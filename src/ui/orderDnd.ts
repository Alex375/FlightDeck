// Drag-and-drop reordering shared by the conversation sidebar and the Flight Deck.
// Both surfaces reorder the SAME two levels — repos (groups / swimlanes) and the
// conversations within a repo — so the drop math, the manual-vs-recency decision and
// the collision scoping live here once. The surfaces only differ in how they render
// (a vertical list vs. swimlanes + a horizontally-scrolling card grid).
//
// Manual mode (the level's "auto reorder" toggle is OFF): a drop PERSISTS the new
// arrangement (manualOrder store) so it survives quit/relaunch.
// Recency mode (toggle ON): a drop is EPHEMERAL — held in local state and dropped the
// moment the automatic order recomputes (the next activity/status event), matching the
// "reorder as you like, but the next change re-sorts" behaviour.
import { useCallback, useEffect, useState } from "react";
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useDisplay } from "../store/display";
import { useManualOrder, slotFor, type OrderSurface } from "../store/manualOrder";
import type { RepoGroup } from "../store/conversationsStore";

export type DragKind = "repo" | "conv";
/** Attached to every sortable via `useSortable({ data })`, so `onDragEnd` and the
 *  collision filter know what is being dragged and (for a conversation) its repo. */
export interface DragData {
  kind: DragKind;
  repoId?: string;
}
export interface ActiveDrag {
  kind: DragKind;
  id: string;
  repoId?: string;
}

// The WHOLE row/card is the drag surface (no grip handle), so a reorder ends with the
// pointer over an interactive child — and, unlike native HTML5 drag, a pointer-based
// drag does NOT suppress the trailing `click`. Without a guard, dropping a card would
// also fire its click (open the conversation) and dropping onto a button would trigger
// it. This module-level latch (only one drag happens at a time) swallows that ONE click.
let justDragged = false;
let disarmTimer: ReturnType<typeof setTimeout> | null = null;
function armReorderGuard() {
  justDragged = true;
  if (disarmTimer) {
    clearTimeout(disarmTimer);
    disarmTimer = null;
  }
}
function disarmReorderGuardSoon() {
  // The trailing click fires synchronously right after pointerup; a macrotask reset runs
  // AFTER it, so the guard is still armed when that click arrives, then clears itself.
  if (disarmTimer) clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => {
    justDragged = false;
    disarmTimer = null;
  }, 0);
}

/** onClickCapture handler for every draggable row/card: swallows the single click that
 *  the browser fires right after a real drag (so a reorder never also selects / opens /
 *  deletes). A no-op for ordinary clicks (no drag happened). */
