use reqwest::multipart;

pub async fn transcribe(
  base_url: &str,
  api_key: &str,
  model: &str,
  audio_data: Vec<u8>,
) -> Result<String, String> {
  if api_key.trim().is_empty() {
    return Err("Missing API key".to_string());
  }

  let url = build_transcription_url(base_url);
  let client = reqwest::Client::new();

  let form = multipart::Form::new()
    .part(
      "file",
      multipart::Part::bytes(audio_data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?,
    )
    .text("model", model.to_string());

  let response = client
    .post(url)
    .bearer_auth(api_key)
    .multipart(form)
    .send()
    .await
    .map_err(|e| e.to_string())?;

  let status = response.status();
  let body = response.text().await.map_err(|e| e.to_string())?;

  if !status.is_success() {
    return Err(format!("API error {status}: {body}"));
  }

  let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
  Ok(json["text"].as_str().unwrap_or("").to_string())
}

fn build_transcription_url(base_url: &str) -> String {
  let trimmed = base_url.trim_end_matches('/');
  if trimmed.ends_with("/audio/transcriptions") {
    trimmed.to_string()
  } else {
    format!("{trimmed}/audio/transcriptions")
  }
}

#[cfg(test)]
mod tests {
  use super::build_transcription_url;

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
}
