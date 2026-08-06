// The one dialog both delete surfaces raise — the sidebar row and the Flight Deck card.
//
// Shared so the question reads the same wherever it is asked: the two used to carry
// their own copy of the wording, which is how they drifted once already.

import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { Conversation } from "../../store/conversationsStore";
import type { DeleteReason } from "./deleteGuard";

export function DeleteConversationDialog({
  conv,
  reason,
  onCancel,
  onConfirm,
}: {
  conv: Conversation;
  /** Why we are asking — see `deleteGuard`. Never rendered for a null reason: the
   *  caller keeps the friction-free one-click delete in that case. */
  reason: DeleteReason;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const backend = conv.kind === "codex" ? "Codex" : "Claude";
  const task = conv.tosseTaskTitle ?? "a TOSSE task";
  const status = conv.tosseTaskStatus;
  return (
    <ConfirmDialog
      open
      danger
      title={`Delete "${conv.name}"?`}
      confirmLabel="Delete anyway"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {reason !== "linkedTask" ? (
        <>
          This conversation is <strong>running</strong>. Deleting it will{" "}
          <strong>stop the {backend} session</strong> and unfinished work may be lost. The
          conversation can still be recovered with ⌘Z, but not the interrupted run.
        </>
      ) : null}
      {reason === "both" ? " " : null}
      {reason !== "running" ? (
        <>
          {/* Says what is NOT touched, too: nothing here writes to the CRM, and without
              that sentence the dialog reads like "this will close your task". */}
          {reason === "both" ? "It is also the conversation" : "This is the conversation"}{" "}
          opened on <strong>{task}</strong>
          {status ? ` (${status})` : ""}. The task stays exactly as it is in TOSSE — only
          this conversation goes, and the link with it.
        </>
      ) : null}
    </ConfirmDialog>
  );
}
