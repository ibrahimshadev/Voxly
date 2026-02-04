use reqwest::multipart;

pub async fn transcribe(
  base_url: &str,
  api_key: &str,
  model: &str,
  provider: &str,
  audio_data: Vec<u8>,
  prompt: Option<&str>,
) -> Result<String, String> {
  if api_key.trim().is_empty() {
    return Err("Missing API key".to_string());
  }

  let url = build_transcription_url(base_url);
  let client = reqwest::Client::new();
  let prompt_to_send = prompt.filter(|p| supports_prompt(provider, model) && !p.trim().is_empty());

  if let Some(prompt_value) = prompt_to_send {
    let first_attempt = send_transcription_request(
      &client,
      &url,
      api_key,
      model,
      audio_data.clone(),
      Some(prompt_value),
    )
    .await;
    match first_attempt {
      Ok(text) => return Ok(text),
      Err(error) => {
        if should_retry_without_prompt(&error) {
          return send_transcription_request(&client, &url, api_key, model, audio_data, None)
            .await
            .map_err(|retry_error| retry_error.to_string());
        }
        return Err(error.to_string());
      }
    }
  }

  send_transcription_request(&client, &url, api_key, model, audio_data, None)
    .await
    .map_err(|error| error.to_string())
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

fn should_retry_without_prompt(error: &ApiError) -> bool {
  let Some(status) = error.status else {
    return false;
  };

  if !matches!(status.as_u16(), 400 | 404 | 415 | 422) {
    return false;
  }

  let body = error.body.to_ascii_lowercase();
  body.contains("prompt")
    || body.contains("unknown parameter")
    || body.contains("not allowed")
    || body.contains("unexpected field")
}

async fn send_transcription_request(
  client: &reqwest::Client,
  url: &str,
  api_key: &str,
  model: &str,
  audio_data: Vec<u8>,
  prompt: Option<&str>,
) -> Result<String, ApiError> {
  let mut form = multipart::Form::new()
    .part(
      "file",
      multipart::Part::bytes(audio_data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|error| ApiError::transport(error.to_string()))?,
    )
    .text("model", model.to_string());

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

  let json: serde_json::Value = serde_json::from_str(&body)
    .map_err(|error| ApiError::transport(error.to_string()))?;
  Ok(json["text"].as_str().unwrap_or("").to_string())
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
  use super::{build_transcription_url, supports_prompt};

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
}
