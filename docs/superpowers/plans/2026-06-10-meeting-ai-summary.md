# AI Meeting Summary (GPT-OSS-120B on Groq) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user generate a structured AI summary (Markdown) of a completed meeting transcript using `openai/gpt-oss-120b` on Groq, persisted to the existing `meeting_summaries` SQLite table and rendered in the Summary tab.

**Architecture:** A new `src-tauri/src/meeting/summarize.rs` module (mirrors `transcribe.rs` structure, reuses the `format_text.rs` chat-completions pattern) is driven by an awaited `generate_meeting_summary` Tauri command guarded by a per-meeting in-flight lock. The command loads the meeting via `state.meeting_manager.get(&id)` (which reconciles with live recording IDs — do NOT call `storage::get_detail_reconciled` with an empty set, that would mark in-flight recordings as orphaned). The frontend rewrites the placeholder `SummaryPanel` to call the command and render sanitized Markdown via `marked` + `DOMPurify`.

**Tech Stack:** Rust (Tauri v2, reqwest, rusqlite, serde), SolidJS + TypeScript, Tailwind v4, marked, dompurify.

**Spec:** `docs/superpowers/specs/2026-06-10-meeting-ai-summary-design.md` (deviations called out inline below).

---

## Build & test commands (environment-specific — read first)

This worktree lives on the WSL filesystem; the repo targets Windows. Verified working setup:

- **Rust tests/check** (Windows cargo.exe + shared warm target cache, run from `src-tauri/`):
  ```bash
  cd src-tauri && WSLENV=CARGO_TARGET_DIR/p CARGO_TARGET_DIR=/mnt/c/Users/user/Documents/work/dikt/src-tauri/target /mnt/c/Users/user/.cargo/bin/cargo.exe test
  ```
  (`cargo.exe check` for compile-only. Warm cache ≈ seconds, not minutes.)
- **Frontend** (WSL node, from repo root): `npx tsc --noEmit` for typecheck; `npm run build` for the vite build (vite does NOT typecheck). `npm install` already done.
- Conventional commits; do not push — semantic-release runs on main.

## Known spec deviations (intentional)