export function guardReorderClick(e: { preventDefault(): void; stopPropagation(): void }): void {
  if (justDragged) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Reorder the repo groups to match `repoIds`; any group not named is appended as-is. */
export function reorderRepos(groups: RepoGroup[], repoIds: string[]): RepoGroup[] {
  const byId = new Map(groups.map((g) => [g.repo.id, g] as const));
  const out: RepoGroup[] = [];
  for (const id of repoIds) {
    const g = byId.get(id);
    if (g) {
      out.push(g);
      byId.delete(id);
    }
  }
  for (const g of groups) if (byId.has(g.repo.id)) out.push(g);
  return out;
}

/** Reorder one repo's conversations to match `convIds`; leftovers appended as-is. */
export function reorderConvs(groups: RepoGroup[], repoId: string, convIds: string[]): RepoGroup[] {
  return groups.map((g) => {
    if (g.repo.id !== repoId) return g;
    const byId = new Map(g.conversations.map((c) => [c.id, c] as const));
    const convs: RepoGroup["conversations"] = [];
    for (const id of convIds) {
      const c = byId.get(id);
      if (c) {
        convs.push(c);
        byId.delete(id);
      }
    }
    for (const c of g.conversations) if (byId.has(c.id)) convs.push(c);
    return { ...g, conversations: convs };
  });
}

/**
 * Collision detection that keeps a drag on its own axis: a repo drag only ever
 * targets other repos, and a conversation drag only targets conversations IN THE SAME
 * repo — so a card never visually jumps into another swimlane, and cross-repo drops
 * are impossible (a conversation stays in its repo). Falls back to unfiltered
 * `closestCenter` if the active drag carries no `kind`.
 */
export const orderCollisionDetection: CollisionDetection = (args) => {
  const ad = args.active.data.current as DragData | undefined;
  if (!ad?.kind) return closestCenter(args);
  const droppableContainers = args.droppableContainers.filter((c) => {
    const d = c.data.current as DragData | undefined;
    if (ad.kind === "repo") return d?.kind === "repo";
    return d?.kind === "conv" && d?.repoId === ad.repoId;
  });
  return closestCenter({ ...args, droppableContainers });
};

/**
 * DnD wiring for one surface. Returns the groups to RENDER (`displayGroups` — the
 * automatic order, or an ephemeral recency-mode override), the sensors, and the
 * DndContext handlers. The caller wraps its list in a `DndContext` fed by these, with
 * a `SortableContext` per level.
 */
export function useSurfaceOrderDnd(surface: OrderSurface, groups: RepoGroup[]) {
  const autoConvs = useDisplay((s) =>
    surface === "sidebar" ? s.autoOrderSidebarConvs : s.autoOrderFleetConvs,
  );
  const autoRepos = useDisplay((s) =>
    surface === "sidebar" ? s.autoOrderSidebarRepos : s.autoOrderFleetRepos,
  );
  const shared = useDisplay((s) => s.sharedManualOrder);
  const slot = slotFor(surface, shared);
  const setRepoOrder = useManualOrder((s) => s.setRepoOrder);
  const setConvOrder = useManualOrder((s) => s.setConvOrder);

  // The recency-mode drag override. Cleared whenever the automatic `groups` recompute
  // (i.e. the next activity/status event), so the drag "holds until the next change".
  const [ephemeral, setEphemeral] = useState<RepoGroup[] | null>(null);
  const [active, setActive] = useState<ActiveDrag | null>(null);
  useEffect(() => {
    setEphemeral(null);
  }, [groups]);

  const displayGroups = ephemeral ?? groups;

  const sensors = useSensors(
    // A small activation distance so a plain click (open / select / a card button) is
    // never swallowed by the drag sensor — only a deliberate move starts a reorder.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = useCallback((e: DragStartEvent) => {
    armReorderGuard();
    const d = e.active.data.current as DragData | undefined;
    if (d?.kind) setActive({ kind: d.kind, id: String(e.active.id), repoId: d.repoId });
  }, []);

  const onDragCancel = useCallback(() => {
    setActive(null);
    disarmReorderGuardSoon();
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActive(null);
      disarmReorderGuardSoon();
      const { active: a, over } = e;
      if (!over || a.id === over.id) return;
      const ad = a.data.current as DragData | undefined;
      const od = over.data.current as DragData | undefined;
      if (ad?.kind === "repo" && od?.kind === "repo") {
        const ids = displayGroups.map((g) => g.repo.id);
        const from = ids.indexOf(String(a.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return;
        const next = arrayMove(ids, from, to);
        if (autoRepos) setEphemeral(reorderRepos(displayGroups, next));
        else setRepoOrder(slot, next);
      } else if (ad?.kind === "conv" && od?.kind === "conv" && ad.repoId && ad.repoId === od.repoId) {
        const group = displayGroups.find((g) => g.repo.id === ad.repoId);
        if (!group) return;
        const ids = group.conversations.map((c) => c.id);
        const from = ids.indexOf(String(a.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return;
        const next = arrayMove(ids, from, to);
        if (autoConvs) setEphemeral(reorderConvs(displayGroups, ad.repoId, next));
        else setConvOrder(slot, ad.repoId, next);
      }
    },
    [displayGroups, autoRepos, autoConvs, slot, setRepoOrder, setConvOrder],
  );

  return { displayGroups, sensors, onDragStart, onDragEnd, onDragCancel, active };
}
