import type { Provider, Settings } from './types';
import { DEFAULT_MODES } from './defaultModes';

export const CHAT_MODELS: Record<Provider, string[]> = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  custom: []
};

export const PROVIDERS: Record<Provider, { label: string; base_url: string; models: string[] }> = {
  groq: {
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3']
  },
  openai: {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1']
  },
  custom: {
    label: 'Custom',
    base_url: '',
    models: []
  }
};

// Curated "thinking" models for meeting summaries — verified against the live
// Groq/OpenAI model APIs on 2026-06-10 (see spec §11.3). First entry = default.
export const SUMMARY_MODELS: Record<Provider, string[]> = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'],
  openai: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4', 'gpt-5.5'],
  custom: []
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'groq',
  base_url: PROVIDERS.groq.base_url,
  model: PROVIDERS.groq.models[0],
  hotkey: 'CommandOrControl+Space',
  meeting_hotkey: 'CommandOrControl+Alt+M',
  hotkey_mode: 'hold',
  copy_to_clipboard_on_success: false,
  meeting_record_video: true,
  meeting_record_mic: true,
  meeting_record_system_audio: true,
  meeting_video_preset: 'screen_720p_30',
  meeting_mic_device: null,
  meeting_system_audio_device: null,
  meeting_consent_acknowledged: false,
  api_key: '',
  assemblyai_api_key: '',
  provider_api_keys: {},
  summary_provider: 'groq',
  summary_base_url: PROVIDERS.groq.base_url,
  summary_model: SUMMARY_MODELS.groq[0],
  summary_api_key: '',
  summary_provider_api_keys: {},
  vocabulary: [],
  active_mode_id: null,
  modes: DEFAULT_MODES
};

export const MAX_VOCABULARY_ENTRIES = 100;
export const MAX_REPLACEMENTS_PER_ENTRY = 10;
