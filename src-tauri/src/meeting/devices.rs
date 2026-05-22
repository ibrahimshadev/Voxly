use std::process::Stdio;

use cpal::traits::{DeviceTrait, HostTrait};
use tauri::AppHandle;

use crate::meeting::recorder::{ffmpeg_available, ffmpeg_program, hidden_command};
use crate::meeting::types::MeetingDevices;

pub fn list_devices(app: &AppHandle) -> MeetingDevices {
    let cpal_audio_devices = cpal_input_devices();
    let system_audio_devices = crate::meeting::loopback::output_devices().unwrap_or_default();
    let available = ffmpeg_available(app);
    if !available {
        return MeetingDevices {
            audio_devices: cpal_audio_devices,
            system_audio_devices: system_audio_devices.clone(),
            has_system_audio: !system_audio_devices.is_empty(),
            ffmpeg_available: false,
            message: Some(
                "FFmpeg was not found. Audio devices were loaded from Windows, but screen/mic recording still needs FFmpeg on PATH or VOXLY_FFMPEG."
                    .to_string(),
            ),
            ..Default::default()
        };
    }

    if !cfg!(windows) {
        return MeetingDevices {
            audio_devices: cpal_audio_devices,
            system_audio_devices,
            ffmpeg_available: true,
            message: Some("Meeting recording is currently wired for Windows only.".to_string()),
            ..Default::default()
        };
    }

    let output = hidden_command(ffmpeg_program(app))
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    let Ok(output) = output else {
        return MeetingDevices {
            audio_devices: cpal_audio_devices,
            system_audio_devices: system_audio_devices.clone(),
            has_system_audio: !system_audio_devices.is_empty(),
            ffmpeg_available: true,
            message: Some("Could not list DirectShow devices.".to_string()),
            ..Default::default()
        };
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    let (mut audio_devices, video_devices) = parse_dshow_devices(&stderr);
    for device in cpal_audio_devices {
        push_unique(&mut audio_devices, device);
    }
    let has_system_audio = !system_audio_devices.is_empty();

    MeetingDevices {
        audio_devices,
        system_audio_devices,
        video_devices,
        has_system_audio,
        ffmpeg_available: true,
        message: if stderr.trim().is_empty() {
            Some("FFmpeg returned no DirectShow device output.".to_string())
        } else {
            None
        },
    }
}

fn cpal_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };

    let mut names = Vec::new();
    for device in devices {
        if let Ok(name) = device.name() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                push_unique(&mut names, trimmed.to_string());
            }
        }
    }
    names
}

fn parse_dshow_devices(output: &str) -> (Vec<String>, Vec<String>) {
    enum Section {
        None,
        Video,
        Audio,
    }

    let mut section = Section::None;
    let mut audio = Vec::new();
    let mut video = Vec::new();

    for line in output.lines() {
        if let Some(name) = quoted_device_name(line) {
            if line.contains("(audio)") {
                push_unique(&mut audio, name);
                continue;
            }
            if line.contains("(video)") {
                push_unique(&mut video, name);
                continue;
            }
        }

        if line.contains("DirectShow video devices") {
            section = Section::Video;
            continue;
        }
        if line.contains("DirectShow audio devices") {
            section = Section::Audio;
            continue;
        }

        let Some(name) = quoted_device_name(line) else {
            continue;
        };

        match section {
            Section::Audio => push_unique(&mut audio, name),
            Section::Video => push_unique(&mut video, name),
            Section::None => {}
        }
    }

    (audio, video)
}

fn quoted_device_name(line: &str) -> Option<String> {
    if line.contains("Alternative name") {
        return None;
    }

    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn push_unique(items: &mut Vec<String>, value: String) {
    if !items.iter().any(|item| item == &value) {
        items.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_dshow_devices;

    #[test]
    fn parses_sectioned_directshow_devices() {
        let output = r#"
[dshow @ 000] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000]  "Integrated Camera"
[dshow @ 000]     Alternative name "@device_pnp_..."
[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "Microphone Array"
[dshow @ 000]  "virtual-audio-capturer"
"#;
        let (audio, video) = parse_dshow_devices(output);
        assert_eq!(video, vec!["Integrated Camera"]);
        assert_eq!(audio, vec!["Microphone Array", "virtual-audio-capturer"]);
    }

    #[test]
    fn parses_compact_directshow_devices() {
        let output = r#"
[dshow @ 000] "USB  Live camera" (video)
[dshow @ 000] "OBS Virtual Camera" (none)
[dshow @ 000] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 000] "Microphone (USB Live Camera audio)" (audio)
"#;
        let (audio, video) = parse_dshow_devices(output);
        assert_eq!(video, vec!["USB  Live camera"]);
        assert_eq!(
            audio,
            vec![
                "Microphone (Realtek(R) Audio)",
                "Microphone (USB Live Camera audio)"
            ]
        );
    }
}
