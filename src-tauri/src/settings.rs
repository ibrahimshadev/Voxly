use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

use crate::domain::types::{Mode, VocabularyEntry};

const SERVICE_NAME: &str = "dikt";
// Use Tauri's canonical modifier name. This resolves to Ctrl on Windows/Linux and Cmd on macOS.
const DEFAULT_HOTKEY: &str = "CommandOrControl+Space";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
  pub provider: String,
  pub base_url: String,
  pub model: String,
  pub hotkey: String,
  #[serde(default = "default_hotkey_mode")]
  pub hotkey_mode: String,
  #[serde(default = "default_copy_to_clipboard_on_success")]
  pub copy_to_clipboard_on_success: bool,
  pub api_key: String,
  #[serde(default)]
  pub vocabulary: Vec<VocabularyEntry>,
  #[serde(default)]
  pub active_mode_id: Option<String>,
  #[serde(default)]
  pub modes: Vec<Mode>,
}

fn default_provider() -> String {
  "groq".to_string()
}

fn default_hotkey_mode() -> String {
  "hold".to_string()
}

fn default_copy_to_clipboard_on_success() -> bool {
  false
}

fn default_modes(provider: &str) -> Vec<Mode> {
  let model = match provider {
    "groq" => "llama-3.3-70b-versatile",
    "openai" => "gpt-4o-mini",
    _ => "",
  }
  .to_string();

  vec![
    Mode {
      id: uuid::Uuid::new_v4().to_string(),
      name: "Grammar & Punctuation".to_string(),
      system_prompt: "Fix grammar, punctuation, and spelling. Preserve the original meaning and tone. Return only the corrected text.".to_string(),
      model: model.clone(),
    },
    Mode {
      id: uuid::Uuid::new_v4().to_string(),
      name: "Email Draft".to_string(),
      system_prompt: "Rewrite the following dictation as a professional email. Keep the same intent and key points. Return only the email body.".to_string(),
      model,
    },
  ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSettings {
  #[serde(default = "default_provider")]
  provider: String,
  base_url: String,
  model: String,
  hotkey: String,
  #[serde(default = "default_hotkey_mode")]
  hotkey_mode: String,
  #[serde(default = "default_copy_to_clipboard_on_success")]
  copy_to_clipboard_on_success: bool,
  #[serde(default)]
  encrypted_api_key: Option<String>,
  #[serde(default)]
  vocabulary: Vec<VocabularyEntry>,
  #[serde(default)]
  active_mode_id: Option<String>,
  #[serde(default)]
  modes: Vec<Mode>,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      provider: "groq".to_string(),
      base_url: "https://api.groq.com/openai/v1".to_string(),
      model: "whisper-large-v3-turbo".to_string(),
      hotkey: DEFAULT_HOTKEY.to_string(),
      hotkey_mode: "hold".to_string(),
      copy_to_clipboard_on_success: false,
      api_key: String::new(),
      vocabulary: Vec::new(),
      active_mode_id: None,
      modes: Vec::new(),
    }
  }
}

pub fn load_settings() -> AppSettings {
  let mut settings = AppSettings::default();
  let mut should_seed_default_modes = true;

  if let Ok(path) = settings_path() {
    if let Ok(contents) = fs::read_to_string(&path) {
      let has_modes_field = json_has_modes_field(&contents);
      if let Ok(mut stored) = serde_json::from_str::<StoredSettings>(&contents) {
        let mut updated = false;
        let normalized = normalize_hotkey(&stored.hotkey);
        if normalized != stored.hotkey {
          stored.hotkey = normalized;
          updated = true;
        }

        if updated {
          if let Ok(new_contents) = serde_json::to_string_pretty(&stored) {
            let _ = fs::write(&path, new_contents);
          }
        }

        settings.provider = stored.provider;
        settings.base_url = stored.base_url;
        settings.model = stored.model;
        settings.hotkey = stored.hotkey;
        settings.hotkey_mode = stored.hotkey_mode;
        settings.copy_to_clipboard_on_success = stored.copy_to_clipboard_on_success;
        settings.vocabulary = stored.vocabulary;
        settings.active_mode_id = stored.active_mode_id;
        settings.modes = stored.modes;
        should_seed_default_modes = !has_modes_field;
      }
    }
  }

  if let Ok(Some(api_key)) = get_api_key() {
    settings.api_key = api_key;
  }

  if should_seed_default_modes && settings.modes.is_empty() {
    settings.modes = default_modes(&settings.provider);
  }

  settings
}