1. **`run()` does not load from storage.** Spec §4.1 says `run()` calls `storage::get_detail_reconciled(&id, None)` — that signature is stale; the real one takes `&HashSet<String>` of live IDs, and an empty set corrupts active recordings. Instead the **command** loads via `state.meeting_manager.get(&id)` and passes the `MeetingDetail` into `run()`.
2. **`resolve_groq_key` lives in `summarize.rs`**, not `commands.rs` (spec §10 put it there, §4.3 showed it standalone). All summary logic + its tests stay in one module.
3. **The `json` DB column stores the full serialized `MeetingSummary`** (not a partial blob reassembled from columns). `created_at_ms`/`provider` columns are still filled (the table requires `created_at_ms NOT NULL`). Load = parse the blob; no reassembly logic to get wrong. Matches how `meeting_transcripts.json` works.
4. **Line numbers updated** to the current codebase (spec was written against 1.21.0; we're on 1.22.0): `SummaryPanel` is at `MeetingsPage.tsx:859`, summary tab button at `:682`, panel call site at `:719`.

---

### Task 0: Commit the spec + this plan

**Files:**
- Add: `docs/superpowers/specs/2026-06-10-meeting-ai-summary-design.md` (already copied into the worktree)
- Add: `docs/superpowers/plans/2026-06-10-meeting-ai-summary.md` (this file)

- [ ] **Step 0.1: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-meeting-ai-summary-design.md docs/superpowers/plans/2026-06-10-meeting-ai-summary.md
git commit -m "docs(plans): add AI meeting summary design spec and implementation plan"
```

---

### Task 1: Backend types — `MeetingSummary` + `MeetingDetail.summary`

**Files:**
- Modify: `src-tauri/src/meeting/types.rs` (after `MeetingDetail`, around line 51)
- Modify: `src-tauri/src/meeting/storage.rs:191-195` (`get_detail_reconciled` constructs `MeetingDetail` — must gain the new field to compile)
- Modify: `src-tauri/src/meeting/mod.rs` (re-export)

- [ ] **Step 1.1: Add the `MeetingSummary` struct and `summary` field**

In `src-tauri/src/meeting/types.rs`, add `summary` to `MeetingDetail` (keeping the same serde attrs as `transcript`) and the new struct below it:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingDetail {
    pub meta: MeetingMeta,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<MeetingTranscript>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<MeetingSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingSummary {
    pub markdown: String,
    pub model: String,
    pub provider: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_created_at_ms: Option<i64>,
}
```

(`PartialEq` is for test assertions.)

- [ ] **Step 1.2: Fix the `MeetingDetail` construction and re-export**

In `src-tauri/src/meeting/storage.rs` `get_detail_reconciled` (line ~191), add the field as a stub for now (Task 2 wires it to the DB):

```rust
    Ok(MeetingDetail {
        meta,
        source_path: source.to_string_lossy().to_string(),
        transcript: load_transcript(id).ok().flatten(),
        summary: None,
    })
```

In `src-tauri/src/meeting/mod.rs`, add `MeetingSummary` to the `pub use types::{...}` list.

- [ ] **Step 1.3: Verify it compiles**

Run (from `src-tauri/`): the cargo.exe check command from the header.
Expected: `Finished` with no errors.

- [ ] **Step 1.4: Commit**

```bash
git add src-tauri/src/meeting/types.rs src-tauri/src/meeting/storage.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): add MeetingSummary type to meeting detail"
```

---

### Task 2: Storage — `save_summary` / `load_summary` round-trip

**Files:**
- Modify: `src-tauri/src/meeting/storage.rs` (new functions after `load_transcript`, ~line 238; tests in the existing `mod tests`)

- [ ] **Step 2.1: Write the failing tests**

Append to `mod tests` in `storage.rs`. These hit the real (test-scoped temp) SQLite DB — `db::app_data_dir()` is pid-scoped under `#[cfg(test)]`, and unique UUIDs keep parallel tests independent. The FK `meeting_summaries.meeting_id REFERENCES meetings(id)` means the meeting row must exist first.

```rust
    use crate::meeting::types::MeetingSummary;

    fn sample_summary() -> MeetingSummary {
        MeetingSummary {
            markdown: "## Conversation Summary\nWe discussed the plan.".to_string(),
            model: "openai/gpt-oss-120b".to_string(),
            provider: "groq".to_string(),
            created_at_ms: 1_234,
            transcript_created_at_ms: Some(999),
        }
    }

    #[test]
    fn summary_round_trips_through_db_and_cascades_on_delete() {
        let id = format!("summary-rt-{}", uuid::Uuid::new_v4());
        upsert_meta(meta(&id, MeetingStatus::Recorded)).unwrap();

        let summary = sample_summary();
        save_summary(&id, &summary).unwrap();
        assert_eq!(load_summary(&id).unwrap().unwrap(), summary);

        // INSERT OR REPLACE overwrites on regenerate
        let regenerated = MeetingSummary {
            markdown: "## Conversation Summary\nSecond pass.".to_string(),
            created_at_ms: 5_678,
            ..sample_summary()
        };
        save_summary(&id, &regenerated).unwrap();
        assert_eq!(load_summary(&id).unwrap().unwrap(), regenerated);

        // deleting the meeting cascades to its summary
        delete_meeting(&id).unwrap();
        assert!(load_summary(&id).unwrap().is_none());
    }

    #[test]
    fn save_summary_requires_existing_meeting() {
        let id = format!("summary-missing-{}", uuid::Uuid::new_v4());
        let error = save_summary(&id, &sample_summary()).unwrap_err();
        assert!(error.contains("no longer exists"));
    }

    #[test]
    fn load_summary_returns_none_for_unknown_meeting() {
        let id = format!("summary-none-{}", uuid::Uuid::new_v4());
        assert!(load_summary(&id).unwrap().is_none());
    }
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: cargo.exe test (header command) with filter `summary`.
Expected: compile error — `save_summary`/`load_summary` not found. That's the red state.

- [ ] **Step 2.3: Implement `save_summary` / `load_summary` and wire `get_detail_reconciled`**

Add after `load_transcript` (mirrors `save_transcript`/`load_transcript`; import `MeetingSummary` in the `use crate::meeting::types::{...}` list at the top):

```rust
pub fn save_summary(id: &str, summary: &MeetingSummary) -> Result<(), String> {
    let _guard = STORAGE_LOCK
        .lock()
        .map_err(|_| "Meeting storage lock poisoned".to_string())?;
    if !meeting_exists(id)? {
        return Err("Meeting no longer exists.".to_string());
    }
    let contents = serde_json::to_string_pretty(summary).map_err(|e| e.to_string())?;
    crate::db::with_connection(|conn| {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO meeting_summaries (meeting_id, json, created_at_ms, provider)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![id, contents, summary.created_at_ms, &summary.provider],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to save meeting summary: {error}"))
    })
}

pub fn load_summary(id: &str) -> Result<Option<MeetingSummary>, String> {
    let contents = crate::db::with_connection(|conn| {
        conn.query_row(
            "SELECT json FROM meeting_summaries WHERE meeting_id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load meeting summary: {error}"))
    })?;
    contents.map_or(Ok(None), |contents| {
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| format!("Failed to parse meeting summary: {error}"))
    })
}
```

Then replace the Task 1 stub in `get_detail_reconciled`:

```rust
        summary: load_summary(id).ok().flatten(),
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: cargo.exe test with filter `summary`.
Expected: 3 passed.

