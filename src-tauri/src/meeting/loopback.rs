#[cfg(windows)]
mod platform {
    use std::path::Path;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
    use wasapi::{
        initialize_mta, initialize_sta, DeviceEnumerator, Direction, SampleType, StreamMode,
        WaveFormat,
    };

    use super::{
        frames_within_wav_limit, silence_frames_needed, GAP_TOLERANCE_FRAMES, SAMPLE_RATE,
    };

    pub struct LoopbackRecorder {
        recording: Arc<AtomicBool>,
        handle: Option<JoinHandle<Result<(), String>>>,
        started_at: Instant,
    }

    impl LoopbackRecorder {
        pub fn spawn(output_path: &Path, device_name: Option<&str>) -> Result<Self, String> {
            let recording = Arc::new(AtomicBool::new(true));
            let thread_recording = Arc::clone(&recording);
            let output_path = output_path.to_path_buf();
            let device_name = device_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let (tx, rx) = mpsc::channel();

            let handle = thread::spawn(move || {
                let result = run_loopback_capture(
                    &output_path,
                    device_name.as_deref(),
                    thread_recording,
                    tx,
                );
                if let Err(error) = &result {
                    eprintln!("WASAPI loopback capture error: {error}");
                }
                result
            });

            let started = rx
                .recv_timeout(Duration::from_secs(3))
                .unwrap_or_else(|_| Err("Timed out starting WASAPI loopback capture".to_string()));
            match started {
                Ok(started_at) => Ok(Self {
                    recording,
                    handle: Some(handle),
                    started_at,
                }),
                Err(error) => {
                    recording.store(false, Ordering::SeqCst);
                    let _ = handle.join();
                    Err(error)
                }
            }
        }

        pub fn started_at(&self) -> Instant {
            self.started_at
        }

        pub fn signal(&self) {
            self.recording.store(false, Ordering::SeqCst);
        }

        pub fn stop(mut self) -> Result<(), String> {
            self.recording.store(false, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                return handle
                    .join()
                    .map_err(|_| "WASAPI loopback capture thread panicked".to_string())?;
            }
            Ok(())
        }
    }

    pub fn output_devices() -> Result<Vec<String>, String> {
        initialize_audio_thread()?;
        let enumerator = DeviceEnumerator::new()
            .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
        let devices = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(|error| format!("Failed to list output devices: {error}"))?;

        let mut names = Vec::new();
        for device in &devices {
            let device =
                device.map_err(|error| format!("Failed to read output device: {error}"))?;
            let name = device
                .get_friendlyname()
                .map_err(|error| format!("Failed to read output device name: {error}"))?;
            if !names.iter().any(|item| item == &name) {
                names.push(name);
            }
        }
        Ok(names)
    }

