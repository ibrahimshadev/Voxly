use std::io::Cursor;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};

// Lock-free audio level metering: written by CPAL callback, read by emitter thread.
const SILENT_DB: f32 = -60.0;
static LEVEL_RMS: AtomicU32 = AtomicU32::new(SILENT_DB.to_bits());
static LEVEL_PEAK: AtomicU32 = AtomicU32::new(SILENT_DB.to_bits());
static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Read the current audio level (RMS and peak in dB). Returns (-60, -60) when silent.
pub fn current_level() -> (f32, f32) {
    (
        f32::from_bits(LEVEL_RMS.load(Ordering::Relaxed)),
        f32::from_bits(LEVEL_PEAK.load(Ordering::Relaxed)),
    )
}

/// Whether the recorder is actively capturing audio.
pub fn is_recording() -> bool {
    RECORDING_ACTIVE.load(Ordering::Relaxed)
}

fn reset_levels() {
    LEVEL_RMS.store(SILENT_DB.to_bits(), Ordering::Relaxed);
    LEVEL_PEAK.store(SILENT_DB.to_bits(), Ordering::Relaxed);
}

pub struct AudioRecorder {
    samples: Arc<Mutex<Vec<i16>>>,
    recording: Arc<AtomicBool>,
    thread_handle: Mutex<Option<JoinHandle<()>>>,
    sample_rate: Arc<AtomicU32>,
}

impl Default for AudioRecorder {
    fn default() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            recording: Arc::new(AtomicBool::new(false)),
            thread_handle: Mutex::new(None),
            sample_rate: Arc::new(AtomicU32::new(16000)),
        }
    }
}

impl AudioRecorder {
    pub fn start(&self) -> Result<(), String> {
        if self.recording.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.samples.lock().unwrap().clear();
        reset_levels();
        RECORDING_ACTIVE.store(true, Ordering::Relaxed);
        self.recording.store(true, Ordering::SeqCst);

        let samples = Arc::clone(&self.samples);
        let recording = Arc::clone(&self.recording);
        let sample_rate = Arc::clone(&self.sample_rate);
        sample_rate.store(16000, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            if let Err(e) = run_audio_capture(samples, recording, sample_rate) {
                eprintln!("Audio capture error: {e}");
            }
        });

        *self.thread_handle.lock().unwrap() = Some(handle);

        // Give the thread a moment to start and set the sample rate
        thread::sleep(std::time::Duration::from_millis(100));

        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<u8>, String> {
        self.recording.store(false, Ordering::SeqCst);
        RECORDING_ACTIVE.store(false, Ordering::Relaxed);
        reset_levels();

        // Wait for the audio thread to finish
        if let Some(handle) = self.thread_handle.lock().unwrap().take() {
            let _ = handle.join();
        }

        let samples = self.samples.lock().unwrap();
        if samples.is_empty() {
            return Err("No audio captured".to_string());
        }

        let sample_rate = self.sample_rate.load(Ordering::SeqCst);

        let spec = WavSpec {
            channels: 1,
            sample_rate: sample_rate.max(1),
            bits_per_sample: 16,
            sample_format: WavSampleFormat::Int,
        };

        let mut wav_buffer = Vec::new();
        {
            let mut writer =
                WavWriter::new(Cursor::new(&mut wav_buffer), spec).map_err(|e| e.to_string())?;
            for &sample in samples.iter() {
                writer.write_sample(sample).map_err(|e| e.to_string())?;
            }
            writer.finalize().map_err(|e| e.to_string())?;
        }

        Ok(wav_buffer)
    }
}

fn run_audio_capture(
    samples: Arc<Mutex<Vec<i16>>>,
    recording: Arc<AtomicBool>,
    sample_rate: Arc<AtomicU32>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No input device available")?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {e}"))?;

    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();

    sample_rate.store(config.sample_rate.0, Ordering::SeqCst);

    let stream = match sample_format {
        SampleFormat::I16 => build_stream::<i16>(&device, &config, &samples, &recording, |v| v)?,
        SampleFormat::U16 => build_stream::<u16>(&device, &config, &samples, &recording, |v| {
            (v as i32 - 32768) as i16
        })?,
        SampleFormat::F32 => build_stream::<f32>(&device, &config, &samples, &recording, |v| {
            let clamped = v.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32) as i16
        })?,
        _ => return Err("Unsupported sample format".to_string()),
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start input stream: {e}"))?;

    // Keep the stream alive while recording
    while recording.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(10));
    }

    Ok(())
}

fn build_stream<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: &Arc<Mutex<Vec<i16>>>,
    recording: &Arc<AtomicBool>,
    convert: fn(T) -> i16,
) -> Result<cpal::Stream, String> {
    let samples = Arc::clone(samples);
    let recording = Arc::clone(recording);
    let channels = config.channels as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if recording.load(Ordering::SeqCst) {
                    push_mono_i16(&samples, data, channels, convert);
                }
            },
            |err| eprintln!("Audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {e}"))
}

fn push_mono_i16<T, F>(samples: &Arc<Mutex<Vec<i16>>>, data: &[T], channels: usize, convert: F)
where
    T: Copy,
    F: Fn(T) -> i16,
{
    if channels == 0 {
        return;
    }

    let mut sum_sq: f64 = 0.0;
    let mut max_abs: u16 = 0;
    let mut frame_count: usize = 0;

    if let Ok(mut buffer) = samples.lock() {
        for frame in data.chunks(channels) {
            let mut acc = 0i32;
            let mut ch_count = 0i32;
            for &sample in frame {
                acc += convert(sample) as i32;
                ch_count += 1;
            }
            if ch_count > 0 {
                let mono = (acc / ch_count) as i16;
                buffer.push(mono);
                sum_sq += (mono as f64) * (mono as f64);
                let abs = mono.unsigned_abs();
                if abs > max_abs {
                    max_abs = abs;
                }
                frame_count += 1;
            }
        }
    }

    if frame_count > 0 {
        let norm = i16::MAX as f64;
        let rms = (sum_sq / frame_count as f64).sqrt();
        let rms_db = if rms > 0.0 {
            (20.0 * (rms / norm).log10()).max(-60.0) as f32
        } else {
            SILENT_DB
        };
        let peak_db = if max_abs > 0 {
            (20.0 * (max_abs as f64 / norm).log10()).max(-60.0) as f32
        } else {
            SILENT_DB
        };
        LEVEL_RMS.store(rms_db.to_bits(), Ordering::Relaxed);
        LEVEL_PEAK.store(peak_db.to_bits(), Ordering::Relaxed);
    }
}
