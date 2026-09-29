import { Show, For, createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { Settings, Provider } from '../../types';
import { PROVIDER_IDS, PROVIDERS } from '../../constants';
import { CircleCheck } from 'lucide-solid';
import { notifyError, notifySuccess } from '../../lib/notify';
import Select from './Select';
import ProviderIcon from './ProviderIcon';

/** In-memory model selection per provider. Resets on app start so defaults apply. */
const providerModelMemory: Partial<Record<Provider, string>> = {};

type SettingsPageProps = {
  settings: Accessor<Settings>;
  setSettings: Setter<Settings>;
  saving: Accessor<boolean>;
  onTest: () => void;
  onSaveQuiet: () => void;
  onTestAndSave: () => void;
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
    const defaultChatModel = config.chatModels[0] ?? '';
    props.setSettings((current) => {
      if (provider === current.provider) return current;

      // Stash current model for the old provider
      providerModelMemory[current.provider] = current.model;

      const updatedKeys = {
        ...current.provider_api_keys,
        [current.provider]: current.api_key
      };

      // Restore previous model selection, or fall back to provider default
      const restoredModel = providerModelMemory[provider] ?? config.models[0] ?? '';

      return {
        ...current,
        provider,
        base_url: config.base_url,
        model: restoredModel,
        api_key: updatedKeys[provider] ?? '',
        provider_api_keys: updatedKeys,
        modes: provider === 'custom'
          ? current.modes
          : current.modes.map((m) => ({ ...m, model: defaultChatModel })),
      };
    });
    props.onTestAndSave();
  };

  /** Update a behavior field and auto-save immediately */
  const setBehavior = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    props.setSettings((current) => ({ ...current, [key]: value }));
    props.onSaveQuiet();
  };

  const providerConfig = () => PROVIDERS[props.settings().provider];
  const keyUrl = () => providerConfig().keyUrl;
  const copyKeyUrl = async () => {
    const url = keyUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notifySuccess('Copied key URL.');
    } catch (err) {
      notifyError(err, 'Failed to copy key URL.');
    }
  };

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
            <For each={PROVIDER_IDS}>
              {(provider) => {
                const isActive = () => props.settings().provider === provider;
                return (
                  <button
                    type="button"
                    onClick={() => onProviderChange(provider)}
                    class={`cursor-pointer relative p-4 rounded-xl border transition-colors flex flex-col items-center justify-center gap-2 ${
                      isActive()
                        ? 'border-primary bg-primary/5'
                        : 'border-white/10 bg-surface-dark hover:border-white/20 hover:bg-white/[0.03]'
                    }`}
                  >
                    <ProviderIcon provider={provider} active={isActive()} class="w-7 h-7" />
                    <span class={`font-medium text-sm ${
                      isActive() ? 'text-white' : 'text-gray-300'
                    }`}>
                      {PROVIDERS[provider].label}
                    </span>
                    <Show when={isActive()}>
                      <div class="absolute top-1.5 right-1.5">
                        <CircleCheck size={18} class="text-primary" fill="currentColor" stroke="black" />
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
                  <button
                    type="button"
                    onClick={() => void copyKeyUrl()}
                    class="text-xs text-primary hover:underline cursor-pointer"
                  >
                    Get key
                  </button>
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
                onClick={props.onTestAndSave}
                class="px-6 py-2.5 rounded-lg text-sm font-semibold text-black bg-primary hover:bg-primary-dark disabled:opacity-50 transition-colors cursor-pointer"
              >
                {props.saving() ? 'Testing...' : 'Save Provider'}
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
              <div class="flex bg-input-bg p-1 rounded-lg border border-white/15">
                <button
                  type="button"
                  onClick={() => setBehavior('copy_to_clipboard_on_success', false)}
                  class={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    !props.settings().copy_to_clipboard_on_success
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Paste
                </button>
                <button
                  type="button"
                  onClick={() => setBehavior('copy_to_clipboard_on_success', true)}
                  class={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    props.settings().copy_to_clipboard_on_success
                      ? 'bg-white/10 text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Paste + Copy
                </button>
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
