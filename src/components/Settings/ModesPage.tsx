import { Index, Show, createSignal, createMemo } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Mode } from '../../types';
import { MODE_ICONS, MODE_COLORS, MODE_DESCRIPTIONS, DEFAULT_MODE_IDS } from '../../defaultModes';
import { Plus, Pencil, Trash2, Save, Layers, RotateCcw } from 'lucide-solid';
import Select from './Select';

export type ModesPageProps = {
  modes: Accessor<Mode[]>;
  activeModeId: Accessor<string | null>;
  modelsList: Accessor<string[]>;
  modelsLoading: Accessor<boolean>;
  modelsError: Accessor<string>;
  onUpdateMode: (id: string, field: keyof Mode, value: string) => void;
  onSetActiveModeId: (id: string | null) => void;
  onAddMode: () => void;
  onDeleteMode: (id: string) => void;
  onResetModes: () => void;
  onSave: () => void;
  saving: Accessor<boolean>;
};

function CollapsedModeCard(props: {
  mode: Mode;
  isActive: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onDelete: () => void;
}) {
  const icon = () => MODE_ICONS[props.mode.id] ?? 'tune';
  const colors = () => MODE_COLORS[props.mode.id];
  const description = () =>
    MODE_DESCRIPTIONS[props.mode.id] ?? (props.mode.system_prompt.length > 50
      ? props.mode.system_prompt.slice(0, 50) + '...'
      : props.mode.system_prompt);

  return (
    <div
      class={`group bg-surface-dark border rounded overflow-hidden relative transition-all hover:border-zinc-700 ${
        props.isActive
          ? 'border-zinc-700/50'
          : 'border-white/5 hover:bg-[#161616]'
      }`}
    >
      {/* Active indicator strip */}
      <Show when={props.isActive}>
        <div class="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
      </Show>

      <div class="flex items-center p-4 gap-4">
        {/* Icon */}
        <div
          class={`w-10 h-10 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
            colors()
              ? `${colors()!.bg} ${colors()!.text}`
              : props.isActive
                ? 'bg-[#1c2e27] text-primary'
                : 'bg-zinc-800 text-zinc-400 group-hover:text-white'
          }`}
        >
          <span class="material-symbols-outlined">{icon()}</span>
        </div>

        {/* Info */}
        <div class="flex flex-col md:flex-row md:items-center gap-2 md:gap-6 flex-1 min-w-0">
          <div class="flex items-center gap-3">
            <h3
              class={`text-base font-semibold whitespace-nowrap ${
                props.isActive ? 'text-white' : 'text-zinc-300 group-hover:text-white font-medium'
              }`}
            >
              {props.mode.name}
            </h3>
            <Show when={props.isActive}>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/20 text-primary border border-primary/20 tracking-wide">
                ACTIVE
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-2 text-zinc-500 text-sm min-w-0">
            <span class="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-400 shrink-0">
              {props.mode.model}
            </span>
            <span class="hidden md:inline-block w-1 h-1 rounded-full bg-zinc-700 shrink-0" />
            <span class="truncate max-w-[200px] text-zinc-600">{description()}</span>
          </div>
        </div>

        {/* Actions */}
        <div
          class={`flex items-center gap-1 transition-opacity ${
            props.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <Show
            when={props.isActive}
            fallback={
              <button
                type="button"
                onClick={props.onActivate}
                class="px-3 py-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors mr-2 cursor-pointer"
              >
                Activate
              </button>
            }
          >
            <button
              type="button"
              onClick={props.onDeactivate}
              class="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white transition-colors mr-2 cursor-pointer"
            >
              Deactivate
            </button>
          </Show>
          <button
            type="button"
            onClick={props.onEdit}
            class="w-8 h-8 rounded hover:bg-white/5 flex items-center justify-center text-zinc-500 hover:text-white transition-colors cursor-pointer"
            title="Edit mode"
          >
            <Pencil size={16} />
          </button>
          <Show when={!DEFAULT_MODE_IDS.has(props.mode.id)}>
            <button
              type="button"
              onClick={props.onDelete}
              class="w-8 h-8 rounded hover:bg-white/5 flex items-center justify-center text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
              title="Delete mode"
            >
              <Trash2 size={16} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

function ExpandedModeCard(props: {
  mode: Mode;
  modelOptions: { value: string; label: string }[];
  onUpdateMode: (field: keyof Mode, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const icon = () => MODE_ICONS[props.mode.id] ?? 'tune';
  const colors = () => MODE_COLORS[props.mode.id];

  return (
    <div class="bg-surface-dark border border-zinc-700 rounded overflow-hidden shadow-2xl relative">
      {/* Header */}
      <div class="flex items-center p-4 gap-4 border-b border-white/5 bg-[#161616]">
        <div
          class={`w-10 h-10 rounded flex items-center justify-center flex-shrink-0 ${
            colors() ? `${colors()!.bg} ${colors()!.text}` : 'bg-zinc-800 text-white'
          }`}
        >
          <span class="material-symbols-outlined">{icon()}</span>
        </div>
        <div class="flex-1">
          <h3 class="text-base font-semibold text-white">{props.mode.name}</h3>
          <p class="text-xs text-zinc-500 mt-0.5">Editing configuration...</p>
        </div>
        <div class="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary">
          <Pencil size={16} />
        </div>
      </div>

      {/* Form Content */}
      <div class="p-6 flex flex-col gap-5">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Mode Name */}
          <div class="flex flex-col gap-2">
            <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">Mode Name</label>
            <input
              type="text"
              value={props.mode.name}
              onInput={(e) => props.onUpdateMode('name', (e.target as HTMLInputElement).value)}
              placeholder="e.g. Clean Draft"
              class="w-full bg-input-bg border border-white/15 rounded-lg py-2 px-3 text-sm text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
            />
          </div>

          {/* AI Model */}
          <div class="flex flex-col gap-2">
            <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">AI Model</label>
            <Select
              value={props.mode.model}
              options={props.modelOptions}
              onChange={(v) => props.onUpdateMode('model', v)}
              class="px-3"
            />
          </div>
        </div>

        {/* System Prompt */}
        <div class="flex flex-col gap-2">
          <div class="flex justify-between items-end">
            <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">System Prompt</label>
            <span class="text-[10px] text-zinc-600">Markdown supported</span>
          </div>
          <textarea
            value={props.mode.system_prompt}
            onInput={(e) => props.onUpdateMode('system_prompt', (e.target as HTMLTextAreaElement).value)}
            placeholder="Enter the system prompt for this mode..."
            class="w-full bg-input-bg border border-white/15 rounded-lg py-2 px-3 text-sm text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700 font-mono resize-none min-h-[140px] leading-relaxed"
            rows={5}
          />
          <p class="text-xs text-zinc-500 mt-1">
            This prompt instructs the AI on how to format and process your transcription.
          </p>
        </div>

        {/* Footer Actions */}
        <div class="flex items-center justify-between pt-4 mt-2 border-t border-white/5">
          <Show
            when={!DEFAULT_MODE_IDS.has(props.mode.id)}
            fallback={<div />}
          >
            <button
              type="button"
              onClick={props.onDelete}
              class="text-xs font-medium text-red-400 hover:text-red-300 transition-colors flex items-center gap-1 cursor-pointer"
            >
              <Trash2 size={14} />
              Delete Mode
            </button>
          </Show>
          <div class="flex items-center gap-3">
            <button
              type="button"
              onClick={props.onCancel}
              class="text-sm font-medium text-zinc-400 hover:text-white transition-colors px-3 py-2 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={props.onSave}
              disabled={props.saving}
              class="bg-primary hover:bg-primary/90 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-primary/10 flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={16} />
              {props.saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ModesPage(props: ModesPageProps) {
  const [editingModeId, setEditingModeId] = createSignal<string | null>(null);

  const activeMode = createMemo(() => {
    const id = props.activeModeId();
    if (!id) return null;
    return props.modes().find((m) => m.id === id) ?? null;
  });

  const modelOptions = createMemo(() =>
    props.modelsList().map((m) => ({ value: m, label: m }))
  );

  const handleNewMode = () => {
    props.onAddMode();
    // The new mode will be the last one added
    const modes = props.modes();
    const newMode = modes[modes.length - 1];
    if (newMode) {
      setEditingModeId(newMode.id);
    }
  };

  const handleSave = () => {
    props.onSave();
    setEditingModeId(null);
  };

  const handleDelete = (id: string) => {
    if (editingModeId() === id) {
      setEditingModeId(null);
    }
    props.onDeleteMode(id);
  };

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div class="flex-none px-6 sm:px-10 py-5 border-b border-white/5">
        <div class="max-w-4xl mx-auto w-full flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline gap-4">
              <h1 class="text-white text-3xl font-bold tracking-tight">Modes</h1>
              <div class="flex items-center gap-1.5 text-sm text-gray-400 border-l border-white/10 pl-4">
                <Layers size={14} class="text-primary" />
                <span class="font-semibold text-white">{props.modes().length}</span>
                <span class="hidden sm:inline">configured</span>
              </div>
            </div>
            <p class="text-zinc-500 text-sm">AI-powered transcription formatting configurations.</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Reset all modes to defaults? This will replace your current modes.')) {
                  setEditingModeId(null);
                  props.onResetModes();
                }
              }}
              class="px-3 py-2.5 rounded-lg text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer flex items-center gap-1.5"
              title="Reset to default modes"
            >
              <RotateCcw size={14} />
              Reset
            </button>
            <button
              type="button"
              onClick={handleNewMode}
              class="px-4 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <Plus size={16} />
              New Mode
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <Show
        when={props.modes().length > 0}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center px-6 gap-4">
            <div class="text-center text-sm text-gray-500">
              No modes configured yet. Create a mode to apply AI formatting to your transcriptions.
            </div>
            <button
              type="button"
              onClick={handleNewMode}
              class="px-4 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <Plus size={16} />
              Create your first mode
            </button>
          </div>
        }
      >
        <main class="flex-1 overflow-y-auto px-4 sm:px-10 py-6 scrollbar-hide">
          <div class="max-w-4xl mx-auto flex flex-col gap-3">
            {/* Active mode indicator */}
            <Show when={activeMode()}>
              {(mode) => (
                <div class="flex items-center gap-2 text-xs font-semibold tracking-wider text-primary/80 uppercase mb-2">
                  <span class="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  Active: {mode().name}
                </div>
              )}
            </Show>

            {/* Mode cards */}
            <Index each={props.modes()}>
              {(mode) => (
                <Show
                  when={editingModeId() === mode().id}
                  fallback={
                    <CollapsedModeCard
                      mode={mode()}
                      isActive={props.activeModeId() === mode().id}
                      isEditing={false}
                      onEdit={() => setEditingModeId(mode().id)}
                      onActivate={() => props.onSetActiveModeId(mode().id)}
                      onDeactivate={() => props.onSetActiveModeId(null)}
                      onDelete={() => handleDelete(mode().id)}
                    />
                  }
                >
                  <ExpandedModeCard
                    mode={mode()}
                    modelOptions={modelOptions()}
                    onUpdateMode={(field, value) => props.onUpdateMode(mode().id, field, value)}
                    onCancel={() => setEditingModeId(null)}
                    onSave={handleSave}
                    onDelete={() => handleDelete(mode().id)}
                    saving={props.saving()}
                  />
                </Show>
              )}
            </Index>

            {/* Footer tip */}
            <div class="mt-8 text-center border-t border-white/5 pt-6">
              <p class="text-xs text-zinc-600">
                Modes are applied automatically after transcription is complete. Local processing is used unless a cloud model is selected.
              </p>
            </div>
          </div>
        </main>
      </Show>
    </div>
  );
}
