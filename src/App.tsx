import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Status = 'idle' | 'recording' | 'transcribing' | 'pasting' | 'done' | 'error';

type DictationUpdate = {
  state: 'idle' | 'recording' | 'transcribing' | 'pasting' | 'done' | 'error';
  message?: string;
  text?: string;
};

type Provider = 'groq' | 'openai' | 'custom';

type Settings = {
  provider: Provider;
  base_url: string;
  model: string;
  hotkey: string;
  api_key: string;
};

const PROVIDERS = {
  groq: {
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en']
  },
  openai: {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    models: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']
  },
  custom: {
    label: 'Custom',
    base_url: '',
    models: []
  }
} as const;

const DEFAULT_SETTINGS: Settings = {
  provider: 'groq',
  base_url: PROVIDERS.groq.base_url,
  model: PROVIDERS.groq.models[0],
  hotkey: 'CommandOrControl+Space',
  api_key: ''
};

const COLLAPSED_HEIGHT = 100;
const PANEL_WIDTH = 320;
const SETTINGS_PANEL_BOTTOM_OFFSET = 48; // Space for pill + padding

// Format hotkey for display
const formatHotkey = (hotkey: string): string => {
  return hotkey
    .replace('Control+Super', 'Ctrl + Win')
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\+/g, ' + ');
};

