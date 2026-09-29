import { createSignal, createEffect, createMemo, on, onCleanup, onMount, Switch, Match } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { Toaster } from 'solid-sonner';

import type { Settings, Tab, VocabularyEntry, KeytermEntry, TranscriptionHistoryItem, TranscriptionHistoryPage, TranscriptionHistoryStats, Mode, MeetingMeta, MeetingDetail, MeetingDevices, MeetingSummary, MeetingUpdate, MeetingTranscript } from './types';
import {
  DEFAULT_SETTINGS,
  MAX_KEYTERM_LEN,
  MAX_KEYTERMS,
  MAX_REPLACEMENTS_PER_ENTRY,
  MAX_VOCABULARY_ENTRIES,
  PROVIDERS
} from './constants';
import { DEFAULT_MODES } from './defaultModes';
import { Layout, SettingsPage, RightPanel, HistoryPage, DictionaryPage, ModesPage, MeetingsPage } from './components/Settings';
import { notifyError, notifyInfo, notifySuccess } from './lib/notify';

const HISTORY_PAGE_SIZE = 50;

const EMPTY_HISTORY_STATS: TranscriptionHistoryStats = {
  total_count: 0,
  today_count: 0,
  today_audio_secs: 0,
  total_audio_secs: 0,
};

const omit = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
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
    id: (entry.id ?? '').trim() || crypto.randomUUID(),
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

const sanitizeKeytermEntry = (entry: Partial<KeytermEntry>): KeytermEntry => ({
  id: (entry.id ?? '').trim() || crypto.randomUUID(),
  term: (entry.term ?? '').trim().slice(0, MAX_KEYTERM_LEN),
  enabled: entry.enabled ?? true
});

const sanitizeKeyterms = (entries: KeytermEntry[]): KeytermEntry[] => {
  const seen = new Set<string>();
  const sanitized: KeytermEntry[] = [];
  for (const entry of entries) {
    const next = sanitizeKeytermEntry(entry);
    if (!next.term) continue;
    const key = next.term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(next);
    if (sanitized.length >= MAX_KEYTERMS) break;
  }
  return sanitized;
};

const normalizeMeetingLanguage = (value: unknown): Settings['meeting_language'] =>
  value === 'multi' ? 'multi' : 'en';

