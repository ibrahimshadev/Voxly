#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
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

            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(started_at)) => Ok(Self {
                    recording,
                    handle: Some(handle),
                    started_at,
                }),
                Ok(Err(error)) => {
                    recording.store(false, Ordering::SeqCst);
                    let _ = handle.join();
                    Err(error)
                }
                Err(_) => {
                    recording.store(false, Ordering::SeqCst);
                    let _ = handle.join();
                    Err("Timed out starting WASAPI loopback capture".to_string())
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
        let startup = initialize_capture(output_path, device_name);
        let Ok(mut capture) = startup else {
            let error = startup
                .err()
                .unwrap_or_else(|| "WASAPI startup failed".to_string());
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        };

        capture
            .audio_client
            .start_stream()
            .map_err(|error| format!("Failed to start WASAPI loopback stream: {error}"))?;
        let _ = ready.send(Ok(Instant::now()));

        while recording.load(Ordering::SeqCst) {
            capture_available_packets(&mut capture)?;
            let _ = capture.event.wait_for_event(100);
        }

        capture_available_packets(&mut capture)?;
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
        let desired_format = WaveFormat::new(16, 16, &SampleType::Int, 48_000, 2, None);
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
            sample_rate: 48_000,
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
        })
    }

    fn capture_available_packets(capture: &mut ActiveLoopbackCapture) -> Result<(), String> {
        loop {
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
            let samples = frames as usize * capture.channels;

            if info.flags.silent {
                for _ in 0..samples {
                    capture
                        .writer
                        .write_sample(0i16)
                        .map_err(|error| format!("Failed to write loopback silence: {error}"))?;
                }
                continue;
            }

            for sample in buffer[..samples * 2].chunks_exact(2) {
                capture
                    .writer
                    .write_sample(i16::from_le_bytes([sample[0], sample[1]]))
                    .map_err(|error| format!("Failed to write loopback sample: {error}"))?;
            }
        }
    }

    fn initialize_audio_thread() -> Result<(), String> {
        initialize_mta()
            .ok()
            .or_else(|_| initialize_sta().ok())
            .map_err(|error| format!("Failed to initialize Windows audio: {error}"))
    }

    pub fn system_audio_available() -> bool {
        !output_devices().unwrap_or_default().is_empty()
    }

    pub fn temp_system_audio_path(base: &Path) -> PathBuf {
        base.join("system-audio.wav")
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::{Path, PathBuf};
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

    pub fn system_audio_available() -> bool {
        false
    }

    pub fn temp_system_audio_path(base: &Path) -> PathBuf {
        base.join("system-audio.wav")
    }
}

pub use platform::*;
