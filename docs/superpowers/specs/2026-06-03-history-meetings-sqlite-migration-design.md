# Design: Migrate transcription history + meeting metadata to SQLite

**Date:** 2026-06-03
**Status:** Draft — under review (Codex review requested before implementation)
**App version at time of writing:** 1.19.1 (already in production, distributed via GitHub releases)

---

## 1. Context & problem

`dikt` is a Tauri v2 + SolidJS desktop dictation app, already shipping to users via GitHub releases.

Two stores currently use plain JSON files under `APPDATA/dikt/` (Windows) / `XDG_CONFIG_HOME|HOME/.config/dikt/`:

### a) Transcription (dictation) history — the driver for this work
- File: `transcription_history.json` — a single JSON array of `TranscriptionHistoryItem`.
- Code: `src-tauri/src/transcription_history.rs`.
- Current cap: `MAX_HISTORY_ITEMS = 10_000`.
- **Hot-path problem:** every dictation calls `append_item()`, which does a *full* load → parse → prepend → truncate → `to_string_pretty` → write of the **entire** file (`transcription_history.rs:110-132`). This is O(n) per dictation.
- **Frontend problem:** `get_transcription_history` returns the *entire* array; the frontend (`SettingsApp.tsx:193`) loads all items into memory, re-loads them after *every* dictation (`transcription-history-updated` listener, `SettingsApp.tsx:646`), and does search/pagination/stats **client-side** (`SettingsApp.tsx:376-430`, `HistoryPage.tsx`).
- Measured on the maintainer's device: file is at exactly 10,000 entries = 2.5 MB (~256 bytes/entry).

At the target of ~100k entries this becomes ~16-25 MB rewritten on every dictation + shipped over IPC repeatedly + filtered in JS on every keystroke. JSON storage is the wrong access pattern.

### b) Meeting metadata
- Code: `src-tauri/src/meeting/storage.rs`, types in `src-tauri/src/meeting/types.rs`.
- `meetings/index.json` — JSON array of `MeetingMeta` (the index).
- `meetings/<id>/transcript.json` — per-meeting `MeetingTranscript` (lazy-loaded).
- `meetings/<id>/recording.mp4` + `transcript-audio.m4a` — **binary media** (1.3 MB+ each).
- Meeting counts are tiny (a handful; hundreds-to-low-thousands lifetime). No scaling pressure. Included in this migration **only for storage-engine consistency**, not performance.

## 2. Decision summary (all confirmed with maintainer)

| Decision | Choice |
|---|---|
| Storage engine | **SQLite** via `rusqlite` with the **`bundled`** feature (compiles SQLite into the binary; no system dep; cross-platform). Not `tauri-plugin-sql` — we want typed Rust commands, not SQL exposed to JS. |
| DB file | Single **`dikt.db`** in the same config dir (sibling of the old JSON files). WAL mode, `foreign_keys=ON`. One shared `Lazy<Mutex<Connection>>`; synchronous queries (sub-ms; Tauri runs commands off the UI thread). |
| Scope | **History + meeting metadata** into `dikt.db`. **Media files (mp4/m4a) stay on the filesystem** — never stored as BLOBs. |
| History search | Plain SQL `LIKE '%q%'` over `text`/`original_text`/`mode_name` (matches current client-side semantics). FTS5 deferred. |
| History retention | **Unbounded** — no cap, no auto-delete. `MAX_HISTORY_ITEMS` removed. Inserts stay O(1). |
| Meeting media/paths | Unchanged. `meetings_dir()`, `meeting_dir()`, `source_path()`, `transcript_audio_path()`, `create_meeting_folder()` all stay. |

