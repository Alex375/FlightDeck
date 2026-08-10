// The user's composer-bar arrangement, persisted to localStorage with the same
// lightweight pattern as display.ts / manualOrder.ts — pure UI arrangement, so it stays
// out of the SQLite metadata store (no Rust, no migration, no regenerated bindings).
//
// What it holds:
//   • `compactLeft` — per left-hand chip, force icon-only. The width-driven compaction
//     (`@container composer (max-width:500px)`) still applies on top: this setting is a
//     FLOOR (always icon-only), the container query remains the CEILING (icon-only when
//     narrow). They compose without conflict.
//   • `hidden` / `rightOrder` — the right-hand side, hideable and reorderable.
//   • `customs` — user-made buttons (icon + one action).
//
// ONE global arrangement, deliberately not per-repository: the bar is muscle memory, and
// a control that moves between repos destroys the very thing this feature protects. The
// per-repo need is about custom BUTTONS, which is why `CustomButton.repoId` is reserved
// in the stored shape (see composerLayout.ts) even though v1 never sets it.
import { create } from "zustand";
import { chipById, type CustomButton } from "../features/conversation/composerLayout";

const STORAGE_KEY = "tosse:composer";

interface ComposerBarData {
  /** chip id → force icon-only. Absent / false = follow the width. */
  compactLeft: Record<string, boolean>;
  /** Right-hand ids the user hid (native chips and custom buttons alike). */
  hidden: string[];
  /** Right-hand ids in render order; ids absent from it keep their natural position. */
  rightOrder: string[];
  customs: CustomButton[];
}

const empty = (): ComposerBarData => ({ compactLeft: {}, hidden: [], rightOrder: [], customs: [] });

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Keep only what still exists and is legal, so a hand-edited or outdated blob degrades
 *  to "some settings were dropped" instead of poisoning the render. */
function normCustom(v: unknown): CustomButton | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<CustomButton>;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.action !== "string" || !o.action) return null;
  return {
    id: o.id,
    icon: typeof o.icon === "string" && o.icon ? o.icon : "spark",
    label: typeof o.label === "string" ? o.label : "",
    action: o.action,
    arg: typeof o.arg === "string" ? o.arg : undefined,
    repoId: typeof o.repoId === "string" ? o.repoId : null,
  };
}

function load(): ComposerBarData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<ComposerBarData>;
    const compactLeft: Record<string, boolean> = {};
    if (parsed.compactLeft && typeof parsed.compactLeft === "object") {
      for (const [id, on] of Object.entries(parsed.compactLeft)) {
        // Only left-hand chips can be forced compact; a stale id from an older version
        // (or a right-hand one) is dropped rather than kept as dead weight.
        if (on === true && chipById(id)?.side === "left") compactLeft[id] = true;
      }
    }
    const customs: CustomButton[] = [];
    if (Array.isArray(parsed.customs)) {
      const seen = new Set<string>();
      for (const c of parsed.customs) {
        const norm = normCustom(c);
        if (norm && !seen.has(norm.id)) {
          customs.push(norm);
          seen.add(norm.id);
        }
      }
    }
    return {
      compactLeft,
      // A left-hand id can never be hidden — drop it here so the budget maths and the
      // render agree even on a doctored blob.
      hidden: strings(parsed.hidden).filter((id) => chipById(id)?.side !== "left"),
      rightOrder: strings(parsed.rightOrder),
      customs,
    };
  } catch {
    return empty();
  }
}

function save(data: ComposerBarData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota / disabled storage — best-effort, matches the other preference stores */
  }
}

interface ComposerBarState extends ComposerBarData {
  /** Force a left-hand chip to icon-only (or let it follow the width again). */
  setLeftCompact: (chipId: string, compact: boolean) => void;
  /** Show / hide a right-hand control. Left-hand ids are ignored by design. */
  setHidden: (id: string, hidden: boolean) => void;
  /** Persist the right-hand arrangement after a drop. */
  setRightOrder: (ids: string[]) => void;
  addCustom: (button: CustomButton) => void;
  updateCustom: (id: string, patch: Partial<Omit<CustomButton, "id">>) => void;
  removeCustom: (id: string) => void;
  /**
   * Back to the shipped bar (Settings → "Reset the bar").
   *
   * ⚠️ Deliberately NOT wired into `wipeAllData`. That wipe clears everything keyed BY a
   * repo or conversation (manual order, drafts, folds) because it turns to rubbish once
   * they are gone — but the bar is a global preference like the rest of `display.ts`,
   * which survives, and the custom buttons are user CONTENT (their prompt text). Losing
   * them as a side effect of deleting conversations would be a surprise, so this button
   * is the only way back.
   */
  reset: () => void;
}

export const useComposerBar = create<ComposerBarState>((set) => {
  const commit = (data: ComposerBarData) => {
    save(data);
    return data;
  };
  return {
    ...load(),
    setLeftCompact: (chipId, compact) =>
      set((s) => {
        if (chipById(chipId)?.side !== "left") return s;
        const compactLeft = { ...s.compactLeft };
        if (compact) compactLeft[chipId] = true;
        else delete compactLeft[chipId];
        return commit({ ...pick(s), compactLeft });
      }),
    setHidden: (id, hidden) =>
      set((s) => {
        if (chipById(id)?.side === "left") return s;
        const has = s.hidden.includes(id);
        if (hidden === has) return s;
        return commit({
          ...pick(s),
          hidden: hidden ? [...s.hidden, id] : s.hidden.filter((x) => x !== id),
        });
      }),
    setRightOrder: (ids) => set((s) => commit({ ...pick(s), rightOrder: [...ids] })),
    addCustom: (button) => set((s) => commit({ ...pick(s), customs: [...s.customs, button] })),
    updateCustom: (id, patch) =>
      set((s) =>
        commit({
          ...pick(s),
          customs: s.customs.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
        }),
      ),
    removeCustom: (id) =>
      set((s) =>
        commit({
          ...pick(s),
          customs: s.customs.filter((c) => c.id !== id),
          // Scrub the deleted id from the other two lists so it can't linger as a ghost
          // entry that silently eats an arrangement position.
          hidden: s.hidden.filter((x) => x !== id),
          rightOrder: s.rightOrder.filter((x) => x !== id),
        }),
      ),
    reset: () => set(() => commit(empty())),
  };
});

/** Strip the actions off the state so a committed object is pure data. */
function pick(s: ComposerBarState): ComposerBarData {
  return { compactLeft: s.compactLeft, hidden: s.hidden, rightOrder: s.rightOrder, customs: s.customs };
}
