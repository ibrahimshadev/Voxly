use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::meeting::types::{MeetingDetail, MeetingMeta, MeetingStatus};

const INDEX_FILE: &str = "index.json";
const SOURCE_FILE: &str = "recording.mp4";

pub fn now_ms() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64)
}

pub fn meetings_dir() -> Result<PathBuf, String> {
    let base_dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config")
    } else {
        std::env::temp_dir()
    };

    Ok(base_dir.join("dikt").join("meetings"))
}

pub fn meeting_dir(id: &str) -> Result<PathBuf, String> {
    Ok(meetings_dir()?.join(id))
}

pub fn source_path(id: &str) -> Result<PathBuf, String> {
    Ok(meeting_dir(id)?.join(SOURCE_FILE))
}

pub fn create_meeting_folder(id: &str) -> Result<PathBuf, String> {
    let dir = meeting_dir(id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn load_index() -> Result<Vec<MeetingMeta>, String> {
    let path = meetings_dir()?.join(INDEX_FILE);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Failed to read meetings index '{}': {error}",
                path.display()
            ))
        }
    };

    let mut items: Vec<MeetingMeta> = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse meetings index '{}': {error}",
            path.display()
        )
    })?;
    items.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    Ok(items)
}

pub fn load_index_reconciled(active_id: Option<&str>) -> Result<Vec<MeetingMeta>, String> {
    let mut items = load_index()?;
    let ended_at_ms = now_ms()?;
    let changed = reconcile_orphaned_recordings(&mut items, active_id, ended_at_ms, |id| {
        Ok(file_size(&source_path(id)?))
    })?;

    if changed {
        save_index(&items)?;
        items.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    }

    Ok(items)
}

fn reconcile_orphaned_recordings<F>(
    items: &mut [MeetingMeta],
    active_id: Option<&str>,
    ended_at_ms: i64,
    mut file_size_for: F,
) -> Result<bool, String>
where
    F: FnMut(&str) -> Result<Option<u64>, String>,
{
    let mut changed = false;

    for item in items {
        if !matches!(item.status, MeetingStatus::Recording) {
            continue;
        }
        if active_id.is_some_and(|id| id == item.id) {
            continue;
        }

        item.status = MeetingStatus::Error;
        item.ended_at_ms.get_or_insert(ended_at_ms);
        item.duration_secs
            .get_or_insert(((ended_at_ms - item.started_at_ms).max(0) as f64) / 1000.0);
        item.file_size_bytes = file_size_for(&item.id)?;
        changed = true;
    }

    Ok(changed)
}

pub fn save_index(items: &[MeetingMeta]) -> Result<(), String> {
    let dir = meetings_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(INDEX_FILE);
    let contents = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    atomic_write(&path, contents.as_bytes())
}

pub fn upsert_meta(meta: MeetingMeta) -> Result<(), String> {
    let mut items = load_index()?;
    if let Some(existing) = items.iter_mut().find(|item| item.id == meta.id) {
        *existing = meta;
    } else {
        items.insert(0, meta);
    }
    items.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    save_index(&items)
}

pub fn get_detail_reconciled(id: &str, active_id: Option<&str>) -> Result<MeetingDetail, String> {
    let meta = load_index_reconciled(active_id)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "Meeting not found".to_string())?;
    let source = source_path(id)?;
    Ok(MeetingDetail {
        meta,
        source_path: source.to_string_lossy().to_string(),
    })
}

pub fn delete_meeting(id: &str) -> Result<(), String> {
    let mut items = load_index()?;
    items.retain(|item| item.id != id);
    save_index(&items)?;

    let dir = meeting_dir(id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to delete meeting folder '{}': {e}", dir.display()))?;
    }
    Ok(())
}

pub fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, bytes).map_err(|e| {
        format!(
            "Failed to write temporary file '{}': {e}",
            tmp_path.display()
        )
    })?;
    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(path);
        fs::rename(&tmp_path, path).map_err(|retry_error| {
            format!(
                "Failed to move '{}' into place (rename error: {error}, retry error: {retry_error})",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, status: MeetingStatus) -> MeetingMeta {
        MeetingMeta {
            id: id.to_string(),
            title: id.to_string(),
            started_at_ms: 1_000,
            ended_at_ms: None,
            duration_secs: None,
            has_video: true,
            has_mic: false,
            has_system_audio: false,
            file_size_bytes: None,
            status,
        }
    }

    #[test]
    fn reconciliation_marks_only_orphaned_recordings_as_error() {
        let mut items = vec![
            meta("active", MeetingStatus::Recording),
            meta("orphan", MeetingStatus::Recording),
            meta("done", MeetingStatus::Recorded),
        ];

        let changed = reconcile_orphaned_recordings(&mut items, Some("active"), 6_000, |id| {
            Ok((id == "orphan").then_some(42))
        })
        .unwrap();

        assert!(changed);
        assert!(matches!(items[0].status, MeetingStatus::Recording));
        assert!(items[0].ended_at_ms.is_none());
        assert!(matches!(items[1].status, MeetingStatus::Error));
        assert_eq!(items[1].ended_at_ms, Some(6_000));
        assert_eq!(items[1].duration_secs, Some(5.0));
        assert_eq!(items[1].file_size_bytes, Some(42));
        assert!(matches!(items[2].status, MeetingStatus::Recorded));
    }

    #[test]
    fn reconciliation_is_noop_when_active_recording_is_current() {
        let mut items = vec![meta("active", MeetingStatus::Recording)];

        let changed =
            reconcile_orphaned_recordings(&mut items, Some("active"), 6_000, |_| Ok(Some(42)))
                .unwrap();

        assert!(!changed);
        assert!(matches!(items[0].status, MeetingStatus::Recording));
        assert_eq!(items[0].file_size_bytes, None);
    }
}
