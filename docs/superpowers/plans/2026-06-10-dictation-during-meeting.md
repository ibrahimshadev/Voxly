# Dictation During Meeting (Combined Pill) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+Space dictation works while a meeting records; the pill shows meeting timer + compact waveform side by side at ~184px.

**Architecture:** Frontend-only, two-axis state model: `'meeting'` is removed from the dictation `Status` union; the meeting indicator renders from the existing `meetingActive`/`meetingElapsed` signals. The pill becomes a pure function of both axes. One shared predicate (`status() !== 'idle'`) drives both the combined-width CSS class and the click-through hit region. Zero Rust changes.

**Tech Stack:** SolidJS + TypeScript, siriwave, CSS (WebView2 transparent-window constraints: discrete width snaps only, never animated layout).

**Spec:** `docs/superpowers/specs/2026-06-10-dictation-during-meeting-design.md` — read fully first; §3.2's shared predicate and the stray-write deletions are load-bearing.

---

## Environment

- Frontend-only: verification is `npx tsc --noEmit` (fast, from repo root `/mnt/c/Users/user/Documents/work/dikt`) per task, plus one `npm run build` at the end (vite, ~4–6 min on /mnt/c — run in background). No Rust changes → no cargo runs needed.
- The Status-union change makes tsc enumerate every `'meeting'` status reference; the refactor is complete only when tsc is clean. Find them up front with: `grep -rn "'meeting'" src/App.tsx src/components/Pill/Pill.tsx src/types.ts`
- **Line references below were re-verified against main at `0381170`** (after the AI-summary commits landed). If main moves again before execution, re-verify with the greps given in each step.
- Conventional commits, matching repo history.

---

### Task 0: Branch

- [ ] **Step 0.1:**

```bash
cd /mnt/c/Users/user/Documents/work/dikt && git checkout -b feat/dictation-during-meeting && npx tsc --noEmit
```
Expected: branch created; tsc clean baseline.

---

### Task 1: `SineWaves` size props

**Files:**
- Modify: `src/components/Pill/SineWaves.tsx` (whole file is 27 lines)

- [ ] **Step 1.1: Add optional `width`/`height`/`amplitude` props**

Replace the component with:

```tsx
import { onMount, onCleanup } from 'solid-js';
import SiriWave from 'siriwave';

type SineWavesProps = {
  width?: number;
  height?: number;
  amplitude?: number;
};

export default function SineWaves(props: SineWavesProps) {
  let container: HTMLDivElement | undefined;
  let wave: SiriWave | undefined;

  onMount(() => {
    if (container) {
      wave = new SiriWave({
        container,
        width: props.width ?? 90,
        height: props.height ?? 35,
        style: 'ios9',
        speed: 0.06,
        amplitude: props.amplitude ?? 4,
        autostart: true,
      });
    }
  });

  onCleanup(() => {
    wave?.dispose();
  });

  return <div ref={container} class="sine-waves-container" />;
}
```

Props are read once in `onMount` — siriwave's canvas is sized at construction. That is fine: the wave mounts fresh on each dictation, and in Task 2's structure the compact/full variants are separate `<Show>` children, so when the meeting stops mid-dictation Solid swaps to a freshly mounted full-size wave immediately (matches spec §7; do not "fix" the remount if observed in manual testing).

- [ ] **Step 1.2: Verify + commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/components/Pill/SineWaves.tsx && git commit -m "feat(ui): add size props to dictation sine wave"
```

---

### Task 2: Two-axis state model + combined pill

**Files:**
- Modify: `src/types.ts:1`
- Modify: `src/App.tsx` (`:20-26`, `:79`, `:117-123`, `:128`, `:148-169`, `:190-197`, `:251`, `:309-339`, `:365`, `:412-418`)
- Modify: `src/components/Pill/Pill.tsx` (whole file)
- Modify: `src/style.css` (append after `.pill.meeting` block at `:122-125`)

These change together in one commit — the union change breaks every `'meeting'` reference at once, and intermediate states don't compile.

- [ ] **Step 2.1: `types.ts` — remove `'meeting'` from `Status`** (line 1)

```ts
export type Status = 'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'done' | 'error';
```

- [ ] **Step 2.2: Run tsc to enumerate the breakage**

Run: `npx tsc --noEmit 2>&1 | grep "error TS"`
Expected: errors in exactly `src/App.tsx` and `src/components/Pill/Pill.tsx` (the union member no longer exists). This is the worklist for the next steps.

- [ ] **Step 2.3: `App.tsx` — predicates (`:20-26`)**

Replace:
```ts
  const isActive = () =>
    status() === 'recording' ||
    status() === 'transcribing' ||
    status() === 'formatting' ||
    status() === 'pasting' ||
    status() === 'meeting';
  const isMeetingBusy = () => meetingActive() || status() === 'meeting';
