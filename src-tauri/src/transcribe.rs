use reqwest::multipart;

#[derive(Debug, Clone)]
pub struct TranscriptionResult {
    pub text: String,
    pub duration_secs: Option<f64>,
    pub language: Option<String>,
}

pub async fn transcribe(
    base_url: &str,
    api_key: &str,
    model: &str,
    provider: &str,
    audio_data: Vec<u8>,
    prompt: Option<&str>,
) -> Result<TranscriptionResult, String> {
    if api_key.trim().is_empty() {
        return Err("Missing API key".to_string());
    }

    let url = build_transcription_url(base_url);
    let client = reqwest::Client::new();
    let prompt_to_send =
        prompt.filter(|p| supports_prompt(provider, model) && !p.trim().is_empty());

    let mut result = send_transcription_request(
        &client,
        &url,
        api_key,
        model,
        audio_data.clone(),
        prompt_to_send,
        true,
    )
    .await;
    if let Err(error) = &result {
        let retry = if prompt_to_send.is_some() && retryable(error, &["prompt"]) {
            Some((None, true))
        } else if retryable(error, &["response_format", "verbose"]) {
            // verbose_json caused the error: retry without it
            Some((prompt_to_send, false))
        } else {
            None
        };
        if let Some((prompt, verbose)) = retry {
            result = send_transcription_request(
                &client, &url, api_key, model, audio_data, prompt, verbose,
            )
            .await;
        }
    }
    result.map_err(|error| error.to_string())
}

fn build_transcription_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/audio/transcriptions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/audio/transcriptions")
    }
}

fn supports_prompt(provider: &str, model: &str) -> bool {
    match provider {
        "groq" => true,
        "openai" => model.to_ascii_lowercase().starts_with("whisper"),
        "custom" => true,
        _ => false,
    }
}

/// Whether a rejected request is worth retrying without the parameter named by `keywords`.
fn retryable(error: &ApiError, keywords: &[&str]) -> bool {
    if !error
        .status
        .is_some_and(|status| matches!(status.as_u16(), 400 | 404 | 415 | 422))
    {
        return false;
    }

    let body = error.body.to_ascii_lowercase();
    keywords
        .iter()
        .chain(&["unknown parameter", "not allowed", "unexpected field"])
        .any(|keyword| body.contains(keyword))
}

async fn send_transcription_request(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    audio_data: Vec<u8>,
    prompt: Option<&str>,
    verbose: bool,
) -> Result<TranscriptionResult, ApiError> {
    let mut form = multipart::Form::new()
        .part(
            "file",
            multipart::Part::bytes(audio_data)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|error| ApiError::transport(error.to_string()))?,
        )
        .text("model", model.to_string());

    if verbose {
        form = form.text("response_format", "verbose_json");
    }

    if let Some(prompt_value) = prompt {
        form = form.text("prompt", prompt_value.to_string());
    }

    let response = client
        .post(url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| ApiError::transport(error.to_string()))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| ApiError::transport(error.to_string()))?;

    if !status.is_success() {
        return Err(ApiError::api(status, body));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| ApiError::transport(error.to_string()))?;

    let text = json["text"].as_str().unwrap_or("").trim().to_string();
    let duration_secs = json["duration"].as_f64();
    let language = json["language"].as_str().map(|s| s.to_lowercase());

    Ok(TranscriptionResult {
        text,
        duration_secs,
        language,
    })
}

#[derive(Debug)]
struct ApiError {
    status: Option<reqwest::StatusCode>,
    body: String,
}

impl ApiError {
    fn api(status: reqwest::StatusCode, body: String) -> Self {
        Self {
            status: Some(status),
            body,
        }
    }

    fn transport(message: String) -> Self {
        Self {
            status: None,
            body: message,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "API error {status}: {}", self.body),
            None => write!(f, "{}", self.body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_transcription_url, retryable, supports_prompt, ApiError};

    #[test]
    fn url_builder_appends_endpoint() {
        assert_eq!(
            build_transcription_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            build_transcription_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
    }

    #[test]
    fn url_builder_accepts_full_endpoint() {
        assert_eq!(
            build_transcription_url("https://api.openai.com/v1/audio/transcriptions"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            build_transcription_url("https://api.openai.com/v1/audio/transcriptions/"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
    }

    #[test]
    fn prompt_support_by_provider_and_model() {
        assert!(supports_prompt("groq", "whisper-large-v3"));
        assert!(supports_prompt("openai", "whisper-1"));
        assert!(!supports_prompt("openai", "gpt-4o-transcribe"));
        assert!(supports_prompt("custom", "anything"));
    }

    #[test]
    fn retryable_requires_client_error_status_and_matching_body() {
        let bad_request = |body: &str| ApiError::api(reqwest::StatusCode::BAD_REQUEST, body.into());
        assert!(retryable(&bad_request("Unknown PROMPT field"), &["prompt"]));
        assert!(retryable(&bad_request("unexpected field"), &["prompt"]));
        assert!(!retryable(&bad_request("prompt too long"), &["verbose"]));
        assert!(retryable(
            &bad_request("response_format invalid"),
            &["response_format", "verbose"]
        ));
        assert!(!retryable(
            &ApiError::api(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "prompt".into()),
            &["prompt"]
        ));
        assert!(!retryable(
            &ApiError::transport("prompt".into()),
            &["prompt"]
        ));
    }
}
