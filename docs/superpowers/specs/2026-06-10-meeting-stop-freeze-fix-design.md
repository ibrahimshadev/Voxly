# Design: Fix app freeze when stopping long meeting recordings

**Date:** 2026-06-10
**Status:** Draft — root-cause traced against the live codebase; awaiting maintainer sign-off before the implementation plan.
**App version at time of writing:** 1.21.0 (in production, distributed via GitHub releases)

---

## 1. Context & problem

Stopping a meeting recording of ~30 minutes or longer freezes the **entire app** (pill + settings windows, tray) for tens of seconds to minutes. Maintainer-confirmed behavior: the recording *does* save correctly behind the scenes, and the app becomes responsive again the moment saving completes. Nothing is lost — the app just blocks until FFmpeg finishes.

### Root cause (traced, three compounding problems)

1. **`stop_meeting` is a synchronous Tauri command** (`src-tauri/src/commands.rs:199`). In Tauri v2, non-async commands run on the **main thread** — the event loop servicing every window, the tray, and all IPC. Anything slow inside it freezes the whole app (Windows marks it "Not Responding").

2. **The stop path does duration-proportional FFmpeg work inline** (`RunningRecorder::stop`, `src-tauri/src/meeting/recorder.rs:115`):
   - `stop_ffmpeg` (recorder.rs:224) sends `q` and waits for the recording FFmpeg to exit. The recording is written with `-movflags +faststart` (recorder.rs:683), so exit includes faststart's "second pass" — rewriting the **entire file** to move the moov atom to the front. Cost scales with file size.
   - When system audio was recorded (the normal meeting setup), `mux_outputs` (recorder.rs:252) runs a second FFmpeg process over the **full-length** recording: decode `capture.mp4` audio + the full `system-audio.wav` (~690 MB/hour), mix, re-encode AAC, `-c:v copy` video if present, write the final file with **another** faststart full-file rewrite. Blocking `.output()`.
   - `create_dual_channel_transcript_audio` (recorder.rs:355) then decodes both full-length inputs **again** to build `transcript-audio.m4a` for AssemblyAI. Also blocking.

   A 2-minute test recording finishes in a blink (why this never showed in testing); a 30–60 minute meeting takes minutes — all on the main thread.

3. **Latent corruption landmine:** `stop_ffmpeg` kills FFmpeg after a fixed **8 seconds** (recorder.rs:240). For long *video* recordings, the faststart rewrite at quit time can exceed 8s → FFmpeg is killed mid-finalization → meeting marked `Error`, file potentially unplayable.

Non-causes, ruled out during diagnosis: the WASAPI loopback recorder streams to disk and its stop is a flag + thread join + WAV header finalize (`loopback.rs:70`) — cheap; SQLite meta updates — trivial.

The codebase already contains the correct pattern: `transcribe_meeting` (commands.rs:249) spawns its slow work via `tauri::async_runtime::spawn` and reports progress through events. `stop_meeting` is the outlier.

## 2. Decision summary

Locked by the maintainer ("full fix" scope, progress bar included).

