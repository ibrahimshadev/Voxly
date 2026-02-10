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

  // Send interactive hit regions to Rust for per-pixel click-through.
  // The OS hit-test handler uses these rects to decide which areas
  // are interactive vs transparent (pass clicks through).
  createEffect(() => {
    const hovered = isHovered();
    const active = isActive();
    const settingsOpen = isSettingsOpen();

    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];

    // Pill area with approach margin.
    // Window: 360x100, pill centered at bottom with 8px padding.
    // Margin must be large enough for the 50ms cursor tracker to catch
    // an approaching cursor before it reaches the pill (~15px at normal speed).
    const pillW = active ? 90 : 48;
    const pillH = active ? 28 : 20;
    const pillX = (360 - pillW) / 2;
    const pillY = 100 - 8 - pillH;
    const margin = 15;
    rects.push({
      x: pillX - margin,
      y: pillY - margin,
      w: pillW + 2 * margin,
      h: pillH + margin + 8,
    });

    // Tooltip area when visible
    if (hovered && !active && !settingsOpen) {
      const tooltipW = 220;
      const tooltipH = 36;
      const tooltipX = (360 - tooltipW) / 2;
      const tooltipY = pillY - 8 - tooltipH;
      rects.push({ x: tooltipX, y: tooltipY, w: tooltipW, h: tooltipH });
    }

    void invoke('update_hit_region', { rects });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
  });

  return (
    <div
      class="app-container"
      onPointerLeave={() => setIsHovered(false)}
    >
      <div
        class="pill-area"
        onPointerEnter={() => setIsHovered(true)}
        onPointerMove={() => { if (!isHovered()) setIsHovered(true); }}
        onPointerLeave={() => setIsHovered(false)}
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
