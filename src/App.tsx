import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Status = 'idle' | 'recording' | 'transcribing' | 'pasting' | 'done' | 'error';
type Tab = 'settings' | 'vocabulary';

type DictationUpdate = {
  state: 'idle' | 'recording' | 'transcribing' | 'pasting' | 'done' | 'error';
  message?: string;
  text?: string;
};

type Provider = 'groq' | 'openai' | 'custom';

type VocabularyEntry = {
  id: string;
  word: string;
  replacements: string[];
  enabled: boolean;
};

type Settings = {
  provider: Provider;
  base_url: string;
  model: string;
  hotkey: string;
  api_key: string;
  vocabulary: VocabularyEntry[];
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
  api_key: '',
  vocabulary: []
};

const COLLAPSED_HEIGHT = 100;
const PANEL_WIDTH = 320;
const SETTINGS_PANEL_BOTTOM_OFFSET = 48;
const MAX_VOCABULARY_ENTRIES = 100;
const MAX_REPLACEMENTS_PER_ENTRY = 10;

const formatHotkey = (hotkey: string): string => {
  return hotkey
    .replace('Control+Super', 'Ctrl + Win')
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\+/g, ' + ');
};

const createVocabularyId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `vocab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const sanitizeVocabularyEntry = (entry: Partial<VocabularyEntry>): VocabularyEntry => {
  const replacements = Array.from(
    new Set(
      (entry.replacements ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).slice(0, MAX_REPLACEMENTS_PER_ENTRY);

  return {
    id: (entry.id ?? '').trim() || createVocabularyId(),
    word: (entry.word ?? '').trim(),
    replacements,
    enabled: entry.enabled ?? true
  };
};

const sanitizeVocabulary = (vocabulary: VocabularyEntry[]): VocabularyEntry[] => {
  return vocabulary
    .map((entry) => sanitizeVocabularyEntry(entry))
    .filter((entry) => entry.word.length > 0)
    .slice(0, MAX_VOCABULARY_ENTRIES);
};

export default function App() {
  const [status, setStatus] = createSignal<Status>('idle');
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal('');
  const [showSettings, setShowSettings] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<Tab>('settings');
  const [isHovered, setIsHovered] = createSignal(false);
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [testMessage, setTestMessage] = createSignal('');
  const [vocabularyMessage, setVocabularyMessage] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [isVocabularyEditorOpen, setIsVocabularyEditorOpen] = createSignal(false);
  const [editingVocabularyId, setEditingVocabularyId] = createSignal<string | null>(null);
  const [editorWord, setEditorWord] = createSignal('');
  const [editorReplacements, setEditorReplacements] = createSignal('');
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
      if (result) setText(result);
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
      const vocabulary = sanitizeVocabulary(Array.isArray(merged.vocabulary) ? merged.vocabulary : []);
      setSettings({ ...merged, vocabulary });
      await registerHotkey(merged.hotkey);
    } catch (err) {
      setError(String(err));
      await registerHotkey(DEFAULT_SETTINGS.hotkey);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    setTestMessage('');
    setVocabularyMessage('');
    try {
      const sanitizedSettings = {
        ...settings(),
        vocabulary: sanitizeVocabulary(settings().vocabulary)
      };
      await invoke('save_settings', { settings: sanitizedSettings });
      setSettings(sanitizedSettings);
      await registerHotkey(sanitizedSettings.hotkey);
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
    if (showSettings()) {
      await resizeWindowToFitSettings();
    }
  };

  const resizeWindowToFitSettings = async () => {
    if (!settingsPanelRef) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
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
      await resizeWindowToFitSettings();
    } else {
      setActiveTab('settings');
      setVocabularyMessage('');
      setIsVocabularyEditorOpen(false);
      setEditingVocabularyId(null);
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await invoke('resize_window', {
          width: PANEL_WIDTH,
          height: COLLAPSED_HEIGHT
        });
      } catch (err) {
        console.error('Failed to resize window:', err);
      }
    }
  };

  onMount(async () => {
    await loadSettings();

    let resizeObserver: ResizeObserver | undefined;
    if (settingsPanelRef) {
      resizeObserver = new ResizeObserver(() => {
        if (showSettings()) {
          void resizeWindowToFitSettings();
        }
      });
      resizeObserver.observe(settingsPanelRef);
    }

    const unlistenSettings = await listen('show-settings', async () => {
      if (!showSettings()) {
        await toggleSettings();
      }
      setActiveTab('settings');
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

    onCleanup(() => {
      void unlistenSettings();
      void unlistenDictation();
      resizeObserver?.disconnect();
    });
  });

  onCleanup(() => {
    void unregister(registeredHotkey);
  });

  const onField = (key: 'base_url' | 'model' | 'hotkey' | 'api_key') => (event: Event) => {
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

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    setTestMessage('');
    setVocabularyMessage('');
  };

  const persistVocabulary = async (nextVocabulary: VocabularyEntry[], message?: string) => {
    const sanitizedVocabulary = sanitizeVocabulary(nextVocabulary);
    try {
      await invoke('save_vocabulary', { vocabulary: sanitizedVocabulary });
      setSettings((current) => ({ ...current, vocabulary: sanitizedVocabulary }));
      if (message) setVocabularyMessage(message);
      return true;
    } catch (err) {
      setVocabularyMessage(String(err));
      return false;
    }
  };

  const openCreateVocabularyEditor = () => {
    if (settings().vocabulary.length >= MAX_VOCABULARY_ENTRIES) {
      setVocabularyMessage(`Maximum ${MAX_VOCABULARY_ENTRIES} entries reached.`);
      return;
    }
    setEditingVocabularyId(null);
    setEditorWord('');
    setEditorReplacements('');
    setVocabularyMessage('');
    setIsVocabularyEditorOpen(true);
  };

  const openEditVocabularyEditor = (entry: VocabularyEntry) => {
    setEditingVocabularyId(entry.id);
    setEditorWord(entry.word);
    setEditorReplacements(entry.replacements.join('\n'));
    setVocabularyMessage('');
    setIsVocabularyEditorOpen(true);
  };

  const cancelVocabularyEditor = () => {
    setEditingVocabularyId(null);
    setEditorWord('');
    setEditorReplacements('');
    setVocabularyMessage('');
    setIsVocabularyEditorOpen(false);
  };

  const saveVocabularyEntry = async () => {
    const word = editorWord().trim();
    if (!word) {
      setVocabularyMessage('Word is required.');
      return;
    }

    const replacements = Array.from(
      new Set(
        editorReplacements()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      )
    ).slice(0, MAX_REPLACEMENTS_PER_ENTRY);

    const editingId = editingVocabularyId();
    const existingEntry = settings().vocabulary.find((entry) => entry.id === editingId);

    const nextEntry = sanitizeVocabularyEntry({
      id: editingId ?? createVocabularyId(),
      word,
      replacements,
      enabled: existingEntry?.enabled ?? true
    });

    const nextVocabulary = editingId
      ? settings().vocabulary.map((entry) => (entry.id === editingId ? nextEntry : entry))
      : [...settings().vocabulary, nextEntry];
    const saved = await persistVocabulary(nextVocabulary, 'Vocabulary entry saved.');
    if (!saved) return;

    setIsVocabularyEditorOpen(false);
    setEditingVocabularyId(null);
    setEditorWord('');
    setEditorReplacements('');
  };

  const deleteVocabularyEntry = async (id: string) => {
    const nextVocabulary = settings().vocabulary.filter((entry) => entry.id !== id);
    const saved = await persistVocabulary(nextVocabulary, 'Vocabulary entry deleted.');
    if (!saved) return;
    if (editingVocabularyId() === id) cancelVocabularyEditor();
  };

  const toggleVocabularyEntryEnabled = async (id: string) => {
    const nextVocabulary = settings().vocabulary.map((entry) =>
      entry.id === id ? { ...entry, enabled: !entry.enabled } : entry
    );
    const saved = await persistVocabulary(nextVocabulary);
    if (!saved) return;
    setVocabularyMessage('');
  };

  const startDrag = async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea')) return;
    e.preventDefault();
    await getCurrentWindow().startDragging();
  };

  const isActive = () =>
    status() === 'recording' || status() === 'transcribing' || status() === 'pasting';

  return (
    <div class="app-container">
      <div ref={settingsPanelRef} class="settings-panel" classList={{ visible: showSettings() }}>
        <header class="settings-header">
          <span class="settings-title">dikt</span>
          <button class="collapse-button" onClick={toggleSettings} title="Collapse">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </header>

        <div class="tab-row">
          <button
            class="tab-button"
            classList={{ active: activeTab() === 'settings' }}
            onClick={() => switchToTab('settings')}
            type="button"
          >
            Settings
          </button>
          <button
            class="tab-button"
            classList={{ active: activeTab() === 'vocabulary' }}
            onClick={() => switchToTab('vocabulary')}
            type="button"
          >
            Vocabulary
          </button>
        </div>

        {/* Settings Tab */}
        <div class="settings-content tab-content" classList={{ hidden: activeTab() !== 'settings' }}>
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
            <Show
              when={settings().provider !== 'custom'}
              fallback={<input value={settings().model} onInput={onField('model')} placeholder="model-name" />}
            >
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
            <button class="button ghost" onClick={testConnection} type="button">
              Test
            </button>
            <button class="button" disabled={saving()} onClick={saveSettings} type="button">
              Save
            </button>
          </div>
        </div>

        {/* Vocabulary Tab */}
        <div class="settings-content vocabulary-content tab-content" classList={{ hidden: activeTab() !== 'vocabulary' }}>
          <Show when={vocabularyMessage()}>
            <div class="muted">{vocabularyMessage()}</div>
          </Show>

          <Show
            when={isVocabularyEditorOpen()}
            fallback={
              <>
                <Show
                  when={settings().vocabulary.length > 0}
                  fallback={<div class="muted">No vocabulary yet. Add terms you frequently dictate.</div>}
                >
                  <div class="vocabulary-list">
                    {settings().vocabulary.map((entry) => (
                      <div class="vocabulary-entry" classList={{ disabled: !entry.enabled }}>
                        <div class="vocabulary-entry-main">
                          <span class="vocabulary-word">{entry.word}</span>
                          <span class="vocabulary-meta">{entry.replacements.length} replacement(s)</span>
                        </div>
                        <div class="vocabulary-entry-actions">
                          <button
                            class="mini-button"
                            onClick={() => toggleVocabularyEntryEnabled(entry.id)}
                            type="button"
                          >
                            {entry.enabled ? 'On' : 'Off'}
                          </button>
                          <button class="mini-button" onClick={() => openEditVocabularyEditor(entry)} type="button">
                            Edit
                          </button>
                          <button
                            class="mini-button danger"
                            onClick={() => deleteVocabularyEntry(entry.id)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </Show>

                <button
                  class="button ghost wide"
                  onClick={openCreateVocabularyEditor}
                  disabled={settings().vocabulary.length >= MAX_VOCABULARY_ENTRIES}
                  type="button"
                >
                  + Add word
                </button>
              </>
            }
          >
            <div class="vocabulary-editor">
              <label class="field">
                <span>Word</span>
                <input
                  value={editorWord()}
                  onInput={(event) => setEditorWord((event.target as HTMLInputElement).value)}
                  placeholder="Kubernetes"
                />
              </label>

              <label class="field">
                <span>Replacements (one per line)</span>
                <textarea
                  value={editorReplacements()}
                  onInput={(event) => setEditorReplacements((event.target as HTMLTextAreaElement).value)}
                  rows={5}
                  placeholder="cube and eighties\nkuber nettis"
                />
              </label>

              <div class="muted">
                Up to {MAX_REPLACEMENTS_PER_ENTRY} replacements. Matching is case-insensitive and word-boundary based.
              </div>

              <div class="actions">
                <button class="button ghost" onClick={cancelVocabularyEditor} type="button">
                  Cancel
                </button>
                <button class="button" onClick={saveVocabularyEntry} type="button">
                  Save Entry
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <Show when={!showSettings()}>
        <div class="tooltip" classList={{ visible: isHovered() && !isActive() }}>
          <span>
            Hold to talk: <strong>{formatHotkey(settings().hotkey)}</strong>
          </span>
        </div>
      </Show>

      <div
        class="pill"
        classList={{
          expanded: (isHovered() || isActive()) && !showSettings(),
          recording: status() === 'recording',
          transcribing: status() === 'transcribing' || status() === 'pasting'
        }}
        onMouseDown={startDrag}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <Show when={status() === 'idle' && (!isHovered() || showSettings())}>
          <div class="idle-dots">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </Show>

        <Show when={status() === 'idle' && isHovered() && !showSettings()}>
          <span class="hotkey-text">{formatHotkey(settings().hotkey)}</span>
          <button class="gear-button" onClick={toggleSettings} title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Show>

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

        <Show when={status() === 'transcribing' || status() === 'pasting'}>
          <div class="loading-dots">
            <span />
            <span />
            <span />
          </div>
        </Show>

        <Show when={status() === 'done'}>
          <svg class="check-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </Show>

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
