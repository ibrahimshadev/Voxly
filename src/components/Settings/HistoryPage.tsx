import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { TranscriptionHistoryItem } from '../../types';
import {
  formatDurationHuman,
  formatTotalAudio,
  formatItemTime,
  formatExactTime,
  getLanguageCode,
  groupByDate,
} from './historyUtils';
import {
  Timer,
  Mic,
  Sparkles,
  Clock,
  ChevronDown,
  Copy,
  Trash2,
  BookOpen,
  CalendarDays,
  AudioLines,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-solid';

export type HistoryPageProps = {
  history: Accessor<TranscriptionHistoryItem[]>;
  totalCount: Accessor<number>;
  todayCount: Accessor<number>;
  totalAudioSecs: Accessor<number>;
  message: Accessor<string>;
  searchQuery: Accessor<string>;
  onSearchQueryChange: (value: string) => void;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
};

const isMessageError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes('error') || normalized.includes('fail') || normalized.includes('missing');
};

function HistoryItem(props: {
  item: TranscriptionHistoryItem;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
}) {
  const hasOriginalText = () =>
    props.item.original_text != null && props.item.original_text !== props.item.text;

  const isNonEnglish = () =>
    props.item.language != null && props.item.language !== 'english' && props.item.language !== '';

  return (
    <div class="group relative rounded-xl p-4 hover:bg-surface-hover transition-colors duration-200 flex flex-col gap-2">
      <div class="pr-12">
        <p class={`text-white text-[15px] leading-relaxed ${isNonEnglish() ? 'italic' : ''}`}>
          {isNonEnglish() && '\u201C'}{props.item.text}{isNonEnglish() && '\u201D'}
        </p>

        <Show when={hasOriginalText()}>
          <details class="group/details mt-3">
            <summary class="cursor-pointer text-xs text-primary font-medium hover:brightness-110 transition-colors list-none flex items-center gap-1 w-fit select-none">
              Show original
              <ChevronDown size={12} class="group-open/details:rotate-180 transition-transform" />
            </summary>
            <div class="mt-2 p-3 bg-black/20 rounded-md border-l-2 border-white/10 text-gray-500 text-sm break-words">
              {props.item.original_text}
            </div>
          </details>
        </Show>
      </div>

      <div class="flex items-center gap-4 mt-1 text-xs text-gray-500 select-none">
        <Show when={isNonEnglish()}>
          <div class="bg-white/10 text-white/90 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wide">
            {getLanguageCode(props.item.language!)}
          </div>
        </Show>

        <Show when={props.item.duration_secs != null}>
          <div class="flex items-center gap-1">
            <Timer size={12} />
            <span>{formatDurationHuman(props.item.duration_secs!)}</span>
          </div>
        </Show>

        <div class="flex items-center gap-1">
          {props.item.mode_name ? <Sparkles size={12} /> : <Mic size={12} />}
          <span>{props.item.mode_name ?? 'Dictation'}</span>
        </div>

        <div class="flex items-center gap-1" title={formatExactTime(props.item.created_at_ms)}>
          <Clock size={12} />
          <span>{formatItemTime(props.item.created_at_ms)}</span>
        </div>
      </div>

      <div class="absolute right-3 top-3 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <button
          type="button"
          onClick={() => props.onCopy(props.item.text)}
          class="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
          title="Copy text"
        >
          <Copy size={16} />
        </button>
        <button
          type="button"
          onClick={() => props.onDelete(props.item.id)}
          class="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Delete entry"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;
const MAX_PAGE_BUTTONS = 5;

function buildPageNumbers(currentPage: number, totalPages: number): (number | '...')[] {
  if (totalPages <= MAX_PAGE_BUTTONS) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | '...')[] = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < totalPages - 1) pages.push('...');
  pages.push(totalPages);

  return pages;
}

