use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;

use crate::meeting::storage;
use crate::meeting::types::{MeetingDetail, MeetingSummary, MeetingTranscript, TranscriptStatus};
use crate::settings::AppSettings;

const MODEL: &str = "openai/gpt-oss-120b";
const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMPLETION_TOKENS: u32 = 8_192;
const TEMPERATURE: f32 = 0.3;
// Safe input budget. gpt-oss-120b context = 131,072 tokens; reserve headroom for
// the system prompt + completion. ~4 chars/token heuristic.
const MAX_TRANSCRIPT_CHARS: usize = 360_000; // ≈ 90k tokens
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_OPENAI_SUMMARY_MODEL: &str = "gpt-5.4-mini";

#[derive(Debug, Clone)]
pub struct SummaryConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

const SUMMARY_SYSTEM_PROMPT: &str = r#"You are an expert meeting analyst. You will be given a meeting transcript with
speaker labels. In these transcripts, "You" is the local microphone speaker (the
person running this app) and "System" is the remote/other participants captured from
system audio; treat any other label as a distinct speaker. Output GitHub-Flavored
Markdown ONLY (no preamble, no code fences around the whole reply, no raw HTML).

Analyze the following meeting transcript and produce a structured summary using
exactly this format:

---

## Conversation Summary
Write 2-3 sentences describing who is speaking, what product/project is being
discussed, and the overall context of the conversation.

---

## Key Topics Discussed
List each major topic that came up in the meeting. For each topic:
- Give it a bold numbered title
- Write 2-3 sentences explaining what was discussed, what the problem was, and what
  decision or conclusion was reached (if any)

---

## 🚧 Blockers
Present a table with 3 columns:
| # | Blocker | Impact |
List only the things that are actively preventing progress. For each blocker, clearly
state what it is and what it is blocking downstream.

---

## ✅ Next Action Items
Present a table with 2 columns:
| Owner | Action |
Assign every action item to a specific person mentioned in the transcript. Be specific
and actionable — not vague. If a deadline or dependency was mentioned, include it in
the action description.

---

## Overall Assessment
Write 3-4 sentences giving a high-level verdict on where the project stands. Mention
what is going well, what the main risks are, and what the critical path looks like
going forward.
"#;

static IN_FLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Debug)]
struct InFlightGuard {
    id: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = IN_FLIGHT.lock() {
            set.remove(&self.id);
        }
    }
}

fn acquire_in_flight(id: &str) -> Result<InFlightGuard, String> {
    let mut set = IN_FLIGHT
        .lock()
        .map_err(|_| "Summary state lock poisoned".to_string())?;
    if !set.insert(id.to_string()) {
        return Err("A summary is already being generated for this meeting.".to_string());
    }
    Ok(InFlightGuard { id: id.to_string() })
}

pub fn resolve_groq_key(settings: &AppSettings) -> Result<String, String> {
    if let Some(key) = settings
        .provider_api_keys
        .get("groq")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return Ok(key.to_string());
    }
    if settings.provider == "groq" {
        let key = settings.api_key.trim();
        if !key.is_empty() {
            return Ok(key.to_string());
        }
    }
    Err(
        "Add a Groq API key in Settings (switch the provider to Groq and save) to generate meeting summaries."
            .to_string(),
    )
}

pub fn resolve_summary_config(settings: &AppSettings) -> Result<SummaryConfig, String> {
    let provider = {
        let trimmed = settings.summary_provider.trim();
        if trimmed.is_empty() {
            "groq".to_string()
        } else {
            trimmed.to_string()
        }
    };

    let api_key = non_empty(&settings.summary_api_key)
        .or_else(|| {
            settings
                .summary_provider_api_keys
                .get(&provider)
                .and_then(|key| non_empty(key))
        })
        .or_else(|| {
            if provider != "groq" {
                return None;
            }
            // v1 legacy fallback, verbatim semantics.
            settings
                .provider_api_keys
                .get("groq")
                .and_then(|key| non_empty(key))
                .or_else(|| {
                    if settings.provider == "groq" {
                        non_empty(&settings.api_key)
                    } else {
                        None
                    }
                })
        })
        .ok_or_else(|| {
            "Add an API key under Meetings → AI Summary to generate meeting summaries."
                .to_string()
        })?;

    let base_url = match non_empty(&settings.summary_base_url) {
        Some(url) => url,
        None => match provider.as_str() {
            "groq" => GROQ_BASE_URL.to_string(),
            "openai" => DEFAULT_OPENAI_BASE_URL.to_string(),
            _ => return Err("Set a base URL and model under Meetings → AI Summary.".to_string()),
        },
    };
    let model = match non_empty(&settings.summary_model) {
        Some(model) => model,
        None => match provider.as_str() {
            "groq" => MODEL.to_string(),
            "openai" => DEFAULT_OPENAI_SUMMARY_MODEL.to_string(),
            _ => return Err("Set a base URL and model under Meetings → AI Summary.".to_string()),
        },
    };

    Ok(SummaryConfig {
        provider,
        base_url,
        model,
        api_key,
    })
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn build_transcript_text(transcript: &MeetingTranscript) -> String {
    if transcript.utterances.is_empty() {
        return transcript.text.trim().to_string();
    }
    transcript
        .utterances
        .iter()
        .map(|utterance| format!("{}: {}", utterance.speaker, utterance.text.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn check_transcript_len(text: &str) -> Result<(), String> {
    if text.len() > MAX_TRANSCRIPT_CHARS {
        return Err(
            "This transcript is too long to summarize in a single pass; chunked summarization is planned for a future update."
                .to_string(),
        );
    }
    Ok(())
}

fn request_body(transcript_text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": MODEL,
        "messages": [
            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
            { "role": "user", "content": transcript_text }
        ],
        "temperature": TEMPERATURE,
        "max_completion_tokens": MAX_COMPLETION_TOKENS,
        "reasoning_effort": "low",
        "include_reasoning": false
    })
}

fn parse_summary_content(body: &str) -> Result<String, String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("Failed to parse Groq response: {error}"))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err("Groq response did not include summary content.".to_string());
    }
    Ok(content.to_string())
}

