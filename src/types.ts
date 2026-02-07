export type Status = 'idle' | 'recording' | 'transcribing' | 'formatting' | 'pasting' | 'done' | 'error';
export type Tab = 'settings' | 'vocabulary' | 'history' | 'modes';
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
  hotkey_mode: HotkeyMode;
  copy_to_clipboard_on_success: boolean;
  api_key: string;
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
