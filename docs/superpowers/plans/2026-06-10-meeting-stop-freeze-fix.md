# Meeting Stop Freeze Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop of a long meeting recording no longer freezes the app: stop returns instantly with a `processing` status, FFmpeg finalization runs in the background with a real progress bar, the redundant second FFmpeg pass is merged away, and the 8s kill that can corrupt long video recordings becomes a 300s last resort.

**Architecture:** Split `RunningRecorder::stop()` into instant `signal_stop()` + background `finalize()` driven from `MeetingSessionManager::begin_stop()` via `tauri::async_runtime::spawn_blocking`. New persisted `MeetingStatus::Processing` + in-memory `finalizing` id set give crash-safe reconciliation. Progress comes from FFmpeg `-progress pipe:1` parsed against the known recording duration and emitted as throttled `meeting:update` events the existing listeners already receive.

**Tech Stack:** Tauri v2 (Rust backend), SolidJS + TypeScript frontend, FFmpeg subprocess, SQLite (rusqlite), WASAPI loopback.

**Spec:** `docs/superpowers/specs/2026-06-10-meeting-stop-freeze-fix-design.md` — read it first; it locks all decisions and explains why.

---

## Environment — READ FIRST (WSL + Windows toolchain)

This repo lives on the Windows filesystem and the app targets Windows. Two toolchains exist; **use the right one or tests are meaningless**:

- **Rust:** ALWAYS use the **Windows** cargo from WSL, running inside `src-tauri/`:
  `cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test`
  (Windows target ⇒ `cfg!(windows)` is true, so `build_args` tests exercise the real code path; reuses the existing Windows build cache. The WSL-native cargo cannot compile this crate — no Linux webview deps.) First test compile takes a few minutes; subsequent runs are incremental.
- **Frontend:** WSL node is fine, from the repo root:
  `cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit && npm run build`
- **Baseline:** `cargo.exe test` currently shows **49 passed; 1 failed** — the failure is a pre-existing Windows-only test bug fixed in Task 0. After Task 0 the suite must be green and STAY green after every task.
- Tests live inside the source files (`#[cfg(test)] mod tests`), per house style. Test names use `snake_case` sentences. No new dependencies are needed or allowed.
- Commit messages follow conventional commits (`fix:`, `feat:`, `test:`, `docs:`), matching repo history.

---

### Task 0: Branch + green baseline

**Files:**
- Modify: `src-tauri/src/db.rs:534-543` (test module)

- [ ] **Step 0.1: Create the working branch**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git checkout -b fix/meeting-stop-freeze
```

- [ ] **Step 0.2: Reproduce the pre-existing failure**

Run: `cd src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test first_database_open_migrates`
Expected: FAIL — `Os { code: 32 ... "The process cannot access the file because it is being used by another process." }` at `db.rs:542`.

Cause: the second `conn` opened at db.rs:536 is never dropped before `fs::remove_dir_all(app_dir)`. Windows refuses to delete open files; Unix doesn't — so this only fails on Windows.

- [ ] **Step 0.3: Fix — drop the connection before cleanup**

In `src-tauri/src/db.rs`, the test `first_database_open_migrates_existing_json_without_removing_it` ends with:

```rust
        assert!(history_path.exists());
        assert!(transcript_path.exists());

        fs::remove_dir_all(app_dir).unwrap();
```

Insert `drop(conn);` after the `assert!(transcript_path.exists());` line (mirroring the existing `drop(conn);` at db.rs:534).

- [ ] **Step 0.4: Verify green baseline**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: `50 passed; 0 failed`

- [ ] **Step 0.5: Commit**

```bash
git add src-tauri/src/db.rs && git commit -m "test(db): drop connection before temp dir cleanup so suite passes on Windows"
```

---

### Task 1: `MeetingStatus::Processing` + `MeetingUpdate.progress_pct`

**Files:**
- Modify: `src-tauri/src/meeting/types.rs:3-9` (enum), `:89-100` (MeetingUpdate)
- Modify: `src-tauri/src/db.rs:371-386` (status mappers) + test module
- Modify (add `progress_pct: None` to every `MeetingUpdate { ... }` literal): `src-tauri/src/commands.rs:186,204,218`, `src-tauri/src/meeting/manager.rs:222`, `src-tauri/src/meeting/transcribe.rs:575`, `src-tauri/src/meeting/recorder.rs:199`

- [ ] **Step 1.1: Write the failing test** — in `src-tauri/src/db.rs` `mod tests`:

```rust
    #[test]
    fn meeting_status_processing_round_trips() {
        assert_eq!(meeting_status_to_str(&MeetingStatus::Processing), "processing");
        assert!(matches!(
            meeting_status_from_str("processing"),
            Some(MeetingStatus::Processing)
        ));
    }
```

- [ ] **Step 1.2: Run it — expect compile failure**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test meeting_status_processing`
Expected: compile error E0599 — `no variant or associated item named 'Processing' found`.

- [ ] **Step 1.3: Implement**

`types.rs` — add the variant (serde `rename_all = "snake_case"` already on the enum):

```rust
pub enum MeetingStatus {
    Recording,
    Processing,
    Recorded,
    Error,
}
```

