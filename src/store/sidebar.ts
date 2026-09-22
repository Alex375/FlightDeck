// Width of the left conversations sidebar. A pure layout preference, persisted to
// localStorage (same lightweight pattern as display.ts / notifications.ts) rather
// than the Rust core — it's not domain data, so it doesn't belong in the SQLite
// metadata store, matching the "layout prefs live in localStorage" policy.
import { create } from "zustand";

const STORAGE_KEY = "tosse:sidebar";

/** Drag bounds for the sidebar width (px). The default matches the historical fixed
 *  width, so a user who never drags sees no change.
 *
 *  The floor is 150, not the original 190: measured at every width down to 120, NOTHING in
 *  the sidebar overflows its box — repo and conversation names simply ellipsis earlier, and
 *  the header's buttons are `flex:0 0 auto`. 190 was a guess, and it stopped people from
 *  reclaiming horizontal space they were entitled to. 150 is where a repo name still shows
 *  enough characters to be told apart; below that the list stops being navigable, which is
 *  a reason to stop, unlike "it might break" (it doesn't). */
export const SIDEBAR_MIN = 150;
export const SIDEBAR_MAX = 460;
const DEFAULT_WIDTH = 224;

export function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

function load(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const p = JSON.parse(raw) as { width?: number };
    return typeof p.width === "number" ? clampSidebarWidth(p.width) : DEFAULT_WIDTH;
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

interface SidebarState {
  width: number;
  /** Set the width (clamped to [MIN, MAX]) and persist it. */
  setWidth: (w: number) => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  width: load(),
  setWidth: (w) =>
    set(() => {
      const width = clampSidebarWidth(w);
      save(width);
      return { width };
    }),
}));
