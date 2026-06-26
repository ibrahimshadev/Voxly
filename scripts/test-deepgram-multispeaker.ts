/**
 * Test Deepgram on multi-speaker meetings — multichannel vs diarization.
 *
 * Usage:
 *   npx tsx scripts/test-deepgram-multispeaker.ts --key <api-key> --file <audio.m4a>
 */

import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Mode = 'multichannel' | 'diarize' | 'multichannel+diarize';

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

async function transcribe(filePath: string, apiKey: string, mode: Mode) {
  const params = new URLSearchParams({
    model: 'nova-3',
    utterances: 'true',
    punctuate: 'true',
    smart_format: 'true',
    detect_language: 'true',
  });

  if (mode === 'multichannel') {
    params.set('multichannel', 'true');
    params.set('diarize', 'false');
  } else if (mode === 'diarize') {
    params.set('diarize', 'true');
    params.set('multichannel', 'false');
  } else {
    params.set('multichannel', 'true');
    params.set('diarize', 'true');
  }

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/mp4',
    },
    // @ts-expect-error Node fetch stream body
    body: createReadStream(filePath),
    duplex: 'half',
  });

  const elapsed = (Date.now() - started) / 1000;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${mode} failed ${response.status}: ${text.slice(0, 400)}`);
  }

  return { mode, elapsed, raw: JSON.parse(text) as Record<string, unknown> };
}

function summarize(mode: string, raw: Record<string, unknown>) {
  const results = raw.results as Record<string, unknown> | undefined;
  const utterances = (results?.utterances ?? []) as Array<Record<string, unknown>>;
  const metadata = raw.metadata as Record<string, unknown> | undefined;

  const speakers = new Set<string>();
  const channels = new Set<number>();
  for (const u of utterances) {
    if (typeof u.speaker === 'number') speakers.add(`speaker:${u.speaker}`);
    if (typeof u.channel === 'number') {
      channels.add(u.channel);
      speakers.add(`channel:${u.channel}`);
    }
  }

  const bySpeaker = new Map<string, number>();
  for (const u of utterances) {
    const label = typeof u.speaker === 'number'
      ? `Speaker ${u.speaker}`
      : typeof u.channel === 'number'
        ? (u.channel === 0 ? 'You (ch0)' : u.channel === 1 ? 'System (ch1)' : `Channel ${u.channel}`)
        : 'unknown';
    bySpeaker.set(label, (bySpeaker.get(label) ?? 0) + 1);
  }

  const preview = utterances.slice(0, 8).map((u, i) => {
    const label = typeof u.speaker === 'number'
      ? `Speaker ${u.speaker}`
      : typeof u.channel === 'number'
        ? (u.channel === 0 ? 'You' : u.channel === 1 ? 'System' : `Ch${u.channel}`)
        : '?';
    return `  ${i + 1}. [${label}] ${String(u.transcript ?? '').slice(0, 100)}`;
  });

  return {
    mode,
    durationSecs: metadata?.duration,
    utteranceCount: utterances.length,
    distinctLabels: Object.fromEntries(bySpeaker),
    preview,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = args.key;
  const filePath = args.file;
  if (!apiKey || !filePath) {
    console.error('Usage: npx tsx scripts/test-deepgram-multispeaker.ts --key <key> --file <audio>');
    process.exit(1);
  }

  const modes: Mode[] = ['multichannel', 'diarize', 'multichannel+diarize'];
  const outDir = join(process.cwd(), 'scripts', '.deepgram-comparison');
  mkdirSync(outDir, { recursive: true });

  console.log(`File: ${filePath} (${basename(filePath)})`);
  console.log(`Testing ${modes.length} Deepgram modes for multi-speaker handling...\n`);

  for (const mode of modes) {
    console.log(`--- ${mode} ---`);
    try {
      const result = await transcribe(filePath, apiKey, mode);
      const summary = summarize(mode, result.raw);
      summary.mode = `${mode} (${result.elapsed.toFixed(1)}s)`;
      console.log(`Duration: ${summary.durationSecs}s | Utterances: ${summary.utteranceCount}`);
      console.log('Speaker breakdown:', summary.distinctLabels);
      console.log('First utterances:');
      for (const line of summary.preview) console.log(line);

      const slug = basename(filePath, '.m4a');
      writeFileSync(
        join(outDir, `${slug}-${mode.replace('+', '_')}.json`),
        JSON.stringify({ summary, raw: result.raw }, null, 2),
      );
      console.log('');
    } catch (error) {
      console.error(`Failed: ${error instanceof Error ? error.message : error}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});