`types.rs` — add to `MeetingUpdate` (after `file_size_bytes`):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_pct: Option<f32>,
```

`db.rs` mappers — add arms:

```rust
fn meeting_status_to_str(status: &MeetingStatus) -> &'static str {
    match status {
        MeetingStatus::Recording => "recording",
        MeetingStatus::Processing => "processing",
        MeetingStatus::Recorded => "recorded",
        MeetingStatus::Error => "error",
    }
}
```
and in `meeting_status_from_str`: `"processing" => Some(MeetingStatus::Processing),`

Then fix every `MeetingUpdate { ... }` struct literal the compiler reports (the 6 sites listed above) by adding `progress_pct: None,`. Find them with:
`grep -rn "MeetingUpdate {" src/` (run inside `src-tauri/`).

- [ ] **Step 1.4: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: `51 passed; 0 failed`

- [ ] **Step 1.5: Commit**

```bash
git add -A src-tauri/src && git commit -m "feat(meeting): add processing status and progress field to meeting events"
```

---

### Task 2: Reconciliation over live ids (crash safety)

**Files:**
- Modify: `src-tauri/src/meeting/storage.rs:71-118,182-186` + its tests (`:322-353`)
- Modify: `src-tauri/src/meeting/manager.rs:172-180,199-206`

- [ ] **Step 2.1: Write failing tests** — in `storage.rs` `mod tests` (the `meta(id, status)` helper at `:302` already exists). Add:

```rust
    use std::collections::HashSet;

    fn live(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
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
```

Also update the two existing reconcile tests (`:322-353`) to the new signature: replace `Some("active")` with `&live(&["active"])` and `None`-style arguments accordingly.

- [ ] **Step 2.2: Run — expect compile failure** (signature mismatch)

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test reconciliation`
Expected: compile error (expected `&HashSet<String>`, found `Option<&str>`).

- [ ] **Step 2.3: Implement**

`storage.rs` — change signatures and the orphan rule (`use std::collections::HashSet;` already exists at storage.rs:1 — do NOT add a duplicate):

```rust
pub fn load_index_reconciled(live_ids: &HashSet<String>) -> Result<Vec<MeetingMeta>, String> {
    // body unchanged except: reconcile_orphaned_recordings(&mut items, live_ids, ended_at_ms, ...)
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
        // rest unchanged (Error + backfill)
```

`get_detail_reconciled(id: &str, live_ids: &HashSet<String>)` — same mechanical change.

`manager.rs` — replace `active_id()` with `live_ids()` (finalizing ids join in Task 6):

```rust
    fn live_ids(&self) -> Result<std::collections::HashSet<String>, String> {
        let mut ids = std::collections::HashSet::new();
        if let Some(active) = self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?
            .as_ref()
        {
            ids.insert(active.meta.id.clone());
        }
        Ok(ids)
    }
```
and update `list()` / `get()` to `storage::load_index_reconciled(&self.live_ids()?)` / `storage::get_detail_reconciled(id, &self.live_ids()?)`.

Check for other callers: `grep -rn "load_index_reconciled\|get_detail_reconciled" src/` — if any pass `None` (e.g. future summary code), use `&HashSet::new()`.

- [ ] **Step 2.4: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: `53 passed; 0 failed`

- [ ] **Step 2.5: Commit**

```bash
git add -A src-tauri/src && git commit -m "feat(meeting): reconcile orphaned processing meetings over live id set"
```

---

### Task 3: `LoopbackRecorder::signal()` (non-joining stop signal)

**Files:**
- Modify: `src-tauri/src/meeting/loopback.rs` (both `platform` modules)

- [ ] **Step 3.1: Implement** — Windows impl (next to `stop()` at `:70`):

```rust
        pub fn signal(&self) {
            self.recording.store(false, Ordering::SeqCst);
        }
```

Non-Windows stub (next to its `stop()`):

```rust
        pub fn signal(&self) {}
```

`stop()` stays as-is (signal + join); the flag store is idempotent. No unit test — this wraps a hardware capture thread; it's covered by the suite compiling and manual verification.

- [ ] **Step 3.2: Verify + commit**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test` → `53 passed`.

```bash
git add src-tauri/src/meeting/loopback.rs && git commit -m "feat(meeting): add non-joining signal to loopback recorder"
```

---

### Task 4: `build_args` — faststart/gain only on final outputs

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs:561-689` (`build_args`) + test module

- [ ] **Step 4.1: Write failing tests** — in `recorder.rs` `mod tests` (these run under Windows cargo, so `cfg!(windows)` is true and `build_args` returns Ok):

```rust
    fn mic_only_options() -> MeetingStartOptions {
        MeetingStartOptions {
            title: None,
            record_video: false,
            record_mic: true,
            record_system_audio: false,
            video_preset: "audio_only".to_string(),
            mic_device: Some("Test Mic".to_string()),
            system_audio_device: None,
        }
    }

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn build_args_keeps_faststart_and_gain_for_final_output() {
        let args = build_args(Path::new("out.mp4"), &mic_only_options(), false, true).unwrap();
        assert!(has_pair(&args, "-movflags", "+faststart"));
        assert!(has_pair(&args, "-af", MEETING_AUDIO_GAIN_FILTER));
    }

    #[test]
    fn build_args_omits_faststart_and_gain_for_intermediate_capture() {
        let args = build_args(Path::new("capture.mp4"), &mic_only_options(), false, false).unwrap();
        assert!(!args.contains(&"+faststart".to_string()));
        assert!(!args.contains(&"-af".to_string()));
    }
```

- [ ] **Step 4.2: Run — expect one failure**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test build_args`
Expected: `build_args_omits_faststart_and_gain_for_intermediate_capture` FAILS (faststart is currently unconditional at recorder.rs:682-684); the other passes.

- [ ] **Step 4.3: Implement** — in `build_args`, rename the 4th parameter `apply_audio_gain: bool` → `is_final_output: bool` (update the doc-free usage at `:669`), and gate the trailing movflags block:

```rust
    if is_final_output {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    args.push(output_path.to_string_lossy().to_string());
```

(The `-af` gain extend at `:668-671` already keys off this parameter — only its name changes.) The call site at `:72` — `build_args(primary_path, options, false, !has_system_audio)` — is already passing the right value: the single-FFmpeg recording is final exactly when there's no system audio.

- [ ] **Step 4.4: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: `55 passed; 0 failed`

- [ ] **Step 4.5: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs && git commit -m "feat(meeting): skip faststart on intermediate capture so quit is fast"
```

---

### Task 5: Progress parser module

**Files:**
- Create: `src-tauri/src/meeting/progress.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (add `pub mod progress;`)

- [ ] **Step 5.1: Write the module with failing tests first** — create `progress.rs` with ONLY the test module and stub signatures that `todo!()`, or write tests + implementation in one file but **run the tests before wiring any caller**. Required behavior:

```rust
use std::time::{Duration, Instant};

/// Parses one line of `ffmpeg -progress pipe:1` output into processed seconds.
/// Accepts `out_time=HH:MM:SS.ffffff` (canonical, version-stable) and
/// `out_time_us=<microseconds>` (fallback). Returns None for anything else —
/// including `out_time_ms=`, which is historically microseconds and ambiguous
/// across FFmpeg versions.
pub fn parse_out_time_secs(line: &str) -> Option<f64>;

/// Percentage for the UI. None when duration is unknown/invalid (UI shows
/// indeterminate). Clamped to 99.0 — the terminal "stopped" event is the
/// completion signal, never the bar.
pub fn progress_pct(out_time_secs: f64, duration_secs: f64) -> Option<f32>;

/// Rate limiter: emit on first call, then when pct advanced >= 1.0 point or
/// >= 500ms elapsed since the last emit.
pub struct ProgressThrottle { last: Option<(Instant, f32)> }
impl ProgressThrottle {
    pub fn new() -> Self;
    pub fn should_emit(&mut self, pct: f32, now: Instant) -> bool;
}
```

Tests (all pure — `now` is injected, no sleeping):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_out_time_hms() {
        assert_eq!(parse_out_time_secs("out_time=00:01:30.500000"), Some(90.5));
    }

    #[test]
    fn parses_out_time_us_fallback() {
        assert_eq!(parse_out_time_secs("out_time_us=90500000"), Some(90.5));
    }

    #[test]
    fn ignores_other_lines_and_ambiguous_ms_key() {
        assert_eq!(parse_out_time_secs("frame=120"), None);
        assert_eq!(parse_out_time_secs("out_time_ms=90500000"), None);
        assert_eq!(parse_out_time_secs("out_time=garbage"), None);
        assert_eq!(parse_out_time_secs(""), None);
    }

    #[test]
    fn pct_is_ratio_clamped_to_99() {
        assert_eq!(progress_pct(45.0, 90.0), Some(50.0));
        assert_eq!(progress_pct(150.0, 90.0), Some(99.0)); // apad runs past duration
        assert_eq!(progress_pct(-5.0, 90.0), Some(0.0));
    }

    #[test]
    fn pct_is_none_without_valid_duration() {
        assert_eq!(progress_pct(45.0, 0.0), None);
        assert_eq!(progress_pct(45.0, -1.0), None);
    }

    #[test]
    fn throttle_emits_first_then_on_step_or_interval() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.should_emit(10.0, t0));
        assert!(!throttle.should_emit(10.5, t0 + Duration::from_millis(100)));
        assert!(throttle.should_emit(11.5, t0 + Duration::from_millis(200))); // ≥1 pct step
        assert!(throttle.should_emit(11.6, t0 + Duration::from_millis(800))); // ≥500ms
    }
}
```

Implementation sketch (keep it this simple):

```rust
pub fn parse_out_time_secs(line: &str) -> Option<f64> {
    if let Some(value) = line.strip_prefix("out_time=") {
        let mut parts = value.trim().splitn(3, ':');
        let hours: f64 = parts.next()?.parse().ok()?;
        let minutes: f64 = parts.next()?.parse().ok()?;
        let seconds: f64 = parts.next()?.parse().ok()?;
        return Some(hours * 3600.0 + minutes * 60.0 + seconds);
    }
    if let Some(value) = line.strip_prefix("out_time_us=") {
        let us: i64 = value.trim().parse().ok()?;
        return Some(us as f64 / 1_000_000.0);
    }
    None
}

pub fn progress_pct(out_time_secs: f64, duration_secs: f64) -> Option<f32> {
    if duration_secs <= 0.0 {
        return None;
    }
    Some(((out_time_secs / duration_secs) * 100.0).clamp(0.0, 99.0) as f32)
}
```

`should_emit`: store `(now, pct)` on every `true`; return true when `last.is_none()`, `pct - last_pct >= 1.0`, or `now - last_instant >= Duration::from_millis(500)`.

- [ ] **Step 5.2: Wire the module**

Add `pub mod progress;` to `src-tauri/src/meeting/mod.rs`.

- [ ] **Step 5.3: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: `61 passed; 0 failed`

- [ ] **Step 5.4: Commit**

```bash
git add src-tauri/src/meeting/progress.rs src-tauri/src/meeting/mod.rs && git commit -m "feat(meeting): add ffmpeg progress parser and emit throttle"
```

---

### Task 6: Recorder — signal/finalize split + merged post-process invocation

**Files:**
- Modify: `src-tauri/src/meeting/recorder.rs` (largest task; pure builders are TDD'd, orchestration is compile+suite verified)

- [ ] **Step 6.1: Write failing tests for the merged filter graph** — in `recorder.rs` tests:

```rust
    #[test]
    fn combined_post_filter_splits_mic_and_system_into_mix_and_transcript() {
        assert_eq!(
            combined_post_filter(0),
            "[0:a]asetpts=PTS-STARTPTS,volume=3.0,asplit=2[mic_mix][mic_tr];\
             [1:a]asetpts=PTS-STARTPTS,asplit=2[sys_mix][sys_tr];\
             [mic_mix][sys_mix]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout];\
             [mic_tr]pan=mono|c0=c0,apad=pad_dur=3[mt];\
             [sys_tr]pan=mono|c0=0.5*c0+0.5*c1,apad=pad_dur=3[st];\
             [mt][st]join=inputs=2:channel_layout=stereo[tout]"
        );
    }

    #[test]
    fn combined_post_filter_preserves_system_offset() {
        assert!(combined_post_filter(250)
            .contains("[1:a]asetpts=PTS-STARTPTS,adelay=250:all=1,asplit=2[sys_mix][sys_tr]"));
        assert!(combined_post_filter(-1250)
            .contains("[1:a]atrim=start=1.250,asetpts=PTS-STARTPTS,asplit=2[sys_mix][sys_tr]"));
    }
```

NOTE on the expected string: write it as ONE string with no whitespace between segments (the `\` continuations above are for plan readability — in the test use a single concatenated literal, segments joined by `;`).

- [ ] **Step 6.2: Write failing tests for the two-output args builder**:

```rust
    #[test]
    fn post_process_args_builds_two_outputs_with_progress() {
        let args = post_process_args(
            Some(Path::new("capture.mp4")),
            Path::new("system.wav"),
            Path::new("final.mp4"),
            Some(Path::new("transcript.m4a")),
            true,  // has_video
            true,  // has_primary_audio
            0,
        );
        assert!(has_pair(&args, "-progress", "pipe:1"));
        assert!(args.contains(&"-nostats".to_string()));
        assert!(has_pair(&args, "-map", "0:v?"));
        assert!(has_pair(&args, "-c:v", "copy"));
        assert!(has_pair(&args, "-map", "[aout]"));
        assert!(has_pair(&args, "-map", "[tout]"));
        assert!(has_pair(&args, "-movflags", "+faststart"));
        // transcript output is last; final output precedes it
        let final_pos = args.iter().position(|a| a == "final.mp4").unwrap();
        let transcript_pos = args.iter().position(|a| a == "transcript.m4a").unwrap();
        assert!(final_pos < transcript_pos);
        // faststart belongs to the final output, not the transcript output
        let faststart_pos = args.iter().position(|a| a == "+faststart").unwrap();
        assert!(faststart_pos < final_pos);
    }

    #[test]
    fn post_process_args_without_transcript_matches_mix_only_shape() {
        let args = post_process_args(
            Some(Path::new("capture.mp4")),
            Path::new("system.wav"),
            Path::new("final.mp4"),
            None,
            true,
            true,
            0,
        );
        assert!(!args.iter().any(|a| a.contains("[tout]")));
        assert!(args.iter().any(|a| a.contains("amix=inputs=2")));
        assert!(args.last().unwrap() == "final.mp4");
    }

    #[test]
    fn post_process_args_system_only_uses_first_input() {
        let args = post_process_args(
            None,
            Path::new("system.wav"),
            Path::new("final.mp4"),
            None,
            false,
            false,
            0,
        );
        assert!(args.iter().any(|a| a.starts_with("[0:a]")));
        assert!(!has_pair(&args, "-c:v", "copy"));
    }
```

- [ ] **Step 6.3: Run — expect compile failures** (functions don't exist)

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test post_process -- --list` (or just `cargo.exe test`)
Expected: E0425 unresolved names.

- [ ] **Step 6.4: Implement the pure builders**

Extract the offset chain so the existing `audio_offset_filter` and the new builder share it:

```rust
fn offset_filter_steps(offset_ms: i64) -> Vec<String> {
    let mut filters = Vec::new();
    if offset_ms > 0 {
        filters.push("asetpts=PTS-STARTPTS".to_string());
        filters.push(format!("adelay={offset_ms}:all=1"));
    } else if offset_ms < 0 {
        filters.push(format!("atrim=start={:.3}", (-offset_ms as f64) / 1000.0));
        filters.push("asetpts=PTS-STARTPTS".to_string());
    } else {
        filters.push("asetpts=PTS-STARTPTS".to_string());
    }
    filters
}
```

Rewrite `audio_offset_filter` to use it (existing tests at `:773-794` must keep passing unchanged). Then:

```rust
fn combined_post_filter(system_audio_offset_ms: i64) -> String {
    let sys_chain = offset_filter_steps(system_audio_offset_ms).join(",");
    format!(
        "[0:a]asetpts=PTS-STARTPTS,{MEETING_MIC_GAIN_FILTER},asplit=2[mic_mix][mic_tr];\
         [1:a]{sys_chain},asplit=2[sys_mix][sys_tr];\
         [mic_mix][sys_mix]amix=inputs=2:duration=longest:normalize=0,{MEETING_AUDIO_LIMITER_FILTER}[aout];\
         [mic_tr]pan=mono|c0=c0,apad=pad_dur=3[mt];\
         [sys_tr]pan=mono|c0=0.5*c0+0.5*c1,apad=pad_dur=3[st];\
         [mt][st]join=inputs=2:channel_layout=stereo[tout]"
    )
}
```
(Again: single-string format literal, no embedded whitespace — the `\` here are plan formatting.)

`post_process_args` — assembles the full invocation. Behavior by case:
- `transcript.is_some() && has_primary_audio && primary.is_some()` → `combined_post_filter`, two outputs.
- otherwise → exactly today's `mux_outputs` argument construction (three `match (primary.is_some(), has_primary_audio)` arms with `mic_system_mix_filter` / `audio_offset_filter`), one output.
- ALL cases prepend: `-hide_banner -y -progress pipe:1 -nostats`, then `-i` inputs, then filter, maps, codecs (`-c:a aac -b:a 128k`), `-movflags +faststart` before the final path; the transcript output adds `-map [tout] -c:a aac -b:a 96k transcript.m4a` AFTER the final path.

- [ ] **Step 6.5: Run builder tests**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: all pass (existing `audio_offset_filter` / `mic_system_mix_filter` tests still green — they pin the shared chain refactor).

- [ ] **Step 6.6: Restructure stop into signal + finalize**

Replace `RunningRecorder::stop()` (recorder.rs:115-160) with:

```rust
    pub fn signal_stop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
            }
        }
        if let Some(loopback) = self.loopback.as_ref() {
            loopback.signal();
        }
    }

    pub fn finalize(
        mut self,
        duration_secs: f64,
        on_progress: &(dyn Fn(f32) + Send + Sync),
    ) -> Result<(), String> {
        let ffmpeg_result = match self.child.take() {
            Some(child) => wait_ffmpeg(child),
            None => Ok(()),
        };
        let loopback_result = match self.loopback.take() {
            Some(loopback) => loopback.stop(),
            None => Ok(()),
        };
        ffmpeg_result?;
        loopback_result?;

        if self.system_audio_path.is_some() {
            self.run_post_process(duration_secs, on_progress)?;
        }
        Ok(())
    }
```

`wait_ffmpeg` replaces the body of `stop_ffmpeg` (recorder.rs:224-250): delete the stdin-write block (now in `signal_stop`), keep the poll loop, and change the timeout:

```rust
const FFMPEG_QUIT_TIMEOUT: Duration = Duration::from_secs(300);
```
with the kill branch comment updated: killing mid-finalization corrupts the file; 300s is a last resort for a truly hung process, not a normal path.

**IMPORTANT — second caller:** `stop_ffmpeg` is also called at `recorder.rs:89`, the loopback-spawn-failure cleanup inside `RunningRecorder::spawn`. That path MUST still send `q` before waiting, or the just-spawned FFmpeg never quits and the cleanup blocks (while holding the manager's `active` lock). Keep `stop_ffmpeg` as a thin wrapper used only by that call site:

```rust
fn stop_ffmpeg(mut child: Child) -> Result<(), String> {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    wait_ffmpeg(child)
}
```

`run_post_process(&mut self, duration_secs, on_progress)` replaces the `mux_outputs` call site logic (recorder.rs:130-157) and `mux_outputs`/`create_dual_channel_transcript_audio` themselves:

1. Build combined args via `post_process_args(primary, system, final, transcript_path, has_video, has_primary_audio, offset)` where `transcript_path = transcript_audio_path_for(&self.final_path)` only when `self.has_primary_audio && self.primary_path.is_some()`.
2. `run_ffmpeg_with_progress(&self.ffmpeg_path, &args, duration_secs, on_progress)`:
   - `hidden_command(ffmpeg).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()`
   - stderr → drain thread collecting into a `String` (reuse the `BufReader::lines` pattern from `spawn_ffmpeg`, recorder.rs:189-209, but append to a buffer instead of emitting)
   - stdout → loop `BufReader::lines`: `progress::parse_out_time_secs(line)` → `progress::progress_pct(secs, duration_secs)` → `ProgressThrottle::should_emit(pct, Instant::now())` → `on_progress(pct)`
   - `child.wait()`; on non-success status → `Err(format!("Failed to mux system audio with FFmpeg: {stderr}"))`
3. **Fallback ladder** (preserves today's semantics):
   - combined (with transcript) fails AND a transcript was requested → log `eprintln!` and retry once with `transcript: None` (mix-only — today's exact output).
   - mix-only also fails → existing `promote_primary_capture` fallback path with the same error messages as today (recorder.rs:141-155).
4. On success: remove `capture.mp4` (when distinct from final) and `system-audio.wav` — same cleanup as today (recorder.rs:346-351).

Keep a temporary compatibility shim so `manager.rs` still compiles this commit (removed in Task 7):

```rust
    pub fn stop(mut self) -> Result<(), String> {
        self.signal_stop();
        self.finalize(0.0, &|_| {})
    }
```

Delete `mux_outputs` and `create_dual_channel_transcript_audio` once `run_post_process` covers them (the compiler will flag any leftover references).

- [ ] **Step 6.7: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: all pass (≈66; exact count printed). No warnings about unused functions.

- [ ] **Step 6.8: Commit**

```bash
git add src-tauri/src/meeting/recorder.rs && git commit -m "feat(meeting): split recorder stop into signal and progress-reporting finalize"
```

---

### Task 7: Manager `begin_stop` + finalizing set + command rewrite

**Files:**
- Modify: `src-tauri/src/meeting/manager.rs`
- Modify: `src-tauri/src/commands.rs:176-230`

- [ ] **Step 7.1: Write failing tests** — in a new `#[cfg(test)] mod tests` in `manager.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[test]
    fn finalizing_guard_removes_id_on_drop() {
        let set = Arc::new(Mutex::new(HashSet::new()));
        set.lock().unwrap().insert("m1".to_string());
        let guard = FinalizingGuard {
            set: Arc::clone(&set),
            id: "m1".to_string(),
        };
        drop(guard);
        assert!(set.lock().unwrap().is_empty());
    }

    #[test]
    fn delete_is_rejected_while_meeting_is_finalizing() {
        let manager = MeetingSessionManager::default();
        manager
            .finalizing
            .lock()
            .unwrap()
            .insert("m1".to_string());
        let error = manager.delete("m1").unwrap_err();
        assert!(error.contains("finish saving"));
    }
}
```

- [ ] **Step 7.2: Run — expect compile failure** (no `FinalizingGuard`, no `finalizing` field)

- [ ] **Step 7.3: Implement `manager.rs`**

```rust
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct MeetingSessionManager {
    active: Mutex<Option<ActiveMeeting>>,
    finalizing: Arc<Mutex<HashSet<String>>>,
}

struct FinalizingGuard {
    set: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for FinalizingGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            set.remove(&self.id);
        }
    }
}
```

Replace `stop()` with `begin_stop` + the background task:

```rust
    pub fn begin_stop(&self, app: AppHandle) -> Result<MeetingMeta, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?
            .take();
        let Some(mut active) = active else {
            return Err("No meeting is recording.".to_string());
        };

        active.recorder.signal_stop();

        let id = active.meta.id.clone();
        let ended_at_ms = storage::now_ms()?;
        let duration_secs = active.started.elapsed().as_secs_f64();
        let source_path = storage::source_path(&id)?;
        let file_size_bytes = storage::file_size(&source_path);

        let meta = storage::update_meta_by_id(&id, |item| {
            item.ended_at_ms = Some(ended_at_ms);
            item.duration_secs = Some(duration_secs);
            item.file_size_bytes = file_size_bytes;
            item.status = MeetingStatus::Processing;
            Ok(())
        })?
        .unwrap_or_else(|| {
            let mut meta = active.meta.clone();
            meta.ended_at_ms = Some(ended_at_ms);
            meta.duration_secs = Some(duration_secs);
            meta.file_size_bytes = file_size_bytes;
            meta.status = MeetingStatus::Processing;
            meta
        });

        self.finalizing
            .lock()
            .map_err(|_| "Meeting finalizing lock poisoned".to_string())?
            .insert(id.clone());
        let guard = FinalizingGuard {
            set: Arc::clone(&self.finalizing),
            id: id.clone(),
        };

        let recorder = active.recorder;
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            run_finalize(app, recorder, id, duration_secs, source_path);
        });

        Ok(meta)
    }
