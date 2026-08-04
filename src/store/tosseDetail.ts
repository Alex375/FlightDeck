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

export function clampDetailWidth(w: number): number {
  return Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, Math.round(w)));
}

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
  /** Set the width (clamped to [MIN, MAX]) and persist it. */
  setWidth: (w: number) => void;
}

export const useTosseDetail = create<TosseDetailState>((set) => ({
  width: load(),
  setWidth: (w) =>
    set(() => {
      const width = clampDetailWidth(w);
      save(width);
      return { width };
    }),
}));
