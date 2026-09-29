// The conversation side panel: the far-right column that holds the conversation's STATE — the
// TOSSE task it carries, its active `/goal`, the agent's todo list, the artifacts it published,
// what it costs and where it runs — and, pinned at the bottom, its session: the stream, the
// worktree, the machine. It exists so the header can carry actions only.
//
// It is a stack of WIDGETS the user chooses, orders and folds (the header's « Customize »): the
// catalogue and its rules are `sidePanelWidgets.ts`, the arrangement `sidePanelWidgetsStore.ts`.
// A widget switched OFF is not rendered at all — its hooks never run, hidden costs nothing. A
// widget switched ON renders only when it has something to show; the empty hint covers "nothing
// at all".
//
// Every section renders from the same sources as the surfaces it replaced (the header chips,
// the composer's goal/artifact chips, the todo bar), so nothing is re-derived here — and a
// widget switched off here gives its old surface back (see App, ConversationPane, the composer).
//
// Only mounted while the `conversationSidePanel` display pref is on — see ConductorConversation.
// Its HEIGHT is driven from there too: full height, or fitted to its content (useFitHeight),
// which is why it exposes its chrome/scroller/sections as `refs`.

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Dot, Ico, TosseCrmMark } from "../../ui/kit";
import { CONVERSATION_PANEL_CHORD } from "../../ui/shortcuts";
import {
  useSetTosseTaskAssignee,
  useSetTosseTaskStatus,
  useTosseAvailable,
  useTosseTaskDetail,
} from "../../ipc/useTosse";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useContextData } from "../../store/contextData";
import { useActiveGoal } from "../../store/goalStore";
import { useSessionState, useTodos, useTodoSummary } from "../../store/conversationStore";
import { useConversationRepo, type Conversation } from "../../store/conversationsStore";
import { useSidePanelLayout } from "../../store/sidePanelWidgetsStore";
import { useDisplay } from "../../store/display";
import { motionAllowed } from "../../ui/motion";
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
import { ContextUsageMenu } from "./ContextUsageMenu";
import { TelemetryDeck, TelemetryDeckFolded } from "./TelemetryDeck";
import { ArtifactFace } from "./artifactIcon";
import { artifactKind, openArtifactView } from "./artifactOpen";
import { openConversationAt } from "../../store/threadJump";
import { useClearGoalAction } from "./GoalPopover";
import { useStreamActions } from "./StreamControl";
import type { FitRefs } from "./useFitHeight";
import { PanelSection } from "./PanelSection";
import { PanelCustomize } from "./PanelCustomize";
import { isCollapsed, type WidgetId } from "./sidePanelWidgets";
import { GitStatusWidget } from "./widgets/GitStatusWidget";
import { LinkedConversationsWidget } from "./widgets/LinkedConversationsWidget";
import { MachineRow } from "./widgets/MachineRow";
import { PlanUsageWidget } from "./widgets/PlanUsageWidget";
import { StatsWidget } from "./widgets/StatsWidget";
import s from "./ConversationSidePanel.module.css";

