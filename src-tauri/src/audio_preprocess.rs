use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use tauri::AppHandle;

use crate::meeting::recorder::{ffmpeg_program, hidden_command};

const FFMPEG_ARGS: [&str; 13] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "wav",
    "-i",
    "pipe:0",
    "-af",
    "silenceremove=stop_periods=-1:stop_duration=0.5:stop_silence=0.3:stop_threshold=-40dB:detection=peak",
    "-ac",
    "1",
    "-ar",
];
const FFMPEG_TAIL_ARGS: [&str; 4] = ["16000", "-f", "s16le", "pipe:1"];
const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const BLOCK_ALIGN: u16 = CHANNELS * (BITS_PER_SAMPLE / 8);
const BYTE_RATE: u32 = SAMPLE_RATE * BLOCK_ALIGN as u32;

static FFMPEG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = FFMPEG_PATH.set(ffmpeg_program(app));
}

pub fn process(audio_wav: Vec<u8>) -> Vec<u8> {
    let Some(path) = FFMPEG_PATH.get() else {
        eprintln!("[audio_preprocess] no_ffmpeg_path skipping");
        return audio_wav;
    };

    match process_with_ffmpeg(path, &audio_wav) {
        Some(processed) => processed,
        None => audio_wav,
    }
}

fn process_with_ffmpeg(path: &Path, audio_wav: &[u8]) -> Option<Vec<u8>> {
    let in_bytes = audio_wav.len();
    let mut child = match hidden_command(path)
        .args(FFMPEG_ARGS)
        .args(FFMPEG_TAIL_ARGS)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("[audio_preprocess] spawn_failed err={error}");
            return None;
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        eprintln!("[audio_preprocess] spawn_failed err=missing stdin pipe");
        return None;
    };

    let output = std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(audio_wav));
        let output = child.wait_with_output();
        let _ = writer.join();
        output
    });

    let output = match output {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[audio_preprocess] spawn_failed err={error}");
            return None;
        }
    };

    if !output.status.success() {
        eprintln!(
            "[audio_preprocess] ffmpeg_failed in_bytes={} status={} stderr={}",
            in_bytes,
            output.status,
            stderr_snippet(&output.stderr)
        );
        return None;
    }

    if output.stdout.is_empty() {
        eprintln!(
            "[audio_preprocess] empty_output in_bytes={} status={}",
            in_bytes, output.status
        );
        return None;
    }

    let wav = wrap_s16le_as_wav(&output.stdout);
    let in_secs = input_wav_duration_secs(audio_wav).unwrap_or(0.0);
    let out_secs = output.stdout.len() as f64 / BYTE_RATE as f64;
    eprintln!(
        "[audio_preprocess] ok in_bytes={} in_secs={:.2} out_bytes={} out_secs={:.2} exit=0",
        in_bytes,
        in_secs,
        wav.len(),
        out_secs
    );
    Some(wav)
}

fn input_wav_duration_secs(audio_wav: &[u8]) -> Option<f64> {
    if audio_wav.len() < 44 {
        return None;
    }

    let byte_rate = u32::from_le_bytes(audio_wav[28..32].try_into().ok()?) as f64;
    if byte_rate == 0.0 {
        return None;
    }

    Some((audio_wav.len() - 44) as f64 / byte_rate)
}

fn wrap_s16le_as_wav(pcm: &[u8]) -> Vec<u8> {
    let data_size = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(data_size + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&BYTE_RATE.to_le_bytes());
    wav.extend_from_slice(&BLOCK_ALIGN.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

fn stderr_snippet(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(200)
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect()
}
