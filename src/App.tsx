import { createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Status = 'idle' | 'recording' | 'transcribing' | 'done' | 'error';

type Settings = {
  base_url: string;
  model: string;
  hotkey: string;
  api_key: string;
};

const DEFAULT_SETTINGS: Settings = {
  base_url: 'https://api.openai.com/v1',
  model: 'whisper-1',
  hotkey: 'Control+Super',
  api_key: ''
};

const PILL_HEIGHT = 48;
const EXPANDED_HEIGHT = 380;

// Format hotkey for display
const formatHotkey = (hotkey: string): string => {
  return hotkey
    .replace('Control+Super', 'Ctrl+Win')
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
  let registeredHotkey = DEFAULT_SETTINGS.hotkey;

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
    if (status() === 'recording') return;
    setError('');
    setStatus('recording');
    try {
      await invoke('start_recording');
    } catch (err) {
      setStatus('error');
      setError(String(err));
    }
  };

  const handleReleased = async () => {
    if (status() !== 'recording') return;
    setStatus('transcribing');
    try {
      const result = (await invoke<string>('stop_and_transcribe')) ?? '';
      setText(result);
      setStatus('done');
      setTimeout(() => setStatus('idle'), 1500);
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
  };

  const toggleSettings = async () => {
    const expanded = !showSettings();
    setShowSettings(expanded);
    try {
      await invoke('resize_window', {
        width: 200,
        height: expanded ? EXPANDED_HEIGHT : PILL_HEIGHT
      });
    } catch (err) {
      console.error('Failed to resize window:', err);
    }
  };

  onMount(async () => {
    await loadSettings();

    // Listen for tray settings event
    const unlisten = await listen('show-settings', async () => {
      if (!showSettings()) {
        await toggleSettings();
      }
    });

    onCleanup(() => {
      void unlisten();
    });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
  });

  const onField = (key: keyof Settings) => (event: Event) => {
    const target = event.target as HTMLInputElement;
    setSettings((current) => ({ ...current, [key]: target.value }));
  };

  const startDrag = async (e: MouseEvent) => {
    // Don't drag if clicking on a button
    if ((e.target as HTMLElement).closest('button')) return;
    await getCurrentWindow().startDragging();
  };

  return (
    <div class="pill-container">
      <Show when={showSettings()}>
        <div class="settings-panel">
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
              <span>Base URL</span>
              <input
                value={settings().base_url}
                onInput={onField('base_url')}
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label class="field">
              <span>Model</span>
              <input value={settings().model} onInput={onField('model')} placeholder="whisper-1" />
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
      </Show>

      <div
        class="pill"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onMouseDown={startDrag}
      >
        <Show when={status() === 'idle' && !showSettings()}>
          <span class="hotkey-text">{formatHotkey(settings().hotkey)}</span>
        </Show>

        <Show when={status() === 'recording'}>
          <div class="wave-bars">
            <For each={[0, 1, 2, 3, 4]}>
              {(i) => <div class="wave-bar" style={{ "animation-delay": `${i * 0.1}s` }} />}
            </For>
          </div>
        </Show>

        <Show when={status() === 'transcribing'}>
          <span class="status-text">...</span>
        </Show>

        <Show when={status() === 'done'}>
          <svg class="check-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </Show>

        <Show when={status() === 'error'}>
          <span class="error-text" title={error()}>!</span>
        </Show>

        <Show when={!showSettings()}>
          <button
            class="gear-button"
            classList={{ visible: isHovered() }}
            onClick={toggleSettings}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Show>
      </div>
    </div>
  );
}
