import { PROVIDERS } from '../constants';
import type { Provider } from '../types';

// Provider model lists also carry speech, TTS, safety-classifier and embedding
// models, none of which can rewrite text for a mode.
const NON_CHAT_MODEL = /whisper|transcri|tts|speech|audio|orpheus|playai|guard|embed|moderation|image|dall-e|realtime/i;

export const isChatModel = (id: string): boolean => !NON_CHAT_MODEL.test(id);

/**
 * Model for a mode that needs one: the first curated chat model the provider
 * actually serves, else its first chat-capable model, else '' (never an audio
 * or guard model picked by list order).
 */
export function pickModeModel(provider: Provider, available: string[]): string {
  const curated = PROVIDERS[provider].chatModels;
  if (available.length === 0) return curated[0] ?? '';
  return curated.find((id) => available.includes(id)) ?? available.find(isChatModel) ?? '';
}
