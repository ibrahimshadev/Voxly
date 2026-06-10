# Design: Dictation while a meeting is recording (combined pill)

**Date:** 2026-06-10
**Status:** Draft — maintainer-approved design; awaiting spec review + sign-off before the implementation plan.
**App version at time of writing:** 1.22.0 released; local main additionally carries the unreleased meeting-stop-freeze fix (see `2026-06-10-meeting-stop-freeze-fix-design.md`).

---

## 1. Context & problem

dikt's core feature is hotkey dictation (Ctrl+Space by default): record mic → transcribe → format → paste into the focused app. The meeting recorder is a separate subsystem (FFmpeg + WASAPI). Today the two are mutually exclusive **by frontend guard only**: while a meeting records, the dictation hotkey is dead.

The maintainer wants to dictate during meetings (e.g., dictate a chat reply mid-call), with the pill showing **both** indicators side by side — meeting dot + timer on the left, a compact dictation waveform on the right — the pill snapping a little wider while both are active.

### What blocks it today (all frontend; verified)

- `src/App.tsx:26` — `isMeetingBusy = () => meetingActive() || status() === 'meeting'`.
- `App.tsx:79` (`handlePressed`) and `:128` (`handleReleased`) — the dictation hotkey handlers early-return when `isMeetingBusy()`.
- `App.tsx:251` — the `dictation:update` backend-event listener drops all dictation state events during meetings.
- Root architectural cause: the meeting occupies the **dictation status machine** — `status` has a `'meeting'` value, and the per-second `meeting:update` tick calls `setStatus('meeting')` (`App.tsx:311-318`), which would stomp any concurrent dictation state.

The guards were added with the original meeting feature (commit `aab1b71`) for simplicity — not as a workaround for any real conflict.

### Why concurrent capture is safe (no backend change needed)

- Dictation captures the **default input device** via cpal/WASAPI **shared mode** (`src-tauri/src/audio.rs:131-141`).
- The meeting mic is captured by a separate FFmpeg process (dshow, shared mode); system audio is WASAPI *render* loopback — it never touches the mic.
- Windows shared-mode audio supports multiple concurrent captures of the same endpoint (Teams + OBS pattern).
- `start_recording` / `stop_and_transcribe` and the whole `domain`/`audio` backend have **zero** meeting awareness (grep-verified) — if the frontend allows it, the backend just works.
- Click-through/hover: the Rust cursor tracker consumes hit rects **sent from the frontend** (`click_through/windows.rs:42,:100` via `update_hit_region`, `commands.rs:27`) — a wider pill is purely a frontend rect change.

## 2. Decision summary

Locked by the maintainer.

| Decision | Choice |
|---|---|
| State model | **Two independent axes** (approach B): `status` returns to dictation-only — `'meeting'` is **removed** from the `Status` union; the meeting indicator renders from the existing `meetingActive`/`meetingElapsed` signals. Rejected: keeping `'meeting'` as a pseudo-status (every removed guard would need compensating special cases against the per-second tick). |
| Combined pill | Meeting indicator (● REC + timer) left, **compact dictation wave** right, 1px divider between. Pill snaps to **~184px** min-width (vs 118 meeting-only, 90 dictation-only, 48 idle), height stays 28px. |
| Width changes | **Discrete snap on state change** — same as the existing 48→90→118 jumps. NO width/height transitions, ever (WebView2 transparent-window constraint; `style.css:96` transitions only background/border-color/border-radius and stays that way). Section entrances animate with opacity/transform only. |
| Compact wave | `SineWaves` gains optional `width`/`height` props (defaults 90×35, `SineWaves.tsx:12-13`); combined state uses **~52×24** with reduced amplitude (~3). The maintainer explicitly OK'd a smaller wave for this state. |
| Backend | **No Rust changes.** Frontend-only feature. |
| Reverse direction | Starting a **meeting** while dictating stays blocked with the existing message (`App.tsx:166-169`) — YAGNI. Stopping a meeting while dictating works naturally. |
| Audio overlap | Dictated speech is audible in the meeting recording (same mic) — accepted, inherent. |
| Window | Never resized; fixed 360×100. 184px pill fits with room to spare. |

## 3. State model — `src/App.tsx`, `src/types.ts`

### 3.1 `Status` union (`types.ts:1`)

`'meeting'` removed: `'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'done' | 'error'`. `status` means dictation only. (The unrelated `DictationUpdate.state` union at `types.ts:66` is already meeting-free; untouched.)

### 3.2 `App.tsx` signal/derivation changes

