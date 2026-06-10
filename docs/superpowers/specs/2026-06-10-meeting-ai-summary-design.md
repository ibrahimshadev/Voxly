# Design: AI meeting summary (GPT-OSS-120B on Groq)

**Date:** 2026-06-10
**Status:** Draft — codex-reviewed (gpt-5.5 high, against the live codebase + Groq docs); awaiting maintainer sign-off before the implementation plan.
**App version at time of writing:** 1.21.0 (in production, distributed via GitHub releases)

---

## 1. Context & problem

`dikt` already records meetings (`src-tauri/src/meeting/`, Windows-only, FFmpeg + WASAPI) and transcribes them via **AssemblyAI** (`src-tauri/src/meeting/transcribe.rs`), persisting utterances + text to the SQLite table `meeting_transcripts`.

The **summary tab is a non-functional placeholder**: `SummaryPanel` in `src/components/Settings/MeetingsPage.tsx:818` renders four hardcoded cards and a "Generate Summary" button **with no `onClick`**. The DB table `meeting_summaries (meeting_id PK, json, created_at_ms, provider)` exists (`src-tauri/src/db.rs:130`) but nothing reads or writes it.

**Goal:** after a transcript exists, let the user generate a structured AI summary using **GPT-OSS-120B on Groq** (`openai/gpt-oss-120b`), reusing the existing OpenAI-compatible chat pattern (`src-tauri/src/format_text.rs`). Output is a fixed Markdown structure (Conversation Summary, Key Topics, Blockers table, Next Action Items table, Overall Assessment).

This is **additive** — recording and AssemblyAI transcription are untouched.

## 2. Decision summary

Locked by the maintainer, then hardened per the codex review.

| Decision | Choice |
|---|---|
| Trigger | **Manual** "Generate Summary" button, enabled only once the transcript is completed. Not auto-on-transcription. |
| Model | **`openai/gpt-oss-120b`** on Groq, hardcoded ("internally"); not user-selectable. |
| Storage / render | Store & render **raw Markdown** (not structured JSON). Render with `marked` + `DOMPurify`. |
| API key | **Reuse the saved Groq provider key** `provider_api_keys["groq"]`; fall back to `api_key` **only** when active `provider == "groq"`. No new dedicated key field. |
| Command shape | **Awaited** command (`generate_meeting_summary`) returning the summary — not fire-and-forget. Protected by a **backend per-meeting in-flight lock**. |
| Lifecycle state | **No `summary_status` on meeting meta for v1** — avoids a schema migration (`SCHEMA_VERSION` stays `1`). Presence of a `meeting_summaries` row = summary exists. |
| Long transcripts | **No silent truncation.** Send the full transcript (131K context fits ~any real meeting); if it exceeds a safe budget, return a clear error. Chunked map-reduce **deferred to v1.1**. |
| Schema | **No DB schema change** — reuse the existing `meeting_summaries` table; extra fields ride in its `json` blob. |

### Why these (codex review highlights)
- **Awaited, not background:** summary generation is retryable, has no external job id (unlike AssemblyAI), and the settings window is *hidden, not destroyed* on close, so an in-flight `await` survives. A persisted `summary_status` would force a migration + reconciliation + meeting-list UI states for little v1 benefit.
- **Backend in-flight lock:** frontend button-disable is not enough — multiple events/windows or fast clicks can race two Groq calls and double-writes.
- **Key resolution guard:** `api_key` mirrors the *active* provider (`settings.rs:259`/`:288`). Falling back to it while OpenAI/custom is active would send the wrong key to Groq. Only use it when `provider == "groq"`.
- **`marked` is only a transitive dep today** — relying on `node_modules` without declaring it in `package.json` is a reproducibility bug.
- **No silent truncation:** blind capping biases the summary toward the meeting's start and drops late action items.

## 3. Architecture & data flow