export default function SettingsApp() {
  const [settings, setSettings] = createSignal<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<Tab>('settings');
  const [saving, setSaving] = createSignal(false);

  const [history, setHistory] = createSignal<TranscriptionHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = createSignal(0);
  const [historyPage, setHistoryPage] = createSignal(1);
  const [historyStats, setHistoryStats] = createSignal(EMPTY_HISTORY_STATS);
  const [historySearchQuery, setHistorySearchQuery] = createSignal('');
  const [meetings, setMeetings] = createSignal<MeetingMeta[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = createSignal<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = createSignal<MeetingDetail | null>(null);
  const [meetingDevices, setMeetingDevices] = createSignal<MeetingDevices | null>(null);
  // Saving progress per finalizing meeting id; null = indeterminate.
  const [processingMeetings, setProcessingMeetings] = createSignal<Record<string, number | null>>({});
  const [summaryGenerating, setSummaryGenerating] = createSignal<Record<string, boolean>>({});
  const [summaryErrors, setSummaryErrors] = createSignal<Record<string, string>>({});
  const meetingRecording = createMemo(() => meetings().some((meeting) => meeting.status === 'recording'));

  const [modelsList, setModelsList] = createSignal<string[]>([]);

  const [isDark, setIsDark] = createSignal(true);
  const [audioLevel, setAudioLevel] = createSignal<{ rms_db: number; peak_db: number } | null>(null);
  let audioLevelTimer: ReturnType<typeof setTimeout> | undefined;

  const [isVocabularyEditorOpen, setIsVocabularyEditorOpen] = createSignal(false);
  const [editingVocabularyId, setEditingVocabularyId] = createSignal<string | null>(null);
  const [editorWord, setEditorWord] = createSignal('');
  const [editorReplacements, setEditorReplacements] = createSignal('');
  let meetingsLoadSeq = 0;
  let meetingDetailLoadSeq = 0;
  let historyLoadSeq = 0;
  let historySearchTimer: ReturnType<typeof setTimeout> | undefined;

  type SaveSettingsQuietOptions = {
    notifyOnError?: boolean;
    errorMessage?: string;
  };

  const loadSettings = async () => {
    try {
      const result = await invoke<Settings>('get_settings');
      const merged = { ...DEFAULT_SETTINGS, ...result };
      const vocabulary = sanitizeVocabulary(Array.isArray(merged.vocabulary) ? merged.vocabulary : []);
      const keyterm_glossary = sanitizeKeyterms(
        Array.isArray(merged.keyterm_glossary) ? merged.keyterm_glossary : []
      );
      setSettings({
        ...merged,
        vocabulary,
        keyterm_glossary,
        meeting_language: normalizeMeetingLanguage(merged.meeting_language)
      });
    } catch (err) {
      notifyError(err, 'Failed to load settings.');
    }
  };

  const saveSettingsQuiet = async (options: SaveSettingsQuietOptions = {}): Promise<boolean> => {
    try {
      const sanitizedSettings = {
        ...settings(),
        vocabulary: sanitizeVocabulary(settings().vocabulary),
        keyterm_glossary: sanitizeKeyterms(settings().keyterm_glossary),
        meeting_language: normalizeMeetingLanguage(settings().meeting_language)
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

  const todayStartMs = () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return startOfToday.getTime();
  };

  const loadHistoryStats = async () => {
    try {
      const stats = await invoke<TranscriptionHistoryStats>('get_transcription_history_stats', {
        todayStartMs: todayStartMs(),
      });
      setHistoryStats(stats);
    } catch (err) {
      notifyError(err, 'Failed to load history stats.');
    }
  };

  const loadHistory = async (page = historyPage()) => {
    const seq = ++historyLoadSeq;
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * HISTORY_PAGE_SIZE;
    try {
      const result = await invoke<TranscriptionHistoryPage>('get_transcription_history', {
        offset,
        limit: HISTORY_PAGE_SIZE,
        query: historySearchQuery().trim() || null,
      });
      if (seq !== historyLoadSeq) return;
      if (safePage > 1 && result.items.length === 0 && result.total > 0) {
        const previousPage = safePage - 1;
        setHistoryPage(previousPage);
        await loadHistory(previousPage);
        return;
      }
      setHistoryPage(safePage);
      setHistory(result.items);
      setHistoryTotal(result.total);
    } catch (err) {
      notifyError(err, 'Failed to load history.');
    }
  };

  createEffect(on(historySearchQuery, () => {
    clearTimeout(historySearchTimer);
    if (!settingsLoaded() || activeTab() !== 'history') return;
    historySearchTimer = setTimeout(() => {
      setHistoryPage(1);
      void loadHistory(1);
    }, 250);
  }));

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

  // Optimistically patch a meeting in both the list and the open detail view.
  const patchMeetingMeta = (id: string, patch: Partial<MeetingMeta>) => {
    setMeetings((current) =>
      current.map((meeting) => (meeting.id === id ? { ...meeting, ...patch } : meeting))
    );
    setSelectedMeeting((current) =>
      current?.meta.id === id ? { ...current, meta: { ...current.meta, ...patch } } : current
    );
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
      notifyInfo('Saving recording…');
      void loadMeetings();
    } catch (err) {
      await loadMeetings();
      notifyError(err, 'Failed to stop meeting recording.');
    }
  };

  const transcribeMeeting = async (id: string) => {
    try {
      const meta = await invoke<MeetingMeta>('transcribe_meeting', { id });
      upsertMeetingMeta(meta);
      notifyInfo('Meeting transcription started.');
      void loadMeetings();
    } catch (err) {
      notifyError(err, 'Failed to start meeting transcription.');
    }
  };

  const generateSummary = async (id: string) => {
    setSummaryErrors((current) => omit(current, id));
    setSummaryGenerating((current) => ({ ...current, [id]: true }));
    try {
      const summary = await invoke<MeetingSummary>('generate_meeting_summary', { id });
      setSelectedMeeting((current) => (current?.meta.id === id ? { ...current, summary } : current));
      notifySuccess('Meeting summary ready.');
    } catch (err) {
      const message = typeof err === 'string' ? err : 'Failed to generate meeting summary.';
      setSummaryErrors((current) => ({ ...current, [id]: message }));
      notifyError(err, 'Failed to generate meeting summary.');
    } finally {
      setSummaryGenerating((current) => omit(current, id));
    }
  };

  const renameMeeting = async (id: string, title: string) => {
    try {
      const meta = await invoke<MeetingMeta>('rename_meeting', { id, title });
      setSelectedMeeting((current) => (current?.meta.id === id ? { ...current, meta } : current));
    } catch (err) {
      notifyError(err, 'Failed to rename meeting.');
    }
  };

  const renameMeetingSpeaker = async (id: string, speaker: string, name: string) => {
    const previous = selectedMeeting();
    const normalized = name.trim();
    setSelectedMeeting((current) => {
      if (current?.meta.id !== id || !current.transcript) return current;
      const speakerNames = { ...(current.transcript.speaker_names ?? {}) };
      if (normalized) speakerNames[speaker] = normalized;
      else delete speakerNames[speaker];
      return {
        ...current,
        transcript: { ...current.transcript, speaker_names: speakerNames }
      };
    });

    try {
      const transcript = await invoke<MeetingTranscript>('rename_meeting_speaker', {
        id,
        speaker,
        name: normalized
      });
      setSelectedMeeting((current) =>
        current?.meta.id === id ? { ...current, transcript } : current
      );
    } catch (err) {
      if (previous?.meta.id === id) setSelectedMeeting(previous);
      notifyError(err, 'Failed to rename speaker.');
    }
  };

  const updateHistoryItem = async (id: string, text: string) => {
    try {
      const updated = await invoke<TranscriptionHistoryItem>('update_transcription_history_item', {
        id,
        text,
      });
      // Patch in place: editing changes neither ordering nor counts, so a full
      // reload would only cost a scroll jump.
      setHistory((items) => items.map((item) => (item.id === id ? updated : item)));
      notifySuccess('Entry updated.');
    } catch (err) {
      notifyError(err, 'Failed to update history entry.');
      throw err; // keep the inline editor open so the unsaved edit isn't lost
    }
  };

  const deleteHistoryItem = async (id: string) => {
    try {
      await invoke('delete_transcription_history_item', { id });
      await loadHistory();
      await loadHistoryStats();
      notifySuccess('Entry deleted.');
    } catch (err) {
      notifyError(err, 'Failed to delete history entry.');
    }
  };

  const clearHistory = async () => {
    try {
      await invoke('clear_transcription_history');
      setHistoryPage(1);
      setHistory([]);
      setHistoryTotal(0);
      setHistoryStats(EMPTY_HISTORY_STATS);
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

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab !== 'history') {
      setHistorySearchQuery('');
    }
    if (tab !== 'dictionary') {
      cancelVocabularyEditor();
    }
    if (tab === 'history') {
      void loadHistory();
      void loadHistoryStats();
    }
    if (tab === 'meetings') {
      void loadMeetings();
      void loadMeetingDevices();
    }
  };

  const fetchModels = async (reconcileModes: boolean) => {
    const provider = settings().provider;
    const fallback = PROVIDERS[provider].chatModels;
    let available = fallback;
    try {
      const result = await invoke<string[]>('fetch_provider_models', {
        baseUrl: settings().base_url,
        apiKey: settings().api_key
      });
      if (result.length > 0) available = result;
    } catch {
      // Keep the curated list when the provider can't be reached.
    }
    setModelsList(available);
    if (reconcileModes && provider !== 'custom' && available.length > 0) {
      const preferred = fallback[0] ?? available[0];
      const defaultModel = available.includes(preferred) ? preferred : available[0];
      setSettings((current) => ({
        ...current,
        modes: current.modes.map((mode) =>
          available.includes(mode.model) ? mode : { ...mode, model: defaultModel }
        )
      }));
    }
  };

  const addMode = () => {
    const id = crypto.randomUUID();
    const preferred = PROVIDERS[settings().provider].chatModels[0] ?? '';
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

    const editingId = editingVocabularyId();
    const existingEntry = settings().vocabulary.find((entry) => entry.id === editingId);

    const nextEntry = sanitizeVocabularyEntry({
      id: editingId ?? undefined,
      word,
      replacements: editorReplacements().split('\n'),
      enabled: existingEntry?.enabled ?? true
    });

    const nextVocabulary = editingId
      ? settings().vocabulary.map((entry) => (entry.id === editingId ? nextEntry : entry))
      : [...settings().vocabulary, nextEntry];

    const saved = await persistVocabulary(nextVocabulary, 'Vocabulary entry saved.');
    if (saved) cancelVocabularyEditor();
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
    await loadHistoryStats();
    await loadMeetings();
    await loadMeetingDevices();

    const unlistenOpened = await listen('settings-window-opened', () => {
      void loadSettings();
      void loadHistory();
      void loadHistoryStats();
    });

    const unlistenHistoryUpdated = await listen('transcription-history-updated', () => {
      void loadHistory();
      void loadHistoryStats();
    });

    const unlistenMeetingsUpdated = await listen('meetings-updated', () => {
      void loadMeetings();
    });

    const unlistenMeetingUpdate = await listen<MeetingUpdate>('meeting:update', (event) => {
      const payload = event.payload;
      const id = payload.meeting_id;
      if (!id) return;

      switch (payload.state) {
        case 'processing':
          setProcessingMeetings((current) => ({ ...current, [id]: payload.progress_pct ?? null }));
          patchMeetingMeta(id, { status: 'processing' });
          break;
        case 'transcribing':
          patchMeetingMeta(id, { transcript_status: 'pending', transcript_error: undefined });
          break;
        case 'stopped':
          setProcessingMeetings((current) => omit(current, id));
          notifySuccess('Meeting recording saved.');
          void loadMeetings();
          break;
        case 'error':
          setProcessingMeetings((current) => omit(current, id));
          notifyError(payload.message ?? 'Failed to save meeting recording.');
          void loadMeetings();
          break;
        case 'transcribed':
          notifySuccess('Meeting transcript ready.');
          void loadMeetings();
          break;
        case 'transcription_error':
          notifyError(payload.message ?? 'Meeting transcription failed.');
          void loadMeetings();
          break;
      }
    });

    const unlistenHistoryError = await listen<string>('transcription-history-error', (event) => {
      notifyError(event.payload);
      void loadHistory();
      void loadHistoryStats();
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
      void unlistenMeetingUpdate();
      void unlistenHistoryError();
      void unlistenAudioLevel();
      clearTimeout(audioLevelTimer);
      clearTimeout(historySearchTimer);
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
            onSaveQuiet={saveSettingsQuiet}
            onTestAndSave={testAndSaveProvider}
          />
        </Match>
        <Match when={activeTab() === 'history'}>
          <HistoryPage
            history={history}
            currentPage={historyPage}
            pageSize={HISTORY_PAGE_SIZE}
            totalCount={historyTotal}
            stats={historyStats}
            searchQuery={historySearchQuery}
            onSearchQueryChange={(value) => setHistorySearchQuery(value)}
            onPageChange={(page) => void loadHistory(page)}
            onCopy={copyHistoryText}
            onEdit={updateHistoryItem}
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
            processingMeetings={processingMeetings}
            onStartRecording={startMeetingRecording}
            onStopRecording={stopMeetingRecording}
            onTranscribeMeeting={transcribeMeeting}
            onGenerateSummary={(id) => void generateSummary(id)}
            onRenameMeeting={(id, title) => void renameMeeting(id, title)}
            onRenameSpeaker={(id, speaker, name) => void renameMeetingSpeaker(id, speaker, name)}
            summaryGenerating={summaryGenerating}
            summaryErrors={summaryErrors}
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
