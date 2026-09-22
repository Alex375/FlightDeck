// The conversation side panel: the far-right column that holds the conversation's STATE — the
// TOSSE task it carries, its active `/goal`, the agent's todo list, the artifacts it published,
// and (as a footer) its session: the stream and the worktree. It exists so the header can carry
// actions only.
//
// Every section renders from the same sources as the surfaces it replaced (the header chips,
// the composer's goal/artifact chips, the todo bar), so nothing is re-derived here. A section
// with nothing to show is absent rather than empty; the empty hint covers "nothing at all".
//
// Only mounted while the `conversationSidePanel` display pref is on — see ConductorConversation.

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Dot, Ico, TosseCrmMark } from "../../ui/kit";
import { CONVERSATION_PANEL_CHORD } from "../../ui/shortcuts";
import {
  useSetTosseTaskAssignee,
  useSetTosseTaskStatus,
  useTosseAvailable,
  useTosseTaskDetail,
} from "../../ipc/useTosse";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useActiveGoal } from "../../store/goalStore";
import { useSessionState, useTodos, useTodoSummary } from "../../store/conversationStore";
import { useConversationRepo, type Conversation } from "../../store/conversationsStore";
import { useEditorStore } from "../editor/editorStore";
import {
  effectiveCwd,
  isLinked,
  mainWorktree,
  resolveWorktree,
  worktreeName,
} from "../git/worktree";
import { useWorktreeUi } from "../git/worktreeUiStore";
import { liveBlockers } from "../tosse/tosseModel";
import { TaskStatusActions, TaskStatusChip, TaskSubtaskRows } from "../tosse/TosseView";
import { AssigneePicker } from "../tosse/AssigneePicker";
import { TodoList } from "../todos/TodoList";
import { useArtifacts, type Artifact } from "./artifacts";
import { artifactKind, openArtifactView } from "./artifactOpen";
import { useClearGoalAction } from "./GoalPopover";
import { useStreamActions } from "./StreamControl";
import s from "./ConversationSidePanel.module.css";

export function ConversationSidePanel({ conv }: { conv: Conversation }) {
  const closePanel = useEditorStore((st) => st.setConvPanelOpen);
  const tosseAvailable = useTosseAvailable();
  const goal = useActiveGoal(conv.id);
  const todos = useTodos(conv.id);
  const artifacts = useArtifacts(conv.id);

  // Same gate as the header chip it replaces: a linked task only shows while TOSSE exists.
  const showTask = tosseAvailable && !!conv.tosseTaskId && !!conv.tosseTaskTitle;
  const empty = !showTask && !goal && todos.length === 0 && artifacts.length === 0;

  return (
    <aside className={s.panel} aria-label="Conversation panel">
      <div className={s.head}>
        <span className={s.headTab}>Conversation</span>
        {/* A standing reminder, not a tooltip: the panel is opened and closed all the time,
            and the chord is only worth having if it is known. */}
        <kbd className={s.kbd} title="Open / close this panel">
          {CONVERSATION_PANEL_CHORD}
        </kbd>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => closePanel(false)}
          title={`Close the conversation panel (${CONVERSATION_PANEL_CHORD})`}
          aria-label="Close the conversation panel"
        >
          <Ico name="x" className="sm" />
        </button>
      </div>

      <div className={s.body}>
        {showTask ? <TaskSection conv={conv} /> : null}
        {goal ? (
          <GoalSection convId={conv.id} condition={goal.condition} reason={goal.reason} />
        ) : null}
        {todos.length > 0 ? <TodoSection convId={conv.id} /> : null}
        {artifacts.length > 0 ? <ArtifactsSection convId={conv.id} artifacts={artifacts} /> : null}
        {empty ? (
          <p className={s.empty}>
            Nothing to track yet. This conversation's TOSSE task, goal, todo list and artifacts
            show up here as they appear.
          </p>
        ) : null}
      </div>

      {/* Pinned below the scrolling sections: the stream's controls stay one click away. */}
      <SessionFooter conv={conv} />
    </aside>
  );
}

