import { createSignal } from 'solid-js';

type PanelResizeOptions = {
  storageKey: string;
  defaultPercent: number;
  minPercent: number;
  maxPercent: number;
  /** 'x' resizes against the container width, 'y' against its height. */
  axis: 'x' | 'y';
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function readStoredPercent(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Drag-to-resize state for a split panel. The returned `onPointerDown` goes on the
 * divider handle; the handle's parent element is measured as the split container.
 * The chosen size persists to localStorage as a percentage.
 */
export function createPanelResize(options: PanelResizeOptions) {
  const { storageKey, defaultPercent, minPercent, maxPercent, axis } = options;
  const [percent, setPercent] = createSignal(
    readStoredPercent(storageKey, defaultPercent, minPercent, maxPercent),
  );
  const [dragging, setDragging] = createSignal(false);

  const onPointerDown = (event: PointerEvent) => {
    const handle = event.currentTarget as HTMLElement;
    const container = handle.parentElement;
    if (!container) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const rect = container.getBoundingClientRect();

    const onMove = (move: PointerEvent) => {
      const ratio =
        axis === 'x'
          ? (move.clientX - rect.left) / rect.width
          : (move.clientY - rect.top) / rect.height;
      setPercent(clamp(ratio * 100, minPercent, maxPercent));
    };
    const onUp = (up: PointerEvent) => {
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      try {
        localStorage.setItem(storageKey, String(Math.round(percent() * 10) / 10));
      } catch {
        // Persistence is best-effort; the session keeps the in-memory size.
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  return { percent, dragging, onPointerDown };
}
