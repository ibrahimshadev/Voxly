use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
#[cfg(test)]
use rusqlite::OptionalExtension;
use rusqlite::{params, Connection};

use crate::meeting::types::{MeetingMeta, MeetingStatus, MeetingTranscript, TranscriptStatus};
use crate::transcription_history::TranscriptionHistoryItem;

const DB_FILE: &str = "dikt.db";
const SCHEMA_VERSION: i64 = 1;

static DB: Lazy<Result<Mutex<Connection>, String>> = Lazy::new(|| {
    let app_dir = app_data_dir()?;
    let db_path = app_dir.join(DB_FILE);
    open_database(&db_path, &app_dir).map(Mutex::new)
});

pub fn app_data_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        if let Ok(dir) = std::env::var("DIKT_TEST_APP_DATA_DIR") {
            return Ok(PathBuf::from(dir));
        }
        return Ok(std::env::temp_dir().join(format!("dikt-test-{}", std::process::id())));
    }

    #[cfg(not(test))]
    let base_dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config")
    } else {
        std::env::temp_dir()
    };

    #[cfg(not(test))]
    Ok(base_dir.join("dikt"))
}

pub fn init() -> Result<(), String> {
    with_connection(|_| Ok(()))
}

pub fn with_connection<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut Connection) -> Result<T, String>,
{
    let mutex = DB
        .as_ref()
        .map_err(|error| format!("Failed to initialize database: {error}"))?;
    let mut conn = mutex
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    f(&mut conn)
}

fn open_database(db_path: &Path, app_dir: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create database directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    let mut conn = Connection::open(db_path)
        .map_err(|error| format!("Failed to open database '{}': {error}", db_path.display()))?;
    configure_connection(&conn)?;
    create_schema(&conn)?;
    migrate_json_if_needed(&mut conn, app_dir)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        "#,
    )
    .map_err(|error| format!("Failed to configure database pragmas: {error}"))
}

fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS transcription_history (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            duration_secs REAL,
            language TEXT,
            mode_name TEXT,
            original_text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_history_created_at
            ON transcription_history(created_at_ms DESC);

        CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            duration_secs REAL,
            has_video INTEGER NOT NULL,
            has_mic INTEGER NOT NULL,
            has_system_audio INTEGER NOT NULL,
            file_size_bytes INTEGER,
            status TEXT NOT NULL,
            transcript_status TEXT,
            transcript_error TEXT,
            assemblyai_transcript_id TEXT,
            transcript_started_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_meetings_started_at
            ON meetings(started_at_ms DESC);

        CREATE TABLE IF NOT EXISTS meeting_transcripts (
            meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
            json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meeting_summaries (
            meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
            json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            provider TEXT
        );
        "#,
    )
    .map_err(|error| format!("Failed to create database schema: {error}"))
}

fn migrate_json_if_needed(conn: &mut Connection, app_dir: &Path) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Failed to read database user_version: {error}"))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("Failed to start database migration: {error}"))?;

    migrate_history_json(&tx, app_dir);
    migrate_meetings_json(&tx, app_dir);
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| format!("Failed to update database user_version: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Failed to commit database migration: {error}"))?;

    Ok(())
}

fn migrate_history_json(conn: &Connection, app_dir: &Path) {
    let path = app_dir.join("transcription_history.json");
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            eprintln!(
                "Skipping transcription history JSON migration; failed to read '{}': {error}",
                path.display()
            );
            return;
        }
    };

    let items: Vec<TranscriptionHistoryItem> = match serde_json::from_str(&contents) {
        Ok(items) => items,
        Err(error) => {
            eprintln!(
                "Skipping transcription history JSON migration; failed to parse '{}': {error}",
                path.display()
            );
            return;
        }
    };

    for item in items {
        if let Err(error) = insert_history_item(conn, &item) {
            eprintln!(
                "Skipping transcription history item '{}' during JSON migration: {error}",
                item.id
            );
        }
    }
}

