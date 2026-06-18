use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

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
    /// Set when the user manually edits the transcription; doubles as the
    /// "was edited" flag and the timestamp of the edit. `None` for untouched items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryPage {
    pub items: Vec<TranscriptionHistoryItem>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryStats {
    pub total_count: i64,
    pub today_count: i64,
    pub today_audio_secs: f64,
    pub total_audio_secs: f64,
}

pub struct AppendItemParams {
    pub text: String,
    pub duration_secs: Option<f64>,
    pub language: Option<String>,
    pub mode_name: Option<String>,
    pub original_text: Option<String>,
}

fn set_last_error(message: String) {
    if let Ok(mut guard) = LAST_HISTORY_ERROR.lock() {
        *guard = Some(message);
    }
}

pub fn load_history_page(
    offset: u32,
    limit: u32,
    query: Option<String>,
) -> Result<HistoryPage, String> {
    let limit = limit.clamp(1, 500) as i64;
    let offset = offset as i64;
    let query = query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    crate::db::with_connection(|conn| {
        let (items, total) = if let Some(query) = query {
            let pattern = format!("%{query}%");
            let total = conn
                .query_row(
                    r#"
                    SELECT COUNT(*)
                    FROM transcription_history
                    WHERE text LIKE ?1 OR original_text LIKE ?1 OR mode_name LIKE ?1
                    "#,
                    params![pattern],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Failed to count transcription history: {error}"))?;

            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, text, created_at_ms, duration_secs, language, mode_name, original_text, edited_at_ms
                    FROM transcription_history
                    WHERE text LIKE ?1 OR original_text LIKE ?1 OR mode_name LIKE ?1
                    ORDER BY created_at_ms DESC
                    LIMIT ?2 OFFSET ?3
                    "#,
                )
                .map_err(|error| format!("Failed to query transcription history: {error}"))?;
            let items = stmt
                .query_map(params![pattern, limit, offset], history_item_from_row)
                .map_err(|error| format!("Failed to query transcription history: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read transcription history row: {error}"))?;
            (items, total)
        } else {
            let total = conn
                .query_row("SELECT COUNT(*) FROM transcription_history", [], |row| {
                    row.get(0)
                })
                .map_err(|error| format!("Failed to count transcription history: {error}"))?;

            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT id, text, created_at_ms, duration_secs, language, mode_name, original_text, edited_at_ms
                    FROM transcription_history
                    ORDER BY created_at_ms DESC
                    LIMIT ?1 OFFSET ?2
                    "#,
                )
                .map_err(|error| format!("Failed to query transcription history: {error}"))?;
            let items = stmt
                .query_map(params![limit, offset], history_item_from_row)
                .map_err(|error| format!("Failed to query transcription history: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read transcription history row: {error}"))?;
            (items, total)
        };

        Ok(HistoryPage { items, total })
    })
}

pub fn history_stats(today_start_ms: i64) -> Result<HistoryStats, String> {
    crate::db::with_connection(|conn| {
        let total_count = conn
            .query_row("SELECT COUNT(*) FROM transcription_history", [], |row| {
                row.get(0)
            })
            .map_err(|error| format!("Failed to count transcription history: {error}"))?;
        let today_count = conn
            .query_row(
                "SELECT COUNT(*) FROM transcription_history WHERE created_at_ms >= ?1",
                params![today_start_ms],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to count today's transcription history: {error}"))?;
        let total_audio_secs = conn
            .query_row(
                "SELECT COALESCE(SUM(duration_secs), 0.0) FROM transcription_history",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to sum transcription audio duration: {error}"))?;
        let today_audio_secs = conn
            .query_row(
                "SELECT COALESCE(SUM(duration_secs), 0.0) FROM transcription_history WHERE created_at_ms >= ?1",
                params![today_start_ms],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to sum today's transcription audio duration: {error}"))?;

        Ok(HistoryStats {
            total_count,
            today_count,
            today_audio_secs,
            total_audio_secs,
        })
    })
}

pub fn append_item(params: AppendItemParams) -> Result<(), String> {
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
        edited_at_ms: None,
    };

    crate::db::with_connection(|conn| crate::db::insert_history_item(conn, &item))
}

/// Replaces the text of an existing history item with a manual edit.
///
/// Stamps `edited_at_ms` so the UI can show the entry was edited, and preserves
/// the original recognizer output in `original_text` the first time an item is
/// edited (`COALESCE(original_text, text)` keeps any pre-existing value, e.g. the
/// raw text saved when an AI mode reformatted the dictation). Returns the updated row.
pub fn update_item(id: &str, text: &str) -> Result<TranscriptionHistoryItem, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    crate::db::with_connection(|conn| update_item_in(conn, id, text, now_ms))
}

fn update_item_in(
    conn: &rusqlite::Connection,
    id: &str,
    text: &str,
    now_ms: i64,
) -> Result<TranscriptionHistoryItem, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Transcription text cannot be empty.".to_string());
    }

    let affected = conn
        .execute(
            r#"
            UPDATE transcription_history
            SET original_text = COALESCE(original_text, text),
                text = ?2,
                edited_at_ms = ?3
            WHERE id = ?1
            "#,
            params![id, text, now_ms],
        )
        .map_err(|error| format!("Failed to update transcription history item: {error}"))?;

    if affected == 0 {
        return Err(format!("Transcription history item '{id}' not found."));
    }

    conn.query_row(
        r#"
        SELECT id, text, created_at_ms, duration_secs, language, mode_name, original_text, edited_at_ms
        FROM transcription_history
        WHERE id = ?1
        "#,
        params![id],
        history_item_from_row,
    )
    .map_err(|error| format!("Failed to load updated transcription history item: {error}"))
}