export default function App() {
  const [status, setStatus] = createSignal<Status>('idle');
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal('');
  const [showSettings, setShowSettings] = createSignal(false);
  const [isHovered, setIsHovered] = createSignal(false);
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [testMessage, setTestMessage] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  let isHolding = false;
  let registeredHotkey = DEFAULT_SETTINGS.hotkey;
  let settingsPanelRef: HTMLDivElement | undefined;

  const registerHotkey = async (hotkey: string) => {
    if (registeredHotkey) {
      await unregister(registeredHotkey).catch(() => {});
    }
    await register(hotkey, (event) => {
      if (event.state === 'Pressed') {
        void handlePressed();
      } else if (event.state === 'Released') {
        void handleReleased();
      }
    });
    registeredHotkey = hotkey;
  };

  const handlePressed = async () => {
    if (isHolding || status() === 'recording') return;
    isHolding = true;
    // Set status synchronously BEFORE calling backend to avoid race condition
    // with handleReleased (which checks status before calling stop_and_transcribe)
    setError('');
    setStatus('recording');
    try {
      await invoke('start_recording');
    } catch (err) {
      isHolding = false;
      setStatus('error');
      setError(String(err));
    }
  };

  const handleReleased = async () => {
    if (!isHolding) return;
    isHolding = false;
    setStatus('transcribing');
    try {
      const result = (await invoke<string>('stop_and_transcribe')) ?? '';
      // Backend emits structured status updates; keep a UI fallback.
      if (result) setText(result);
      if (status() !== 'error') {
        setStatus('done');
        setTimeout(() => setStatus('idle'), 1500);
      }
    } catch (err) {
      setStatus('error');
      setError(String(err));
    }
  };

  const loadSettings = async () => {
    try {
      const result = await invoke<Settings>('get_settings');
      const merged = { ...DEFAULT_SETTINGS, ...result };
      setSettings(merged);
      await registerHotkey(merged.hotkey);
    } catch (err) {
      setError(String(err));
      await registerHotkey(DEFAULT_SETTINGS.hotkey);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setTestMessage('');
    try {
      await invoke('save_settings', { settings: settings() });
      await registerHotkey(settings().hotkey);
      setTestMessage('Settings saved.');
      await toggleSettings();
    } catch (err) {
      setTestMessage(String(err));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTestMessage('');
    try {
      const message = await invoke<string>('test_connection', { settings: settings() });
      setTestMessage(message);
    } catch (err) {
      setTestMessage(String(err));
    }
    // Resize window if content height changed
    if (showSettings()) {
      await resizeWindowToFitSettings();
    }
  };

  const resizeWindowToFitSettings = async () => {
    if (!settingsPanelRef) return;
    // Wait for DOM to update
    await new Promise(resolve => setTimeout(resolve, 10));
    const panelHeight = settingsPanelRef.offsetHeight;
    const windowHeight = panelHeight + SETTINGS_PANEL_BOTTOM_OFFSET;
    try {
      await invoke('resize_window', {
        width: PANEL_WIDTH,
        height: windowHeight
      });
    } catch (err) {
      console.error('Failed to resize window:', err);
    }
  };

  const toggleSettings = async () => {
    const expanded = !showSettings();
    setShowSettings(expanded);
    setIsHovered(false);
    if (expanded) {
      // Resize after settings panel renders
      await resizeWindowToFitSettings();
    } else {
      // Wait for CSS transition to complete before resizing window
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        await invoke('resize_window', {
          width: 320,
          height: COLLAPSED_HEIGHT
        });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    }
  };

  onMount(async () => {
    await loadSettings();

    // Watch for settings panel size changes
    let resizeObserver: ResizeObserver | undefined;
    if (settingsPanelRef) {
      resizeObserver = new ResizeObserver(() => {
        if (showSettings()) {
          void resizeWindowToFitSettings();
        }
      });
      resizeObserver.observe(settingsPanelRef);
    }

    // Listen for tray settings event
    const unlisten = await listen('show-settings', async () => {
      if (!showSettings()) {
        await toggleSettings();
      }
    });

    const unlistenDictation = await listen<DictationUpdate>('dictation:update', (event) => {
      const payload = event.payload;
      switch (payload.state) {
        case 'recording': {
          if (!isHolding) break;
          setError('');
          setStatus('recording');
          break;
        }
        case 'transcribing': {
          setError('');
          setStatus('transcribing');
          break;
        }
        case 'pasting': {
          setError('');
          setStatus('pasting');
          break;
        }
        case 'done': {
          isHolding = false;
          if (payload.text != null) setText(payload.text);
          setStatus('done');
          setTimeout(() => setStatus('idle'), 1500);
          break;
        }
        case 'error': {
          isHolding = false;
          setStatus('error');
          setError(payload.message ?? 'Error');
          break;
        }
        case 'idle':
        default: {
          isHolding = false;
          setStatus('idle');
          break;
        }
      }
    });

    onCleanup(() => {
      void unlisten();
      void unlistenDictation();
      resizeObserver?.disconnect();
    });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
  });

  const onField = (key: keyof Settings) => (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    setSettings((current) => ({ ...current, [key]: target.value }));
  };

  const onProviderChange = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    const provider = target.value as Provider;
    const config = PROVIDERS[provider];
    setSettings((current) => ({
      ...current,
      provider,
      base_url: config.base_url,
      model: config.models[0] ?? ''
    }));
  };

  const startDrag = async (e: MouseEvent) => {
    // Don't drag if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select')) return;
    e.preventDefault();
    await getCurrentWindow().startDragging();
  };

  const isActive = () =>
    status() === 'recording' || status() === 'transcribing' || status() === 'pasting';

  return (
    <div class="app-container">
      <div ref={settingsPanelRef} class="settings-panel" classList={{ visible: showSettings() }}>
          <header class="settings-header">
            <span class="settings-title">Settings</span>
            <button class="collapse-button" onClick={toggleSettings} title="Collapse">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </header>

          <div class="settings-content">
            <label class="field">
              <span>Provider</span>
              <select value={settings().provider} onChange={onProviderChange}>
                <option value="groq">Groq</option>
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label class="field">
              <span>Base URL</span>
              <input
                value={settings().base_url}
                onInput={onField('base_url')}
                placeholder="https://api.groq.com/openai/v1"
              />
            </label>
            <label class="field">
              <span>Model</span>
              <Show when={settings().provider !== 'custom'} fallback={
                <input value={settings().model} onInput={onField('model')} placeholder="model-name" />
              }>
                <select value={settings().model} onChange={onField('model')}>
                  {PROVIDERS[settings().provider].models.map((model) => (
                    <option value={model}>{model}</option>
                  ))}
                </select>
              </Show>
            </label>
            <label class="field">
              <span>API Key</span>
              <input
                type="password"
                value={settings().api_key}
                onInput={onField('api_key')}
                placeholder="sk-..."
              />
            </label>
            <label class="field">
              <span>Hotkey</span>
              <input value={settings().hotkey} onInput={onField('hotkey')} />
            </label>

            <Show when={!settings().api_key}>
              <div class="warning">Missing API key</div>
            </Show>

            <Show when={testMessage()}>
              <div class="muted">{testMessage()}</div>
            </Show>

            <div class="actions">
              <button class="button ghost" onClick={testConnection}>
                Test
              </button>
              <button class="button" disabled={saving()} onClick={saveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>

      <Show when={!showSettings()}>
        {/* Tooltip - appears on hover */}
        <div class="tooltip" classList={{ visible: isHovered() && !isActive() }}>
          <span>Hold to talk: <strong>{formatHotkey(settings().hotkey)}</strong></span>
        </div>
      </Show>

      {/* The minimal pill */}
      <div
        class="pill"
        classList={{
          expanded: (isHovered() || isActive()) && !showSettings(),
          recording: status() === 'recording'
        }}
        onMouseDown={startDrag}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Idle: just dots (or when settings is open) */}
        <Show when={status() === 'idle' && (!isHovered() || showSettings())}>
          <div class="idle-dots">
            <span /><span /><span /><span /><span />
          </div>
        </Show>

        {/* Hovered idle: show hotkey + settings (only when settings panel is closed) */}
        <Show when={status() === 'idle' && isHovered() && !showSettings()}>
          <span class="hotkey-text">{formatHotkey(settings().hotkey)}</span>
          <button class="gear-button" onClick={toggleSettings} title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Show>

        {/* Recording: static visualization (no mic access) */}
        <Show when={status() === 'recording'}>
          <div class="wave-bars">
            <span class="wave-bar" />
            <span class="wave-bar" />
            <span class="wave-bar" />
            <span class="wave-bar" />
            <span class="wave-bar" />
            <span class="wave-bar" />
            <span class="wave-bar" />
          </div>
        </Show>

        {/* Transcribing */}
        <Show when={status() === 'transcribing' || status() === 'pasting'}>
          <div class="loading-dots">
            <span /><span /><span />
          </div>
        </Show>

        {/* Done */}
        <Show when={status() === 'done'}>
          <svg class="check-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </Show>

        {/* Error */}
        <Show when={status() === 'error'}>
          <span class="error-icon" title={error()}>!</span>
          <Show when={isHovered()}>
            <button class="gear-button" onClick={toggleSettings} title="Settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </Show>
        </Show>
      </div>
    </div>
  );
}
