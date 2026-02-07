import { createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { DictationUpdate, Settings, Status } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { Pill, Tooltip } from './components';

export default function App() {
  const [status, setStatus] = createSignal<Status>('idle');
  const [error, setError] = createSignal('');
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [isHovered, setIsHovered] = createSignal(false);
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false);

  let isHolding = false;
  let registeredHotkey = DEFAULT_SETTINGS.hotkey;
  const hotkeyRegistrationMessage = 'Could not register hotkey - it may be in use by another app. Change it in Settings.';

  const registerHotkey = async (hotkey: string): Promise<boolean> => {
    if (registeredHotkey) {
      await unregister(registeredHotkey).catch(() => {});
    }

    try {
      await register(hotkey, (event) => {
        if (event.state === 'Pressed') {
          void handlePressed();
        } else if (event.state === 'Released') {
          void handleReleased();
        }
      });
      registeredHotkey = hotkey;
      return true;
    } catch (err) {
      console.error('Failed to register global hotkey:', err);
      return false;
    }
  };

  const handlePressed = async () => {
    if (settings().hotkey_mode === 'hold') {
      if (isHolding || status() === 'recording') return;
      isHolding = true;
      setError('');
      setStatus('recording');
      try {
        await invoke('start_recording');
      } catch (err) {
        isHolding = false;
        setStatus('error');
        setError(String(err));
      }
      return;
    }

    if (status() === 'recording') {
      setStatus('transcribing');
      try {
        await invoke('stop_and_transcribe');
        if (status() !== 'error') {
          setStatus('done');
          setTimeout(() => {
            if (status() === 'done') setStatus('idle');
          }, 1500);
        }
      } catch (err) {
        setStatus('error');
        setError(String(err));
      }
      return;
    }

    if (status() === 'idle' || status() === 'done' || status() === 'error') {
      setError('');
      setStatus('recording');
      try {
        await invoke('start_recording');
      } catch (err) {
        setStatus('error');
        setError(String(err));
      }
    }
  };

  const handleReleased = async () => {
    if (settings().hotkey_mode !== 'hold' || !isHolding) return;

    isHolding = false;
    setStatus('transcribing');
    try {
      await invoke('stop_and_transcribe');
      if (status() !== 'error') {
        setStatus('done');
        setTimeout(() => {
          if (status() === 'done') setStatus('idle');
        }, 1500);
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
      const registered = await registerHotkey(merged.hotkey);
      if (!registered) {
        setError(hotkeyRegistrationMessage);
      } else {
        setError('');
      }
    } catch (err) {
      const settingsError = String(err);
      const registered = await registerHotkey(DEFAULT_SETTINGS.hotkey);
      if (!registered) {
        setError(`${settingsError}\n${hotkeyRegistrationMessage}`);
        return;
      }
      setError(settingsError);
    }
  };

  const toggleSettingsWindow = async () => {
    try {
      if (isSettingsOpen()) {
        await invoke('hide_settings_window');
      } else {
        await invoke('show_settings_window');
      }
    } catch (err) {
      console.error('Failed to toggle settings window:', err);
    }
  };

  const startDrag = async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea')) return;

    e.preventDefault();
    await getCurrentWindow().startDragging();
  };

  const isActive = () =>
    status() === 'recording' ||
    status() === 'transcribing' ||
    status() === 'formatting' ||
    status() === 'pasting';

  onMount(async () => {
    document.body.classList.add('window-main');
    await loadSettings();

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
        case 'formatting': {
          setError('');
          setStatus('formatting');
          break;
        }
        case 'pasting': {
          setError('');
          setStatus('pasting');
          break;
        }
        case 'done': {
          isHolding = false;
          setStatus('done');
          setTimeout(() => {
            if (status() === 'done') setStatus('idle');
          }, 1500);
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

    const unlistenSettingsOpened = await listen('settings-window-opened', () => {
      setIsSettingsOpen(true);
    });

    const unlistenSettingsClosed = await listen('settings-window-closed', () => {
      setIsSettingsOpen(false);
    });

    const unlistenSettingsUpdated = await listen('settings-updated', () => {
      void loadSettings();
    });

    onCleanup(() => {
      document.body.classList.remove('window-main');
      void unlistenDictation();
      void unlistenSettingsOpened();
      void unlistenSettingsClosed();
      void unlistenSettingsUpdated();
    });
  });

  // Passthrough (click-through) only during idle.
  // During active states, disable passthrough so WebView2 repaints properly.
  createEffect(() => {
    const s = status();
    void invoke('set_cursor_passthrough', { ignore: s === 'idle' });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
  });

  return (
    <div
      class="app-container"
      onMouseMove={() => {
        if (status() === 'idle' && !isHovered()) {
          void invoke('set_cursor_passthrough', { ignore: true });
        }
      }}
      onMouseLeave={() => {
        if (status() === 'idle') {
          void invoke('set_cursor_passthrough', { ignore: true });
        }
      }}
    >
      <div
        class="pill-area"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          if (status() === 'idle') {
            void invoke('set_cursor_passthrough', { ignore: true });
          }
        }}
      >
        <Tooltip
          visible={isHovered() && !isActive() && !isSettingsOpen()}
          hotkey={settings().hotkey}
          hotkeyMode={settings().hotkey_mode}
          onSettingsClick={toggleSettingsWindow}
        />

        <Pill
          status={status}
          error={error}
          onMouseDown={startDrag}
          onSettingsClick={toggleSettingsWindow}
        />
      </div>
    </div>
  );
}
