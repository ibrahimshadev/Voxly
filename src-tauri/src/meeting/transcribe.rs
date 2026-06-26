use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio_util::io::ReaderStream;

use crate::meeting::recorder;
use crate::meeting::storage;
use crate::meeting::types::{
    MeetingMeta, MeetingStatus, MeetingTranscript, MeetingUpdate, TranscriptStatus, Utterance,
};

const DEEPGRAM_LISTEN_URL: &str = "https://api.deepgram.com/v1/listen";
const REQUEST_MAX_ATTEMPTS: usize = 5;
const DEEPGRAM_TIMEOUT: Duration = Duration::from_secs(660);
const DEEPGRAM_UTT_SPLIT_SECS: &str = "1.5";
const TURN_MERGE_MAX_GAP_MS: i64 = 1_500;
const TURN_MERGE_MAX_DURATION_MS: i64 = 30_000;
const TURN_MERGE_MAX_CHARS: usize = 650;
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Default)]
pub struct DeepgramTranscriptionOptions {
    pub keyterms: Vec<String>,
    pub language: String,
    pub redact_pii: bool,
    pub redact_pci: bool,
}

struct ParsedDeepgramTranscript {
    transcript: MeetingTranscript,
    request_id: Option<String>,
}

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

pub async fn run(
    app: AppHandle,
    api_key: String,
    options: DeepgramTranscriptionOptions,
    id: String,
) {
    emit_update(&app, "transcribing", &id, None);
    let result = run_inner(&app, &api_key, &options, &id).await;
    if let Err(error) = result {
        mark_error(&app, &id, error).await;
    }
}

