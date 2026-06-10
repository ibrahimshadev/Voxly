import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  Bot,
  Calendar,
  ChevronDown,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  HardDrive,
  Loader2,
  Mic,
  Monitor,
  Pencil,
  Play,
  RefreshCcw,
  Square,
  Trash2,
  UploadCloud,
  Video,
  Volume2,
} from 'lucide-solid';
import type { JSX } from 'solid-js';
import type { MeetingDetail, MeetingDevices, MeetingMeta, Provider, Settings } from '../../types';
import { PROVIDERS, SUMMARY_MODELS } from '../../constants';
import { notifyError, notifySuccess } from '../../lib/notify';
import { renderMarkdown } from '../../lib/markdown';
import { createPanelResize } from '../../lib/panelResize';
import Select from './Select';
import { GroqIcon, OpenAIIcon } from './SettingsPage';

type MeetingsPageProps = {
  meetings: Accessor<MeetingMeta[]>;
  selectedMeetingId: Accessor<string | null>;
  selectedMeeting: Accessor<MeetingDetail | null>;
  devices: Accessor<MeetingDevices | null>;
  settings: Accessor<Settings>;
  setSettings: Setter<Settings>;
  onSelectMeeting: (id: string) => void;
  onDeleteMeeting: (id: string) => void;
  onRefreshDevices: () => void;
  meetingRecording: Accessor<boolean>;
  processingMeetings: Accessor<Record<string, number | null>>;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onTranscribeMeeting: (id: string) => void;
  onGenerateSummary: (id: string) => void;
  onRenameMeeting: (id: string, title: string) => void;
  summaryGenerating: Accessor<Record<string, boolean>>;
  summaryErrors: Accessor<Record<string, string>>;
  onSaveSettings: () => Promise<boolean>;
};

const VIDEO_PRESETS = [
  { value: 'screen_720p_30', label: 'Screen 720p / 30 fps' },
  { value: 'screen_720p_15', label: 'Screen 720p / 15 fps' },
  { value: 'screen_1080p_30', label: 'Screen 1080p / 30 fps' },
  { value: 'audio_only', label: 'Audio only' },
];

type TranscriptTab = 'transcript' | 'summary';

type ConfigTab = 'capture' | 'transcription' | 'summary';

const CONFIG_TABS: { value: ConfigTab; label: string }[] = [
  { value: 'capture', label: 'Capture' },
  { value: 'transcription', label: 'Transcription' },
  { value: 'summary', label: 'AI Summary' },
];

type SummaryProviderOption = {
  value: Provider;
  label: string;
  icon?: string;
  iconComponent?: (props: { class?: string }) => JSX.Element;
};

const SUMMARY_PROVIDER_OPTIONS: SummaryProviderOption[] = [
  { value: 'groq', label: 'Groq', iconComponent: GroqIcon },
  { value: 'openai', label: 'OpenAI', iconComponent: OpenAIIcon },
  { value: 'custom', label: 'Custom', icon: 'dns' },
];

// Session-scoped model stash per provider (mirrors providerModelMemory in SettingsPage).
const summaryModelMemory: Partial<Record<Provider, string>> = {};

function formatDate(ms: number) {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(seconds?: number) {
  if (!seconds) return '0:00';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes?: number) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatHotkeyForDisplay(hotkey: string) {
  return hotkey
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Shift', 'Shift')
    .replace(/\+/g, ' + ');
}

function formatSpeakerLabel(speaker: string) {
  return speaker === 'You' || speaker === 'System' ? speaker : `Speaker ${speaker}`;
}

function transcriptStatusLabel(meeting: MeetingMeta) {
  if (meeting.status === 'processing') return 'Saving';
  if (meeting.transcript_status === 'pending') return 'Transcribing';
  if (meeting.transcript_status === 'completed') return 'Transcribed';
  if (meeting.transcript_status === 'error') return 'Error';
  if (meeting.status === 'recording') return 'Recording';
  if (meeting.status === 'error') return 'Error';
  return 'Ready';
}

function statusClass(meeting: MeetingMeta) {
  const label = transcriptStatusLabel(meeting);
  if (label === 'Ready' || label === 'Transcribed') {
    return 'border-primary/35 bg-primary/10 text-primary';
  }
  if (label === 'Saving') {
    return 'border-sky-400/35 bg-sky-500/10 text-sky-300';
  }
  if (label === 'Transcribing') {
    return 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300';
  }
  if (label === 'Recording') {
    return 'border-red-400/35 bg-red-500/10 text-red-300';
  }
  return 'border-amber-400/35 bg-amber-500/10 text-amber-300';
}

function ToggleRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={`rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 flex items-center justify-between gap-3 text-left transition-colors ${
        props.disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:bg-white/[0.04] cursor-pointer'
      }`}
    >
      <span class="min-w-0 flex flex-col gap-1">
        <span class="text-sm font-medium text-gray-200 leading-tight">{props.label}</span>
        <Show when={props.description}>
          <span class="text-[11px] text-gray-500 leading-snug">{props.description}</span>
        </Show>
      </span>
      <span
        class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
          props.checked ? 'bg-primary' : 'bg-white/10'
        }`}
      >
        <span
          class={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            props.checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
          }`}
        />
      </span>
    </button>
  );
}