```
with:
```ts
  const isDictating = () =>
    status() === 'recording' ||
    status() === 'transcribing' ||
    status() === 'formatting' ||
    status() === 'pasting';
  // Shared predicate (spec §3.2): drives BOTH the pill's `dictating` class and
  // the combined hit-region width. Includes 'done' and 'error' so the checkmark
  // and the error gear render inside the wide pill's hit region.
  const dictationSlotVisible = () => status() !== 'idle';
  const isActive = () => isDictating() || meetingActive();
```

- [ ] **Step 2.4: `App.tsx` — delete the dictation guards and stray meeting writes**

1. `handlePressed` (`:79` area): delete the line `if (isMeetingBusy()) return;`
2. Toggle-start catch (`:117-123`): delete the two stray meeting writes —
```ts
      } catch (err) {
        setMeetingActive(false);   // ← DELETE
        setMeetingElapsed(0);      // ← DELETE
        setStatus('error');
        setError(String(err));
      }
```
3. `handleReleased` (`:128` area): delete the line `if (isMeetingBusy()) return;`
4. `dictation:update` listener (`:251` area): delete the line `if (isMeetingBusy()) return;`

- [ ] **Step 2.5: `App.tsx` — `toggleMeetingRecording` (`:147-198`)**

Stop path: the `if (isMeetingBusy()) {` becomes `if (meetingActive()) {`; meeting-signal resets stay; status writes follow spec §3.3:

```ts
    if (meetingActive()) {
      try {
        const meta = await invoke<MeetingMeta>('stop_meeting');
        lastStoppedMeetingId = meta.id;
        setMeetingActive(false);
        setMeetingId(null);
        setMeetingElapsed(0);
      } catch (err) {
        setMeetingActive(false);
        setMeetingId(null);
        setMeetingElapsed(0);
        if (!isDictating()) setStatus('error');
        setError(String(err));
      }
      return;
    }
```
(The success-path `setStatus('idle')` is deleted outright: in the new model status is dictation-only, so the only state the old write could legally apply to is already `'idle'`. The catch keeps an error display unless a dictation is actively running.)

Start-block guard (`:166`): `if (isActive())` still compiles and keeps its meaning (dictating OR meeting) — leave it; the meeting-already-active case is handled by the stop path above. Start success (`:188-197`): delete only the `setStatus('meeting');` line — `lastStoppedMeetingId = null; setError(''); setMeetingActive(true); setMeetingId(meta.id); setMeetingElapsed(0);` all stay.

- [ ] **Step 2.6: `App.tsx` — `meeting:update` listener (`:309-339`)**

- `recording` branch: delete `setStatus('meeting');` (everything else — resurrect guards, `setMeetingId`, `lastStoppedMeetingId = null`, `setMeetingActive(true)`, `setMeetingElapsed(...)` — stays verbatim).
- `stopped`/`processing` branch: delete `if (status() === 'meeting') setStatus('idle');` (meeting-signal resets stay).
- `error` branch: replace `setStatus('error');` with `if (!isDictating()) setStatus('error');` (the `setError(...)` stays unconditional).

- [ ] **Step 2.7: `App.tsx` — hit region (`:365`) and Pill prop (`:412-418`)**

```ts
    const pillW = meetingActive() && dictationSlotVisible() ? 184
      : meetingActive() ? 118
      : active ? 90
      : 48;
```
(NOT `isDictating()` — `done`/`error` must keep the wide rect, spec §6.) `pillH` line unchanged.

Pill call site gains the prop:
```tsx
        <Pill
          status={status}
          error={error}
          meetingActive={meetingActive}
          meetingElapsed={meetingElapsed}
          onMouseDown={startDrag}
          onSettingsClick={toggleSettingsWindow}
        />
```

- [ ] **Step 2.8: `Pill.tsx` — render both axes**

Replace the component body (props type + JSX; `formatHotkey` and `meetingTime` helpers unchanged):

```tsx
type PillProps = {
  status: Accessor<Status>;
  error: Accessor<string>;
  meetingActive: Accessor<boolean>;
  meetingElapsed?: Accessor<number>;
  onMouseDown: (e: MouseEvent) => void;
  onSettingsClick: () => void;
};
```

```tsx
  return (
    <div
      class="pill"
      classList={{
        recording: props.status() === 'recording',
        transcribing: props.status() === 'transcribing' || props.status() === 'formatting' || props.status() === 'pasting',
        meeting: props.meetingActive(),
        dictating: props.status() !== 'idle',
        error: props.status() === 'error',
      }}
      onMouseDown={props.onMouseDown}
    >
      <Show when={props.status() === 'idle' && !props.meetingActive()}>
        <IdleDots />
      </Show>

      <Show when={props.meetingActive()}>
        <div class="meeting-indicator">
          <span class="meeting-dot" />
          <span class="meeting-label">REC</span>
          <span class="meeting-time">{meetingTime()}</span>
        </div>
      </Show>

      <Show when={props.status() !== 'idle'}>
        <div class="dictation-slot">
          <Show when={props.status() === 'recording'}>
            <Show
              when={props.meetingActive()}
              fallback={<SineWaves />}
            >
              <SineWaves width={52} height={24} amplitude={3} />
            </Show>
          </Show>

          <Show when={props.status() === 'transcribing' || props.status() === 'formatting' || props.status() === 'pasting'}>
            <LoadingDots />
          </Show>

          <Show when={props.status() === 'done'}>
            <svg class="check-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </Show>

          <Show when={props.status() === 'error'}>
            <span class="error-icon" title={props.error()}>!</span>
            <GearButton onClick={props.onSettingsClick} />
          </Show>
        </div>
      </Show>
    </div>
  );
```

Notes: the outer `dictation-slot` `<Show>` is the §3.2 shared predicate; the inner recording `<Show when={props.meetingActive()}>` picks the compact wave. The pre-existing `error` class still keys off status, so error-alone keeps today's 90×28 styling; the new `meeting`/`dictating` classes only combine in CSS.

- [ ] **Step 2.9: `style.css` — combined state (append after the `.pill.meeting` block at `:122-125`)**

```css
.pill.meeting.dictating {
  min-width: 184px;
}

.dictation-slot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pill.meeting .dictation-slot {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  padding-left: 8px;
}
```
Do NOT touch the transition list at `:96` — width/height stay snap-only (WebView2 rule).

- [ ] **Step 2.10: Verify**

Run: `npx tsc --noEmit`
Expected: clean — every former `'meeting'` status reference is gone. Double-check none survive:
`grep -rn "'meeting'" src/App.tsx src/components/Pill/Pill.tsx src/types.ts` → expected: zero hits (event names are `'meeting:update'`, which this pattern does not match).

- [ ] **Step 2.11: Commit**

```bash
git add src/types.ts src/App.tsx src/components/Pill/Pill.tsx src/style.css
git commit -m "feat(ui): allow dictation during meetings with combined pill"
```

---

### Task 3: Full verification + handoff

- [ ] **Step 3.1: Build**

Run (background): `npx tsc --noEmit && npm run build`
Expected: tsc clean; vite build succeeds.

- [ ] **Step 3.2: Commit the plan document**

```bash
git add docs/superpowers/plans/2026-06-10-dictation-during-meeting.md
git commit -m "docs(plans): add dictation-during-meeting implementation plan"
```

- [ ] **Step 3.3: Manual verification (maintainer, Windows — spec §9)**

1. Start meeting → Ctrl+Space dictation (toggle mode): combined pill `(● REC m:ss │ ∿∿∿)`, timer keeps ticking, paste lands in the focused app, checkmark holds the wide pill 1.5s, then meeting-only.
2. Same in hold mode.
3. Stop the meeting (meeting hotkey) mid-dictation → dictation continues alone at 90px.
4. Dictation error during meeting → error icon + gear inside the wide pill; gear is clickable; meeting unaffected.
5. Dictation alone and meeting alone — unchanged.
6. Several dictations during one meeting → no pill rendering drift (WebView2 regression check).
7. Meeting playback: dictated speech audible (expected).
