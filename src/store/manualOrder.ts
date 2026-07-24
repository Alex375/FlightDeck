// Manual (drag-and-drop) ordering of repos and conversations, persisted to
// localStorage with the same lightweight pattern as sidebarFold.ts / workFold.ts /
// display.ts — pure UI ordering, NOT domain data, so it stays out of the SQLite
// metadata store (the Rust core treats display order as "the front's concern").
//
// Shape: three independent order "slots" — `shared` (used by BOTH surfaces when the
// `sharedManualOrder` pref is on), `sidebar`, and `flightdeck` (used when the pref is
// off, so each surface keeps its own arrangement). Each slot holds an ordered list of
// repo ids plus, per repo, an ordered list of conversation ids.
//
// The stored order is only ever CONSULTED for a level whose "auto reorder by recency"
// toggle is OFF (manual mode). It is written by a drag-drop in manual mode. A drag in
// recency mode is handled ephemerally by the view (never persisted here).
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const STORAGE_KEY = "tosse:manualorder";

/** An ordered arrangement for one surface: repos, and per-repo conversations. */
export interface OrderBlob {
  /** Ordered repo ids. Repos absent here fall back to "new on top" (see comparator). */
  repoOrder: string[];
  /** repoId → ordered conversation ids (within that repo). */
  convOrder: Record<string, string[]>;
}

/** Which surface is asking. The concrete storage slot is resolved via {@link slotFor}
 *  against the `sharedManualOrder` pref. */
export type OrderSurface = "sidebar" | "flightdeck";
/** The concrete storage slot key (what actually gets read/written). */
export type OrderSlot = "shared" | OrderSurface;

/** Resolve the storage slot: when the two surfaces share one order, both use `shared`;
 *  otherwise each uses its own slot. Pure so the view and the store agree. */
export function slotFor(surface: OrderSurface, shared: boolean): OrderSlot {
  return shared ? "shared" : surface;
}

interface ManualOrderData {
  shared: OrderBlob;
  sidebar: OrderBlob;
  flightdeck: OrderBlob;
}

const emptyBlob = (): OrderBlob => ({ repoOrder: [], convOrder: {} });
const emptyData = (): ManualOrderData => ({
  shared: emptyBlob(),
  sidebar: emptyBlob(),
  flightdeck: emptyBlob(),
});

function normBlob(v: unknown): OrderBlob {
  const o = (v ?? {}) as Partial<OrderBlob>;
  const repoOrder = Array.isArray(o.repoOrder)
    ? o.repoOrder.filter((x): x is string => typeof x === "string")
    : [];
  const convOrder: Record<string, string[]> = {};
  if (o.convOrder && typeof o.convOrder === "object") {
    for (const [repoId, ids] of Object.entries(o.convOrder)) {
      if (Array.isArray(ids)) convOrder[repoId] = ids.filter((x): x is string => typeof x === "string");
    }
  }
  return { repoOrder, convOrder };
}

function load(): ManualOrderData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    const parsed = JSON.parse(raw) as Partial<ManualOrderData>;
    return {
      shared: normBlob(parsed.shared),
      sidebar: normBlob(parsed.sidebar),
      flightdeck: normBlob(parsed.flightdeck),
    };
  } catch {
    return emptyData();
  }
}

