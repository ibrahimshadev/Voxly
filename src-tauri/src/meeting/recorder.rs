use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use std::{fs, io};

use tauri::{AppHandle, Emitter, Manager};

use crate::meeting::loopback::{temp_system_audio_path, LoopbackRecorder};
use crate::meeting::progress::{parse_out_time_secs, progress_pct, ProgressThrottle};
use crate::meeting::types::{MeetingStartOptions, MeetingUpdate};

const MEETING_AUDIO_GAIN_FILTER: &str = "volume=2.0";
const MEETING_MIC_GAIN_FILTER: &str = "volume=3.0";
const MEETING_AUDIO_LIMITER_FILTER: &str = "alimiter=limit=0.95";
// Last-resort ceiling for the recording FFmpeg after `q`. Killing it mid-
// finalization corrupts the file, so this must comfortably cover faststart
// rewrites of multi-GB captures; finalization runs off the main thread.
const FFMPEG_QUIT_TIMEOUT: Duration = Duration::from_secs(300);
// Startup-failure cleanup (loopback spawn failed right after FFmpeg started):
// the capture is <1s old, so a short wait keeps the manager lock from being
// held for minutes and a kill has no corruption cost.
const FFMPEG_STARTUP_QUIT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct RunningRecorder {
    child: Option<Child>,
    loopback: Option<LoopbackRecorder>,
    final_path: PathBuf,
    primary_path: Option<PathBuf>,
    system_audio_path: Option<PathBuf>,
    ffmpeg_path: PathBuf,
    has_video: bool,
    has_primary_audio: bool,
    system_audio_offset_ms: i64,
}

impl RunningRecorder {
    pub fn spawn(
        app: AppHandle,
        meeting_id: String,
        output_path: &Path,
        options: &MeetingStartOptions,
    ) -> Result<Self, String> {
        let ffmpeg = ffmpeg_program(&app);
        let preset = VideoPreset::from_setting(&options.video_preset);
        let has_video = options.record_video && !matches!(preset, VideoPreset::AudioOnly);
        let has_primary_audio =
            options.record_mic && clean_device_name(options.mic_device.as_deref()).is_some();
        let has_system_audio = options.record_system_audio;

        if !has_video && !has_primary_audio && !has_system_audio {
            return Err(
                "No meeting capture source is configured. Choose screen capture, a microphone device, or system audio."
                    .to_string(),
            );
        }

        let meeting_dir = output_path
            .parent()
            .ok_or_else(|| "Meeting output path has no parent directory".to_string())?;
        let system_audio_path = if has_system_audio {
            Some(temp_system_audio_path(meeting_dir))
        } else {
            None
        };
        let primary_path = if has_video || has_primary_audio {
            Some(if has_system_audio {
                meeting_dir.join("capture.mp4")
            } else {
                output_path.to_path_buf()
            })
        } else {
            None
        };

        let mut primary_started_at = None;
        let mut child = if let Some(primary_path) = &primary_path {
            let args = build_args(primary_path, options, false, !has_system_audio)?;
            let spawned = spawn_ffmpeg(app.clone(), meeting_id.clone(), &ffmpeg, &args)?;
            primary_started_at = Some(spawned.started_at);
            Some(spawned.child)
        } else {
            None
        };

        let mut system_started_at = None;
        let loopback = if let Some(path) = &system_audio_path {
            match LoopbackRecorder::spawn(path, options.system_audio_device.as_deref()) {
                Ok(loopback) => {
                    system_started_at = Some(loopback.started_at());
                    Some(loopback)
                }
                Err(error) => {
                    if let Some(child) = child.take() {
                        let _ = stop_ffmpeg(child);
                    }
                    return Err(error);
                }
            }
        } else {
            None
        };
        let system_audio_offset_ms = match (primary_started_at, system_started_at) {
            (Some(primary), Some(system)) => signed_offset_ms(system, primary),
            _ => 0,
        };

        Ok(Self {
            child,
            loopback,
            final_path: output_path.to_path_buf(),
            primary_path,
            system_audio_path,
            ffmpeg_path: ffmpeg,
            has_video,
            has_primary_audio,
            system_audio_offset_ms,
        })
    }

