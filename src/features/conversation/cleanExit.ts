// Exit choreography for the clean-output LIVE fold. Purely cosmetic: it changes NOTHING
// about WHAT folds or WHEN — `liveVisibleStart` / `splitFinalMessage` / `atomStillRunning`
// still decide that alone. It only keeps an item that just crossed the fold boundary mounted
// for a moment so it can animate towards the block above instead of being cut out.
//
// Why a hold is needed at all: the clear zone and the fold are two DIFFERENT render sites
// (`atomsToSegments` is called with keyPrefix "vis" vs "fold"), so the moment the cut moves,
// React unmounts the item on one side and mounts it on the other. Nothing is left to animate.
// Holding the atom in the clear zone for EXIT_MS keeps the SAME DOM node alive across the
// transition — the wrapper it already lives in simply gains `data-exit`, which is what starts
// the CSS transition (a freshly mounted node with the attribute already set would not animate).
//
// The state is adjusted DURING render (the "adjusting state when props change" pattern), never
// from an effect: an effect would let React commit one frame with the item already gone, and
// re-adding it afterwards would create a NEW node — a flicker plus a dead transition.

import { useEffect, useState } from "react";

/** How long an item stays mounted while flying out. Mirrors `--cv-exit-dur` in
 *  conductor-conversation.css — keep the two in step. */
export const EXIT_MS = 180;
/** Delay between two items of the SAME batch, so a group leaving at once reads item by item
 *  instead of evaporating together. */
export const EXIT_STAGGER_MS = 35;
/** Past this many slots the remaining items leave WITH the last one. A parallel batch can
 *  release a dozen tools at once; un-capped, the tail would still be animating long after the
 *  agent moved on. */
export const EXIT_MAX_SLOTS = 5;

/** Stagger delay of the n-th item of a batch (capped — see {@link EXIT_MAX_SLOTS}). */
export function exitDelayMs(slot: number): number {
  return Math.min(Math.max(slot, 0), EXIT_MAX_SLOTS) * EXIT_STAGGER_MS;
}

/** An atom held back in the clear zone while it animates out. `key` is the atom's render id
 *  (a step's tool_use id, else the segment key). */
export interface ExitHold {
  key: string;
  slot: number;
  expiresAt: number;
}

/** Do two key lists hold the same keys in the same order? */
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The holds after the cut moved: expired ones dropped, and every atom that just left the clear
 * zone FOR THE FOLD added with its stagger slot.
 *
 * An atom that vanished from the round entirely (a reload / rewind rebuilds the atom list) is
 * NOT held: it must be in `folded` to be considered "flying towards the block". Same guard on
 * the existing holds, so a rebuilt list drops them instead of resurrecting stale rows.
 */
export function computeExits(opts: {
  /** The clear-zone keys we last rendered against (the rule's own view, holds excluded). */
  prevVisible: readonly string[];
  /** The clear-zone keys the rule wants now. */
  visibleNow: readonly string[];
  /** Keys now on the folded side of the cut. */
  folded: ReadonlySet<string>;
  held: readonly ExitHold[];
  now: number;
  /** Optional veto: an atom that does NOT actually leave the clear flow must never be held.
   *  See {@link useWorkExit}. Defaults to holding everything. */
  holdable?: (key: string) => boolean;
}): ExitHold[] {
  const { prevVisible, visibleNow, folded, held, now, holdable } = opts;
  const kept = held.filter((h) => h.expiresAt > now && folded.has(h.key));
  const visible = new Set(visibleNow);
  const alreadyHeld = new Set(kept.map((h) => h.key));
  const leaving = prevVisible.filter(
    (k) =>
      !visible.has(k) && folded.has(k) && !alreadyHeld.has(k) && (holdable ? holdable(k) : true),
  );
  if (leaving.length === 0) return kept;
  const out = kept.slice();
  // ⚠️ ONE deadline for the whole batch, set by its LAST slot — the stagger lives purely in CSS
  // (`--cv-exit-delay`). Retiring them one by one instead would shorten the held region while
  // the rest are still in the air, and `atomsToSegments` numbers reconstructed runs by ORDINAL
  // from the start of that region: a run's key would change mid-flight (`vis-run-1` →
  // `vis-run-0`), remounting a live tool section and slamming shut any step row the user had
  // opened. Holding a zero-height node a few extra ms costs nothing.
  const expiresAt = now + EXIT_MS + exitDelayMs(leaving.length - 1);
  // Oldest (topmost) first: slot 0 leaves first, the rest trail behind it.
  leaving.forEach((key, i) => out.push({ key, slot: i, expiresAt }));
  return out;
}

