// Width of the TOSSE view's task detail panel. Same lightweight pattern as sidebar.ts: a
// pure layout preference, so it lives in localStorage rather than the SQLite metadata store.
import { create } from "zustand";

const STORAGE_KEY = "tosse:tosseDetail";

/** Drag bounds for the panel (px).
 *
 *  The default is deliberately WIDE. At the previous fixed 372px the panel held roughly 50
 *  characters per line, which is below what long-form Markdown — the notes and context this
 *  panel exists to show — needs to stay readable. 520px lands near 68, and the CRM's own
 *  task page is wider still. */
export const DETAIL_MIN = 380;
export const DETAIL_MAX = 760;
const DEFAULT_WIDTH = 520;

/**
 * Clamp a dragged width.
 *
 * `available` is the width of the row the panel shares with the list. The CSS also caps the
 * panel at a share of that row, and without passing it here the two disagreed: on a narrow
 * window the drag kept storing widths the layout would never honour, so a whole stretch of
 * the splitter's travel did nothing on screen while quietly rewriting the stored value —
 * and the panel then jumped when the window was widened again. One clamp, one truth.
 */
export function clampDetailWidth(w: number, available?: number): number {
  const viewportCap = available && available > 0 ? available * VIEWPORT_SHARE : Infinity;
  // The floor still wins over the share: below it the panel is not worth showing at all,
  // and the list gives up the room instead (mirrors the CSS `min-width`).
  const cap = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, viewportCap));
  return Math.round(Math.min(cap, Math.max(DETAIL_MIN, w)));
}

/** Must match `.detail`'s `max-width` share in TosseView.module.css. */
export const VIEWPORT_SHARE = 0.55;

function load(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const p = JSON.parse(raw) as { width?: number };
    return typeof p.width === "number" ? clampDetailWidth(p.width) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function save(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width }));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface TosseDetailState {
  width: number;
  /** Set the width and persist it. `available` is the row's width, so the clamp matches
   *  what the layout will actually grant (see {@link clampDetailWidth}). */
  setWidth: (w: number, available?: number) => void;
}

export const useTosseDetail = create<TosseDetailState>((set) => ({
  width: load(),
  setWidth: (w, available) =>
    set(() => {
      const width = clampDetailWidth(w, available);
      save(width);
      return { width };
    }),
}));