    /// Tells the capture processes to wind down without waiting. Instant.
    pub fn signal_stop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
        }
        if let Some(loopback) = self.loopback.as_ref() {
            loopback.signal();
        }
    }

    /// Waits for the capture processes and runs the post-processing passes.
    /// Duration-proportional — must run off the main thread. `duration_secs`
    /// scales the progress percentages; pass 0.0 when unknown (no progress).
    pub fn finalize(
        mut self,
        duration_secs: f64,
        on_progress: &(dyn Fn(f32) + Send + Sync),
    ) -> Result<(), String> {
        let ffmpeg_result = match self.child.take() {
            Some(child) => wait_ffmpeg(child, FFMPEG_QUIT_TIMEOUT),
            None => Ok(()),
        };
        let loopback_result = match self.loopback.take() {
            Some(loopback) => loopback.stop(),
            None => Ok(()),
        };

        ffmpeg_result?;
        loopback_result?;

        if self.system_audio_path.is_some() {
            self.run_post_process(duration_secs, on_progress)?;
        }

        Ok(())
    }

    fn run_post_process(
        &mut self,
        duration_secs: f64,
        on_progress: &(dyn Fn(f32) + Send + Sync),
    ) -> Result<(), String> {
        let Some(system_audio_path) = self.system_audio_path.clone() else {
            return Ok(());
        };
        let transcript_audio_path = if self.has_primary_audio && self.primary_path.is_some() {
            transcript_audio_path_for(&self.final_path)
        } else {
            None
        };

        let combined_args = post_process_args(
            self.primary_path.as_deref(),
            &system_audio_path,
            &self.final_path,
            transcript_audio_path.as_deref(),
            self.has_video,
            self.has_primary_audio,
            self.system_audio_offset_ms,
        );
        let mut result =
            run_ffmpeg_with_progress(&self.ffmpeg_path, &combined_args, duration_secs, on_progress);

        // The transcript track must stay non-fatal (it was a separate, logged-only
        // pass before the merge): retry producing only the final mix.
        if result.is_err() && transcript_audio_path.is_some() {
            if let Err(error) = &result {
                eprintln!("Combined mux+transcript pass failed, retrying mix-only: {error}");
            }
            let mix_only_args = post_process_args(
                self.primary_path.as_deref(),
                &system_audio_path,
                &self.final_path,
                None,
                self.has_video,
                self.has_primary_audio,
                self.system_audio_offset_ms,
            );
            result = run_ffmpeg_with_progress(
                &self.ffmpeg_path,
                &mix_only_args,
                duration_secs,
                on_progress,
            );
        }

        if let Err(error) = result {
            if let Some(primary_path) = self.primary_path.as_deref() {
                if primary_path != self.final_path {
                    promote_primary_capture(primary_path, &self.final_path).map_err(
                        |fallback_error| {
                            format!(
                                "{error}. Also failed to keep the primary capture: {fallback_error}"
                            )
                        },
                    )?;
                    return Err(format!(
                        "{error}. Saved the screen/mic capture without the system-audio mix."
                    ));
                }
            }
            return Err(error);
        }

        if let Some(primary_path) = self.primary_path.as_deref() {
            if primary_path != self.final_path {
                let _ = std::fs::remove_file(primary_path);
            }
        }
        let _ = std::fs::remove_file(&system_audio_path);
        Ok(())
    }
}

struct SpawnedFfmpeg {
    child: Child,
    started_at: Instant,
}

