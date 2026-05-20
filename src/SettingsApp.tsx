import { createSignal, createEffect, createMemo, onCleanup, onMount, Switch, Match } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { Toaster } from 'solid-sonner';

import type { Settings, Tab, VocabularyEntry, TranscriptionHistoryItem, Mode, MeetingMeta, MeetingDetail, MeetingDevices } from './types';
import {
  CHAT_MODELS,
  DEFAULT_SETTINGS,
  MAX_REPLACEMENTS_PER_ENTRY,
  MAX_VOCABULARY_ENTRIES
} from './constants';
import { DEFAULT_MODES } from './defaultModes';
import { Layout, SettingsPage, RightPanel, HistoryPage, DictionaryPage, ModesPage, MeetingsPage } from './components/Settings';
import type { HistoryStats } from './components/Settings';
import { notifyError, notifyInfo, notifySuccess } from './lib/notify';

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
  const [settingsLoaded, setSettingsLoaded] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<Tab>('settings');
  const [saving, setSaving] = createSignal(false);

  const [history, setHistory] = createSignal<TranscriptionHistoryItem[]>([]);
  const [historySearchQuery, setHistorySearchQuery] = createSignal('');
  const [meetings, setMeetings] = createSignal<MeetingMeta[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = createSignal<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = createSignal<MeetingDetail | null>(null);
  const [meetingDevices, setMeetingDevices] = createSignal<MeetingDevices | null>(null);
  const meetingRecording = createMemo(() => meetings().some((meeting) => meeting.status === 'recording'));

  const [modelsList, setModelsList] = createSignal<string[]>([]);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  const [modelsError, setModelsError] = createSignal('');

  const [isDark, setIsDark] = createSignal(true);
  const [audioLevel, setAudioLevel] = createSignal<{ rms_db: number; peak_db: number } | null>(null);
  let audioLevelTimer: ReturnType<typeof setTimeout> | undefined;

  const [isVocabularyEditorOpen, setIsVocabularyEditorOpen] = createSignal(false);
  const [editingVocabularyId, setEditingVocabularyId] = createSignal<string | null>(null);
  const [editorWord, setEditorWord] = createSignal('');
  const [editorReplacements, setEditorReplacements] = createSignal('');
  let meetingsLoadSeq = 0;
  let meetingDetailLoadSeq = 0;

  type SaveSettingsQuietOptions = {
    notifyOnError?: boolean;
    errorMessage?: string;
  };

  const loadSettings = async () => {
    try {
      const result = await invoke<Settings>('get_settings');
      const merged = { ...DEFAULT_SETTINGS, ...result };
      const vocabulary = sanitizeVocabulary(Array.isArray(merged.vocabulary) ? merged.vocabulary : []);
      setSettings({ ...merged, vocabulary });
    } catch (err) {
      notifyError(err, 'Failed to load settings.');
    }
  };

  const closeSettingsWindow = async () => {
    setActiveTab('settings');
    setIsVocabularyEditorOpen(false);
    setEditingVocabularyId(null);
    try {
      await invoke('hide_settings_window');
    } catch (err) {
      notifyError(err, 'Failed to close settings window.');
    }
  };

  const saveSettingsQuiet = async (options: SaveSettingsQuietOptions = {}): Promise<boolean> => {
    try {
      const sanitizedSettings = {
        ...settings(),
        vocabulary: sanitizeVocabulary(settings().vocabulary)
      };
      await invoke('save_settings', { settings: sanitizedSettings });
      setSettings(sanitizedSettings);
      await emit('settings-updated');
      return true;
    } catch (err) {
      if (options.notifyOnError) {
        notifyError(err, options.errorMessage ?? 'Failed to save settings.');
      }
      return false;
    }
  };

  const saveSettings = async () => {
    setSaving(true);
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
      notifyError(err, 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    try {
      const message = await invoke<string>('test_connection', { settings: settings() });
      notifySuccess(message);
    } catch (err) {
      notifyError(err, 'Connection test failed.');
    }
  };

  const testAndSaveProvider = async () => {
    setSaving(true);
    try {
      const message = await invoke<string>('test_connection', { settings: settings() });
      const saved = await saveSettingsQuiet({
        notifyOnError: true,
        errorMessage: 'Connection test passed, but saving provider failed.',
      });
      if (!saved) return;
      notifySuccess(message);
    } catch (err) {
      notifyError(err, 'Provider test failed.');
    } finally {
      setSaving(false);
    }
  };

  const saveModes = async (): Promise<boolean> => {
    const saved = await saveSettingsQuiet({
      notifyOnError: true,
      errorMessage: 'Failed to save mode changes.',
    });
    if (saved) {
      notifySuccess('Mode changes saved.');
    }
    return saved;
  };

  const persistVocabulary = async (nextVocabulary: VocabularyEntry[], message?: string) => {
    const sanitizedVocabulary = sanitizeVocabulary(nextVocabulary);
    try {
      await invoke('save_vocabulary', { vocabulary: sanitizedVocabulary });
      setSettings((current) => ({ ...current, vocabulary: sanitizedVocabulary }));
      if (message) notifySuccess(message);
      return true;
    } catch (err) {
      notifyError(err, 'Failed to save vocabulary.');
      return false;
    }
  };

  const loadHistory = async () => {
    try {
      const items = await invoke<TranscriptionHistoryItem[]>('get_transcription_history');
      setHistory(items);
    } catch (err) {
      notifyError(err, 'Failed to load history.');
    }
  };

  const loadMeetings = async () => {
    const seq = ++meetingsLoadSeq;
    try {
      const items = await invoke<MeetingMeta[]>('list_meetings');
      if (seq !== meetingsLoadSeq) return;
      setMeetings(items);
      const selected = selectedMeetingId();
      if (selected && items.some((item) => item.id === selected)) {
        await loadMeetingDetail(selected);
      } else if (items[0]) {
        setSelectedMeetingId(items[0].id);
        await loadMeetingDetail(items[0].id);
      } else {
        setSelectedMeetingId(null);
        setSelectedMeeting(null);
      }
    } catch (err) {
      notifyError(err, 'Failed to load meetings.');
    }
  };

  const upsertMeetingMeta = (meta: MeetingMeta) => {
    setMeetings((current) => {
      const next = [meta, ...current.filter((item) => item.id !== meta.id)];
      next.sort((a, b) => b.started_at_ms - a.started_at_ms);
      return next;
    });
    setSelectedMeeting((current) => (
      current?.meta.id === meta.id ? { ...current, meta } : current
    ));
  };

  const loadMeetingDetail = async (id: string) => {
    const seq = ++meetingDetailLoadSeq;
    try {
      const detail = await invoke<MeetingDetail>('get_meeting', { id });
      if (seq !== meetingDetailLoadSeq || selectedMeetingId() !== id) return;
      setSelectedMeeting(detail);
    } catch (err) {
      notifyError(err, 'Failed to load meeting.');
    }
  };

  const selectMeeting = (id: string) => {
    setSelectedMeetingId(id);
    void loadMeetingDetail(id);
  };

  const deleteMeeting = async (id: string) => {
    if (!window.confirm('Delete this meeting recording and its source file?')) return;
    try {
      await invoke('delete_meeting', { id });
      notifySuccess('Meeting deleted.');
      await loadMeetings();
    } catch (err) {
      notifyError(err, 'Failed to delete meeting.');
    }
  };

  const loadMeetingDevices = async () => {
    try {
      const devices = await invoke<MeetingDevices>('list_meeting_devices');
      setMeetingDevices(devices);
      setSettings((current) => ({
        ...current,
        meeting_mic_device: current.meeting_mic_device ?? devices.audio_devices[0] ?? null,
        meeting_system_audio_device:
          current.meeting_system_audio_device &&
          devices.system_audio_devices.includes(current.meeting_system_audio_device)
            ? current.meeting_system_audio_device
            : null,
        meeting_record_system_audio:
          devices.system_audio_devices.length > 0 ? current.meeting_record_system_audio : false,
      }));
      if (devices.message) {
        notifyInfo(devices.message);
      }
    } catch (err) {
      notifyError(err, 'Failed to list meeting devices.');
    }
  };

  const startMeetingRecording = async () => {
    if (!settings().meeting_consent_acknowledged) {
      notifyError('Acknowledge meeting recording consent before recording.');
      return;
    }

    const saved = await saveSettingsQuiet({
      notifyOnError: true,
      errorMessage: 'Failed to save meeting capture settings before recording.',
    });
    if (!saved) return;

    try {
      const devices = meetingDevices();
      const systemAudioDevice =
        settings().meeting_record_system_audio &&
        settings().meeting_system_audio_device &&
        (devices?.system_audio_devices.includes(settings().meeting_system_audio_device) ?? false)
          ? settings().meeting_system_audio_device
          : null;

      const meta = await invoke<MeetingMeta>('start_meeting', {
        opts: {
          record_video: settings().meeting_record_video,
          record_mic: settings().meeting_record_mic,
          record_system_audio: settings().meeting_record_system_audio,
          video_preset: settings().meeting_video_preset,
          mic_device: settings().meeting_mic_device,
          system_audio_device: systemAudioDevice,
        },
      });
      upsertMeetingMeta(meta);
      setSelectedMeetingId(meta.id);
      await loadMeetingDetail(meta.id);
      notifySuccess('Meeting recording started.');
    } catch (err) {
      notifyError(err, 'Failed to start meeting recording.');
    }
  };

  const stopMeetingRecording = async () => {
    try {
      const meta = await invoke<MeetingMeta>('stop_meeting');
      upsertMeetingMeta(meta);
      setSelectedMeetingId(meta.id);
      await loadMeetingDetail(meta.id);
      notifySuccess('Meeting recording saved.');
      void loadMeetings();
    } catch (err) {
      await loadMeetings();
      notifyError(err, 'Failed to stop meeting recording.');
    }
  };

  const deleteHistoryItem = async (id: string) => {
    try {
      await invoke('delete_transcription_history_item', { id });
      setHistory((prev) => prev.filter((item) => item.id !== id));
      notifySuccess('Entry deleted.');
    } catch (err) {
      notifyError(err, 'Failed to delete history entry.');
    }
  };

  const clearHistory = async () => {
    try {
      await invoke('clear_transcription_history');
      setHistory([]);
      notifySuccess('History cleared.');
    } catch (err) {
      notifyError(err, 'Failed to clear history.');
    }
  };

  const copyHistoryText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notifySuccess('Copied to clipboard.');
    } catch (err) {
      notifyError(err, 'Failed to copy to clipboard.');
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
    if (tab !== 'history') {
      setHistorySearchQuery('');
    }
    if (tab !== 'dictionary') {
      cancelVocabularyEditor();
    }
    if (tab === 'meetings') {
      void loadMeetings();
      void loadMeetingDevices();
    }
  };

  const fetchModels = async (reconcileModes: boolean) => {
    const provider = settings().provider;
    const baseUrl = settings().base_url;
    const apiKey = settings().api_key;
    setModelsLoading(true);
    setModelsError('');
    try {
      const result = await invoke<string[]>('fetch_provider_models', {
        baseUrl,
        apiKey
      });
      const fallback = CHAT_MODELS[provider] ?? [];
      const availableModels = result.length > 0 ? result : fallback;
      setModelsList(availableModels);
      setModelsError(result.length === 0 ? 'API returned no models, using defaults' : '');
      if (reconcileModes && provider !== 'custom' && availableModels.length > 0) {
        const preferred = CHAT_MODELS[provider]?.[0] ?? availableModels[0];
        const defaultModel = availableModels.includes(preferred) ? preferred : availableModels[0];
        setSettings((current) => ({
          ...current,
          modes: current.modes.map((mode) =>
            availableModels.includes(mode.model) ? mode : { ...mode, model: defaultModel }
          )
        }));
      }
    } catch (err) {
      setModelsError('Model fetch failed: ' + String(err));
      const fallback = CHAT_MODELS[provider] ?? [];
      setModelsList(fallback);
      if (reconcileModes && provider !== 'custom' && fallback.length > 0) {
        const defaultModel = fallback[0];
        setSettings((current) => ({
          ...current,
          modes: current.modes.map((mode) =>
            fallback.includes(mode.model) ? mode : { ...mode, model: defaultModel }
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
    void saveSettingsQuiet();
  };

  const updateMode = (id: string, field: keyof Mode, value: string) => {
    setSettings((current) => ({
      ...current,
      modes: current.modes.map((mode) => (mode.id === id ? { ...mode, [field]: value } : mode))
    }));
  };

  const setActiveModeId = (id: string | null) => {
    setSettings((current) => ({ ...current, active_mode_id: id }));
    void saveSettingsQuiet();
  };

  const resetModes = async () => {
    setSettings((current) => ({
      ...current,
      modes: DEFAULT_MODES,
      active_mode_id: null,
    }));
    await saveSettingsQuiet();
  };

  const openCreateVocabularyEditor = () => {
    if (settings().vocabulary.length >= MAX_VOCABULARY_ENTRIES) {
      notifyInfo(`Maximum ${MAX_VOCABULARY_ENTRIES} entries reached.`);
      return;
    }
    setEditingVocabularyId(null);
    setEditorWord('');
    setEditorReplacements('');
    setIsVocabularyEditorOpen(true);
  };

  const openEditVocabularyEditor = (entry: VocabularyEntry) => {
    setEditingVocabularyId(entry.id);
    setEditorWord(entry.word);
    setEditorReplacements(entry.replacements.join('\n'));
    setIsVocabularyEditorOpen(true);
  };

  const cancelVocabularyEditor = () => {
    setEditingVocabularyId(null);
    setEditorWord('');
    setEditorReplacements('');
    setIsVocabularyEditorOpen(false);
  };

  const saveVocabularyEntry = async () => {
    const word = editorWord().trim();
    if (!word) {
      notifyError('Word is required.');
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
  };

  const toggleTheme = () => {
    const next = !isDark();
    setIsDark(next);
    localStorage.setItem('dikt-theme', next ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !next);
  };

  const provider = createMemo(() => settings().provider);
  let isInitialLoad = true;

  createEffect(() => {
    provider();
    if (!settingsLoaded()) return;
    const shouldReconcileModes = isInitialLoad;
    if (shouldReconcileModes) isInitialLoad = false;
    void fetchModels(shouldReconcileModes);
  });

  onMount(async () => {
    const savedTheme = localStorage.getItem('dikt-theme');
    const dark = savedTheme !== 'light';
    setIsDark(dark);
    document.documentElement.classList.toggle('light', !dark);

    await loadSettings();
    setSettingsLoaded(true);
    await loadHistory();
    await loadMeetings();
    await loadMeetingDevices();

    const unlistenOpened = await listen('settings-window-opened', () => {
      void loadSettings();
      void loadHistory();
    });

    const unlistenHistoryUpdated = await listen('transcription-history-updated', () => {
      void loadHistory();
    });

    const unlistenMeetingsUpdated = await listen('meetings-updated', () => {
      void loadMeetings();
    });

    const unlistenHistoryError = await listen<string>('transcription-history-error', (event) => {
      notifyError(event.payload);
      void loadHistory();
    });

    const unlistenAudioLevel = await listen<{ rms_db: number; peak_db: number }>('audio:level', (event) => {
      setAudioLevel(event.payload);
      clearTimeout(audioLevelTimer);
      audioLevelTimer = setTimeout(() => setAudioLevel(null), 150);
    });

    onCleanup(() => {
      void unlistenOpened();
      void unlistenHistoryUpdated();
      void unlistenMeetingsUpdated();
      void unlistenHistoryError();
      void unlistenAudioLevel();
      clearTimeout(audioLevelTimer);
    });
  });

  const isFullBleedTab = () => activeTab() === 'history' || activeTab() === 'dictionary' || activeTab() === 'modes' || activeTab() === 'meetings';

  return (
    <>
      <Toaster
        theme={isDark() ? 'dark' : 'light'}
        position="top-right"
        richColors
        duration={2200}
        visibleToasts={5}
        closeButton
      />
      <Layout
        activeTab={activeTab}
        onTabChange={switchToTab}
        rightPanel={isFullBleedTab() ? undefined : (
          <RightPanel
            activeTab={activeTab}
            modes={() => settings().modes}
            activeModeId={() => settings().active_mode_id}
            onSetActiveModeId={setActiveModeId}
            audioLevel={audioLevel}
          />
        )}
        fullBleed={isFullBleedTab()}
        isDark={isDark}
        onToggleTheme={toggleTheme}
    >
      <Switch>
        <Match when={activeTab() === 'settings'}>
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            saving={saving}
            onTest={testConnection}
            onSave={saveSettings}
            onSaveQuiet={saveSettingsQuiet}
            onTestAndSave={testAndSaveProvider}
          />
        </Match>
        <Match when={activeTab() === 'history'}>
          <HistoryPage
            history={filteredHistory}
            totalCount={() => history().length}
            todayCount={() => historyStats().todayCount}
            totalAudioSecs={() => historyStats().totalAudioSecs}
            searchQuery={historySearchQuery}
            onSearchQueryChange={(value) => setHistorySearchQuery(value)}
            onCopy={copyHistoryText}
            onDelete={deleteHistoryItem}
            onClearAll={clearHistory}
          />
        </Match>
        <Match when={activeTab() === 'dictionary'}>
          <DictionaryPage
            entries={() => settings().vocabulary}
            isEditorOpen={isVocabularyEditorOpen}
            editingId={editingVocabularyId}
            editorWord={editorWord}
            setEditorWord={setEditorWord}
            editorReplacements={editorReplacements}
            setEditorReplacements={setEditorReplacements}
            onOpenCreate={openCreateVocabularyEditor}
            onEdit={openEditVocabularyEditor}
            onSave={saveVocabularyEntry}
            onCancel={cancelVocabularyEditor}
            onToggleEnabled={toggleVocabularyEntryEnabled}
            onDelete={deleteVocabularyEntry}
          />
        </Match>
        <Match when={activeTab() === 'modes'}>
          <ModesPage
            modes={() => settings().modes}
            activeModeId={() => settings().active_mode_id}
            modelsList={modelsList}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            onUpdateMode={updateMode}
            onSetActiveModeId={setActiveModeId}
            onAddMode={addMode}
            onDeleteMode={deleteMode}
            onResetModes={resetModes}
            onSave={saveModes}
            saving={saving}
          />
        </Match>
        <Match when={activeTab() === 'meetings'}>
          <MeetingsPage
            meetings={meetings}
            selectedMeetingId={selectedMeetingId}
            selectedMeeting={selectedMeeting}
            devices={meetingDevices}
            settings={settings}
            setSettings={setSettings}
            onSelectMeeting={selectMeeting}
            onDeleteMeeting={deleteMeeting}
            onRefreshDevices={loadMeetingDevices}
            meetingRecording={meetingRecording}
            onStartRecording={startMeetingRecording}
            onStopRecording={stopMeetingRecording}
            onSaveSettings={() => saveSettingsQuiet({
              notifyOnError: true,
              errorMessage: 'Failed to save meeting capture settings.',
            })}
          />
        </Match>
      </Switch>
    </Layout>
    </>
  );
}