```
User clicks "Generate Summary"  (button enabled only when transcript_status == completed)
  → invoke("generate_meeting_summary", { id })
  → [Rust] resolve Groq key
          → acquire per-id in-flight guard (reject if already running)
          → load meeting meta (require Completed) + transcript (require loadable, non-empty)
          → build speaker-labeled transcript text
          → POST https://api.groq.com/openai/v1/chat/completions  (model openai/gpt-oss-120b)
          → extract choices[0].message.content (Markdown)
          → save to meeting_summaries  → emit "meetings-updated"
          → return MeetingSummary
  → [UI] render Markdown via marked + DOMPurify
```

The existing `meetings-updated` listener (`src/SettingsApp.tsx:659`) already reloads `get_meeting` for the selected meeting, so the panel refreshes through plumbing that already exists. The awaited return value lets the UI render immediately without waiting for the reload round-trip.

## 4. Backend design

### 4.1 New module `src-tauri/src/meeting/summarize.rs`

Mirrors the structure of `meeting/transcribe.rs`.

Constants:
```rust
const MODEL: &str = "openai/gpt-oss-120b";
const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMPLETION_TOKENS: u32 = 8_192;
const TEMPERATURE: f32 = 0.3;
// Safe input budget. gpt-oss-120b context = 131,072 tokens; reserve headroom for
// the system prompt + completion. ~4 chars/token heuristic.
const MAX_TRANSCRIPT_CHARS: usize = 360_000; // ≈ 90k tokens
```

`SUMMARY_SYSTEM_PROMPT` (hardcoded, verbatim from the maintainer, with a markdown-only + speaker-framing preamble):

```
You are an expert meeting analyst. You will be given a meeting transcript with
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
```

Request body (Groq-specific params from the codex review):
```jsonc
{
  "model": "openai/gpt-oss-120b",
  "messages": [
    { "role": "system", "content": <SUMMARY_SYSTEM_PROMPT> },
    { "role": "user",   "content": <speaker-labeled transcript> }
  ],
  "temperature": 0.3,
  "max_completion_tokens": 8192,
  "reasoning_effort": "low",   // gpt-oss supports low|medium|high
  "include_reasoning": false   // gpt-oss returns reasoning in a separate field by default
}
```
Response parsing reuses the `format_text.rs` shape: read `choices[0].message.content`; error if missing/empty.

Public entry point:
```rust
pub async fn run(app: AppHandle, groq_key: String, id: String) -> Result<MeetingSummary, String>
```
Steps: load meta + transcript in one call via `storage::get_detail_reconciled(&id, None)`; require `meta.transcript_status == Completed` **and** a `Some`, non-empty transcript (not status alone); `build_transcript_text`; enforce `MAX_TRANSCRIPT_CHARS` (clear error if exceeded); POST; parse; `storage::save_summary`; return. **`run()` does not emit** `meetings-updated` — the command (§4.4) owns that single emit, to avoid a redundant double reload.

`build_transcript_text(&MeetingTranscript) -> String`: if `utterances` non-empty, join `format!("{speaker}: {text}")` lines; otherwise fall back to `transcript.text`. Label reality: multichannel mic+system recordings yield `You`/`System` (`transcribe.rs:461-465,498`), but single-channel **diarized** transcripts keep AssemblyAI's raw labels (`A`, `B`, …). Both are fine — the system prompt's "treat any other label as a distinct speaker" + the `You`/`System` framing covers it; the model infers real names from content where mentioned.

### 4.2 In-flight lock

A module-level guard prevents concurrent generation for the same meeting:
```rust
static IN_FLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
// RAII guard inserts id on acquire, removes on Drop (covers early returns + panics).
```
If the id is already present → `Err("A summary is already being generated for this meeting.")`.