fn spawn_ffmpeg(
    app: AppHandle,
    meeting_id: String,
    ffmpeg: &Path,
    args: &[String],
) -> Result<SpawnedFfmpeg, String> {
    let mut command = hidden_command(ffmpeg);
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start FFmpeg. Install FFmpeg or configure the bundled sidecar. Tried '{}': {error}",
                ffmpeg.display()
            )
        })?;
    let started_at = Instant::now();

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "meeting:update",
                    MeetingUpdate {
                        state: "log".to_string(),
                        meeting_id: Some(meeting_id.clone()),
                        message: Some(trimmed.to_string()),
                        elapsed_secs: None,
                        file_size_bytes: None,
                        progress_pct: None,
                    },
                );
            }
        });
    }

    thread::sleep(Duration::from_millis(350));
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Failed to inspect FFmpeg process: {error}"))?
    {
        return Err(format!(
            "FFmpeg exited before recording started with status {status}. Check selected devices and FFmpeg permissions."
        ));
    }

    Ok(SpawnedFfmpeg { child, started_at })
}

// Used only by the loopback-spawn-failure cleanup in `spawn`; the normal stop
// path signals via `signal_stop` and waits in `finalize`.
fn stop_ffmpeg(mut child: Child) -> Result<(), String> {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    wait_ffmpeg(child, FFMPEG_STARTUP_QUIT_TIMEOUT)
}

fn wait_ffmpeg(mut child: Child, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!("FFmpeg exited with status {status}"));
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    // Last resort for a truly wedged process — killing FFmpeg
                    // while it finalizes the file can corrupt the recording.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("FFmpeg did not stop cleanly and was killed".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("Failed to wait for FFmpeg: {error}")),
        }
    }
}

fn run_ffmpeg_with_progress(
    ffmpeg: &Path,
    args: &[String],
    duration_secs: f64,
    on_progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<(), String> {
    let mut child = hidden_command(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to mux system audio with FFmpeg: {error}"))?;

    let stderr_handle = child.stderr.take().map(|stderr| {
        thread::spawn(move || {
            let mut buffer = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                buffer.push_str(&line);
                buffer.push('\n');
            }
            buffer
        })
    });

    if let Some(stdout) = child.stdout.take() {
        let mut throttle = ProgressThrottle::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(out_time_secs) = parse_out_time_secs(&line) else {
                continue;
            };
            let Some(pct) = progress_pct(out_time_secs, duration_secs) else {
                continue;
            };
            if throttle.should_emit(pct, Instant::now()) {
                on_progress(pct);
            }
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for FFmpeg: {error}"))?;
    let stderr_output = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "Failed to mux system audio with FFmpeg: {stderr_output}"
        ));
    }
    Ok(())
}

fn signed_offset_ms(value: Instant, baseline: Instant) -> i64 {
    if let Some(duration) = value.checked_duration_since(baseline) {
        duration.as_millis().min(i64::MAX as u128) as i64
    } else {
        -(baseline
            .duration_since(value)
            .as_millis()
            .min(i64::MAX as u128) as i64)
    }
}

fn offset_filter_steps(offset_ms: i64) -> Vec<String> {
    let mut filters = Vec::new();
    if offset_ms > 0 {
        filters.push("asetpts=PTS-STARTPTS".to_string());
        filters.push(format!("adelay={offset_ms}:all=1"));
    } else if offset_ms < 0 {
        filters.push(format!("atrim=start={:.3}", (-offset_ms as f64) / 1000.0));
        filters.push("asetpts=PTS-STARTPTS".to_string());
    } else {
        filters.push("asetpts=PTS-STARTPTS".to_string());
    }
    filters
}

fn audio_offset_filter(input: &str, output: &str, offset_ms: i64, apply_gain: bool) -> String {
    let mut filters = offset_filter_steps(offset_ms);
    if apply_gain {
        filters.push(MEETING_AUDIO_GAIN_FILTER.to_string());
    }
    format!("{input}{}{output}", filters.join(","))
}

