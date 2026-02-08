import { For, Show, onMount, onCleanup } from 'solid-js';
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

type AudioLevel = { rms_db: number; peak_db: number };

type RightPanelProps = {
  activeTab: Accessor<Tab>;
  modes: Accessor<Mode[]>;
  activeModeId: Accessor<string | null>;
  onSetActiveModeId: (id: string | null) => void;
  audioLevel: Accessor<AudioLevel | null>;
};

const PANEL_MODE_IDS = ['clean-draft', 'email-composer', 'developer-log'] as const;

// ── Visualizer constants ─────────────────────────────────────────────
const BAR_COUNT = 17;
const BAR_WEIGHTS = [
  0.25, 0.35, 0.5, 0.6, 0.75, 0.85, 0.9, 0.95, 1.0,
  0.95, 0.9, 0.85, 0.75, 0.6, 0.5, 0.35, 0.25,
];
const MIN_H = 2;
const MAX_H = 48;
const NOISE_GATE_DB = -42;   // dB below which ambient noise is suppressed
const ATTACK = 0.35;         // fast rise  (~120ms to peak at 60fps)
const DECAY  = 0.06;         // slow fall  (~800ms to rest at 60fps)

const promptPreview = (systemPrompt: string): string => {
  const firstLine = systemPrompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
};

// ── Live mic visualizer (rAF-driven, direct DOM) ─────────────────────
function MicVisualizer(props: { audioLevel: Accessor<AudioLevel | null> }) {
  const barRefs: HTMLDivElement[] = [];
  const heights = new Float32Array(BAR_COUNT);

  const isActive = () => props.audioLevel() !== null;

  onMount(() => {
    let rafId: number;

    const tick = () => {
      const al = props.audioLevel();
      const now = performance.now() / 1000;
      const recording = al !== null;

      // Normalize with noise gate
      let norm = 0;
      if (recording) {
        const db = al!.rms_db;
        const gated = db < NOISE_GATE_DB ? -60 : db;
        norm = Math.max(0, Math.min(1, (gated + 60) / 55));
      }

      for (let i = 0; i < BAR_COUNT; i++) {
        // Per-bar time-varying jitter for organic movement
        const phase = now * 9.5 + i * 1.4;
        const jitter = recording ? (0.78 + 0.22 * Math.sin(phase)) : 1;
        const target = norm * BAR_WEIGHTS[i] * jitter;

        // Spring dynamics
        const cur = heights[i];
        heights[i] = target > cur
          ? cur + (target - cur) * ATTACK
          : cur + (target - cur) * DECAY;

        const h = heights[i];
        const el = barRefs[i];
        if (!el) continue;

        el.style.height = `${MIN_H + (MAX_H - MIN_H) * h}px`;
        el.style.backgroundColor = `rgba(16, 183, 127, ${0.2 + 0.8 * h})`;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(rafId));
  });

  return (
    <div class="mt-8 pt-6 border-t border-white/5 pb-2">
      <div class="flex justify-between items-center mb-2">
        <Show
          when={isActive()}
          fallback={
            <span class="text-xs font-mono text-gray-500 font-bold tracking-widest uppercase">
              Microphone
            </span>
          }
        >
          <span class="text-xs font-mono text-primary font-bold tracking-widest uppercase animate-pulse">
            Live Input
          </span>
        </Show>
        <span class={`material-symbols-outlined text-[16px] ${isActive() ? 'text-primary' : 'text-gray-600'}`}>
          {isActive() ? 'mic' : 'mic_off'}
        </span>
      </div>
      <div class="h-16 w-full bg-input-bg rounded-lg border border-white/10 flex items-center justify-center gap-[2px] overflow-hidden px-4">
        {BAR_WEIGHTS.map((_, i) => (
          <div
            ref={(el) => { barRefs[i] = el; }}
            class="w-1 rounded-full"
            style={{
              height: `${MIN_H}px`,
              'background-color': 'rgba(16, 183, 127, 0.2)',
            }}
          />
        ))}
      </div>
      <div class="flex justify-between mt-2 px-1">
        <span class="text-[10px] text-gray-600 font-mono">-60dB</span>
        <span class="text-[10px] text-gray-600 font-mono">0dB</span>
      </div>
    </div>
  );
}

// ── Settings right panel ─────────────────────────────────────────────
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
      <div class="flex items-center justify-between mb-5">
        <p class="text-xs text-gray-500 leading-relaxed">
          Click a mode to activate. Click again to deactivate.
        </p>
        <Show when={props.activeModeId()}>
          <button
            type="button"
            onClick={() => props.onSetActiveModeId(null)}
            class="text-[11px] font-medium text-zinc-400 hover:text-white transition-colors cursor-pointer shrink-0 ml-3"
          >
            Deactivate
          </button>
        </Show>
      </div>

      {/* Transcription Modes */}
      <div class="space-y-3 mb-auto">
        <For each={panelModes()}>
          {(mode) => {
            const modeActive = () => props.activeModeId() === mode.id;
            const modeColor = MODE_COLORS[mode.id] ?? { bg: 'bg-primary/10', text: 'text-primary' };
            const icon = MODE_ICONS[mode.id] ?? 'tune';
            return (
              <button
                type="button"
                onClick={() => props.onSetActiveModeId(modeActive() ? null : mode.id)}
                class={`relative p-4 rounded-xl border cursor-pointer group transition-colors ${
                  modeActive()
                    ? 'border-primary bg-primary/5 shadow-[0_0_20px_rgba(16,183,127,0.05)]'
                    : 'border-white/5 bg-surface-dark hover:border-white/10'
                }`}
              >
                <div class="flex justify-between items-start mb-1">
                  <span class={`font-semibold transition-colors text-left ${modeActive() ? 'text-white group-hover:text-primary' : 'text-gray-300 group-hover:text-white'}`}>
                    {mode.name}
                  </span>
                  <span class={`material-symbols-outlined text-[18px] ${modeColor.bg} ${modeColor.text} rounded-md px-1.5 py-0.5`}>
                    {icon}
                  </span>
                </div>
                <p class={`text-xs leading-relaxed text-left ${modeActive() ? 'text-gray-400' : 'text-gray-500'}`}>
                  {promptPreview(mode.system_prompt)}
                </p>
              </button>
            );
          }}
        </For>
      </div>

      {/* Enhancements (disabled) */}
      {false && (
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
      )}

      {/* Mic Visualizer */}
      <MicVisualizer audioLevel={props.audioLevel} />
    </div>
  );
}

export default function RightPanel(props: RightPanelProps) {
  return <SettingsPanel {...props} />;
}