pub fn delete_item(id: &str) -> Result<(), String> {
    crate::db::with_connection(|conn| {
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to delete transcription history item: {error}"))
    })
}

pub fn clear_history() -> Result<(), String> {
    crate::db::with_connection(|conn| {
        conn.execute("DELETE FROM transcription_history", [])
            .map(|_| ())
            .map_err(|error| format!("Failed to clear transcription history: {error}"))
    })
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

fn history_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptionHistoryItem> {
    Ok(TranscriptionHistoryItem {
        id: row.get("id")?,
        text: row.get("text")?,
        created_at_ms: row.get("created_at_ms")?,
        duration_secs: row.get("duration_secs")?,
        language: row.get("language")?,
        mode_name: row.get("mode_name")?,
        original_text: row.get("original_text")?,
        edited_at_ms: row.get("edited_at_ms")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use rusqlite::OptionalExtension;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE transcription_history (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                duration_secs REAL,
                language TEXT,
                mode_name TEXT,
                original_text TEXT,
                edited_at_ms INTEGER
            );
            CREATE INDEX idx_history_created_at ON transcription_history(created_at_ms DESC);
            "#,
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, text: &str, created_at_ms: i64) {
        crate::db::insert_history_item(
            conn,
            &TranscriptionHistoryItem {
                id: id.to_string(),
                text: text.to_string(),
                created_at_ms,
                duration_secs: Some(2.5),
                language: Some("en".to_string()),
                mode_name: Some("Clean Draft".to_string()),
                original_text: None,
                edited_at_ms: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn insert_and_query_history_rows() {
        let conn = test_conn();
        insert(&conn, "old", "older", 1);
        insert(&conn, "new", "newer", 2);

        let mut stmt = conn
            .prepare(
                "SELECT id, text, created_at_ms, duration_secs, language, mode_name, original_text, edited_at_ms FROM transcription_history ORDER BY created_at_ms DESC",
            )
            .unwrap();
        let rows = stmt
            .query_map([], history_item_from_row)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "new");
        assert_eq!(rows[1].id, "old");
    }

    #[test]
    fn delete_by_id_removes_only_matching_row() {
        let conn = test_conn();
        insert(&conn, "a", "one", 1);
        insert(&conn, "b", "two", 2);

        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params!["a"],
        )
        .unwrap();
        let remaining: Option<String> = conn
            .query_row(
                "SELECT id FROM transcription_history ORDER BY created_at_ms DESC",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(remaining.as_deref(), Some("b"));
    }

    #[test]
    fn editing_preserves_first_original_text_and_stamps_edited_at() {
        let conn = test_conn();
        // `insert` stores original_text = None, so `text` is the raw recognizer output.
        insert(&conn, "a", "raw transcription", 1);

        let first = update_item_in(&conn, "a", "  first edit  ", 100).unwrap();
        assert_eq!(first.text, "first edit", "edited text is trimmed and saved");
        assert_eq!(
            first.original_text.as_deref(),
            Some("raw transcription"),
            "raw recognizer output is preserved into original_text on first edit"
        );
        assert_eq!(first.edited_at_ms, Some(100));

        let second = update_item_in(&conn, "a", "second edit", 200).unwrap();
        assert_eq!(second.text, "second edit");
        assert_eq!(
            second.original_text.as_deref(),
            Some("raw transcription"),
            "the preserved original is never overwritten by later edits"
        );
        assert_eq!(second.edited_at_ms, Some(200));
    }

    #[test]
    fn editing_missing_item_is_an_error() {
        let conn = test_conn();
        assert!(update_item_in(&conn, "missing", "text", 1).is_err());
    }

    #[test]
    fn editing_to_empty_text_is_rejected() {
        let conn = test_conn();
        insert(&conn, "a", "raw transcription", 1);
        assert!(update_item_in(&conn, "a", "   ", 100).is_err());
        // The original row is left untouched.
        let text: String = conn
            .query_row(
                "SELECT text FROM transcription_history WHERE id = ?1",
                params!["a"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "raw transcription");
    }

    #[test]
    fn clear_removes_all_rows() {
        let conn = test_conn();
        insert(&conn, "a", "one", 1);
        conn.execute("DELETE FROM transcription_history", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transcription_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
