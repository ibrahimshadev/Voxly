import { createSignal, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

import type { Settings, Tab, VocabularyEntry } from './types';
import {
  DEFAULT_SETTINGS,
  MAX_REPLACEMENTS_PER_ENTRY,
  MAX_VOCABULARY_ENTRIES
} from './constants';
import { SettingsPanel } from './components';

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

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    setTestMessage('');
    setVocabularyMessage('');
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

  onMount(async () => {
    document.body.classList.add('window-settings');
    await loadSettings();

    const unlistenOpened = await listen('settings-window-opened', () => {
      setTestMessage('');
      setVocabularyMessage('');
      void loadSettings();
    });

    onCleanup(() => {
      document.body.classList.remove('window-settings');
      void unlistenOpened();
    });
  });

  return (
    <div class="window-settings-root">
      <SettingsPanel
        visible={() => true}
        activeTab={activeTab}
        settings={settings}
        setSettings={setSettings}
        testMessage={testMessage}
        vocabularyMessage={vocabularyMessage}
        saving={saving}
        isVocabularyEditorOpen={isVocabularyEditorOpen}
        editorWord={editorWord}
        setEditorWord={setEditorWord}
        editorReplacements={editorReplacements}
        setEditorReplacements={setEditorReplacements}
        onCollapse={closeSettingsWindow}
        onTabChange={switchToTab}
        onTest={testConnection}
        onSave={saveSettings}
        onVocabularyOpenCreate={openCreateVocabularyEditor}
        onVocabularyEdit={openEditVocabularyEditor}
        onVocabularySave={saveVocabularyEntry}
        onVocabularyCancel={cancelVocabularyEditor}
        onVocabularyToggleEnabled={toggleVocabularyEntryEnabled}
        onVocabularyDelete={deleteVocabularyEntry}
      />
    </div>
  );
}
