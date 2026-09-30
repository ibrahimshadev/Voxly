import type { HotkeyMode } from '../types';
import { formatHotkey } from '../lib/hotkey';
import GearButton from './Pill/GearButton';

type TooltipProps = {
  visible: boolean;
  hotkey: string;
  hotkeyMode: HotkeyMode;
  onSettingsClick: () => void;
};

export default function Tooltip(props: TooltipProps) {
  return (
    <div
      class="tooltip"
      classList={{ visible: props.visible }}
    >
      <span>
        {props.hotkeyMode === 'hold' ? 'Hold to talk: ' : 'Press to toggle: '}
        <strong>{formatHotkey(props.hotkey, true)}</strong>
      </span>
      <GearButton onClick={props.onSettingsClick} />
    </div>
  );
}