## 3. Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- replaces transcription_history.json
CREATE TABLE IF NOT EXISTS transcription_history (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    duration_secs REAL,
    language      TEXT,
    mode_name     TEXT,
    original_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at
    ON transcription_history(created_at_ms DESC);

-- replaces meetings/index.json
CREATE TABLE IF NOT EXISTS meetings (
    id                       TEXT PRIMARY KEY,
    title                    TEXT NOT NULL,
    started_at_ms            INTEGER NOT NULL,
    ended_at_ms              INTEGER,
    duration_secs            REAL,
    has_video                INTEGER NOT NULL,   -- 0/1
    has_mic                  INTEGER NOT NULL,
    has_system_audio         INTEGER NOT NULL,
    file_size_bytes          INTEGER,
    status                   TEXT NOT NULL,      -- 'recording'|'recorded'|'error'
    transcript_status        TEXT,               -- 'pending'|'completed'|'error'|NULL
    transcript_error         TEXT,
    assemblyai_transcript_id TEXT,
    transcript_started_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meetings_started_at
    ON meetings(started_at_ms DESC);

-- replaces each meetings/<id>/transcript.json (lazy-loaded; kept separate so listing meetings stays light)
CREATE TABLE IF NOT EXISTS meeting_transcripts (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    json       TEXT NOT NULL   -- serialized MeetingTranscript (utterances + text + metadata)
);
```

`MeetingTranscript` is stored as a JSON text blob deliberately: it is always loaded whole for one meeting, never queried across meetings, so normalizing `utterances` into rows is pure overhead.

## 4. Migration (one-time, JSON → SQLite)

Guarded by `PRAGMA user_version`. Runs eagerly at startup via `db::init()` from `main.rs` setup (so failures surface at boot, not mid-dictation).

**Ordering (crash-safe):**
1. Open/create `dikt.db`; create all tables (idempotent `IF NOT EXISTS`).
2. If `user_version == 0`:
   a. `BEGIN TRANSACTION`
   b. If `transcription_history.json` exists & parses → insert all rows.
   c. If `meetings/index.json` exists & parses → insert all meeting rows; for each meeting, if `meetings/<id>/transcript.json` exists & parses → insert into `meeting_transcripts`.
   d. `PRAGMA user_version = 1` (transactional in SQLite — rolls back with the txn).
   e. `COMMIT`
3. **After commit**, best-effort rename each imported JSON to `*.migrated` (backup; never deleted). Rename failure is non-fatal (re-run sees `user_version=1` and skips import; leftover JSON is ignored).

**Idempotency / crash safety:**
- Crash *before* COMMIT → `user_version` stays 0, rows rolled back, JSON untouched → clean retry next launch.
- Crash *after* COMMIT, before rename → `user_version=1`, import skipped on retry; JSON remains but is ignored (harmless backup).
- Fresh install (no JSON) → empty tables, `user_version=1`. New users unaffected.

## 5. Backend command API (history → server-side)

```rust
struct HistoryPage { items: Vec<TranscriptionHistoryItem>, total: i64 }
```

| Command | Signature | Change |
|---|---|---|
| `get_transcription_history` | `(offset: u32, limit: u32, query: Option<String>) -> HistoryPage` | **Changed** (was `() -> Vec<…>`). Page + total match count. `WHERE text LIKE ?1 OR original_text LIKE ?1 OR mode_name LIKE ?1`, `ORDER BY created_at_ms DESC LIMIT ?limit OFFSET ?offset`. |
| `get_transcription_history_stats` | `(today_start_ms: i64, week_start_ms: i64) -> HistoryStats` | **New.** SQL aggregates (`COUNT`, conditional counts, `MAX`, `SUM`/`AVG(duration_secs)`). Timezone boundaries computed in frontend (as today). |
| `delete_transcription_history_item` | `(id) -> ()` | Same signature; `DELETE WHERE id=?`. |
| `clear_transcription_history` | `() -> ()` | Same signature; `DELETE FROM transcription_history`. |
| `append_item` *(internal, from `manager.rs:186`)* | `(params) -> ()` | Same signature; single `INSERT`, no cap trim. |

Meeting commands (`list_meetings`, `get_meeting`, `delete_meeting`) **keep identical signatures** — only storage internals change.

## 6. Frontend changes (History page ONLY)

Because meeting command contracts are unchanged, the **entire meetings frontend is untouched**. Only the History wiring changes:
- Page-shaped state: `historyItems` (≤50), `historyTotal`, `historyPage`, debounced `historySearchQuery`, `historyStats`.
- Search → debounced (~250ms), resets to page 1, server-side. Drop `filteredHistory` client memo.
- Pagination → `totalPages = ceil(total/50)`; `onPageChange` refetches. `HistoryPage.tsx` receives the current page instead of slicing all; `Pagination`/`buildPageNumbers`/`groupByDate` stay (grouping runs on the 50-row page, which is contiguous in time).
- Stats → `get_transcription_history_stats` (refreshed on tab open, after delete/clear, on `transcription-history-updated`).
- `transcription-history-updated` listener → refetch current 50-row page + stats instead of reloading everything. **Biggest runtime win.**
- delete/clear → command then refetch current page + stats.

## 7. Module structure

- **New `src-tauri/src/db.rs`** — owns the shared `Lazy<Mutex<Connection>>`, schema creation, and the `user_version`-guarded migration for both history and meetings. Eager `db::init()` in `main.rs` setup.
- **`transcription_history.rs`** — rewritten onto the shared connection; keeps `TranscriptionHistoryItem`, `AppendItemParams`, `record_runtime_error`/`take_runtime_error`.
- **`meeting/storage.rs`** — index + transcript reads/writes swap JSON↔SQL; **path helpers and the reconcile functions (`reconcile_orphaned_recordings`, `reconcile_stale_pending_transcripts`) stay** (reconcile still operates on an in-memory `Vec`, written back transactionally; meeting counts are tiny).

## 8. Error handling
- Boot migration/open failure → logged; app continues (dictation still works; history/meetings may appear empty); surfaced via existing `transcription-history-error` event.
- `append` failure during dictation already routes through `record_runtime_error` + the error event → **a save failure never breaks the returned dictation text.** Preserved.
- Migration + clear in transactions. Mutex poisoning → error string (as today).

## 9. Testing
- Backend unit tests (temp-dir DB for migration, `:memory:` for query logic), mirroring existing style in `transcription_history.rs`:
  - history: append, paginated fetch, LIKE search across all 3 columns, delete, clear, stats aggregation, DESC ordering.
  - meetings: upsert/update/load, reconcile (keep existing pure-fn tests green), transcript save/load, `ON DELETE CASCADE`.
  - migration: seed temp `transcription_history.json` + `meetings/index.json` + a `transcript.json` → `init()` → assert rows imported, `*.migrated` backups created, `user_version=1`, **re-run is a no-op**.
- Build cost: `rusqlite` `bundled` adds ~10-20s to a *clean* build (negligible incremental).

---

## 10. KEY REVIEW QUESTION — production upgrade behavior

**The app is already in production.** Users will download a new release from GitHub and run it over their existing `APPDATA/dikt/` data. Expected behavior on first launch of the new version:

1. `dikt.db` doesn't exist → created; `user_version=0` → migration runs.
2. Existing `transcription_history.json` (up to 10k entries) imported → renamed `.migrated`.
3. Existing `meetings/index.json` + each `transcript.json` imported → renamed `.migrated`.
4. `user_version=1`. User sees all history + meetings intact. Media files untouched.

### Known edge cases / risks (please scrutinize):
- **Downgrade:** if a user upgrades (JSON → `.migrated`, data now in `dikt.db`) then **downgrades** to an old release, the old code looks for `transcription_history.json` (now `.migrated`) → sees empty history and starts a fresh JSON. Re-upgrading won't re-import (`user_version=1`), so dictations made during the downgrade window live only in the new JSON and are invisible in the DB. Accepted as a rare edge case? Or should we copy-instead-of-rename / dual-write for one release?
- **Corrupt existing JSON:** current production `load_history` returns `Err` on malformed JSON. During migration, should a parse failure (a) abort & retry next boot (stuck if permanently corrupt), (b) skip + mark migrated + preserve as `.corrupt`, or (c) something else?
- **Atomicity of `PRAGMA user_version` inside the txn** — confirm it truly rolls back with the transaction on this `rusqlite`/SQLite version.
- **Windows file locking / antivirus** interfering with WAL files or the `.migrated` rename.
- **No down-migration path** (`user_version` only increments). Acceptable for now?

---

## REVIEW ASKS FOR CODEX

You have the full repo at `/mnt/c/Users/user/Documents/work/dikt`. Please review against the actual code. Specifically:

1. **Production upgrade safety** — is the migration ordering in §4 genuinely crash-safe and idempotent for users upgrading from 1.19.1? Any data-loss window? Is renaming the JSON the right call vs. keeping it? How should the downgrade and corrupt-JSON cases be handled?
2. **Plan soundness** — is SQLite + the schema in §3 appropriate? Anything wrong with the unified `dikt.db`, WAL, single mutexed connection, or storing `MeetingTranscript` as a JSON blob?
3. **Implementation approach** — is the module split (§7) and the `manager.rs:186` / command integration correct given how the code is actually structured? Any concurrency issue with one shared `Lazy<Mutex<Connection>>` across the dictation hot path + UI commands + the meeting recorder threads?
4. **Frontend contract change** — `get_transcription_history` changing signature (§5/§6): anything that breaks beyond the History page?
5. **Anything missing or risky** we haven't considered — especially anything that could corrupt or lose a production user's existing history/meetings on upgrade.

Please be specific and cite files/lines where relevant. Flag anything you'd block on before implementation.