- [ ] **Step 2.5: Commit**

```bash
git add src-tauri/src/meeting/storage.rs
git commit -m "feat(meeting): persist meeting summaries in sqlite"
```

---

### Task 3: `summarize.rs` — pure logic (key resolution, transcript text, size guard, response parsing, in-flight lock)

**Files:**
- Create: `src-tauri/src/meeting/summarize.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (`pub mod summarize;`)

- [ ] **Step 3.1: Create the module skeleton with constants + system prompt, write failing tests**

Create `src-tauri/src/meeting/summarize.rs`:

```rust
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;

use crate::meeting::storage;
use crate::meeting::types::{MeetingDetail, MeetingSummary, MeetingTranscript, TranscriptStatus};
use crate::settings::AppSettings;

const MODEL: &str = "openai/gpt-oss-120b";
const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMPLETION_TOKENS: u32 = 8_192;
const TEMPERATURE: f32 = 0.3;
// Safe input budget. gpt-oss-120b context = 131,072 tokens; reserve headroom for
// the system prompt + completion. ~4 chars/token heuristic.
const MAX_TRANSCRIPT_CHARS: usize = 360_000; // ≈ 90k tokens

const SUMMARY_SYSTEM_PROMPT: &str = r#"You are an expert meeting analyst. You will be given a meeting transcript with
speaker labels. In these transcripts, "You" is the local microphone speaker (the
person running this app) and "System" is the remote/other participants captured from
system audio; treat any other label as a distinct speaker. Output GitHub-Flavored
Markdown ONLY (no preamble, no code fences around the whole reply, no raw HTML).

Analyze the following meeting transcript and produce a structured summary using
exactly this format:

---

## Conversation Summary
Write 2-3 sentences describing who is speaking, what product/project is being
discussed, and the overall context of the conversation.

---

## Key Topics Discussed
List each major topic that came up in the meeting. For each topic:
- Give it a bold numbered title
- Write 2-3 sentences explaining what was discussed, what the problem was, and what
  decision or conclusion was reached (if any)

---

## 🚧 Blockers
Present a table with 3 columns:
| # | Blocker | Impact |
List only the things that are actively preventing progress. For each blocker, clearly
state what it is and what it is blocking downstream.

---

## ✅ Next Action Items
Present a table with 2 columns:
| Owner | Action |
Assign every action item to a specific person mentioned in the transcript. Be specific
and actionable — not vague. If a deadline or dependency was mentioned, include it in
the action description.

---

## Overall Assessment
Write 3-4 sentences giving a high-level verdict on where the project stands. Mention
what is going well, what the main risks are, and what the critical path looks like
going forward.
"#;