- `isMeetingBusy()` (`:26`) — **deleted**; nothing may gate dictation on meetings anymore.
- `isActive()` (`:20-25`) — drops the `status() === 'meeting'` arm and ORs in `meetingActive()`:
  `isActive = () => isDictating() || meetingActive()` where `isDictating()` covers `recording|transcribing|formatting|pasting`. Used for tooltip suppression (`:378`, `:406`) and hit-region height — semantics preserved.
- **One shared predicate for the dictation slot:** `dictationSlotVisible = () => status() !== 'idle'`. This single predicate drives BOTH the pill's `dictating` class (§4) and the combined hit-region width (§6). It deliberately includes `done` (1.5s checkmark) and `error` (error icon + gear): the pill stays at combined width through those moments so the checkmark renders in the slot and — critically — the interactive gear button remains inside the hit region (a 118px hit rect with error content would leave the gear click-through-dead, the exact failure the hit-region system exists to prevent).
- Guards deleted: `handlePressed:79`, `handleReleased:128`, `dictation:update` listener `:251`.
- **Stray meeting writes deleted from the dictation flow:** `handlePressed`'s toggle-start catch currently does `setMeetingActive(false); setMeetingElapsed(0)` (`App.tsx:119-120`) — unreachable during meetings today, but once the guards go, a failed `start_recording` mid-meeting would blank the meeting indicator for up to a second. Both lines are removed; dictation handlers must never write meeting signals (the "no cross-stomping" invariant runs both directions).

### 3.3 `meeting:update` listener (`:309-339`) — stops touching `status`

- `recording` tick: only `setMeetingActive(true)`, `setMeetingId`, `setMeetingElapsed`. **No `setStatus`.** The `lastStoppedMeetingId` resurrect-guard logic (`:312-315`) is preserved verbatim.
- `stopped`/`processing`: clear `meetingActive`/`meetingId`/`meetingElapsed` as today (`:319-324`); the `if (status() === 'meeting') setStatus('idle')` line is deleted (no longer meaningful).
- `error`: clears meeting state and surfaces the message as today (`:325-331`), but must **not** clobber an in-flight dictation's status — set error status only when dictation is idle; otherwise show the message via the error signal alone. (Meeting save errors also surface as toasts in Settings.)
- `toggleMeetingRecording` stop path (`:148-163`): both status writes become conditional on dictation being idle — the `setStatus('idle')` on success AND the `setStatus('error')` in its catch (`:160`, `stop_meeting` failing mid-dictation must not clobber the dictation state; the error signal still carries the message).
- `toggleMeetingRecording` start path: the `setStatus('meeting')` at `:193` is deleted (tsc forces this once the union changes); meeting start sets only the meeting signals.

### 3.4 Hotkey flows

- Toggle and hold mode both work during meetings — the handlers lose their early-returns and the stray meeting writes (§3.2); `isHolding` logic unchanged.
- Dictation completion (`done` → 1.5s checkmark → `idle`) is unchanged; with `meetingActive` still true, the pill renders meeting-only after the checkmark.

## 4. Pill rendering — `src/components/Pill/Pill.tsx`

New prop: `meetingActive: Accessor<boolean>` (alongside the existing `meetingElapsed`).

```
idle:        (  ⋯ )                                    48 × 20
dictating:   (  ∿∿∿∿∿  )                               90 × 28
meeting:     (  ● REC 12:34  )                        118 × 28
combined:    (  ● REC 12:34  │  ∿∿∿  )               ~184 × 28
```

- **Meeting section** (`meeting-indicator`, dot/REC/timer — markup unchanged) renders when `props.meetingActive()`, no longer when `status === 'meeting'`.
- **Dictation section** renders per `status` exactly as today (SineWaves / LoadingDots / checkmark / error+gear), in a slot that sits right of the meeting section when both are visible. `IdleDots` renders only when `status === 'idle' && !meetingActive()`.
- `classList`: `meeting: props.meetingActive()`, `dictating: props.status() !== 'idle'` (the §3.2 shared predicate — includes `done` and `error`). Only the `.pill.meeting.dictating` combination has CSS, so the `dictating` class alone is inert. The `recording/transcribing/error` classes stay keyed off `status`.
- **Compact wave:** `SineWaves` accepts `width?: number; height?: number; amplitude?: number` (defaults 90/35/4). Combined state renders `<SineWaves width={52} height={24} amplitude={3} />`. siriwave takes these as plain config (`SineWaves.tsx:10-18`); the container div sizes to match.
- Divider: `border-left: 1px solid rgba(255,255,255,0.12)` + padding on the dictation slot, only in the combined state.
- Both sections may mount/unmount on state change — this matches the pill's existing per-state `<Show>` pattern (infrequent, discrete state changes are the blessed case; the WebView2 rule forbids *hover-driven* churn and *animated layout*, not state snaps).

