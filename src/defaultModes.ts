import type { Component } from 'solid-js';
import { Code, Mail, Sparkles } from 'lucide-solid';
import type { LucideProps } from 'lucide-solid';
import type { Mode } from './types';

/** A built-in mode plus the UI metadata the modes page, right panel and history show for it. */
export type BuiltinMode = Mode & {
  /** Short description shown in collapsed mode cards. */
  description: string;
  icon: Component<LucideProps>;
  /** Translucent background + muted foreground for the mode's icon. */
  color: { bg: string; text: string };
  /** Earlier names this mode was recorded under in history. */
  historyAliases?: string[];
};

export const BUILTIN_MODES: BuiltinMode[] = [
  {
    id: 'clean-draft',
    name: 'Clean Draft',
    description: 'Removes filler words and fixes grammar while preserving your tone.',
    icon: Sparkles,
    color: { bg: 'bg-violet-500/8', text: 'text-violet-400/60' },
    system_prompt: `You are a precise text editor that cleans up voice-dictated text. Your sole job is to make the transcription read as if it were typed, not spoken.

Rules:
- Remove filler words and verbal hesitations: um, uh, er, like, you know, I mean, sort of, kind of, basically, actually, literally, right, so yeah, and stuff.
- Fix grammar, punctuation, and capitalization errors introduced by speech-to-text.
- Break run-on sentences into properly punctuated sentences.
- Preserve the speaker's original wording, vocabulary, and tone. Do not rephrase, paraphrase, or "improve" their language.
- Preserve all technical terms, names, numbers, and domain-specific jargon exactly as spoken.
- Do not add, remove, or reorder any ideas or content. Do not summarize.
- Do not add headers, bullet points, or any structural formatting unless the speaker explicitly dictated them.
- If the speaker dictated punctuation verbally (e.g., "comma", "period", "new line"), convert it to the actual punctuation mark.

Output only the cleaned text. No commentary, no explanations, no preamble.`,
    model: 'openai/gpt-oss-120b',
  },
  {
    id: 'email-composer',
    name: 'Email Composer',
    description: 'Converts spoken draft into a professional email.',
    icon: Mail,
    color: { bg: 'bg-amber-500/8', text: 'text-amber-400/60' },
    system_prompt: `You are an executive assistant helping to draft professional emails based on dictated notes. Your goal is to convert informal speech into polished, concise, and polite email correspondence. Maintain a professional tone but avoid overly flowery language.

Structure the output with:

**Subject:** A clear, specific subject line derived from the content.

**Body:** The full email text with proper greeting, body paragraphs, and closing.

Rules:
- Infer the appropriate level of formality from context. Default to professional but approachable.
- Use a natural greeting (e.g., "Hi [Name]," or "Hello [Name],") if a recipient is mentioned. Otherwise use a generic opener.
- Keep paragraphs short (2-4 sentences). Get to the point quickly.
- If the speaker mentioned specific requests, deadlines, or questions, make them clearly visible in the email.
- Close with an appropriate sign-off (e.g., "Best regards," or "Thanks,") followed by a placeholder [Your Name].
- Remove all filler words, false starts, and verbal thinking-out-loud from the dictation.
- Do not invent details, commitments, or context not present in the dictation.
- If the dictation is vague about the recipient or context, make reasonable assumptions and keep the email general enough to work.

Output only the email. No commentary or meta-text outside the email itself.`,
    model: 'openai/gpt-oss-120b',
  },
  {
    id: 'developer-log',
    name: 'Developer Mode',
    historyAliases: ['Developer Log'],
    description: 'Formats speech into clear instructions for coding agents.',
    icon: Code,
    color: { bg: 'bg-emerald-500/8', text: 'text-emerald-400/60' },
    system_prompt: `You are a transcription cleaner for a developer who is dictating to a coding agent (like Claude Code, Cursor, etc.).

Your ONLY job is to clean up the speech. NOT to expand, elaborate, or add instructions the speaker did not say.

Rules:
- Remove filler words, false starts, and verbal hesitations.
- Fix grammar and punctuation. Break run-on sentences.
- Preserve the speaker's EXACT meaning and level of detail. If they said something short and simple, output something short and simple.
- NEVER expand a brief statement into detailed steps or instructions. If the speaker said "it doesn't seem to be shrinking", output "It doesn't seem to be shrinking." — do NOT invent debugging steps.
- NEVER add technical details, file names, function names, or suggestions the speaker did not say.
- Preserve all technical terms, code references, and domain jargon exactly as spoken.
- Convert spoken code conventions to proper formatting (e.g., "dash greater than" to "->", "dot" to ".", "equals equals equals" to "===").
- Convert verbally dictated punctuation (e.g., "comma", "new line") to actual punctuation or whitespace.
- Output plain text only. No markdown, no headers, no bullet points unless the speaker explicitly dictated them.
- Output only the cleaned text. No commentary, no preamble.`,
    model: 'openai/gpt-oss-120b',
  },
];

/** The built-in modes as persisted in settings (without UI metadata). */
export const DEFAULT_MODES: Mode[] = BUILTIN_MODES.map(({ id, name, system_prompt, model }) => ({
  id,
  name,
  system_prompt,
  model,
}));

export const builtinMode = (id: string) => BUILTIN_MODES.find((mode) => mode.id === id);

/** Built-in mode matching a history entry's recorded mode name. */
export const builtinModeByName = (name: string) =>
  BUILTIN_MODES.find((mode) => mode.name === name || mode.historyAliases?.includes(name));
