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
  assemblyai_api_key: string;
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

export type TranscriptionHistoryPage = {
  items: TranscriptionHistoryItem[];
  total: number;
};

export type TranscriptionHistoryStats = {
  total_count: number;
  today_count: number;
  today_audio_secs: number;
  total_audio_secs: number;
};

export type DictationUpdate = {
  state: 'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'done' | 'error';
  message?: string;
  text?: string;
};

export type MeetingStatus = 'recording' | 'processing' | 'recorded' | 'error';
export type TranscriptStatus = 'pending' | 'completed' | 'error';

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
  transcript_status?: TranscriptStatus;
  transcript_error?: string;
  assemblyai_transcript_id?: string;
  transcript_started_at_ms?: number;
};

export type Utterance = {
  speaker: string;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
};

export type MeetingTranscript = {
  utterances: Utterance[];
  text: string;
  audio_duration_secs?: number;
  language_code?: string;
  provider: string;
  created_at_ms: number;
};

export type MeetingSummary = {
  markdown: string;
  model: string;
  provider: string;
  created_at_ms: number;
  transcript_created_at_ms?: number;
};

export type MeetingDetail = {
  meta: MeetingMeta;
  source_path: string;
  transcript?: MeetingTranscript;
  summary?: MeetingSummary;
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
  state:
    | 'recording'
    | 'processing'
    | 'stopped'
    | 'log'
    | 'error'
    | 'transcribing'
    | 'transcribed'
    | 'transcription_error';
  meeting_id?: string;
  message?: string;
  elapsed_secs?: number;
  file_size_bytes?: number;
  progress_pct?: number;
};