/**
 * The TOSSE task this conversation carries — often the only thing in the panel, so it is a
 * real card, kept to what you act on: project, title, the status (a menu) and the assignee
 * (the CRM's avatar picker), the one-line notes, blockers, the subtasks (a collapsible list
 * you can tick) and the CRM's status ladder (« Mark in progress », « Mark as Done »,
 * « Approve & Done »…). The status chip, the subtask rows and the ladder are the TOSSE view's
 * own components writing through the same mutations — one way to move a task, wherever you
 * are. Clicking the card opens the full task in the side region.
 *
 * The full task comes from the CRM; until it arrives (or if it cannot), the card falls back
 * to the title and status denormalised on the conversation — legible offline, as the header
 * chip was — and says why it has nothing more.
 */
function TaskSection({ conv }: { conv: Conversation }) {
  const taskId = conv.tosseTaskId!;
  const openTosseTask = useEditorStore((st) => st.openTosseTask);
  const { data: detail, error: loadError, dataUpdatedAt } = useTosseTaskDetail(taskId);
  const setStatus = useSetTosseTaskStatus();
  const setAssignee = useSetTosseTaskAssignee();
  const [subtasksOpen, setSubtasksOpen] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const open = () => openTosseTask({ convId: conv.id, taskId });

  // Show a value being written right away, and KEEP showing it until this task's detail has
  // been re-read: the writes patch the board caches (or nothing), not the detail query — only
  // refetched once they settle — so dropping the override on success would flash the old
  // value back for the length of that refetch.
  const unsettled = (m: { isPending: boolean; isSuccess: boolean; submittedAt: number }) =>
    m.isPending || (m.isSuccess && dataUpdatedAt < m.submittedAt);
  const statusWrite = setStatus.variables && unsettled(setStatus) ? setStatus.variables : null;
  const assigneeWrite =
    setAssignee.variables && unsettled(setAssignee) ? setAssignee.variables.assignedTo : null;

  const writeStatus = (status: string) => setStatus.mutate({ taskId, status });
  // The status mutation also ticks SUBTASKS (their own ids), so the override is split by id.
  const status =
    (statusWrite?.taskId === taskId ? statusWrite.status : null) ??
    detail?.task.status ??
    conv.tosseTaskStatus;
  const task = detail && status ? { ...detail.task, status } : null;
  const subtasks = (detail?.subtasks ?? []).map((st) =>
    statusWrite && statusWrite.taskId === st.id ? { ...st, status: statusWrite.status } : st,
  );
  const subtasksDone = subtasks.filter((st) => st.status === "Fait").length;
  const blockers = detail ? liveBlockers(detail.blockedBy).length : 0;
  const writeError = setStatus.error ?? setAssignee.error;

  // A click on the card's background opens the task. Controls inside it keep their own job,
  // and a portalled menu's clicks bubble through the REACT tree to here without being inside
  // the card's DOM — neither must open the task.
  const onCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!cardRef.current?.contains(target)) return;
    if (target.closest("button, a, input, [role='menuitem']")) return;
    open();
  };

  return (
    <section className={s.section}>
      <div className={s.label}>
        <TosseCrmMark className={s.tosseMark} />
        TOSSE task
        <button
          type="button"
          className={s.textBtn}
          onClick={open}
          title="Read the task in the side region"
        >
          Open
        </button>
      </div>
      <div ref={cardRef} className={`${s.card} ${s.taskCard}`} onClick={onCardClick}>
        {detail?.projectName ? <div className={s.taskKicker}>{detail.projectName}</div> : null}
        <button type="button" className={s.taskTitle} onClick={open} title="Open the task">
          {task?.title ?? conv.tosseTaskTitle}
        </button>
        {status ? (
          <div className={s.taskRow}>
            <TaskStatusChip status={status} onSetStatus={writeStatus} />
            <span className={s.taskRowGap} />
            {/* The assignee only once the task is read: there is no denormalised copy to
                show before that, and a picker must never offer to "change" an unknown value. */}
            {task ? (
              <AssigneePicker
                value={assigneeWrite ?? task.assignedTo}
                onChange={(assignedTo) => setAssignee.mutate({ taskId, assignedTo })}
                disabled={setAssignee.isPending}
              />
            ) : null}
          </div>
        ) : null}

        {task?.notes ? <div className={s.taskNotes}>{task.notes}</div> : null}
        {blockers > 0 ? (
          <div className={s.taskBlocked}>
            Blocked by {blockers} task{blockers === 1 ? "" : "s"}
          </div>
        ) : null}

        {subtasks.length > 0 ? (
          <div className={s.subtasks}>
            <button
              type="button"
              className={s.subtasksHead}
              onClick={() => setSubtasksOpen((o) => !o)}
              aria-expanded={subtasksOpen}
            >
              <Ico name="chev" className={`sm ${s.subtasksChev}`} />
              {subtasksOpen ? "Hide subtasks" : "Show subtasks"}
              <span className={`${s.subtasksCount} wf-mono`}>
                {subtasksDone}/{subtasks.length}
              </span>
            </button>
            {subtasksOpen ? (
              <div className={s.subtasksList}>
                <TaskSubtaskRows
                  subtasks={subtasks}
                  onToggle={(subtaskId, next) => setStatus.mutate({ taskId: subtaskId, status: next })}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {loadError && !detail ? (
          <div className={s.taskError}>Couldn't load the task: {String(loadError.message)}</div>
        ) : null}
        {/* The WRITE's refusal, not only the read's — a rejected change must not look like an
            accepted one. */}
        {writeError ? <div className={s.taskError}>{String(writeError.message)}</div> : null}
        {detail && task ? (
          <div className={s.taskActs}>
            <TaskStatusActions detail={{ ...detail, task }} onWrite={writeStatus} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function GoalSection({
  convId,
  condition,
  reason,
}: {
  convId: string;
  condition: string;
  reason: string | null;
}) {
  const clear = useClearGoalAction(convId);
  return (
    <section className={s.section}>
      <div className={s.label}>
        <Ico name="target" className={`sm ${s.goalIco}`} />
        Goal
        {/* An active goal is by definition not achieved yet (the CLI clears it once met);
            what we can say is whether the evaluator has looked at it. */}
        <span className={`${s.pill} ${s.pillAtt}`}>{reason ? "Not met" : "Not checked yet"}</span>
        <button type="button" className={s.textBtn} onClick={clear} title="Clear the goal">
          Clear
        </button>
      </div>
      <div className={s.goalCond}>{condition}</div>
      {reason ? <div className={s.goalReason}>{reason}</div> : null}
    </section>
  );
}

function TodoSection({ convId }: { convId: string }) {
  const todos = useTodos(convId);
  const summary = useTodoSummary(convId);
  const pct = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;
  return (
    <section className={s.section}>
      <div className={s.label}>
        <Ico name="list" className="sm" />
        Todo
        <span className={`${s.meta} wf-mono`}>
          {summary.completed}/{summary.total}
        </span>
      </div>
      <div
        className={s.progress}
        role="progressbar"
        aria-label="Todo progress"
        aria-valuemin={0}
        aria-valuemax={summary.total}
        aria-valuenow={summary.completed}
      >
        <div className={s.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={s.todos}>
        <TodoList todos={todos} />
      </div>
    </section>
  );
}

function ArtifactsSection({ convId, artifacts }: { convId: string; artifacts: Artifact[] }) {
  return (
    <section className={s.section}>
      <div className={s.label}>
        <Ico name="artifact" className="sm" />
        Artifacts
        <span className={`${s.meta} wf-mono`}>{artifacts.length}</span>
      </div>
      <div className={s.artifacts}>
        {artifacts
          .slice()
          .reverse()
          .map((a) => (
            <ArtifactCard key={a.url ?? a.latestFilePath} convId={convId} art={a} />
          ))}
      </div>
    </section>
  );
}

/** One published artifact: favicon tile, title, kind + version count. Opens like every other
 *  artifact surface (in-app viewer when the local file is still there, else the hosted page). */
function ArtifactCard({ convId, art }: { convId: string; art: Artifact }) {
  const kind = artifactKind(art.latestFilePath) === "md" ? "Markdown" : "HTML";
  const versions = art.versions.length;
  const open = () =>
    openArtifactView({
      convId,
      title: art.title,
      favicon: art.favicon,
      url: art.url,
      filePath: art.latestFilePath,
    });
  return (
    <button
      type="button"
      className={s.artCard}
      onClick={open}
      title={art.url ? "Open in Flight Deck" : "Not published yet"}
    >
      <span className={s.artTile} aria-hidden="true">
        {art.favicon ? art.favicon : <Ico name="artifact" className="sm" />}
      </span>
      <span className={s.artMain}>
        <span className={s.artTitle}>{art.title}</span>
        <span className={s.artSub}>
          {kind} · v{versions}
          {art.url ? "" : " · publishing…"}
        </span>
      </span>
      <Ico name="external" className={`sm ${s.artGo}`} />
    </button>
  );
}

/** The session footer: the stream (state + turn on / restart / turn off) and the worktree the
 *  conversation works in right now (+ the manager). What the header used to show as chips. */
function SessionFooter({ conv }: { conv: Conversation }) {
  return (
    <div className={s.foot}>
      <StreamRow conv={conv} />
      <WorktreeRow conv={conv} />
    </div>
  );
}

function StreamRow({ conv }: { conv: Conversation }) {
  const { status, live, pending, error, start, restart, stop } = useStreamActions(conv);
  const title = error ? "Stream failed" : live ? "Stream on" : "Stream off";
  // Lazy policy: an off stream is the normal resting state — it spawns on the next message.
  const sub = error ?? (live ? "Session running" : "Starts with your next message");
  return (
    <div className={s.row} title={error ? `Failed: ${error}` : undefined}>
      <span className={s.rowIco}>
        <Dot s={status} pulse />
      </span>
      <span className={s.rowMain}>
        <span className={s.rowTitle}>{title}</span>
        <span className={`${s.rowSub} ${error ? s.rowSubErr : ""}`}>{sub}</span>
      </span>
      <span className={s.rowActs}>
        {live ? (
          <>
            <button
              type="button"
              className={s.rowBtn}
              disabled={pending}
              onClick={restart}
              title="Restart the stream"
              aria-label="Restart the stream"
            >
              <Ico name="restart" className="sm" />
            </button>
            <button
              type="button"
              className={s.rowBtn}
              disabled={pending}
              onClick={stop}
              title="Turn the stream off"
              aria-label="Turn the stream off"
            >
              <Ico name="power" className="sm" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className={s.rowBtn}
            disabled={pending}
            onClick={start}
            title="Turn the stream on (without sending anything)"
            aria-label="Turn the stream on"
          >
            <Ico name="play" className="sm" />
          </button>
        )}
      </span>
    </div>
  );
}

/** The worktree the conversation is in RIGHT NOW (follows EnterWorktree/ExitWorktree via the
 *  live cwd), accented when it is a linked worktree. Absent outside a git repository. */
function WorktreeRow({ conv }: { conv: Conversation }) {
  const repo = useConversationRepo(conv.id);
  const { data: worktrees } = useWorktrees(repo?.path ?? null);
  const state = useSessionState(conv.id);
  const openManager = useWorktreeUi((st) => st.openManager);
  if (!repo || !worktrees || worktrees.length === 0) return null;

  const wt = resolveWorktree(effectiveCwd(conv, state), worktrees) ?? mainWorktree(worktrees);
  if (!wt) return null;
  const linked = isLinked(wt);
  const name = wt.branch ?? worktreeName(wt);
  const root = repo.path.replace(/\/+$/, "");
  const where = !linked
    ? "Main working tree"
    : wt.path.startsWith(`${root}/`)
      ? wt.path.slice(root.length + 1)
      : wt.path;
  return (
    <div className={s.row} title={wt.path}>
      <span className={`${s.rowIco} ${linked ? s.linked : ""}`}>
        <Ico name="branch" className="sm" />
      </span>
      <span className={s.rowMain}>
        <span className={`${s.rowTitle} ${s.mono} ${linked ? s.linked : ""}`}>{name}</span>
        <span className={s.rowSub}>{where}</span>
      </span>
      <span className={s.rowActs}>
        <button type="button" className={s.smallBtn} onClick={() => openManager(conv.repoId)}>
          Manage
        </button>
      </span>
    </div>
  );
}
