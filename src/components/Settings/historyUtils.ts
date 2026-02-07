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

export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(timestampMs)) return 'Unknown time';

  const elapsedSeconds = Math.floor((nowMs - timestampMs) / 1000);
  if (elapsedSeconds < 0) return 'just now';
  if (elapsedSeconds < 60) return 'just now';

  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatItemTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return 'Unknown';

  const now = new Date();
  const date = new Date(timestampMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;

  if (timestampMs >= startOfToday) {
    return formatRelativeTime(timestampMs);
  }

  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (timestampMs >= startOfYesterday) {
    return `Yesterday, ${timeStr}`;
  }

  const dayOfWeek = now.getDay();
  const startOfThisWeek = startOfToday - (dayOfWeek * 86400000);
  if (timestampMs >= startOfThisWeek) {
    const dayName = date.toLocaleDateString([], { weekday: 'long' });
    return `${dayName}, ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateStr}, ${timeStr}`;
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
  if (items.length === 0) return [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const dayOfWeek = now.getDay();
  const startOfThisWeek = startOfToday - (dayOfWeek * 86400000);

  const buckets: Record<string, DateGroup> = {};
  const order: string[] = [];

  for (const item of items) {
    let key: string;
    let label: string;
    let isToday = false;

    if (item.created_at_ms >= startOfToday) {
      key = 'today';
      label = 'Today';
      isToday = true;
    } else if (item.created_at_ms >= startOfYesterday) {
      key = 'yesterday';
      label = 'Yesterday';
    } else if (item.created_at_ms >= startOfThisWeek) {
      key = 'this-week';
      label = 'This Week';
    } else {
      key = 'older';
      label = 'Older';
    }

    if (!buckets[key]) {
      buckets[key] = { label, isToday, items: [] };
      order.push(key);
    }
    buckets[key].items.push(item);
  }

  return order.map((key) => buckets[key]);
}
