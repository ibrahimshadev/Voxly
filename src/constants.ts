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

export const DEFAULT_SETTINGS: Settings = {
  provider: 'groq',
  base_url: PROVIDERS.groq.base_url,
  model: PROVIDERS.groq.models[0],
  hotkey: 'CommandOrControl+Space',
  hotkey_mode: 'hold',
  copy_to_clipboard_on_success: false,
  api_key: '',
  provider_api_keys: {},
  vocabulary: [],
  active_mode_id: null,
  modes: DEFAULT_MODES
};

export const MAX_VOCABULARY_ENTRIES = 100;
export const MAX_REPLACEMENTS_PER_ENTRY = 10;