/**
 * Where the RENDERED clear zone starts once the held atoms are added back. They always sit
 * immediately before the cut (they just crossed it), so this walks back from `split` while the
 * atoms are held — the held atoms rejoin the clear zone contiguously and, being re-coalesced by
 * `atomsToSegments`, land back in their own run at their own place.
 */
export function heldVisibleStart(
  atomKeys: readonly string[],
  split: number,
  held: readonly ExitHold[],
): number {
  if (held.length === 0) return split;
  const heldKeys = new Set(held.map((h) => h.key));
  let start = split;
  while (start > 0 && heldKeys.has(atomKeys[start - 1])) start--;
  return start;
}

/** The empty slot map. Exported so callers can hand a NEUTRAL motion down instead of dropping
 *  the prop: a wrapper that appears and disappears changes the element type at a stable key,
 *  which remounts the subtree (and loses every row the user had expanded). */
export const NO_SLOTS: ReadonlyMap<string, number> = new Map();

interface ExitState {
  visible: readonly string[];
  held: readonly ExitHold[];
}

/**
 * Hold the atoms that just left the clear zone so they can animate out.
 *
 * `enabled` is false on a settled response — nothing is moving, so holding anything would only
 * delay the render. It stays TRUE whether the fold is open or closed: an open fold shows the
 * arriving copy growing in as this one shrinks away (the two halves of one movement, which is
 * what keeps the thread's height constant), a closed one simply renders nothing to arrive into.
 *
 * Returns the start index of the clear zone to RENDER (holds included) and the per-atom stagger
 * slot for the ones currently in flight — the SAME slots drive both halves.
 */
export function useWorkExit(
  atomKeys: readonly string[],
  split: number,
  enabled: boolean,
  /** Veto for atoms that do NOT actually leave the clear flow when they cross the cut — a
   *  plan / artifact / question is pulled straight back out of the block and rendered in clear
   *  (see renderFoldedWork), so holding one would show the SAME card twice, at full height,
   *  for the whole flight. Nothing to animate: from the user's side it never left. */
  holdable?: (key: string) => boolean,
): { visStart: number; slots: ReadonlyMap<string, number> } {
  const visibleNow = atomKeys.slice(split);
  const [state, setState] = useState<ExitState>(() => ({ visible: visibleNow, held: [] }));

  if (!enabled) {
    // Stay in sync with the rule while disabled so re-enabling doesn't diff against a stale
    // view and fly out a batch that left long ago.
    if (state.held.length > 0 || !sameKeys(state.visible, visibleNow))
      setState({ visible: visibleNow, held: [] });
  } else if (!sameKeys(state.visible, visibleNow)) {
    setState({
      visible: visibleNow,
      held: computeExits({
        prevVisible: state.visible,
        visibleNow,
        folded: new Set(atomKeys.slice(0, split)),
        held: state.held,
        now: Date.now(),
        holdable,
      }),
    });
  }

  // Release the holds on time. One timer at the earliest deadline; each firing re-renders and
  // re-arms for whatever is left, so a staggered batch retires in order.
  const nextDeadline = state.held.length
    ? Math.min(...state.held.map((h) => h.expiresAt))
    : null;
  useEffect(() => {
    if (nextDeadline == null) return;
    const t = setTimeout(
      () =>
        setState((s) => {
          const now = Date.now();
          const held = s.held.filter((h) => h.expiresAt > now);
          return held.length === s.held.length ? s : { ...s, held };
        }),
      Math.max(0, nextDeadline - Date.now()),
    );
    return () => clearTimeout(t);
  }, [nextDeadline]);

  if (state.held.length === 0) return { visStart: split, slots: NO_SLOTS };
  const slots = new Map<string, number>();
  for (const h of state.held) slots.set(h.key, h.slot);
  return { visStart: heldVisibleStart(atomKeys, split, state.held), slots };
}