| Decision | Choice |
|---|---|
| Threading | **Background finalization.** `stop_meeting` returns immediately with the new `processing` status; the slow work runs via `tauri::async_runtime::spawn_blocking`. Command gets `#[tauri::command(async)]` so even the fast part stays off the main thread. |
| Lifecycle | New **`MeetingStatus::Processing`** ("processing") between `recording` and `recorded`/`error`. Set at stop time together with `ended_at_ms`/`duration_secs` (both known then). |
| Progress | **Real percentage progress** for the post-processing pass via FFmpeg `-progress pipe:1`, emitted as throttled `meeting:update { state: "processing", progress_pct }` events. Indeterminate during the brief quit phase (no progress data exists there). |
| FFmpeg efficiency | Drop `+faststart` from the **intermediate** `capture.mp4` (it gets remuxed anyway — the rewrite at quit time is pure waste). **Merge** the final-mix and transcript-audio passes into **one** FFmpeg invocation with two outputs (inputs decoded once instead of twice). Final outputs keep `+faststart`. |
| Quit timeout | Graceful-quit wait raised **8s → 300s** (`FFMPEG_QUIT_TIMEOUT`). Kill remains a last resort only; killing during faststart finalization is what corrupts files. Off the main thread, a long wait is harmless. |
| Pill UX | Pill returns to **idle immediately** on stop — recording *has* stopped; dictation is available. Saving progress lives in Settings → Meetings. No new pill states (respects the WebView2 transparent-window constraints). |
| Settings UX | "Saving recording…" toast on stop; meeting list badge **"Saving… N%"**; progress bar in the detail panel; success/error toast when finalization completes. |
| Concurrency | Starting a **new** meeting while a previous one finalizes is **allowed** (separate folder/processes; FFmpeg releases the capture devices shortly after `q` — an immediate back-to-back start can at worst hit the existing clear start error). **Deleting** a finalizing meeting is **rejected** (FFmpeg holds its files open). |
| Crash safety | Manager tracks finalizing ids in memory; reconciliation treats dangling `recording` **or** `processing` rows (not in the live set) as orphans → `error`. App killed mid-finalization self-heals on next launch. |
| Drive-by | `start_meeting` also gets `#[tauri::command(async)]` — it has a hard-coded 350ms sleep (recorder.rs:211) plus process spawning that freezes the app ~0.5–1s on every start. Same bug class, attribute-only change. |

### Why these