    fn run_loopback_capture(
        output_path: &Path,
        device_name: Option<&str>,
        recording: Arc<AtomicBool>,
        ready: mpsc::Sender<Result<Instant, String>>,
    ) -> Result<(), String> {
        let mut capture = match initialize_capture(output_path, device_name).and_then(start_capture)
        {
            Ok(capture) => capture,
            Err(error) => {
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        // Frame 0 of the WAV is this instant; `system_audio_offset_ms` aligns it
        // against the primary capture's start.
        let _ = ready.send(Ok(Instant::now()));

        // A full WAV ends the system-audio track early; the meeting itself
        // (mic/video) keeps recording and the mix pads the shorter track.
        while recording.load(Ordering::SeqCst) && !capture.wav_full {
            capture_available_packets(&mut capture)?;
            let _ = capture.event.wait_for_event(100);
        }

        capture_available_packets(&mut capture)?;
        // Loopback delivers nothing while the output is idle; pad the tail so the
        // track runs until the stop instant like the other captures.
        let now = qpc_now_100ns()?;
        let tail = silence_frames_needed(
            now.saturating_sub(capture.anchor_100ns),
            capture.frames_written,
            0,
        );
        write_silence(&mut capture, tail)?;
        let _ = capture.audio_client.stop_stream();
        capture.writer.finalize().map_err(|error| {
            format!(
                "Failed to finalize WASAPI loopback WAV '{}': {error}",
                output_path.display()
            )
        })
    }

    struct ActiveLoopbackCapture {
        audio_client: wasapi::AudioClient,
        capture_client: wasapi::AudioCaptureClient,
        event: wasapi::Handle,
        writer: WavWriter<std::io::BufWriter<std::fs::File>>,
        bytes_per_frame: usize,
        channels: usize,
        // Performance-counter time in 100 ns units (the unit of packet
        // timestamps) that frame 0 of the WAV corresponds to.
        anchor_100ns: u64,
        frames_written: u64,
        // Set once the WAV size limit is reached; nothing more is written.
        wav_full: bool,
    }

    fn start_capture(mut capture: ActiveLoopbackCapture) -> Result<ActiveLoopbackCapture, String> {
        capture
            .audio_client
            .start_stream()
            .map_err(|error| format!("Failed to start WASAPI loopback stream: {error}"))?;
        capture.anchor_100ns = qpc_now_100ns()?;
        Ok(capture)
    }

    // The clock WASAPI stamps capture packets with. (IAudioClock::GetPosition
    // can't anchor: it reports 0 until the stream's first period.)
    fn qpc_now_100ns() -> Result<u64, String> {
        use windows::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };

        let mut counter = 0i64;
        let mut frequency = 0i64;
        unsafe {
            QueryPerformanceCounter(&mut counter)
                .and_then(|()| QueryPerformanceFrequency(&mut frequency))
                .map_err(|error| format!("Failed to read the performance counter: {error}"))?;
        }
        let ticks = u128::try_from(counter).unwrap_or(0) * 10_000_000;
        Ok((ticks / u128::try_from(frequency.max(1)).unwrap_or(1)) as u64)
    }

    fn initialize_capture(
        output_path: &Path,
        device_name: Option<&str>,
    ) -> Result<ActiveLoopbackCapture, String> {
        initialize_audio_thread()?;

        let enumerator = DeviceEnumerator::new()
            .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
        let device = match device_name {
            Some(name) => enumerator
                .get_device_collection(&Direction::Render)
                .and_then(|devices| devices.get_device_with_name(name))
                .or_else(|_| enumerator.get_default_device(&Direction::Render))
                .map_err(|error| format!("Failed to open output device '{name}': {error}"))?,
            None => enumerator
                .get_default_device(&Direction::Render)
                .map_err(|error| format!("Failed to open default output device: {error}"))?,
        };

        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|error| format!("Failed to create WASAPI audio client: {error}"))?;
        let desired_format =
            WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, 2, None);
        let (default_period, _) = audio_client
            .get_device_period()
            .map_err(|error| format!("Failed to read WASAPI device period: {error}"))?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: default_period,
        };

        audio_client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|error| format!("Failed to initialize WASAPI loopback capture: {error}"))?;
        let event = audio_client
            .set_get_eventhandle()
            .map_err(|error| format!("Failed to create WASAPI event handle: {error}"))?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|error| format!("Failed to create WASAPI capture client: {error}"))?;

        let spec = WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: WavSampleFormat::Int,
        };
        let writer = WavWriter::create(output_path, spec).map_err(|error| {
            format!(
                "Failed to create WASAPI loopback WAV '{}': {error}",
                output_path.display()
            )
        })?;

        Ok(ActiveLoopbackCapture {
            audio_client,
            capture_client,
            event,
            writer,
            bytes_per_frame: desired_format.get_blockalign() as usize,
            channels: 2,
            anchor_100ns: 0,
            frames_written: 0,
            wav_full: false,
        })
    }

    fn capture_available_packets(capture: &mut ActiveLoopbackCapture) -> Result<(), String> {
        while !capture.wav_full {
            let packet_frames = match capture
                .capture_client
                .get_next_packet_size()
                .map_err(|error| format!("Failed to read WASAPI packet size: {error}"))?
            {
                Some(0) | None => return Ok(()),
                Some(frames) => frames as usize,
            };

            let mut buffer = vec![0u8; packet_frames * capture.bytes_per_frame];
            let (frames, info) = capture
                .capture_client
                .read_from_device(&mut buffer)
                .map_err(|error| format!("Failed to read WASAPI loopback data: {error}"))?;

            // Place the packet at its capture time: the output device sends no
            // packets while idle, so without this every gap would pull later
            // audio earlier and shorten the track.
            if !info.flags.timestamp_error {
                let tolerance = if info.flags.data_discontinuity {
                    0
                } else {
                    GAP_TOLERANCE_FRAMES
                };
                // A packet can't have been captured in the future; the clamp keeps
                // a bogus timestamp from writing a runaway gap.
                let captured_at = info.timestamp.min(qpc_now_100ns()?);
                let gap = silence_frames_needed(
                    captured_at.saturating_sub(capture.anchor_100ns),
                    capture.frames_written,
                    tolerance,
                );
                write_silence(capture, gap)?;
            }

            if info.flags.silent {
                write_silence(capture, u64::from(frames))?;
                continue;
            }

            let frames = claim_frames(capture, u64::from(frames)) as usize;
            let bytes = frames * capture.bytes_per_frame;
            for sample in buffer[..bytes].chunks_exact(2) {
                capture
                    .writer
                    .write_sample(i16::from_le_bytes([sample[0], sample[1]]))
                    .map_err(|error| format!("Failed to write loopback sample: {error}"))?;
            }
        }
        Ok(())
    }

    fn write_silence(capture: &mut ActiveLoopbackCapture, frames: u64) -> Result<(), String> {
        let frames = claim_frames(capture, frames);
        for _ in 0..frames * capture.channels as u64 {
            capture
                .writer
                .write_sample(0i16)
                .map_err(|error| format!("Failed to write loopback silence: {error}"))?;
        }
        Ok(())
    }

    /// Reserves up to `frames` of the WAV's size budget and returns how many
    /// may be written. hound panics (debug) or corrupts the header (release)
    /// past its u32 sizes, so the track stops there instead.
    fn claim_frames(capture: &mut ActiveLoopbackCapture, frames: u64) -> u64 {
        let allowed = frames_within_wav_limit(capture.frames_written, frames);
        if allowed < frames && !capture.wav_full {
            capture.wav_full = true;
            eprintln!(
                "WASAPI loopback WAV reached its 4 GB size limit; system audio stops here \
while the meeting keeps recording"
            );
        }
        capture.frames_written += allowed;
        allowed
    }

    fn initialize_audio_thread() -> Result<(), String> {
        initialize_mta()
            .ok()
            .or_else(|_| initialize_sta().ok())
            .map_err(|error| format!("Failed to initialize Windows audio: {error}"))
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;
    use std::time::Instant;

    pub struct LoopbackRecorder;

    impl LoopbackRecorder {
        pub fn spawn(_output_path: &Path, _device_name: Option<&str>) -> Result<Self, String> {
            Err(
                "System audio loopback recording is currently implemented for Windows only."
                    .to_string(),
            )
        }

        pub fn signal(&self) {}

        pub fn stop(self) -> Result<(), String> {
            Ok(())
        }

        pub fn started_at(&self) -> Instant {
            Instant::now()
        }
    }

    pub fn output_devices() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

use std::path::{Path, PathBuf};

pub use platform::*;

const SAMPLE_RATE: u32 = 48_000;
// Deficits below this are packet/clock jitter, not a gap. It also bounds how
// far audio-clock drift against the performance counter can accumulate before
// a silence insert pulls the track back onto wall-clock time.
#[cfg_attr(not(windows), allow(dead_code))]
const GAP_TOLERANCE_FRAMES: u64 = SAMPLE_RATE as u64 * 30 / 1000;

// 16-bit stereo, as captured and written.
#[cfg_attr(not(windows), allow(dead_code))]
const WAV_BYTES_PER_FRAME: u64 = 4;
// hound stores both the data size and the RIFF size (data + 36-byte header)
// as u32; the margin keeps the RIFF size in range too.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_WAV_FRAMES: u64 = (u32::MAX as u64 - 1_024) / WAV_BYTES_PER_FRAME;

/// How many of `frames` still fit in the WAV after `frames_written`.
#[cfg_attr(not(windows), allow(dead_code))]
fn frames_within_wav_limit(frames_written: u64, frames: u64) -> u64 {
    frames.min(MAX_WAV_FRAMES.saturating_sub(frames_written))
}

/// Frames of silence to write so the next frame lands `elapsed_100ns` (100 ns
/// units since capture start) into the track, given `frames_written` so far.
/// Deficits within `tolerance_frames` are ignored; a surplus is never trimmed.
#[cfg_attr(not(windows), allow(dead_code))]
fn silence_frames_needed(elapsed_100ns: u64, frames_written: u64, tolerance_frames: u64) -> u64 {
    let expected = u128::from(elapsed_100ns) * u128::from(SAMPLE_RATE) / 10_000_000;
    let deficit = expected.saturating_sub(u128::from(frames_written));
    if deficit > u128::from(tolerance_frames) {
        u64::try_from(deficit).unwrap_or(u64::MAX)
    } else {
        0
    }
}

pub fn temp_system_audio_path(base: &Path) -> PathBuf {
    base.join("system-audio.wav")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND_100NS: u64 = 10_000_000;

    #[test]
    fn no_silence_when_track_is_on_time() {
        assert_eq!(silence_frames_needed(SECOND_100NS, 48_000, 0), 0);
        assert_eq!(silence_frames_needed(0, 0, GAP_TOLERANCE_FRAMES), 0);
    }

    #[test]
    fn idle_output_gap_is_filled_to_wall_clock() {
        // 1 s of audio written, next packet captured 5 s after start.
        assert_eq!(
            silence_frames_needed(5 * SECOND_100NS, 48_000, GAP_TOLERANCE_FRAMES),
            4 * 48_000
        );
    }

    #[test]
    fn silent_start_is_filled_from_frame_zero() {
        // Nothing played for the first 2.5 s of the meeting.
        assert_eq!(
            silence_frames_needed(25 * SECOND_100NS / 10, 0, GAP_TOLERANCE_FRAMES),
            120_000
        );
    }

    #[test]
    fn jitter_within_tolerance_is_ignored() {
        let elapsed = SECOND_100NS + 20 * 10_000; // 1.020 s
        assert_eq!(
            silence_frames_needed(elapsed, 48_000, GAP_TOLERANCE_FRAMES),
            0
        );
        assert_eq!(silence_frames_needed(elapsed, 48_000, 0), 960);
    }

    #[test]
    fn deficit_just_past_tolerance_is_filled_exactly() {
        // 31 ms behind with a 30 ms tolerance.
        let elapsed = SECOND_100NS + 310_000;
        assert_eq!(
            silence_frames_needed(elapsed, 48_000, GAP_TOLERANCE_FRAMES),
            1_488
        );
    }

    #[test]
    fn surplus_is_never_negative() {
        assert_eq!(silence_frames_needed(SECOND_100NS, 96_000, 0), 0);
    }

    #[test]
    fn wav_limit_allows_writes_below_budget() {
        assert_eq!(frames_within_wav_limit(0, 480), 480);
        assert_eq!(frames_within_wav_limit(MAX_WAV_FRAMES - 480, 480), 480);
    }

    #[test]
    fn wav_limit_truncates_the_write_that_crosses_it() {
        assert_eq!(frames_within_wav_limit(MAX_WAV_FRAMES - 100, 480), 100);
    }

    #[test]
    fn wav_limit_allows_nothing_once_full() {
        assert_eq!(frames_within_wav_limit(MAX_WAV_FRAMES, 480), 0);
        assert_eq!(frames_within_wav_limit(MAX_WAV_FRAMES + 1, 480), 0);
    }

    #[test]
    fn wav_limit_keeps_riff_sizes_within_u32() {
        // hound's header: data size and data size + 36 both stored as u32.
        let data_bytes = MAX_WAV_FRAMES * WAV_BYTES_PER_FRAME;
        assert!(data_bytes + 36 <= u64::from(u32::MAX));
        // ~6.2 h of 48 kHz stereo audio.
        assert!(MAX_WAV_FRAMES / u64::from(SAMPLE_RATE) > 6 * 3_600);
    }

    #[test]
    fn stop_padding_covers_long_idle_tail() {
        // A one-hour meeting where playback stopped after 10 minutes.
        let hour = 3_600 * SECOND_100NS;
        assert_eq!(silence_frames_needed(hour, 600 * 48_000, 0), 3_000 * 48_000);
    }

    // Needs Windows playback devices: `cargo test -- --ignored loopback_track`.
    // Runs on every output device so both an idle one (no packets at all) and a
    // playing one are covered; either way the WAV must span wall-clock time.
    #[cfg(windows)]
    #[test]
    #[ignore = "records from the Windows playback devices"]
    fn loopback_track_spans_wall_clock_time() {
        let dir = std::env::temp_dir().join(format!("dikt_loopback_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = temp_system_audio_path(&dir);

        for device in output_devices().unwrap() {
            let recorder = LoopbackRecorder::spawn(&path, Some(&device)).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(3));
            let elapsed = recorder.started_at().elapsed().as_secs_f64();
            recorder.stop().unwrap();

            let reader = hound::WavReader::open(&path).unwrap();
            let secs = f64::from(reader.duration()) / f64::from(SAMPLE_RATE);
            assert!(
                (secs - elapsed).abs() < 0.25,
                "{device}: wav {secs}s vs {elapsed}s"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
