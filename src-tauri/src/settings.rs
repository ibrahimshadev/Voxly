use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

use crate::domain::types::{KeytermEntry, Mode, VocabularyEntry};

const SERVICE_NAME: &str = "dikt";
const API_KEY_USER: &str = "api-key";
const DEEPGRAM_KEY_USER: &str = "deepgram-api-key";
// Use Tauri's canonical modifier name. This resolves to Ctrl on Windows/Linux and Cmd on macOS.
const DEFAULT_HOTKEY: &str = "CommandOrControl+Space";
const DEFAULT_MEETING_HOTKEY: &str = "CommandOrControl+Alt+M";
const LEGACY_DEFAULT_MEETING_HOTKEY: &str = "CommandOrControl+Shift+M";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub hotkey: String,
    #[serde(default = "default_meeting_hotkey")]
    pub meeting_hotkey: String,
    #[serde(default = "default_hotkey_mode")]
    pub hotkey_mode: String,
    #[serde(default = "default_copy_to_clipboard_on_success")]
    pub copy_to_clipboard_on_success: bool,
    #[serde(default = "default_meeting_record_video")]
    pub meeting_record_video: bool,
    #[serde(default = "default_meeting_record_mic")]
    pub meeting_record_mic: bool,
    #[serde(default = "default_meeting_record_system_audio")]
    pub meeting_record_system_audio: bool,
    #[serde(default = "default_meeting_video_preset")]
    pub meeting_video_preset: String,
    #[serde(default)]
    pub meeting_mic_device: Option<String>,
    #[serde(default)]
    pub meeting_system_audio_device: Option<String>,
    #[serde(default)]
    pub meeting_consent_acknowledged: bool,
    pub api_key: String,
    #[serde(default)]
    pub deepgram_api_key: String,
    #[serde(default)]
    pub keyterm_glossary: Vec<KeytermEntry>,
    #[serde(default = "default_meeting_language")]
    pub meeting_language: String,
    #[serde(default)]
    pub deepgram_redaction_enabled: bool,
    #[serde(default = "default_true")]
    pub deepgram_redact_pii: bool,
    #[serde(default = "default_true")]
    pub deepgram_redact_pci: bool,
    #[serde(default)]
    pub provider_api_keys: HashMap<String, String>,
    #[serde(default = "default_summary_provider")]
    pub summary_provider: String,
    #[serde(default = "default_summary_base_url")]
    pub summary_base_url: String,
    #[serde(default = "default_summary_model")]
    pub summary_model: String,
    #[serde(default)]
    pub summary_api_key: String,
    #[serde(default)]
    pub summary_provider_api_keys: HashMap<String, String>,
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

fn default_summary_provider() -> String {
    "groq".to_string()
}

fn default_summary_base_url() -> String {
    "https://api.groq.com/openai/v1".to_string()
}

fn default_summary_model() -> String {
    "openai/gpt-oss-120b".to_string()
}

fn default_hotkey_mode() -> String {
    "hold".to_string()
}

fn default_copy_to_clipboard_on_success() -> bool {
    false
}

fn default_true() -> bool {
    true
}

fn default_meeting_hotkey() -> String {
    DEFAULT_MEETING_HOTKEY.to_string()
}

fn default_meeting_record_video() -> bool {
    true
}

fn default_meeting_record_mic() -> bool {
    true
}

fn default_meeting_record_system_audio() -> bool {
    true
}

fn default_meeting_video_preset() -> String {
    "screen_720p_30".to_string()
}

