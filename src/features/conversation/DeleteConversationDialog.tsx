// The one dialog both delete surfaces raise — the sidebar row and the Flight Deck card.
//
// Shared so the question reads the same wherever it is asked: the two used to carry
// their own copy of the wording, which is how they drifted once already.
//
// Deliberately terse. A confirmation is read in the second before a click, so it shows the
// two facts that could change the answer — this is running, this carries that task — and
// nothing else. The earlier version spelled out what deleting does NOT touch (the transcript,
// the CRM, ⌘Z); three sentences of reassurance is what turns a dialog into something you
// dismiss without reading, which costs the warnings that matter.

import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { useDisplay } from "../../store/display";
import { useEditorStore } from "../editor/editorStore";
import { useTosseConnection } from "../../ipc/useTosse";
import type { Conversation } from "../../store/conversationsStore";
import { taskStatusTone } from "../tosse/tosseModel";
import type { DeleteReason } from "./deleteGuard";
import s from "./DeleteConversationDialog.module.css";

export function DeleteConversationDialog({
  conv,
  reason,
  onCancel,
  onConfirm,
  onShowConversation,
}: {
  conv: Conversation;
  /** Why we are asking — see `deleteGuard`. Never rendered for a null reason: the
   *  caller keeps the friction-free one-click delete in that case. */
  reason: DeleteReason;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Bring this conversation on screen — the ONE step that genuinely differs between the two
   * surfaces (the sidebar selects the row, the Flight Deck card leaves the deck for the
   * conversation view), so each supplies its own. What happens NEXT is shared and lives
   * here, which is the whole reason this dialog is one component.
   *
   * Omitted where there is nowhere to go: the task then reads as a plain statement rather
   * than as a link that does nothing.
   */
  onShowConversation?: (convId: string) => void;
}) {
  const backend = conv.kind === "codex" ? "Codex" : "Claude";
  const status = conv.tosseTaskStatus;
  // The CRM's own colour for the status, as everywhere else a task status is shown.
  const tone = taskStatusTone(status);

  // Same gate as the header's task chip: reading a task needs a live CRM session, so with
  // no connection the row states the task instead of offering a panel that could only load
  // an error. Cheap — the status query is already mounted and cached app-wide.
  const tabEnabled = useDisplay((d) => d.tosseTasksView);
  const { data: connection } = useTosseConnection(tabEnabled);
  const taskId = conv.tosseTaskId;
  const canOpenTask =
    taskId != null && onShowConversation != null && tabEnabled && connection?.connected === true;

  // Cancel first — going to read the task is deciding NOT to delete right now — then bring
  // the conversation on screen and open its task beside it. Same destination as the chip in
  // the conversation header: the side panel, so the conversation stays visible.
  const openTask = () => {
    onCancel();
    onShowConversation?.(conv.id);
    useEditorStore.getState().openTosseTask({ convId: conv.id, taskId: taskId as string });
  };

  const taskBody = (
    <>
      <TosseCrmMark className={s.mark} />
      <span className={s.title}>{conv.tosseTaskTitle ?? "A TOSSE task"}</span>
      {status ? <span className={`${s.badge} ${s[`b_${tone}`]}`}>{status}</span> : null}
      {canOpenTask ? <Ico name="external" className={`sm ${s.go}`} /> : null}
    </>
  );

  return (
    <ConfirmDialog
      open
      danger
      size="lg"
      title={`Delete "${conv.name}"?`}
      confirmLabel="Delete anyway"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {reason !== "linkedTask" ? (
        <div className={s.line}>Running — this stops the {backend} session.</div>
      ) : null}
      {/* The task as a SNIPPET, not a sentence: its title and the status badge are the whole
          reason to hesitate, and they read faster as a row than as prose. */}
      {reason !== "running" ? (
        canOpenTask ? (
          <button
            type="button"
            className={`${s.task} ${s.clickable}`}
            title="Open this task in the side panel"
            onClick={openTask}
          >
            {taskBody}
          </button>
        ) : (
          <div className={s.task}>{taskBody}</div>
        )
      ) : null}
    </ConfirmDialog>
  );
}