fn migrate_meetings_json(conn: &Connection, app_dir: &Path) {
    let meetings_dir = app_dir.join("meetings");
    let index_path = meetings_dir.join("index.json");
    let contents = match fs::read_to_string(&index_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            eprintln!(
                "Skipping meetings JSON migration; failed to read '{}': {error}",
                index_path.display()
            );
            return;
        }
    };

    let items: Vec<MeetingMeta> = match serde_json::from_str(&contents) {
        Ok(items) => items,
        Err(error) => {
            eprintln!(
                "Skipping meetings JSON migration; failed to parse '{}': {error}",
                index_path.display()
            );
            return;
        }
    };

    for item in items {
        if let Err(error) = upsert_meeting_meta(conn, &item) {
            eprintln!(
                "Skipping meeting '{}' during JSON migration: {error}",
                item.id
            );
            continue;
        }

        let transcript_path = meetings_dir.join(&item.id).join("transcript.json");
        let transcript_json = match fs::read_to_string(&transcript_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                eprintln!(
                    "Skipping meeting transcript JSON migration; failed to read '{}': {error}",
                    transcript_path.display()
                );
                continue;
            }
        };

        if let Err(error) = serde_json::from_str::<MeetingTranscript>(&transcript_json) {
            eprintln!(
                "Skipping meeting transcript JSON migration; failed to parse '{}': {error}",
                transcript_path.display()
            );
            continue;
        }

        if let Err(error) = conn.execute(
            r#"
            INSERT OR REPLACE INTO meeting_transcripts (meeting_id, json)
            VALUES (?1, ?2)
            "#,
            params![&item.id, transcript_json],
        ) {
            eprintln!(
                "Skipping meeting transcript '{}' during JSON migration: {error}",
                item.id
            );
        }
    }
}

pub fn insert_history_item(
    conn: &Connection,
    item: &TranscriptionHistoryItem,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT OR IGNORE INTO transcription_history (
            id, text, created_at_ms, duration_secs, language, mode_name, original_text
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            &item.id,
            &item.text,
            item.created_at_ms,
            item.duration_secs,
            item.language.as_deref(),
            item.mode_name.as_deref(),
            item.original_text.as_deref()
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("Failed to insert transcription history item: {error}"))
}

pub fn upsert_meeting_meta(conn: &Connection, meta: &MeetingMeta) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO meetings (
            id, title, started_at_ms, ended_at_ms, duration_secs,
            has_video, has_mic, has_system_audio, file_size_bytes, status,
            transcript_status, transcript_error, assemblyai_transcript_id, transcript_started_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            started_at_ms = excluded.started_at_ms,
            ended_at_ms = excluded.ended_at_ms,
            duration_secs = excluded.duration_secs,
            has_video = excluded.has_video,
            has_mic = excluded.has_mic,
            has_system_audio = excluded.has_system_audio,
            file_size_bytes = excluded.file_size_bytes,
            status = excluded.status,
            transcript_status = excluded.transcript_status,
            transcript_error = excluded.transcript_error,
            assemblyai_transcript_id = excluded.assemblyai_transcript_id,
            transcript_started_at_ms = excluded.transcript_started_at_ms
        "#,
        params![
            &meta.id,
            &meta.title,
            meta.started_at_ms,
            meta.ended_at_ms,
            meta.duration_secs,
            bool_to_i64(meta.has_video),
            bool_to_i64(meta.has_mic),
            bool_to_i64(meta.has_system_audio),
            meta.file_size_bytes.map(|value| value as i64),
            meeting_status_to_str(&meta.status),
            meta.transcript_status
                .as_ref()
                .map(transcript_status_to_str),
            meta.transcript_error.as_deref(),
            meta.assemblyai_transcript_id.as_deref(),
            meta.transcript_started_at_ms,
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("Failed to upsert meeting metadata: {error}"))
}

pub fn meeting_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingMeta> {
    let status: String = row.get("status")?;
    let transcript_status: Option<String> = row.get("transcript_status")?;
    let file_size_bytes: Option<i64> = row.get("file_size_bytes")?;
    Ok(MeetingMeta {
        id: row.get("id")?,
        title: row.get("title")?,
        started_at_ms: row.get("started_at_ms")?,
        ended_at_ms: row.get("ended_at_ms")?,
        duration_secs: row.get("duration_secs")?,
        has_video: row.get::<_, i64>("has_video")? != 0,
        has_mic: row.get::<_, i64>("has_mic")? != 0,
        has_system_audio: row.get::<_, i64>("has_system_audio")? != 0,
        file_size_bytes: file_size_bytes.map(|value| value as u64),
        status: meeting_status_from_str(&status).unwrap_or(MeetingStatus::Error),
        transcript_status: transcript_status
            .as_deref()
            .and_then(transcript_status_from_str),
        transcript_error: row.get("transcript_error")?,
        assemblyai_transcript_id: row.get("assemblyai_transcript_id")?,
        transcript_started_at_ms: row.get("transcript_started_at_ms")?,
    })
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn meeting_status_to_str(status: &MeetingStatus) -> &'static str {
    match status {
        MeetingStatus::Recording => "recording",
        MeetingStatus::Processing => "processing",
        MeetingStatus::Recorded => "recorded",
        MeetingStatus::Error => "error",
    }
}

