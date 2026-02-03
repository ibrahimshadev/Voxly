use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "dikt";
const DEFAULT_HOTKEY: &str = "Control+Space";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
  pub base_url: String,
  pub model: String,
  pub hotkey: String,
  pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSettings {
  base_url: String,
  model: String,
  hotkey: String,
  #[serde(default)]
  encrypted_api_key: Option<String>,
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      base_url: "https://api.openai.com/v1".to_string(),
      model: "whisper-1".to_string(),
      hotkey: DEFAULT_HOTKEY.to_string(),
      api_key: String::new(),
    }
  }
}

pub fn load_settings() -> AppSettings {
  let mut settings = AppSettings::default();

  if let Ok(path) = settings_path() {
    if let Ok(contents) = fs::read_to_string(&path) {
      if let Ok(mut stored) = serde_json::from_str::<StoredSettings>(&contents) {
        let mut updated = false;
        if is_deprecated_hotkey(&stored.hotkey) {
          stored.hotkey = DEFAULT_HOTKEY.to_string();
          updated = true;
        }

        settings.base_url = stored.base_url;
        settings.model = stored.model;
        settings.hotkey = stored.hotkey;

        if updated {
          if let Ok(new_contents) = serde_json::to_string_pretty(&stored) {
            let _ = fs::write(&path, new_contents);
          }
        }
      }
    }
  }

  if let Ok(Some(api_key)) = get_api_key() {
    settings.api_key = api_key;
  }

  settings
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
  let stored = StoredSettings {
    base_url: settings.base_url.clone(),
    model: settings.model.clone(),
    hotkey: settings.hotkey.clone(),
    encrypted_api_key: None,
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

fn is_deprecated_hotkey(hotkey: &str) -> bool {
  matches!(hotkey, "Control+Super" | "Alt+Space" | "Super+Space")
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
  // Try keyring first
  if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, "api-key") {
    if entry.set_password(api_key).is_ok() {
      // Clear any encrypted fallback if keyring succeeds
      clear_encrypted_api_key_fallback();
      return Ok(());
    }
  }

  // Fallback: store encrypted in settings file
  store_encrypted_api_key_fallback(api_key)
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
      base_url: "https://api.openai.com/v1".to_string(),
      model: "whisper-1".to_string(),
      hotkey: "Control+Space".to_string(),
      encrypted_api_key: None,
    })
  } else {
    StoredSettings {
      base_url: "https://api.openai.com/v1".to_string(),
      model: "whisper-1".to_string(),
      hotkey: "Control+Space".to_string(),
      encrypted_api_key: None,
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
