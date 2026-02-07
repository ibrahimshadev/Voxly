import { Show, For, createSignal } from 'solid-js';
import type { Accessor, Setter, JSX } from 'solid-js';
import type { Settings, Provider } from '../../types';
import { PROVIDERS } from '../../constants';
import Select from './Select';

type SettingsPageProps = {
  settings: Accessor<Settings>;
  setSettings: Setter<Settings>;
  testMessage: Accessor<string>;
  saving: Accessor<boolean>;
  onTest: () => void;
  onSave: () => void;
  onSaveQuiet: () => void;
};

const GroqIcon = (props: { class?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 305" fill="currentColor" class={props.class}>
    <path d="M105.304.004C47.704-.496.504 45.804.004 103.404c-.5 57.6 45.8 104.8 103.4 105.3h36.2v-39.1h-34.3c-36 .4-65.6-28.4-66-64.5-.4-36.1 28.4-65.6 64.5-66h1.5c36 0 65.2 29.2 65.4 65.2v96.1c0 35.7-29.1 64.8-64.7 65.2-17.1-.1-33.4-7-45.4-19.1l-27.7 27.7c19.2 19.3 45.2 30.3 72.4 30.5h1.4c56.9-.8 102.6-47 102.9-103.9v-99.1C208.204 46.204 161.904 1.104 105.304.004Z"/>
  </svg>
);

const OpenAIIcon = (props: { class?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class={props.class}>
    <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"/>
  </svg>
);

type ProviderOption = { value: Provider; label: string; icon?: string; iconComponent?: (props: { class?: string }) => JSX.Element };

const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: 'groq', label: 'Groq', iconComponent: GroqIcon },
  { value: 'openai', label: 'OpenAI', iconComponent: OpenAIIcon },
  { value: 'custom', label: 'Custom', icon: 'dns' },
];

