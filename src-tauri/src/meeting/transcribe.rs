use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::io::ReaderStream;

use crate::meeting::recorder;
use crate::meeting::storage;
use crate::meeting::types::{
    MeetingMeta, MeetingStatus, MeetingTranscript, MeetingUpdate, TranscriptStatus, Utterance,
};

const ASSEMBLYAI_BASE_URL: &str = "https://api.assemblyai.com";
const UPLOAD_PATH: &str = "/v2/upload";
const TRANSCRIPT_PATH: &str = "/v2/transcript";
const POLL_INITIAL_DELAY: Duration = Duration::from_secs(3);
const POLL_MAX_DELAY: Duration = Duration::from_secs(15);
const REQUEST_MAX_ATTEMPTS: usize = 5;
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn begin(id: &str) -> Result<MeetingMeta, String> {
    let source_path = storage::source_path(id)?;
    let started_at_ms = storage::now_ms()?;
    let updated = storage::update_meta_by_id(id, |meta| {
        if !matches!(meta.status, MeetingStatus::Recorded) {
            return Err("Only completed meeting recordings can be transcribed.".to_string());
        }
        if !meta.has_mic && !meta.has_system_audio {
            return Err("This meeting has no captured audio to transcribe.".to_string());
        }
        if matches!(meta.transcript_status, Some(TranscriptStatus::Pending)) {
            return Err("This meeting is already being transcribed.".to_string());
        }
        if !source_path.exists() {
            return Err("The meeting source file is missing.".to_string());
        }

        meta.transcript_status = Some(TranscriptStatus::Pending);
        meta.transcript_error = None;
        meta.assemblyai_transcript_id = None;
        meta.transcript_started_at_ms = Some(started_at_ms);
        Ok(())
    })?;

    updated.ok_or_else(|| "Meeting not found".to_string())
}

pub async fn run(app: AppHandle, api_key: String, id: String) {
    emit_update(&app, "transcribing", &id, None);
    let result = run_inner(&app, &api_key, &id).await;
    if let Err(error) = result {
        mark_error(&app, &id, error).await;
    }
}

async fn run_inner(app: &AppHandle, api_key: &str, id: &str) -> Result<(), String> {
    ensure_meeting_exists(id)?;

    let audio_upload = prepare_audio_upload(app, id).await?;
    let cleanup_path = audio_upload.cleanup.then_some(audio_upload.path.clone());
    let result = async {
        ensure_meeting_exists(id)?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

        let upload_url = upload_file(&client, api_key, &audio_upload.path)
            .await
            .map_err(|error| error.to_string())?;
        ensure_meeting_exists(id)?;

        let transcript_id =
            submit_transcript(&client, api_key, &upload_url, audio_upload.multichannel)
                .await
                .map_err(|error| error.to_string())?;
        set_transcript_id(id, &transcript_id)?;
        ensure_meeting_exists(id)?;

        let response = poll_transcript(&client, api_key, id, &transcript_id).await?;
        ensure_meeting_exists(id)?;

        let transcript = parse_transcript(response)?;
        storage::save_transcript(id, &transcript)?;
        let updated = storage::update_meta_by_id(id, |meta| {
            meta.transcript_status = Some(TranscriptStatus::Completed);
            meta.transcript_error = None;
            meta.assemblyai_transcript_id = Some(transcript_id.clone());
            Ok(())
        })?;
        if updated.is_none() {
            return Err("Meeting no longer exists.".to_string());
        }

        emit_update(app, "transcribed", id, None);
        let _ = app.emit("meetings-updated", ());
        Ok(())
    }
    .await;

    if let Some(cleanup_path) = cleanup_path {
        let _ = tokio::fs::remove_file(cleanup_path).await;
    }
    result
}

async fn mark_error(app: &AppHandle, id: &str, error: String) {
    let updated = storage::update_meta_by_id(id, |meta| {
        meta.transcript_status = Some(TranscriptStatus::Error);
        meta.transcript_error = Some(error.clone());
        Ok(())
    })
    .ok()
    .flatten();

    if updated.is_some() {
        emit_update(app, "transcription_error", id, Some(error));
        let _ = app.emit("meetings-updated", ());
    }
}

