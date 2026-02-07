use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const MAX_HISTORY_ITEMS: usize = 10_000;
static LAST_HISTORY_ERROR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TranscriptionHistoryItem {
    pub id: String,
    pub text: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
}

fn history_path() -> Result<PathBuf, String> {
    let base_dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config")
    } else {
        std::env::temp_dir()
    };

    Ok(base_dir.join("dikt").join("transcription_history.json"))
}

fn set_last_error(message: String) {
    if let Ok(mut guard) = LAST_HISTORY_ERROR.lock() {
        *guard = Some(message);
    }
}

fn normalize_items(mut items: Vec<TranscriptionHistoryItem>) -> Vec<TranscriptionHistoryItem> {
    items.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    items.truncate(MAX_HISTORY_ITEMS);
    items
}

fn load_history_from(path: &Path) -> Result<Vec<TranscriptionHistoryItem>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(format!(
                "Failed to read transcription history file '{}': {e}",
                path.display()
            ))
        }
    };
    let items: Vec<TranscriptionHistoryItem> = serde_json::from_str(&contents).map_err(|e| {
        format!(
            "Failed to parse transcription history JSON from '{}': {e}",
            path.display()
        )
    })?;
    Ok(normalize_items(items))
}

fn save_history_to(path: &Path, items: &[TranscriptionHistoryItem]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, contents).map_err(|e| {
        format!(
            "Failed to write temporary transcription history file '{}': {e}",
            tmp_path.display()
        )
    })?;
    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(path);
        fs::rename(&tmp_path, path).map_err(|rename_err| {
            format!(
                "Failed to move transcription history file '{}' into place (rename error: {e}, retry error: {rename_err})",
                path.display()
            )
        })?;
    }
    Ok(())
}

pub fn load_history() -> Result<Vec<TranscriptionHistoryItem>, String> {
    let path = history_path()?;
    load_history_from(&path)
}

pub struct AppendItemParams {
    pub text: String,
    pub duration_secs: Option<f64>,
    pub language: Option<String>,
    pub mode_name: Option<String>,
    pub original_text: Option<String>,
}

pub fn append_item(params: AppendItemParams) -> Result<(), String> {
    let path = history_path()?;
    let mut items = load_history_from(&path)?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let item = TranscriptionHistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        text: params.text,
        created_at_ms: now_ms,
        duration_secs: params.duration_secs,
        language: params.language,
        mode_name: params.mode_name,
        original_text: params.original_text,
    };

    items.insert(0, item);
    items.truncate(MAX_HISTORY_ITEMS);

    save_history_to(&path, &items)
}

pub fn delete_item(id: &str) -> Result<(), String> {
    let path = history_path()?;
    let mut items = load_history_from(&path)?;
    items.retain(|item| item.id != id);
    save_history_to(&path, &items)
}

pub fn clear_history() -> Result<(), String> {
    let path = history_path()?;
    save_history_to(&path, &[])
}

pub fn record_runtime_error(message: String) {
    set_last_error(message);
}

pub fn take_runtime_error() -> Option<String> {
    LAST_HISTORY_ERROR
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dikt_test_{}", uuid::Uuid::new_v4()));
        dir.join("dikt").join("transcription_history.json")
    }

    #[test]
    fn load_empty_returns_empty_vec() {
        let path = test_path();
        let items = load_history_from(&path).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn save_load_roundtrip() {
        let path = test_path();
        let items = vec![TranscriptionHistoryItem {
            id: "test-1".to_string(),
            text: "Hello world".to_string(),
            created_at_ms: 1000,
            ..Default::default()
        }];
        save_history_to(&path, &items).unwrap();
        let loaded = load_history_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "test-1");
        assert_eq!(loaded[0].text, "Hello world");
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn append_prepends_and_trims() {
        let path = test_path();
        for i in 0..5 {
            let mut items = load_history_from(&path).unwrap();
            let item = TranscriptionHistoryItem {
                id: uuid::Uuid::new_v4().to_string(),
                text: format!("item {i}"),
                created_at_ms: i as i64,
                ..Default::default()
            };
            items.insert(0, item);
            items.truncate(3);
            save_history_to(&path, &items).unwrap();
        }
        let items = load_history_from(&path).unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "item 4");
        assert_eq!(items[1].text, "item 3");
        assert_eq!(items[2].text, "item 2");
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn delete_by_id() {
        let path = test_path();
        let items = vec![
            TranscriptionHistoryItem {
                id: "a".to_string(),
                text: "two".to_string(),
                created_at_ms: 2,
                ..Default::default()
            },
            TranscriptionHistoryItem {
                id: "b".to_string(),
                text: "one".to_string(),
                created_at_ms: 1,
                ..Default::default()
            },
        ];
        save_history_to(&path, &items).unwrap();

        let mut loaded = load_history_from(&path).unwrap();
        loaded.retain(|item| item.id != "a");
        save_history_to(&path, &loaded).unwrap();

        let result = load_history_from(&path).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "one");
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn clear_removes_all() {
        let path = test_path();
        let items = vec![TranscriptionHistoryItem {
            id: "a".to_string(),
            text: "hello".to_string(),
            created_at_ms: 1,
            ..Default::default()
        }];
        save_history_to(&path, &items).unwrap();
        save_history_to(&path, &[]).unwrap();
        let result = load_history_from(&path).unwrap();
        assert!(result.is_empty());
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn malformed_json_returns_empty() {
        let path = test_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not valid json!!!").unwrap();
        let result = load_history_from(&path);
        assert!(result.is_err());
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn load_truncates_to_max_items() {
        let path = test_path();
        let count = MAX_HISTORY_ITEMS + 25;
        let mut items = Vec::new();
        for i in 0..count {
            items.push(TranscriptionHistoryItem {
                id: format!("item-{i}"),
                text: format!("entry {i}"),
                created_at_ms: i as i64,
                ..Default::default()
            });
        }
        save_history_to(&path, &items).unwrap();
        let loaded = load_history_from(&path).unwrap();
        assert_eq!(loaded.len(), MAX_HISTORY_ITEMS);
        assert_eq!(loaded[0].id, format!("item-{}", count - 1));
        let _ = fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}