fn json_has_modes_field(contents: &str) -> bool {
  serde_json::from_str::<serde_json::Value>(contents)
    .ok()
    .and_then(|value| value.as_object().map(|obj| obj.contains_key("modes")))
    .unwrap_or(false)
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
  let stored = StoredSettings {
    provider: settings.provider.clone(),
    base_url: settings.base_url.clone(),
    model: settings.model.clone(),
    hotkey: settings.hotkey.clone(),
    hotkey_mode: settings.hotkey_mode.clone(),
    copy_to_clipboard_on_success: settings.copy_to_clipboard_on_success,
    encrypted_api_key: None,
    vocabulary: settings.vocabulary.clone(),
    active_mode_id: settings.active_mode_id.clone(),
    modes: settings.modes.clone(),
  };

  let path = settings_path()?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let contents = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
  fs::write(&path, contents).map_err(|e| e.to_string())?;

  if settings.api_key.trim().is_empty() {
    delete_api_key()?;
  } else {
    store_api_key(&settings.api_key)?;
  }

  Ok(())
}

fn settings_path() -> Result<PathBuf, String> {
  let base_dir = if let Ok(appdata) = std::env::var("APPDATA") {
    PathBuf::from(appdata)
  } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
    PathBuf::from(xdg)
  } else if let Ok(home) = std::env::var("HOME") {
    PathBuf::from(home).join(".config")
  } else {
    std::env::temp_dir()
  };

  Ok(base_dir.join("dikt").join("settings.json"))
}

fn normalize_hotkey(hotkey: &str) -> String {
  // Migrate older / non-canonical variants to values the plugin parser is known to accept.
  match hotkey {
    // Old experiments
    "Control+Super" | "Alt+Space" | "Super+Space" => DEFAULT_HOTKEY.to_string(),
    // Some builds stored a non-canonical Control name; normalize it.
    "Control+Space" => DEFAULT_HOTKEY.to_string(),
    other => other.to_string(),
  }
}

// Encryption helpers for fallback storage
fn get_machine_key() -> Vec<u8> {
  let username = env::var("USERNAME")
    .or_else(|_| env::var("USER"))
    .unwrap_or_default();
  let computer = env::var("COMPUTERNAME")
    .or_else(|_| env::var("HOSTNAME"))
    .unwrap_or_default();
  let key_str = format!("{}@{}-dikt-key", username, computer);
  let mut key = key_str.as_bytes().to_vec();
  // Ensure key is at least 32 bytes by repeating
  while key.len() < 32 {
    key.extend_from_slice(key_str.as_bytes());
  }
  key.truncate(32);
  key
}

fn encrypt_api_key(api_key: &str) -> String {
  let key = get_machine_key();
  let encrypted: Vec<u8> = api_key
    .as_bytes()
    .iter()
    .enumerate()
    .map(|(i, b)| b ^ key[i % key.len()])
    .collect();
  BASE64.encode(&encrypted)
}

fn decrypt_api_key(encrypted: &str) -> Option<String> {
  let key = get_machine_key();
  let data = BASE64.decode(encrypted).ok()?;
  let decrypted: Vec<u8> = data
    .iter()
    .enumerate()
    .map(|(i, b)| b ^ key[i % key.len()])
    .collect();
  String::from_utf8(decrypted).ok()
}

fn store_api_key(api_key: &str) -> Result<(), String> {
  // Always store encrypted fallback (keyring may not persist on some systems like WSL)
  store_encrypted_api_key_fallback(api_key)?;

  // Also try keyring as primary storage
  if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, "api-key") {
    let _ = entry.set_password(api_key);
  }

  Ok(())
}