async fn run_inner(
    app: &AppHandle,
    api_key: &str,
    options: &DeepgramTranscriptionOptions,
    id: &str,
) -> Result<(), String> {
    ensure_meeting_exists(id)?;

    let audio_upload = prepare_audio_upload(app, id).await?;
    let cleanup_path = audio_upload.cleanup.then_some(audio_upload.path.clone());
    let result = async {
        ensure_meeting_exists(id)?;

        let client = reqwest::Client::builder()
            .timeout(DEEPGRAM_TIMEOUT)
            .build()
            .map_err(|error| format!("Failed to create HTTP client: {error}"))?;

        let response = transcribe_deepgram(
            &client,
            api_key,
            id,
            &audio_upload.path,
            audio_upload.multichannel,
            options,
        )
        .await
        .map_err(|error| error.to_string())?;
        ensure_meeting_exists(id)?;

        let mut parsed = parse_deepgram(response, audio_upload.multichannel, &options.language)?;
        preserve_speaker_names(id, &mut parsed.transcript)?;
        storage::save_transcript(id, &parsed.transcript)?;

        let updated = storage::update_meta_by_id(id, |meta| {
            meta.transcript_status = Some(TranscriptStatus::Completed);
            meta.transcript_error = None;
            meta.assemblyai_transcript_id = parsed.request_id.clone();
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

fn preserve_speaker_names(id: &str, transcript: &mut MeetingTranscript) -> Result<(), String> {
    let Some(previous) = storage::load_transcript(id)? else {
        return Ok(());
    };
    if previous.speaker_names.is_empty() {
        return Ok(());
    }

    let speakers = transcript
        .utterances
        .iter()
        .map(|utterance| utterance.speaker.clone())
        .collect::<HashSet<_>>();
    transcript.speaker_names = previous
        .speaker_names
        .into_iter()
        .filter(|(speaker, _)| speakers.contains(speaker))
        .collect();
    Ok(())
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

async fn transcribe_deepgram(
    client: &reqwest::Client,
    api_key: &str,
    meeting_id: &str,
    path: &Path,
    multichannel: bool,
    options: &DeepgramTranscriptionOptions,
) -> Result<DeepgramResponse, ApiError> {
    let params = build_deepgram_query_params(meeting_id, multichannel, options);
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
            .post(DEEPGRAM_LISTEN_URL)
            .query(&params)
            .header(AUTHORIZATION, format!("Token {api_key}"))
            .header(CONTENT_TYPE, content_type_for(path))
            .header(reqwest::header::CONTENT_LENGTH, content_length)
            .body(reqwest::Body::wrap_stream(stream))
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
                sleep_retry(error.retry_after.unwrap_or(delay)).await;
                delay = next_delay(delay);
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::transport(
        "Deepgram request retry limit exceeded".to_string(),
    ))
}

fn build_deepgram_query_params(
    meeting_id: &str,
    multichannel: bool,
    options: &DeepgramTranscriptionOptions,
) -> Vec<(&'static str, String)> {
    let mut params = vec![
        ("model", "nova-3".to_string()),
        ("diarize_model", "latest".to_string()),
        ("smart_format", "true".to_string()),
        ("punctuate", "true".to_string()),
        ("utterances", "true".to_string()),
        ("utt_split", DEEPGRAM_UTT_SPLIT_SECS.to_string()),
        ("tag", "dikt-meeting".to_string()),
        ("extra", format!("meeting_id:{meeting_id}")),
        (
            "language",
            if options.language.trim() == "multi" {
                "multi".to_string()
            } else {
                "en".to_string()
            },
        ),
    ];

    if multichannel {
        params.push(("multichannel", "true".to_string()));
    }

    for term in &options.keyterms {
        let term = term.trim();
        if !term.is_empty() {
            params.push(("keyterm", term.to_string()));
        }
    }

    if options.redact_pii {
        params.push(("redact", "pii".to_string()));
    }
    if options.redact_pci {
        params.push(("redact", "pci".to_string()));
    }

    params
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

fn parse_deepgram(
    response: DeepgramResponse,
    multichannel: bool,
    requested_language: &str,
) -> Result<ParsedDeepgramTranscript, String> {
    let request_id = response.metadata.request_id.clone();
    let duration = response.metadata.duration;
    let language_code = detected_language(&response).or_else(|| {
        Some(if requested_language.trim() == "multi" {
            "multi".to_string()
        } else {
            "en".to_string()
        })
    });
    let fallback_text = fallback_transcript_text(&response);
    let mut utterances = parse_deepgram_utterances(response.results.utterances, multichannel);

    if multichannel {
        utterances = filter_multichannel_bleed(utterances);
    }
    utterances = merge_adjacent_utterances(utterances);

    let text = if utterances.is_empty() {
        fallback_text
    } else {
        utterances
            .iter()
            .map(|utterance| utterance.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };

    Ok(ParsedDeepgramTranscript {
        transcript: MeetingTranscript {
            utterances,
            text,
            audio_duration_secs: duration,
            language_code,
            provider: "deepgram".to_string(),
            created_at_ms: storage::now_ms()?,
            speaker_names: HashMap::new(),
        },
        request_id,
    })
}

fn parse_deepgram_utterances(
    utterances: Vec<DeepgramUtterance>,
    multichannel: bool,
) -> Vec<Utterance> {
    let mut sortable = utterances
        .into_iter()
        .filter_map(|utterance| {
            let start = utterance.start?;
            let end = utterance.end?;
            if !start.is_finite() || !end.is_finite() || end < start {
                return None;
            }

            let transcript = utterance.transcript?.trim().to_string();
            if transcript.is_empty() {
                return None;
            }

            Some(UsableDeepgramUtterance {
                channel: utterance.channel?,
                speaker: utterance.speaker?,
                start,
                end,
                transcript,
                confidence: utterance.confidence,
            })
        })
        .collect::<Vec<_>>();

    sortable.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut remote_labels = HashMap::<(u32, u32), String>::new();
    let mut mono_labels = HashMap::<u32, String>::new();

    sortable
        .into_iter()
        .map(|utterance| {
            let speaker = if multichannel {
                multichannel_speaker_label(utterance.channel, utterance.speaker, &mut remote_labels)
            } else {
                mono_speaker_label(utterance.speaker, &mut mono_labels)
            };

            Utterance {
                speaker,
                text: utterance.transcript,
                start_ms: seconds_to_ms(utterance.start),
                end_ms: seconds_to_ms(utterance.end),
                confidence: utterance.confidence,
            }
        })
        .collect()
}

fn multichannel_speaker_label(
    channel: u32,
    speaker: u32,
    remote_labels: &mut HashMap<(u32, u32), String>,
) -> String {
    if channel == 0 {
        return "You".to_string();
    }

    let next_label = if channel == 1 {
        format!("Sys-{}", letter_for_index(remote_labels.len()))
    } else {
        format!("Ch{}-{}", channel, letter_for_index(remote_labels.len()))
    };
    remote_labels
        .entry((channel, speaker))
        .or_insert(next_label)
        .clone()
}

fn mono_speaker_label(speaker: u32, labels: &mut HashMap<u32, String>) -> String {
    let next_label = letter_for_index(labels.len());
    labels.entry(speaker).or_insert(next_label).clone()
}

fn seconds_to_ms(seconds: f64) -> i64 {
    (seconds * 1000.0).round() as i64
}

fn fallback_transcript_text(response: &DeepgramResponse) -> String {
    response
        .results
        .channels
        .iter()
        .filter_map(|channel| channel.alternatives.first())
        .filter_map(|alternative| alternative.transcript.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn detected_language(response: &DeepgramResponse) -> Option<String> {
    response
        .results
        .channels
        .iter()
        .filter_map(|channel| channel.alternatives.first())
        .find_map(|alternative| {
            alternative
                .detected_language
                .as_deref()
                .or(alternative.language.as_deref())
                .map(str::to_string)
        })
}

fn content_type_for(_path: &Path) -> &'static str {
    "audio/mp4"
}

fn letter_for_index(index: usize) -> String {
    let mut n = index;
    let mut chars = Vec::new();
    loop {
        let rem = n % 26;
        chars.push((b'A' + rem as u8) as char);
        if n < 26 {
            break;
        }
        n = (n / 26) - 1;
    }
    chars.iter().rev().collect()
}

fn filter_multichannel_bleed(utterances: Vec<Utterance>) -> Vec<Utterance> {
    let remote_utterances: Vec<Utterance> = utterances
        .iter()
        .filter(|utterance| utterance.speaker != "You")
        .cloned()
        .collect();

    utterances
        .into_iter()
        .filter(|utterance| {
            if utterance.speaker != "You" {
                return true;
            }
            !is_system_bleed_duplicate(utterance, &remote_utterances)
        })
        .collect()
}

fn merge_adjacent_utterances(utterances: Vec<Utterance>) -> Vec<Utterance> {
    let mut merged: Vec<Utterance> = Vec::new();

    for utterance in utterances {
        let Some(previous) = merged.last_mut() else {
            merged.push(utterance);
            continue;
        };

        let gap_ms = utterance.start_ms.saturating_sub(previous.end_ms);
        let merged_text = format!(
            "{} {}",
            previous.text.trim_end(),
            utterance.text.trim_start()
        );
        let merged_duration_ms = utterance.end_ms.saturating_sub(previous.start_ms);
        if previous.speaker == utterance.speaker
            && gap_ms <= TURN_MERGE_MAX_GAP_MS
            && merged_duration_ms <= TURN_MERGE_MAX_DURATION_MS
            && merged_text.len() <= TURN_MERGE_MAX_CHARS
        {
            previous.text = merged_text;
            previous.end_ms = utterance.end_ms;
            previous.confidence = merge_confidence(previous.confidence, utterance.confidence);
        } else {
            merged.push(utterance);
        }
    }

    merged
}

fn merge_confidence(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some((left + right) / 2.0),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
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
            progress_pct: None,
        },
    );
}

fn should_retry(error: &ApiError) -> bool {
    let Some(status) = error.status else {
        return false;
    };
    if status == reqwest::StatusCode::GATEWAY_TIMEOUT
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
    {
        return false;
    }
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn next_delay(current: Duration) -> Duration {
    std::cmp::min(current * 2, Duration::from_secs(30))
}

async fn sleep_retry(delay: Duration) {
    tokio::time::sleep(delay).await;
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    value.parse::<u64>().ok().map(Duration::from_secs)
}

#[derive(Debug, Deserialize, Default)]
struct DeepgramResponse {
    #[serde(default)]
    metadata: DeepgramMetadata,
    #[serde(default)]
    results: DeepgramResults,
}

#[derive(Debug, Deserialize, Default)]
struct DeepgramMetadata {
    duration: Option<f64>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct DeepgramResults {
    #[serde(default)]
    utterances: Vec<DeepgramUtterance>,
    #[serde(default)]
    channels: Vec<DeepgramChannel>,
}

#[derive(Debug, Deserialize, Default)]
struct DeepgramChannel {
    #[serde(default)]
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize, Default)]
struct DeepgramAlternative {
    transcript: Option<String>,
    detected_language: Option<String>,
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeepgramUtterance {
    channel: Option<u32>,
    speaker: Option<u32>,
    start: Option<f64>,
    end: Option<f64>,
    transcript: Option<String>,
    confidence: Option<f64>,
}

struct UsableDeepgramUtterance {
    channel: u32,
    speaker: u32,
    start: f64,
    end: f64,
    transcript: String,
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
            Some(reqwest::StatusCode::GATEWAY_TIMEOUT) => write!(
                f,
                "Deepgram processing timed out. Try again or shorten the recording."
            ),
            Some(reqwest::StatusCode::REQUEST_TIMEOUT) => {
                write!(
                    f,
                    "Deepgram request timed out. Try again or shorten the recording."
                )
            }
            Some(status) => write!(f, "Deepgram API error {status}: {}", self.body),
            None => write!(f, "{}", self.body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_deepgram_query_params, letter_for_index, merge_adjacent_utterances, parse_deepgram,
        should_retry, DeepgramAlternative, DeepgramChannel, DeepgramMetadata, DeepgramResponse,
        DeepgramResults, DeepgramTranscriptionOptions, DeepgramUtterance,
    };
    use crate::meeting::types::Utterance;

    fn response(utterances: Vec<DeepgramUtterance>) -> DeepgramResponse {
        DeepgramResponse {
            metadata: DeepgramMetadata {
                duration: Some(12.5),
                request_id: Some("request-1".to_string()),
            },
            results: DeepgramResults {
                utterances,
                channels: vec![DeepgramChannel {
                    alternatives: vec![DeepgramAlternative {
                        transcript: Some("fallback text".to_string()),
                        detected_language: Some("en".to_string()),
                        language: None,
                    }],
                }],
            },
        }
    }

    fn utterance(
        channel: u32,
        speaker: u32,
        start: f64,
        end: f64,
        text: &str,
    ) -> DeepgramUtterance {
        DeepgramUtterance {
            channel: Some(channel),
            speaker: Some(speaker),
            start: Some(start),
            end: Some(end),
            transcript: Some(text.to_string()),
            confidence: Some(0.91),
        }
    }

    #[test]
    fn parse_deepgram_maps_multichannel_speakers_by_channel_and_first_appearance() {
        let parsed = parse_deepgram(
            response(vec![
                utterance(1, 7, 1.0, 2.0, "remote first"),
                utterance(0, 7, 0.0, 1.0, "local"),
                utterance(1, 9, 2.0, 3.0, "remote second"),
                utterance(1, 7, 3.0, 4.0, "remote first again"),
            ]),
            true,
            "en",
        )
        .unwrap();

        let transcript = parsed.transcript;
        assert_eq!(parsed.request_id.as_deref(), Some("request-1"));
        assert_eq!(transcript.provider, "deepgram");
        assert_eq!(transcript.language_code.as_deref(), Some("en"));
        assert_eq!(transcript.audio_duration_secs, Some(12.5));
        assert_eq!(transcript.utterances[0].speaker, "You");
        assert_eq!(transcript.utterances[1].speaker, "Sys-A");
        assert_eq!(transcript.utterances[2].speaker, "Sys-B");
        assert_eq!(transcript.utterances[3].speaker, "Sys-A");
        assert_eq!(transcript.utterances[1].start_ms, 1000);
    }

    #[test]
    fn parse_deepgram_removes_remote_audio_bleed_from_mic_channel() {
        let parsed = parse_deepgram(
            response(vec![
                utterance(0, 0, 0.19, 5.859, "This is me speaking with you directly."),
                utterance(
                    1,
                    0,
                    5.77,
                    14.1,
                    "The DJI Spark was initially thought to be $3,000, then at launch it became $4,000,",
                ),
                utterance(
                    0,
                    0,
                    6.72,
                    17.39,
                    "DJI Spark was initially thought to be $3,000, and at launch it became $4,000, and then it became $4,600 to $4,700.",
                ),
                utterance(1, 1, 14.7, 17.71, "and then it became $4,600 to $4,700."),
            ]),
            true,
            "en",
        )
        .unwrap();

        let transcript = parsed.transcript;
        assert_eq!(transcript.utterances.len(), 3);
        assert_eq!(transcript.utterances[0].speaker, "You");
        assert_eq!(transcript.utterances[1].speaker, "Sys-A");
        assert_eq!(transcript.utterances[2].speaker, "Sys-B");
        assert!(!transcript
            .text
            .contains("and at launch it became $4,000, and then"));
    }

    #[test]
    fn parse_deepgram_maps_mono_speakers_to_raw_letters() {
        let parsed = parse_deepgram(
            response(vec![
                utterance(0, 3, 0.0, 1.0, "first"),
                utterance(0, 8, 1.0, 2.0, "second"),
                utterance(0, 3, 2.0, 3.0, "first again"),
            ]),
            false,
            "multi",
        )
        .unwrap();

        let speakers = parsed
            .transcript
            .utterances
            .iter()
            .map(|utterance| utterance.speaker.as_str())
            .collect::<Vec<_>>();
        assert_eq!(speakers, vec!["A", "B", "A"]);
        assert_eq!(parsed.transcript.language_code.as_deref(), Some("en"));
    }

    #[test]
    fn parse_deepgram_skips_malformed_utterances() {
        let parsed = parse_deepgram(
            response(vec![
                DeepgramUtterance {
                    channel: Some(0),
                    speaker: Some(0),
                    start: Some(0.0),
                    end: Some(1.0),
                    transcript: Some("valid".to_string()),
                    confidence: None,
                },
                DeepgramUtterance {
                    channel: Some(0),
                    speaker: None,
                    start: Some(1.0),
                    end: Some(2.0),
                    transcript: Some("missing speaker".to_string()),
                    confidence: None,
                },
                DeepgramUtterance {
                    channel: Some(0),
                    speaker: Some(0),
                    start: Some(3.0),
                    end: Some(2.0),
                    transcript: Some("bad timing".to_string()),
                    confidence: None,
                },
            ]),
            false,
            "en",
        )
        .unwrap();

        assert_eq!(parsed.transcript.utterances.len(), 1);
        assert_eq!(parsed.transcript.utterances[0].text, "valid");
    }

    #[test]
    fn letter_for_index_uses_spreadsheet_labels() {
        assert_eq!(letter_for_index(0), "A");
        assert_eq!(letter_for_index(25), "Z");
        assert_eq!(letter_for_index(26), "AA");
        assert_eq!(letter_for_index(27), "AB");
    }

    fn app_utterance(speaker: &str, start_ms: i64, end_ms: i64, text: &str) -> Utterance {
        Utterance {
            speaker: speaker.to_string(),
            text: text.to_string(),
            start_ms,
            end_ms,
            confidence: Some(0.9),
        }
    }

    #[test]
    fn merge_adjacent_utterances_combines_same_speaker_short_gap_rows() {
        let merged = merge_adjacent_utterances(vec![
            app_utterance("Sys-A", 0, 1_000, "First sentence."),
            app_utterance("Sys-A", 1_700, 2_400, "Second sentence."),
        ]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "First sentence. Second sentence.");
        assert_eq!(merged[0].start_ms, 0);
        assert_eq!(merged[0].end_ms, 2_400);
    }

    #[test]
    fn merge_adjacent_utterances_keeps_speaker_changes_and_large_gaps_split() {
        let merged = merge_adjacent_utterances(vec![
            app_utterance("Sys-A", 0, 1_000, "Remote."),
            app_utterance("You", 1_100, 1_400, "Okay."),
            app_utterance("Sys-A", 4_000, 4_700, "Later."),
        ]);

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].speaker, "Sys-A");
        assert_eq!(merged[1].speaker, "You");
        assert_eq!(merged[2].speaker, "Sys-A");
    }

    #[test]
    fn merge_adjacent_utterances_caps_merged_turn_size() {
        let merged = merge_adjacent_utterances(vec![
            app_utterance("Sys-A", 0, 1_000, &"a".repeat(645)),
            app_utterance("Sys-A", 1_100, 1_500, "too large"),
        ]);

        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn query_params_use_deepgram_contract_and_repeated_values() {
        let options = DeepgramTranscriptionOptions {
            keyterms: vec!["ElevenLabs".to_string(), "OSIM".to_string()],
            language: "multi".to_string(),
            redact_pii: true,
            redact_pci: true,
        };
        let params = build_deepgram_query_params("meeting-1", true, &options);

        assert!(params.contains(&("model", "nova-3".to_string())));
        assert!(params.contains(&("diarize_model", "latest".to_string())));
        assert!(params.contains(&("utt_split", "1.5".to_string())));
        assert!(!params.iter().any(|(key, _)| *key == "diarize"));
        assert_eq!(
            params
                .iter()
                .filter(|(key, _)| *key == "keyterm")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["ElevenLabs", "OSIM"]
        );
        assert_eq!(
            params
                .iter()
                .filter(|(key, _)| *key == "redact")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["pii", "pci"]
        );
        assert!(params.contains(&("language", "multi".to_string())));
        assert!(params.contains(&("extra", "meeting_id:meeting-1".to_string())));
        assert!(params.contains(&("multichannel", "true".to_string())));
    }

    #[test]
    fn retry_classifier_treats_504_as_terminal() {
        let error = super::ApiError::api(
            reqwest::StatusCode::GATEWAY_TIMEOUT,
            "timeout".to_string(),
            None,
        );
        assert!(!should_retry(&error));

        let error = super::ApiError::api(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "server error".to_string(),
            None,
        );
        assert!(should_retry(&error));
    }
}