```

The background body as a free function (keeps the closure small and testable boundaries clear):

```rust
fn run_finalize(
    app: AppHandle,
    recorder: RunningRecorder,
    id: String,
    duration_secs: f64,
    source_path: std::path::PathBuf,
) {
    let progress_app = app.clone();
    let progress_id = id.clone();
    let result = recorder.finalize(duration_secs, &move |pct| {
        let _ = progress_app.emit(
            "meeting:update",
            MeetingUpdate {
                state: "processing".to_string(),
                meeting_id: Some(progress_id.clone()),
                message: None,
                elapsed_secs: None,
                file_size_bytes: None,
                progress_pct: Some(pct),
            },
        );
    });

    let file_size_bytes = storage::file_size(&source_path);
    let status = if result.is_ok() {
        MeetingStatus::Recorded
    } else {
        MeetingStatus::Error
    };
    let _ = storage::update_meta_by_id(&id, |item| {
        item.status = status.clone();
        item.file_size_bytes = file_size_bytes;
        Ok(())
    });

    match result {
        Ok(()) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "stopped".to_string(),
                    meeting_id: Some(id),
                    message: None,
                    elapsed_secs: Some(duration_secs.round() as u64),
                    file_size_bytes,
                    progress_pct: None,
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "error".to_string(),
                    meeting_id: Some(id),
                    message: Some(error),
                    elapsed_secs: None,
                    file_size_bytes,
                    progress_pct: None,
                },
            );
        }
    }
    let _ = app.emit("meetings-updated", ());
}
```

`live_ids()` gains the finalizing ids:

```rust
        ids.extend(
            self.finalizing
                .lock()
                .map_err(|_| "Meeting finalizing lock poisoned".to_string())?
                .iter()
                .cloned(),
        );