## 5. CSS — `src/style.css`

- `.pill.meeting.dictating { min-width: 184px; }` (after `.pill.meeting` at `:122`).
- Dictation-slot divider class (combined state only).
- **No change** to the transition list at `:96` (background/border-color/border-radius only). No width/height/padding transitions anywhere. Optional entrance polish on the slot contents: opacity/transform with the same pattern the tooltip uses.

## 6. Hit region — `App.tsx:354-387`

`pillW` (`:365`) becomes (using the §3.2 shared predicate, NOT `isDictating()` — `done`/`error` must keep the wide rect):
```ts
const pillW = meetingActive() && dictationSlotVisible() ? 184 : meetingActive() ? 118 : active ? 90 : 48;
```
`pillH` logic unchanged (active → 28). The effect already tracks these signals reactively and re-invokes `update_hit_region`; the Rust cursor tracker follows the frontend rects — **no Rust change**.

## 7. Edge cases

| Case | Behavior |
|---|---|
| Dictation completes during meeting | Checkmark 1.5s in the dictation slot at combined width (the shared predicate includes `done`) → pill snaps back to meeting-only (118px) when status returns to `idle`. |
| Meeting stopped (hotkey or Settings) mid-dictation | Meeting section disappears (`processing` event clears `meetingActive`); dictation continues at 90px. |
| Dictation error during meeting | Error icon + gear in the dictation slot at combined width (gear stays inside the hit region); meeting keeps recording; clears as today. |
| `start_recording` fails mid-meeting (toggle-start catch) | Dictation error shown; meeting indicator untouched (stray meeting writes at App.tsx:119-120 are deleted, §3.2). |
| Meeting `error` event mid-dictation | Meeting state clears; error message shown without clobbering dictation status (§3.3). |
| Start meeting while dictating | Blocked with existing message (unchanged, `App.tsx:166-169`). |
| Hold-mode release after meeting ends mid-dictation | Unaffected — release path keyed off `isHolding`, not meeting state. |
| Mic audio overlap | Dictated speech audible in the meeting recording — accepted. |
| Both states' per-second updates | Meeting tick updates only meeting signals; dictation events update only `status` — no cross-stomping by construction. |

## 8. Out of scope (v1)

- Starting a meeting while dictating.
- Any backend/Rust change; any change to recording, transcription, or paste behavior.
- Pill hover behavior changes; tooltip content changes.
- Live meeting transcription (separate idea, not this feature).

## 9. Testing

No Rust surface → no new Rust tests. Frontend verification:
- `npx tsc --noEmit` (the `Status` union change makes the compiler enumerate every `'meeting'` reference — the refactor is type-driven and complete only when tsc is clean) + `npm run build`.
- Manual (maintainer, Windows):
  1. Start meeting → Ctrl+Space dictation (toggle mode) → combined pill, timer keeps ticking, wave animates, text pastes into focused app; checkmark → back to meeting-only.
  2. Same in hold mode.
  3. Stop meeting mid-dictation (meeting hotkey) → dictation continues alone.
  4. Dictation error during meeting (e.g., no provider key) → error in slot, meeting unaffected.
  5. Dictation alone and meeting alone — unchanged appearance/behavior.
  6. Repeated dictations during one meeting → no pill rendering drift (WebView2 regression check).
  7. Meeting recording playback: dictated speech audible (expected).

## 10. File-by-file change list

**Modified — Frontend only**
- `src/types.ts` — remove `'meeting'` from `Status`.
- `src/App.tsx` — delete `isMeetingBusy` + 3 guards; delete stray meeting writes in `handlePressed`'s catch (:119-120); add `dictationSlotVisible`; rework `isActive`; meeting listener stops touching `status`; conditional status writes in meeting stop/error paths (:160, :163 area) and deleted `setStatus('meeting')` (:193, :318); combined-width hit region; pass `meetingActive` to `<Pill>`.
- `src/components/Pill/Pill.tsx` — `meetingActive` prop; meeting section keyed off it; dictation slot beside it; compact wave in combined state.
- `src/components/Pill/SineWaves.tsx` — optional `width`/`height`/`amplitude` props.
- `src/style.css` — `.pill.meeting.dictating` width; divider; no transition changes.

**No Rust changes. No new dependencies. No DB/schema/events changes.**
