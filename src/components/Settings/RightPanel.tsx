import { For } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Mode, Tab } from '../../types';
import { DEFAULT_MODES, MODE_COLORS, MODE_ICONS } from '../../defaultModes';

export type HistoryStats = {
  filteredCount: number;
  totalCount: number;
  todayCount: number;
  weekCount: number;
  latestAt: number | null;
  totalAudioSecs: number;
  averageAudioSecs: number;
};

type RightPanelProps = {
  activeTab: Accessor<Tab>;
  modes: Accessor<Mode[]>;
  activeModeId: Accessor<string | null>;
  onSetActiveModeId: (id: string | null) => void;
};

const PANEL_MODE_IDS = ['clean-draft', 'email-composer', 'developer-log'] as const;

const promptPreview = (systemPrompt: string): string => {
  const firstLine = systemPrompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
};

function SettingsPanel(props: RightPanelProps) {
  const panelModes = () =>
    PANEL_MODE_IDS.map((id) =>
      props.modes().find((mode) => mode.id === id) ?? DEFAULT_MODES.find((mode) => mode.id === id)!
    );

  return (
    <div class="p-6 flex-1 flex flex-col h-full">
      {/* AI Configuration Heading */}
      <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-0.5">
        AI Configuration
      </h2>
      <p class="text-xs text-gray-500 leading-relaxed mb-5">
        Click a mode to activate it. Click the active mode again to deactivate it.
      </p>

      {/* Transcription Modes */}
      <div class="space-y-3 mb-8">
        <For each={panelModes()}>
          {(mode) => {
            const isActive = () => props.activeModeId() === mode.id;
            const modeColor = MODE_COLORS[mode.id] ?? { bg: 'bg-primary/10', text: 'text-primary' };
            const icon = MODE_ICONS[mode.id] ?? 'tune';
            return (
              <button
                type="button"
                onClick={() => props.onSetActiveModeId(isActive() ? null : mode.id)}
                class={`relative p-4 rounded-xl border cursor-pointer group transition-colors ${
                  isActive()
                    ? 'border-primary bg-primary/5 shadow-[0_0_20px_rgba(16,183,127,0.05)]'
                    : 'border-white/5 bg-surface-dark hover:border-white/10'
                }`}
              >
                <div class="flex justify-between items-start mb-1">
                  <span class={`font-semibold transition-colors text-left ${isActive() ? 'text-white group-hover:text-primary' : 'text-gray-300 group-hover:text-white'}`}>
                    {mode.name}
                  </span>
                  <span class={`material-symbols-outlined text-[18px] ${modeColor.bg} ${modeColor.text} rounded-md px-1.5 py-0.5`}>
                    {icon}
                  </span>
                </div>
                <p class={`text-xs leading-relaxed text-left ${isActive() ? 'text-gray-400' : 'text-gray-500'}`}>
                  {promptPreview(mode.system_prompt)}
                </p>
              </button>
            );
          }}
        </For>
      </div>

      {/* Enhancements */}
      <div class="mb-auto">
        <h3 class="text-xs font-semibold text-gray-500 mb-4 px-1">ENHANCEMENTS</h3>
        <div class="bg-surface-dark rounded-xl border border-white/5 p-4 space-y-4">
          {/* Auto-Punctuation */}
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-300">Auto-Punctuation</span>
            <label class="relative inline-flex items-center cursor-pointer">
              <input checked type="checkbox" class="sr-only peer" />
              <div class="w-9 h-5 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:bg-primary" />
            </label>
          </div>

          {/* Vocabulary Boost */}
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-300">Vocabulary Boost</span>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" class="sr-only peer" />
              <div class="w-9 h-5 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:bg-primary" />
            </label>
          </div>
        </div>
      </div>

      {/* Mic Visualizer */}
      <div class="mt-8 pt-6 border-t border-white/5 pb-2">
        <div class="flex justify-between items-center mb-2">
          <span class="text-xs font-mono text-primary font-bold tracking-widest uppercase animate-pulse">
            Live Input
          </span>
          <span class="material-symbols-outlined text-primary text-[16px]">mic_off</span>
        </div>
        <div class="h-16 w-full bg-input-bg rounded-lg border border-white/10 flex items-center justify-center gap-[2px] overflow-hidden px-4">
          <div class="w-1 bg-primary/20 h-3 rounded-full" />
          <div class="w-1 bg-primary/30 h-5 rounded-full" />
          <div class="w-1 bg-primary/50 h-8 rounded-full" />
          <div class="w-1 bg-primary h-4 rounded-full" />
          <div class="w-1 bg-primary h-7 rounded-full" />
          <div class="w-1 bg-primary h-10 rounded-full" />
          <div class="w-1 bg-primary h-6 rounded-full" />
          <div class="w-1 bg-primary h-3 rounded-full" />
          <div class="w-1 bg-primary h-8 rounded-full" />
          <div class="w-1 bg-primary h-12 rounded-full" />
          <div class="w-1 bg-primary h-6 rounded-full" />
          <div class="w-1 bg-primary h-4 rounded-full" />
          <div class="w-1 bg-primary h-9 rounded-full" />
          <div class="w-1 bg-primary h-2 rounded-full" />
          <div class="w-1 bg-primary/50 h-5 rounded-full" />
          <div class="w-1 bg-primary/30 h-3 rounded-full" />
          <div class="w-1 bg-primary/20 h-2 rounded-full" />
        </div>
        <div class="flex justify-between mt-2 px-1">
          <span class="text-[10px] text-gray-600 font-mono">-60dB</span>
          <span class="text-[10px] text-gray-600 font-mono">0dB</span>
        </div>
      </div>
    </div>
  );
}

export default function RightPanel(props: RightPanelProps) {
  return <SettingsPanel {...props} />;
}
