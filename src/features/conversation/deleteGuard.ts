// Whether deleting a conversation should ask first — and what to say.
//
// Deleting is friction-free by design (one click, ⌘Z undoes it) precisely BECAUSE the
// on-disk transcript is never touched. Two things are not undoable that way, and each
// earns a question:
//   - a live run, which the delete kills;
//   - a conversation that carries a TOSSE task someone is counting on.
//
// Pure, and shared by both delete surfaces (the sidebar row and the Flight Deck card),
// so the two can never disagree about when a conversation is safe to drop.

import type { Conversation } from "../../store/conversationsStore";

/**
 * The TOSSE statuses that make a linked conversation worth a question.
 *
 * "En cours" and "Review" are the two states where a task is LIVE — being worked on, or
 * waiting to be read. A task in « À faire », « Backlog » or « Fait » is not: deleting its
 * conversation loses nothing anyone is waiting on, and asking there would train the user
 * to click through the dialog without reading it.
 */
export const ACTIVE_TASK_STATUSES = ["En cours", "Review"];

/** Why the delete is asking. `both` when a live run AND a live task coincide — one
 *  dialog that states both, never two questions in a row. */
export type DeleteReason = "running" | "linkedTask" | "both";

export interface DeleteGuardInput {
  /** A turn is in flight or background work is still running. */
  busy: boolean;
  /** The conversation's linked-task status, as last known. Null when unlinked. */
  taskStatus: string | null;
  /** The user's preference — off means a linked task never asks (a live run still does). */
  warnOnLinkedTask: boolean;
}

/**
 * Whether to confirm, and why. `null` keeps the one-click delete.
 *
 * ⚠️ The task side reads the DENORMALISED status stored on the conversation, not the
 * CRM. That is the point of storing it: the warning has to work with no network, which
 * is exactly when a stale board would otherwise make it silently stop warning.
 */
export function deleteReason(input: DeleteGuardInput): DeleteReason | null {
  const linked =
    input.warnOnLinkedTask &&
    input.taskStatus != null &&
    ACTIVE_TASK_STATUSES.includes(input.taskStatus);
  if (input.busy && linked) return "both";
  if (input.busy) return "running";
  if (linked) return "linkedTask";
  return null;
}

/** The same question, asked from a conversation. Convenience over {@link deleteReason}. */
export function deleteReasonFor(
  conv: Conversation,
  busy: boolean,
  warnOnLinkedTask: boolean,
): DeleteReason | null {
  return deleteReason({ busy, taskStatus: conv.tosseTaskStatus, warnOnLinkedTask });
}