export default function MeetingsPage(props: MeetingsPageProps) {
  let videoRef: HTMLVideoElement | undefined;
  const [activeTab, setActiveTab] = createSignal<TranscriptTab>('transcript');
  const [configTab, setConfigTab] = createSignal<ConfigTab>('capture');
  const [showSummaryKey, setShowSummaryKey] = createSignal(false);
  const [editingTitleId, setEditingTitleId] = createSignal<string | null>(null);
  const [titleDraft, setTitleDraft] = createSignal('');
  const [configCollapsed, setConfigCollapsed] = createSignal(
    localStorage.getItem('meetings.configCollapsed') === '1',
  );

  const toggleConfigCollapsed = () => {
    const next = !configCollapsed();
    setConfigCollapsed(next);
    try {
      localStorage.setItem('meetings.configCollapsed', next ? '1' : '0');
    } catch {
      // Best-effort persistence only.
    }
  };

  const leftResize = createPanelResize({
    storageKey: 'meetings.leftPanelPercent',
    defaultPercent: 45,
    minPercent: 28,
    maxPercent: 65,
    axis: 'x',
  });
  const videoResize = createPanelResize({
    storageKey: 'meetings.videoPanelPercent',
    defaultPercent: 40,
    minPercent: 20,
    maxPercent: 75,
    axis: 'y',
  });

  const startTitleEdit = (meeting: MeetingDetail) => {
    setTitleDraft(meeting.meta.title);
    setEditingTitleId(meeting.meta.id);
  };

  const cancelTitleEdit = () => {
    setTitleDraft('');
    setEditingTitleId(null);
  };

  const commitTitleEdit = () => {
    const editingId = editingTitleId();
    const selected = props.selectedMeeting();
    setEditingTitleId(null);
    if (!editingId || !selected || selected.meta.id !== editingId) return;
    const draft = titleDraft().trim();
    if (!draft || draft === selected.meta.title) return;
    props.onRenameMeeting(editingId, draft);
  };

  const summaryModelOptions = () =>
    SUMMARY_MODELS[props.settings().summary_provider].map((model) => ({
      value: model,
      label: model,
    }));

  const onSummaryProviderChange = (provider: Provider) => {
    if (provider === props.settings().summary_provider) return;
    applyChange((current) => {
      const previous = current.summary_provider;
      const stashedKeys = { ...current.summary_provider_api_keys };
      if (current.summary_api_key.trim()) {
        stashedKeys[previous] = current.summary_api_key;
      } else {
        delete stashedKeys[previous];
      }
      summaryModelMemory[previous] = current.summary_model;

      // Restore this provider's summary key; if none, prefill from the
      // transcription-side key for the same provider (spec §11.8 step 2).
      const restoredKey = stashedKeys[provider]?.trim()
        ? (stashedKeys[provider] as string)
        : (current.provider_api_keys[provider] ?? '');

      return {
        ...current,
        summary_provider: provider,
        summary_base_url: PROVIDERS[provider].base_url,
        summary_model: summaryModelMemory[provider] ?? SUMMARY_MODELS[provider][0] ?? '',
        summary_api_key: restoredKey,
        summary_provider_api_keys: stashedKeys,
      };
    });
  };

  const audioOptions = createMemo(() => {
    const devices = props.devices()?.audio_devices ?? [];
    return [
      { value: '', label: 'Not selected' },
      ...devices.map((device) => ({ value: device, label: device })),
    ];
  });

  const systemAudioOptions = createMemo(() => {
    const devices = props.devices()?.system_audio_devices ?? [];
    return [
      { value: '', label: 'Default Windows output' },
      ...devices.map((device) => ({ value: device, label: device })),
    ];
  });

  const selectedProcessingPct = createMemo(() => {
    const meeting = props.selectedMeeting();
    if (!meeting || meeting.meta.status !== 'processing') return null;
    return props.processingMeetings()[meeting.meta.id] ?? null;
  });

  const selectedSourceUrl = createMemo(() => {
    const meeting = props.selectedMeeting();
    if (
      !meeting ||
      meeting.meta.status === 'recording' ||
      meeting.meta.status === 'processing' ||
      !meeting.meta.file_size_bytes
    ) {
      return '';
    }

    const version = [
      meeting.meta.status,
      meeting.meta.ended_at_ms ?? meeting.meta.started_at_ms,
      meeting.meta.file_size_bytes,
    ].join(':');
    return `${convertFileSrc(meeting.source_path)}?v=${encodeURIComponent(version)}`;
  });

  const applyChange = (updater: (current: Settings) => Settings) => {
    props.setSettings(updater);
    void props.onSaveSettings();
  };

  const transcriptText = (meeting: MeetingDetail) => {
    const transcript = meeting.transcript;
    if (!transcript) return '';
    if (transcript.utterances.length === 0) return transcript.text;
    return transcript.utterances
      .map((utterance) => `${formatSpeakerLabel(utterance.speaker)}: ${utterance.text}`)
      .join('\n');
  };

  const copyTranscript = async (meeting: MeetingDetail) => {
    try {
      await navigator.clipboard.writeText(transcriptText(meeting));
      notifySuccess('Transcript copied.');
    } catch (err) {
      notifyError(err, 'Failed to copy transcript.');
    }
  };

  const seekTo = (startMs: number) => {
    if (!videoRef) return;
    videoRef.currentTime = Math.max(0, startMs / 1000);
    void videoRef.play().catch(() => undefined);
  };

  const canTranscribe = (meeting: MeetingDetail) =>
    props.settings().assemblyai_api_key.trim() &&
    props.settings().meeting_consent_acknowledged &&
    (meeting.meta.has_mic || meeting.meta.has_system_audio) &&
    meeting.meta.status === 'recorded' &&
    meeting.meta.transcript_status !== 'pending';

  return (
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-background-dark">
      <header class="shrink-0 border-b border-white/5 bg-background-dark px-6 lg:px-10 py-5">
        <div class="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h1 class="text-white text-[30px] leading-9 font-bold tracking-tight">Meetings</h1>
            <p class="mt-1 text-sm text-zinc-500">
              Record MP4 meetings and generate speaker-labeled transcripts.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={props.onRefreshDevices}
              class="h-9 w-10 rounded-lg border border-white/10 bg-surface-dark text-zinc-500 hover:text-white hover:bg-white/5 transition-colors flex items-center justify-center cursor-pointer"
              title="Refresh devices"
            >
              <RefreshCcw size={16} />
            </button>
            <Show
              when={props.meetingRecording()}
              fallback={
                <button
                  type="button"
                  onClick={props.onStartRecording}
                  class="h-9 px-5 rounded-lg bg-primary text-black hover:bg-primary-dark transition-colors text-sm font-semibold flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!props.settings().meeting_consent_acknowledged}
                >
                  <Video size={15} />
                  Start Recording
                </button>
              }
            >
              <button
                type="button"
                onClick={props.onStopRecording}
                class="h-9 px-5 rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 transition-colors text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Square size={14} />
                Stop Recording
              </button>
            </Show>
          </div>
        </div>
      </header>

      <div
        class="relative flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[var(--meetings-left)_minmax(0,1fr)] overflow-hidden"
        style={{ '--meetings-left': `${leftResize.percent()}%` }}
      >
        <div
          class={`hidden xl:block absolute inset-y-0 z-20 w-[7px] -translate-x-1/2 cursor-col-resize transition-colors ${
            leftResize.dragging() ? 'bg-primary/40' : 'hover:bg-primary/25'
          }`}
          style={{ left: 'var(--meetings-left)' }}
          onPointerDown={leftResize.onPointerDown}
          title="Drag to resize"
        />
        <section class="min-h-0 flex flex-col border-r border-white/5 bg-background-dark overflow-hidden">
          <div class="shrink-0 border-b border-white/5 bg-surface-dark/70 p-4 lg:p-5">
            <div class="space-y-3">
              <Show
                when={!props.settings().meeting_consent_acknowledged}
              >
                  <div class="border border-amber-500/30 bg-amber-500/10 p-3">
                    <div class="flex items-start gap-2">
                      <AlertTriangle size={15} class="mt-0.5 shrink-0 text-amber-300" />
                      <div>
                        <p class="text-sm font-semibold text-amber-200">Consent required</p>
                        <p class="mt-1 text-xs text-amber-100/70 leading-relaxed">
                          You are responsible for getting permission from meeting participants before recording.
                        </p>
                        <label class="mt-3 flex items-start gap-2 text-xs text-amber-50/80 cursor-pointer">
                          <input
                            type="checkbox"
                            class="mt-0.5 accent-primary"
                            checked={props.settings().meeting_consent_acknowledged}
                            onChange={(e) =>
                              applyChange((current) => ({
                                ...current,
                                meeting_consent_acknowledged: (e.target as HTMLInputElement).checked,
                              }))
                            }
                          />
                          I understand and will obtain required consent.
                        </label>
                      </div>
                    </div>
                  </div>
              </Show>

              <button
                type="button"
                onClick={toggleConfigCollapsed}
                class="w-full flex items-center justify-between gap-2 text-left cursor-pointer group"
                title={configCollapsed() ? 'Expand configuration' : 'Collapse configuration'}
              >
                <span class="text-[11px] font-mono uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                  Configuration
                </span>
                <ChevronDown
                  size={15}
                  class={`text-zinc-500 group-hover:text-zinc-200 transition-transform ${
                    configCollapsed() ? '-rotate-90' : ''
                  }`}
                />
              </button>

              <Show when={!configCollapsed()}>
                <div class="space-y-3">
              <div class="flex items-center gap-1 border-b border-white/5">
                <For each={CONFIG_TABS}>
                  {(tab) => (
                    <button
                      type="button"
                      onClick={() => setConfigTab(tab.value)}
                      class={`px-3 pb-2 border-b-2 text-[11px] font-mono uppercase tracking-wider transition-colors cursor-pointer ${
                        configTab() === tab.value
                          ? 'border-primary text-primary'
                          : 'border-transparent text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  )}
                </For>
              </div>

              <Show when={configTab() === 'transcription'}>
                <div class="space-y-3">
                  <div>
                    <label class="text-xs text-gray-500 font-medium ml-1">
                      AssemblyAI API key
                    </label>
                    <input
                      type="password"
                      value={props.settings().assemblyai_api_key}
                      onInput={(e) =>
                        props.setSettings((current) => ({
                          ...current,
                          assemblyai_api_key: (e.target as HTMLInputElement).value,
                        }))
                      }
                      onBlur={() => void props.onSaveSettings()}
                      placeholder="AssemblyAI key for meeting transcripts"
                      class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                    />
                  </div>
                </div>
              </Show>

              <Show when={configTab() === 'capture'}>
                <div class="space-y-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-gray-500 font-medium ml-1">
                    Meeting hotkey
                  </label>
                  <input
                    type="text"
                    value={props.settings().meeting_hotkey}
                    onInput={(e) =>
                      props.setSettings((current) => ({
                        ...current,
                        meeting_hotkey: (e.target as HTMLInputElement).value,
                      }))
                    }
                    onBlur={() => void props.onSaveSettings()}
                    class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-primary font-bold focus:outline-none focus:border-primary/50 hover:border-primary/50 transition-colors"
                  />
                  <p class="mt-1 text-[11px] text-zinc-600">
                    Windows: {formatHotkeyForDisplay(props.settings().meeting_hotkey)}
                  </p>
                </div>

                <div>
                  <label class="text-xs text-gray-500 font-medium ml-1">
                    Video source
                  </label>
                  <Select
                    value={props.settings().meeting_video_preset}
                    options={VIDEO_PRESETS}
                    class="mt-1.5 px-3 py-1.5"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_video_preset: value,
                        meeting_record_video: value !== 'audio_only',
                      }))
                    }
                  />
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-gray-500 font-medium ml-1">
                    Microphone
                  </label>
                  <Select
                    value={props.settings().meeting_mic_device ?? ''}
                    options={audioOptions()}
                    class="mt-1.5 px-3 py-1.5"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_mic_device: value || null,
                      }))
                    }
                  />
                </div>

                <div>
                  <label class="text-xs text-gray-500 font-medium ml-1">
                    System audio
                  </label>
                  <Select
                    value={props.settings().meeting_system_audio_device ?? ''}
                    options={systemAudioOptions()}
                    class="mt-1.5 px-3 py-1.5"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_system_audio_device: value || null,
                      }))
                    }
                  />
                </div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <ToggleRow
                  label="Record Screen"
                  description="MP4 video"
                  checked={props.settings().meeting_record_video}
                  disabled={props.settings().meeting_video_preset === 'audio_only'}
                  onChange={(checked) =>
                    applyChange((current) => ({
                      ...current,
                      meeting_record_video: checked,
                    }))
                  }
                />
                <ToggleRow
                  label="Record Mic"
                  description="Your channel"
                  checked={props.settings().meeting_record_mic}
                  onChange={(checked) =>
                    applyChange((current) => ({
                      ...current,
                      meeting_record_mic: checked,
                    }))
                  }
                />
                <ToggleRow
                  label="System Audio"
                  description="Playback"
                  checked={props.settings().meeting_record_system_audio}
                  onChange={(checked) =>
                    applyChange((current) => ({
                      ...current,
                      meeting_record_system_audio: checked,
                    }))
                  }
                />
              </div>

              <Show when={props.devices() && !props.devices()!.has_system_audio}>
                <p class="text-xs text-amber-300/80 leading-relaxed">
                  No Windows playback output was returned for WASAPI loopback capture. System audio records from the selected speaker/headphone output.
                </p>
              </Show>
              <Show when={props.devices()?.message}>
                <p class="text-xs text-red-300/80 leading-relaxed">{props.devices()?.message}</p>
              </Show>
              <Show when={(props.devices()?.audio_devices.length ?? 0) === 0}>
                <p class="text-xs text-red-300/80 leading-relaxed">
                  No audio devices were returned. Check Windows microphone permission for desktop apps, then refresh devices.
                </p>
              </Show>
                </div>
              </Show>

              <Show when={configTab() === 'summary'}>
                <div class="space-y-3">
                  <div class="grid grid-cols-3 gap-2">
                    <For each={SUMMARY_PROVIDER_OPTIONS}>
                      {(option) => {
                        const isActive = () => props.settings().summary_provider === option.value;
                        return (
                          <button
                            type="button"
                            onClick={() => onSummaryProviderChange(option.value)}
                            class={`cursor-pointer relative p-3 rounded-xl border transition-colors flex flex-col items-center justify-center gap-1.5 ${
                              isActive()
                                ? 'border-primary bg-primary/5'
                                : 'border-white/10 bg-surface-dark hover:border-white/20 hover:bg-white/[0.03]'
                            }`}
                          >
                            {option.iconComponent
                              ? option.iconComponent({
                                  class: `w-5 h-5 ${isActive() ? 'text-primary' : 'text-gray-400'}`,
                                })
                              : (
                                <span class={`material-symbols-outlined text-xl ${isActive() ? 'text-primary' : 'text-gray-400'}`}>
                                  {option.icon}
                                </span>
                              )}
                            <span class={`font-medium text-xs ${isActive() ? 'text-white' : 'text-gray-300'}`}>
                              {option.label}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>

                  <div>
                    <label class="text-xs text-gray-500 font-medium ml-1">Base URL</label>
                    <input
                      type="text"
                      value={props.settings().summary_base_url}
                      onInput={(e) =>
                        props.setSettings((current) => ({
                          ...current,
                          summary_base_url: (e.target as HTMLInputElement).value,
                        }))
                      }
                      onBlur={() => void props.onSaveSettings()}
                      placeholder="https://api.example.com/v1"
                      class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                    />
                  </div>

                  <div>
                    <label class="text-xs text-gray-500 font-medium ml-1">Model</label>
                    <Show
                      when={props.settings().summary_provider !== 'custom'}
                      fallback={
                        <input
                          type="text"
                          value={props.settings().summary_model}
                          onInput={(e) =>
                            props.setSettings((current) => ({
                              ...current,
                              summary_model: (e.target as HTMLInputElement).value,
                            }))
                          }
                          onBlur={() => void props.onSaveSettings()}
                          placeholder="model-name"
                          class="mt-1.5 w-full bg-input-bg border border-white/15 rounded-lg py-1.5 px-3 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                        />
                      }
                    >
                      <Select
                        value={props.settings().summary_model}
                        options={summaryModelOptions()}
                        class="mt-1.5 px-3 py-1.5"
                        onChange={(value) =>
                          applyChange((current) => ({ ...current, summary_model: value }))
                        }
                      />
                    </Show>
                  </div>

                  <div>
                    <label class="text-xs text-gray-500 font-medium ml-1">API key</label>
                    <div class="relative mt-1.5">
                      <input
                        type={showSummaryKey() ? 'text' : 'password'}
                        value={props.settings().summary_api_key}
                        onInput={(e) =>
                          props.setSettings((current) => ({
                            ...current,
                            summary_api_key: (e.target as HTMLInputElement).value,
                          }))
                        }
                        onBlur={() => void props.onSaveSettings()}
                        placeholder="API key for meeting summaries"
                        class="w-full bg-input-bg border border-white/15 rounded-lg py-1.5 pl-3 pr-10 text-sm font-mono text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors placeholder-gray-700"
                      />
                      <button
                        type="button"
                        onClick={() => setShowSummaryKey((value) => !value)}
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
                        title={showSummaryKey() ? 'Hide key' : 'Show key'}
                      >
                        <Show when={showSummaryKey()} fallback={<Eye size={15} />}>
                          <EyeOff size={15} />
                        </Show>
                      </button>
                    </div>
                    <p class="mt-1 text-[11px] text-zinc-600">
                      Used only for meeting summaries. Transcription settings are unaffected.
                    </p>
                  </div>
                </div>
              </Show>
                </div>
              </Show>
            </div>
          </div>

          <div class="shrink-0 border-b border-border-dark bg-[#111111] px-4 py-3 flex items-center justify-between">
            <h3 class="text-[11px] font-mono uppercase tracking-wider text-zinc-500">Saved Meetings</h3>
            <span class="border border-border-dark bg-background-dark px-2 py-1 text-[10px] font-mono text-zinc-500">
              {props.meetings().length} items
            </span>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
            <Show
              when={props.meetings().length > 0}
              fallback={
                <div class="p-6 text-sm text-zinc-500 leading-relaxed">
                  No meetings recorded yet. Use Start Recording or the Windows hotkey after saving capture settings.
                </div>
              }
            >
              <For each={props.meetings()}>
                {(meeting) => {
                  const selected = () => props.selectedMeetingId() === meeting.id;
                  return (
                    <button
                      type="button"
                      onClick={() => props.onSelectMeeting(meeting.id)}
                      class={`group relative w-full text-left border-b border-border-dark p-4 transition-colors cursor-pointer ${
                        selected() ? 'bg-surface-hover' : 'hover:bg-surface-hover/70'
                      }`}
                    >
                      <span
                        class={`absolute left-0 top-0 bottom-0 w-1 transition-colors ${
                          selected() ? 'bg-primary' : 'bg-transparent group-hover:bg-border-dark'
                        }`}
                      />
                      <div class="pl-1">
                        <div class="flex items-start justify-between gap-3">
                          <p class="min-w-0 text-sm font-semibold text-zinc-100 truncate">{meeting.title}</p>
                          <span class={`shrink-0 border px-2 py-0.5 text-[10px] font-mono uppercase ${statusClass(meeting)}`}>
                            {transcriptStatusLabel(meeting)}
                            {meeting.status === 'processing' && props.processingMeetings()[meeting.id] != null
                              ? ` ${Math.floor(props.processingMeetings()[meeting.id]!)}%`
                              : ''}
                          </span>
                        </div>
                        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-zinc-500">
                          <span class="flex items-center gap-1">
                            <Calendar size={13} />
                            {formatDate(meeting.started_at_ms)}
                          </span>
                          <span class="flex items-center gap-1">
                            <Clock size={13} />
                            {formatDuration(meeting.duration_secs)}
                          </span>
                          <span>{formatBytes(meeting.file_size_bytes)}</span>
                        </div>
                        <div class="mt-3 flex items-center gap-2 text-zinc-600">
                          <Mic size={14} class={meeting.has_mic ? 'text-primary' : ''} />
                          <Monitor size={14} class={meeting.has_video ? 'text-primary' : ''} />
                          <Volume2 size={14} class={meeting.has_system_audio ? 'text-primary' : ''} />
                        </div>
                      </div>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </section>

        <main class="min-h-0 flex flex-col bg-[#111111] overflow-hidden">
          <Show
            when={props.selectedMeeting()}
            fallback={
              <div class="h-full flex items-center justify-center bg-background-dark">
                <div class="text-center max-w-sm px-6">
                  <div class="mx-auto w-12 h-12 border border-border-dark bg-surface-dark flex items-center justify-center text-zinc-500">
                    <Play size={20} />
                  </div>
                  <h2 class="mt-4 text-lg font-semibold text-zinc-200">Select a recording</h2>
                  <p class="mt-2 text-sm text-zinc-500">
                    Saved MP4 files play here. Transcripts and summaries stay attached to the selected recording.
                  </p>
                </div>
              </div>
            }
          >
            {(meeting) => (
              <>
                <section
                  class="relative shrink-0 min-h-[140px] border-b border-border-dark bg-background-dark"
                  style={{ height: `${videoResize.percent()}%` }}
                >
                  <Show
                    keyed
                    when={selectedSourceUrl()}
                    fallback={
                      <div class="h-full flex items-center justify-center px-6 text-center">
                        <div class="w-full max-w-xs">
                          <p class="text-sm font-medium text-zinc-300">
                            {meeting().meta.status === 'recording'
                              ? 'Recording in progress'
                              : meeting().meta.status === 'processing'
                                ? 'Saving recording…'
                                : 'Recording file is not ready'}
                          </p>
                          <p class="mt-1 text-xs text-zinc-500">
                            {meeting().meta.status === 'recording'
                              ? 'Playback will appear after the meeting is stopped.'
                              : meeting().meta.status === 'processing'
                                ? 'Mixing and saving the audio. Playback will appear when finished.'
                                : 'The saved source file has no playable media yet.'}
                          </p>
                          <Show when={meeting().meta.status === 'processing'}>
                            <div class="mt-4 h-1 w-full overflow-hidden rounded-full bg-white/10">
                              <div
                                class={`h-full rounded-full bg-primary ${
                                  selectedProcessingPct() == null
                                    ? 'w-2/5 meeting-progress-indeterminate'
                                    : 'w-full origin-left transition-transform duration-300'
                                }`}
                                style={
                                  selectedProcessingPct() != null
                                    ? { transform: `scaleX(${selectedProcessingPct()! / 100})` }
                                    : undefined
                                }
                              />
                            </div>
                          </Show>
                        </div>
                      </div>
                    }
                  >
                    {(src) => (
                      <video
                        ref={videoRef}
                        src={src}
                        controls
                        preload="metadata"
                        class="h-full w-full bg-[#0b0b0b] object-contain"
                      />
                    )}
                  </Show>
                </section>

                <div
                  class={`relative z-20 h-[7px] -my-[3.5px] shrink-0 cursor-row-resize transition-colors ${
                    videoResize.dragging() ? 'bg-primary/40' : 'hover:bg-primary/25'
                  }`}
                  onPointerDown={videoResize.onPointerDown}
                  title="Drag to resize"
                />

                <section class="shrink-0 border-b border-border-dark bg-[#111111] px-4 lg:px-5 py-3">
                  <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div class="min-w-0">
                      <Show
                        when={editingTitleId() === meeting().meta.id}
                        fallback={
                          <div class="group flex min-w-0 items-center gap-1.5">
                            <h2
                              class="text-base font-semibold text-white truncate cursor-text"
                              onClick={() => startTitleEdit(meeting())}
                              title="Click to rename"
                            >
                              {meeting().meta.title}
                            </h2>
                            <button
                              type="button"
                              onClick={() => startTitleEdit(meeting())}
                              title="Rename meeting"
                              class="shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200 transition-opacity cursor-pointer"
                            >
                              <Pencil size={13} />
                            </button>
                          </div>
                        }
                      >
                        <input
                          type="text"
                          value={titleDraft()}
                          maxLength={120}
                          ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
                          onInput={(e) => setTitleDraft((e.target as HTMLInputElement).value)}
                          onBlur={commitTitleEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            if (e.key === 'Escape') cancelTitleEdit();
                          }}
                          class="w-full max-w-md bg-input-bg border border-white/15 rounded-lg py-1 px-2 text-base font-semibold text-white focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                        />
                      </Show>
                      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-zinc-500">
                        <span class="flex items-center gap-1">
                          <Calendar size={13} />
                          {formatDate(meeting().meta.started_at_ms)}
                        </span>
                        <span class="flex items-center gap-1">
                          <Clock size={13} />
                          {formatDuration(meeting().meta.duration_secs)}
                        </span>
                        <span class="flex items-center gap-1">
                          <HardDrive size={13} />
                          {formatBytes(meeting().meta.file_size_bytes)}
                        </span>
                      </div>
                    </div>

                    <div class="flex items-center gap-2">
                      <p class="hidden 2xl:block max-w-[190px] text-right text-[10px] leading-snug text-zinc-500">
                        Uploads meeting audio to AssemblyAI cloud.
                      </p>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => props.onTranscribeMeeting(meeting().meta.id)}
                          disabled={!canTranscribe(meeting())}
                          class="h-8 px-4 rounded-lg bg-primary text-black hover:bg-primary-dark transition-colors text-xs font-semibold flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <UploadCloud size={15} />
                          {meeting().meta.transcript_status === 'error' ? 'Retry' : 'Transcribe'}
                        </button>
                        <button
                          type="button"
                          onClick={() => props.onDeleteMeeting(meeting().meta.id)}
                          class="h-8 w-8 rounded-lg border border-white/10 text-zinc-500 hover:text-red-300 hover:border-red-400/30 hover:bg-red-500/10 transition-colors cursor-pointer flex items-center justify-center"
                          title="Delete meeting"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="min-h-0 flex-1 flex flex-col bg-background-dark overflow-hidden">
                  <div class="shrink-0 border-b border-border-dark bg-[#111111] px-4 lg:px-5 pt-2 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                    <div class="flex items-end gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveTab('transcript')}
                        class={`px-3 pb-2 border-b-2 text-[11px] font-mono uppercase tracking-wider flex items-center gap-2 transition-colors ${
                          activeTab() === 'transcript'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <FileText size={14} />
                        Transcript
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab('summary')}
                        disabled={meeting().meta.transcript_status !== 'completed'}
                        title={
                          meeting().meta.transcript_status === 'completed'
                            ? undefined
                            : 'Transcribe this meeting first'
                        }
                        class={`px-3 pb-2 border-b-2 text-[11px] font-mono uppercase tracking-wider flex items-center gap-2 transition-colors disabled:cursor-not-allowed disabled:text-zinc-700 ${
                          activeTab() === 'summary'
                            ? 'border-primary text-primary'
                            : 'border-transparent text-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <Bot size={14} />
                        Summary
                      </button>
                    </div>

                    <div class="flex items-center gap-2 pb-2">
                      <Show when={meeting().transcript}>
                        <button
                          type="button"
                          onClick={() => void copyTranscript(meeting())}
                          class="px-3 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-zinc-500 hover:text-white hover:bg-surface-dark transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <Copy size={13} />
                          Copy
                        </button>
                      </Show>
                      <button
                        type="button"
                        disabled
                        class="px-3 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-zinc-600 flex items-center gap-1.5 cursor-not-allowed"
                      >
                        <Download size={13} />
                        Export
                      </button>
                    </div>
                  </div>

                  <div class="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
                    <Show
                      when={activeTab() === 'transcript'}
                      fallback={
                        <SummaryPanel
                          meeting={meeting()}
                          onGenerateSummary={props.onGenerateSummary}
                          generating={Boolean(props.summaryGenerating()[meeting().meta.id])}
                          error={props.summaryErrors()[meeting().meta.id] ?? null}
                          summaryModel={props.settings().summary_model}
                        />
                      }
                    >
                      <TranscriptPanel
                        meeting={meeting()}
                        settings={props.settings}
                        onTranscribeMeeting={props.onTranscribeMeeting}
                        seekTo={seekTo}
                      />
                    </Show>
                  </div>
                </section>
              </>
            )}
          </Show>
        </main>
      </div>
    </div>
  );
}

function TranscriptPanel(props: {
  meeting: MeetingDetail;
  settings: Accessor<Settings>;
  onTranscribeMeeting: (id: string) => void;
  seekTo: (startMs: number) => void;
}) {
  const canTranscribe =
    props.settings().assemblyai_api_key.trim() &&
    props.settings().meeting_consent_acknowledged &&
    (props.meeting.meta.has_mic || props.meeting.meta.has_system_audio) &&
    props.meeting.meta.status === 'recorded' &&
    props.meeting.meta.transcript_status !== 'pending';

  return (
    <Show
      when={props.meeting.transcript}
      fallback={
        <div class="p-5 lg:p-6">
          <Show
            when={props.meeting.meta.transcript_status === 'pending'}
            fallback={
              <Show
                when={props.meeting.meta.transcript_status === 'error'}
                fallback={
                  <div class="border border-border-dark bg-[#111111] p-4 flex items-center justify-between gap-4">
                    <div class="min-w-0">
                      <p class="text-sm text-zinc-300">No transcript yet.</p>
                      <p class="mt-1 text-xs text-zinc-500">
                        Speaker labels work best with clear voices and limited crosstalk.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => props.onTranscribeMeeting(props.meeting.meta.id)}
                      disabled={!canTranscribe}
                      class="shrink-0 px-4 py-2 bg-primary text-black hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <UploadCloud size={14} />
                      Transcribe
                    </button>
                  </div>
                }
              >
                <div class="border border-amber-400/20 bg-amber-500/10 p-4 flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-amber-200">Transcription failed</p>
                    <p class="mt-1 text-xs text-amber-100/70 leading-relaxed">
                      {props.meeting.meta.transcript_error ?? 'AssemblyAI returned an error.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => props.onTranscribeMeeting(props.meeting.meta.id)}
                    disabled={!props.settings().assemblyai_api_key.trim()}
                    class="shrink-0 px-4 py-2 text-xs font-mono font-bold text-amber-100 hover:bg-amber-400/10 border border-amber-300/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Retry
                  </button>
                </div>
              </Show>
            }
          >
            <div class="border border-primary/20 bg-primary/10 p-4 flex items-center gap-3 text-primary">
              <Loader2 size={16} class="animate-spin" />
              <div>
                <p class="text-sm font-medium">Transcribing...</p>
                <p class="mt-1 text-xs text-primary/80">
                  AssemblyAI is processing the extracted meeting audio.
                </p>
              </div>
            </div>
          </Show>
        </div>
      }
    >
      {(transcript) => (
        <div class="p-5 lg:p-6">
          <Show
            when={transcript().utterances.length > 0}
            fallback={
              <div class="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {transcript().text}
              </div>
            }
          >
            <div class="space-y-6">
              <For each={transcript().utterances}>
                {(utterance) => (
                  <button
                    type="button"
                    onClick={() => props.seekTo(utterance.start_ms)}
                    class="group w-full text-left grid grid-cols-[72px_minmax(0,1fr)] gap-4 hover:bg-white/[0.03] transition-colors cursor-pointer p-2 -m-2"
                  >
                    <span class="pt-1 text-right text-[11px] font-mono text-zinc-600">
                      {formatDuration(utterance.start_ms / 1000)}
                    </span>
                    <span class="min-w-0">
                      <span
                        class={`inline-flex border px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                          formatSpeakerLabel(utterance.speaker) === 'You'
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-border-dark bg-[#111111] text-zinc-500'
                        }`}
                      >
                        {formatSpeakerLabel(utterance.speaker)}
                      </span>
                      <span class="mt-2 block text-sm leading-relaxed text-zinc-300 group-hover:text-zinc-100">
                        {utterance.text}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

function SummaryPanel(props: {
  meeting: MeetingDetail;
  onGenerateSummary: (id: string) => void;
  generating: boolean;
  error: string | null;
  summaryModel: string;
}) {
  const hasTranscript = () =>
    props.meeting.meta.transcript_status === 'completed' && Boolean(props.meeting.transcript);
  const summary = () => props.meeting.summary;

  return (
    <div class="p-5 lg:p-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h3 class="text-sm font-semibold text-white">AI meeting summary</h3>
          <p class="mt-1 text-xs text-zinc-500">
            Generated from the meeting transcript with {summary()?.model ?? props.summaryModel}.
          </p>
        </div>
        <Show when={!summary()}>
          <button
            type="button"
            onClick={() => props.onGenerateSummary(props.meeting.meta.id)}
            disabled={!hasTranscript() || props.generating}
            class="px-4 py-2 border border-border-dark text-xs font-mono font-bold text-primary hover:bg-primary hover:text-black transition-colors disabled:text-zinc-600 disabled:hover:bg-transparent disabled:hover:text-zinc-600 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
          >
            <Show when={props.generating} fallback={<>Generate Summary</>}>
              <Loader2 size={14} class="animate-spin" />
              Generating…
            </Show>
          </button>
        </Show>
      </div>

      <Show when={props.error}>
        <div class="mb-5 border border-amber-400/20 bg-amber-500/10 p-4">
          <p class="text-sm font-medium text-amber-200">Summary generation failed</p>
          <p class="mt-1 text-xs text-amber-100/70 leading-relaxed">{props.error}</p>
        </div>
      </Show>

      <Show
        when={summary()}
        fallback={
          <Show
            when={hasTranscript()}
            fallback={
              <div class="border border-border-dark bg-[#111111] p-4 text-sm text-zinc-400">
                Transcribe this meeting first. The summary uses the transcript to extract key
                topics, blockers, and action items.
              </div>
            }
          >
            <Show when={props.generating}>
              <div class="border border-primary/20 bg-primary/10 p-4 flex items-center gap-3 text-primary">
                <Loader2 size={16} class="animate-spin" />
                <div>
                  <p class="text-sm font-medium">Generating summary…</p>
                  <p class="mt-1 text-xs text-primary/80">
                    {props.summaryModel} is analyzing the transcript.
                  </p>
                </div>
              </div>
            </Show>
          </Show>
        }
      >
        {(current) => (
          <div>
            <div class="summary-prose" innerHTML={renderMarkdown(current().markdown)} />
            <div class="mt-6 pt-4 border-t border-border-dark flex flex-wrap items-center justify-between gap-3">
              <p class="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
                {current().model} · {formatDate(current().created_at_ms)}
              </p>
              <button
                type="button"
                onClick={() => props.onGenerateSummary(props.meeting.meta.id)}
                disabled={props.generating}
                class="px-3 py-1 rounded-lg border border-white/10 text-[11px] font-mono text-zinc-500 hover:text-white hover:bg-surface-dark transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Show when={props.generating} fallback={<RefreshCcw size={13} />}>
                  <Loader2 size={13} class="animate-spin" />
                </Show>
                Regenerate
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