// One filter graph feeding both outputs: the mic/system mix for the final
// recording and the dual-channel (mic|system) track AssemblyAI transcribes.
// Inputs are decoded once; asplit fans each source into both branches.
fn combined_post_filter(system_audio_offset_ms: i64) -> String {
    let sys_chain = offset_filter_steps(system_audio_offset_ms).join(",");
    format!(
        "[0:a]asetpts=PTS-STARTPTS,{MEETING_MIC_GAIN_FILTER},asplit=2[mic_mix][mic_tr];\
[1:a]{sys_chain},asplit=2[sys_mix][sys_tr];\
[mic_mix][sys_mix]amix=inputs=2:duration=longest:normalize=0,{MEETING_AUDIO_LIMITER_FILTER}[aout];\
[mic_tr]pan=mono|c0=c0,apad=pad_dur=3[mt];\
[sys_tr]pan=mono|c0=0.5*c0+0.5*c1,apad=pad_dur=3[st];\
[mt][st]join=inputs=2:channel_layout=stereo[tout]"
    )
}

fn post_process_args(
    primary_path: Option<&Path>,
    system_audio_path: &Path,
    final_path: &Path,
    transcript_audio_path: Option<&Path>,
    has_video: bool,
    has_primary_audio: bool,
    system_audio_offset_ms: i64,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
    ];
    if let Some(primary_path) = primary_path {
        args.extend(["-i".to_string(), primary_path.to_string_lossy().to_string()]);
    }
    args.extend([
        "-i".to_string(),
        system_audio_path.to_string_lossy().to_string(),
    ]);

    let combined =
        transcript_audio_path.is_some() && primary_path.is_some() && has_primary_audio;

    match (primary_path.is_some(), has_primary_audio) {
        (true, true) => {
            let filter = if combined {
                combined_post_filter(system_audio_offset_ms)
            } else {
                mic_system_mix_filter(system_audio_offset_ms)
            };
            args.extend(["-filter_complex".to_string(), filter]);
            if has_video {
                args.extend(["-map".to_string(), "0:v?".to_string()]);
            }
            args.extend(["-map".to_string(), "[aout]".to_string()]);
            if has_video {
                args.extend(["-c:v".to_string(), "copy".to_string()]);
            }
        }
        (true, false) => {
            let system_filter =
                audio_offset_filter("[1:a]", "[aout]", system_audio_offset_ms, true);
            args.extend(["-filter_complex".to_string(), system_filter]);
            if has_video {
                args.extend(["-map".to_string(), "0:v?".to_string()]);
            }
            args.extend(["-map".to_string(), "[aout]".to_string()]);
            if has_video {
                args.extend(["-c:v".to_string(), "copy".to_string()]);
            }
        }
        (false, _) => {
            let system_filter = audio_offset_filter("[0:a]", "[aout]", 0, true);
            args.extend(["-filter_complex".to_string(), system_filter]);
            args.extend(["-map".to_string(), "[aout]".to_string()]);
        }
    }

    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "128k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        final_path.to_string_lossy().to_string(),
    ]);

    if combined {
        if let Some(transcript_audio_path) = transcript_audio_path {
            args.extend([
                "-map".to_string(),
                "[tout]".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "96k".to_string(),
                transcript_audio_path.to_string_lossy().to_string(),
            ]);
        }
    }

    args
}

fn mic_system_mix_filter(system_audio_offset_ms: i64) -> String {
    let system_filter = audio_offset_filter("[1:a]", "[sys]", system_audio_offset_ms, false);
    format!(
        "[0:a]asetpts=PTS-STARTPTS,{MEETING_MIC_GAIN_FILTER}[mic];{system_filter};[mic][sys]amix=inputs=2:duration=longest:normalize=0,{MEETING_AUDIO_LIMITER_FILTER}[aout]"
    )
}

fn transcript_audio_path_for(final_path: &Path) -> Option<PathBuf> {
    final_path
        .parent()
        .map(|dir| dir.join("transcript-audio.m4a"))
}

