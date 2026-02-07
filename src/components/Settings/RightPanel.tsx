import type { Accessor } from 'solid-js';
import type { Tab } from '../../types';

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
};

function SettingsPanel() {
  return (
    <div class="p-6 flex-1 flex flex-col h-full">
      {/* AI Configuration Heading */}
      <h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-6">
        AI Configuration
      </h2>

      {/* Transcription Modes */}
      <div class="space-y-3 mb-8">
        {/* Clean Draft — Active */}
        <div class="relative p-4 rounded-xl border border-primary bg-primary/5 shadow-[0_0_20px_rgba(16,183,127,0.05)] cursor-pointer group transition-colors">
          <div class="flex justify-between items-start mb-1">
            <span class="font-semibold text-white group-hover:text-primary transition-colors">
              Clean Draft
            </span>
            <span class="material-symbols-outlined text-primary text-[18px]">auto_fix</span>
          </div>
          <p class="text-xs text-gray-400 leading-relaxed">
            Removes filler words, fixes grammar, and formats into paragraphs.
          </p>
        </div>

        {/* Meeting Minutes */}
        <div class="relative p-4 rounded-xl border border-white/5 bg-surface-dark hover:border-white/10 cursor-pointer group transition-colors">
          <div class="flex justify-between items-start mb-1">
            <span class="font-semibold text-gray-300 group-hover:text-white transition-colors">
              Meeting Minutes
            </span>
            <span class="material-symbols-outlined text-gray-600 group-hover:text-gray-400 text-[18px]">
              groups
            </span>
          </div>
          <p class="text-xs text-gray-500 leading-relaxed">
            Summarizes spoken content into bullet points and action items.
          </p>
        </div>

        {/* Developer Mode */}
        <div class="relative p-4 rounded-xl border border-white/5 bg-surface-dark hover:border-white/10 cursor-pointer group transition-colors">
          <div class="flex justify-between items-start mb-1">
            <span class="font-semibold text-gray-300 group-hover:text-white transition-colors">
              Developer Mode
            </span>
            <span class="material-symbols-outlined text-gray-600 group-hover:text-gray-400 text-[18px]">
              code
            </span>
          </div>
          <p class="text-xs text-gray-500 leading-relaxed">
            Preserves code snippets and technical jargon verbatim.
          </p>
        </div>
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

export default function RightPanel(_props: RightPanelProps) {
  return <SettingsPanel />;
}