```

`delete()` gains, before the storage call:

```rust
        if self
            .finalizing
            .lock()
            .map_err(|_| "Meeting finalizing lock poisoned".to_string())?
            .contains(id)
        {
            return Err("Wait for the recording to finish saving before deleting it.".to_string());
        }
```

Remove the Task-6 `stop()` shim from `recorder.rs`.

- [ ] **Step 7.4: Rewrite `stop_meeting` and mark commands async** — `commands.rs`:

```rust
#[tauri::command(async)]
pub fn stop_meeting(app: AppHandle, state: State<'_, AppState>) -> Result<MeetingMeta, String> {
    match state.meeting_manager.begin_stop(app.clone()) {
        Ok(meta) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "processing".to_string(),
                    meeting_id: Some(meta.id.clone()),
                    message: None,
                    elapsed_secs: meta.duration_secs.map(|value| value.round() as u64),
                    file_size_bytes: meta.file_size_bytes,
                    progress_pct: None,
                },
            );
            let _ = app.emit("meetings-updated", ());
            Ok(meta)
        }
        Err(error) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "error".to_string(),
                    meeting_id: None,
                    message: Some(error.clone()),
                    elapsed_secs: None,
                    file_size_bytes: None,
                    progress_pct: None,
                },
            );
            let _ = app.emit("meetings-updated", ());
            Err(error)
        }
    }
}
```

And `start_meeting` (commands.rs:176): `#[tauri::command]` → `#[tauri::command(async)]`. Body unchanged. `main.rs` needs no change (command names unchanged).

