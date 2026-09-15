// Open/collapsed state of the "Travail de Claude" fold blocks (clean-output mode),
// keyed by conversation id → round key → open. Persisted to localStorage via the shared
// {@link loadJson}/{@link saveJson} helpers (not the SQLite metadata store — this is pure UI
// state, so it stays out of the Rust core, no schema migration).
//
// Why a store and not a plain React useState in ClaudeWorkBlock: the conversation pane
// is remounted per conversation (`key={conv.id}` in ConductorConversation), so any local
// component state resets when you switch away and come back — the fold you opened would
// snap shut. A Zustand store is global and survives that remount, so the fold state
// persists across a conversation switch; localStorage additionally carries it across app
// restarts. Round keys are the assistant round's stable turn id (from the transcript,
// stable across reloads), so a persisted entry re-associates with the right block on
// return; an orphaned key just falls back to collapsed (the default), which is harmless.
import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

const STORAGE_KEY = "tosse:workfold";

// convId → roundKey → open. Absent = collapsed (the default), so we only ever store
// entries the user actually touched.
type FoldMap = Record<string, Record<string, boolean>>;

const load = (): FoldMap => loadJson<FoldMap>(STORAGE_KEY, {});
const save = (map: FoldMap): void => saveJson(STORAGE_KEY, map);

interface WorkFoldState {
  open: FoldMap;
  /** Flip one block's open state (per conversation + round). Persisted. */
  toggle: (conv: string, key: string) => void;
  /** Set one block's open state explicitly — a jump to a message folded inside it opens it
   *  (a toggle could close a block that is already open). Persisted. */
  setOpen: (conv: string, key: string, open: boolean) => void;
  /** Forget one conversation's fold state — wired into removeConversation/removeRepo,
   *  same as the other per-conversation UI caches (composer draft, todo bar). */
  clearConversation: (conv: string) => void;
  /** Drop every remembered fold state — wired into "Delete all" (wipeAllData). */
  clearAll: () => void;
}

export const useWorkFold = create<WorkFoldState>((set) => ({
  open: load(),
  toggle: (conv, key) =>
    set((s) => {
      const convMap = s.open[conv] ?? {};
      const next: FoldMap = { ...s.open, [conv]: { ...convMap, [key]: !convMap[key] } };
      save(next);
      return { open: next };
    }),
  setOpen: (conv, key, open) =>
    set((s) => {
      const convMap = s.open[conv] ?? {};
      if ((convMap[key] ?? false) === open) return s;
      const next: FoldMap = { ...s.open, [conv]: { ...convMap, [key]: open } };
      save(next);
      return { open: next };
    }),
  clearConversation: (conv) =>
    set((s) => {
      if (!(conv in s.open)) return s;
      const next = { ...s.open };
      delete next[conv];
      save(next);
      return { open: next };
    }),
  clearAll: () =>
    set(() => {
      save({});
      return { open: {} };
    }),
}));

/** Subscribe to one fold block's open state (default collapsed). */
export const useWorkFoldOpen = (conv: string, key: string): boolean =>
  useWorkFold((s) => s.open[conv]?.[key] ?? false);

/** Imperative clears for non-React callers (conversationsStore removal / wipe). */
export function clearWorkFold(conv: string): void {
  useWorkFold.getState().clearConversation(conv);
}
export function clearAllWorkFold(): void {
  useWorkFold.getState().clearAll();
}