### 4.3 Key resolution
```rust
fn resolve_groq_key(settings: &AppSettings) -> Result<String, String> {
    if let Some(k) = settings.provider_api_keys.get("groq")
        .map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Ok(k.to_string());
    }
    if settings.provider == "groq" {
        let k = settings.api_key.trim();
        if !k.is_empty() { return Ok(k.to_string()); }
    }
    Err("Add a Groq API key in Settings (switch the provider to Groq and save) \
         to generate meeting summaries.".to_string())
}
```

### 4.4 Command — `src-tauri/src/commands.rs`
```rust
#[tauri::command]
pub async fn generate_meeting_summary(
    id: String, app: AppHandle, state: State<'_, AppState>,
) -> Result<MeetingSummary, String>
```
- `settings = state.manager.get_settings()?`
- `groq_key = resolve_groq_key(&settings)?`
- `summary = meeting::summarize::run(app.clone(), groq_key, id).await?` (acquires the in-flight guard internally)
- `let _ = app.emit("meetings-updated", ());`
- return `summary`

Registered in `src-tauri/src/main.rs`'s `invoke_handler`. (No meeting-consent re-check: consent governs *recording*; the transcript already exists.)

## 5. Data model & storage

### 5.1 Types — `src-tauri/src/meeting/types.rs`
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSummary {
    pub markdown: String,
    pub model: String,
    pub provider: String,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_created_at_ms: Option<i64>, // forward-compat: detect stale summaries later
}

