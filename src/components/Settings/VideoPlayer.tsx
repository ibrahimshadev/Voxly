import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-solid';
import type { Utterance } from '../../types';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SPEED_KEY = 'meetings.playbackRate';
const VOLUME_KEY = 'meetings.playerVolume';
const MUTED_KEY = 'meetings.playerMuted';
const CONTROLS_HIDE_DELAY_MS = 2600;
const DOUBLE_CLICK_WINDOW_MS = 220;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const parsed = Number(localStorage.getItem(key));
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mmss = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : mmss;
}

type VideoPlayerProps = {
  src: string;
  utterances?: Utterance[];
  speakerNames?: Record<string, string>;
  /** Used for seek math until the file reports its own duration. */
  fallbackDurationSecs?: number;
  ref?: (el: HTMLVideoElement) => void;
};

function formatSpeaker(speaker: string, names?: Record<string, string>): string {
  const renamed = names?.[speaker]?.trim();
  if (renamed) return renamed;
  if (speaker === 'You' || speaker === 'System') return speaker;
  if (speaker.startsWith('Sys-') || /^Ch\d+-/.test(speaker)) return speaker;
  return `Speaker ${speaker}`;
}

export default function VideoPlayer(props: VideoPlayerProps) {
  let containerRef: HTMLDivElement | undefined;
  let videoEl: HTMLVideoElement | undefined;
  let barRef: HTMLDivElement | undefined;
  let hideTimer: number | undefined;
  let clickTimer: number | undefined;
  let rafId: number | undefined;

  const [playing, setPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [bufferedSecs, setBufferedSecs] = createSignal(0);
  const [volume, setVolume] = createSignal(readStoredNumber(VOLUME_KEY, 1, 0, 1));
  const [muted, setMuted] = createSignal(localStorage.getItem(MUTED_KEY) === '1');
  const [speed, setSpeed] = createSignal(readStoredNumber(SPEED_KEY, 1, 0.25, 4));
  const [fullscreen, setFullscreen] = createSignal(false);
  const [controlsVisible, setControlsVisible] = createSignal(true);
  const [speedMenuOpen, setSpeedMenuOpen] = createSignal(false);
  const [scrubbing, setScrubbing] = createSignal(false);
  const [hoverRatio, setHoverRatio] = createSignal<number | null>(null);

  const totalSecs = () => {
    const reported = duration();
    if (Number.isFinite(reported) && reported > 0) return reported;
    return props.fallbackDurationSecs ?? 0;
  };

  const progressPct = (secs: number) => {
    const total = totalSecs();
    return total > 0 ? `${clamp((secs / total) * 100, 0, 100)}%` : '0%';
  };

  // One marker per speaker turn (not per utterance) keeps long meetings readable.
  const markers = createMemo(() => {
    const total = totalSecs();
    const utterances = props.utterances;
    if (!utterances?.length || total <= 0) return [];
    const turns: { pct: number; speaker: string }[] = [];
    let lastSpeaker: string | undefined;
    for (const utterance of utterances) {
      if (utterance.speaker === lastSpeaker) continue;
      lastSpeaker = utterance.speaker;
      const pct = (utterance.start_ms / 1000 / total) * 100;
      if (pct >= 0 && pct <= 100) turns.push({ pct, speaker: utterance.speaker });
    }
    return turns;
  });

  const speakerAt = (secs: number): string | null => {
    const ms = secs * 1000;
    const utterance = props.utterances?.find((u) => ms >= u.start_ms && ms <= u.end_ms);
    return utterance?.speaker ?? null;
  };

  const stopRaf = () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    rafId = undefined;
  };
  const startRaf = () => {
    stopRaf();
    const tick = () => {
      if (videoEl) setCurrentTime(videoEl.currentTime);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (playing() && !scrubbing() && !speedMenuOpen()) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  };
  const poke = () => {
    setControlsVisible(true);
    if (playing()) scheduleHide();
  };

  const togglePlay = () => {
    if (!videoEl) return;
    if (videoEl.paused || videoEl.ended) void videoEl.play().catch(() => undefined);
    else videoEl.pause();
  };

  const skip = (deltaSecs: number) => {
    if (!videoEl) return;
    videoEl.currentTime = Math.max(0, videoEl.currentTime + deltaSecs);
    setCurrentTime(videoEl.currentTime);
    poke();
  };

  const toggleMute = () => {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (containerRef) await containerRef.requestFullscreen();
    } catch {
      // Fullscreen can be rejected (e.g. not user-initiated); ignore.
    }
  };

  const applySpeed = (value: number) => {
    setSpeed(value);
    if (videoEl) {
      videoEl.playbackRate = value;
      videoEl.defaultPlaybackRate = value;
    }
    try {
      localStorage.setItem(SPEED_KEY, String(value));
    } catch {
      // Best-effort persistence.
    }
    setSpeedMenuOpen(false);
  };

  // Single click toggles play, double click toggles fullscreen.
  const onSurfaceClick = () => {
    if (clickTimer !== undefined) {
      window.clearTimeout(clickTimer);
      clickTimer = undefined;
      void toggleFullscreen();
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined;
      togglePlay();
    }, DOUBLE_CLICK_WINDOW_MS);
  };

  const ratioFromEvent = (event: PointerEvent): number => {
    if (!barRef) return 0;
    const rect = barRef.getBoundingClientRect();
    return rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
  };
  const seekToRatio = (ratio: number) => {
    if (!videoEl || totalSecs() <= 0) return;
    videoEl.currentTime = ratio * totalSecs();
    setCurrentTime(videoEl.currentTime);
  };

  const onBarPointerDown = (event: PointerEvent) => {
    if (!barRef) return;
    event.preventDefault();
    barRef.setPointerCapture(event.pointerId);
    setScrubbing(true);
    setHoverRatio(ratioFromEvent(event));
    seekToRatio(ratioFromEvent(event));
  };
  const onBarPointerMove = (event: PointerEvent) => {
    const ratio = ratioFromEvent(event);
    setHoverRatio(ratio);
    if (scrubbing()) seekToRatio(ratio);
    poke();
  };
  const onBarPointerUp = (event: PointerEvent) => {
    if (!scrubbing() || !barRef) return;
    barRef.releasePointerCapture(event.pointerId);
    setScrubbing(false);
    setHoverRatio(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    // A focused control button handles Space/Enter natively; don't double-fire.
    if (target.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) {
      return;
    }
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        skip(-5);
        break;
      case 'ArrowRight':
        event.preventDefault();
        skip(5);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        void toggleFullscreen();
        break;
      default:
        return;
    }
    poke();
  };

  onMount(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === containerRef);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    onCleanup(() => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      stopRaf();
      window.clearTimeout(hideTimer);
      window.clearTimeout(clickTimer);
    });
  });

  const showControls = () => controlsVisible() || !playing();
  const hoverSecs = () => (hoverRatio() ?? 0) * totalSecs();

  return (
    <div
      ref={containerRef}
      tabindex="0"
      class="group/player relative h-full w-full overflow-hidden bg-[#0b0b0b] outline-none select-none"
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerLeave={() => {
        if (playing() && !scrubbing() && !speedMenuOpen()) setControlsVisible(false);
      }}
    >
      <video
        ref={(el) => {
          videoEl = el;
          el.playbackRate = speed();
          el.defaultPlaybackRate = speed();
          el.volume = volume();
          el.muted = muted();
          props.ref?.(el);
        }}
        src={props.src}
        preload="metadata"
        class="h-full w-full object-contain"
        onClick={onSurfaceClick}
        onPlay={() => {
          setPlaying(true);
          startRaf();
          scheduleHide();
        }}
        onPause={() => {
          setPlaying(false);
          stopRaf();
          setControlsVisible(true);
        }}
        onEnded={() => {
          setPlaying(false);
          stopRaf();
          setControlsVisible(true);
        }}
        onTimeUpdate={() => videoEl && setCurrentTime(videoEl.currentTime)}
        onLoadedMetadata={() => videoEl && setDuration(videoEl.duration)}
        onDurationChange={() => videoEl && setDuration(videoEl.duration)}
        onProgress={() => {
          if (!videoEl) return;
          const ranges = videoEl.buffered;
          if (ranges.length > 0) setBufferedSecs(ranges.end(ranges.length - 1));
        }}
        onVolumeChange={() => {
          if (!videoEl) return;
          setVolume(videoEl.volume);
          setMuted(videoEl.muted);
          try {
            localStorage.setItem(VOLUME_KEY, String(videoEl.volume));
            localStorage.setItem(MUTED_KEY, videoEl.muted ? '1' : '0');
          } catch {
            // Best-effort persistence.
          }
        }}
      />

      {/* Center play affordance while paused */}
      <Show when={!playing()}>
        <button
          type="button"
          onClick={togglePlay}
          class="absolute left-1/2 top-1/2 z-10 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white transition-colors hover:bg-black/80 cursor-pointer"
          title="Play"
        >
          <Play size={22} class="ml-0.5" />
        </button>
      </Show>

      {/* Click-away layer for the speed menu */}
      <Show when={speedMenuOpen()}>
        <div class="absolute inset-0 z-20" onClick={() => setSpeedMenuOpen(false)} />
      </Show>

      {/* Bottom control bar */}
      <div
        class={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-1.5 pt-8 transition-opacity duration-200 ${
          showControls() ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* Seek bar */}
        <div
          ref={barRef}
          class="group/bar relative flex h-5 cursor-pointer items-center"
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
          onPointerCancel={onBarPointerUp}
          onPointerLeave={() => {
            if (!scrubbing()) setHoverRatio(null);
          }}
        >
          <div class="relative h-[4px] w-full bg-white/15">
            <div
              class="absolute inset-y-0 left-0 bg-white/20"
              style={{ width: progressPct(bufferedSecs()) }}
            />
            <div
              class="absolute inset-y-0 left-0 bg-primary"
              style={{ width: progressPct(currentTime()) }}
            />
            <For each={markers()}>
              {(marker) => (
                <div
                  class="absolute top-1/2 h-[10px] w-[2px] -translate-y-1/2"
                  style={{
                    left: `${marker.pct}%`,
                    background:
                      marker.speaker === 'You' ? 'rgba(16,183,127,0.9)' : 'rgba(255,255,255,0.55)',
                  }}
                />
              )}
            </For>
            <div
              class={`absolute top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary transition-opacity ${
                scrubbing() ? 'opacity-100' : 'opacity-0 group-hover/bar:opacity-100'
              }`}
              style={{ left: progressPct(currentTime()) }}
            />
          </div>

          {/* Hover tooltip: timestamp + speaker */}
          <Show when={hoverRatio() !== null && totalSecs() > 0}>
            <div
              class="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap border border-white/10 bg-black/90 px-2 py-1 font-mono text-[10px] text-zinc-200"
              style={{ left: `${clamp((hoverRatio() ?? 0) * 100, 6, 94)}%` }}
            >
              {formatTime(hoverSecs())}
              <Show when={speakerAt(hoverSecs())}>
                {(speaker) => (
                  <span class="ml-1.5 text-zinc-400">
                    · {formatSpeaker(speaker(), props.speakerNames)}
                  </span>
                )}
              </Show>
            </div>
          </Show>
        </div>

        {/* Buttons row */}
        <div class="mt-0.5 flex items-center gap-0.5">
          <button
            type="button"
            onClick={togglePlay}
            class="flex h-8 w-8 cursor-pointer items-center justify-center text-zinc-200 transition-colors hover:text-white"
            title={playing() ? 'Pause (Space)' : 'Play (Space)'}
          >
            <Show when={playing()} fallback={<Play size={17} />}>
              <Pause size={17} />
            </Show>
          </button>
          <button
            type="button"
            onClick={() => skip(-10)}
            class="flex h-8 w-8 cursor-pointer items-center justify-center text-zinc-300 transition-colors hover:text-white"
            title="Back 10s (←)"
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            onClick={() => skip(10)}
            class="flex h-8 w-8 cursor-pointer items-center justify-center text-zinc-300 transition-colors hover:text-white"
            title="Forward 10s (→)"
          >
            <RotateCw size={15} />
          </button>

          <span class="ml-1.5 font-mono text-[11px] tabular-nums text-zinc-300">
            {formatTime(currentTime())}
            <span class="text-zinc-500"> / {formatTime(totalSecs())}</span>
          </span>

          <div class="flex-1" />

          {/* Playback speed */}
          <div class="relative z-30">
            <button
              type="button"
              onClick={() => setSpeedMenuOpen(!speedMenuOpen())}
              class="h-8 cursor-pointer px-2 font-mono text-[11px] text-zinc-300 transition-colors hover:text-white"
              title="Playback speed"
            >
              {speed()}×
            </button>
            <Show when={speedMenuOpen()}>
              <div class="absolute bottom-full right-0 mb-1.5 w-20 border border-white/10 bg-[#101114] py-1">
                <For each={SPEEDS}>
                  {(value) => (
                    <button
                      type="button"
                      onClick={() => applySpeed(value)}
                      class={`block w-full cursor-pointer px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-white/10 ${
                        value === speed() ? 'text-primary' : 'text-zinc-300'
                      }`}
                    >
                      {value}×
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Volume */}
          <button
            type="button"
            onClick={toggleMute}
            class="flex h-8 w-8 cursor-pointer items-center justify-center text-zinc-300 transition-colors hover:text-white"
            title="Mute (M)"
          >
            <Show when={!muted() && volume() > 0} fallback={<VolumeX size={16} />}>
              <Volume2 size={16} />
            </Show>
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted() ? 0 : volume()}
            onInput={(event) => {
              if (!videoEl) return;
              const value = Number(event.currentTarget.value);
              videoEl.volume = value;
              videoEl.muted = value === 0;
            }}
            class="w-16 cursor-pointer"
            title="Volume"
          />

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            class="ml-0.5 flex h-8 w-8 cursor-pointer items-center justify-center text-zinc-300 transition-colors hover:text-white"
            title="Fullscreen (F)"
          >
            <Show when={fullscreen()} fallback={<Maximize size={15} />}>
              <Minimize size={15} />
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
}
