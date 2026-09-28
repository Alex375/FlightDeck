// The one-line stand-in for the conversation side panel while it is CLOSED: the active goal
// and the todo progress, pinned above the composer so closing the panel never hides what the
// agent is working toward. One click opens the panel. Renders nothing when there is neither.
//
// Each part stands in only for a panel widget that is ON: a widget switched off has given its
// state its old home back (the composer's goal chip, the todo bar), so repeating it here would
// show it twice.

import { Ico } from "../../ui/kit";
import { CONVERSATION_PANEL_CHORD } from "../../ui/shortcuts";
import { useActiveGoal } from "../../store/goalStore";
import { useTodoSummary } from "../../store/conversationStore";
import { useEditorStore } from "../editor/editorStore";
import s from "./ConversationSummaryLine.module.css";

export function ConversationSummaryLine({
  session,
  showGoal = true,
  showTodos = true,
}: {
  session: string;
  /** The panel's goal widget is on — the goal lives in the panel, so it stands in for it here. */
  showGoal?: boolean;
  /** The panel's todo widget is on — same for the todo progress. */
  showTodos?: boolean;
}) {
  const activeGoal = useActiveGoal(session);
  const todoSummary = useTodoSummary(session);
  const openPanel = useEditorStore((st) => st.setConvPanelOpen);
  const goal = showGoal ? activeGoal : null;
  const todo = showTodos ? todoSummary : { ...todoSummary, total: 0 };

  if (!goal && todo.total === 0) return null;
  const pct = todo.total > 0 ? Math.round((todo.completed / todo.total) * 100) : 0;

  return (
    <button
      type="button"
      className={s.line}
      onClick={() => openPanel(true)}
      title={`Open the conversation panel (${CONVERSATION_PANEL_CHORD})`}
    >
      {goal ? (
        <span className={s.part} title={goal.condition}>
          <Ico name="target" className={`sm ${s.goalIco}`} />
          Goal
        </span>
      ) : null}
      {goal && todo.total > 0 ? <span className={s.sep} aria-hidden="true" /> : null}
      {todo.total > 0 ? (
        <span className={`${s.part} ${s.grow}`}>
          <Ico name="list" className="sm" />
          Todo
          <span className={`${s.count} wf-mono`}>
            {todo.completed}/{todo.total}
          </span>
          <span className={s.bar} aria-hidden="true">
            <span className={s.barFill} style={{ width: `${pct}%` }} />
          </span>
          {todo.current ? <span className={s.current}>{todo.current.content}</span> : null}
        </span>
      ) : null}
      {/* The same standing reminder as the open panel's header. */}
      <kbd className={s.kbd}>{CONVERSATION_PANEL_CHORD}</kbd>
    </button>
  );
}