- [ ] **Step 7.5: Run the full suite**

Run: `/mnt/c/Users/user/.cargo/bin/cargo.exe test`
Expected: all pass (≈68). Then `/mnt/c/Users/user/.cargo/bin/cargo.exe check` — no warnings about dead code (old `stop()` fully removed).

- [ ] **Step 7.6: Commit**

```bash
git add -A src-tauri/src && git commit -m "feat(meeting): finalize recordings in background with processing status"
```

---

### Task 8: Frontend types + pill

**Files:**
- Modify: `src/types.ts:71` (MeetingStatus), `:123-130` (MeetingUpdate)
- Modify: `src/App.tsx:319` (listener)

- [ ] **Step 8.1: Implement `types.ts`**

```ts
export type MeetingStatus = 'recording' | 'processing' | 'recorded' | 'error';
```

In `MeetingUpdate`: extend the `state` union with `'processing'` and add the field:

```ts
  state: 'recording' | 'processing' | 'stopped' | 'log' | 'error' | 'transcribing' | 'transcribed' | 'transcription_error';
  progress_pct?: number;
```

- [ ] **Step 8.2: Pill — treat `processing` as "recording is over"** — `App.tsx:319`:

```ts
      } else if (payload.state === 'stopped' || payload.state === 'processing') {
```
(body of the branch unchanged — clears meeting state, returns to idle; idempotent under repeated progress events).