fn set_transcript_id(id: &str, transcript_id: &str) -> Result<(), String> {
    let updated = storage::update_meta_by_id(id, |meta| {
        meta.assemblyai_transcript_id = Some(transcript_id.to_string());
        Ok(())
    })?;
    if updated.is_none() {
        return Err("Meeting no longer exists.".to_string());
    }
    Ok(())
}

fn ensure_meeting_exists(id: &str) -> Result<(), String> {
    if storage::meeting_exists(id)? {
        Ok(())
    } else {
        Err("Meeting no longer exists.".to_string())
    }
}

struct AudioUpload {
    path: PathBuf,
    cleanup: bool,
    multichannel: bool,
}

async fn prepare_audio_upload(app: &AppHandle, id: &str) -> Result<AudioUpload, String> {
    let transcript_audio = storage::transcript_audio_path(id)?;
    if transcript_audio.exists() {
        return Ok(AudioUpload {
            path: transcript_audio,
            cleanup: false,
            multichannel: true,
        });
    }

    Ok(AudioUpload {
        path: extract_audio(app, id).await?,
        cleanup: true,
        multichannel: false,
    })
}

async fn extract_audio(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let source = storage::source_path(id)?;
    if !source.exists() {
        return Err("The meeting source file is missing.".to_string());
    }

    let meeting_dir = storage::meeting_dir(id)?;
    if !meeting_dir.exists() {
        return Err("Meeting folder no longer exists.".to_string());
    }

    let output = meeting_dir.join(format!("transcript-audio-{}.m4a", uuid::Uuid::new_v4()));
    let ffmpeg = recorder::ffmpeg_program(app);
    let args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        source.to_string_lossy().to_string(),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "64k".to_string(),
        output.to_string_lossy().to_string(),
    ];
    let mut command = hidden_tokio_command(&ffmpeg);
    command.args(args);

    let output_result = command
        .output()
        .await
        .map_err(|error| format!("Failed to extract meeting audio with FFmpeg: {error}"))?;

    if !output_result.status.success() {
        return Err(format!(
            "Failed to extract meeting audio with FFmpeg: {}",
            String::from_utf8_lossy(&output_result.stderr)
        ));
    }

    if !output.exists() {
        return Err("FFmpeg did not create an audio file.".to_string());
    }

    Ok(output)
}

fn hidden_tokio_command(program: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    hide_console_window(&mut command);
    command
}

#[cfg(windows)]
fn hide_console_window(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut tokio::process::Command) {
    let _ = CREATE_NO_WINDOW;
}

async fn upload_file(
    client: &reqwest::Client,
    api_key: &str,
    path: &Path,
) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    struct UploadResponse {
        upload_url: String,
    }

    let url = format!("{ASSEMBLYAI_BASE_URL}{UPLOAD_PATH}");
    let mut delay = Duration::from_secs(1);
    for attempt in 1..=REQUEST_MAX_ATTEMPTS {
        let file = tokio::fs::File::open(path).await.map_err(|error| {
            ApiError::transport(format!("Failed to open extracted audio: {error}"))
        })?;
        let content_length = file
            .metadata()
            .await
            .map_err(|error| {
                ApiError::transport(format!("Failed to inspect extracted audio: {error}"))
            })?
            .len();
        let stream = ReaderStream::new(file);
        let response = client
            .post(&url)
            .header(AUTHORIZATION, api_key)
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(reqwest::Body::wrap_stream(stream))
            .header(reqwest::header::CONTENT_LENGTH, content_length)
            .send()
            .await
            .map_err(|error| ApiError::transport(error.to_string()));

        match response {
            Ok(response) => match parse_json_response::<UploadResponse>(response).await {
                Ok(parsed) => return Ok(parsed.upload_url),
                Err(error) if should_retry(&error) && attempt < REQUEST_MAX_ATTEMPTS => {
                    sleep_retry(error.retry_after.unwrap_or(delay)).await;
                    delay = next_delay(delay);
                }
                Err(error) => return Err(error),
            },
            Err(error) if should_retry(&error) && attempt < REQUEST_MAX_ATTEMPTS => {
                sleep_retry(delay).await;
                delay = next_delay(delay);
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::transport(
        "Upload retry limit exceeded".to_string(),
    ))
}

async fn submit_transcript(
    client: &reqwest::Client,
    api_key: &str,
    audio_url: &str,
    multichannel: bool,
) -> Result<String, ApiError> {
    #[derive(Serialize)]
    struct SubmitRequest<'a> {
        audio_url: &'a str,
        speaker_labels: bool,
        language_detection: bool,
        multichannel: bool,
    }

    #[derive(Deserialize)]
    struct SubmitResponse {
        id: String,
        status: String,
    }

    let url = format!("{ASSEMBLYAI_BASE_URL}{TRANSCRIPT_PATH}");
    let response: SubmitResponse = post_json_with_retries(
        client,
        &url,
        api_key,
        &SubmitRequest {
            audio_url,
            speaker_labels: !multichannel,
            language_detection: true,
            multichannel,
        },
    )
    .await?;

    if !matches!(
        response.status.as_str(),
        "queued" | "processing" | "completed"
    ) {
        return Err(ApiError::transport(format!(
            "Unexpected AssemblyAI transcript status '{}'",
            response.status
        )));
    }

    Ok(response.id)
}

