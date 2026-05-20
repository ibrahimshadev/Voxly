import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Status } from '../../types';
import IdleDots from './IdleDots';
import SineWaves from './SineWaves';
import LoadingDots from './LoadingDots';
import GearButton from './GearButton';

type PillProps = {
  status: Accessor<Status>;
  error: Accessor<string>;
  meetingElapsed?: Accessor<number>;
  onMouseDown: (e: MouseEvent) => void;
  onSettingsClick: () => void;
};

export function formatHotkey(hotkey: string): string {
  return hotkey
    .replace('Control+Super', 'Ctrl + Win')
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\+/g, ' + ');
}

export default function Pill(props: PillProps) {
  const meetingTime = () => {
    const total = props.meetingElapsed?.() ?? 0;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  return (
    <div
      class="pill"
      classList={{
        recording: props.status() === 'recording',
        transcribing: props.status() === 'transcribing' || props.status() === 'formatting' || props.status() === 'pasting',
        meeting: props.status() === 'meeting',
        error: props.status() === 'error',
      }}
      onMouseDown={props.onMouseDown}
    >
      <Show when={props.status() === 'idle'}>
        <IdleDots />
      </Show>

      <Show when={props.status() === 'recording'}>
        <SineWaves />
      </Show>

      <Show when={props.status() === 'transcribing' || props.status() === 'formatting' || props.status() === 'pasting'}>
        <LoadingDots />
      </Show>

      <Show when={props.status() === 'meeting'}>
        <div class="meeting-indicator">
          <span class="meeting-dot" />
          <span class="meeting-label">REC</span>
          <span class="meeting-time">{meetingTime()}</span>
        </div>
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
  );
}