- [ ] **Step 8.3: Verify**

Run: `cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit && npm run build`
Expected: no type errors; vite build succeeds.

- [ ] **Step 8.4: Commit**

```bash
git add src/types.ts src/App.tsx && git commit -m "feat(ui): handle processing meeting state in pill"
```

---

### Task 9: Settings window — saving state, toasts, progress bar

**Files:**
- Modify: `src/SettingsApp.tsx` (signal `~:374`, listener `:663-688`, prop site `:805`)
- Modify: `src/components/Settings/MeetingsPage.tsx` (props `:28`, labels `:99-120`, badge `:500`, gates `:181-193`, `:548-577`)
- Modify: `src/style.css` (indeterminate keyframes)

- [ ] **Step 9.1: SettingsApp — signal + stop handler + listener**

Add near the other meeting signals:

```ts
  const [processingMeetings, setProcessingMeetings] = createSignal<Record<string, number | null>>({});
```

In `stopMeetingRecording` (`:374`): replace `notifySuccess('Meeting recording saved.');` with `notifyInfo('Saving recording…');` (keep `upsertMeetingMeta`/select/detail-load/`loadMeetings` as is).

In the `meeting:update` listener (`:663`), after the `if (!id) return;` guard, add BEFORE the `transcribing` branch:

```ts
      if (payload.state === 'processing') {
        setProcessingMeetings((current) => ({ ...current, [id]: payload.progress_pct ?? null }));
        setMeetings((current) =>
          current.map((meeting) => (meeting.id === id ? { ...meeting, status: 'processing' as const } : meeting))
        );
        setSelectedMeeting((current) =>
          current?.meta.id === id
            ? { ...current, meta: { ...current.meta, status: 'processing' as const } }
            : current
        );
      } else if (payload.state === 'stopped') {
        setProcessingMeetings((current) => {
          const { [id]: _removed, ...rest } = current;
          return rest;
        });
        notifySuccess('Meeting recording saved.');
        void loadMeetings();
        if (selectedMeetingId() === id) void loadMeetingDetail(id);
      } else if (payload.state === 'error') {
        setProcessingMeetings((current) => {
          const { [id]: _removed, ...rest } = current;
          return rest;
        });
        notifyError(payload.message ?? 'Failed to save meeting recording.');
        void loadMeetings();
        if (selectedMeetingId() === id) void loadMeetingDetail(id);
      } else if (payload.state === 'transcribing') {
        // ... existing branches unchanged
```

