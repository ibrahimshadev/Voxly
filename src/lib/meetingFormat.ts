// Shared by the meetings page and its video player.

function clock(wholeSecs: number): string {
  const hours = Math.floor(wholeSecs / 3600);
  const minutes = Math.floor((wholeSecs % 3600) / 60);
  const secs = wholeSecs % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Recording and utterance lengths, rounded to the nearest second. */
export function formatDuration(seconds?: number) {
  return seconds ? clock(Math.round(seconds)) : '0:00';
}

/** Player position, truncated so the clock never runs ahead of playback. */
export function formatPlaybackTime(seconds: number) {
  return Number.isFinite(seconds) && seconds >= 0 ? clock(Math.floor(seconds)) : '0:00';
}

export function formatSpeakerLabel(speaker: string, names?: Record<string, string>) {
  const renamed = names?.[speaker]?.trim();
  if (renamed) return renamed;
  if (speaker === 'You' || speaker === 'System') return speaker;
  if (speaker.startsWith('Sys-') || /^Ch\d+-/.test(speaker)) return speaker;
  return `Speaker ${speaker}`;
}
