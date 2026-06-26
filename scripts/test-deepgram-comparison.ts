/**
 * Compare Deepgram transcription against existing AssemblyAI transcripts in dikt.db.
 *
 * Usage:
 *   npx tsx scripts/test-deepgram-comparison.ts --key <deepgram-api-key>
 *   npx tsx scripts/test-deepgram-comparison.ts --key <key> --meeting <uuid>
 *   npx tsx scripts/test-deepgram-comparison.ts --key <key> --intelligence
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const APP_DATA = process.env.DIKT_APP_DATA_DIR
  ?? '/mnt/c/Users/user/AppData/Roaming/dikt';
const DB_PATH = join(APP_DATA, 'dikt.db');
const MEETINGS_DIR = join(APP_DATA, 'meetings');
const OUTPUT_DIR = join(process.cwd(), 'scripts', '.deepgram-comparison');

type Utterance = {
  speaker: string;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
};

type MeetingTranscript = {
  utterances: Utterance[];
  text: string;
  audio_duration_secs?: number;
  language_code?: string;
  provider: string;
  created_at_ms: number;
};

type MeetingRow = {
  id: string;
  title: string;
  duration_secs: number;
  transcript_status: string;
};

type ComparisonResult = {
  meetingId: string;
  title: string;
  durationSecs: number;
  assemblyai: {
    utteranceCount: number;
    wordCount: number;
    avgConfidence: number | null;
    language: string | null;
    textPreview: string;
  };
  deepgram: {
    utteranceCount: number;
    wordCount: number;
    avgConfidence: number | null;
    language: string | null;
    textPreview: string;
    requestDurationSecs: number;
  };
  comparison: {
    textSimilarity: number;
    utteranceCountDelta: number;
    youUtteranceDelta: number;
    systemUtteranceDelta: number;
    sampleDifferences: string[];
  };
  intelligence?: Record<string, unknown>;
};

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--intelligence') {
      args.intelligence = true;
    } else if (key.startsWith('--') && value && !value.startsWith('--')) {
      args[key.slice(2)] = value;
      i++;
    }
  }
  return args;
}

function sqlJson(query: string): string {
  const copyPath = '/tmp/dikt-compare.db';
  execFileSync('cp', ['-f', DB_PATH, copyPath]);
  return execFileSync('sqlite3', [copyPath, query], { encoding: 'utf8' }).trim();
}

function listMeetings(): MeetingRow[] {
  const rows = sqlJson(
    `SELECT m.id || '|' || m.title || '|' || COALESCE(m.duration_secs, 0) || '|' || COALESCE(m.transcript_status, '') FROM meetings m WHERE m.transcript_status = 'completed' ORDER BY m.duration_secs ASC;`,
  );
  if (!rows) return [];
  return rows.split('\n').map((line) => {
    const [id, title, duration_secs, transcript_status] = line.split('|');
    return {
      id,
      title,
      duration_secs: Number(duration_secs),
      transcript_status,
    };
  });
}

function loadAssemblyTranscript(meetingId: string): MeetingTranscript {
  const json = sqlJson(
    `SELECT json FROM meeting_transcripts WHERE meeting_id = '${meetingId}';`,
  );
  return JSON.parse(json) as MeetingTranscript;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text).split(' ').filter(Boolean);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function avgConfidence(utterances: Utterance[]): number | null {
  const values = utterances
    .map((u) => u.confidence)
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function channelLabel(channel: number): string {
  return channel === 0 ? 'You' : channel === 1 ? 'System' : `Channel ${channel + 1}`;
}

function parseDeepgramResponse(raw: Record<string, unknown>): {
  utterances: Utterance[];
  text: string;
  language: string | null;
} {
  const results = raw.results as Record<string, unknown> | undefined;
  const utterances: Utterance[] = [];
  const parts: string[] = [];

  const segmented = results?.utterances;
  if (Array.isArray(segmented) && segmented.length > 0) {
    for (const item of segmented) {
      const u = item as Record<string, unknown>;
      const transcript = String(u.transcript ?? '').trim();
      if (!transcript) continue;
      const channel = typeof u.channel === 'number' ? u.channel : 0;
      utterances.push({
        speaker: channelLabel(channel),
        text: transcript,
        start_ms: Math.round(Number(u.start ?? 0) * 1000),
        end_ms: Math.round(Number(u.end ?? 0) * 1000),
        confidence: typeof u.confidence === 'number' ? u.confidence : undefined,
      });
      parts.push(transcript);
    }
  } else {
    const channels = results?.channels;
    if (Array.isArray(channels)) {
      channels.forEach((channel, index) => {
        const alt = (channel as Record<string, unknown>).alternatives;
        const first = Array.isArray(alt) ? (alt[0] as Record<string, unknown>) : undefined;
        const transcript = String(first?.transcript ?? '').trim();
        if (!transcript) return;
        utterances.push({
          speaker: channelLabel(index),
          text: transcript,
          start_ms: 0,
          end_ms: 0,
          confidence: typeof first?.confidence === 'number' ? first.confidence : undefined,
        });
        parts.push(transcript);
      });
    }
  }

  const channels = results?.channels;
  const firstChannel = Array.isArray(channels) ? channels[0] as Record<string, unknown> : undefined;
  const firstAlt = firstChannel?.alternatives;
  const firstResult = Array.isArray(firstAlt) ? firstAlt[0] as Record<string, unknown> : undefined;
  const language = typeof firstResult?.detected_language === 'string'
    ? firstResult.detected_language
    : null;

  return {
    utterances,
    text: parts.join(' '),
    language,
  };
}

async function transcribeWithDeepgram(
  audioPath: string,
  apiKey: string,
  intelligence: boolean,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    model: 'nova-3',
    multichannel: 'true',
    utterances: 'true',
    punctuate: 'true',
    smart_format: 'true',
    detect_language: 'true',
    diarize: 'false',
  });

  if (intelligence) {
    params.set('sentiment', 'true');
    params.set('topics', 'true');
    params.set('summarize', 'v2');
    params.set('intents', 'true');
    params.set('detect_entities', 'true');
  }

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
  const fileStream = createReadStream(audioPath);
  const started = Date.now();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/mp4',
    },
    // @ts-expect-error Node fetch accepts streams for duplex requests
    body: fileStream,
    duplex: 'half',
  });

  const elapsedSecs = (Date.now() - started) / 1000;
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Deepgram API ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text) as Record<string, unknown>;
  json._requestDurationSecs = elapsedSecs;
  return json;
}

function findSampleDifferences(assembly: MeetingTranscript, deepgram: Utterance[]): string[] {
  const differences: string[] = [];
  const bySpeaker = (speaker: string, utterances: Utterance[]) =>
    utterances.filter((u) => u.speaker === speaker).map((u) => normalizeText(u.text)).join(' ');

  for (const speaker of ['You', 'System']) {
    const aText = bySpeaker(speaker, assembly.utterances);
    const dText = bySpeaker(speaker, deepgram);
    const similarity = jaccardSimilarity(aText, dText);
    differences.push(`${speaker} channel similarity: ${(similarity * 100).toFixed(1)}%`);
  }

  const assemblyFirst = assembly.utterances.slice(0, 3);
  const deepgramFirst = deepgram.slice(0, 3);
  for (let i = 0; i < Math.max(assemblyFirst.length, deepgramFirst.length); i++) {
    const a = assemblyFirst[i];
    const d = deepgramFirst[i];
    if (!a || !d) continue;
    if (normalizeText(a.text) !== normalizeText(d.text)) {
      differences.push(
        `Utterance ${i + 1} [${a.speaker}]: AssemblyAI="${a.text.slice(0, 90)}..." | Deepgram="${d.text.slice(0, 90)}..."`,
      );
    }
  }

  return differences.slice(0, 6);
}

async function compareMeeting(
  meeting: MeetingRow,
  apiKey: string,
  intelligence: boolean,
): Promise<ComparisonResult> {
  const audioPath = join(MEETINGS_DIR, meeting.id, 'transcript-audio.m4a');
  if (!existsSync(audioPath)) {
    throw new Error(`Missing audio for ${meeting.id}: ${audioPath}`);
  }

  const assembly = loadAssemblyTranscript(meeting.id);
  const raw = await transcribeWithDeepgram(audioPath, apiKey, intelligence);
  const parsed = parseDeepgramResponse(raw);

  const result: ComparisonResult = {
    meetingId: meeting.id,
    title: meeting.title,
    durationSecs: meeting.duration_secs,
    assemblyai: {
      utteranceCount: assembly.utterances.length,
      wordCount: tokenize(assembly.text).length,
      avgConfidence: avgConfidence(assembly.utterances),
      language: assembly.language_code ?? null,
      textPreview: assembly.text.slice(0, 180),
    },
    deepgram: {
      utteranceCount: parsed.utterances.length,
      wordCount: tokenize(parsed.text).length,
      avgConfidence: avgConfidence(parsed.utterances),
      language: parsed.language,
      textPreview: parsed.text.slice(0, 180),
      requestDurationSecs: Number(raw._requestDurationSecs ?? 0),
    },
    comparison: {
      textSimilarity: jaccardSimilarity(assembly.text, parsed.text),
      utteranceCountDelta: parsed.utterances.length - assembly.utterances.length,
      youUtteranceDelta:
        parsed.utterances.filter((u) => u.speaker === 'You').length
        - assembly.utterances.filter((u) => u.speaker === 'You').length,
      systemUtteranceDelta:
        parsed.utterances.filter((u) => u.speaker === 'System').length
        - assembly.utterances.filter((u) => u.speaker === 'System').length,
      sampleDifferences: findSampleDifferences(assembly, parsed.utterances),
    },
  };

  if (intelligence) {
    const results = raw.results as Record<string, unknown> | undefined;
    const summary = results?.summary;
    const sentiments = results?.sentiments;
    const topics = results?.topics;
    const intents = results?.intents;
    const entities = results?.entities;
    result.intelligence = {
      summary,
      sentiments: Array.isArray(sentiments) ? sentiments.slice(0, 3) : sentiments,
      topics: Array.isArray(topics) ? topics.slice(0, 5) : topics,
      intents: Array.isArray(intents) ? intents.slice(0, 5) : intents,
      entities: Array.isArray(entities) ? entities.slice(0, 8) : entities,
    };
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    join(OUTPUT_DIR, `${meeting.id}.json`),
    JSON.stringify({ assembly, deepgram: parsed, raw, result }, null, 2),
  );

  return result;
}

function printResult(result: ComparisonResult) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Meeting: ${result.title}`);
  console.log(`ID: ${result.meetingId}`);
  console.log(`Duration: ${Math.round(result.durationSecs / 60)} min`);
  console.log(`${'='.repeat(72)}`);

  console.log('\nAssemblyAI (existing DB):');
  console.log(`  Utterances: ${result.assemblyai.utteranceCount}`);
  console.log(`  Words:      ${result.assemblyai.wordCount}`);
  console.log(`  Avg conf:   ${result.assemblyai.avgConfidence?.toFixed(3) ?? 'n/a'}`);
  console.log(`  Language:   ${result.assemblyai.language ?? 'n/a'}`);
  console.log(`  Preview:    ${result.assemblyai.textPreview}...`);

  console.log('\nDeepgram (nova-3, multichannel):');
  console.log(`  Utterances: ${result.deepgram.utteranceCount}`);
  console.log(`  Words:      ${result.deepgram.wordCount}`);
  console.log(`  Avg conf:   ${result.deepgram.avgConfidence?.toFixed(3) ?? 'n/a'}`);
  console.log(`  Language:   ${result.deepgram.language ?? 'n/a'}`);
  console.log(`  Latency:    ${result.deepgram.requestDurationSecs.toFixed(1)}s`);
  console.log(`  Preview:    ${result.deepgram.textPreview}...`);

  console.log('\nComparison:');
  console.log(`  Overall text similarity (Jaccard): ${(result.comparison.textSimilarity * 100).toFixed(1)}%`);
  console.log(`  Utterance count delta: ${result.comparison.utteranceCountDelta >= 0 ? '+' : ''}${result.comparison.utteranceCountDelta}`);
  console.log(`  You channel delta: ${result.comparison.youUtteranceDelta >= 0 ? '+' : ''}${result.comparison.youUtteranceDelta}`);
  console.log(`  System channel delta: ${result.comparison.systemUtteranceDelta >= 0 ? '+' : ''}${result.comparison.systemUtteranceDelta}`);
  console.log('  Sample differences:');
  for (const line of result.comparison.sampleDifferences) {
    console.log(`    - ${line}`);
  }

  if (result.intelligence) {
    console.log('\nDeepgram Intelligence (single-request extras):');
    console.log(JSON.stringify(result.intelligence, null, 2));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = args.key as string | undefined;
  const meetingId = args.meeting as string | undefined;
  const intelligence = Boolean(args.intelligence);

  if (!apiKey) {
    console.error('Usage: npx tsx scripts/test-deepgram-comparison.ts --key <deepgram-api-key> [--meeting <uuid>] [--intelligence]');
    process.exit(1);
  }

  if (!existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    process.exit(1);
  }

  let meetings = listMeetings();
  if (meetingId) {
    meetings = meetings.filter((m) => m.id === meetingId);
    if (meetings.length === 0) {
      console.error(`No completed transcript found for meeting ${meetingId}`);
      process.exit(1);
    }
  } else {
    // Default: compare all meetings under 35 minutes to keep runtime reasonable
    meetings = meetings.filter((m) => m.duration_secs <= 35 * 60);
  }

  console.log(`Comparing ${meetings.length} meeting(s) with Deepgram...`);
  const results: ComparisonResult[] = [];

  for (const meeting of meetings) {
    console.log(`\nTranscribing: ${meeting.title} (${basename(join(MEETINGS_DIR, meeting.id, 'transcript-audio.m4a'))})`);
    try {
      const result = await compareMeeting(meeting, apiKey, intelligence && results.length === 0);
      results.push(result);
      printResult(result);
    } catch (error) {
      console.error(`Failed for ${meeting.id}:`, error instanceof Error ? error.message : error);
    }
  }

  if (results.length > 0) {
    const summaryPath = join(OUTPUT_DIR, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify(results, null, 2));
    console.log(`\nSaved detailed outputs to ${OUTPUT_DIR}`);
    console.log(`Saved summary to ${summaryPath}`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});