(`'log'` events keep falling through — no branch matches them, same as today.)

Pass the accessor at the `<MeetingsPage` site (`:805`): `processingMeetings={processingMeetings}`.

- [ ] **Step 9.2: MeetingsPage — props, labels, badge**

Props type (`:28`): add `processingMeetings: Accessor<Record<string, number | null>>;`

`transcriptStatusLabel` (`:99`): insert before the `'recording'` line:

```ts
  if (meeting.status === 'processing') return 'Saving';
```

`statusClass` (`:108`): add:

```ts
  if (label === 'Saving') {
    return 'border-sky-400/35 bg-sky-500/10 text-sky-300';
  }
```

Badge (`:500-502`) — append the live percentage:

```tsx
                          <span class={`shrink-0 border px-2 py-0.5 text-[10px] font-mono uppercase ${statusClass(meeting)}`}>
                            {transcriptStatusLabel(meeting)}
                            {meeting.status === 'processing' && props.processingMeetings()[meeting.id] != null
                              ? ` ${Math.floor(props.processingMeetings()[meeting.id]!)}%`
                              : ''}
                          </span>
```

- [ ] **Step 9.3: MeetingsPage — playback gate + progress bar**

`selectedSourceUrl` (`:183`):

```ts
    if (
      !meeting ||
      meeting.meta.status === 'recording' ||
      meeting.meta.status === 'processing' ||
      !meeting.meta.file_size_bytes
    ) {
      return '';
    }
```

