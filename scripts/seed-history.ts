/**
 * Seed transcription_history.json with 100 random items for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-history.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TEXTS = [
  "The stale smell of old beer lingers. It takes heat to bring out the odor.",
  "A cold dip restores health and zest. A salt pickle tastes fine with ham.",
  "Tacos al pastor are my favorite. A zestful food is the hot cross bun.",
  "Send the meeting notes to the team before end of day please.",
  "We need to refactor the authentication module before the next sprint.",
  "Can you review the pull request I opened for the dashboard feature?",
  "The quarterly earnings report shows a fifteen percent increase in revenue.",
  "I think we should use WebSockets instead of polling for real-time updates.",
  "Remember to pick up groceries on the way home. We need milk and eggs.",
  "The flight to San Francisco departs at seven thirty tomorrow morning.",
  "Let me know when the deployment is finished so I can run the smoke tests.",
  "Hey can you schedule a one-on-one with the new hire for Thursday afternoon?",
  "The API response time has degraded significantly since the last release.",
  "I'll draft the proposal this weekend and share it with everyone on Monday.",
  "Please update the Kubernetes cluster to version one point twenty eight.",
  "The design looks great but I think we need more contrast on the buttons.",
  "Don't forget to add error handling for the edge case we discussed.",
  "The customer reported that the export feature is timing out on large datasets.",
  "We should probably add integration tests for the payment flow.",
  "I'm going to grab lunch. Does anyone want anything from the Thai place?",
  "The new onboarding flow reduced drop-off by twenty three percent.",
  "Can we move the standup to ten thirty? I have a conflict at nine.",
  "The database migration completed successfully with zero downtime.",
  "I need to update my resume before the end of the month.",
  "Let's circle back on the pricing strategy after the board meeting.",
];

const MODE_NAMES = [
  null, null, null, null, null, null, null, // ~70% no mode
  "Grammar & Punctuation",
  "Email Draft",
  "Meeting Notes",
];

const LANGUAGES = [
  "english", "english", "english", "english", "english", "english", "english",
  "english", "english", // ~90% english
  "spanish",
  "french",
];

const FORMATTED_PREFIXES = [
  "Dear team,\n\n",
  "Subject: ",
  "Action items:\n- ",
  "Hi,\n\n",
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

type HistoryItem = {
  id: string;
  text: string;
  created_at_ms: number;
  duration_secs?: number;
  language?: string;
  mode_name?: string;
  original_text?: string;
};

function generateItem(index: number): HistoryItem {
  const now = Date.now();
  // Spread items over the last 30 days, newest first
  const ageMs = index * randomBetween(15 * 60_000, 8 * 3600_000); // 15min to 8hrs apart
  const createdAtMs = Math.round(now - ageMs);

  const originalText = randomChoice(TEXTS);
  const modeName = randomChoice(MODE_NAMES);
  const language = randomChoice(LANGUAGES);
  const durationSecs = Math.round(randomBetween(2, 45) * 100) / 100;

  let text = originalText;
  let savedOriginal: string | undefined;

  if (modeName) {
    // Simulate mode formatting changing the text
    text = randomChoice(FORMATTED_PREFIXES) + originalText;
    savedOriginal = originalText;
  }

  const item: HistoryItem = {
    id: crypto.randomUUID(),
    text,
    created_at_ms: createdAtMs,
    duration_secs: durationSecs,
    language,
  };

  if (modeName) {
    item.mode_name = modeName;
    item.original_text = savedOriginal;
  }

  return item;
}

// Generate 100 items
const items: HistoryItem[] = [];
for (let i = 0; i < 100; i++) {
  items.push(generateItem(i));
}

// Write to the APPDATA path (Windows) or fallback
const appdata = process.env.APPDATA;
const xdgConfig = process.env.XDG_CONFIG_HOME;
const home = process.env.HOME;

let baseDir: string;
if (appdata) {
  baseDir = appdata;
} else if (xdgConfig) {
  baseDir = xdgConfig;
} else if (home) {
  baseDir = join(home, '.config');
} else {
  baseDir = '/tmp';
}

const dir = join(baseDir, 'dikt');
const filePath = join(dir, 'transcription_history.json');

mkdirSync(dir, { recursive: true });
writeFileSync(filePath, JSON.stringify(items, null, 2));

console.log(`Wrote ${items.length} items to ${filePath}`);