export function ConversationSidePanel({ conv, refs }: { conv: Conversation; refs?: FitRefs }) {
  const closePanel = useEditorStore((st) => st.setConvPanelOpen);
  const layout = useSidePanelLayout((st) => st.layout);
  const customizing = useSidePanelLayout((st) => st.customizing);
  const setCustomizing = useSidePanelLayout((st) => st.setCustomizing);
  const main = layout.main.filter((e) => e.on);
  const foot = layout.foot.filter((e) => e.on);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));

  // Leaving the customize view brings the widgets back with the same rise the view came in with
  // — one gesture, one movement each way. Flagged on the edge during render, so the stack's
  // first frame already carries it; cleared when its animation ends.
  const [returning, setReturning] = useState(false);
  const [wasCustomizing, setWasCustomizing] = useState(customizing);
  if (wasCustomizing !== customizing) {
    setWasCustomizing(customizing);
    setReturning(!customizing);
  }
  // Either view starts at its top: a scroll position is the other view's, and would open the
  // customize list halfway down. The scroller is also what the fit-content mode measures, so
  // it takes the caller's ref when there is one (one element, one ref).
  const ownBodyRef = useRef<HTMLDivElement>(null);
  const bodyRef = refs?.body ?? ownBodyRef;
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [customizing]);

  return (
    <aside
      ref={refs?.panel}
      className={s.panel}
      aria-label="Conversation panel"
      data-customizing={customizing || undefined}
      data-motion={motion || undefined}
    >
      <div className={s.head}>
        <span className={s.headTab}>
          {/* Keyed by the title, so the change of mode reads as one word replacing another. */}
          <span key={customizing ? "c" : "v"} className={s.headTitle}>
            {customizing ? "Customize" : "Conversation"}
          </span>
          {/* A standing reminder, not a tooltip: the panel is opened and closed all the time,
              and the chord is only worth having if it is known. */}
          <kbd className={s.kbd} title="Open / close this panel">
            {CONVERSATION_PANEL_CHORD}
          </kbd>
        </span>
        <span className={s.headActs}>
          {customizing ? (
            <button type="button" className={s.doneBtn} onClick={() => setCustomizing(false)}>
              Done
            </button>
          ) : (
            <button
              type="button"
              className={s.iconBtn}
              onClick={() => setCustomizing(true)}
              title="Customize this panel"
              aria-label="Customize this panel"
            >
              <Ico name="grid" className="sm" />
            </button>
          )}
          <button
            type="button"
            className={s.iconBtn}
            onClick={() => closePanel(false)}
            title={`Close the conversation panel (${CONVERSATION_PANEL_CHORD})`}
            aria-label="Close the conversation panel"
          >
            <Ico name="x" className="sm" />
          </button>
        </span>
      </div>

      {/* The scroller, and inside it the sections at their natural height — two boxes, so the
          fit-content mode can read what the sections WANT whatever height the panel has. */}
      <div ref={bodyRef} className={s.body}>
        <div ref={refs?.inner} className={s.bodyInner}>
          {customizing ? (
            <PanelCustomize />
          ) : (
            <>
              <div
                className={s.stack}
                data-returning={returning || undefined}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget) setReturning(false);
                }}
              >
                {/* Keyed by conversation too: the panel is not remounted on a conversation
                    switch, and a widget's own state (a histogram's baseline, a folded list)
                    must never carry over to another conversation. */}
                {main.map((e) => (
                  <MainWidget key={`${conv.id}:${e.id}`} id={e.id} conv={conv} />
                ))}
              </div>
              {/* Shown by CSS only while the stack above rendered nothing (`.stack:empty`). */}
              <p className={s.empty}>
                {main.length === 0 ? (
                  <>Every section is switched off. </>
                ) : (
                  <>
                    Nothing to track yet. This conversation's task, goal, todo list, artifacts and
                    other readings show up here as they appear.{" "}
                  </>
                )}
                <button type="button" className={s.emptyLink} onClick={() => setCustomizing(true)}>
                  Customize the panel
                </button>
              </p>
            </>
          )}
        </div>
      </div>

      {/* Pinned below the scrolling sections: the stream's controls stay one click away. */}
      {!customizing && foot.length > 0 ? (
        <div className={s.foot}>
          {foot.map((e) => (
            <FootWidget key={`${conv.id}:${e.id}`} id={e.id} conv={conv} />
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/** One scrolling section, by id. Each renders null when it has nothing to show. */
function MainWidget({ id, conv }: { id: WidgetId; conv: Conversation }) {
  switch (id) {
    case "telemetry":
      return <TelemetryWidget convId={conv.id} />;
    case "task":
      return <TaskWidget conv={conv} />;
    case "goal":
      return <GoalWidget convId={conv.id} />;
    case "todos":
      return <TodoWidget convId={conv.id} />;
    case "artifacts":
      return <ArtifactsWidget convId={conv.id} />;
    case "linked":
      return <LinkedConversationsWidget conv={conv} />;
    case "stats":
      return <StatsWidget conv={conv} />;
    case "context":
      return <ContextWidget convId={conv.id} />;
    case "git":
      return <GitStatusWidget conv={conv} />;
    case "plan":
      return <PlanUsageWidget conv={conv} />;
    default:
      return null;
  }
}

/** One row pinned at the bottom, by id. */
function FootWidget({ id, conv }: { id: WidgetId; conv: Conversation }) {
  switch (id) {
    case "stream":
      return <StreamRow conv={conv} />;
    case "worktree":
      return <WorktreeRow conv={conv} />;
    case "machine":
      return <MachineRow conv={conv} />;
    default:
      return null;
  }
}

/** The telemetry deck is its own island (its head IS its header), so it folds itself: folded, only
 *  its head is mounted — not the derivation, not the frame loop. */
function TelemetryWidget({ convId }: { convId: string }) {
  const collapsible = useSidePanelLayout((st) => st.layout.collapsible);
  const collapsed = useSidePanelLayout((st) => isCollapsed(st.layout, "telemetry"));
  const setCollapsed = useSidePanelLayout((st) => st.setCollapsed);
  // The folded and the open deck are different elements: a fold toggled from the keyboard would
  // drop focus to <body>. Remember that the toggle had focus, and give it back to the new one.
  const hostRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const toggle = (fold: boolean) => {
    refocus.current = hostRef.current?.contains(document.activeElement) ?? false;
    setCollapsed("telemetry", fold);
  };
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    hostRef.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
  }, [collapsed]);
  return (
    <div ref={hostRef} className={s.deckHost}>
      {collapsed ? (
        <TelemetryDeckFolded convId={convId} onUnfold={() => toggle(false)} />
      ) : (
        <TelemetryDeck convId={convId} onFold={collapsible ? () => toggle(true) : undefined} />
      )}
    </div>
  );
}

/** Same gate as the header chip it replaces: a linked task only shows while TOSSE exists. */
function TaskWidget({ conv }: { conv: Conversation }) {
  const tosseAvailable = useTosseAvailable();
  if (!tosseAvailable || !conv.tosseTaskId || !conv.tosseTaskTitle) return null;
  return <TaskSection conv={conv} />;
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
    <PanelSection
      id="task"
      icon={<TosseCrmMark className={s.tosseMark} />}
      title="TOSSE task"
      // Folded, the card is its status — the one thing a glance at a task wants (open, the status
      // chip in the body says it).
      foldedMeta={status ? <span className={s.meta}>{status}</span> : undefined}
      action={
        <button
          type="button"
          className={s.textBtn}
          onClick={open}
          title="Read the task in the side region"
        >
          Open
        </button>
      }
    >
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
    </PanelSection>
  );
}

function GoalWidget({ convId }: { convId: string }) {
  const goal = useActiveGoal(convId);
  const clear = useClearGoalAction(convId);
  if (!goal) return null;
  return (
    <PanelSection
      id="goal"
      icon={<Ico name="target" className={`sm ${s.goalIco}`} />}
      title="Goal"
      // An active goal is by definition not achieved yet (the CLI clears it once met); what we
      // can say is whether the evaluator has looked at it.
      meta={<span className={`${s.pill} ${s.pillAtt}`}>{goal.reason ? "Not met" : "Not checked yet"}</span>}
      action={
        <button type="button" className={s.textBtn} onClick={clear} title="Clear the goal">
          Clear
        </button>
      }
    >
      <div className={s.goalCond}>{goal.condition}</div>
      {goal.reason ? <div className={s.goalReason}>{goal.reason}</div> : null}
    </PanelSection>
  );
}

/**
 * How full this conversation's context window is — the one figure that decides when a
 * conversation has to be compacted or forked, and until now readable only from the composer's
 * 16px ring.
 *
 * ⚠️ Two figures that arrive at DIFFERENT times, and the section says which it has: the token
 * count lands with the first model call of a turn (and survives a reload), the WINDOW only at
 * the end of a turn. Until both are in there is no honest percentage, so the bar is withheld
 * and the row reads "— of an unknown window" rather than drawing a fill from a guess.
 *
 * Clicking opens the SAME popover as the composer's ring and the Flight Deck card's meter
 * (plan usage + « Compact context »), through the same backend-aware hook — a third surface
 * answering the same question must not be a third implementation of it.
 */
function ContextWidget({ convId }: { convId: string }) {
  const { ctx } = useContextData(convId);
  // The section appears once there IS a token count to show — an untouched conversation has
  // nothing to report, and "— / —" is not a reading.
  if (!ctx.usedKnown) return null;
  return (
    <PanelSection
      id="context"
      icon={<Ico name="gauge" className="sm" />}
      title="Context"
      meta={<span className={`${s.meta} wf-mono`}>{ctx.windowKnown ? `${ctx.pct}%` : "—"}</span>}
    >
      <ContextUsageMenu
        convId={convId}
        trigger={(ctx, warn) => (
          <button
            className={s.ctxBtn}
            data-warn={warn || undefined}
            title={
              ctx.windowKnown
                ? `Context ${ctx.used} / ${ctx.max}`
                : "The context window is only known once a turn ends"
            }
          >
            <span
              className={s.progress}
              role="progressbar"
              aria-label="Context window used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={ctx.windowKnown ? ctx.pct : undefined}
            >
              {ctx.windowKnown ? (
                <span className={s.ctxFill} style={{ width: `${ctx.pct}%` }} />
              ) : null}
            </span>
            <span className={s.ctxRow}>
              <span className={`${s.ctxUsed} wf-mono`}>
                {ctx.used} / {ctx.max}
              </span>
              <span className={s.ctxHint}>
                {ctx.windowKnown ? "tokens" : "window known at turn end"}
              </span>
            </span>
          </button>
        )}
      />
    </PanelSection>
  );
}

function TodoWidget({ convId }: { convId: string }) {
  const todos = useTodos(convId);
  const summary = useTodoSummary(convId);
  if (todos.length === 0) return null;
  const pct = summary.total > 0 ? Math.round((summary.completed / summary.total) * 100) : 0;
  return (
    <PanelSection
      id="todos"
      icon={<Ico name="list" className="sm" />}
      title="Todo"
      meta={
        <span className={`${s.meta} wf-mono`}>
          {summary.completed}/{summary.total}
        </span>
      }
    >
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
    </PanelSection>
  );
}

function ArtifactsWidget({ convId }: { convId: string }) {
  const artifacts = useArtifacts(convId);
  if (artifacts.length === 0) return null;
  return (
    <PanelSection
      id="artifacts"
      icon={<Ico name="artifact" className="sm" />}
      title="Artifacts"
      meta={<span className={`${s.meta} wf-mono`}>{artifacts.length}</span>}
    >
      <div className={s.artifacts}>
        {artifacts
          .slice()
          .reverse()
          .map((a) => (
            <ArtifactCard key={a.url ?? a.latestFilePath} convId={convId} art={a} />
          ))}
      </div>
    </PanelSection>
  );
}

/**
 * One published artifact: its face, title, kind and version count. The card opens the artifact
 * like every other artifact surface (in-app viewer when the local file is still there, else the
 * hosted page); the version badge expands its HISTORY.
 *
 * ⚠️ The typed/multi-file flags are passed on. Without them a Claude Design canvas would be
 * routed to the local preview and render its `canvas.json` as a page — the broken screen
 * `routeArtifactOpen` exists to avoid. Every surface must hand it the same facts.
 */
function ArtifactCard({ convId, art }: { convId: string; art: Artifact }) {
  const [open, setOpen] = useState(false);
  const kind = art.typed
    ? art.typeName
      ? `${art.typeName} artifact`
      : "Artifact"
    : artifactKind(art.latestFilePath) === "md"
      ? "Markdown"
      : "HTML";
  const count = art.versions.length;
  // The badge shows the ARTIFACT's version number, which is the highest any ack named — not the
  // last one, whose publish may have failed (and so carries no number at all). Falls back to the
  // count for transcripts written before the CLI put "(Version N)" in the ack.
  const latest =
    art.versions.reduce<number | null>((m, v) => (v.version && (m === null || v.version > m) ? v.version : m), null) ??
    count;
  const openArtifact = () =>
    openArtifactView({
      convId,
      title: art.title,
      favicon: art.favicon,
      url: art.url,
      filePath: art.latestFilePath,
      typed: art.typed,
      multiFile: art.multiFile,
    });
  return (
    <div className={s.artCard} data-open={open || undefined}>
      <div className={s.artHead}>
        <button
          type="button"
          className={s.artOpen}
          onClick={openArtifact}
          title={art.url ? "Open in Flight Deck" : "Not published yet"}
        >
          <span className={s.artTile} aria-hidden="true">
            <ArtifactFace face={art.favicon} />
          </span>
          <span className={s.artMain}>
            <span className={s.artTitle}>{art.title}</span>
            <span className={s.artSub}>
              {kind}
              {art.url ? "" : " · publishing…"}
            </span>
          </span>
          <Ico name="external" className={`sm ${s.artGo}`} />
        </button>
        {count > 1 ? (
          <button
            type="button"
            className={s.artVbtn}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={open ? "Hide the version history" : "Show the version history"}
          >
            <span className="wf-mono">v{latest}</span>
            <Ico name="chev" className={`sm ${s.artVchev}`} />
          </button>
        ) : (
          <span className={`${s.artV1} wf-mono`}>v{latest}</span>
        )}
      </div>
      {count > 1 && open ? <ArtifactVersions convId={convId} art={art} /> : null}
    </div>
  );
}

/**
 * The version history of one artifact, newest first — the only way to reach an OLDER version.
 *
 * ⚠️ There is no per-version link to fabricate: the wire gives ONE canonical URL (claude.ai
 * always serves the latest), and each republish overwrites the same local temp file, so an
 * earlier version's bytes exist nowhere the app can read. What does survive is the message that
 * published it, card and all — so a row scrolls the thread there rather than pretending to open
 * something. A version whose publish FAILED says so instead of looking like one you can visit.
 */
function ArtifactVersions({ convId, art }: { convId: string; art: Artifact }) {
  return (
    <div className={s.artVersions}>
      {art.versions
        .map((v, i) => ({ v, n: v.version ?? i + 1 }))
        .reverse()
        .map(({ v, n }) => (
          <button
            key={v.toolUseId}
            type="button"
            className={s.artVrow}
            data-state={v.isError ? "error" : undefined}
            onClick={() => openConversationAt(convId, { kind: "artifact", toolUseId: v.toolUseId })}
            title="Go to where this version was published"
          >
            <span className={`${s.artVn} wf-mono`}>v{n}</span>
            <span className={s.artVlabel}>
              {v.isError ? "Publishing failed" : v.label || v.description || "—"}
            </span>
            <Ico name="reply" className={`sm ${s.artVgo}`} />
          </button>
        ))}
    </div>
  );
}

// ---- Rows pinned at the bottom: the stream (state + turn on / restart / turn off) and the
// worktree the conversation works in right now (+ the manager) — what the header used to show as
// chips — and the machine it runs on (widgets/MachineRow).

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
