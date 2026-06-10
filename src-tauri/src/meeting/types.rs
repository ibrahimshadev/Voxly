use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    Recording,
    Processing,
    Recorded,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptStatus {
    Pending,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    pub has_video: bool,
    pub has_mic: bool,
    pub has_system_audio: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    pub status: MeetingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_status: Option<TranscriptStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assemblyai_transcript_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_started_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingDetail {
    pub meta: MeetingMeta,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<MeetingTranscript>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTranscript {
    pub utterances: Vec<Utterance>,
    pub text: String,
    pub audio_duration_secs: Option<f64>,
    pub language_code: Option<String>,
    pub provider: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Utterance {
    pub speaker: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingStartOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub record_video: bool,
    #[serde(default)]
    pub record_mic: bool,
    #[serde(default)]
    pub record_system_audio: bool,
    #[serde(default)]
    pub video_preset: String,
    #[serde(default)]
    pub mic_device: Option<String>,
    #[serde(default)]
    pub system_audio_device: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingUpdate {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_pct: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MeetingDevices {
    pub audio_devices: Vec<String>,
    #[serde(default)]
    pub system_audio_devices: Vec<String>,
    pub video_devices: Vec<String>,
    pub has_system_audio: bool,
    pub ffmpeg_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
