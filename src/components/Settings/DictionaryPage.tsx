import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { VocabularyEntry } from '../../types';
import { MAX_VOCABULARY_ENTRIES, MAX_REPLACEMENTS_PER_ENTRY } from '../../constants';
import {
  Search,
  BookOpen,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-solid';
import { SwitchKnob } from './controls';

export type DictionaryPageProps = {
  entries: Accessor<VocabularyEntry[]>;
  isEditorOpen: Accessor<boolean>;
  editingId: Accessor<string | null>;
  editorWord: Accessor<string>;
  setEditorWord: Setter<string>;
  editorReplacements: Accessor<string>;
  setEditorReplacements: Setter<string>;
  onOpenCreate: () => void;
  onEdit: (entry: VocabularyEntry) => void;
  onSave: () => void;
  onCancel: () => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
};

function EntryEditor(props: {
  editorWord: Accessor<string>;
  setEditorWord: Setter<string>;
  editorReplacements: Accessor<string>;
  setEditorReplacements: Setter<string>;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
}) {
  return (
    <div class="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
      <h4 class="text-sm font-semibold text-white">
        {props.isNew ? 'Add New Word' : 'Edit Word'}
      </h4>

      <div class="space-y-1.5">
        <label class="text-xs text-gray-500 font-medium ml-1">WORD</label>
        <input
          type="text"
          value={props.editorWord()}
          onInput={(e) => props.setEditorWord((e.target as HTMLInputElement).value)}
          placeholder="e.g. Kubernetes"
          class="w-full bg-input-bg border border-white/15 rounded-lg py-2 px-3 text-sm text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
        />
      </div>

      <div class="space-y-1.5">
        <label class="text-xs text-gray-500 font-medium ml-1">REPLACEMENTS</label>
        <textarea
          value={props.editorReplacements()}
          onInput={(e) => props.setEditorReplacements((e.target as HTMLTextAreaElement).value)}
          placeholder={"e.g.\nkubernetes\nkubernetties\ncoobernetes"}
          rows={4}
          class="w-full bg-input-bg border border-white/15 rounded-lg py-2 px-3 text-sm text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700 resize-none"
        />
        <p class="text-[11px] text-gray-600 pl-1">
          One per line. These are the misheard variations that should map to the word above.
        </p>
        <p class="text-[11px] text-gray-600 pl-1">
          Up to {MAX_REPLACEMENTS_PER_ENTRY} replacements per entry. Matching is case-insensitive.
        </p>
      </div>

      <div class="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={props.onSave}
          class="px-5 py-2 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <Check size={14} />
          Save
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          class="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-300 transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <X size={14} />
          Cancel
        </button>
      </div>
    </div>
  );
}

function DictionaryItem(props: {
  entry: VocabularyEntry;
  onEdit: (entry: VocabularyEntry) => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div class={`group relative rounded-xl p-4 hover:bg-surface-hover transition-colors duration-200 flex items-center gap-4 ${
      !props.entry.enabled ? 'opacity-60' : ''
    }`}>
      <div class="flex-1 min-w-0">
        <p class="text-white text-[15px] font-medium leading-snug">{props.entry.word}</p>
        <Show when={props.entry.replacements.length > 0}>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <For each={props.entry.replacements}>
              {(replacement) => (
                <span class="bg-white/5 rounded px-2 py-0.5 text-xs text-gray-400">
                  {replacement}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="flex items-center gap-2 shrink-0">
        <SwitchKnob
          on={props.entry.enabled}
          onToggle={() => props.onToggleEnabled(props.entry.id)}
          title={props.entry.enabled ? 'Disable entry' : 'Enable entry'}
        />

        <div class="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            type="button"
            onClick={() => props.onEdit(props.entry)}
            class="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
            title="Edit entry"
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            onClick={() => props.onDelete(props.entry.id)}
            class="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete entry"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DictionaryPage(props: DictionaryPageProps) {
  const [searchQuery, setSearchQuery] = createSignal('');

  const filteredEntries = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return props.entries();
    return props.entries().filter((entry) =>
      entry.word.toLowerCase().includes(query) ||
      entry.replacements.some((r) => r.toLowerCase().includes(query))
    );
  });

  const activeCount = createMemo(() =>
    props.entries().filter((e) => e.enabled).length
  );

  const atMax = createMemo(() =>
    props.entries().length >= MAX_VOCABULARY_ENTRIES
  );

  const isCreating = createMemo(() =>
    props.isEditorOpen() && props.editingId() === null
  );

  const entryEditor = (isNew: boolean) => (
    <EntryEditor
      editorWord={props.editorWord}
      setEditorWord={props.setEditorWord}
      editorReplacements={props.editorReplacements}
      setEditorReplacements={props.setEditorReplacements}
      onSave={props.onSave}
      onCancel={props.onCancel}
      isNew={isNew}
    />
  );

  const emptyMessage = createMemo(() =>
    searchQuery().trim().length > 0
      ? 'No matching dictionary entries.'
      : 'No dictionary entries yet. Add words you frequently dictate to improve transcription accuracy.'
  );

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div class="flex-none px-6 sm:px-10 py-5 border-b border-white/5">
        <div class="max-w-4xl mx-auto w-full flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="flex items-baseline gap-4 min-w-0">
            <h1 class="text-white text-3xl font-bold tracking-tight shrink-0">Dictionary</h1>
            <div class="flex items-center gap-4 text-sm text-gray-400 border-l border-white/10 pl-4 overflow-hidden">
              <div class="flex items-center gap-1.5 shrink-0" title="Total Words">
                <BookOpen size={14} class="text-primary" />
                <span class="font-semibold text-white">{props.entries().length}</span>
                <span class="hidden sm:inline">words</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0" title="Active Entries">
                <Check size={14} class="text-primary" />
                <span class="font-semibold text-white">{activeCount()}</span>
                <span class="hidden sm:inline">active</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <div class="relative w-full md:w-64 group">
              <div class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 group-focus-within:text-primary transition-colors">
                <Search size={16} />
              </div>
              <input
                type="text"
                value={searchQuery()}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                placeholder="Search words..."
                class="block w-full p-2.5 pl-10 text-sm text-white bg-surface-dark border border-white/10 rounded-lg focus:ring-1 focus:ring-primary focus:border-primary placeholder-gray-600 transition-all outline-none"
              />
            </div>
            <button
              type="button"
              disabled={atMax()}
              onClick={props.onOpenCreate}
              class="px-4 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
              title={atMax() ? `Maximum ${MAX_VOCABULARY_ENTRIES} entries reached` : 'Add a new word'}
            >
              <Plus size={16} />
              Add Word
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <Show
        when={filteredEntries().length > 0 || isCreating()}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center px-6 gap-4">
            <div class="text-center text-sm text-gray-500">{emptyMessage()}</div>
            <Show when={searchQuery().trim().length === 0 && props.entries().length === 0}>
              <button
                type="button"
                onClick={props.onOpenCreate}
                class="px-4 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Plus size={16} />
                Add your first word
              </button>
            </Show>
          </div>
        }
      >
        <main class="flex-1 overflow-y-auto px-4 sm:px-10 py-6 scrollbar-hide">
          <div class="max-w-4xl mx-auto flex flex-col gap-1">
            {/* Create editor at the top */}
            <Show when={isCreating()}>{entryEditor(true)}</Show>

            <For each={filteredEntries()}>
              {(entry) => (
                <Show
                  when={props.editingId() === entry.id}
                  fallback={
                    <DictionaryItem
                      entry={entry}
                      onEdit={props.onEdit}
                      onToggleEnabled={props.onToggleEnabled}
                      onDelete={props.onDelete}
                    />
                  }
                >
                  {entryEditor(false)}
                </Show>
              )}
            </For>
          </div>
        </main>
      </Show>
    </div>
  );
}
