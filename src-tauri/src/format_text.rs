pub async fn format_text(
  base_url: &str,
  api_key: &str,
  model: &str,
  system_prompt: &str,
  text: &str,
) -> Result<String, String> {
  let trimmed = base_url.trim_end_matches('/');
  let url = format!("{trimmed}/chat/completions");

  let body = serde_json::json!({
    "model": model,
    "messages": [
      { "role": "system", "content": system_prompt },
      { "role": "user", "content": text }
    ]
  });

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

  let response = client
    .post(&url)
    .bearer_auth(api_key)
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Format request failed: {e}"))?;

  let status = response.status();
  let response_body = response
    .text()
    .await
    .map_err(|e| format!("Failed to read format response: {e}"))?;

  if !status.is_success() {
    return Err(format!("Format API error {status}: {response_body}"));
  }

  let json: serde_json::Value = serde_json::from_str(&response_body)
    .map_err(|e| format!("Failed to parse format response: {e}"))?;

  json["choices"][0]["message"]["content"]
    .as_str()
    .map(|s| s.to_string())
    .ok_or_else(|| "Format response missing choices[0].message.content".to_string())
}