fn get_api_key() -> Result<Option<String>, String> {
  // Try keyring first
  if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, "api-key") {
    match entry.get_password() {
      Ok(value) => return Ok(Some(value)),
      Err(keyring::Error::NoEntry) => {}
      Err(_) => {}
    }
  }

  // Fallback: check encrypted storage
  get_encrypted_api_key_fallback()
}

fn delete_api_key() -> Result<(), String> {
  // Try to delete from keyring
  if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, "api-key") {
    let _ = entry.delete_credential();
  }

  // Also clear fallback
  clear_encrypted_api_key_fallback();
  Ok(())
}

fn store_encrypted_api_key_fallback(api_key: &str) -> Result<(), String> {
  let path = settings_path()?;
  let mut stored = if let Ok(contents) = fs::read_to_string(&path) {
    serde_json::from_str::<StoredSettings>(&contents).unwrap_or_else(|_| StoredSettings {
      provider: "groq".to_string(),
      base_url: "https://api.groq.com/openai/v1".to_string(),
      model: "whisper-large-v3-turbo".to_string(),
      hotkey: DEFAULT_HOTKEY.to_string(),
      hotkey_mode: "hold".to_string(),
      copy_to_clipboard_on_success: false,
      encrypted_api_key: None,
      vocabulary: Vec::new(),
      active_mode_id: None,
      modes: Vec::new(),
    })
  } else {
    StoredSettings {
      provider: "groq".to_string(),
      base_url: "https://api.groq.com/openai/v1".to_string(),
      model: "whisper-large-v3-turbo".to_string(),
      hotkey: DEFAULT_HOTKEY.to_string(),
      hotkey_mode: "hold".to_string(),
      copy_to_clipboard_on_success: false,
      encrypted_api_key: None,
      vocabulary: Vec::new(),
      active_mode_id: None,
      modes: Vec::new(),
    }
  };

  stored.encrypted_api_key = Some(encrypt_api_key(api_key));

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let contents = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
  fs::write(&path, contents).map_err(|e| e.to_string())?;

  Ok(())
}

fn get_encrypted_api_key_fallback() -> Result<Option<String>, String> {
  let path = settings_path()?;
  if let Ok(contents) = fs::read_to_string(&path) {
    if let Ok(stored) = serde_json::from_str::<StoredSettings>(&contents) {
      if let Some(encrypted) = stored.encrypted_api_key {
        return Ok(decrypt_api_key(&encrypted));
      }
    }
  }
  Ok(None)
}

fn clear_encrypted_api_key_fallback() {
  if let Ok(path) = settings_path() {
    if let Ok(contents) = fs::read_to_string(&path) {
      if let Ok(mut stored) = serde_json::from_str::<StoredSettings>(&contents) {
        stored.encrypted_api_key = None;
        if let Ok(new_contents) = serde_json::to_string_pretty(&stored) {
          let _ = fs::write(&path, new_contents);
        }
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{json_has_modes_field, StoredSettings};

  #[test]
  fn legacy_settings_without_vocabulary_deserialize() {
    let legacy_json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "whisper-large-v3-turbo",
      "hotkey": "CommandOrControl+Space"
    }"#;

    let parsed: StoredSettings = serde_json::from_str(legacy_json).unwrap();
    assert!(parsed.vocabulary.is_empty());
  }

  #[test]
  fn legacy_settings_without_modes_deserialize() {
    let legacy_json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "whisper-large-v3-turbo",
      "hotkey": "CommandOrControl+Space",
      "vocabulary": []
    }"#;

    let parsed: StoredSettings = serde_json::from_str(legacy_json).unwrap();
    assert!(parsed.modes.is_empty());
    assert!(parsed.active_mode_id.is_none());
  }

  #[test]
  fn modes_field_detection_returns_false_when_missing() {
    let json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1"
    }"#;

    assert!(!json_has_modes_field(json));
  }

  #[test]
  fn modes_field_detection_returns_true_when_present() {
    let json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "modes": []
    }"#;

    assert!(json_has_modes_field(json));
  }
}