fn meeting_status_from_str(value: &str) -> Option<MeetingStatus> {
    match value {
        "recording" => Some(MeetingStatus::Recording),
        "processing" => Some(MeetingStatus::Processing),
        "recorded" => Some(MeetingStatus::Recorded),
        "error" => Some(MeetingStatus::Error),
        _ => None,
    }
}

fn transcript_status_to_str(status: &TranscriptStatus) -> &'static str {
    match status {
        TranscriptStatus::Pending => "pending",
        TranscriptStatus::Completed => "completed",
        TranscriptStatus::Error => "error",
    }
}

fn transcript_status_from_str(value: &str) -> Option<TranscriptStatus> {
    match value {
        "pending" => Some(TranscriptStatus::Pending),
        "completed" => Some(TranscriptStatus::Completed),
        "error" => Some(TranscriptStatus::Error),
        _ => None,
    }
}

#[cfg(test)]
pub fn open_test_database(db_path: &Path, app_dir: &Path) -> Result<Connection, String> {
    open_database(db_path, app_dir)
}

#[cfg(test)]
pub fn user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Failed to read user_version: {error}"))
}

#[cfg(test)]
pub fn history_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM transcription_history", [], |row| {
        row.get(0)
    })
    .map_err(|error| format!("Failed to count history rows: {error}"))
}

#[cfg(test)]
pub fn meeting_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM meetings", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count meeting rows: {error}"))
}

#[cfg(test)]
pub fn migrated_transcript_json(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT json FROM meeting_transcripts WHERE meeting_id = ?1",
        params![meeting_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("Failed to load migrated transcript JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn temp_app_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dikt-sqlite-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_json(path: &Path, value: serde_json::Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn first_database_open_migrates_existing_json_without_removing_it() {
        let app_dir = temp_app_dir();
        let db_path = app_dir.join(DB_FILE);

        let history_path = app_dir.join("transcription_history.json");
        write_json(
            &history_path,
            json!([
                {
                    "id": "history-1",
                    "text": "first dictation",
                    "created_at_ms": 1_000,
                    "duration_secs": 2.5,
                    "language": "en",
                    "mode_name": "Clean Draft",
                    "original_text": "first dictation"
                }
            ]),
        );

        let meetings_dir = app_dir.join("meetings");
        write_json(
            &meetings_dir.join("index.json"),
            json!([
                {
                    "id": "meeting-1",
                    "title": "Planning",
                    "started_at_ms": 2_000,
                    "ended_at_ms": 5_000,
                    "duration_secs": 3.0,
                    "has_video": true,
                    "has_mic": true,
                    "has_system_audio": true,
                    "file_size_bytes": 42,
                    "status": "recorded",
                    "transcript_status": "completed",
                    "assemblyai_transcript_id": "assembly-id",
                    "transcript_started_at_ms": 3_000
                }
            ]),
        );
        let transcript_path = meetings_dir.join("meeting-1").join("transcript.json");
        write_json(
            &transcript_path,
            json!({
                "utterances": [
                    {
                        "speaker": "A",
                        "text": "hello",
                        "start_ms": 0,
                        "end_ms": 900,
                        "confidence": 0.98
                    }
                ],
                "text": "hello",
                "audio_duration_secs": 0.9,
                "language_code": "en",
                "provider": "assemblyai",
                "created_at_ms": 6_000
            }),
        );

        let conn = open_test_database(&db_path, &app_dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        assert_eq!(history_count(&conn).unwrap(), 1);
        assert_eq!(meeting_count(&conn).unwrap(), 1);
        assert!(migrated_transcript_json(&conn, "meeting-1")
            .unwrap()
            .unwrap()
            .contains("\"provider\": \"assemblyai\""));
        drop(conn);

        let conn = open_test_database(&db_path, &app_dir).unwrap();
        assert_eq!(history_count(&conn).unwrap(), 1);
        assert_eq!(meeting_count(&conn).unwrap(), 1);
        assert!(history_path.exists());
        assert!(transcript_path.exists());
        drop(conn);

        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn meeting_status_processing_round_trips() {
        assert_eq!(meeting_status_to_str(&MeetingStatus::Processing), "processing");
        assert!(matches!(
            meeting_status_from_str("processing"),
            Some(MeetingStatus::Processing)
        ));
    }
}