- **Events over awaited command:** the await-based flow is what couples UI feedback to a minutes-long operation. Events (`meeting:update`) already drive the pill and the transcription flow; stop joins the same pattern. The fast return still carries the `processing` meta so the settings page updates instantly.
- **`processing` as a persisted status, not just a UI flag:** the meeting list must render correctly from a cold `list_meetings` load (settings window can be hidden/reshown mid-finalization), and reconciliation needs a persisted marker to detect crash-orphaned finalizations.
- **In-memory finalizing set, not a DB field:** "is a task running right now" is process state; persisting it would recreate the staleness problem reconciliation exists to solve. The set + persisted status together give both liveness and crash detection.
- **Merged FFmpeg invocation with fallback:** today a transcript-audio failure is non-fatal (logged only, recorder.rs:341). A merged graph would make it fatal to the final file — so on combined failure, finalize retries **mix-only** (today's exact behavior), then falls back to `promote_primary_capture` as today. Transcription already degrades to the source file when `transcript-audio.m4a` is absent (single-channel diarization instead of mic/system channels).
- **Parse `out_time=`, not `out_time_ms=`:** FFmpeg's `out_time_ms` progress key is historically **microseconds** (a long-standing quirk, inconsistent across versions). The `out_time=HH:MM:SS.ffffff` text field is unambiguous everywhere; `out_time_us=` is the fallback.

## 3. Architecture & data flow

```
User clicks stop (pill App.tsx:147 or settings SettingsApp.tsx:374)
  → invoke("stop_meeting")                               #[tauri::command(async)]
  → [manager.begin_stop]
        take ActiveMeeting (Err if none — unchanged)
        recorder.signal_stop()        // write "q" to FFmpeg stdin + flip loopback flag; instant
        meta: status=processing, ended_at_ms, duration_secs  → upsert
        finalizing.insert(id)         // in-memory live set
        spawn_blocking(finalize task)
        return meta                   // status=processing
  → command emits meeting:update{state:"processing"} + meetings-updated, returns meta
  → UI is free; pill idle; settings shows "Saving… ⏳"

[finalize task — background, blocking pool]
        wait for recording FFmpeg exit (≤300s; kill = last resort)
        join loopback thread
        if system audio: run merged mux+transcript FFmpeg with -progress pipe:1
            stdout reader: parse out_time → pct = out_time / duration_secs
            emit meeting:update{state:"processing", progress_pct} (throttled)
            on failure: retry mix-only → else promote_primary_capture
        cleanup temp files
        meta: status=recorded|error, file_size_bytes → upsert
        finalizing.remove(id)         // RAII guard, survives panics
        emit meeting:update{state:"stopped"|"error"} + meetings-updated
```

## 4. Backend design

### 4.1 `src-tauri/src/meeting/recorder.rs`

Constants:
```rust
const FFMPEG_QUIT_TIMEOUT: Duration = Duration::from_secs(300); // was 8s
```

`RunningRecorder::stop()` splits into:

- **`signal_stop(&mut self)`** — write `q\n` to the child's stdin (ignore failures: process may already be gone) and call `loopback.signal()`. No waiting. Instant.
- **`finalize(self, progress: impl Fn(f32)) -> Result<(), String>`** — consumes self; runs on the blocking pool:
  1. `wait_ffmpeg(child)`: poll `try_wait()` every 100ms up to `FFMPEG_QUIT_TIMEOUT`; on timeout kill + wait and return the "did not stop cleanly" error (unchanged text).
  2. `loopback.stop()` (joins the capture thread; flag already flipped — idempotent).
  3. If system audio: **merged post-process** (4.1.2), reporting progress via the callback.
  4. Existing fallback ladder preserved: merged failure → mix-only invocation → `promote_primary_capture` → error.

#### 4.1.1 Intermediate file loses faststart

`build_args` gains `is_final_output: bool` (replaces the current `apply_audio_gain: bool` — both gain and `+faststart` follow exactly the same condition: the single-FFmpeg recording *is* the final file only when there's no system audio). Call site: `build_args(primary_path, options, false, !has_system_audio)` keeps its shape; `-movflags +faststart` and `-af volume=2.0` are appended only when `is_final_output`. This makes the `q` quit fast in the system-audio case — the long faststart cost moves into the merged pass, where it's measured and backgrounded.

#### 4.1.2 Merged mux + transcript invocation

One FFmpeg run, two outputs, replacing `mux_outputs` + `create_dual_channel_transcript_audio` in the mic+system case. Shared upstream chains are split with `asplit`:

```
[0:a]asetpts=PTS-STARTPTS,volume=3.0,asplit=2[mic_mix][mic_tr];
[1:a]{offset chain: asetpts / adelay|atrim}asplit=2[sys_mix][sys_tr];
[mic_mix][sys_mix]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout];
[mic_tr]pan=mono|c0=c0,apad=pad_dur=3[mt];
[sys_tr]pan=mono|c0=0.5*c0+0.5*c1,apad=pad_dur=3[st];
[mt][st]join=inputs=2:channel_layout=stereo[tout]
```

Args (per-output options precede each output file):
```
-progress pipe:1 -nostats -hide_banner -y
-i capture.mp4 -i system-audio.wav
-filter_complex <graph>
-map 0:v? -map [aout] -c:v copy -c:a aac -b:a 128k -movflags +faststart  recording.mp4
-map [tout]            -c:a aac -b:a 96k                                 transcript-audio.m4a
```

This preserves the current filter semantics exactly (mic +volume=3.0 into both branches; system offset chain shared; no gain on system in the mic+system mix — matching `mic_system_mix_filter` and the transcript filter today). The two single-output cases (video-only + system; system-only) keep their current mix-only graphs, gaining only `-progress pipe:1` and the progress callback.

Process handling changes from `.output()` to `spawn()` with stdout piped (progress) and stderr piped (error capture via a drain thread, reported on failure as today).

#### 4.1.3 Progress parsing

`-progress pipe:1` emits `key=value` blocks. Parser reads stdout lines, extracts `out_time=HH:MM:SS.ffffff` (fallback `out_time_us=`), converts to seconds, computes `pct = (out_time_secs / duration_secs).clamp(0.0, 0.99) * 100`. The callback fires when pct advances ≥1 point or ≥500ms elapsed since the last emit. 100% is never emitted from the parser — the terminal `stopped` event is the completion signal. (`duration_secs` comes from meta; the transcript branch's `apad=pad_dur=3` makes output run ~3s past it, hence the clamp.)

### 4.2 `src-tauri/src/meeting/loopback.rs`

Add `signal(&self)` — `self.recording.store(false, Ordering::SeqCst)` without joining. `stop()` keeps signal + join semantics (now called from `finalize`). Both platform stubs updated.

### 4.3 `src-tauri/src/meeting/manager.rs`

```rust
pub struct MeetingSessionManager {
    active: Mutex<Option<ActiveMeeting>>,
    finalizing: Mutex<HashSet<String>>,   // NEW: live finalization ids
}
```

- **`begin_stop(&self, app: AppHandle) -> Result<MeetingMeta, String>`** replaces `stop()`: take active → `signal_stop()` → compute `ended_at_ms`/`duration_secs` → upsert meta with `status=Processing` → insert id into `finalizing` → `tauri::async_runtime::spawn_blocking(finalize task)` → return processing meta.
- **Finalize task:** holds an RAII guard that removes the id from `finalizing` on drop (covers panics). Runs `recorder.finalize(progress_cb)` where `progress_cb` emits `meeting:update { state: "processing", meeting_id, progress_pct }`. On completion: `update_meta_by_id` (status `Recorded`/`Error` + `file_size_bytes`), emit `meeting:update { state: "stopped" | "error" (message) , meeting_id }` + `meetings-updated`. The error emit sets `meeting_id` (today's sync error path emits `meeting_id: None`, commands.rs:220 — background errors are per-meeting and both listeners use the id).
- **`live_ids()`** (replaces `active_id()` for reconciliation): active id + finalizing ids, as a `HashSet<String>`. `list()` / `get()` pass it through.
- **`delete()`**: additionally reject ids present in `finalizing` — "Wait for the recording to finish saving before deleting it."
- `start()` is untouched — a new recording during finalization is independent (own folder, own processes; capture devices were released at signal + loopback join).

### 4.4 `src-tauri/src/meeting/storage.rs`

`load_index_reconciled` / `get_detail_reconciled` take `live_ids: &HashSet<String>` instead of `active_id: Option<&str>`. `reconcile_orphaned_recordings` orphan rule becomes: `status ∈ {Recording, Processing}` **and** `id ∉ live_ids` → `Error` (+ existing `ended_at_ms`/`duration_secs`/`file_size` backfill). Existing tests updated; new cases added (§8).

### 4.5 Types & DB

`src-tauri/src/meeting/types.rs`:
```rust
pub enum MeetingStatus { Recording, Processing, Recorded, Error }  // + Processing ("processing")

pub struct MeetingUpdate {
    // ... existing fields ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_pct: Option<f32>,   // NEW: 0–99, only on state == "processing"
}
```

`src-tauri/src/db.rs`: add `"processing"` to `meeting_status_to_str` / `meeting_status_from_str` (db.rs:371/:379). No schema change — `status` is TEXT. Unknown strings already fall back to `Error` on read (db.rs:353), so a DB written by the new version degrades safely under an app downgrade.

### 4.6 `src-tauri/src/commands.rs`

```rust
#[tauri::command(async)]
pub fn stop_meeting(app: AppHandle, state: State<'_, AppState>) -> Result<MeetingMeta, String> {
    let meta = state.meeting_manager.begin_stop(app.clone())?;
    let _ = app.emit("meeting:update", MeetingUpdate { state: "processing", meeting_id, elapsed_secs: duration, file_size_bytes, progress_pct: None, .. });
    let _ = app.emit("meetings-updated", ());
    Ok(meta)
}
```
Error path unchanged (emit `error` state + `meetings-updated`, return Err). `start_meeting` gains the `(async)` attribute, body unchanged. (Both already return `Result`, which `#[tauri::command(async)]` with borrowed `State` requires.)

The per-second progress timer (`manager.rs:209`) needs no change: its `is_still_recording` check matches `status == Recording`, so the elapsed/size ticker stops at the `processing` transition automatically.

## 5. Frontend design

### 5.1 `src/types.ts`

- `MeetingStatus` (types.ts:71) += `'processing'`.
- `MeetingUpdate` (types.ts:123): `state` += `'processing'`; add `progress_pct?: number`.

### 5.2 Pill — `src/App.tsx`

`meeting:update` listener (App.tsx:309): add a `processing` branch with the same body as `stopped` (clear meeting state → idle; set `lastStoppedMeetingId` so a late `recording` tick can't resurrect the meeting UI). Branch is idempotent — repeated progress events are harmless. `stopped`/`error` branches unchanged. The `toggleMeetingRecording` await path (App.tsx:150) now resolves in milliseconds and already resets state.

### 5.3 Settings — `src/SettingsApp.tsx`

- New signal: `processingMeetings: Record<string, number | null>` (id → pct, `null` = indeterminate).
- `stopMeetingRecording` (SettingsApp.tsx:374): replace the premature `notifySuccess('Meeting recording saved.')` with `notifyInfo('Saving recording…')`; returned meta (status `processing`) flows through the existing `upsertMeetingMeta` + select + detail load.
- `meeting:update` listener (SettingsApp.tsx:663) gains:
  - `processing` → set `processingMeetings[id]` to `progress_pct ?? null`; patch status `'processing'` into the list item + selected meta (same patch pattern the `transcribing` branch uses).
  - `stopped` → delete from `processingMeetings`; `notifySuccess('Meeting recording saved.')`; `loadMeetings()`; reload detail if selected.
  - `error` (with `meeting_id`) → delete from `processingMeetings`; `notifyError(message)`; `loadMeetings()`; reload detail if selected. (Start-failure `error` events carry no `meeting_id` and keep being ignored here — the pill surfaces those, unchanged.)
- Thread `processingMeetings` down to `MeetingsPage` as a prop.

### 5.4 `src/components/Settings/MeetingsPage.tsx`

- `transcriptStatusLabel` (:99–106): `processing` → **"Saving…"**, with the live percentage appended when known ("Saving… 42%").
- Playback gate (:183, :556): treat `processing` like `recording` (file not final); copy: "Saving recording…".
- Detail panel: where the not-ready notice renders, show a progress bar for `processing` — determinate `scaleX(pct/100)` fill when a percentage exists, an indeterminate shimmer otherwise. Transform-based animation only (project CSS rules; the settings window is opaque, but compositor-safe properties remain the house style).
- Transcribe button needs nothing: it already requires `status === 'recorded'` (:228), so `processing` keeps it disabled.

## 6. Error handling & edge cases

| Case | Behavior |
|---|---|
| Recording FFmpeg doesn't exit within 300s | Killed (last resort) → status `error`, `error` event with message, toast in settings; pill shows error state. |
| Merged invocation fails | Retry mix-only (today's two-pass behavior, minus transcript audio) → on success `recorded`; transcription later falls back to the source file. |
| Mix-only also fails | `promote_primary_capture` keeps the screen/mic capture (existing fallback ladder, unchanged), error surfaced as today. Known nuance: the promoted file no longer has `+faststart` (the intermediate loses it by design) — acceptable for this rare degraded path; local playback uses range requests. Do not "fix" this ad hoc during implementation. |
| App killed mid-finalization | `finalizing` set is gone on relaunch → reconciliation finds dangling `processing` → `error` with backfilled duration/size. |
| Stop clicked twice / from both windows | Second call: "No meeting is recording." (active already taken — unchanged semantics). |
| Delete while finalizing | Rejected: "Wait for the recording to finish saving before deleting it." |
| Start new meeting while finalizing | Allowed — independent folder/processes; devices released at signal time. |
| Settings window hidden during finalization | Events are missed but harmless: reopening reloads `list_meetings`, which reads the persisted `processing`/`recorded` status. |
| No system audio recorded | No post-process pass exists; the whole save is the FFmpeg quit → indeterminate "Saving…" only (no percentages). Audio-only quits are fast; video quits keep faststart and may take seconds–minutes, now bounded by 300s and off the main thread. |
| Progress for the quit phase | None exists (faststart's second pass reports nothing) → indeterminate bar until the merged pass starts emitting. |

## 7. Out of scope (v1) / future

- **Pill-side progress display** — pill stays minimal per the WebView2 transparent-window constraints; Settings → Meetings is the progress surface.
- **Cancel during finalization.**
- **Progress for the graceful-quit phase** (no data source).
- **OS notification when saving completes** (possible later via the existing toast plumbing).
- **`start_meeting` deeper async refactor** — only the attribute changes; its 350ms probe sleep moves off the main thread but still delays the invoke response. Fine for v1.

## 8. Testing

Rust unit tests (existing style in `recorder.rs` / `storage.rs`):
- `build_args`: `+faststart`/gain present when `is_final_output`, absent otherwise (both system-audio cases).
- Merged filter graph builder: exact strings for mic+system with positive/negative/zero offsets (extends the existing `audio_offset_filter` / `mic_system_mix_filter` tests); asplit branches; `[aout]`/`[tout]` labels.
- Two-output arg assembly: per-output maps/codecs/faststart placement; `-progress pipe:1 -nostats` present.
- Progress parser: `out_time` → pct math, clamping at 99, throttling rule, `out_time_us` fallback, garbage lines ignored.
- Reconciliation: `processing` ∈ live set → kept; dangling `processing` → `error` with backfill; dangling `recording` behavior unchanged; live `recording` unchanged.
- DB status mappers round-trip `"processing"`.

Manual verification (Windows, maintainer):
1. Record 30–60 min with mic + system audio (± video) → stop → app stays responsive, pill idle immediately, badge shows "Saving… N%" with a moving bar → completes → file plays, `transcript-audio.m4a` exists, transcription works.
2. Stop, then immediately start a new recording → both complete correctly.
3. Kill the app mid-"Saving…" → relaunch → meeting shows `Error`, app healthy.
4. Short recording (<2 min) → near-instant save, no regression.
5. Audio-only (no system audio) → indeterminate "Saving…", quick completion.

## 9. File-by-file change list

**Modified — Rust**
- `src-tauri/src/meeting/recorder.rs` — `signal_stop`/`finalize` split; `FFMPEG_QUIT_TIMEOUT`; `is_final_output` in `build_args`; merged two-output invocation + progress parsing; fallback ladder.
- `src-tauri/src/meeting/loopback.rs` — `signal()` on both platform impls.
- `src-tauri/src/meeting/manager.rs` — `begin_stop`, `finalizing` set + RAII guard, spawn_blocking task, `live_ids()`, delete guard.
- `src-tauri/src/meeting/storage.rs` — reconciliation over live-id set; `Recording|Processing` orphan rule.
- `src-tauri/src/meeting/types.rs` — `MeetingStatus::Processing`; `MeetingUpdate.progress_pct`.
- `src-tauri/src/db.rs` — status mapper strings.
- `src-tauri/src/commands.rs` — `stop_meeting` rewritten (async attribute, begin_stop, processing emit); `start_meeting` async attribute.

**Modified — Frontend**
- `src/types.ts` — `MeetingStatus` + `'processing'`; `MeetingUpdate.state` + `'processing'`, `progress_pct`.
- `src/App.tsx` — `processing` branch in the meeting listener.
- `src/SettingsApp.tsx` — `processingMeetings` signal; listener branches for `processing`/`stopped`/`error`; toast changes.
- `src/components/Settings/MeetingsPage.tsx` — "Saving… N%" badge; playback gate; progress bar in detail panel.

**No DB schema change. No new dependencies.**
