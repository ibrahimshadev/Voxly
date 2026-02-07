import { For } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Tab } from '../../types';
import { APP_NAME } from '../../branding';

type SidebarProps = {
  activeTab: Accessor<Tab>;
  onTabChange: (tab: Tab) => void;
  isDark: Accessor<boolean>;
  onToggleTheme: () => void;
};

const NAV_ITEMS: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'settings', label: 'Settings', icon: 'settings' },
  { tab: 'history', label: 'History', icon: 'history' },
  { tab: 'vocabulary', label: 'Vocabulary', icon: 'book_2' },
  { tab: 'modes', label: 'Modes', icon: 'layers' },
];

export default function Sidebar(props: SidebarProps) {
  return (
    <aside class="w-52 bg-sidebar border-r border-white/5 flex flex-col justify-between shrink-0 z-20">
      {/* Header */}
      <div class="px-4 pt-5 pb-4">
        {/* Logo */}
        <div class="flex items-center gap-2.5 mb-6">
          <div class="w-7 h-7 bg-primary rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(16,183,127,0.4)]">
            <span class="material-symbols-outlined text-black text-[16px] font-bold">mic</span>
          </div>
          <div>
            <h1 class="font-bold text-base tracking-tight">{APP_NAME}</h1>
            <span class="text-[9px] text-gray-500 font-mono tracking-widest uppercase">PRO v2.1</span>
          </div>
        </div>

        {/* Navigation */}
        <nav class="space-y-0.5">
          <For each={NAV_ITEMS}>
            {(item) => (
              <button
                onClick={() => props.onTabChange(item.tab)}
                class={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
                  props.activeTab() === item.tab
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-gray-400 hover:text-white hover:bg-white/5 border border-transparent'
                }`}
                type="button"
              >
                <span class="material-symbols-outlined text-[18px]">{item.icon}</span>
                <span class="text-sm font-medium">{item.label}</span>
              </button>
            )}
          </For>
        </nav>
      </div>

      {/* Bottom */}
      <div>
        {/* Theme Toggle */}
        <div class="px-4 pb-1">
          <button
            type="button"
            onClick={props.onToggleTheme}
            class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 border border-transparent transition-colors cursor-pointer"
          >
            <span class="material-symbols-outlined text-[18px]">
              {props.isDark() ? 'light_mode' : 'dark_mode'}
            </span>
            <span class="text-sm font-medium">
              {props.isDark() ? 'Light Mode' : 'Dark Mode'}
            </span>
          </button>
        </div>

        {/* User Footer */}
        <div class="px-3 py-3 border-t border-white/5">
          <div class="flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
            <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 overflow-hidden shrink-0" />
            <div class="flex flex-col overflow-hidden">
              <span class="text-xs font-medium truncate text-gray-200">Alex Chen</span>
              <span class="text-[10px] text-gray-500 truncate">alex@dikt.app</span>
            </div>
            <span class="material-symbols-outlined text-gray-600 text-[14px] ml-auto">unfold_more</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
