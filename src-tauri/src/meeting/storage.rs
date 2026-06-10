use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use rusqlite::{params, OptionalExtension};

use crate::meeting::types::{
    MeetingDetail, MeetingMeta, MeetingStatus, MeetingTranscript, TranscriptStatus,
};

const SOURCE_FILE: &str = "recording.mp4";
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
    Ok(crate::db::app_data_dir()?.join("meetings"))
}

pub fn meeting_dir(id: &str) -> Result<PathBuf, String> {
    Ok(meetings_dir()?.join(id))
}

pub fn source_path(id: &str) -> Result<PathBuf, String> {
    Ok(meeting_dir(id)?.join(SOURCE_FILE))
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
    crate::db::with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, title, started_at_ms, ended_at_ms, duration_secs,
                       has_video, has_mic, has_system_audio, file_size_bytes, status,
                       transcript_status, transcript_error, assemblyai_transcript_id,
                       transcript_started_at_ms
                FROM meetings
                ORDER BY started_at_ms DESC
                "#,
            )
            .map_err(|error| format!("Failed to query meetings index: {error}"))?;
        let items = stmt
            .query_map([], crate::db::meeting_from_row)
            .map_err(|error| format!("Failed to query meetings index: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read meeting metadata row: {error}"))?;
        Ok(items)
    })
}

pub fn load_index_reconciled(live_ids: &HashSet<String>) -> Result<Vec<MeetingMeta>, String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    let mut items = load_index()?;
    let ended_at_ms = now_ms()?;
    let mut changed = reconcile_orphaned_recordings(&mut items, live_ids, ended_at_ms, |id| {
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
    live_ids: &HashSet<String>,
    ended_at_ms: i64,
    mut file_size_for: F,
) -> Result<bool, String>
where
    F: FnMut(&str) -> Result<Option<u64>, String>,
{
    let mut changed = false;

    for item in items {
        if !matches!(
            item.status,
            MeetingStatus::Recording | MeetingStatus::Processing
        ) {
            continue;
        }
        if live_ids.contains(&item.id) {
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
    crate::db::with_connection(|conn| {
        let tx = conn
            .transaction()
            .map_err(|error| format!("Failed to start meeting index transaction: {error}"))?;

        let ids = items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        let existing = {
            let mut stmt = tx
                .prepare("SELECT id FROM meetings")
                .map_err(|error| format!("Failed to query existing meeting ids: {error}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Failed to query existing meeting ids: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read existing meeting id: {error}"))?;
            rows
        };
        for id in existing {
            if !ids.contains(id.as_str()) {
                tx.execute("DELETE FROM meetings WHERE id = ?1", params![id])
                    .map_err(|error| format!("Failed to delete stale meeting metadata: {error}"))?;
            }
        }
        for item in items {
            crate::db::upsert_meeting_meta(&tx, item)?;
        }

        tx.commit()
            .map_err(|error| format!("Failed to save meeting index: {error}"))
    })
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
    crate::db::with_connection(|conn| crate::db::upsert_meeting_meta(conn, &meta))
}

pub fn get_detail_reconciled(id: &str, live_ids: &HashSet<String>) -> Result<MeetingDetail, String> {
    let meta = load_index_reconciled(live_ids)?
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
    if !meeting_exists(id)? {
        return Err("Meeting no longer exists.".to_string());
    }
    let dir = meeting_dir(id)?;
    if !dir.exists() {
        return Err("Meeting folder no longer exists.".to_string());
    }
    let contents = serde_json::to_string_pretty(transcript).map_err(|e| e.to_string())?;
    crate::db::with_connection(|conn| {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO meeting_transcripts (meeting_id, json)
            VALUES (?1, ?2)
            "#,
            params![id, contents],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to save meeting transcript: {error}"))
    })
}

pub fn load_transcript(id: &str) -> Result<Option<MeetingTranscript>, String> {
    let contents = crate::db::with_connection(|conn| {
        conn.query_row(
            "SELECT json FROM meeting_transcripts WHERE meeting_id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load meeting transcript: {error}"))
    })?;
    contents.map_or(Ok(None), |contents| {
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| format!("Failed to parse meeting transcript: {error}"))
    })
}

pub fn meeting_exists(id: &str) -> Result<bool, String> {
    crate::db::with_connection(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| format!("Failed to check meeting existence: {error}"))
    })
}

pub fn delete_meeting(id: &str) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    crate::db::with_connection(|conn| {
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|error| format!("Failed to delete meeting metadata: {error}"))
    })?;

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

    fn live(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn reconciliation_marks_only_orphaned_recordings_as_error() {
        let mut items = vec![
            meta("active", MeetingStatus::Recording),
            meta("orphan", MeetingStatus::Recording),
            meta("done", MeetingStatus::Recorded),
        ];

        let changed = reconcile_orphaned_recordings(&mut items, &live(&["active"]), 6_000, |id| {
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
            reconcile_orphaned_recordings(&mut items, &live(&["active"]), 6_000, |_| Ok(Some(42)))
                .unwrap();

        assert!(!changed);
        assert!(matches!(items[0].status, MeetingStatus::Recording));
        assert_eq!(items[0].file_size_bytes, None);
    }

    #[test]
    fn reconciliation_keeps_live_processing_meetings() {
        let mut items = vec![meta("saving", MeetingStatus::Processing)];

        let changed =
            reconcile_orphaned_recordings(&mut items, &live(&["saving"]), 6_000, |_| Ok(Some(42)))
                .unwrap();

        assert!(!changed);
        assert!(matches!(items[0].status, MeetingStatus::Processing));
    }

    #[test]
    fn reconciliation_marks_dangling_processing_as_error() {
        let mut items = vec![meta("orphan", MeetingStatus::Processing)];

        let changed =
            reconcile_orphaned_recordings(&mut items, &live(&[]), 6_000, |_| Ok(Some(42)))
                .unwrap();

        assert!(changed);
        assert!(matches!(items[0].status, MeetingStatus::Error));
        assert_eq!(items[0].ended_at_ms, Some(6_000));
        assert_eq!(items[0].file_size_bytes, Some(42));
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