static IN_FLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
```

Then the test module at the bottom (write tests FIRST — the functions don't exist yet):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::types::Utterance;

    fn settings_with(provider: &str, api_key: &str, groq_map_key: Option<&str>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.provider = provider.to_string();
        settings.api_key = api_key.to_string();
        settings.provider_api_keys.clear();
        if let Some(key) = groq_map_key {
            settings
                .provider_api_keys
                .insert("groq".to_string(), key.to_string());
        }
        settings
    }

    fn transcript(utterances: Vec<Utterance>, text: &str) -> MeetingTranscript {
        MeetingTranscript {
            utterances,
            text: text.to_string(),
            audio_duration_secs: None,
            language_code: None,
            provider: "assemblyai".to_string(),
            created_at_ms: 0,
        }
    }

    fn utterance(speaker: &str, text: &str) -> Utterance {
        Utterance {
            speaker: speaker.to_string(),
            text: text.to_string(),
            start_ms: 0,
            end_ms: 1,
            confidence: None,
        }
    }

    #[test]
    fn resolve_groq_key_prefers_saved_groq_provider_key() {
        let settings = settings_with("openai", "openai-key", Some("groq-key"));
        assert_eq!(resolve_groq_key(&settings).unwrap(), "groq-key");
    }

    #[test]
    fn resolve_groq_key_falls_back_to_api_key_only_when_groq_is_active() {
        let settings = settings_with("groq", "active-groq-key", None);
        assert_eq!(resolve_groq_key(&settings).unwrap(), "active-groq-key");
    }

    #[test]
    fn resolve_groq_key_rejects_api_key_of_other_providers() {
        let settings = settings_with("openai", "openai-key", None);
        assert!(resolve_groq_key(&settings).is_err());
    }

    #[test]
    fn resolve_groq_key_rejects_blank_keys() {
        let settings = settings_with("groq", "   ", Some("  "));
        assert!(resolve_groq_key(&settings).is_err());
    }

    #[test]
    fn build_transcript_text_joins_speaker_labeled_utterances() {
        let transcript = transcript(
            vec![
                utterance("You", "Let's review the launch plan."),
                utterance("System", "The API is still blocked."),
            ],
            "raw fallback",
        );
        assert_eq!(
            build_transcript_text(&transcript),
            "You: Let's review the launch plan.\nSystem: The API is still blocked."
        );
    }

    #[test]
    fn build_transcript_text_falls_back_to_raw_text() {
        let transcript = transcript(vec![], "  plain transcript text  ");
        assert_eq!(build_transcript_text(&transcript), "plain transcript text");
    }

    #[test]
    fn check_transcript_len_rejects_oversized_transcripts() {
        let oversized = "a".repeat(MAX_TRANSCRIPT_CHARS + 1);
        let error = check_transcript_len(&oversized).unwrap_err();
        assert!(error.contains("too long"));
        assert!(check_transcript_len("short").is_ok());
    }

    #[test]
    fn parse_summary_content_extracts_markdown() {
        let body = r#"{"choices":[{"message":{"content":"## Conversation Summary\nHello"}}]}"#;
        assert_eq!(
            parse_summary_content(body).unwrap(),
            "## Conversation Summary\nHello"
        );
    }

    #[test]
    fn parse_summary_content_rejects_missing_or_empty_content() {
        assert!(parse_summary_content(r#"{"choices":[]}"#).is_err());
        assert!(parse_summary_content(r#"{"choices":[{"message":{"content":"  "}}]}"#).is_err());
        assert!(parse_summary_content("not json").is_err());
    }

    #[test]
    fn request_body_uses_locked_model_and_params() {
        let body = request_body("transcript text");
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "transcript text");
        assert_eq!(body["max_completion_tokens"], 8_192);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["include_reasoning"], false);
    }

    #[test]
    fn in_flight_guard_blocks_concurrent_generation_and_releases_on_drop() {
        let id = format!("guard-{}", uuid::Uuid::new_v4());
        let guard = acquire_in_flight(&id).unwrap();
        let error = acquire_in_flight(&id).unwrap_err();
        assert!(error.contains("already being generated"));
        drop(guard);
        assert!(acquire_in_flight(&id).is_ok());
    }
}
```

Add `pub mod summarize;` to `src-tauri/src/meeting/mod.rs`.

> Note: `impl Default for AppSettings` exists at `settings.rs:155` (defaults to `provider: "groq"`, empty keys) — the test helper overrides `provider`/`api_key`/`provider_api_keys` explicitly so defaults don't mask anything.

- [ ] **Step 3.2: Run tests to verify they fail**

Run: cargo.exe test with filter `summarize`.
Expected: compile errors — `resolve_groq_key` etc. not found.

- [ ] **Step 3.3: Implement the pure functions**

Add between the statics and the test module:

