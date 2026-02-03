import { createSignal, onCleanup, onMount, Show, For, createEffect } from 'solid-js';
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

// Audio visualization constants
const NUM_BARS = 7;
const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 20;

type Settings = {
  base_url: string;
  model: string;
  hotkey: string;
  api_key: string;
};

const DEFAULT_SETTINGS: Settings = {
  base_url: 'https://api.openai.com/v1',
  model: 'whisper-1',
  hotkey: 'Control+Space',
  api_key: ''
};

const COLLAPSED_HEIGHT = 100;
const EXPANDED_HEIGHT = 480;
const PANEL_WIDTH = 360;

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
  const [audioLevels, setAudioLevels] = createSignal<number[]>(Array(NUM_BARS).fill(MIN_BAR_HEIGHT));
  let registeredHotkey = DEFAULT_SETTINGS.hotkey;

  // Audio visualization refs
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let mediaStream: MediaStream | null = null;
  let animationId: number | null = null;

  const startAudioVisualization = async () => {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 32; // Small FFT for few bars
      analyser.smoothingTimeConstant = 0.7;

      const source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevels = () => {
        if (!analyser || status() !== 'recording') return;

        analyser.getByteFrequencyData(dataArray);

        // Map frequency data to bar heights
        const levels: number[] = [];
        const step = Math.floor(dataArray.length / NUM_BARS);
        for (let i = 0; i < NUM_BARS; i++) {
          // Average a few frequency bins for each bar
          let sum = 0;
          for (let j = 0; j < step; j++) {
            sum += dataArray[i * step + j] || 0;
          }
          const avg = sum / step;
          // Map 0-255 to MIN_BAR_HEIGHT-MAX_BAR_HEIGHT
          const height = MIN_BAR_HEIGHT + (avg / 255) * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
          levels.push(height);
        }
        setAudioLevels(levels);

        animationId = requestAnimationFrame(updateLevels);
      };

      updateLevels();
    } catch (err) {
      console.error('Failed to start audio visualization:', err);
    }
  };

  const stopAudioVisualization = () => {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    analyser = null;
    setAudioLevels(Array(NUM_BARS).fill(MIN_BAR_HEIGHT));
  };

  // Start/stop visualization based on recording status
  createEffect(() => {
    if (status() === 'recording') {
      startAudioVisualization();
    } else {
      stopAudioVisualization();
    }
  });

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
    try {
      await invoke('start_recording');
    } catch (err) {
      setStatus('error');
      setError(String(err));
    }
  };

  const handleReleased = async () => {
    if (status() !== 'recording') return;
    try {
      const result = (await invoke<string>('stop_and_transcribe')) ?? '';
      // Backend also emits structured status updates; keep this as a fallback.
      if (result) setText(result);
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
        width: expanded ? PANEL_WIDTH : 320,
        height: expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT
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

    const unlistenDictation = await listen<DictationUpdate>('dictation:update', (event) => {
      const payload = event.payload;
      switch (payload.state) {
        case 'recording': {
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
          if (payload.text != null) setText(payload.text);
          setStatus('done');
          setTimeout(() => setStatus('idle'), 1500);
          break;
        }
        case 'error': {
          setStatus('error');
          setError(payload.message ?? 'Error');
          break;
        }
        case 'idle':
        default: {
          setStatus('idle');
          break;
        }
      }
    });

    onCleanup(() => {
      void unlisten();
      void unlistenDictation();
    });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
    stopAudioVisualization();
  });

  const onField = (key: keyof Settings) => (event: Event) => {
    const target = event.target as HTMLInputElement;
    setSettings((current) => ({ ...current, [key]: target.value }));
  };

  const startDrag = async (e: MouseEvent) => {
    // Don't drag if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    e.preventDefault();
    await getCurrentWindow().startDragging();
  };

  const isActive = () =>
    status() === 'recording' || status() === 'transcribing' || status() === 'pasting';

  return (
    <div class="app-container" onMouseDown={startDrag}>
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

      <Show when={!showSettings()}>
        {/* Tooltip - appears on hover */}
        <div class="tooltip" classList={{ visible: isHovered() && !isActive() }}>
          <span>Click or hold <strong>{formatHotkey(settings().hotkey)}</strong> to start dictating</span>
        </div>

        {/* The minimal pill */}
        <div
          class="pill"
          classList={{
            expanded: isHovered() || isActive(),
            recording: status() === 'recording'
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Idle: just dots */}
          <Show when={status() === 'idle' && !isHovered()}>
            <div class="idle-dots">
              <span /><span /><span /><span /><span />
            </div>
          </Show>

          {/* Hovered idle: show hotkey + settings */}
          <Show when={status() === 'idle' && isHovered()}>
            <span class="hotkey-text">{formatHotkey(settings().hotkey)}</span>
            <button class="gear-button" onClick={toggleSettings} title="Settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </Show>

          {/* Recording: real-time audio visualization */}
          <Show when={status() === 'recording'}>
            <div class="wave-bars">
              <For each={audioLevels()}>
                {(height) => <div class="wave-bar" style={{ height: `${height}px` }} />}
              </For>
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
      </Show>
    </div>
  );
}
