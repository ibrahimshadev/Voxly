use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use tauri::AppHandle;

use crate::meeting::recorder::{ffmpeg_program, hidden_command};

const FFMPEG_ARGS: [&str; 17] = [
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
    "16000",
    "-f",
    "s16le",
    "pipe:1",
];
const SAMPLE_RATE: u32 = 16_000;

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

    let wav = wrap_s16le_as_wav(&output.stdout)?;
    let out_secs = (output.stdout.len() / 2) as f64 / SAMPLE_RATE as f64;
    eprintln!(
        "[audio_preprocess] ok in_bytes={} out_bytes={} out_secs={:.2} exit=0",
        in_bytes,
        wav.len(),
        out_secs
    );
    Some(wav)
}

fn wrap_s16le_as_wav(pcm: &[u8]) -> Option<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = Vec::with_capacity(44 + pcm.len());
    let mut writer = hound::WavWriter::new(Cursor::new(&mut wav), spec).ok()?;
    for sample in pcm.chunks_exact(2) {
        writer
            .write_sample(i16::from_le_bytes([sample[0], sample[1]]))
            .ok()?;
    }
    writer.finalize().ok()?;
    Some(wav)
}

fn stderr_snippet(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(200)
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapped_pcm_decodes_as_16k_mono_wav() {
        let samples: Vec<i16> = vec![0, 1, -1, i16::MAX, i16::MIN, 1234];
        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let wav = wrap_s16le_as_wav(&pcm).unwrap();
        assert_eq!(wav.len(), 44 + pcm.len());

        let mut reader = hound::WavReader::new(Cursor::new(wav)).unwrap();
        let spec = reader.spec();
        assert_eq!(
            (spec.channels, spec.sample_rate, spec.bits_per_sample),
            (1, 16_000, 16)
        );
        let decoded: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(decoded, samples);
    }
}
