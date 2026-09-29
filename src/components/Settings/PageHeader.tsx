import { Show } from 'solid-js';
import type { Component, JSX } from 'solid-js';
import { Search } from 'lucide-solid';
import type { LucideProps } from 'lucide-solid';

/** One figure in a page header's stat strip. */
export function StatChip(props: {
  icon: Component<LucideProps>;
  value: JSX.Element;
  label?: string;
  /** Breakpoint at which the label appears. */
  labelClass?: string;
  title?: string;
}) {
  return (
    <div class="flex items-center gap-1.5 shrink-0" title={props.title}>
      <props.icon size={14} class="text-primary" />
      <span class="font-semibold text-white">{props.value}</span>
      <Show when={props.label}>
        <span class={props.labelClass ?? 'hidden sm:inline'}>{props.label}</span>
      </Show>
    </div>
  );
}

/** Title, stat strip, optional search box and actions (children) of a full-bleed page. */
export default function PageHeader(props: {
  title: string;
  stats: JSX.Element;
  subtitle?: string;
  search?: {
    value: string;
    onInput: (value: string) => void;
    placeholder: string;
    /** Width of the box from the md breakpoint up. */
    class: string;
  };
  children: JSX.Element;
}) {
  const titleRow = (
    <div class="flex items-baseline gap-4 min-w-0">
      <h1 class="text-white text-3xl font-bold tracking-tight shrink-0">{props.title}</h1>
      <div class="flex items-center gap-4 text-sm text-gray-400 border-l border-white/10 pl-4 overflow-hidden">
        {props.stats}
      </div>
    </div>
  );
  return (
    <div class="flex-none px-6 sm:px-10 py-5 border-b border-white/5">
      <div
        class={`max-w-4xl mx-auto w-full flex flex-col md:flex-row ${
          props.subtitle ? 'md:items-start' : 'md:items-center'
        } justify-between gap-4`}
      >
        <Show when={props.subtitle} fallback={titleRow}>
          <div class="flex flex-col gap-2">
            {titleRow}
            <p class="text-zinc-500 text-sm">{props.subtitle}</p>
          </div>
        </Show>

        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.search}>
            {(search) => (
              <div class={`relative w-full ${search().class} group`}>
                <div class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 group-focus-within:text-primary transition-colors">
                  <Search size={16} />
                </div>
                <input
                  type="text"
                  value={search().value}
                  onInput={(e) => search().onInput(e.currentTarget.value)}
                  placeholder={search().placeholder}
                  class="block w-full p-2.5 pl-10 text-sm text-white bg-surface-dark border border-white/10 rounded-lg focus:ring-1 focus:ring-primary focus:border-primary placeholder-gray-600 transition-all outline-none"
                />
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  );
}
