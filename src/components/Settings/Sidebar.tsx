import { For } from 'solid-js';
import type { Accessor, Component } from 'solid-js';
import { BookOpen, History, Layers, Mic, Moon, Settings, SquarePlay, Sun } from 'lucide-solid';
import type { LucideProps } from 'lucide-solid';
import type { Tab } from '../../types';
import { APP_NAME } from '../../branding';

type SidebarProps = {
  activeTab: Accessor<Tab>;
  onTabChange: (tab: Tab) => void;
  isDark: Accessor<boolean>;
  onToggleTheme: () => void;
};

const NAV_ITEMS: { tab: Tab; label: string; icon: Component<LucideProps> }[] = [
  { tab: 'settings', label: 'Settings', icon: Settings },
  { tab: 'history', label: 'History', icon: History },
  { tab: 'meetings', label: 'Meetings', icon: SquarePlay },
  { tab: 'dictionary', label: 'Dictionary', icon: BookOpen },
  { tab: 'modes', label: 'Modes', icon: Layers },
];

export default function Sidebar(props: SidebarProps) {
  return (
    <aside class="w-52 bg-sidebar border-r border-white/5 flex flex-col justify-between shrink-0 z-20">
      {/* Header */}
      <div class="px-4 pt-5 pb-4">
        {/* Logo */}
        <div class="flex items-center gap-2.5 mb-6">
          <div class="w-7 h-7 bg-primary rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(16,183,127,0.4)]">
            <Mic size={24} class="text-black" />
          </div>
          <h1 class="font-bold text-base tracking-tight">{APP_NAME}</h1>
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
                <item.icon size={24} />
                <span class="text-sm font-medium">{item.label}</span>
              </button>
            )}
          </For>
        </nav>
      </div>

      {/* Theme Toggle */}
      <div class="px-4 pb-4">
        <button
          type="button"
          onClick={props.onToggleTheme}
          class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 border border-transparent transition-colors cursor-pointer"
        >
          {props.isDark() ? <Sun size={24} /> : <Moon size={24} />}
          <span class="text-sm font-medium">
            {props.isDark() ? 'Light Mode' : 'Dark Mode'}
          </span>
        </button>
      </div>
    </aside>
  );
}
