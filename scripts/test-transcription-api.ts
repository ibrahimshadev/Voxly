/**
 * Probe transcription API responses from Groq/OpenAI with verbose_json.
 *
 * Usage:
 *   npx tsx scripts/test-transcription-api.ts --provider groq --key gsk_xxx --file test.wav
 *   npx tsx scripts/test-transcription-api.ts --provider openai --key sk-xxx --file test.wav
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const PROVIDERS: Record<string, { url: string; model: string }> = {
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3',
  },
  openai: {
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
  },
};

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key.startsWith('--') && value && !value.startsWith('--')) {
      args[key.slice(2)] = value;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const providerName = args.provider;
  const apiKey = args.key;
  const filePath = args.file;

  if (!providerName || !apiKey || !filePath) {
    console.error('Usage: npx tsx scripts/test-transcription-api.ts --provider <groq|openai> --key <api-key> --file <audio-file>');
    process.exit(1);
  }

  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.error(`Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }

  const fileData = readFileSync(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileData]), fileName);
  formData.append('model', provider.model);
  formData.append('response_format', 'verbose_json');

  console.log(`\n--- ${providerName.toUpperCase()} (${provider.model}) ---`);
  console.log(`POST ${provider.url}`);
  console.log(`File: ${filePath} (${fileData.length} bytes)\n`);

  const response = await fetch(provider.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  console.log(`Status: ${response.status} ${response.statusText}`);

  const text = await response.text();
  try {
    const json = JSON.parse(text);
    console.log('\nResponse JSON:');
    console.log(JSON.stringify(json, null, 2));

    // Summarize key fields
    console.log('\n--- Key Fields ---');
    console.log(`text:     ${typeof json.text === 'string' ? `"${json.text.slice(0, 80)}..."` : 'MISSING'}`);
    console.log(`duration: ${json.duration ?? 'MISSING'}`);
    console.log(`language: ${json.language ?? 'MISSING'}`);
    console.log(`segments: ${Array.isArray(json.segments) ? `${json.segments.length} segment(s)` : 'MISSING'}`);

    if (Array.isArray(json.segments) && json.segments.length > 0) {
      const seg = json.segments[0];
      console.log(`\nFirst segment keys: ${Object.keys(seg).join(', ')}`);
    }
  } catch {
    console.log('\nRaw response (not JSON):');
    console.log(text);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