fn default_meeting_language() -> String {
    "en".to_string()
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
    #[serde(default = "default_meeting_hotkey")]
    meeting_hotkey: String,
    #[serde(default = "default_hotkey_mode")]
    hotkey_mode: String,
    #[serde(default = "default_copy_to_clipboard_on_success")]
    copy_to_clipboard_on_success: bool,
    #[serde(default = "default_meeting_record_video")]
    meeting_record_video: bool,
    #[serde(default = "default_meeting_record_mic")]
    meeting_record_mic: bool,
    #[serde(default = "default_meeting_record_system_audio")]
    meeting_record_system_audio: bool,
    #[serde(default = "default_meeting_video_preset")]
    meeting_video_preset: String,
    #[serde(default)]
    meeting_mic_device: Option<String>,
    #[serde(default)]
    meeting_system_audio_device: Option<String>,
    #[serde(default)]
    meeting_consent_acknowledged: bool,
    #[serde(default)]
    encrypted_api_key: Option<String>,
    #[serde(default)]
    encrypted_deepgram_api_key: Option<String>,
    #[serde(default)]
    keyterm_glossary: Vec<KeytermEntry>,
    #[serde(default = "default_meeting_language")]
    meeting_language: String,
    #[serde(default)]
    deepgram_redaction_enabled: bool,
    #[serde(default = "default_true")]
    deepgram_redact_pii: bool,
    #[serde(default = "default_true")]
    deepgram_redact_pci: bool,
    #[serde(default)]
    encrypted_provider_api_keys: HashMap<String, String>,
    #[serde(default = "default_summary_provider")]
    summary_provider: String,
    #[serde(default = "default_summary_base_url")]
    summary_base_url: String,
    #[serde(default = "default_summary_model")]
    summary_model: String,
    #[serde(default)]
    encrypted_summary_provider_api_keys: HashMap<String, String>,
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
            meeting_hotkey: default_meeting_hotkey(),
            hotkey_mode: "hold".to_string(),
            copy_to_clipboard_on_success: false,
            meeting_record_video: true,
            meeting_record_mic: true,
            meeting_record_system_audio: true,
            meeting_video_preset: default_meeting_video_preset(),
            meeting_mic_device: None,
            meeting_system_audio_device: None,
            meeting_consent_acknowledged: false,
            api_key: String::new(),
            deepgram_api_key: String::new(),
            keyterm_glossary: Vec::new(),
            meeting_language: default_meeting_language(),
            deepgram_redaction_enabled: false,
            deepgram_redact_pii: true,
            deepgram_redact_pci: true,
            provider_api_keys: HashMap::new(),
            summary_provider: default_summary_provider(),
            summary_base_url: default_summary_base_url(),
            summary_model: default_summary_model(),
            summary_api_key: String::new(),
            summary_provider_api_keys: HashMap::new(),
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

                let normalized_meeting = normalize_meeting_hotkey(&stored.meeting_hotkey);
                if normalized_meeting != stored.meeting_hotkey {
                    stored.meeting_hotkey = normalized_meeting;
                    updated = true;
                }

                if updated {
                    if let Ok(new_contents) = serde_json::to_string_pretty(&stored) {
                        let _ = fs::write(&path, new_contents);
                    }
                }

                let StoredSettings {
                    provider,
                    base_url,
                    model,
                    hotkey,
                    meeting_hotkey,
                    hotkey_mode,
                    copy_to_clipboard_on_success,
                    meeting_record_video,
                    meeting_record_mic,
                    meeting_record_system_audio,
                    meeting_video_preset,
                    meeting_mic_device,
                    meeting_system_audio_device,
                    meeting_consent_acknowledged,
                    encrypted_api_key: _,
                    encrypted_deepgram_api_key: _,
                    keyterm_glossary,
                    meeting_language,
                    deepgram_redaction_enabled,
                    deepgram_redact_pii,
                    deepgram_redact_pci,
                    encrypted_provider_api_keys,
                    summary_provider,
                    summary_base_url,
                    summary_model,
                    encrypted_summary_provider_api_keys,
                    vocabulary,
                    active_mode_id,
                    modes,
                } = stored;

                settings.provider = provider;
                settings.base_url = base_url;
                settings.model = model;
                settings.hotkey = hotkey;
                settings.meeting_hotkey = normalize_meeting_hotkey(&meeting_hotkey);
                settings.hotkey_mode = hotkey_mode;
                settings.copy_to_clipboard_on_success = copy_to_clipboard_on_success;
                settings.meeting_record_video = meeting_record_video;
                settings.meeting_record_mic = meeting_record_mic;
                settings.meeting_record_system_audio = meeting_record_system_audio;
                settings.meeting_video_preset = meeting_video_preset;
                settings.meeting_mic_device = meeting_mic_device;
                settings.meeting_system_audio_device = meeting_system_audio_device;
                settings.meeting_consent_acknowledged = meeting_consent_acknowledged;
                settings.keyterm_glossary = keyterm_glossary;
                settings.meeting_language = normalize_meeting_language(&meeting_language);
                settings.deepgram_redaction_enabled = deepgram_redaction_enabled;
                settings.deepgram_redact_pii = deepgram_redact_pii;
                settings.deepgram_redact_pci = deepgram_redact_pci;
                settings.vocabulary = vocabulary;
                settings.active_mode_id = active_mode_id;
                settings.modes = modes;
                settings.summary_provider = summary_provider;
                settings.summary_base_url = summary_base_url;
                settings.summary_model = summary_model;
                for (provider, encrypted) in encrypted_provider_api_keys {
                    if let Some(decrypted) = decrypt_api_key(&encrypted) {
                        settings.provider_api_keys.insert(provider, decrypted);
                    }
                }
                for (provider, encrypted) in encrypted_summary_provider_api_keys {
                    if let Some(decrypted) = decrypt_api_key(&encrypted) {
                        settings
                            .summary_provider_api_keys
                            .insert(provider, decrypted);
                    }
                }
                should_seed_default_modes = !has_modes_field;
            }
        }
    }

    if let Some(provider_key) = settings.provider_api_keys.get(&settings.provider).cloned() {
        settings.api_key = provider_key;
    } else if let Ok(Some(api_key)) = get_api_key() {
        if !api_key.trim().is_empty() {
            settings
                .provider_api_keys
                .insert(settings.provider.clone(), api_key.clone());
        }
        settings.api_key = api_key;
    }

    if let Some(summary_key) = settings
        .summary_provider_api_keys
        .get(&settings.summary_provider)
        .cloned()
    {
        settings.summary_api_key = summary_key;
    }

    if let Ok(Some(api_key)) = get_deepgram_api_key() {
        settings.deepgram_api_key = api_key;
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

fn normalize_meeting_language(value: &str) -> String {
    match value.trim() {
        "multi" => "multi".to_string(),
        _ => default_meeting_language(),
    }
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let mut provider_api_keys = settings.provider_api_keys.clone();
    if settings.api_key.trim().is_empty() {
        provider_api_keys.remove(&settings.provider);
    } else {
        provider_api_keys.insert(settings.provider.clone(), settings.api_key.clone());
    }

    let mut encrypted_provider_api_keys = HashMap::new();
    for (provider, api_key) in provider_api_keys {
        if api_key.trim().is_empty() {
            continue;
        }
        encrypted_provider_api_keys.insert(provider, encrypt_api_key(&api_key));
    }

    let mut summary_provider_api_keys = settings.summary_provider_api_keys.clone();
    if settings.summary_api_key.trim().is_empty() {
        summary_provider_api_keys.remove(&settings.summary_provider);
    } else {
        summary_provider_api_keys.insert(
            settings.summary_provider.clone(),
            settings.summary_api_key.clone(),
        );
    }

    let mut encrypted_summary_provider_api_keys = HashMap::new();
    for (provider, api_key) in summary_provider_api_keys {
        if api_key.trim().is_empty() {
            continue;
        }
        encrypted_summary_provider_api_keys.insert(provider, encrypt_api_key(&api_key));
    }

    let stored = StoredSettings {
        provider: settings.provider.clone(),
        base_url: settings.base_url.clone(),
        model: settings.model.clone(),
        hotkey: settings.hotkey.clone(),
        meeting_hotkey: settings.meeting_hotkey.clone(),
        hotkey_mode: settings.hotkey_mode.clone(),
        copy_to_clipboard_on_success: settings.copy_to_clipboard_on_success,
        meeting_record_video: settings.meeting_record_video,
        meeting_record_mic: settings.meeting_record_mic,
        meeting_record_system_audio: settings.meeting_record_system_audio,
        meeting_video_preset: settings.meeting_video_preset.clone(),
        meeting_mic_device: settings.meeting_mic_device.clone(),
        meeting_system_audio_device: settings.meeting_system_audio_device.clone(),
        meeting_consent_acknowledged: settings.meeting_consent_acknowledged,
        encrypted_api_key: None,
        encrypted_deepgram_api_key: None,
        keyterm_glossary: settings.keyterm_glossary.clone(),
        meeting_language: normalize_meeting_language(&settings.meeting_language),
        deepgram_redaction_enabled: settings.deepgram_redaction_enabled,
        deepgram_redact_pii: settings.deepgram_redact_pii,
        deepgram_redact_pci: settings.deepgram_redact_pci,
        encrypted_provider_api_keys,
        summary_provider: settings.summary_provider.clone(),
        summary_base_url: settings.summary_base_url.clone(),
        summary_model: settings.summary_model.clone(),
        encrypted_summary_provider_api_keys,
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

    if settings.deepgram_api_key.trim().is_empty() {
        delete_deepgram_api_key()?;
    } else {
        store_deepgram_api_key(&settings.deepgram_api_key)?;
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

fn normalize_meeting_hotkey(hotkey: &str) -> String {
    match hotkey {
        LEGACY_DEFAULT_MEETING_HOTKEY => DEFAULT_MEETING_HOTKEY.to_string(),
        other => normalize_hotkey(other),
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
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, API_KEY_USER) {
        let _ = entry.set_password(api_key);
    }

    Ok(())
}

fn get_api_key() -> Result<Option<String>, String> {
    // Try keyring first
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, API_KEY_USER) {
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
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, API_KEY_USER) {
        let _ = entry.delete_credential();
    }

    // Also clear fallback
    clear_encrypted_api_key_fallback();
    Ok(())
}

fn store_encrypted_api_key_fallback(api_key: &str) -> Result<(), String> {
    let path = settings_path()?;
    let mut stored = if let Ok(contents) = fs::read_to_string(&path) {
        serde_json::from_str::<StoredSettings>(&contents)
            .unwrap_or_else(|_| default_stored_settings())
    } else {
        default_stored_settings()
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

fn store_deepgram_api_key(api_key: &str) -> Result<(), String> {
    store_encrypted_deepgram_api_key_fallback(api_key)?;

    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, DEEPGRAM_KEY_USER) {
        let _ = entry.set_password(api_key);
    }

    Ok(())
}

fn get_deepgram_api_key() -> Result<Option<String>, String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, DEEPGRAM_KEY_USER) {
        match entry.get_password() {
            Ok(value) => return Ok(Some(value)),
            Err(keyring::Error::NoEntry) => {}
            Err(_) => {}
        }
    }

    get_encrypted_deepgram_api_key_fallback()
}

fn delete_deepgram_api_key() -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, DEEPGRAM_KEY_USER) {
        let _ = entry.delete_credential();
    }

    clear_encrypted_deepgram_api_key_fallback();
    Ok(())
}

