// Which disclosure bands are FOLDED in the TOSSE tasks view. Persisted to localStorage via
// the shared {@link loadJson}/{@link saveJson} helpers — pure UI state, so it stays out of
// the SQLite core (no schema migration for a disclosure triangle).
//
// Only FOLDED things are stored, so the default is "everything open": a band you have never
// touched can never be hidden by us, and a brand-new client or project in the CRM shows up
// rather than inheriting someone else's collapsed state.
//
// ⚠️ ONE map holds every kind of band, so the KEYS have to be a single namespace — hence the
// builders below rather than raw ids at the call sites. A client band is keyed by its bare
// client id (`groupByClient` hands it out, `"none"` for the client-less one), so every other
// kind carries a prefix that a CRM uuid can never produce.
import { create } from "zustand";
import { loadJson, saveJson } from "./persist";

const STORAGE_KEY = "tosse:fold";

/** Fold key for the project-less band. Prefixed so it can never collide with a client id. */
export const GENERAL_FOLD_KEY = "band:general";

/**
 * Fold key for a card's Backlog section.
 *
 * ⚠️ Read INVERTED. This store holds what is CLOSED, because every other band defaults to
 * open. The backlog defaults to CLOSED — it is what you are not working on — so here the
 * presence of the key means OPEN. Same store, same persistence, opposite default.
 */
export const backlogFoldKey = (projectId: string) => `backlog:${projectId}`;

/**
 * Fold key for a card's « En attente » section — read the NORMAL way round.
 *
 * The two off-board sections are rendered by one component but default oppositely, and
 * deliberately (Alexandre, 2026-08-11): a parked-but-waiting task is live work whose ball
 * is in someone else's court, so you want to see it; a backlog item is work you have
 * decided not to start, so you don't. Hence its own key namespace, and the reading sense
 * that goes with it.
 */
export const pendingFoldKey = (projectId: string) => `pending:${projectId}`;

/** Fold key for a project card's body. Prefixed: a project id and a client id are both bare
 *  uuids from the same CRM, and un-prefixed they would share this map — folding a client
 *  would have folded a project that happens to be keyed alike. */
export const projectFoldKey = (projectId: string) => `project:${projectId}`;

/**
 * How ONE off-board section folds: which key namespace it lives in, and which way its
 * default runs.
 *
 * Both facts in one place because they must agree — the store records what is CLOSED, so a
 * section that defaults to OPEN reads its key inverted. Splitting the two across the store
 * and the component is how a section ends up permanently hidden.
 */
const OFF_BOARD_FOLD: Record<string, { key: (id: string) => string; defaultOpen: boolean }> = {
  "En attente": { key: pendingFoldKey, defaultOpen: true },
  Backlog: { key: backlogFoldKey, defaultOpen: false },
};

export function offBoardFold(status: string): { key: (id: string) => string; defaultOpen: boolean } {
  const known = OFF_BOARD_FOLD[status];
  if (known) return known;
  // ⚠️ A TABLE with a per-status fallback, not a `status === "Backlog" ? … : pending`. The
  // off-board status list is the CRM server's and can grow without this file being touched;
  // routing everything else into the `pending:` namespace was not a default but a COLLISION —
  // a third section would have shared one fold key with « En attente », so collapsing either
  // would collapse both on every card, and `aria-expanded` would lie on one of them. A
  // namespace derived from the status keeps each section its own, and open by default is the
  // safe direction (this store only records what is CLOSED).
  return { key: (id: string) => `offboard:${status}:${id}`, defaultOpen: true };
}

/** foldKey → true (folded). Absent = open. */
type FoldMap = Record<string, boolean>;

const load = (): FoldMap => loadJson<FoldMap>(STORAGE_KEY, {});
const save = (map: FoldMap): void => saveJson(STORAGE_KEY, map);

interface TosseFoldState {
  folded: FoldMap;
  toggle: (foldKey: string) => void;
}

export const useTosseFold = create<TosseFoldState>((set) => ({
  folded: load(),
  toggle: (foldKey) =>
    set((s) => {
      const next = { ...s.folded };
      if (next[foldKey]) delete next[foldKey];
      else next[foldKey] = true;
      save(next);
      return { folded: next };
    }),
}));