async fn poll_transcript(
    client: &reqwest::Client,
    api_key: &str,
    meeting_id: &str,
    transcript_id: &str,
) -> Result<AssemblyTranscriptResponse, String> {
    let started = std::time::Instant::now();
    let mut delay = POLL_INITIAL_DELAY;
    let url = format!("{ASSEMBLYAI_BASE_URL}{TRANSCRIPT_PATH}/{transcript_id}");

    loop {
        if started.elapsed() > TRANSCRIPTION_TIMEOUT {
            return Err("AssemblyAI transcription timed out. Retry to start again.".to_string());
        }
        ensure_meeting_exists(meeting_id)?;

        match get_json::<AssemblyTranscriptResponse>(client, &url, api_key).await {
            Ok(response) => match response.status.as_str() {
                "completed" => return Ok(response),
                "error" => {
                    return Err(response
                        .error
                        .unwrap_or_else(|| "AssemblyAI transcription failed.".to_string()))
                }
                "queued" | "processing" => {
                    sleep_retry(delay).await;
                    delay = next_poll_delay(delay);
                }
                other => return Err(format!("Unexpected AssemblyAI transcript status '{other}'")),
            },
            Err(error) if should_retry(&error) => {
                sleep_retry(error.retry_after.unwrap_or(delay)).await;
                delay = next_poll_delay(delay);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

async fn post_json_with_retries<T, R>(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    json: &T,
) -> Result<R, ApiError>
where
    T: Serialize + ?Sized,
    R: for<'de> Deserialize<'de>,
{
    let mut delay = Duration::from_secs(1);
    for attempt in 1..=REQUEST_MAX_ATTEMPTS {
        let response = client
            .post(url)
            .header(AUTHORIZATION, api_key)
            .json(json)
            .send()
            .await
            .map_err(|error| ApiError::transport(error.to_string()));

        match response {
            Ok(response) => match parse_json_response(response).await {
                Ok(parsed) => return Ok(parsed),
                Err(error) if should_retry(&error) && attempt < REQUEST_MAX_ATTEMPTS => {
                    sleep_retry(error.retry_after.unwrap_or(delay)).await;
                    delay = next_delay(delay);
                }
                Err(error) => return Err(error),
            },
            Err(error) if should_retry(&error) && attempt < REQUEST_MAX_ATTEMPTS => {
                sleep_retry(delay).await;
                delay = next_delay(delay);
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::transport(
        "Request retry limit exceeded".to_string(),
    ))
}

async fn get_json<R>(client: &reqwest::Client, url: &str, api_key: &str) -> Result<R, ApiError>
where
    R: for<'de> Deserialize<'de>,
{
    let response = client
        .get(url)
        .header(AUTHORIZATION, api_key)
        .send()
        .await
        .map_err(|error| ApiError::transport(error.to_string()))?;
    parse_json_response(response).await
}

async fn parse_json_response<R>(response: reqwest::Response) -> Result<R, ApiError>
where
    R: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    let body = response
        .text()
        .await
        .map_err(|error| ApiError::transport(error.to_string()))?;

    if !status.is_success() {
        return Err(ApiError::api(status, body, retry_after));
    }

    serde_json::from_str(&body).map_err(|error| ApiError::transport(error.to_string()))
}

fn parse_transcript(response: AssemblyTranscriptResponse) -> Result<MeetingTranscript, String> {
    let is_multichannel = response.audio_channels.unwrap_or(1) > 1;
    let mut utterances: Vec<Utterance> = response
        .utterances
        .unwrap_or_default()
        .into_iter()
        .filter_map(|utterance| {
            let speaker = utterance.speaker?;
            Some(Utterance {
                speaker: if is_multichannel {
                    channel_label(&speaker)
                } else {
                    speaker
                },
                text: utterance.text.unwrap_or_default(),
                start_ms: utterance.start?,
                end_ms: utterance.end?,
                confidence: utterance.confidence,
            })
        })
        .collect();

    if is_multichannel {
        utterances = filter_multichannel_bleed(utterances);
    }
    let text = if is_multichannel && !utterances.is_empty() {
        utterances
            .iter()
            .map(|utterance| utterance.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        response.text.unwrap_or_default()
    };

    Ok(MeetingTranscript {
        utterances,
        text,
        audio_duration_secs: response.audio_duration,
        language_code: response.language_code,
        provider: "assemblyai".to_string(),
        created_at_ms: storage::now_ms()?,
    })
}

fn channel_label(value: &str) -> String {
    match value {
        "1" => "You".to_string(),
        "2" => "System".to_string(),
        other => format!("Channel {other}"),
    }
}

fn filter_multichannel_bleed(utterances: Vec<Utterance>) -> Vec<Utterance> {
    let system_utterances: Vec<Utterance> = utterances
        .iter()
        .filter(|utterance| utterance.speaker == "System")
        .cloned()
        .collect();

    utterances
        .into_iter()
        .filter(|utterance| {
            if utterance.speaker != "You" {
                return true;
            }
            !is_system_bleed_duplicate(utterance, &system_utterances)
        })
        .collect()
}

fn is_system_bleed_duplicate(utterance: &Utterance, system_utterances: &[Utterance]) -> bool {
    let overlapping_system_text = system_utterances
        .iter()
        .filter(|system| utterances_overlap_with_slop(utterance, system, 1_500))
        .map(|system| system.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    if overlapping_system_text.trim().is_empty() {
        return false;
    }

    token_containment(&utterance.text, &overlapping_system_text) >= 0.55
}

fn utterances_overlap_with_slop(a: &Utterance, b: &Utterance, slop_ms: i64) -> bool {
    let a_start = a.start_ms.saturating_sub(slop_ms);
    let a_end = a.end_ms.saturating_add(slop_ms);
    let b_start = b.start_ms.saturating_sub(slop_ms);
    let b_end = b.end_ms.saturating_add(slop_ms);
    a_start < b_end && b_start < a_end
}

fn token_containment(candidate: &str, reference: &str) -> f64 {
    let candidate_tokens = normalized_tokens(candidate);
    if candidate_tokens.is_empty() {
        return 0.0;
    }
    let reference_tokens = normalized_tokens(reference);
    if reference_tokens.is_empty() {
        return 0.0;
    }

    let matched = candidate_tokens
        .iter()
        .filter(|token| reference_tokens.iter().any(|reference| reference == *token))
        .count();
    matched as f64 / candidate_tokens.len() as f64
}

fn normalized_tokens(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|token| token.len() > 1)
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

fn emit_update(app: &AppHandle, state: &str, id: &str, message: Option<String>) {
    let _ = app.emit(
        "meeting:update",
        MeetingUpdate {
            state: state.to_string(),
            meeting_id: Some(id.to_string()),
            message,
            elapsed_secs: None,
            file_size_bytes: None,
        },
    );
}

fn should_retry(error: &ApiError) -> bool {
    let Some(status) = error.status else {
        return false;
    };
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn next_delay(current: Duration) -> Duration {
    std::cmp::min(current * 2, Duration::from_secs(30))
}

fn next_poll_delay(current: Duration) -> Duration {
    std::cmp::min(current + Duration::from_secs(2), POLL_MAX_DELAY)
}

async fn sleep_retry(delay: Duration) {
    tokio::time::sleep(delay).await;
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    value.parse::<u64>().ok().map(Duration::from_secs)
}

#[derive(Debug, Deserialize)]
struct AssemblyTranscriptResponse {
    status: String,
    text: Option<String>,
    audio_duration: Option<f64>,
    audio_channels: Option<u32>,
    language_code: Option<String>,
    utterances: Option<Vec<AssemblyUtterance>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssemblyUtterance {
    speaker: Option<String>,
    text: Option<String>,
    start: Option<i64>,
    end: Option<i64>,
    confidence: Option<f64>,
}

#[derive(Debug)]
struct ApiError {
    status: Option<reqwest::StatusCode>,
    body: String,
    retry_after: Option<Duration>,
}

impl ApiError {
    fn api(status: reqwest::StatusCode, body: String, retry_after: Option<Duration>) -> Self {
        Self {
            status: Some(status),
            body,
            retry_after,
        }
    }

    fn transport(message: String) -> Self {
        Self {
            status: None,
            body: message,
            retry_after: None,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "AssemblyAI API error {status}: {}", self.body),
            None => write!(f, "{}", self.body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_transcript, AssemblyTranscriptResponse, AssemblyUtterance};

    #[test]
    fn parse_transcript_maps_language_code_and_utterances() {
        let transcript = parse_transcript(AssemblyTranscriptResponse {
            status: "completed".to_string(),
            text: Some("Hello there.".to_string()),
            audio_duration: Some(12.5),
            audio_channels: Some(1),
            language_code: Some("en_us".to_string()),
            error: None,
            utterances: Some(vec![AssemblyUtterance {
                speaker: Some("A".to_string()),
                text: Some("Hello there.".to_string()),
                start: Some(250),
                end: Some(1250),
                confidence: Some(0.91),
            }]),
        })
        .unwrap();

        assert_eq!(transcript.language_code.as_deref(), Some("en_us"));
        assert_eq!(transcript.utterances.len(), 1);
        assert_eq!(transcript.utterances[0].speaker, "A");
        assert_eq!(transcript.utterances[0].start_ms, 250);
        assert_eq!(transcript.utterances[0].end_ms, 1250);
    }

    #[test]
    fn parse_multichannel_transcript_removes_system_bleed_from_mic_channel() {
        let transcript = parse_transcript(AssemblyTranscriptResponse {
            status: "completed".to_string(),
            text: Some("duplicated raw text".to_string()),
            audio_duration: Some(23.0),
            audio_channels: Some(2),
            language_code: Some("en".to_string()),
            error: None,
            utterances: Some(vec![
                AssemblyUtterance {
                    speaker: Some("1".to_string()),
                    text: Some("This is me speaking with you directly.".to_string()),
                    start: Some(190),
                    end: Some(5859),
                    confidence: Some(0.98),
                },
                AssemblyUtterance {
                    speaker: Some("2".to_string()),
                    text: Some("The DJI Spark was initially thought to be $3,000, then at launch it became $4,000,".to_string()),
                    start: Some(5770),
                    end: Some(14100),
                    confidence: Some(0.94),
                },
                AssemblyUtterance {
                    speaker: Some("1".to_string()),
                    text: Some("DJI Spark was initially thought to be $3,000, and at launch it became $4,000, and then it became $4,600 to $4,700.".to_string()),
                    start: Some(6720),
                    end: Some(17390),
                    confidence: Some(0.87),
                },
                AssemblyUtterance {
                    speaker: Some("2".to_string()),
                    text: Some("and then it became $4,600 to $4,700.".to_string()),
                    start: Some(14700),
                    end: Some(17710),
                    confidence: Some(0.94),
                },
            ]),
        })
        .unwrap();

        assert_eq!(transcript.utterances.len(), 3);
        assert_eq!(transcript.utterances[0].speaker, "You");
        assert_eq!(transcript.utterances[1].speaker, "System");
        assert_eq!(transcript.utterances[2].speaker, "System");
        assert!(!transcript.text.contains("duplicated raw text"));
        assert!(!transcript
            .text
            .contains("and at launch it became $4,000, and then"));
    }
}