Add inside the component (near `selectedSourceUrl`):

```ts
  const selectedProcessingPct = createMemo(() => {
    const meeting = props.selectedMeeting();
    if (!meeting || meeting.meta.status !== 'processing') return null;
    return props.processingMeetings()[meeting.meta.id] ?? null;
  });
```

Replace the playback fallback block (`:552-564`) with:

```tsx
                      <div class="h-full flex items-center justify-center px-6 text-center">
                        <div class="w-full max-w-xs">
                          <p class="text-sm font-medium text-zinc-300">
                            {meeting().meta.status === 'recording'
                              ? 'Recording in progress'
                              : meeting().meta.status === 'processing'
                                ? 'Saving recording…'
                                : 'Recording file is not ready'}
                          </p>
                          <p class="mt-1 text-xs text-zinc-500">
                            {meeting().meta.status === 'recording'
                              ? 'Playback will appear after the meeting is stopped.'
                              : meeting().meta.status === 'processing'
                                ? 'Mixing and saving the audio. Playback will appear when finished.'
                                : 'The saved source file has no playable media yet.'}
                          </p>
                          <Show when={meeting().meta.status === 'processing'}>
                            <div class="mt-4 h-1 w-full overflow-hidden rounded-full bg-white/10">
                              <div
                                class={`h-full rounded-full bg-primary ${
                                  selectedProcessingPct() == null
                                    ? 'w-2/5 meeting-progress-indeterminate'
                                    : 'w-full origin-left transition-transform duration-300'
                                }`}
                                style={
                                  selectedProcessingPct() != null
                                    ? { transform: `scaleX(${selectedProcessingPct()! / 100})` }
                                    : undefined
                                }
                              />
                            </div>
                          </Show>
                        </div>
                      </div>
```

(`createMemo` is already imported in this file; verify `Show` is too — both are used elsewhere in it.)

- [ ] **Step 9.4: style.css — indeterminate animation (transform-only, per house rules)**

```css
/* Meetings: indeterminate saving bar (compositor-safe: transform only) */
.meeting-progress-indeterminate {
  animation: meeting-progress-slide 1.4s ease-in-out infinite;
}

@keyframes meeting-progress-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}
```

- [ ] **Step 9.5: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 9.6: Commit**

```bash
git add src/SettingsApp.tsx src/components/Settings/MeetingsPage.tsx src/style.css && git commit -m "feat(ui): show saving progress for finalizing meetings"
```

---

### Task 10: Full verification + handoff

- [ ] **Step 10.1: Full automated verification**

```bash
cd /mnt/c/Users/user/Documents/work/dikt/src-tauri && /mnt/c/Users/user/.cargo/bin/cargo.exe test && /mnt/c/Users/user/.cargo/bin/cargo.exe check
cd /mnt/c/Users/user/Documents/work/dikt && npx tsc --noEmit && npm run build
```
Expected: all tests pass (≈68), check clean, tsc clean, build succeeds.

- [ ] **Step 10.2: Commit the plan document** (if not already committed)

```bash
git add docs/superpowers/plans/2026-06-10-meeting-stop-freeze-fix.md && git commit -m "docs(plans): add meeting stop freeze fix implementation plan"
```

- [ ] **Step 10.3: Manual verification (maintainer, on Windows — cannot be automated here)**

1. **Long recording:** record 30–60 min with mic + system audio (± video) → stop → app stays responsive immediately; pill returns to idle; Meetings page shows "Saving… N%" badge and a moving bar → completes with "Meeting recording saved."; file plays; `transcript-audio.m4a` exists in the meeting folder; Transcribe works.
2. **Back-to-back:** stop a recording, immediately start a new one → both complete correctly.
3. **Crash safety:** kill the app (Task Manager) mid-"Saving…" → relaunch → that meeting shows Error status; app healthy.
4. **Short recording:** <2 min → saves near-instantly, no regression.
5. **No system audio:** mic-only recording → indeterminate "Saving…" (no percentages — expected), quick completion.
