export type Status = 'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'meeting' | 'done' | 'error';
export type Tab = 'settings' | 'dictionary' | 'history' | 'modes' | 'meetings';
export type Provider = 'groq' | 'openai' | 'custom';
export type HotkeyMode = 'hold' | 'lock';

export type VocabularyEntry = {
  id: string;
  word: string;
  replacements: string[];
  enabled: boolean;
};

export type Mode = {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
};

export type Settings = {
  provider: Provider;
  base_url: string;
  model: string;
  hotkey: string;
  meeting_hotkey: string;
  hotkey_mode: HotkeyMode;
  copy_to_clipboard_on_success: boolean;
  meeting_record_video: boolean;
  meeting_record_mic: boolean;
  meeting_record_system_audio: boolean;
  meeting_video_preset: string;
  meeting_mic_device: string | null;
  meeting_system_audio_device: string | null;
  meeting_consent_acknowledged: boolean;
  api_key: string;
  provider_api_keys: Partial<Record<Provider, string>>;
  vocabulary: VocabularyEntry[];
  active_mode_id: string | null;
  modes: Mode[];
};

export type TranscriptionHistoryItem = {
  id: string;
  text: string;
  created_at_ms: number;
  duration_secs?: number;
  language?: string;
  mode_name?: string;
  original_text?: string;
};

export type DictationUpdate = {
  state: 'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'done' | 'error';
  message?: string;
  text?: string;
};

export type MeetingStatus = 'recording' | 'recorded' | 'error';

export type MeetingMeta = {
  id: string;
  title: string;
  started_at_ms: number;
  ended_at_ms?: number;
  duration_secs?: number;
  has_video: boolean;
  has_mic: boolean;
  has_system_audio: boolean;
  file_size_bytes?: number;
  status: MeetingStatus;
};

export type MeetingDetail = {
  meta: MeetingMeta;
  source_path: string;
};

export type MeetingDevices = {
  audio_devices: string[];
  system_audio_devices: string[];
  video_devices: string[];
  has_system_audio: boolean;
  ffmpeg_available: boolean;
  message?: string;
};

export type MeetingUpdate = {
  state: 'recording' | 'stopped' | 'log' | 'error';
  meeting_id?: string;
  message?: string;
  elapsed_secs?: number;
  file_size_bytes?: number;
};
