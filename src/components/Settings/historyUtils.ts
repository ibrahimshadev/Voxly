import type { TranscriptionHistoryItem } from '../../types';

export function formatDurationHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (secs === 0) return `${minutes}m`;
  return `${minutes}m ${secs}s`;
}

export function formatTotalAudio(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs <= 0) return '0m';
  const totalSeconds = Math.round(totalSecs);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

const DAY_MS = 86400000;

function dayStarts(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { today, yesterday: today - DAY_MS, thisWeek: today - now.getDay() * DAY_MS };
}

// Only used for today's entries, so less than a day has passed (25h across a DST change).
function formatRelativeTime(timestampMs: number): string {
  const minutes = Math.floor((Date.now() - timestampMs) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : '1d ago';
}

export function formatItemTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return 'Unknown';

  const starts = dayStarts();
  if (timestampMs >= starts.today) return formatRelativeTime(timestampMs);

  const date = new Date(timestampMs);
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (timestampMs >= starts.yesterday) return `Yesterday, ${timeStr}`;
  if (timestampMs >= starts.thisWeek) {
    return `${date.toLocaleDateString([], { weekday: 'long' })}, ${timeStr}`;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
}

export function formatExactTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return 'Unknown time';
  return new Date(timestampMs).toLocaleString();
}

export function getLanguageCode(language: string): string {
  const map: Record<string, string> = {
    french: 'FR', spanish: 'ES', german: 'DE', italian: 'IT',
    portuguese: 'PT', dutch: 'NL', russian: 'RU', japanese: 'JA',
    korean: 'KO', chinese: 'ZH', arabic: 'AR', hindi: 'HI',
    turkish: 'TR', polish: 'PL', swedish: 'SV', danish: 'DA',
    norwegian: 'NO', finnish: 'FI', czech: 'CS', thai: 'TH',
    vietnamese: 'VI', indonesian: 'ID', malay: 'MS', tagalog: 'TL',
  };
  return map[language.toLowerCase()] ?? language.slice(0, 2).toUpperCase();
}

export type DateGroup = {
  label: string;
  isToday: boolean;
  items: TranscriptionHistoryItem[];
};

export function groupByDate(items: TranscriptionHistoryItem[]): DateGroup[] {
  const starts = dayStarts();
  const groups = new Map<string, DateGroup>();
  for (const item of items) {
    const at = item.created_at_ms;
    const label =
      at >= starts.today ? 'Today'
      : at >= starts.yesterday ? 'Yesterday'
      : at >= starts.thisWeek ? 'This Week'
      : 'Older';
    let group = groups.get(label);
    if (!group) {
      group = { label, isToday: label === 'Today', items: [] };
      groups.set(label, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
