import { For, Show, createMemo } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import { convertFileSrc } from '@tauri-apps/api/core';
import { CheckCircle2, HardDrive, Play, RefreshCcw, Square, Trash2, Video } from 'lucide-solid';
import type { MeetingDetail, MeetingDevices, MeetingMeta, Settings } from '../../types';
import Select from './Select';

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
  onStartRecording: () => void;
  onStopRecording: () => void;
  onSaveSettings: () => Promise<boolean>;
};

const VIDEO_PRESETS = [
  { value: 'screen_720p_30', label: 'Screen 720p / 30 fps' },
  { value: 'screen_720p_15', label: 'Screen 720p / 15 fps' },
  { value: 'screen_1080p_30', label: 'Screen 1080p / 30 fps' },
  { value: 'audio_only', label: 'Audio only' },
];

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

export default function MeetingsPage(props: MeetingsPageProps) {
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

  const selectedSourceUrl = createMemo(() => {
    const meeting = props.selectedMeeting();
    if (!meeting || meeting.meta.status === 'recording' || !meeting.meta.file_size_bytes) {
      return '';
    }

    const version = [
      meeting.meta.status,
      meeting.meta.ended_at_ms ?? meeting.meta.started_at_ms,
      meeting.meta.file_size_bytes,
    ].join(':');
    return `${convertFileSrc(meeting.source_path)}?v=${encodeURIComponent(version)}`;
  });

  const storageUsed = createMemo(() =>
    props.meetings().reduce((total, meeting) => total + (meeting.file_size_bytes ?? 0), 0)
  );

  const applyChange = (updater: (current: Settings) => Settings) => {
    props.setSettings(updater);
    void props.onSaveSettings();
  };

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      <div class="flex-none px-6 sm:px-10 py-5 border-b border-white/5">
        <div class="max-w-6xl mx-auto w-full flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline gap-4">
              <h1 class="text-white text-3xl font-bold tracking-tight">Meetings</h1>
              <div class="flex items-center gap-1.5 text-sm text-gray-400 border-l border-white/10 pl-4">
                <Video size={14} class="text-primary" />
                <span class="font-semibold text-white">{props.meetings().length}</span>
                <span class="hidden sm:inline">saved</span>
              </div>
              <div class="flex items-center gap-1.5 text-sm text-gray-400 border-l border-white/10 pl-4">
                <HardDrive size={14} class="text-primary" />
                <span class="font-semibold text-white">{formatBytes(storageUsed())}</span>
              </div>
            </div>
            <p class="text-zinc-500 text-sm">Windows screen and call capture with the MP4 kept as source of truth.</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Show
              when={props.meetingRecording()}
              fallback={
                <button
                  type="button"
                  onClick={props.onStartRecording}
                  class="bg-red-500 hover:bg-red-400 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
                class="bg-white text-zinc-950 hover:bg-zinc-200 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Square size={14} />
                Stop Recording
              </button>
            </Show>
            <button
              type="button"
              onClick={props.onRefreshDevices}
              class="px-3 py-2.5 rounded-lg text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCcw size={15} />
              Refresh Devices
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-hidden">
        <div class="max-w-6xl mx-auto h-full grid grid-cols-[360px_minmax(0,1fr)] gap-0 border-x border-white/5">
          <aside class="border-r border-white/5 overflow-y-auto scrollbar-hide bg-[#111111]/60">
            <div class="p-4 border-b border-white/5 flex flex-col gap-4">
              <Show
                when={props.settings().meeting_consent_acknowledged}
                fallback={
                  <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                    <p class="text-sm font-semibold text-amber-200">Consent required</p>
                    <p class="text-xs text-amber-100/70 mt-1 leading-relaxed">
                      You are responsible for getting permission from meeting participants before recording.
                    </p>
                    <label class="flex items-start gap-2 mt-3 text-xs text-amber-50/80 cursor-pointer">
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
                }
              >
                <div class="rounded-lg border border-primary/20 bg-primary/10 p-3 flex items-center gap-2 text-primary text-sm">
                  <CheckCircle2 size={16} />
                  Consent acknowledged
                </div>
              </Show>

              <div class="grid grid-cols-1 gap-3">
                <div class="flex flex-col gap-2">
                  <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">Meeting Hotkey</label>
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
                    class="w-full bg-input-bg border border-white/15 rounded-lg py-2 px-3 text-sm text-gray-300 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
                  />
                  <p class="text-xs text-zinc-500">On Windows this is {formatHotkeyForDisplay(props.settings().meeting_hotkey)}.</p>
                </div>

                <div class="flex flex-col gap-2">
                  <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">Preset</label>
                  <Select
                    value={props.settings().meeting_video_preset}
                    options={VIDEO_PRESETS}
                    class="px-3"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_video_preset: value,
                        meeting_record_video: value !== 'audio_only',
                      }))
                    }
                  />
                </div>

                <label class="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-zinc-300">
                  <span>Record screen</span>
                  <input
                    type="checkbox"
                    class="accent-primary"
                    checked={props.settings().meeting_record_video}
                    disabled={props.settings().meeting_video_preset === 'audio_only'}
                    onChange={(e) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_record_video: (e.target as HTMLInputElement).checked,
                      }))
                    }
                  />
                </label>

                <label class="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-zinc-300">
                  <span>Record microphone</span>
                  <input
                    type="checkbox"
                    class="accent-primary"
                    checked={props.settings().meeting_record_mic}
                    onChange={(e) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_record_mic: (e.target as HTMLInputElement).checked,
                      }))
                    }
                  />
                </label>

                <div class="flex flex-col gap-2">
                  <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">Microphone Device</label>
                  <Select
                    value={props.settings().meeting_mic_device ?? ''}
                    options={audioOptions()}
                    class="px-3"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_mic_device: value || null,
                      }))
                    }
                  />
                </div>

                <label class="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-zinc-300">
                  <span>Record system audio</span>
                  <input
                    type="checkbox"
                    class="accent-primary"
                    checked={props.settings().meeting_record_system_audio}
                    onChange={(e) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_record_system_audio: (e.target as HTMLInputElement).checked,
                      }))
                    }
                  />
                </label>

                <div class="flex flex-col gap-2">
                  <label class="text-xs font-medium text-gray-500 uppercase tracking-wide">System Audio Device</label>
                  <Select
                    value={props.settings().meeting_system_audio_device ?? ''}
                    options={systemAudioOptions()}
                    class="px-3"
                    onChange={(value) =>
                      applyChange((current) => ({
                        ...current,
                        meeting_system_audio_device: value || null,
                      }))
                    }
                  />
                  <p class="text-xs text-zinc-500 leading-relaxed">
                    Default Windows output records the speaker or headphones currently playing YouTube or meeting audio.
                  </p>
                  <Show when={props.devices() && !props.devices()!.has_system_audio}>
                    <div class="text-xs text-amber-300/80 leading-relaxed space-y-1">
                      <p>
                        No Windows playback output was returned for WASAPI loopback capture. System audio records from the selected speaker/headphone output, not from DirectShow microphone devices.
                      </p>
                    </div>
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
              </div>
            </div>

            <div class="divide-y divide-white/5">
              <Show
                when={props.meetings().length > 0}
                fallback={
                  <div class="p-6 text-sm text-zinc-500 leading-relaxed">
                    No meetings recorded yet. Use Start Recording or the Windows hotkey after saving capture settings.
                  </div>
                }
              >
                <For each={props.meetings()}>
                  {(meeting) => (
                    <button
                      type="button"
                      onClick={() => props.onSelectMeeting(meeting.id)}
                      class={`w-full text-left p-4 transition-colors ${
                        props.selectedMeetingId() === meeting.id
                          ? 'bg-primary/10'
                          : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="text-sm font-semibold text-zinc-200 truncate">{meeting.title}</p>
                          <p class="text-xs text-zinc-500 mt-1">{formatDate(meeting.started_at_ms)}</p>
                        </div>
                        <span class={`text-[10px] uppercase tracking-wide px-2 py-1 rounded border ${
                          meeting.status === 'recording'
                            ? 'border-red-400/30 text-red-300 bg-red-500/10'
                            : meeting.status === 'error'
                              ? 'border-amber-400/30 text-amber-300 bg-amber-500/10'
                              : 'border-white/10 text-zinc-400 bg-white/[0.03]'
                        }`}>
                          {meeting.status}
                        </span>
                      </div>
                      <div class="mt-3 flex items-center gap-3 text-xs text-zinc-500">
                        <span>{formatDuration(meeting.duration_secs)}</span>
                        <span class="w-1 h-1 rounded-full bg-zinc-700" />
                        <span>{formatBytes(meeting.file_size_bytes)}</span>
                        <span class="w-1 h-1 rounded-full bg-zinc-700" />
                        <span>{meeting.has_video ? 'Video' : 'Audio'}</span>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </aside>

          <main class="overflow-y-auto scrollbar-hide">
            <Show
              when={props.selectedMeeting()}
              fallback={
                <div class="h-full flex items-center justify-center">
                  <div class="text-center max-w-sm">
                    <div class="mx-auto w-12 h-12 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-zinc-500">
                      <Play size={20} />
                    </div>
                    <h2 class="mt-4 text-lg font-semibold text-zinc-200">Select a recording</h2>
                    <p class="mt-2 text-sm text-zinc-500">Saved MP4 files play here. Derived transcripts can be added from this source later.</p>
                  </div>
                </div>
              }
            >
              {(meeting) => (
                <div class="p-6 lg:p-8">
                  <div class="flex items-start justify-between gap-4 mb-5">
                    <div>
                      <h2 class="text-xl font-semibold text-white">{meeting().meta.title}</h2>
                      <p class="text-sm text-zinc-500 mt-1">
                        {formatDate(meeting().meta.started_at_ms)} · {formatDuration(meeting().meta.duration_secs)} · {formatBytes(meeting().meta.file_size_bytes)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => props.onDeleteMeeting(meeting().meta.id)}
                      class="w-9 h-9 rounded-lg hover:bg-red-500/10 flex items-center justify-center text-zinc-500 hover:text-red-300 transition-colors cursor-pointer"
                      title="Delete meeting"
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>

                  <div class="rounded-lg overflow-hidden border border-white/10 bg-black/30 min-h-[260px] flex items-center justify-center">
                    <Show
                      keyed
                      when={selectedSourceUrl()}
                      fallback={
                        <div class="px-6 py-10 text-center">
                          <p class="text-sm font-medium text-zinc-300">
                            {meeting().meta.status === 'recording' ? 'Recording in progress' : 'Recording file is not ready'}
                          </p>
                          <p class="mt-1 text-xs text-zinc-500">
                            {meeting().meta.status === 'recording' ? 'Playback will appear after the meeting is stopped.' : 'The saved source file has no playable media yet.'}
                          </p>
                        </div>
                      }
                    >
                      {(src) => (
                        <video
                          src={src}
                          controls
                          preload="metadata"
                          class="w-full max-h-[520px] bg-[#0b0b0b]"
                        />
                      )}
                    </Show>
                  </div>

                  <div class="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div class="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                      <p class="text-xs text-zinc-500 uppercase tracking-wide">Mic</p>
                      <p class="mt-1 text-sm text-zinc-200">{meeting().meta.has_mic ? 'Captured' : 'Off'}</p>
                    </div>
                    <div class="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                      <p class="text-xs text-zinc-500 uppercase tracking-wide">System Audio</p>
                      <p class="mt-1 text-sm text-zinc-200">{meeting().meta.has_system_audio ? 'Captured' : 'Off'}</p>
                    </div>
                    <div class="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                      <p class="text-xs text-zinc-500 uppercase tracking-wide">Source File</p>
                      <p class="mt-1 text-sm text-zinc-200 truncate" title={meeting().source_path}>{meeting().source_path}</p>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </main>
        </div>
      </div>
    </div>
  );
}