fn store_encrypted_deepgram_api_key_fallback(api_key: &str) -> Result<(), String> {
    let path = settings_path()?;
    let mut stored = if let Ok(contents) = fs::read_to_string(&path) {
        serde_json::from_str::<StoredSettings>(&contents)
            .unwrap_or_else(|_| default_stored_settings())
    } else {
        default_stored_settings()
    };

    stored.encrypted_deepgram_api_key = Some(encrypt_api_key(api_key));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| e.to_string())?;

    Ok(())
}

fn get_encrypted_deepgram_api_key_fallback() -> Result<Option<String>, String> {
    let path = settings_path()?;
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(stored) = serde_json::from_str::<StoredSettings>(&contents) {
            if let Some(encrypted) = stored.encrypted_deepgram_api_key {
                return Ok(decrypt_api_key(&encrypted));
            }
        }
    }
    Ok(None)
}

fn clear_encrypted_deepgram_api_key_fallback() {
    if let Ok(path) = settings_path() {
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(mut stored) = serde_json::from_str::<StoredSettings>(&contents) {
                stored.encrypted_deepgram_api_key = None;
                if let Ok(new_contents) = serde_json::to_string_pretty(&stored) {
                    let _ = fs::write(&path, new_contents);
                }
            }
        }
    }
}

