pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
  let trimmed = base_url.trim_end_matches('/');
  let url = format!("{trimmed}/models");

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(10))
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

  let response = client
    .get(&url)
    .bearer_auth(api_key)
    .send()
    .await
    .map_err(|e| format!("Failed to fetch models: {e}"))?;

  let status = response.status();
  let body = response
    .text()
    .await
    .map_err(|e| format!("Failed to read models response: {e}"))?;

  if !status.is_success() {
    return Err(format!("Models API error {status}: {body}"));
  }

  let json: serde_json::Value =
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse models response: {e}"))?;

  let mut models: Vec<String> = json["data"]
    .as_array()
    .ok_or("Models response missing data array".to_string())?
    .iter()
    .filter_map(|item| item["id"].as_str().map(|s| s.to_string()))
    .filter(|model_id| is_chat_model(model_id))
    .collect();

  models.sort_unstable();
  models.dedup();

  if models.is_empty() {
    return Err("No chat-capable models returned by provider".to_string());
  }

  Ok(models)
}

fn is_chat_model(model_id: &str) -> bool {
  const EXCLUDED_TOKENS: [&str; 12] = [
    "whisper",
    "transcribe",
    "transcription",
    "audio",
    "speech",
    "tts",
    "embedding",
    "moderation",
    "image",
    "vision",
    "realtime",
    "dall-e",
  ];

  let lower = model_id.to_ascii_lowercase();
  !EXCLUDED_TOKENS
    .iter()
    .any(|token| lower.contains(token))
}

#[cfg(test)]
mod tests {
  use super::is_chat_model;

  #[test]
  fn chat_model_filter_keeps_text_models() {
    assert!(is_chat_model("gpt-4o-mini"));
    assert!(is_chat_model("llama-3.3-70b-versatile"));
  }

  #[test]
  fn chat_model_filter_excludes_audio_and_embedding_models() {
    assert!(!is_chat_model("whisper-large-v3"));
    assert!(!is_chat_model("gpt-4o-mini-transcribe"));
    assert!(!is_chat_model("text-embedding-3-large"));
  }
}