// MeetingDetail gains a parallel field (keep the same serde attrs the existing
// `transcript` field uses at types.rs:48):
pub struct MeetingDetail {
    pub meta: MeetingMeta,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<MeetingTranscript>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<MeetingSummary>,   // NEW
}
```

### 5.2 Storage — `src-tauri/src/meeting/storage.rs`
- `save_summary(id, &MeetingSummary)`: `INSERT OR REPLACE INTO meeting_summaries (meeting_id, json, created_at_ms, provider)`. The `json` blob = `{ markdown, model, transcript_created_at_ms }`; `created_at_ms` and `provider` go in their columns. Guarded by the existing `STORAGE_LOCK`; require the meeting still exists.
- `load_summary(id) -> Option<MeetingSummary>`: read row, parse json, reassemble (json fields + `created_at_ms`/`provider` columns).
- `get_detail_reconciled(...)` adds `summary: load_summary(id).ok().flatten()` (exactly parallel to `transcript`).

**No schema migration** — table already exists; extra fields live in `json`.

## 6. Frontend design

### 6.1 Types — `src/types.ts`
Add `MeetingSummary` (`{ markdown; model; provider; created_at_ms; transcript_created_at_ms? }`) and `summary?: MeetingSummary | null` on `MeetingDetail`.

### 6.2 Markdown rendering — new `src/lib/markdown.ts`
```ts
import { marked } from 'marked';
import DOMPurify from 'dompurify';
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true }) as string);
}
```
Rendered via a single sanitized `innerHTML` into a styled prose container. GFM tables required for Blockers / Action Items. No raw HTML passes through.

### 6.3 `MeetingsPage.tsx`
- **Summary tab button** (`:643`): `disabled` unless `meeting.meta.transcript_status === 'completed'`; greyed with a tooltip/hint to transcribe first. Enables automatically once the transcript lands (detail reload).
- **`SummaryPanel` rewritten** — remove the four placeholder cards. New props: `meeting`, `onGenerateSummary(id)`, `generating: boolean`, `error: string | null`.
  - `meeting.summary` present → render `renderMarkdown(summary.markdown)` in the prose container; footer with model + generated time; a subtle **Regenerate** button (re-invokes; overwrites).
  - else, not generating → "Generate Summary" button → `onGenerateSummary(meeting.meta.id)`.
  - generating → reuse `LoadingDots` / spinner.
  - error → inline error block styled like the existing transcript-error UI.
- **Prop threading:** add `onGenerateSummary(id)`, `summaryGenerating` and `summaryError` accessors to `MeetingsPageProps`, thread them down to the `<SummaryPanel ... />` call site (`MeetingsPage.tsx:678`), which today is just `<SummaryPanel meeting={meeting()} />`.

### 6.4 `SettingsApp.tsx`
- `summaryGenerating` (per-id or boolean for the selected meeting) + `summaryError` signals.
- `generateSummary(id)`: set generating; `invoke<MeetingSummary>('generate_meeting_summary', { id })`; on success set `selectedMeeting.summary` (or `loadMeetingDetail(id)`); on failure set `summaryError`; clear generating. Wired into `MeetingsPage` like `onTranscribeMeeting`.

### 6.5 `package.json`
Add explicit deps: `marked`, `dompurify` (and `@types/dompurify` if the installed DOMPurify version doesn't ship its own types).

## 7. Error handling & edge cases

| Case | Behavior |
|---|---|
| No Groq key | Actionable error (see §4.3); button stays available, error shown inline. |
| Transcript missing / not completed | Button disabled; backend also guards on `Completed` + loadable, non-empty transcript (not status alone). |
| Groq API / network error | Returned to UI, shown inline, retryable. |
| Concurrent generation (same id) | Backend in-flight lock rejects the second call; frontend also disables the button while in-flight. |
| Re-generate | Overwrites the stored summary (`INSERT OR REPLACE`). |
| Transcript too long (> `MAX_TRANSCRIPT_CHARS`) | Clear error: "This transcript is too long to summarize in a single pass; chunked summarization is planned." (v1.1). No silent truncation. |
| Window hidden mid-generation | `await` survives (window is hidden, not destroyed); summary persists to DB and shows on next `get_meeting`. |

## 8. Testing

Rust unit tests (style follows `transcribe.rs` / `recorder.rs`):
- `build_transcript_text`: speaker-labeled join; fallback to `text` when no utterances.
- `resolve_groq_key`: groq-map hit; `provider == "groq"` fallback to `api_key`; **no** fallback when provider is openai/custom; empty → error.
- Summary response parsing: extract `choices[0].message.content`; missing/empty → error.
- `MAX_TRANSCRIPT_CHARS` guard returns the long-transcript error.
- `save_summary` / `load_summary` round-trip (json blob + column reassembly).

Frontend: manual verification (tab disabled→enabled on transcript; generate → render; error path; regenerate).

## 9. Out of scope (v1) / future

- **Chunked map-reduce** for very long transcripts (v1.1) — `transcript_created_at_ms` is already stored to support future staleness detection.
- **`summary_status` lifecycle** in meeting meta (background generation, reconciliation, meeting-list states) — would require a schema migration.
- **User-editable summary prompt / modes.**
- **Non-Windows** — meeting recording is Windows-only regardless.

## 10. File-by-file change list

**New**
- `src-tauri/src/meeting/summarize.rs` — generation logic, prompt, params, in-flight lock, key-agnostic `run`.
- `src/lib/markdown.ts` — `renderMarkdown` (marked + DOMPurify).

**Modified — Rust**
- `src-tauri/src/meeting/mod.rs` — `pub mod summarize;`, re-export `MeetingSummary`.
- `src-tauri/src/meeting/types.rs` — `MeetingSummary`; `summary` field on `MeetingDetail`.
- `src-tauri/src/meeting/storage.rs` — `save_summary` / `load_summary`; include `summary` in `get_detail_reconciled`.
- `src-tauri/src/commands.rs` — `generate_meeting_summary` + `resolve_groq_key`.
- `src-tauri/src/main.rs` — register the command.

**Modified — Frontend**
- `src/types.ts` — `MeetingSummary` + `summary` on `MeetingDetail`.
- `src/components/Settings/MeetingsPage.tsx` — tab enable/disable; rewritten `SummaryPanel`.
- `src/SettingsApp.tsx` — `generateSummary` handler + signals + wiring.
- `package.json` — add `marked`, `dompurify` (+ `@types/dompurify` if needed).
