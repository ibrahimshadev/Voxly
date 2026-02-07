import { createSignal, createEffect, createMemo, on, onCleanup, onMount, Switch, Match } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

import type { Settings, Tab, VocabularyEntry, TranscriptionHistoryItem, Mode } from './types';
import {
  CHAT_MODELS,
  DEFAULT_SETTINGS,
  MAX_REPLACEMENTS_PER_ENTRY,
  MAX_VOCABULARY_ENTRIES
} from './constants';
import { Layout, SettingsPage, RightPanel, HistoryPage } from './components/Settings';
import type { HistoryStats } from './components/Settings';

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

export default function SettingsApp() {
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = createSignal<Tab>('settings');
  const [testMessage, setTestMessage] = createSignal('');
  const [vocabularyMessage, setVocabularyMessage] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  const [history, setHistory] = createSignal<TranscriptionHistoryItem[]>([]);
  const [historyMessage, setHistoryMessage] = createSignal('');
  const [historySearchQuery, setHistorySearchQuery] = createSignal('');
  let historyMessageTimer: ReturnType<typeof setTimeout> | undefined;

  const flashHistoryMessage = (msg: string, ms = 2000) => {
    clearTimeout(historyMessageTimer);
    setHistoryMessage(msg);
    historyMessageTimer = setTimeout(() => setHistoryMessage(''), ms);
  };

  const [modelsList, setModelsList] = createSignal<string[]>([]);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  const [modelsError, setModelsError] = createSignal('');

  const [isDark, setIsDark] = createSignal(true);

  const [isVocabularyEditorOpen, setIsVocabularyEditorOpen] = createSignal(false);
  const [editingVocabularyId, setEditingVocabularyId] = createSignal<string | null>(null);
  const [editorWord, setEditorWord] = createSignal('');
  const [editorReplacements, setEditorReplacements] = createSignal('');

  const loadSettings = async () => {
    try {
      const result = await invoke<Settings>('get_settings');
      const merged = { ...DEFAULT_SETTINGS, ...result };
      const vocabulary = sanitizeVocabulary(Array.isArray(merged.vocabulary) ? merged.vocabulary : []);
      setSettings({ ...merged, vocabulary });
    } catch (err) {
      setTestMessage(String(err));
    }
  };

  const closeSettingsWindow = async () => {
    setActiveTab('settings');
    setVocabularyMessage('');
    setIsVocabularyEditorOpen(false);
    setEditingVocabularyId(null);
    try {
      await invoke('hide_settings_window');
    } catch (err) {
      setTestMessage(String(err));
    }
  };

  const saveSettingsQuiet = async () => {
    try {
      const sanitizedSettings = {
        ...settings(),
        vocabulary: sanitizeVocabulary(settings().vocabulary)
      };
      await invoke('save_settings', { settings: sanitizedSettings });
      setSettings(sanitizedSettings);
      await emit('settings-updated');
    } catch (_) { /* silent */ }
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
      await emit('settings-updated');
      await closeSettingsWindow();
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

  const loadHistory = async () => {
    try {
      const items = await invoke<TranscriptionHistoryItem[]>('get_transcription_history');
      setHistory(items);
    } catch (err) {
      setHistoryMessage(String(err));
    }
  };

  const deleteHistoryItem = async (id: string) => {
    try {
      await invoke('delete_transcription_history_item', { id });
      setHistory((prev) => prev.filter((item) => item.id !== id));
      flashHistoryMessage('Entry deleted.');
    } catch (err) {
      setHistoryMessage(String(err));
    }
  };

  const clearHistory = async () => {
    try {
      await invoke('clear_transcription_history');
      setHistory([]);
      flashHistoryMessage('History cleared.');
    } catch (err) {
      setHistoryMessage(String(err));
    }
  };

  const copyHistoryText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flashHistoryMessage('Copied to clipboard.');
    } catch (err) {
      setHistoryMessage('Failed to copy: ' + String(err));
    }
  };

  const filteredHistory = createMemo(() => {
    const query = historySearchQuery().trim().toLowerCase();
    if (!query) return history();

    return history().filter((item) =>
      item.text.toLowerCase().includes(query) ||
      (item.original_text?.toLowerCase().includes(query) ?? false) ||
      (item.mode_name?.toLowerCase().includes(query) ?? false)
    );
  });

  const historyStats = createMemo<HistoryStats>(() => {
    const allItems = history();
    const now = Date.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const todayStartMs = startOfToday.getTime();
    const weekStartMs = now - (7 * 24 * 60 * 60 * 1000);

    let todayCount = 0;
    let weekCount = 0;
    let latestAt: number | null = null;
    let totalAudioSecs = 0;
    let audioCount = 0;

    for (const item of allItems) {
      const timestamp = item.created_at_ms;
      if (!Number.isFinite(timestamp)) continue;

      if (latestAt === null || timestamp > latestAt) {
        latestAt = timestamp;
      }
      if (timestamp >= todayStartMs) {
        todayCount += 1;
      }
      if (timestamp >= weekStartMs) {
        weekCount += 1;
      }
      if (item.duration_secs != null && Number.isFinite(item.duration_secs)) {
        totalAudioSecs += item.duration_secs;
        audioCount += 1;
      }
    }

    return {
      filteredCount: filteredHistory().length,
      totalCount: allItems.length,
      todayCount,
      weekCount,
      latestAt,
      totalAudioSecs,
      averageAudioSecs: audioCount > 0 ? totalAudioSecs / audioCount : 0,
    };
  });

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    setTestMessage('');
    setVocabularyMessage('');
    setHistoryMessage('');
    if (tab !== 'history') {
      setHistorySearchQuery('');
    }
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const result = await invoke<string[]>('fetch_provider_models', {
        baseUrl: settings().base_url,
        apiKey: settings().api_key
      });
      const fallback = CHAT_MODELS[settings().provider] ?? [];
      const availableModels = result.length > 0 ? result : fallback;
      setModelsList(availableModels);
      setModelsError(result.length === 0 ? 'API returned no models, using defaults' : '');
      if (settings().provider !== 'custom' && availableModels.length > 0) {
        const firstModel = availableModels[0];
        setSettings((current) => ({
          ...current,
          modes: current.modes.map((mode) =>
            availableModels.includes(mode.model) ? mode : { ...mode, model: firstModel }
          )
        }));
      }
    } catch (err) {
      setModelsError('Model fetch failed: ' + String(err));
      const fallback = CHAT_MODELS[settings().provider] ?? [];
      setModelsList(fallback);
      if (settings().provider !== 'custom' && fallback.length > 0) {
        const firstModel = fallback[0];
        setSettings((current) => ({
          ...current,
          modes: current.modes.map((mode) =>
            fallback.includes(mode.model) ? mode : { ...mode, model: firstModel }
          )
        }));
      }
    } finally {
      setModelsLoading(false);
    }
  };

  const addMode = () => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const preferred = CHAT_MODELS[settings().provider]?.[0] ?? '';
    const available = modelsList();
    const defaultModel = available.includes(preferred) ? preferred
      : available.length > 0 ? available[0]
      : preferred;
    const newMode: Mode = { id, name: '', system_prompt: '', model: defaultModel };
    setSettings((current) => ({ ...current, modes: [...current.modes, newMode] }));
  };

  const deleteMode = (id: string) => {
    setSettings((current) => {
      const nextModes = current.modes.filter((mode) => mode.id !== id);
      const nextActiveModeId = current.active_mode_id === id ? null : current.active_mode_id;
      return { ...current, modes: nextModes, active_mode_id: nextActiveModeId };
    });
  };

  const updateMode = (id: string, field: keyof Mode, value: string) => {
    setSettings((current) => ({
      ...current,
      modes: current.modes.map((mode) => (mode.id === id ? { ...mode, [field]: value } : mode))
    }));
  };

  const setActiveModeId = (id: string | null) => {
    setSettings((current) => ({ ...current, active_mode_id: id }));
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

  const toggleTheme = () => {
    const next = !isDark();
    setIsDark(next);
    localStorage.setItem('dikt-theme', next ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !next);
  };

  const provider = createMemo(() => settings().provider);

  createEffect(on(
    () => [provider(), activeTab()] as const,
    ([_provider, tab]) => {
      if (tab === 'modes') {
        void fetchModels();
      }
    }
  ));

  onMount(async () => {
    const savedTheme = localStorage.getItem('dikt-theme');
    const dark = savedTheme !== 'light';
    setIsDark(dark);
    document.documentElement.classList.toggle('light', !dark);

    await loadSettings();
    await loadHistory();

    const unlistenOpened = await listen('settings-window-opened', () => {
      setTestMessage('');
      setVocabularyMessage('');
      setHistoryMessage('');
      void loadSettings();
      void loadHistory();
    });

    const unlistenHistoryError = await listen<string>('transcription-history-error', (event) => {
      setHistoryMessage(event.payload);
      void loadHistory();
    });

    onCleanup(() => {
      void unlistenOpened();
      void unlistenHistoryError();
    });
  });

  const isHistoryTab = () => activeTab() === 'history';

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={switchToTab}
      rightPanel={isHistoryTab() ? undefined : <RightPanel activeTab={activeTab} />}
      fullBleed={isHistoryTab()}
      isDark={isDark}
      onToggleTheme={toggleTheme}
    >
      <Switch>
        <Match when={activeTab() === 'settings'}>
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            testMessage={testMessage}
            saving={saving}
            onTest={testConnection}
            onSave={saveSettings}
            onSaveQuiet={saveSettingsQuiet}
          />
        </Match>
        <Match when={isHistoryTab()}>
          <HistoryPage
            history={filteredHistory}
            totalCount={() => history().length}
            todayCount={() => historyStats().todayCount}
            totalAudioSecs={() => historyStats().totalAudioSecs}
            message={historyMessage}
            searchQuery={historySearchQuery}
            onSearchQueryChange={(value) => setHistorySearchQuery(value)}
            onCopy={copyHistoryText}
            onDelete={deleteHistoryItem}
            onClearAll={clearHistory}
          />
        </Match>
        <Match when={activeTab() === 'vocabulary'}>
          <div class="py-20 text-center text-gray-500">Vocabulary is coming soon.</div>
        </Match>
        <Match when={activeTab() === 'modes'}>
          <div class="py-20 text-center text-gray-500">Modes is coming soon.</div>
        </Match>
      </Switch>
    </Layout>
  );
}