pub async fn run(
    groq_key: String,
    id: String,
    detail: MeetingDetail,
) -> Result<MeetingSummary, String> {
    let _guard = acquire_in_flight(&id)?;

    if !matches!(
        detail.meta.transcript_status,
        Some(TranscriptStatus::Completed)
    ) {
        return Err("Transcribe this meeting before generating a summary.".to_string());
    }
    let transcript = detail
        .transcript
        .as_ref()
        .ok_or_else(|| "This meeting's transcript could not be loaded.".to_string())?;
    let transcript_text = build_transcript_text(transcript);
    if transcript_text.is_empty() {
        return Err("This meeting's transcript is empty.".to_string());
    }
    check_transcript_len(&transcript_text)?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let response = client
        .post(format!("{GROQ_BASE_URL}/chat/completions"))
        .bearer_auth(&groq_key)
        .json(&request_body(&transcript_text))
        .send()
        .await
        .map_err(|error| format!("Summary request failed: {error}"))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read summary response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Groq API error {status}: {response_body}"));
    }

    let summary = MeetingSummary {
        markdown: parse_summary_content(&response_body)?,
        model: MODEL.to_string(),
        provider: "groq".to_string(),
        created_at_ms: storage::now_ms()?,
        transcript_created_at_ms: Some(transcript.created_at_ms),
    };
    storage::save_summary(&id, &summary)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::types::Utterance;

    fn settings_with(provider: &str, api_key: &str, groq_map_key: Option<&str>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.provider = provider.to_string();
        settings.api_key = api_key.to_string();
        settings.provider_api_keys.clear();
        if let Some(key) = groq_map_key {
            settings
                .provider_api_keys
                .insert("groq".to_string(), key.to_string());
        }
        settings
    }

    fn transcript(utterances: Vec<Utterance>, text: &str) -> MeetingTranscript {
        MeetingTranscript {
            utterances,
            text: text.to_string(),
            audio_duration_secs: None,
            language_code: None,
            provider: "assemblyai".to_string(),
            created_at_ms: 0,
        }
    }

    fn utterance(speaker: &str, text: &str) -> Utterance {
        Utterance {
            speaker: speaker.to_string(),
            text: text.to_string(),
            start_ms: 0,
            end_ms: 1,
            confidence: None,
        }
    }

    fn with_summary(
        mut settings: AppSettings,
        provider: &str,
        api_key: &str,
        map_key: Option<&str>,
    ) -> AppSettings {
        settings.summary_provider = provider.to_string();
        settings.summary_api_key = api_key.to_string();
        settings.summary_provider_api_keys.clear();
        if let Some(key) = map_key {
            settings
                .summary_provider_api_keys
                .insert(provider.to_string(), key.to_string());
        }
        settings
    }

    #[test]
    fn resolve_summary_config_prefers_explicit_summary_key() {
        let settings = with_summary(
            settings_with("openai", "active-key", Some("legacy-groq")),
            "openai",
            "summary-key",
            Some("map-key"),
        );
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.api_key, "summary-key");
        assert_eq!(config.provider, "openai");
    }

    #[test]
    fn resolve_summary_config_falls_back_to_summary_map() {
        let settings = with_summary(
            settings_with("openai", "active-key", None),
            "openai",
            "  ",
            Some("map-key"),
        );
        assert_eq!(resolve_summary_config(&settings).unwrap().api_key, "map-key");
    }

    #[test]
    fn resolve_summary_config_uses_legacy_groq_map_when_summary_unset() {
        let settings = with_summary(
            settings_with("openai", "openai-key", Some("legacy-groq")),
            "groq",
            "",
            None,
        );
        assert_eq!(
            resolve_summary_config(&settings).unwrap().api_key,
            "legacy-groq"
        );
    }

    #[test]
    fn resolve_summary_config_uses_legacy_active_key_only_when_groq_active() {
        let settings = with_summary(settings_with("groq", "active-groq", None), "groq", "", None);
        assert_eq!(
            resolve_summary_config(&settings).unwrap().api_key,
            "active-groq"
        );
    }

    #[test]
    fn resolve_summary_config_denies_legacy_fallback_for_other_providers() {
        // OpenAI summary provider must NOT borrow groq/active keys.
        let settings = with_summary(
            settings_with("groq", "active-groq", Some("legacy-groq")),
            "openai",
            "",
            None,
        );
        assert!(resolve_summary_config(&settings).is_err());
    }

    #[test]
    fn resolve_summary_config_defaults_blank_base_url_and_model_per_provider() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "openai",
            "summary-key",
            None,
        );
        settings.summary_base_url = "  ".to_string();
        settings.summary_model = String::new();
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert_eq!(config.model, "gpt-5.4-mini");
    }

    #[test]
    fn resolve_summary_config_rejects_blank_custom_config() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "custom",
            "summary-key",
            None,
        );
        settings.summary_base_url = String::new();
        settings.summary_model = "some-model".to_string();
        assert!(resolve_summary_config(&settings)
            .unwrap_err()
            .contains("base URL"));
    }

    #[test]
    fn resolve_summary_config_defaults_blank_groq_base_url_and_model() {
        let mut settings = with_summary(
            settings_with("openai", "k", None),
            "groq",
            "summary-key",
            None,
        );
        settings.summary_base_url = String::new();
        settings.summary_model = "  ".to_string();
        let config = resolve_summary_config(&settings).unwrap();
        assert_eq!(config.base_url, "https://api.groq.com/openai/v1");
        assert_eq!(config.model, "openai/gpt-oss-120b");
    }

    #[test]
    fn resolve_summary_config_rejects_blank_custom_model() {
        let mut settings = with_summary(
            settings_with("groq", "k", None),
            "custom",
            "summary-key",
            None,
        );
        settings.summary_base_url = "http://localhost:11434/v1".to_string();
        settings.summary_model = String::new();
        assert!(resolve_summary_config(&settings).is_err());
    }

    #[test]
    fn resolve_groq_key_prefers_saved_groq_provider_key() {
        let settings = settings_with("openai", "openai-key", Some("groq-key"));
        assert_eq!(resolve_groq_key(&settings).unwrap(), "groq-key");
    }

    #[test]
    fn resolve_groq_key_falls_back_to_api_key_only_when_groq_is_active() {
        let settings = settings_with("groq", "active-groq-key", None);
        assert_eq!(resolve_groq_key(&settings).unwrap(), "active-groq-key");
    }

    #[test]
    fn resolve_groq_key_rejects_api_key_of_other_providers() {
        let settings = settings_with("openai", "openai-key", None);
        assert!(resolve_groq_key(&settings).is_err());
    }

    #[test]
    fn resolve_groq_key_rejects_blank_keys() {
        let settings = settings_with("groq", "   ", Some("  "));
        assert!(resolve_groq_key(&settings).is_err());
    }

    #[test]
    fn build_transcript_text_joins_speaker_labeled_utterances() {
        let transcript = transcript(
            vec![
                utterance("You", "Let's review the launch plan."),
                utterance("System", "The API is still blocked."),
            ],
            "raw fallback",
        );
        assert_eq!(
            build_transcript_text(&transcript),
            "You: Let's review the launch plan.\nSystem: The API is still blocked."
        );
    }

    #[test]
    fn build_transcript_text_falls_back_to_raw_text() {
        let transcript = transcript(vec![], "  plain transcript text  ");
        assert_eq!(build_transcript_text(&transcript), "plain transcript text");
    }

    #[test]
    fn check_transcript_len_rejects_oversized_transcripts() {
        let oversized = "a".repeat(MAX_TRANSCRIPT_CHARS + 1);
        let error = check_transcript_len(&oversized).unwrap_err();
        assert!(error.contains("too long"));
        assert!(check_transcript_len("short").is_ok());
    }

    #[test]
    fn parse_summary_content_extracts_markdown() {
        let body = r###"{"choices":[{"message":{"content":"## Conversation Summary\nHello"}}]}"###;
        assert_eq!(
            parse_summary_content(body).unwrap(),
            "## Conversation Summary\nHello"
        );
    }

    #[test]
    fn parse_summary_content_rejects_missing_or_empty_content() {
        assert!(parse_summary_content(r#"{"choices":[]}"#).is_err());
        assert!(parse_summary_content(r#"{"choices":[{"message":{"content":"  "}}]}"#).is_err());
        assert!(parse_summary_content("not json").is_err());
    }

    #[test]
    fn request_body_uses_locked_model_and_params() {
        let body = request_body("transcript text");
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "transcript text");
        assert_eq!(body["max_completion_tokens"], 8_192);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["include_reasoning"], false);
    }

    #[test]
    fn in_flight_guard_blocks_concurrent_generation_and_releases_on_drop() {
        let id = format!("guard-{}", uuid::Uuid::new_v4());
        let guard = acquire_in_flight(&id).unwrap();
        let error = acquire_in_flight(&id).unwrap_err();
        assert!(error.contains("already being generated"));
        drop(guard);
        assert!(acquire_in_flight(&id).is_ok());
    }
}