const PROVIDER_KEY_URLS: Partial<Record<Provider, string>> = {
  groq: 'https://console.groq.com/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const formatHotkey = (raw: string): string =>
  raw.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');

export default function SettingsPage(props: SettingsPageProps) {
  const [showApiKey, setShowApiKey] = createSignal(false);

  const onField = (key: 'base_url' | 'model' | 'hotkey' | 'api_key') => (event: Event) => {
    const target = event.target as HTMLInputElement;
    props.setSettings((current) => ({ ...current, [key]: target.value }));
  };

  const onProviderChange = (provider: Provider) => {
    const config = PROVIDERS[provider];
    props.setSettings((current) => ({
      ...current,
      provider,
      base_url: config.base_url,
      model: config.models[0] ?? ''
    }));
  };

  /** Update a behavior field and auto-save immediately */
  const setBehavior = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    props.setSettings((current) => ({ ...current, [key]: value }));
    props.onSaveQuiet();
  };

  const providerConfig = () => PROVIDERS[props.settings().provider];
  const keyUrl = () => PROVIDER_KEY_URLS[props.settings().provider];

  return (
    <>
      {/* Header */}
      <header class="mb-10">
        <h2 class="text-3xl font-bold tracking-tight mb-2">Settings</h2>
        <p class="text-gray-400">
          Configure your transcription pipeline and application behavior.
        </p>
      </header>

      <div class="space-y-8">
        {/* Transcription Provider */}
        <section>
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              Transcription Provider
            </h3>
          </div>

          {/* Provider Cards */}
          <div class="grid grid-cols-3 gap-3 mb-6">
            <For each={PROVIDER_OPTIONS}>
              {(option) => {
                const isActive = () => props.settings().provider === option.value;
                return (
                  <button
                    type="button"
                    onClick={() => onProviderChange(option.value)}
                    class={`cursor-pointer relative p-4 rounded-xl border transition-colors flex flex-col items-center justify-center gap-2 ${
                      isActive()
                        ? 'border-primary bg-primary/5'
                        : 'border-white/10 bg-surface-dark hover:border-white/20 hover:bg-white/[0.03]'
                    }`}
                  >
                    {option.iconComponent
                      ? option.iconComponent({ class: `w-7 h-7 ${isActive() ? 'text-primary' : 'text-gray-400'}` })
                      : <span class={`material-symbols-outlined text-2xl ${
                          isActive() ? 'text-primary' : 'text-gray-400'
                        }`}>
                          {option.icon}
                        </span>
                    }
                    <span class={`font-medium text-sm ${
                      isActive() ? 'text-white' : 'text-gray-300'
                    }`}>
                      {option.label}
                    </span>
                    <Show when={isActive()}>
                      <div class="absolute top-2 right-2">
                        <span class="material-symbols-outlined text-primary text-[18px]">check_circle</span>
                      </div>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>

          {/* Connection Details Card */}
          <div class="bg-surface-dark border border-white/10 rounded-xl p-6 space-y-5">
            <div class="grid grid-cols-2 gap-5">
              {/* Base URL */}
              <div class="space-y-1.5">
                <label class="text-xs text-gray-500 font-medium ml-1">BASE URL</label>
                <div class="relative">
                  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 material-symbols-outlined text-[18px]">
                    link
                  </span>
                  <input
                    class="w-full bg-input-bg border border-white/15 rounded-lg py-2 pl-10 pr-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                    type="text"
                    value={props.settings().base_url}
                    onInput={onField('base_url')}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
              </div>

              {/* Model ID */}
              <div class="space-y-1.5">
                <label class="text-xs text-gray-500 font-medium ml-1">MODEL ID</label>
                <div class="relative">
                  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 material-symbols-outlined text-[18px] z-10 pointer-events-none">
                    view_in_ar
                  </span>
                  <Show
                    when={props.settings().provider !== 'custom'}
                    fallback={
                      <input
                        class="w-full bg-input-bg border border-white/15 rounded-lg py-2 pl-10 pr-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                        type="text"
                        value={props.settings().model}
                        onInput={onField('model')}
                        placeholder="model-name"
                      />
                    }
                  >
                    <Select
                      value={props.settings().model}
                      options={providerConfig().models.map((m) => ({ value: m, label: m }))}
                      onChange={(value) => props.setSettings((current) => ({ ...current, model: value }))}
                      class="pl-10 pr-8 font-mono"
                    />
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 material-symbols-outlined text-[18px] pointer-events-none z-10">
                      arrow_drop_down
                    </span>
                  </Show>
                </div>
              </div>
            </div>

            {/* API Key */}
            <div class="space-y-1.5">
              <div class="flex justify-between items-center px-1">
                <label class="text-xs text-gray-500 font-medium">API KEY</label>
                <Show when={keyUrl()}>
                  <a
                    href={keyUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-xs text-primary hover:underline cursor-pointer"
                  >
                    Get key
                  </a>
                </Show>
              </div>
              <div class="relative">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 material-symbols-outlined text-[18px]">
                  key
                </span>
                <input
                  class="w-full bg-input-bg border border-white/15 rounded-lg py-2 pl-10 pr-10 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                  type={showApiKey() ? 'text' : 'password'}
                  value={props.settings().api_key}
                  onInput={onField('api_key')}
                  placeholder="sk-..."
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 text-gray-500 hover:text-gray-300 rounded hover:bg-white/5 transition-colors"
                >
                  <span class="material-symbols-outlined text-[18px] leading-none">
                    {showApiKey() ? 'visibility' : 'visibility_off'}
                  </span>
                </button>
              </div>
              <Show
                when={props.settings().api_key}
                fallback={
                  <p class="text-[11px] text-amber-500/80 pl-1 pt-1">
                    Missing API key — required for transcription.
                  </p>
                }
              >
                <p class="text-[11px] text-gray-600 pl-1 pt-1">
                  Your key is stored locally and encrypted.
                </p>
              </Show>
            </div>
          </div>

          {/* Provider Actions */}
          <div class="mt-5">
            <Show when={props.testMessage()}>
              <div class={`text-sm px-4 py-3 rounded-lg mb-4 border ${
                props.testMessage().toLowerCase().includes('error') ||
                props.testMessage().toLowerCase().includes('fail') ||
                props.testMessage().toLowerCase().includes('missing')
                  ? 'text-red-400 bg-red-500/5 border-red-500/20'
                  : 'text-primary bg-primary/5 border-primary/20'
              }`}>
                {props.testMessage()}
              </div>
            </Show>

            <div class="flex items-center justify-end gap-4">
              <button
                type="button"
                onClick={props.onTest}
                class="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
              >
                Test Connection
              </button>
              <button
                type="button"
                disabled={props.saving()}
                onClick={props.onSave}
                class="px-6 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark disabled:opacity-50 transition-colors cursor-pointer"
              >
                {props.saving() ? 'Saving...' : 'Save Provider'}
              </button>
            </div>
          </div>
        </section>

        <hr class="border-white/5 my-2" />

        {/* Behavior Settings — auto-saves on change */}
        <section>
          <h3 class="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Behavior
          </h3>
          <div class="bg-surface-dark border border-white/10 rounded-xl p-1 divide-y divide-white/5">
            {/* Global Hotkey */}
            <div class="p-4 flex items-center justify-between group hover:bg-white/[0.02] transition-colors rounded-t-lg">
              <div class="flex flex-col gap-1">
                <span class="text-sm font-medium text-gray-200">Global Hotkey</span>
                <span class="text-xs text-gray-500">System-wide trigger to start recording</span>
              </div>
              <div class="relative">
                <input
                  class="bg-input-bg border border-white/15 text-center w-36 rounded py-1.5 text-sm font-mono text-primary font-bold focus:outline-none focus:border-primary/50 cursor-pointer hover:border-primary/50 transition-colors"
                  type="text"
                  value={formatHotkey(props.settings().hotkey)}
                  onInput={(e) => {
                    const raw = (e.target as HTMLInputElement).value
                      .replace(/\s*\+\s*/g, '+')
                      .replace('Ctrl', 'CommandOrControl');
                    props.setSettings((current) => ({ ...current, hotkey: raw }));
                  }}
                  onBlur={() => props.onSaveQuiet()}
                />
              </div>
            </div>

            {/* Recording Mode */}
            <div class="p-4 flex items-center justify-between group hover:bg-white/[0.02] transition-colors">
              <div class="flex flex-col gap-1">
                <span class="text-sm font-medium text-gray-200">Recording Trigger</span>
                <span class="text-xs text-gray-500">How you want to control the microphone</span>
              </div>
              <div class="flex bg-input-bg p-1 rounded-lg border border-white/15">
                <button
                  type="button"
                  onClick={() => setBehavior('hotkey_mode', 'lock')}
                  class={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    props.settings().hotkey_mode === 'lock'
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Toggle
                </button>
                <button
                  type="button"
                  onClick={() => setBehavior('hotkey_mode', 'hold')}
                  class={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    props.settings().hotkey_mode === 'hold'
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Hold
                </button>
              </div>
            </div>

            {/* Output Mode */}
            <div class="p-4 flex items-center justify-between group hover:bg-white/[0.02] transition-colors rounded-b-lg">
              <div class="flex flex-col gap-1">
                <span class="text-sm font-medium text-gray-200">Output Action</span>
                <span class="text-xs text-gray-500">What happens after transcription</span>
              </div>
              <div class="w-56">
                <Select
                  value={props.settings().copy_to_clipboard_on_success ? 'copy' : 'paste'}
                  options={[
                    { value: 'paste', label: 'Paste at cursor' },
                    { value: 'copy', label: 'Paste + copy to clipboard' },
                  ]}
                  onChange={(value) => setBehavior('copy_to_clipboard_on_success', value === 'copy')}
                  class="pl-3 pr-8"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Spacer */}
        <div class="h-10" />
      </div>
    </>
  );
}