fn default_stored_settings() -> StoredSettings {
    StoredSettings {
        provider: "groq".to_string(),
        base_url: "https://api.groq.com/openai/v1".to_string(),
        model: "whisper-large-v3-turbo".to_string(),
        hotkey: DEFAULT_HOTKEY.to_string(),
        meeting_hotkey: default_meeting_hotkey(),
        hotkey_mode: "hold".to_string(),
        copy_to_clipboard_on_success: false,
        meeting_record_video: true,
        meeting_record_mic: true,
        meeting_record_system_audio: true,
        meeting_video_preset: default_meeting_video_preset(),
        meeting_mic_device: None,
        meeting_system_audio_device: None,
        meeting_consent_acknowledged: false,
        encrypted_api_key: None,
        encrypted_deepgram_api_key: None,
        keyterm_glossary: Vec::new(),
        meeting_language: default_meeting_language(),
        deepgram_redaction_enabled: false,
        deepgram_redact_pii: true,
        deepgram_redact_pci: true,
        encrypted_provider_api_keys: HashMap::new(),
        summary_provider: default_summary_provider(),
        summary_base_url: default_summary_base_url(),
        summary_model: default_summary_model(),
        encrypted_summary_provider_api_keys: HashMap::new(),
        vocabulary: Vec::new(),
        active_mode_id: None,
        modes: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{json_has_modes_field, normalize_meeting_hotkey, StoredSettings};

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

    #[test]
    fn meeting_hotkey_migrates_old_default() {
        assert_eq!(
            normalize_meeting_hotkey("CommandOrControl+Shift+M"),
            "CommandOrControl+Alt+M"
        );
    }

    #[test]
    fn meeting_hotkey_keeps_custom_value() {
        assert_eq!(
            normalize_meeting_hotkey("CommandOrControl+Shift+R"),
            "CommandOrControl+Shift+R"
        );
    }

    #[test]
    fn legacy_settings_default_summary_fields() {
        let legacy_json = r#"{
      "provider": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "whisper-large-v3-turbo",
      "hotkey": "CommandOrControl+Space"
    }"#;

        let parsed: StoredSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(parsed.summary_provider, "groq");
        assert_eq!(parsed.summary_base_url, "https://api.groq.com/openai/v1");
        assert_eq!(parsed.summary_model, "openai/gpt-oss-120b");
        assert!(parsed.encrypted_summary_provider_api_keys.is_empty());
    }
}
