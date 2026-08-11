// Which linked tasks the app has to go and ASK about, one by one.
//
// A conversation keeps a denormalised copy of its task's title and status, and that copy is
// what the delete warning reads (see `deleteGuard`). It is re-stamped from the briefing —
// but the briefing answers "what am I working on", so it structurally OMITS a task the
// moment it is finished, parked or backlogged (`STATUSES_OFF_THE_BOARD`), and
// `refreshLinkedTaskMeta` deliberately leaves an absent task ALONE rather than erasing the
// link. The two rules compose into a trap: a task that moves to « Fait » is never mentioned
// again, so its conversation keeps « En cours » / « Review » for ever and the delete dialog
// keeps asking about work that is long done.
//
// The fix is not to trust absence — it is to resolve the CONTRADICTION. A task we believe is
// live, that the board of live tasks did not list, is exactly the case worth one targeted
// request. Pure, so the arithmetic of "who do we ask about" is tested without a network.

import type { TosseBriefing } from "../../ipc/client";
import { ACTIVE_TASK_STATUSES } from "../conversation/deleteGuard";

/** A conversation's link, reduced to what this decision needs. */
export interface LinkedTaskRef {
  taskId: string;
  /** Last known status, as stored on the conversation. Null when never stamped. */
  status: string | null;
}

/**
 * Every task id the briefing actually carried, or `null` when there is no briefing yet.
 *
 * ⚠️ `null` means "we have not looked", NOT "the board is empty" — the same distinction
 * `resolve_links` makes on the Rust side. Reconciling against a payload we never received
 * would fire a request for every linked conversation on the first render, before the one
 * cheap bulk answer had a chance to arrive.
 */
export function briefingTaskIds(briefing: TosseBriefing | undefined): Set<string> | null {
  if (!briefing) return null;
  return new Set([
    ...briefing.projects.flatMap((p) => p.tasks.map((t) => t.id)),
    ...briefing.generalTasks.map((t) => t.id),
  ]);
}

/**
 * The task ids to re-read one by one: linked, still BELIEVED live, and absent from the board
 * of live tasks.
 *
 * Scoped to {@link ACTIVE_TASK_STATUSES} on purpose — those are the statuses that make the
 * delete dialog appear, so they are the only ones whose staleness has a consequence. It also
 * makes the set self-limiting: the request that discovers « Fait » removes that id from the
 * set for good, instead of leaving a poll running for the life of the app.
 *
 * A status the briefing DOES carry needs nothing: the bulk refresh already re-stamped it.
 */
export function tasksToReconcile(
  linked: LinkedTaskRef[],
  onBoard: Set<string> | null,
): string[] {
  if (onBoard === null) return [];
  const ids = new Set<string>();
  for (const { taskId, status } of linked) {
    if (status == null || !ACTIVE_TASK_STATUSES.includes(status)) continue;
    if (onBoard.has(taskId)) continue;
    ids.add(taskId); // several conversations can share one task — ask once.
  }
  return [...ids];
}