function Pagination(props: {
  currentPage: Accessor<number>;
  totalPages: Accessor<number>;
  onPageChange: (page: number) => void;
}) {
  const pages = createMemo(() => buildPageNumbers(props.currentPage(), props.totalPages()));

  return (
    <Show when={props.totalPages() > 1}>
      <footer class="flex-none border-t border-white/5 py-3 px-6">
        <div class="max-w-4xl mx-auto flex items-center justify-between text-sm">
          <button
            type="button"
            disabled={props.currentPage() === 1}
            onClick={() => props.onPageChange(props.currentPage() - 1)}
            class="flex items-center gap-1 text-gray-500 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            Prev
          </button>

          <div class="flex items-center gap-2">
            <For each={pages()}>
              {(page) => (
                <>
                  {page === '...' ? (
                    <span class="text-gray-600 px-1">...</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => props.onPageChange(page)}
                      class={`size-8 rounded-lg font-medium flex items-center justify-center transition-colors ${
                        page === props.currentPage()
                          ? 'bg-primary text-black font-bold'
                          : 'text-gray-500 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {page}
                    </button>
                  )}
                </>
              )}
            </For>
          </div>

          <button
            type="button"
            disabled={props.currentPage() === props.totalPages()}
            onClick={() => props.onPageChange(props.currentPage() + 1)}
            class="flex items-center gap-1 text-gray-500 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
            <ChevronRight size={16} />
          </button>
        </div>
      </footer>
    </Show>
  );
}

export default function HistoryPage(props: HistoryPageProps) {
  const [currentPage, setCurrentPage] = createSignal(1);
  const hasSearch = createMemo(() => props.searchQuery().trim().length > 0);

  createEffect(on(() => props.searchQuery(), () => setCurrentPage(1)));

  const totalPages = createMemo(() => Math.max(1, Math.ceil(props.history().length / PAGE_SIZE)));
  const safePage = createMemo(() => Math.min(currentPage(), totalPages()));

  const paginatedHistory = createMemo(() => {
    const start = (safePage() - 1) * PAGE_SIZE;
    return props.history().slice(start, start + PAGE_SIZE);
  });

  const dateGroups = createMemo(() => groupByDate(paginatedHistory()));

  const entryCountLabel = createMemo(() => {
    const total = props.totalCount();
    const visible = props.history().length;
    if (hasSearch()) return `${visible} of ${total}`;
    return total.toLocaleString();
  });

  const handleClearAll = () => {
    if (props.totalCount() === 0) return;
    if (window.confirm('Clear all transcription history?')) {
      props.onClearAll();
    }
  };

  const emptyMessage = createMemo(() =>
    hasSearch()
      ? 'No matching transcriptions found.'
      : 'No transcriptions yet. History will appear here after dictating.'
  );

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div class="flex-none px-6 sm:px-10 py-5 border-b border-white/5">
        <div class="max-w-4xl mx-auto w-full flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="flex items-baseline gap-4 min-w-0">
            <h1 class="text-white text-3xl font-bold tracking-tight shrink-0">History</h1>
            <div class="flex items-center gap-4 text-sm text-gray-400 border-l border-white/10 pl-4 overflow-hidden">
              <div class="flex items-center gap-1.5 shrink-0" title="Total Entries">
                <BookOpen size={14} class="text-primary" />
                <span class="font-semibold text-white">{entryCountLabel()}</span>
                <span class="hidden sm:inline">Entries</span>
              </div>
              <div class="flex items-center gap-1.5 shrink-0" title="Today's Entries">
                <CalendarDays size={14} class="text-primary" />
                <span class="font-semibold text-white">{props.todayCount()}</span>
                <span class="hidden sm:inline">Today</span>
              </div>
              <Show when={props.totalAudioSecs() > 0}>
                <div class="flex items-center gap-1.5 shrink-0" title="Total Audio Duration">
                  <AudioLines size={14} class="text-primary" />
                  <span class="font-semibold text-white">{formatTotalAudio(props.totalAudioSecs())}</span>
                </div>
              </Show>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <div class="relative w-full md:w-72 group">
              <div class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 group-focus-within:text-primary transition-colors">
                <Search size={16} />
              </div>
              <input
                type="text"
                value={props.searchQuery()}
                onInput={(e) => props.onSearchQueryChange((e.target as HTMLInputElement).value)}
                placeholder="Search transcriptions..."
                class="block w-full p-2.5 pl-10 text-sm text-white bg-surface-dark border border-white/10 rounded-lg focus:ring-1 focus:ring-primary focus:border-primary placeholder-gray-600 transition-all outline-none"
              />
            </div>
            <button
              type="button"
              disabled={props.totalCount() === 0}
              onClick={handleClearAll}
              class="p-2.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Clear all history"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Message */}
      <Show when={props.message()}>
        {(message) => (
          <div class="px-6 sm:px-10 pt-4">
            <div class={`max-w-4xl mx-auto text-sm px-4 py-3 rounded-lg border ${
              isMessageError(message())
                ? 'text-red-400 bg-red-500/5 border-red-500/20'
                : 'text-primary bg-primary/5 border-primary/20'
            }`}>
              {message()}
            </div>
          </div>
        )}
      </Show>

      {/* Content */}
      <Show
        when={props.history().length > 0}
        fallback={
          <div class="flex-1 flex items-center justify-center px-6">
            <div class="text-center text-sm text-gray-500">{emptyMessage()}</div>
          </div>
        }
      >
        <main class="flex-1 overflow-y-auto px-4 sm:px-10 py-6 scrollbar-hide">
          <div class="max-w-4xl mx-auto flex flex-col gap-8">
            <For each={dateGroups()}>
              {(group) => (
                <section>
                  <div class="flex items-center gap-4 mb-3">
                    <h3 class={`font-medium text-sm uppercase tracking-wider ${
                      group.isToday ? 'text-primary' : 'text-gray-500'
                    }`}>
                      {group.label}
                    </h3>
                    <div class="h-px bg-white/5 flex-1" />
                  </div>
                  <div class="flex flex-col gap-1">
                    <For each={group.items}>
                      {(item) => (
                        <HistoryItem
                          item={item}
                          onCopy={props.onCopy}
                          onDelete={props.onDelete}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </main>

        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      </Show>
    </div>
  );
}