```rust
struct InFlightGuard {
    id: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = IN_FLIGHT.lock() {
            set.remove(&self.id);
        }
    }
}

fn acquire_in_flight(id: &str) -> Result<InFlightGuard, String> {
    let mut set = IN_FLIGHT
        .lock()
        .map_err(|_| "Summary state lock poisoned".to_string())?;
    if !set.insert(id.to_string()) {
        return Err("A summary is already being generated for this meeting.".to_string());
    }
    Ok(InFlightGuard { id: id.to_string() })
}

pub fn resolve_groq_key(settings: &AppSettings) -> Result<String, String> {
    if let Some(key) = settings
        .provider_api_keys
        .get("groq")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return Ok(key.to_string());
    }
    if settings.provider == "groq" {
        let key = settings.api_key.trim();
        if !key.is_empty() {
            return Ok(key.to_string());
        }
    }
    Err(
        "Add a Groq API key in Settings (switch the provider to Groq and save) to generate meeting summaries."
            .to_string(),
    )
}

fn build_transcript_text(transcript: &MeetingTranscript) -> String {
    if transcript.utterances.is_empty() {
        return transcript.text.trim().to_string();
    }
    transcript
        .utterances
        .iter()
        .map(|utterance| format!("{}: {}", utterance.speaker, utterance.text.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn check_transcript_len(text: &str) -> Result<(), String> {
    if text.len() > MAX_TRANSCRIPT_CHARS {
        return Err(
            "This transcript is too long to summarize in a single pass; chunked summarization is planned for a future update."
                .to_string(),
        );
    }
    Ok(())
}

fn request_body(transcript_text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": MODEL,
        "messages": [
            { "role": "system", "content": SUMMARY_SYSTEM_PROMPT },
            { "role": "user", "content": transcript_text }
        ],
        "temperature": TEMPERATURE,
        "max_completion_tokens": MAX_COMPLETION_TOKENS,
        "reasoning_effort": "low",
        "include_reasoning": false
    })
}

fn parse_summary_content(body: &str) -> Result<String, String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("Failed to parse Groq response: {error}"))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err("Groq response did not include summary content.".to_string());
    }
    Ok(content.to_string())
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: cargo.exe test with filter `summarize`.
Expected: 11 passed. (Compiler will warn about unused `storage`/`MeetingDetail`/`TranscriptStatus`/`REQUEST_TIMEOUT`/`GROQ_BASE_URL` items until Step 3.5 — fine, or add them in 3.5 instead.)

- [ ] **Step 3.5: Add the async `run()` entry point**

```rust
pub async fn run(
    groq_key: String,
    id: String,
    detail: MeetingDetail,
) -> Result<MeetingSummary, String> {
    let _guard = acquire_in_flight(&id)?;

    if !matches!(
        detail.meta.transcript_status,
        Some(TranscriptStatus::Completed)
    ) {
        return Err("Transcribe this meeting before generating a summary.".to_string());
    }
    let transcript = detail
        .transcript
        .as_ref()
        .ok_or_else(|| "This meeting's transcript could not be loaded.".to_string())?;
    let transcript_text = build_transcript_text(transcript);
    if transcript_text.is_empty() {
        return Err("This meeting's transcript is empty.".to_string());
    }
    check_transcript_len(&transcript_text)?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let response = client
        .post(format!("{GROQ_BASE_URL}/chat/completions"))
        .bearer_auth(&groq_key)
        .json(&request_body(&transcript_text))
        .send()
        .await
        .map_err(|error| format!("Summary request failed: {error}"))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read summary response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Groq API error {status}: {response_body}"));
    }

    let summary = MeetingSummary {
        markdown: parse_summary_content(&response_body)?,
        model: MODEL.to_string(),
        provider: "groq".to_string(),
        created_at_ms: storage::now_ms()?,
        transcript_created_at_ms: Some(transcript.created_at_ms),
    };
    storage::save_summary(&id, &summary)?;
    Ok(summary)
}
```

Note: the guard is held across the await (RAII, releases on every path including panic/early return). `run()` does NOT emit `meetings-updated` — the command owns the single emit.

- [ ] **Step 3.6: Run the full meeting test suite**

Run: cargo.exe test with filter `meeting`.
Expected: all pass, no warnings about unused items.

- [ ] **Step 3.7: Commit**

```bash
git add src-tauri/src/meeting/summarize.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): add groq gpt-oss-120b summary generation module"
```

---

### Task 4: Command `generate_meeting_summary` + registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (after `transcribe_meeting`, ~line 258)
- Modify: `src-tauri/src/main.rs` (invoke_handler list, after `commands::transcribe_meeting`)

- [ ] **Step 4.1: Add the command**

In `commands.rs` (the snippet uses the fully-qualified `crate::meeting::types::MeetingSummary` path, so no new import is needed; `AppHandle`, `State`, `Emitter` are already there):

```rust
#[tauri::command]
pub async fn generate_meeting_summary(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::meeting::types::MeetingSummary, String> {
    let settings = state.manager.get_settings()?;
    let groq_key = crate::meeting::summarize::resolve_groq_key(&settings)?;
    let detail = state.meeting_manager.get(&id)?;
    let summary = crate::meeting::summarize::run(groq_key, id, detail).await?;
    let _ = app.emit("meetings-updated", ());
    Ok(summary)
}
```

(No meeting-consent re-check: consent governs recording; the transcript already exists. The in-flight lock lives inside `run()`.)

- [ ] **Step 4.2: Register it**

In `main.rs` invoke_handler, after `commands::transcribe_meeting,`:

```rust
            commands::generate_meeting_summary,
```

- [ ] **Step 4.3: Compile + full test suite**

Run: cargo.exe check, then cargo.exe test (no filter).
Expected: clean check; all tests pass (including pre-existing ones).

- [ ] **Step 4.4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(meeting): expose generate_meeting_summary command"
```

---

### Task 5: Frontend foundation — deps, types, markdown renderer

**Files:**
- Modify: `package.json` (+ lockfile, via npm)
- Modify: `src/types.ts` (after `MeetingTranscript`, ~line 106)
- Create: `src/lib/markdown.ts`

- [ ] **Step 5.1: Install deps**

```bash
npm install marked dompurify --no-audit --no-fund
```

Then check whether the installed DOMPurify ships its own types (v3 does): `ls node_modules/dompurify/dist/*.d.* node_modules/dompurify/types 2>/dev/null`. Only add `@types/dompurify` if there are none.

- [ ] **Step 5.2: Add frontend types**

In `src/types.ts`:

```ts
export type MeetingSummary = {
  markdown: string;
  model: string;
  provider: string;
  created_at_ms: number;
  transcript_created_at_ms?: number;
};
```

and in `MeetingDetail`:

```ts
export type MeetingDetail = {
  meta: MeetingMeta;
  source_path: string;
  transcript?: MeetingTranscript;
  summary?: MeetingSummary;
};
```

- [ ] **Step 5.3: Add `src/lib/markdown.ts`**

```ts
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
```

- [ ] **Step 5.4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5.5: Commit**

```bash
git add package.json package-lock.json src/types.ts src/lib/markdown.ts
git commit -m "feat(ui): add markdown rendering foundation for meeting summaries"
```

---

### Task 6: Frontend — SummaryPanel rewrite, tab gating, wiring

**Files:**
- Modify: `src/components/Settings/MeetingsPage.tsx` (props :28-44, summary tab button :682-693, call site :719, `SummaryPanel` :859-925)
- Modify: `src/SettingsApp.tsx` (signals near :64, `generateSummary` after `transcribeMeeting` :399, props at :847)
- Modify: `src/settings.css` (summary prose styles — NOT `style.css`, which is the transparent pill window's stylesheet; `main.tsx` imports `settings.css` for the settings window. Static rules only; this repo forbids layout-animating transitions/backdrop-filter, see MEMORY)

- [ ] **Step 6.1: Thread new props through `MeetingsPage`**

Add to `MeetingsPageProps`:

```ts
  onGenerateSummary: (id: string) => void;
  summaryGenerating: Accessor<Record<string, boolean>>;
  summaryErrors: Accessor<Record<string, string>>;
```

- [ ] **Step 6.2: Gate the Summary tab button (line ~682)**

Replace the summary tab `<button>` with (adds `disabled` + hint; keeps existing classes):

```tsx
                      <button
                        type="button"
                        onClick={() => setActiveTab('summary')}
                        disabled={meeting().meta.transcript_status !== 'completed'}
                        title={
                          meeting().meta.transcript_status === 'completed'
                            ? undefined
                            : 'Transcribe this meeting first'
                        }
                        class={`px-3 pb-2 border-b-2 text-[11px] font-mono uppercase tracking-wider flex items-center gap-2 transition-colors disabled:cursor-not-allowed disabled:text-zinc-700 ${
                          activeTab() === 'summary'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <Bot size={14} />
                        Summary
                      </button>
```

- [ ] **Step 6.3: Update the `SummaryPanel` call site (line ~719)**

```tsx
                    <Show
                      when={activeTab() === 'transcript'}
                      fallback={
                        <SummaryPanel
                          meeting={meeting()}
                          onGenerateSummary={props.onGenerateSummary}
                          generating={Boolean(props.summaryGenerating()[meeting().meta.id])}
                          error={props.summaryErrors()[meeting().meta.id] ?? null}
                        />
                      }
                    >
```

- [ ] **Step 6.4: Rewrite `SummaryPanel` (replace the entire function, :859-926 including the closing brace)**

Imports: add `renderMarkdown` from `../../lib/markdown` and `RefreshCcw` is already imported. `formatDate` is in-file.

```tsx
function SummaryPanel(props: {
  meeting: MeetingDetail;
  onGenerateSummary: (id: string) => void;
  generating: boolean;
  error: string | null;
}) {
  const hasTranscript = () =>
    props.meeting.meta.transcript_status === 'completed' && Boolean(props.meeting.transcript);
  const summary = () => props.meeting.summary;

  return (
    <div class="p-5 lg:p-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h3 class="text-sm font-semibold text-white">AI meeting summary</h3>
          <p class="mt-1 text-xs text-zinc-500">
            Generated with GPT-OSS-120B on Groq from the meeting transcript.
          </p>
        </div>
        <Show when={!summary()}>
          <button
            type="button"
            onClick={() => props.onGenerateSummary(props.meeting.meta.id)}
            disabled={!hasTranscript() || props.generating}
            class="px-4 py-2 border border-border-dark text-xs font-mono font-bold text-primary hover:bg-primary hover:text-black transition-colors disabled:text-zinc-600 disabled:hover:bg-transparent disabled:hover:text-zinc-600 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
          >
            <Show when={props.generating} fallback={<>Generate Summary</>}>
              <Loader2 size={14} class="animate-spin" />
              Generating…
            </Show>
          </button>
        </Show>
      </div>

      <Show when={props.error}>
        <div class="mb-5 border border-amber-400/20 bg-amber-500/10 p-4">
          <p class="text-sm font-medium text-amber-200">Summary generation failed</p>
          <p class="mt-1 text-xs text-amber-100/70 leading-relaxed">{props.error}</p>
        </div>
      </Show>

      <Show
        when={summary()}
        fallback={
          <Show
            when={hasTranscript()}
            fallback={
              <div class="border border-border-dark bg-[#111111] p-4 text-sm text-zinc-400">
                Transcribe this meeting first. The summary uses the transcript to extract key
                topics, blockers, and action items.
              </div>
            }
          >
            <Show when={props.generating}>
              <div class="border border-primary/20 bg-primary/10 p-4 flex items-center gap-3 text-primary">
                <Loader2 size={16} class="animate-spin" />
                <div>
                  <p class="text-sm font-medium">Generating summary…</p>
                  <p class="mt-1 text-xs text-primary/80">
                    GPT-OSS-120B is analyzing the transcript on Groq.
                  </p>
                </div>
              </div>
            </Show>
          </Show>
        }
      >
        {(current) => (
          <div>
            <div class="summary-prose" innerHTML={renderMarkdown(current().markdown)} />
            <div class="mt-6 pt-4 border-t border-border-dark flex flex-wrap items-center justify-between gap-3">
              <p class="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
                {current().model} · {formatDate(current().created_at_ms)}
              </p>
              <button
                type="button"
                onClick={() => props.onGenerateSummary(props.meeting.meta.id)}
                disabled={props.generating}
                class="px-3 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-zinc-500 hover:text-white hover:bg-surface-dark transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Show when={props.generating} fallback={<RefreshCcw size={13} />}>
                  <Loader2 size={13} class="animate-spin" />
                </Show>
                Regenerate
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
```

- [ ] **Step 6.5: Wire `SettingsApp.tsx`**

Import `MeetingSummary` in the existing type import. Signals next to the other meeting signals (~line 65):

```ts
  const [summaryGenerating, setSummaryGenerating] = createSignal<Record<string, boolean>>({});
  const [summaryErrors, setSummaryErrors] = createSignal<Record<string, string>>({});
```

Handler after `transcribeMeeting` (~line 400):

```ts
  const generateSummary = async (id: string) => {
    setSummaryErrors((current) => {
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
    setSummaryGenerating((current) => ({ ...current, [id]: true }));
    try {
      const summary = await invoke<MeetingSummary>('generate_meeting_summary', { id });
      setSelectedMeeting((current) => (current?.meta.id === id ? { ...current, summary } : current));
      notifySuccess('Meeting summary ready.');
    } catch (err) {
      const message = typeof err === 'string' ? err : 'Failed to generate meeting summary.';
      setSummaryErrors((current) => ({ ...current, [id]: message }));
      notifyError(err, 'Failed to generate meeting summary.');
    } finally {
      setSummaryGenerating((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    }
  };
```

Props at the `<MeetingsPage … />` render (~line 847):

```tsx
            onTranscribeMeeting={transcribeMeeting}
            onGenerateSummary={(id) => void generateSummary(id)}
            summaryGenerating={summaryGenerating}
            summaryErrors={summaryErrors}
```

(The command's `meetings-updated` emit additionally triggers `loadMeetings` → `loadMeetingDetail`, so the summary also survives reloads; the direct `setSelectedMeeting` just renders it instantly.)

- [ ] **Step 6.6: Add `.summary-prose` styles to `src/settings.css`**

Append before the `/* ═══ Light theme ═══ */` section. Use the existing `@theme` variables (`--color-primary`, `--color-border-dark`, `--color-surface-dark`, `--color-white`, `--font-mono`) so the light theme's variable overrides (settings.css:80-100) restyle the prose automatically. Body-text zinc hexes match what `MeetingsPage` components hardcode via `text-zinc-*` classes (the light theme does not remap zinc — consistent with the rest of the meetings page). Static rules only (no transitions, no backdrop-filter — repo constraint).

```css
/* AI meeting summary markdown (Meetings page) */
.summary-prose {
  font-size: 0.875rem;
  line-height: 1.65;
  color: #d4d4d8; /* zinc-300, as used across the meetings page */
}
.summary-prose h2 {
  margin: 1.25rem 0 0.5rem;
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-primary);
}
.summary-prose h2:first-child {
  margin-top: 0;
}
.summary-prose h3 {
  margin: 1rem 0 0.375rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-white);
}
.summary-prose p {
  margin: 0.5rem 0;
}
.summary-prose ul,
.summary-prose ol {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}
.summary-prose ul {
  list-style: disc;
}
.summary-prose ol {
  list-style: decimal;
}
.summary-prose li {
  margin: 0.25rem 0;
}
.summary-prose strong {
  color: var(--color-white);
}
.summary-prose hr {
  margin: 1rem 0;
  border: 0;
  border-top: 1px solid var(--color-border-dark);
}
.summary-prose table {
  width: 100%;
  margin: 0.75rem 0;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
.summary-prose th,
.summary-prose td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  vertical-align: top;
  border: 1px solid var(--color-border-dark);
}
.summary-prose th {
  background: var(--color-surface-dark);
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #a1a1aa; /* zinc-400 */
}
.summary-prose code {
  padding: 0.1rem 0.3rem;
  background: var(--color-surface-dark);
  border: 1px solid var(--color-border-dark);
  font-size: 0.8125rem;
}
```

`.light` overrides for the two hardcoded zinc text colors (append next to the other `.light` rules at the end of the file):

```css
.light .summary-prose {
  color: #3f3f46; /* zinc-700 */
}
.light .summary-prose th {
  color: #52525b; /* zinc-600 */
}
```

- [ ] **Step 6.7: Typecheck + build**

Run: `npx tsc --noEmit` then `npm run build`.
Expected: tsc clean; vite build succeeds.

- [ ] **Step 6.8: Commit**

```bash
git add src/components/Settings/MeetingsPage.tsx src/SettingsApp.tsx src/settings.css
git commit -m "feat(ui): generate and render AI meeting summaries"
```

---

### Task 7: Final verification

- [ ] **Step 7.1: Full Rust test suite** — cargo.exe test (no filter). Expected: everything green.
- [ ] **Step 7.2: `npx tsc --noEmit`** — clean.
- [ ] **Step 7.3: `npm run build`** — succeeds.
- [ ] **Step 7.4: Manual verification (needs Windows app run — user-driven)**: transcribed meeting → Summary tab enabled → Generate → markdown renders with tables; error path with no Groq key; Regenerate overwrites; summary persists after app restart. Note for the report: the live Groq call requires a real key — flag this as the one unverified path if not run.

---

## Out of scope (v1) — per spec §9

Chunked map-reduce for very long transcripts (v1.1; `transcript_created_at_ms` already stored for staleness detection), `summary_status` lifecycle states, user-editable prompt, non-Windows.
