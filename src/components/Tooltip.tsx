import { Show } from 'solid-js';
import { Motion, Presence } from 'solid-motionone';
import type { HotkeyMode } from '../types';
import { formatHotkey } from './Pill';
import GearButton from './Pill/GearButton';

type TooltipProps = {
  visible: boolean;
  hotkey: string;
  hotkeyMode: HotkeyMode;
  onSettingsClick: () => void;
};

export default function Tooltip(props: TooltipProps) {
  return (
    <Presence>
      <Show when={props.visible}>
        <Motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
          class="tooltip visible"
        >
          <span>
            {props.hotkeyMode === 'hold' ? 'Hold to talk: ' : 'Press to toggle: '}
            <strong>{formatHotkey(props.hotkey)}</strong>
          </span>
          <GearButton onClick={props.onSettingsClick} />
        </Motion.div>
      </Show>
    </Presence>
  );
}
