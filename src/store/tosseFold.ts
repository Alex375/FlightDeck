// Which client bands are FOLDED in the TOSSE tasks view, keyed by client id. Persisted to
// localStorage via the shared {@link loadJson}/{@link saveJson} helpers — pure UI state, so
// it stays out of the SQLite core (no schema migration for a disclosure triangle).
//
// Only FOLDED clients are stored, so the default is "everything open": a client you have
// never touched can never be hidden by us, and a brand-new client in the CRM shows up
// rather than inheriting someone else's collapsed state.
import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

const STORAGE_KEY = "tosse:fold";

/** clientId → true (folded). Absent = open. */
type FoldMap = Record<string, boolean>;

const load = (): FoldMap => loadJson<FoldMap>(STORAGE_KEY, {});
const save = (map: FoldMap): void => saveJson(STORAGE_KEY, map);

interface TosseFoldState {
  folded: FoldMap;
  toggle: (clientKey: string) => void;
}

export const useTosseFold = create<TosseFoldState>((set) => ({
  folded: load(),
  toggle: (clientKey) =>
    set((s) => {
      const next = { ...s.folded };
      if (next[clientKey]) delete next[clientKey];
      else next[clientKey] = true;
      save(next);
      return { folded: next };
    }),
}));