fn promote_primary_capture(primary_path: &Path, final_path: &Path) -> Result<(), String> {
    if primary_path == final_path {
        return Ok(());
    }
    if !primary_path.exists() {
        return Err(format!(
            "primary capture '{}' does not exist",
            primary_path.display()
        ));
    }

    if final_path.exists() {
        fs::remove_file(final_path).map_err(|error| {
            format!(
                "failed to replace partial output '{}': {error}",
                final_path.display()
            )
        })?;
    }

    match fs::rename(primary_path, final_path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(primary_path, final_path).map_err(|copy_error| {
                format!(
                    "failed to move '{}' to '{}' (rename error: {rename_error}, copy error: {copy_error})",
                    primary_path.display(),
                    final_path.display()
                )
            })?;
            match fs::remove_file(primary_path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!(
                    "copied primary capture to '{}' but failed to remove '{}': {error}",
                    final_path.display(),
                    primary_path.display()
                )),
            }
        }
    }
}

pub fn ffmpeg_available(app: &AppHandle) -> bool {
    hidden_command(ffmpeg_program(app))
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn hidden_command<P: AsRef<std::ffi::OsStr>>(program: P) -> Command {
    let mut command = Command::new(program);
    hide_console_window(&mut command);
    command
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

pub fn ffmpeg_program(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("VOXLY_FFMPEG") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in bundled_candidates(&resource_dir) {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in bundled_candidates(dir) {
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }

    if cfg!(windows) {
        PathBuf::from("ffmpeg.exe")
    } else {
        PathBuf::from("ffmpeg")
    }
}

fn bundled_candidates(base: &Path) -> Vec<PathBuf> {
    let binary = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    vec![
        base.join(binary),
        base.join("binaries").join(binary),
        base.join("ffmpeg").join(binary),
    ]
}

fn build_args(
    output_path: &Path,
    options: &MeetingStartOptions,
    include_system_audio: bool,
    is_final_output: bool,
) -> Result<Vec<String>, String> {
    if !cfg!(windows) {
        return Err("Meeting recording is currently implemented for Windows only.".to_string());
    }

    let preset = VideoPreset::from_setting(&options.video_preset);
    let record_video = options.record_video && !matches!(preset, VideoPreset::AudioOnly);
    let mut args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-rtbufsize".to_string(),
        "1024M".to_string(),
    ];

    let mut input_index = 0usize;
    let mut video_input: Option<usize> = None;
    let mut audio_inputs: Vec<usize> = Vec::new();

    if record_video {
        args.extend([
            "-f".to_string(),
            "gdigrab".to_string(),
            "-framerate".to_string(),
            preset.framerate().to_string(),
            "-i".to_string(),
            "desktop".to_string(),
        ]);
        video_input = Some(input_index);
        input_index += 1;
    }

    if options.record_mic {
        if let Some(device) = clean_device_name(options.mic_device.as_deref()) {
            args.extend([
                "-f".to_string(),
                "dshow".to_string(),
                "-i".to_string(),
                format!("audio={device}"),
            ]);
            audio_inputs.push(input_index);
            input_index += 1;
        }
    }

    if include_system_audio && options.record_system_audio {
        if let Some(device) = clean_device_name(options.system_audio_device.as_deref()) {
            args.extend([
                "-f".to_string(),
                "dshow".to_string(),
                "-i".to_string(),
                format!("audio={device}"),
            ]);
            audio_inputs.push(input_index);
        }
    }

    if video_input.is_none() && audio_inputs.is_empty() {
        return Err(
            "No meeting capture source is configured. Choose screen capture, a microphone device, or a system-audio loopback device."
                .to_string(),
        );
    }

    if audio_inputs.len() > 1 {
        let inputs = audio_inputs
            .iter()
            .map(|index| format!("[{index}:a]"))
            .collect::<String>();
        args.extend([
            "-filter_complex".to_string(),
            format!(
                "{inputs}amix=inputs={}:duration=longest:normalize=0[aout]",
                audio_inputs.len()
            ),
        ]);
    }

    if let Some(index) = video_input {
        args.extend(["-map".to_string(), format!("{index}:v")]);
    }

    match audio_inputs.as_slice() {
        [] => {}
        [index] => args.extend(["-map".to_string(), format!("{index}:a")]),
        _ => args.extend(["-map".to_string(), "[aout]".to_string()]),
    }

    if video_input.is_some() {
        args.extend([
            "-vf".to_string(),
            format!("scale=-2:{}", preset.height()),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "28".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]);
    }

    if !audio_inputs.is_empty() {
        if is_final_output {
            args.extend(["-af".to_string(), MEETING_AUDIO_GAIN_FILTER.to_string()]);
        }
        args.extend([
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
            "-ar".to_string(),
            "48000".to_string(),
        ]);
    }

    // The intermediate capture gets remuxed into the final file, so faststart's
    // whole-file rewrite at quit time would be wasted work that delays stop.
    if is_final_output {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    args.push(output_path.to_string_lossy().to_string());

    Ok(args)
}

fn clean_device_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

enum VideoPreset {
    AudioOnly,
    Screen720p15,
    Screen720p30,
    Screen1080p30,
}

impl VideoPreset {
    fn from_setting(value: &str) -> Self {
        match value {
            "audio_only" => Self::AudioOnly,
            "screen_720p_15" => Self::Screen720p15,
            "screen_1080p_30" => Self::Screen1080p30,
            _ => Self::Screen720p30,
        }
    }

    fn framerate(&self) -> u32 {
        match self {
            Self::Screen720p15 => 15,
            Self::Screen720p30 | Self::Screen1080p30 => 30,
            Self::AudioOnly => 0,
        }
    }

    fn height(&self) -> u32 {
        match self {
            Self::Screen1080p30 => 1080,
            Self::Screen720p15 | Self::Screen720p30 | Self::AudioOnly => 720,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dikt_meeting_recorder_test_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn promote_primary_capture_replaces_partial_final_file() {
        let dir = test_dir();
        let primary = dir.join("capture.mp4");
        let final_path = dir.join("recording.mp4");
        fs::write(&primary, b"primary").unwrap();
        fs::write(&final_path, b"partial").unwrap();

        promote_primary_capture(&primary, &final_path).unwrap();

        assert_eq!(fs::read(&final_path).unwrap(), b"primary");
        assert!(!primary.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn promote_primary_capture_errors_when_primary_is_missing() {
        let dir = test_dir();
        let primary = dir.join("capture.mp4");
        let final_path = dir.join("recording.mp4");

        let error = promote_primary_capture(&primary, &final_path).unwrap_err();

        assert!(error.contains("does not exist"));
        assert!(!final_path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    fn mic_only_options() -> MeetingStartOptions {
        MeetingStartOptions {
            title: None,
            record_video: false,
            record_mic: true,
            record_system_audio: false,
            video_preset: "audio_only".to_string(),
            mic_device: Some("Test Mic".to_string()),
            system_audio_device: None,
        }
    }

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn build_args_keeps_faststart_and_gain_for_final_output() {
        let args = build_args(Path::new("out.mp4"), &mic_only_options(), false, true).unwrap();

        assert!(has_pair(&args, "-movflags", "+faststart"));
        assert!(has_pair(&args, "-af", MEETING_AUDIO_GAIN_FILTER));
    }

    #[test]
    fn build_args_omits_faststart_and_gain_for_intermediate_capture() {
        let args = build_args(Path::new("capture.mp4"), &mic_only_options(), false, false).unwrap();

        assert!(!args.contains(&"+faststart".to_string()));
        assert!(!args.contains(&"-af".to_string()));
    }

    #[test]
    fn audio_offset_filter_delays_late_system_audio() {
        assert_eq!(
            audio_offset_filter("[1:a]", "[sys]", 750, false),
            "[1:a]asetpts=PTS-STARTPTS,adelay=750:all=1[sys]"
        );
    }

    #[test]
    fn audio_offset_filter_trims_early_system_audio_and_applies_gain() {
        assert_eq!(
            audio_offset_filter("[1:a]", "[aout]", -1250, true),
            "[1:a]atrim=start=1.250,asetpts=PTS-STARTPTS,volume=2.0[aout]"
        );
    }

    #[test]
    fn audio_offset_filter_uses_anull_for_zero_offset_without_gain() {
        assert_eq!(
            audio_offset_filter("[1:a]", "[sys]", 0, false),
            "[1:a]asetpts=PTS-STARTPTS[sys]"
        );
    }

    #[test]
    fn mic_system_mix_filter_boosts_mic_before_mixing() {
        assert_eq!(
            mic_system_mix_filter(0),
            "[0:a]asetpts=PTS-STARTPTS,volume=3.0[mic];[1:a]asetpts=PTS-STARTPTS[sys];[mic][sys]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout]"
        );
    }

    #[test]
    fn mic_system_mix_filter_preserves_system_offset() {
        assert_eq!(
            mic_system_mix_filter(250),
            "[0:a]asetpts=PTS-STARTPTS,volume=3.0[mic];[1:a]asetpts=PTS-STARTPTS,adelay=250:all=1[sys];[mic][sys]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout]"
        );
    }

    #[test]
    fn combined_post_filter_splits_mic_and_system_into_mix_and_transcript() {
        assert_eq!(
            combined_post_filter(0),
            "[0:a]asetpts=PTS-STARTPTS,volume=3.0,asplit=2[mic_mix][mic_tr];[1:a]asetpts=PTS-STARTPTS,asplit=2[sys_mix][sys_tr];[mic_mix][sys_mix]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout];[mic_tr]pan=mono|c0=c0,apad=pad_dur=3[mt];[sys_tr]pan=mono|c0=0.5*c0+0.5*c1,apad=pad_dur=3[st];[mt][st]join=inputs=2:channel_layout=stereo[tout]"
        );
    }

    #[test]
    fn combined_post_filter_preserves_system_offset() {
        assert!(combined_post_filter(250)
            .contains("[1:a]asetpts=PTS-STARTPTS,adelay=250:all=1,asplit=2[sys_mix][sys_tr]"));
        assert!(combined_post_filter(-1250)
            .contains("[1:a]atrim=start=1.250,asetpts=PTS-STARTPTS,asplit=2[sys_mix][sys_tr]"));
    }

    #[test]
    fn post_process_args_builds_two_outputs_with_progress() {
        let args = post_process_args(
            Some(Path::new("capture.mp4")),
            Path::new("system.wav"),
            Path::new("final.mp4"),
            Some(Path::new("transcript.m4a")),
            true,
            true,
            0,
        );

        assert!(has_pair(&args, "-progress", "pipe:1"));
        assert!(args.contains(&"-nostats".to_string()));
        assert!(has_pair(&args, "-map", "0:v?"));
        assert!(has_pair(&args, "-c:v", "copy"));
        assert!(has_pair(&args, "-map", "[aout]"));
        assert!(has_pair(&args, "-map", "[tout]"));
        assert!(has_pair(&args, "-movflags", "+faststart"));

        let final_pos = args.iter().position(|a| a == "final.mp4").unwrap();
        let transcript_pos = args.iter().position(|a| a == "transcript.m4a").unwrap();
        assert!(final_pos < transcript_pos);
        let faststart_pos = args.iter().position(|a| a == "+faststart").unwrap();
        assert!(faststart_pos < final_pos);
    }

    #[test]
    fn post_process_args_without_transcript_matches_mix_only_shape() {
        let args = post_process_args(
            Some(Path::new("capture.mp4")),
            Path::new("system.wav"),
            Path::new("final.mp4"),
            None,
            true,
            true,
            0,
        );

        assert!(!args.iter().any(|a| a.contains("[tout]")));
        assert!(args.iter().any(|a| a.contains("amix=inputs=2")));
        assert_eq!(args.last().unwrap(), "final.mp4");
    }

    #[test]
    fn post_process_args_system_only_uses_first_input() {
        let args = post_process_args(
            None,
            Path::new("system.wav"),
            Path::new("final.mp4"),
            None,
            false,
            false,
            0,
        );

        assert!(args.iter().any(|a| a.starts_with("[0:a]")));
        assert!(!has_pair(&args, "-c:v", "copy"));
    }
}
