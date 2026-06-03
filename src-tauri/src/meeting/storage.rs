use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::meeting::types::{
    MeetingDetail, MeetingMeta, MeetingStatus, MeetingTranscript, TranscriptStatus,
};

const INDEX_FILE: &str = "index.json";
const SOURCE_FILE: &str = "recording.mp4";
const TRANSCRIPT_FILE: &str = "transcript.json";
const TRANSCRIPT_AUDIO_FILE: &str = "transcript-audio.m4a";
const STALE_PENDING_TRANSCRIPT_MS: i64 = 6 * 60 * 60 * 1000;
static STORAGE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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

pub fn transcript_path(id: &str) -> Result<PathBuf, String> {
    Ok(meeting_dir(id)?.join(TRANSCRIPT_FILE))
}

pub fn transcript_audio_path(id: &str) -> Result<PathBuf, String> {
    Ok(meeting_dir(id)?.join(TRANSCRIPT_AUDIO_FILE))
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
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    let mut items = load_index()?;
    let ended_at_ms = now_ms()?;
    let mut changed = reconcile_orphaned_recordings(&mut items, active_id, ended_at_ms, |id| {
        Ok(file_size(&source_path(id)?))
    })?;
    changed |= reconcile_stale_pending_transcripts(&mut items, ended_at_ms);

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

pub fn update_meta_by_id<F>(id: &str, patch: F) -> Result<Option<MeetingMeta>, String>
where
    F: FnOnce(&mut MeetingMeta) -> Result<(), String>,
{
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    let mut items = load_index()?;
    let Some(item) = items.iter_mut().find(|item| item.id == id) else {
        return Ok(None);
    };

    patch(item)?;
    let updated = item.clone();
    items.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    save_index(&items)?;
    Ok(Some(updated))
}

pub fn upsert_meta(meta: MeetingMeta) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
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
        transcript: load_transcript(id).ok().flatten(),
    })
}

pub fn save_transcript(id: &str, transcript: &MeetingTranscript) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    if !load_index()?.iter().any(|item| item.id == id) {
        return Err("Meeting no longer exists.".to_string());
    }
    let dir = meeting_dir(id)?;
    if !dir.exists() {
        return Err("Meeting folder no longer exists.".to_string());
    }
    let path = transcript_path(id)?;
    let contents = serde_json::to_string_pretty(transcript).map_err(|e| e.to_string())?;
    atomic_write_existing_parent(&path, contents.as_bytes())
}

pub fn load_transcript(id: &str) -> Result<Option<MeetingTranscript>, String> {
    let path = transcript_path(id)?;
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read meeting transcript '{}': {error}",
                path.display()
            ))
        }
    };
    serde_json::from_str(&contents).map(Some).map_err(|error| {
        format!(
            "Failed to parse meeting transcript '{}': {error}",
            path.display()
        )
    })
}

pub fn meeting_exists(id: &str) -> Result<bool, String> {
    Ok(load_index()?.iter().any(|item| item.id == id))
}

pub fn delete_meeting(id: &str) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
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

fn atomic_write_existing_parent(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path '{}' has no parent directory", path.display()))?;
    if !parent.exists() {
        return Err(format!(
            "Parent directory '{}' does not exist",
            parent.display()
        ));
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

fn reconcile_stale_pending_transcripts(items: &mut [MeetingMeta], now_ms: i64) -> bool {
    let mut changed = false;

    for item in items {
        if !matches!(item.transcript_status, Some(TranscriptStatus::Pending)) {
            continue;
        }
        let Some(started_at_ms) = item.transcript_started_at_ms else {
            item.transcript_status = Some(TranscriptStatus::Error);
            item.transcript_error =
                Some("Transcription was interrupted. Retry to start again.".to_string());
            changed = true;
            continue;
        };
        if now_ms.saturating_sub(started_at_ms) > STALE_PENDING_TRANSCRIPT_MS {
            item.transcript_status = Some(TranscriptStatus::Error);
            item.transcript_error = Some(
                "Transcription did not complete before the app stopped. Retry to start again."
                    .to_string(),
            );
            changed = true;
        }
    }

    changed
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
            transcript_status: None,
            transcript_error: None,
            assemblyai_transcript_id: None,
            transcript_started_at_ms: None,
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

    #[test]
    fn stale_pending_transcript_is_marked_error() {
        let mut items = vec![MeetingMeta {
            transcript_status: Some(TranscriptStatus::Pending),
            transcript_started_at_ms: Some(1_000),
            ..meta("pending", MeetingStatus::Recorded)
        }];

        let changed = reconcile_stale_pending_transcripts(
            &mut items,
            1_000 + STALE_PENDING_TRANSCRIPT_MS + 1,
        );

        assert!(changed);
        assert!(matches!(
            items[0].transcript_status,
            Some(TranscriptStatus::Error)
        ));
        assert!(items[0]
            .transcript_error
            .as_deref()
            .unwrap_or("")
            .contains("Retry"));
    }
}