function save(data: ManualOrderData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface ManualOrderState extends ManualOrderData {
  /** Persist a repo arrangement for one slot (the full displayed order after a drop). */
  setRepoOrder: (slot: OrderSlot, repoIds: string[]) => void;
  /** Persist a repo's conversation arrangement for one slot. */
  setConvOrder: (slot: OrderSlot, repoId: string, convIds: string[]) => void;
  /** Forget a conversation from every slot (wired into removeConversation). */
  clearConversation: (convId: string) => void;
  /** Forget a repo (and its conversations) from every slot (wired into removeRepo). */
  clearRepo: (repoId: string) => void;
  /** Reset every arrangement (wired into "Delete all" / wipeAllData). */
  clearAll: () => void;
}

export const useManualOrder = create<ManualOrderState>((set) => ({
  ...load(),
  setRepoOrder: (slot, repoIds) =>
    set((s) => {
      const next = { ...s[slot], repoOrder: [...repoIds] };
      const data: ManualOrderData = { shared: s.shared, sidebar: s.sidebar, flightdeck: s.flightdeck, [slot]: next };
      save(data);
      return data;
    }),
  setConvOrder: (slot, repoId, convIds) =>
    set((s) => {
      const next: OrderBlob = { ...s[slot], convOrder: { ...s[slot].convOrder, [repoId]: [...convIds] } };
      const data: ManualOrderData = { shared: s.shared, sidebar: s.sidebar, flightdeck: s.flightdeck, [slot]: next };
      save(data);
      return data;
    }),
  clearConversation: (convId) =>
    set((s) => {
      const scrub = (b: OrderBlob): OrderBlob => {
        const convOrder: Record<string, string[]> = {};
        let touched = false;
        for (const [repoId, ids] of Object.entries(b.convOrder)) {
          if (ids.includes(convId)) {
            convOrder[repoId] = ids.filter((x) => x !== convId);
            touched = true;
          } else convOrder[repoId] = ids;
        }
        return touched ? { ...b, convOrder } : b;
      };
      const data: ManualOrderData = {
        shared: scrub(s.shared),
        sidebar: scrub(s.sidebar),
        flightdeck: scrub(s.flightdeck),
      };
      save(data);
      return data;
    }),
  clearRepo: (repoId) =>
    set((s) => {
      const scrub = (b: OrderBlob): OrderBlob => {
        const repoOrder = b.repoOrder.filter((x) => x !== repoId);
        const convOrder = { ...b.convOrder };
        delete convOrder[repoId];
        return { repoOrder, convOrder };
      };
      const data: ManualOrderData = {
        shared: scrub(s.shared),
        sidebar: scrub(s.sidebar),
        flightdeck: scrub(s.flightdeck),
      };
      save(data);
      return data;
    }),
  clearAll: () =>
    set(() => {
      const data = emptyData();
      save(data);
      return data;
    }),
}));

/** Reactive read of one slot's arrangement. `useShallow` keeps the reference stable
 *  unless that slot actually changes, so ordering consumers don't re-run needlessly. */
export function useOrderSlot(slot: OrderSlot): OrderBlob {
  return useManualOrder(useShallow((s) => s[slot]));
}

// ---- Imperative clears for non-React callers (conversationsStore removal / wipe) ----
export function clearManualOrderConversation(convId: string): void {
  useManualOrder.getState().clearConversation(convId);
}
export function clearManualOrderRepo(repoId: string): void {
  useManualOrder.getState().clearRepo(repoId);
}
export function clearAllManualOrder(): void {
  useManualOrder.getState().clearAll();
}

// ---- Pure comparator helpers (no store / no domain-type imports → testable) ---------

/** Build an id → position map from an ordered id list. */
export function manualIndex(order: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < order.length; i++) m.set(order[i], i);
  return m;
}

/** Flatten a per-repo convOrder into ONE id → within-repo-position map. Conversation
 *  ids are globally unique and only ever compared within their own repo bucket, so the
 *  per-repo (0-based) index is the right key for intra-bucket ordering. */
export function manualConvIndex(convOrder: Record<string, string[]>): Map<string, number> {
  const m = new Map<string, number>();
  for (const ids of Object.values(convOrder)) {
    for (let i = 0; i < ids.length; i++) m.set(ids[i], i);
  }
  return m;
}

/**
 * A comparator that honours a manual arrangement: items KNOWN to `index` sort by their
 * stored position; items NOT in it (brand-new, or never arranged) sort to the TOP,
 * newest-`bornAt`-first among themselves. `bornAt` must be an IMMUTABLE timestamp
 * (createdAt / addedAt), never lastActivityAt — so the fallback position is stable and
 * a manual arrangement never drifts on its own.
 */
export function manualComparator<T>(
  index: Map<string, number>,
  idOf: (t: T) => string,
  bornAt: (t: T) => number,
): (a: T, b: T) => number {
  return (a, b) => {
    const ia = index.get(idOf(a));
    const ib = index.get(idOf(b));
    if (ia === undefined && ib === undefined) return bornAt(b) - bornAt(a); // both new → newest on top
    if (ia === undefined) return -1; // a is new → to the top
    if (ib === undefined) return 1;
    return ia - ib;
  };
}
