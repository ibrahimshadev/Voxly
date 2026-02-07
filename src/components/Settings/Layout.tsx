import { Show } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import type { Tab } from '../../types';
import Sidebar from './Sidebar';

type LayoutProps = {
  activeTab: Accessor<Tab>;
  onTabChange: (tab: Tab) => void;
  children: JSX.Element;
  rightPanel?: JSX.Element;
  fullBleed?: boolean;
  isDark: Accessor<boolean>;
  onToggleTheme: () => void;
};

export default function Layout(props: LayoutProps) {
  return (
    <div class="h-screen overflow-hidden flex bg-background-dark text-white font-display selection:bg-primary/30 selection:text-white">
      {/* Left Sidebar */}
      <Sidebar
        activeTab={props.activeTab}
        onTabChange={props.onTabChange}
        isDark={props.isDark}
        onToggleTheme={props.onToggleTheme}
      />

      {/* Center Main Content */}
      <Show
        when={props.fullBleed}
        fallback={
          <main class="flex-1 overflow-y-auto scrollbar-hide bg-background-dark relative">
            <div class="absolute inset-0 z-0 opacity-[0.03] grid-dots" />
            <div class="max-w-3xl mx-auto py-10 px-8 relative z-10">
              {props.children}
            </div>
          </main>
        }
      >
        <main class="flex-1 flex flex-col overflow-hidden bg-background-dark relative">
          <div class="absolute inset-0 z-0 opacity-[0.03] grid-dots" />
          <div class="relative z-10 flex-1 flex flex-col overflow-hidden">
            {props.children}
          </div>
        </main>
      </Show>

      {/* Right Panel */}
      <Show when={props.rightPanel}>
        <aside class="w-80 bg-sidebar border-l border-white/5 flex flex-col shrink-0 z-20 overflow-y-auto scrollbar-hide">
          {props.rightPanel}
        </aside>
      </Show>
    </div>
  );
}
