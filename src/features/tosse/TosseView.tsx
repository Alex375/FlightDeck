// The TOSSE tasks view — the app's third top-level view (⌘3), listing the CRM's active
// projects by client with their open tasks.
//
// Structure is lifted from the CRM's own Briefing page (project card: client, progress
// ring, tasks in status sections), because that page is the one Alexandre already reads
// every morning — and so are the COLOURS: violet « En revue », yellow « En attente », the
// CRM's two greys. This screen is the CRM's board, so it reads like the CRM even though
// Flight Deck one tab away speaks a different colour language (see `tosse-status.css`).
//
// The briefing feeds most of it (`tosse_briefing`), plus one request per status the
// briefing structurally omits — Backlog and « En attente » (see `useTosseOffBoard`). The
// detail panel fetches a task in full only when a row is opened. Writes are optimistic with
// a whole-board rollback, and a refused write says why — see `useTosse`.
import { useEffect, useMemo, useRef, useState } from "react";
import { Dot, Ico, Menu, MenuItem, TosseCrmMark } from "../../ui/kit";
import { agentStatusToDot } from "../../agent/status";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Splitter } from "../editor/Splitter";
import { useSettingsUi } from "../../store/settingsUi";
import { useTosseDetail } from "../../store/tosseDetail";
import { useHistoryUi } from "../history/historyUiStore";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCreateTosseTask,
  useSetTosseProjectStatus,
  useSetTosseTaskStatus,
  useTosseOffBoard,
  useTosseBriefing,
  useTosseTaskDetail,
  useTosseWebUrl,
} from "../../ipc/useTosse";
import { AssigneeAvatar, splitMcpActor } from "./AssigneeAvatar";
import { ClientAvatar } from "./ClientAvatar";
import { ProjectFolderChip } from "./ProjectFolderChip";
import { TaskLaunchProvider, useTaskLaunch } from "./TaskLaunch";
import { launchTask } from "./taskPrompts";
import type { LaunchMode } from "./taskConversation";
import { useConversationsForTask, type Conversation } from "../../store/conversationsStore";
import {
  GENERAL_FOLD_KEY,
  offBoardFold,
  projectFoldKey,
  useTosseFold,
} from "../../store/tosseFold";
import { useTosseLive } from "../../store/tosseLive";
import { liveIndicatorView } from "./liveIndicator";
import { commands } from "../../ipc/client";

import type {
  TosseOffBoardTask,
  TosseProject,
  TosseTask,
  TosseTaskDetail,
} from "../../ipc/client";
import {
  briefingTotals,
  groupByClient,
  groupOffBoardByProject,
  isOverdue,
  offBoardForScope,
  offBoardProjectCards,
  offBoardWithoutProject,
  OFF_BOARD_SECTIONS,
  projectActions,
  projectStatusTone,
  sectionIcon,
  sectionLabel,
  sortedBacklog,
  shortDate,
  statusSections,
  STATUS_TONE,
  taskQuickAction,
  TASK_STATUS_CHOICES,
  type ProjectAction,
  type StatusSection,
} from "./tosseModel";
import s from "./TosseView.module.css";

/** The progress ring on a project card (done / total across ALL its tasks). Pure SVG —
 *  the same shape the CRM draws, so the two read as one number. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <span className={s.ring} title={`${done} of ${total} tasks done`}>
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={r} className={s.ringTrack} />
        <circle
          cx="15"
          cy="15"
          r={r}
          className={pct >= 100 ? s.ringFull : s.ringFill}
          strokeDasharray={c}
          strokeDashoffset={c - (pct / 100) * c}
        />
      </svg>
      <span className={s.ringLabel}>
        {done}/{total}
      </span>
    </span>
  );
}

/**
 * "Open in TOSSE" — the way out to the CRM for everything this view deliberately does not
 * edit: a task's title, priority, assignee or due date, and deletions. Without it, the v1
 * write scope would read as "you can't", when it is really "not from here".
 *
 * Renders nothing while the origin is unknown: a link that cannot be built is worse than no
 * link. The detail panel reports the reason once — see {@link TaskDetail} — instead of every
 * card repeating the same failure.
 */
function OpenInTosse({ path, title, compact }: { path: string; title: string; compact?: boolean }) {
  const { data: origin } = useTosseWebUrl();
  if (!origin) return null;
  return (
    <button
      className={compact ? s.openIcon : s.open}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(`${origin}${path}`);
      }}
    >
      <Ico name="external" className="sm" />
      {compact ? null : "Open in TOSSE"}
    </button>
  );
}

/** The subtask ring on a task row — the card's `ProgressRing` shrunk to fit a 33px line,
 *  without its label (the ratio is already spelled out beside it). */
function MiniRing({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? done / total : 0;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={s.subRing} aria-hidden="true">
      <circle cx="7" cy="7" r={r} className={s.ringTrack} />
      <circle
        cx="7"
        cy="7"
        r={r}
        className={pct >= 1 ? s.ringFull : s.ringFill}
        strokeDasharray={c}
        strokeDashoffset={c - pct * c}
      />
    </svg>
  );
}

/**
 * A card's off-board section — « En attente » or Backlog — behind a fold of its own.
 *
 * These are sections like the others (same head, same rows) but they do not belong in the
 * status order: the briefing answers "what am I working on", and these two answer different
 * questions, from a request of their own. Hence their own fold and their own default.
 *
 * ⚠️ The two defaults are OPPOSITE, and the store only records what is CLOSED — so the
 * reading of `folded[key]` has to flip with `defaultOpen`. Getting that backwards does not
 * fail loudly: it just hides a section that should be open, which reads as "there is
 * nothing there".
 */
function OffBoardSection({
  status,
  foldKey,
  defaultOpen,
  tasks,
  projectId,
  projectName,
  selectedTaskId,
  onOpenTask,
  onStatus,
  writeErrors,
}: {
  /** The CRM status this section holds — also what it is titled and toned by. */
  status: string;
  foldKey: string;
  defaultOpen: boolean;
  tasks: TosseTask[];
  /** The card's project — what a launch from one of these rows resolves its folder from. */
  projectId: string | null;
  projectName: string | null;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
  onStatus: (task: TosseTask, status: string) => void;
  writeErrors?: Record<string, string>;
}) {
  const marked = useTosseFold((f) => f.folded[foldKey] === true);
  const toggle = useTosseFold((f) => f.toggle);
  const open = defaultOpen ? !marked : marked;
  const label = sectionLabel(status);
  if (tasks.length === 0) return null;
  return (
    <div className={s.section} data-tone={STATUS_TONE[status] ?? "todo"}>
      <button
        className={`${s.sectionHead} ${s.sectionToggle}`}
        onClick={() => toggle(foldKey)}
        aria-expanded={open}
        title={open ? `Hide « ${label} »` : `Show « ${label} »`}
      >
        <span className={`${s.sectionChevron} ${open ? "" : s.sectionChevronClosed}`}>
          <Ico name="chevron" className="sm" />
        </span>
        {/* Dot and icon as on every other section head — the fold is the only difference,
            and a heading that lost its mark would read as a different KIND of thing. */}
        <span className={s.sectionDot} />
        <Ico name={sectionIcon(status)} className={`sm ${s.sectionIco}`} />
        <span className={s.sectionLabel}>{label}</span>
        <span className={s.sectionCount}>{tasks.length}</span>
        <span className={s.sectionRule} />
      </button>
      {open
        ? sortedBacklog(tasks).map((task) => (
            <div key={task.id}>
              <TaskRow
                task={task}
                projectId={projectId}
                projectName={projectName}
                selected={task.id === selectedTaskId}
                onOpen={() => onOpenTask(task.id)}
                onStatus={(status) => onStatus(task, status)}
              />
              {writeErrors?.[task.id] ? (
                <div className={s.rowError}>{writeErrors[task.id]}</div>
              ) : null}
            </div>
          ))
        : null}
    </div>
  );
}

/**
 * Every off-board section of one card, in order — « En attente » first, then the Backlog.
 *
 * Waiting work is live (its ball is in someone else's court) while a backlog item is work
 * deliberately not started, so the one you might act on today sits closer to the tasks
 * above it. Rendered by the same component for both the project cards and the "no project"
 * band: `scopeId` is only what namespaces the fold keys.
 */
function OffBoardSections({
  scopeId,
  offBoard,
  projectId,
  projectName,
  selectedTaskId,
  onOpenTask,
  onStatus,
  writeErrors,
}: {
  scopeId: string;
  offBoard: Record<string, TosseTask[]>;
  projectId: string | null;
  projectName: string | null;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
  onStatus: (task: TosseTask, status: string) => void;
  writeErrors?: Record<string, string>;
}) {
  return (
    <>
      {OFF_BOARD_SECTIONS.map((status) => {
        const fold = offBoardFold(status);
        return (
          <OffBoardSection
            key={status}
            status={status}
            foldKey={fold.key(scopeId)}
            defaultOpen={fold.defaultOpen}
            tasks={offBoard[status] ?? []}
            projectId={projectId}
            projectName={projectName}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
            writeErrors={writeErrors}
            onStatus={onStatus}
          />
        );
      })}
    </>
  );
}

/**
 * What you can do with a task from here: open a conversation it already has, and start
 * another one.
 *
 * Both, deliberately. An earlier version hid "Start" as soon as one conversation existed —
 * "one task, one agent" — but a task legitimately gets a second pass: a retry after a
 * rewind, a second opinion, a discussion alongside the work. Reopening stays the FIRST
 * offer (it is what you usually want, and it is what stops an accidental double-click from
 * spawning a twin), while starting another is one button further along.
 */
function TaskActions({
  task,
  projectId,
  projectName,
  detail,
  className,
  onStatus,
}: {
  task: TosseTask;
  projectId: string | null;
  projectName: string | null;
  /** The open detail panel's payload, when this row is the one being read: its
   *  long-form fields ride along in the "Discuss" prompt instead of being re-fetched. */
  detail?: TosseTaskDetail | null;
  className?: string;
  /** Write this task's status. Given by the LIST, where the shortcut earns its place; the
   *  detail panel leaves it out, because the status chip at its head already IS a
   *  one-click status control, and two of them would only disagree about which is the
   *  one to use. Absent → no quick-action button, exactly as before. */
  onStatus?: (status: string) => void;
}) {
  const api = useTaskLaunch();
  const linked = useConversationsForTask(task.id);
  const quick = taskQuickAction(task.status);
  const busy = api?.busyTaskId === task.id;
  const built = () => launchTask(task, projectName, detail);
  const go = (mode: LaunchMode) => (e: React.MouseEvent) => {
    e.stopPropagation();
    api?.launch(built(), projectId, mode);
  };
  // Nothing to show at all — no launch context AND no status move to offer.
  if (!api && !(quick && onStatus)) return null;
  return (
    <span className={className}>
      {/* One conversation: a plain button. Several: the same button plus a menu to pick
          which — the count is on it, so the row says how many agents this task carries
          without being hovered for a tooltip. */}
      {api == null ? null : linked.length === 1 ? (
        <button
          className={`${s.act} ${s.act_go}`}
          title={`Open « ${linked[0].name} »`}
          onClick={(e) => {
            e.stopPropagation();
            api.open(linked[0].id);
          }}
        >
          <Ico name="chat" className="sm" />
          Open
        </button>
      ) : linked.length > 1 ? (
        <Menu
          portal
          trigger={
            <button
              className={`${s.act} ${s.act_go}`}
              title={`${linked.length} conversations on this task`}
              onClick={(e) => e.stopPropagation()}
            >
              <Ico name="chat" className="sm" />
              Open {linked.length}
            </button>
          }
        >
          {linked.map((c) => (
            <MenuItem key={c.id} icon="chat" onClick={() => api.open(c.id)}>
              {c.name}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {api == null ? null : (
        <button
          className={s.act}
          disabled={busy}
          title={
            linked.length > 0
              ? "Open ANOTHER conversation that thinks this task through, without starting it"
              : "Open a conversation that thinks this task through, without starting it"
          }
          onClick={go("discuss")}
        >
          Discuss
        </button>
      )}
      {/* A split button: "Start" runs it, the caret adds a word about HOW this particular
          run should go. Always "Start", whether or not the task already has a conversation
          — what the button does never changes, so its label should not either. */}
      {api == null ? null : (
        <span className={s.split}>
          <button
            className={`${s.act} ${s.act_go} ${s.splitMain}`}
            disabled={busy}
            title={
              linked.length > 0
                ? "Start another conversation on this task and hand it to the pickup skill"
                : "Open a conversation on this task and hand it to the pickup skill"
            }
            onClick={go("pickup")}
          >
            {busy ? "Opening…" : "Start"}
          </button>
          <Menu
            portal
            align="right"
            trigger={
              <button
                className={`${s.act} ${s.act_go} ${s.splitCaret}`}
                disabled={busy}
                title="Start with an extra instruction"
                onClick={(e) => e.stopPropagation()}
              >
                <Ico name="chevron" className="sm" />
              </button>
            }
          >
            <StartWithNote onStart={(note) => api.launch(built(), projectId, "pickup", note)} />
          </Menu>
        </span>
      )}
      {/* Last, and the only green one: this is where a reviewed task gets closed. Placed
          after the launch buttons on purpose — it ENDS the work the others start, and the
          rightmost slot is the one the eye reaches after reading the row. */}
      {quick && onStatus ? (
        <button
          className={`${s.act} ${s[`act_${quick.tone}`]}`}
          title={`Close this task — moves it to « ${quick.next} »`}
          onClick={(e) => {
            e.stopPropagation();
            onStatus(quick.next);
          }}
        >
          <Ico name="check" className="sm" />
          {quick.label}
        </button>
      ) : null}
    </span>
  );
}

/**
 * The Start button's drop-down: one instruction for THIS run, on top of what the pickup
 * skill already does ("plan first", "don't touch the CSS", "start with the tests").
 *
 * Deliberately not a second dialog — it is a sentence, and a modal for a sentence is the
 * kind of friction that makes people stop using the button at all.
 */
function StartWithNote({ onStart }: { onStart: (note: string) => void }) {
  const [note, setNote] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // ⚠️ Focused on the NEXT FRAME, not at mount. The menu renders its popover
  // `visibility: hidden` and only positions it in a layout effect — and a hidden element
  // cannot take focus, so both `autoFocus` and a plain mount effect silently did nothing
  // and the caret stayed on the button. This drop-down exists to type one sentence; the
  // caret has to be in the field when it appears.
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const send = () => {
    const trimmed = note.trim();
    if (trimmed) onStart(trimmed);
  };
  return (
    <div className={s.noteBox}>
      <div className={s.noteLabel}>Extra instruction for this run</div>
      <textarea
        ref={ref}
        className={s.noteInput}
        rows={3}
        // ⚠️ The menu closes on ANY click inside its popover — that is how a MenuItem
        // dismisses it. Without this, clicking into the field tore the field away (and
        // the click landed on the row underneath, opening the task). Stopped HERE only:
        // the "Start with this" button below still propagates, so pressing it both
        // launches and closes the menu, which is what it should do.
        onClick={(e) => e.stopPropagation()}
        value={note}
        placeholder="e.g. plan it out first, don't touch the CSS…"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          // ⌘↵ sends, like the composer. A bare ↵ writes a newline.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <button className={`${s.act} ${s.act_go} ${s.noteGo}`} disabled={!note.trim()} onClick={send}>
        Start with this
      </button>
    </div>
  );
}

/** Every conversation opened on a task, with its agent's live state. Rendered in the
 *  detail panel; nothing at all when the task has none. */
function TaskConversations({ taskId }: { taskId: string }) {
  const api = useTaskLaunch();
  const convs = useConversationsForTask(taskId);
  if (convs.length === 0) return null;
  return (
    <section>
      <div className={s.detailKey}>Conversations {convs.length}</div>
      {convs.map((c) => (
        <button
          key={c.id}
          className={s.convRow}
          title={`Open « ${c.name} »`}
          onClick={() => api?.open(c.id)}
        >
          <ConvStateDot convId={c.id} />
          <span className={s.convName}>{c.name}</span>
          <Ico name="arrow" className={`sm ${s.convGo}`} />
        </button>
      ))}
    </section>
  );
}

/** The agent's live state for one conversation — its own hook, so a row re-renders on its
 *  own state rather than the whole list on any of them. */
function ConvStateDot({ convId }: { convId: string }) {
  const status = useAgentStatus(convId);
  return <Dot s={agentStatusToDot(status)} pulse />;
}

/**
 * "Someone is already on this" — the smallest mark that answers it, visible at rest.
 *
 * Deliberately just the glyph (and a count past one): the AGENT's state belongs to the
 * conversation surfaces, and a second coloured dot on a row that already carries the CRM's
 * own status would read as a contradiction. Everything else is in the tooltip.
 *
 * For a few seconds after a "Start" that stayed on this view, the SAME chip says « Started »
 * in words instead. The mark that this task is taken is exactly what the click produced, so
 * it is the honest thing to announce with — and reusing the chip means the confirmation
 * fades back into the row's resting state rather than being a second thing to dismiss.
 */
function LinkedMark({ convs, justStarted }: { convs: Conversation[]; justStarted?: boolean }) {
  if (convs.length === 0) return null;
  if (justStarted) {
    return (
      <span
        className={`${s.linked} ${s.linkedStarted}`}
        title={`« ${convs[convs.length - 1].name} » was just started on this task`}
      >
        <Ico name="check" className="sm" />
        Started
      </span>
    );
  }
  return (
    <span
      className={s.linked}
      title={
        convs.length === 1
          ? `« ${convs[0].name} » is on this task`
          : `${convs.length} conversations on this task`
      }
    >
      <Ico name="chat" className="sm" />
      {convs.length > 1 ? convs.length : null}
    </span>
  );
}

/** A task row. The status dot is the write surface: click it, pick a status. NOT a drag —
 *  dragging means "manual order" everywhere else in this app, and a mis-drop here would
 *  write to the CRM. */
function TaskRow({
  task,
  projectId,
  projectName,
  selected,
  onOpen,
  onStatus,
}: {
  task: TosseTask;
  /** The project this row's card belongs to — how the launch resolves a folder. Null in
   *  the project-less band, where the dialog asks for one. */
  projectId: string | null;
  projectName: string | null;
  selected: boolean;
  onOpen: () => void;
  onStatus: (status: string) => void;
}) {
  const tone = STATUS_TONE[task.status] ?? "todo";
  const due = shortDate(task.dueDate);
  const late = isOverdue(task.dueDate, Date.now());
  const linked = useConversationsForTask(task.id);
  // Set for a few seconds after a "Start" that stayed on this view — see `startedTaskIds`.
  const justStarted = useTaskLaunch()?.startedTaskIds.has(task.id) === true;
  return (
    <div
      className={`${s.row} ${selected ? s.rowSel : ""}`}
      data-tone={tone}
      // Drives the one-shot flash. An ATTRIBUTE rather than a class so the animation is
      // restarted by React swapping it, and so it costs nothing at rest.
      data-started={justStarted ? "" : undefined}
      // ⚠️ Both handlers ignore anything that did not happen INSIDE this row's DOM.
      // React bubbles events through the COMPONENT tree, so a popover this row opens in a
      // portal (the Start button's instruction field) sends its clicks and keystrokes
      // here too: clicking that field opened the task underneath, and typing a space in
      // it opened the task AND swallowed the space (`preventDefault` below). The portal's
      // node is not a DOM descendant, so `contains` rejects it — the same guard the
      // Flight Deck card uses for its own portalled popovers.
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        onOpen();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <Menu
        portal
        trigger={
          <button
            className={`${s.dot} ${s[`dot_${tone}`]}`}
            title={`${task.status} — change status`}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        {TASK_STATUS_CHOICES.map((choice) => (
          <div key={choice}>
            {/* "Fait" closes the task: kept reachable (a human is clicking), but never
                adjacent to the status above it. */}
            {choice === "Fait" ? <div className={s.menuSep} /> : null}
            <MenuItem on={task.status === choice} onClick={() => onStatus(choice)}>
              {choice}
            </MenuItem>
          </div>
        ))}
      </Menu>
      {task.priority ? (
        <span className={`${s.pri} ${s[`pri_${priorityClass(task.priority)}`]}`}>
          {task.priority}
        </span>
      ) : null}
      {task.kind ? <span className={s.kind}>{task.kind}</span> : null}
      <span className={s.title}>{task.title}</span>
      {/* A ring, as the perimeter asks and as the CRM draws it: the ratio is readable at a
          glance from the arc, where "1/4" has to be read. */}
      {task.subtaskCount > 0 ? (
        <span className={s.subs} title={`${task.subtaskDone} of ${task.subtaskCount} subtasks done`}>
          <MiniRing done={task.subtaskDone} total={task.subtaskCount} />
          {task.subtaskDone}/{task.subtaskCount}
        </span>
      ) : null}
      <LinkedMark convs={linked} justStarted={justStarted} />
      {task.assignedTo ? <AssigneeAvatar name={task.assignedTo} /> : null}
      {due ? <span className={`${s.due} ${late ? s.dueLate : ""}`}>{due}</span> : null}
      {/* Revealed on hover, at the end of the row — the row's own click still opens the
          task, so these must not sit in the way of it. `onStatus` is the SAME writer the
          dot's menu uses, so the shortcut inherits its optimistic update, its rollback and
          its under-the-row error line for free. */}
      <TaskActions
        task={task}
        projectId={projectId}
        projectName={projectName}
        className={s.rowActs}
        onStatus={onStatus}
      />
    </div>
  );
}

function priorityClass(priority: string): string {
  switch (priority) {
    case "Urgente":
      return "urg";
    case "Haute":
      return "hi";
    case "Basse":
      return "low";
    default:
      return "mid";
  }
}

/** The "add a task" line at the foot of a status section. Creates the task WITH that
 *  section's status, in this card's project. */
function AddTaskRow({ projectId, status }: { projectId: string; status: string }) {
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const create = useCreateTosseTask();
  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { projectId, title: trimmed, status },
      // Clear on SUCCESS only — a refused creation must keep what was typed.
      { onSuccess: () => setTitle("") },
    );
  };
  if (!editing) {
    return (
      <button className={s.addIdle} onClick={() => setEditing(true)}>
        ＋ Add a task to « {status} »
      </button>
    );
  }
  return (
    <div className={s.addRow}>
      <input
        className={s.addInput}
        autoFocus
        value={title}
        placeholder={`New task in « ${status} »`}
        disabled={create.isPending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setTitle("");
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (!title.trim()) setEditing(false);
        }}
      />
      <span className={s.addHint}>{create.isPending ? "Creating…" : "↵ to create"}</span>
      {create.error ? <span className={s.addErr}>{String(create.error.message)}</span> : null}
    </div>
  );
}

/**
 * Failed per-task writes, kept BY TASK.
 *
 * A card shares one mutation across all its rows, so `mutation.error` holds only the most
 * recent failure — click another row and the previous refusal is wiped before anyone read
 * it, which is the silent failure all over again. Keeping them keyed by task means each
 * refusal stays put, under the row it belongs to, until that row's write succeeds.
 */
function useTaskWriteErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const note = (taskId: string, message: string) =>
    setErrors((prev) => ({ ...prev, [taskId]: message }));
  const clear = (taskId: string) =>
    setErrors((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  return { errors, note, clear };
}

/**
 * The status sections of a card: a dot + label + count per status, then its rows.
 *
 * Shared by the project cards and the project-less band — it was copy-pasted between the
 * two, which is how the band ended up drifting (its rows went through a different mutation
 * whose failures nothing displayed). One renderer means one behaviour.
 */
function StatusSections({
  sections,
  projectId,
  projectName,
  selectedTaskId,
  onOpenTask,
  onStatus,
  writeErrors,
}: {
  sections: StatusSection[];
  /** The card's project — what a launch from one of these rows resolves its folder from. */
  projectId: string | null;
  projectName: string | null;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
  onStatus: (task: TosseTask, status: string) => void;
  /** taskId → why its last write was refused. Rendered under that row. */
  writeErrors?: Record<string, string>;
}) {
  return (
    <>
      {sections.map((section) => (
        <div
          key={section.status}
          className={s.section}
          data-tone={STATUS_TONE[section.status] ?? "todo"}
        >
          <div className={s.sectionHead}>
            {/* Dot THEN icon THEN heading — the CRM draws all three, and the pair reads as
                one mark. « Review » is titled « En revue » here, as it is there; the status
                VALUE keeps its own name everywhere it is written or picked. */}
            <span className={s.sectionDot} />
            <Ico name={sectionIcon(section.status)} className={`sm ${s.sectionIco}`} />
            <span className={s.sectionLabel}>{sectionLabel(section.status)}</span>
            <span className={s.sectionCount}>{section.tasks.length}</span>
            <span className={s.sectionRule} />
          </div>
          {section.tasks.map((task) => (
            <div key={task.id}>
              <TaskRow
                task={task}
                projectId={projectId}
                projectName={projectName}
                selected={task.id === selectedTaskId}
                onOpen={() => onOpenTask(task.id)}
                onStatus={(status) => onStatus(task, status)}
              />
              {/* Right under the row it happened on — an error at the top of the card would
                  not say WHICH task the CRM refused. */}
              {writeErrors?.[task.id] ? (
                <div className={s.rowError}>{writeErrors[task.id]}</div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** One project: the Briefing's card, with a state control instead of a state label. */
function ProjectCard({
  project,
  paused,
  index,
  offBoard,
  selectedTaskId,
  onOpenTask,
}: {
  project: TosseProject;
  paused?: boolean;
  /** Position in its band — drives the entry cascade (capped in CSS at 6 steps). */
  index?: number;
  /** This project's off-board tasks by status — from their own requests, see
   *  `useTosseOffBoard`. */
  offBoard: Record<string, TosseTask[]>;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  const setProjectStatus = useSetTosseProjectStatus();
  const taskErrors = useTaskWriteErrors();
  const [confirming, setConfirming] = useState<ProjectAction | null>(null);
  const sections = useMemo(() => statusSections(project.tasks), [project.tasks]);
  // Whether the card has anything at all — "No open task" must not appear above a list of
  // parked ones, which is exactly what counting only the briefing's sections would do.
  const offBoardCount = Object.values(offBoard).reduce((n, tasks) => n + tasks.length, 0);
  const foldKey = projectFoldKey(project.id);
  const folded = useTosseFold((f) => f.folded[foldKey] === true);
  const toggle = useTosseFold((f) => f.toggle);
  const actions = projectActions(project.status);
  const start = shortDate(project.startDate);
  const due = shortDate(project.dueDate);
  const late = isOverdue(project.dueDate, Date.now());

  const run = (action: ProjectAction) => {
    if (action.confirm) setConfirming(action);
    else setProjectStatus.mutate({ projectId: project.id, status: action.next });
  };

  return (
    <div
      className={`${s.card} ${paused ? s.cardPaused : ""} ${folded ? s.cardFolded : ""}`}
      style={{ "--i": index ?? 0 } as React.CSSProperties}
    >
      <div className={s.cardHead}>
        {/* The card's own disclosure, wearing the client band's chevron because it does the
            same thing one level down. It covers the identity block ONLY: the tools beside it
            are buttons of their own, and a button cannot live inside a button. */}
        <button
          className={s.cardIdent}
          onClick={() => toggle(foldKey)}
          aria-expanded={!folded}
          title={folded ? `Show « ${project.name} »'s tasks` : `Hide « ${project.name} »'s tasks`}
        >
          <span className={`${s.cardChevron} ${folded ? s.cardChevronClosed : ""}`}>
            <Ico name="chevron" className="sm" />
          </span>
          <span className={s.cardIdentText}>
            <span className={s.cardName}>{project.name}</span>
            <span className={s.cardMeta}>
              {start ? <span>Started {start}</span> : null}
              {due ? <span className={late ? s.dueLate : ""}>Due {due}</span> : null}
              <span>
                {project.tasks.length} open
                {paused ? " · paused" : ""}
              </span>
              {/* Folded, the head takes over what the sections below were saying — a closed
                  card still has to tell you whether anything in it is running or waiting,
                  the same way a folded client band keeps its counts. Open, they would only
                  repeat the section headings a few pixels lower.

                  ⚠️ The off-board counts are here too, and they have to be: a project whose
                  whole queue is parked has NO briefing section, so a folded card reported
                  "0 open" and nothing else — a card that looks empty and is not. */}
              {folded
                ? sections.map((sec) => (
                    <span
                      key={sec.status}
                      className={s.cardCount}
                      data-tone={STATUS_TONE[sec.status] ?? "todo"}
                    >
                      {sec.tasks.length} {sectionLabel(sec.status).toLowerCase()}
                    </span>
                  ))
                : null}
              {/* After the live ones, in the order the sections themselves appear. */}
              {folded
                ? OFF_BOARD_SECTIONS.filter((status) => (offBoard[status]?.length ?? 0) > 0).map(
                    (status) => (
                      <span
                        key={status}
                        className={s.cardCount}
                        data-tone={STATUS_TONE[status] ?? "todo"}
                      >
                        {offBoard[status]?.length} {sectionLabel(status).toLowerCase()}
                      </span>
                    ),
                  )
                : null}
            </span>
          </span>
        </button>
        <div className={s.cardTools}>
          {/* Where this project's work happens on this Mac — stated, and re-pickable.
              An association decided once inside a dialog would otherwise be invisible. */}
          <ProjectFolderChip projectId={project.id} projectName={project.name} />
          {project.taskCount > 0 ? (
            <ProgressRing done={project.taskDone} total={project.taskCount} />
          ) : null}
          <span className={`${s.state} ${s[`state_${projectStatusTone(project.status)}`]}`}>
            {project.status ?? "—"}
          </span>
          <OpenInTosse
            compact
            path={`/projects/${project.id}`}
            title={`Open « ${project.name} » in TOSSE`}
          />
          {actions.map((a) => (
            <button
              key={a.next}
              className={`${s.act} ${a.tone ? s[`act_${a.tone}`] : ""}`}
              disabled={setProjectStatus.isPending}
              onClick={() => run(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* A refused write is shown where it happened, not swallowed by the next refetch.
          Task-level refusals are rendered under their own row (see `writeErrors`); this one
          is the PROJECT's own state change, which has no row to sit under.

          ⚠️ OUTSIDE the fold, unlike everything below: the buttons that produce this error
          live in the head, which stays on screen when the card is closed. Folding it away
          would leave a click that visibly did nothing and no reason anywhere. */}
      {setProjectStatus.error ? (
        <div className={s.rowError}>{String(setProjectStatus.error.message)}</div>
      ) : null}

      {folded ? null : paused ? (
        <div className={s.pausedNote}>Paused — its tasks are hidden. Resume to work on it.</div>
      ) : (
        <>
          <div className={s.cardRule} />
          <StatusSections
            sections={sections}
            projectId={project.id}
            projectName={project.name}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
            writeErrors={taskErrors.errors}
            onStatus={(task, status) =>
              setTaskStatus.mutate(
                { taskId: task.id, status, title: task.title },
                {
                  onError: (e) => taskErrors.note(task.id, String((e as Error).message)),
                  onSuccess: () => taskErrors.clear(task.id),
                },
              )
            }
          />
          <OffBoardSections
            scopeId={project.id}
            offBoard={offBoard}
            projectId={project.id}
            projectName={project.name}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
            writeErrors={taskErrors.errors}
            onStatus={(task, status) =>
              setTaskStatus.mutate(
                { taskId: task.id, status, title: task.title },
                {
                  onError: (e) => taskErrors.note(task.id, String((e as Error).message)),
                  onSuccess: () => taskErrors.clear(task.id),
                },
              )
            }
          />
          {sections.length === 0 && offBoardCount === 0 ? (
            <div className={s.cardEmpty}>No open task</div>
          ) : null}
          {/* ONE creation line per card, not one per section: a row under every status was
              three invitations where one is wanted. New tasks land in « À faire » — the
              status they nearly always start in — and moving one is a single click away. */}
          <AddTaskRow projectId={project.id} status="À faire" />
        </>
      )}

      <ConfirmDialog
        open={confirming != null}
        title={`Finish « ${project.name} » ?`}
        confirmLabel="Finish the project"
        busy={setProjectStatus.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) {
            setProjectStatus.mutate({ projectId: project.id, status: confirming.next });
          }
          setConfirming(null);
        }}
      >
        The project moves to « Terminé » in TOSSE and leaves this view. Its tasks are not
        changed.
      </ConfirmDialog>
    </div>
  );
}

/**
 * The detail panel: the CRM's task panel, trimmed to what this app can act on.
 *
 * Exported because the conversation's side region shows the SAME panel — a task read from
 * a conversation and a task read from the board must not be two different screens. There it
 * is `embedded`: the host owns the width, so the panel drops its own sizing and border.
 */
export function TaskDetail({
  taskId,
  width,
  onClose,
  embedded,
}: {
  taskId: string;
  /** Ignored when `embedded` — the side region sizes the panel itself. */
  width?: number;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { data, isLoading, error } = useTosseTaskDetail(taskId);
  const setTaskStatus = useSetTosseTaskStatus();
  const { error: webUrlError } = useTosseWebUrl();
  // A full-screen modal opened OVER this panel owns Escape — closing both at once would
  // lose the task you were reading for a key you aimed at the modal.
  // ⚠️ Two separate calls, NOT `useSettingsUi(…) || useHistoryUi(…)`: `||` short-circuits,
  // so the second hook would go uncalled whenever the first is true — a changing hook order,
  // which React treats as a broken component (it tears the view down mid-render).
  const settingsOpen = useSettingsUi((u) => u.open);
  const historyOpen = useHistoryUi((u) => u.open);
  const modalOver = settingsOpen || historyOpen;

  // Escape closes the panel — the button says so, so it has to be true.
  //
  // Listening on `window` (not `document`) is what makes this well-behaved: any layer that
  // is genuinely ABOVE — a ConfirmDialog, a portalled popover — listens on `document` and
  // stops propagation there, so the key never reaches us and only that layer closes. The
  // app-wide capture guard in App.tsx keeps macOS from leaving fullscreen either way.
  useEffect(() => {
    if (modalOver) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOver, onClose]);

  return (
    <aside
      className={`${s.detail} ${embedded ? s.detailEmbedded : ""}`}
      style={embedded ? undefined : ({ "--tosse-detail-w": `${width}px` } as React.CSSProperties)}
    >
      <div className={s.detailHead}>
        <div className={s.detailKicker}>
          {data?.projectName ?? "TOSSE"}
          <button className={s.detailClose} onClick={onClose} title="Close (Esc)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={s.detailTitle}>{data?.task.title ?? "…"}</div>
        {data ? (
          <div className={s.detailChips}>
            {/* A TASK's status, so it uses the task colour language — `projectStatusTone`
                maps PROJECT states, and sends everything it doesn't know to "todo": a task
                in « Review » came out grey here while the board painted it violet, in the
                one place meant to tell you what the task is. */}
            {/* The status is a CONTROL here too, not a label: the panel is where you read a
                task in full, so it is also where you move it on. Same menu as the row's
                dot — one way to change a status, wherever you are. */}
            <Menu
              portal
              trigger={
                <button
                  className={`${s.state} ${s.stateBtn} ${s[`state_${STATUS_TONE[data.task.status] ?? "todo"}`]}`}
                  title={`${data.task.status} — change status`}
                >
                  {data.task.status}
                  <Ico name="chevron" className="sm" />
                </button>
              }
            >
              {TASK_STATUS_CHOICES.map((choice) => (
                <div key={choice}>
                  {choice === "Fait" ? <div className={s.menuSep} /> : null}
                  <MenuItem
                    on={data.task.status === choice}
                    onClick={() => setTaskStatus.mutate({ taskId, status: choice })}
                  >
                    {choice}
                  </MenuItem>
                </div>
              ))}
            </Menu>
            {data.task.priority ? (
              <span className={`${s.pri} ${s[`pri_${priorityClass(data.task.priority)}`]}`}>
                {data.task.priority}
              </span>
            ) : null}
            {data.task.kind ? <span className={s.kind}>{data.task.kind}</span> : null}
            {/* The person wears the SAME mark as in the list, with their name spelled out —
                the panel has room for it, a 20px disc alone would not say who. */}
            {data.task.assignedTo ? (
              <span className={s.whoChip}>
                <AssigneeAvatar name={data.task.assignedTo} />
                {splitMcpActor(data.task.assignedTo).person}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={s.detailBody}>
        {isLoading ? <div className={s.muted}>Loading…</div> : null}
        {error ? <div className={s.rowError}>{String(error.message)}</div> : null}
        {/* The MUTATION's error, not the query's. Ticking a subtask writes to the CRM, and
            a refusal used to land nowhere: this panel only ever rendered the read error, so
            a rejected write looked exactly like an accepted one. */}
        {setTaskStatus.error ? (
          <div className={s.rowError}>{String(setTaskStatus.error.message)}</div>
        ) : null}

        {data && data.blockedBy.length > 0 ? (
          <section>
            <div className={s.detailKey}>Blocked by</div>
            {data.blockedBy.map((b) => (
              <div key={b.id} className={`${s.blockRow} ${b.resolved ? s.blockDone : ""}`}>
                <span className={s.blockDot} data-tone={STATUS_TONE[b.status ?? ""] ?? "todo"} />
                {b.title}
                <span className={s.muted}>{b.status}</span>
              </div>
            ))}
          </section>
        ) : null}

        {/* The conversations this task carries, HIGH in the panel — ahead of the prose,
            because "is someone already on this, and can I jump in?" is what you come here
            to answer first. Their dot is the AGENT's live state (the app's own language),
            which is why it sits inside a chat row rather than next to the task's own CRM
            status above. */}
        <TaskConversations taskId={taskId} />

        {/* The task's BODY. It was fetched, crossed the IPC and was then dropped on the
            floor — so a task whose description lives in `content` (the CRM's long-form
            field, distinct from the one-line `notes`) opened onto an empty panel and read as
            having no description at all. The CRM's own panel renders all three. */}
        {data?.content ? (
          <section>
            <div className={s.detailKey}>Description</div>
            <div className={s.mdCard}>
              <StreamMarkdown text={data.content} />
            </div>
          </section>
        ) : null}

        {data?.task.notes ? (
          <section>
            <div className={s.detailKey}>Notes</div>
            <div className={s.mdCard}>
              <StreamMarkdown text={data.task.notes} />
            </div>
          </section>
        ) : null}

        {data?.context ? (
          <section>
            <div className={s.detailKey}>Context</div>
            <div className={s.mdCard}>
              <StreamMarkdown text={data.context} />
            </div>
          </section>
        ) : null}

        {/* Loaded, but the task carries nothing to show. Said explicitly, because a panel
            that is simply blank is indistinguishable from one that failed to load. */}
        {data && !data.content && !data.task.notes && !data.context && data.subtasks.length === 0 && data.blockedBy.length === 0 ? (
          <div className={s.muted}>This task has no description, notes or subtasks.</div>
        ) : null}

        {data && data.subtasks.length > 0 ? (
          <section>
            <div className={s.detailKey}>
              Subtasks {data.task.subtaskDone}/{data.task.subtaskCount}
            </div>
            {data.subtasks.map((st) => (
              <button
                key={st.id}
                className={s.subRow}
                title={`Mark as ${st.status === "Fait" ? "À faire" : "Fait"}`}
                onClick={() =>
                  setTaskStatus.mutate({
                    taskId: st.id,
                    status: st.status === "Fait" ? "À faire" : "Fait",
                  })
                }
              >
                <span className={`${s.check} ${st.status === "Fait" ? s.checkOn : ""}`} />
                <span className={st.status === "Fait" ? s.subDone : ""}>{st.title}</span>
              </button>
            ))}
          </section>
        ) : null}
      </div>

      <div className={s.detailFoot}>
        {/* The same two buttons as the row, with the panel's own payload: its long-form
            fields (description, notes, context) are already on screen, so "Discuss"
            pastes them into the prompt instead of making the agent fetch them back. */}
        {data ? (
          <TaskActions
            task={data.task}
            projectId={data.projectId}
            projectName={data.projectName}
            detail={data}
            className={s.detailActs}
          />
        ) : null}
        <span className={s.spacer} />
        {/* Said ONCE, here, rather than on every card that would have carried a link: the
            title/priority/assignee edits this view doesn't do all point at TOSSE, so an
            unreachable CRM is worth a sentence, not silence. */}
        {webUrlError ? (
          <span className={s.muted} title={String(webUrlError.message)}>
            TOSSE link unavailable
          </span>
        ) : (
          <OpenInTosse path={`/tasks/${taskId}`} title="Open this task in TOSSE" />
        )}
      </div>
    </aside>
  );
}

/** A client band: a fold whose header keeps reporting what's inside when closed. */
function ClientBand({
  band,
  offBoardByProject,
  selectedTaskId,
  onOpenTask,
}: {
  band: ReturnType<typeof groupByClient>[number];
  /** status → projectId → that project's off-board tasks, from their own requests. */
  offBoardByProject: Record<string, Record<string, TosseTask[]>>;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const folded = useTosseFold((f) => f.folded[band.key] === true);
  const toggle = useTosseFold((f) => f.toggle);
  const running = band.counts["En cours"] ?? 0;
  const review = band.counts["Review"] ?? 0;
  const todo = band.counts["À faire"] ?? 0;
  return (
    <>
      <button
        className={`${s.band} ${folded ? s.bandFolded : ""}`}
        onClick={() => toggle(band.key)}
        aria-expanded={!folded}
        title={folded ? `Show ${band.name}'s projects` : `Hide ${band.name}'s projects`}
      >
        {/* A real disclosure control, not a bare glyph: it sits in its own hit area and
            ROTATES between states, which is what makes the band read as something you can
            click. The previous ▸/▾ character was easy to miss entirely. */}
        <span className={s.bandChevron}>
          <Ico name="chevron" className="sm" />
        </span>
        <ClientAvatar name={band.name} logoUrl={band.logoUrl} website={band.website} />
        <span className={s.bandName}>{band.name}</span>
        <span className={s.bandRule} />
        {/* Counts stay on a FOLDED band on purpose: a closed client still has to tell you
            whether something in there is running or waiting. */}
        <span className={s.bandCounts}>
          {running > 0 ? <b className={s.cRun}>{running} en cours</b> : null}
          {review > 0 ? <b className={s.cRev}>{review} en revue</b> : null}
          {todo > 0 ? <b className={s.cTodo}>{todo} à faire</b> : null}
        </span>
        <span className={s.bandProjects}>
          {band.projects.length} project{band.projects.length > 1 ? "s" : ""}
        </span>
      </button>
      {folded
        ? null
        : band.projects.map((p, i) => (
            <ProjectCard
              key={p.id}
              project={p}
              index={i}
              paused={p.status === "En pause"}
              offBoard={offBoardForScope(offBoardByProject, p.id)}
              selectedTaskId={selectedTaskId}
              onOpenTask={onOpenTask}
            />
          ))}
    </>
  );
}

export function TosseView({
  onOpenConversation,
}: {
  /** Hand over to the conversation a launch just opened (or reopened). */
  onOpenConversation: (convId: string) => void;
}) {
  // The provider owns "Start"/"Discuss" for every row and panel below it — one place
  // that knows the folder rules, the `/pickup` guard and the one-task-one-agent rule.
  return (
    <TaskLaunchProvider onOpenConversation={onOpenConversation}>
      <TosseBoard />
    </TaskLaunchProvider>
  );
}

/**
 * Whether this board is following the CRM live, and — the part that earns its place — when
 * it is NOT.
 *
 * The failure this guards against is specific: the socket dies, nothing on screen changes,
 * and the view keeps showing a board it has stopped updating. The state itself comes from
 * the core (see `tosse/sse.rs`); what to say about it is a pure function
 * ({@link liveIndicatorView}) so the wording is pinned by tests.
 */
function LiveIndicator() {
  const status = useTosseLive((l) => l.status);
  const view = liveIndicatorView(status);
  if (!view) return null;
  const tone = view.tone === "on" ? s.liveOn : view.tone === "wait" ? s.liveWait : s.liveErr;
  return (
    <span className={`${s.live} ${tone}`} title={view.title}>
      <span className={s.liveDot} />
      {view.label}
      {/* Offered only once the channel reads as DOWN — while it is still cycling quietly
          through its backoff, a button would just be a slower version of what is already
          happening. And it really does reconnect: `tosse_live_start` CUTS a wedged retry
          loop short and reopens at once, rather than answering with the error the user is
          already looking at (see `start` in tosse/sse.rs). */}
      {view.retry ? (
        <button
          className={s.liveRetry}
          onClick={() => {
            void commands.tosseLiveStart();
          }}
        >
          Reconnect
        </button>
      ) : null}
    </span>
  );
}

function TosseBoard() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useTosseBriefing();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const detailWidth = useTosseDetail((d) => d.width);
  const setDetailWidth = useTosseDetail((d) => d.setWidth);
  const totals = useMemo(
    () => briefingTotals(data?.projects ?? [], data?.generalTasks ?? []),
    [data],
  );
  // Each off-board status comes from its own request (the briefing excludes them all
  // server-side), so they are filed under the right card HERE rather than by every card
  // asking for its own.
  //
  // ⚠️ Fixed number of hooks, from a constant list — never a `.map` over data, which would
  // change the hook count between renders the moment a status appeared or vanished.
  const pending = useTosseOffBoard("En attente");
  const backlog = useTosseOffBoard("Backlog");
  const offBoardRows = useMemo<Record<string, TosseOffBoardTask[]>>(
    () => ({ "En attente": pending.data ?? [], Backlog: backlog.data ?? [] }),
    [pending.data, backlog.data],
  );
  const offBoardByProject = useMemo(() => {
    const out: Record<string, Record<string, TosseTask[]>> = {};
    for (const [status, rows] of Object.entries(offBoardRows)) {
      out[status] = groupOffBoardByProject(rows);
    }
    return out;
  }, [offBoardRows]);
  const generalOffBoard = useMemo(() => {
    const out: Record<string, TosseTask[]> = {};
    for (const [status, rows] of Object.entries(offBoardRows)) {
      const tasks = offBoardWithoutProject(rows);
      if (tasks.length) out[status] = tasks;
    }
    return out;
  }, [offBoardRows]);
  // A project whose whole queue is parked is absent from the briefing, so its card has to be
  // BUILT — otherwise its tasks are fetched and then rendered nowhere. See
  // `offBoardProjectCards`.
  const bands = useMemo(() => {
    const extra = offBoardProjectCards(data ?? null, Object.values(offBoardRows));
    return groupByClient([...(data?.projects ?? []), ...extra], data?.pausedProjects ?? []);
  }, [data, offBoardRows]);
  const hasGeneralOffBoard = Object.keys(generalOffBoard).length > 0;

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <TosseCrmMark className="sm" />
        <span className={s.toolbarTitle}>Tasks</span>
        <span className={s.toolbarCounts}>
          {(totals["En cours"] ?? 0) > 0 ? (
            <span>
              <b className={s.cRun}>{totals["En cours"]}</b> En cours
            </span>
          ) : null}
          {(totals["Review"] ?? 0) > 0 ? (
            <span>
              <b className={s.cRev}>{totals["Review"]}</b> {sectionLabel("Review")}
            </span>
          ) : null}
          {(totals["À faire"] ?? 0) > 0 ? (
            <span>
              <b className={s.cTodo}>{totals["À faire"]}</b> À faire
            </span>
          ) : null}
        </span>
        <span className={s.spacer} />
        <LiveIndicator />
        <span className={s.sync}>
          {isFetching
            ? "Syncing…"
            : dataUpdatedAt
              ? `Synced ${new Date(dataUpdatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : ""}
        </span>
        <button className={s.act} onClick={() => void refetch()} disabled={isFetching}>
          {/* Spins while syncing, via the wirekit's existing class — no new CSS. */}
          <Ico name="refresh" className={`sm${isFetching ? " wf-spin-fast" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Connected but the read failed: say why and keep whatever is already on screen
          (stale data beats an empty page — the CRM is not the app's source of truth). */}
      {error ? (
        <div className={s.banner}>
          <span>{String(error.message)}</span>
          <span className={s.spacer} />
          <button className={s.bannerAct} onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className={s.body} ref={bodyRef}>
        <div className={s.scroll}>
          <div className={s.column}>
            {isLoading ? <div className={s.muted}>Loading the briefing…</div> : null}

            {/* ⚠️ Gated on EVERYTHING the page renders, not just the client bands. The
                project-less band is a sibling below, so counting only `bands` printed
                "Nothing open in TOSSE" directly above a list of open tasks — while the
                toolbar, which does count them, announced how many there were. The view
                contradicted itself on the only question it exists to answer. */}
            {!isLoading &&
            bands.length === 0 &&
            (data?.generalTasks.length ?? 0) === 0 &&
            !hasGeneralOffBoard &&
            !error ? (
              <div className={s.empty}>
                <div className={s.emptyBig}>Nothing open in TOSSE</div>
                <div>Every active project is clear. Done tasks live in the CRM.</div>
              </div>
            ) : null}

            {bands.map((band) => (
              <ClientBand
                key={band.key}
                band={band}
                offBoardByProject={offBoardByProject}
                selectedTaskId={openTaskId}
                onOpenTask={setOpenTaskId}
              />
            ))}

            {(data?.generalTasks.length ?? 0) > 0 || hasGeneralOffBoard ? (
              <GeneralTaskBand
                tasks={data?.generalTasks ?? []}
                offBoard={generalOffBoard}
                selectedTaskId={openTaskId}
                onOpenTask={setOpenTaskId}
              />
            ) : null}
          </div>
        </div>

        {openTaskId ? (
          <>
            {/* The panel's width is the user's call and it persists — same treatment as the
                conversations sidebar. */}
            <Splitter
              axis="x"
              onMove={(x) => {
                const box = bodyRef.current?.getBoundingClientRect();
                // The row's width goes with it, so the clamp knows the same cap the CSS
                // applies — otherwise part of the drag stores a width nothing honours.
                if (box) setDetailWidth(box.right - x, box.width);
              }}
            />
            {/* Keyed by task id so switching tasks REPLAYS the section cascade — otherwise
                one task is swapped for another with nothing to mark the change. */}
            <TaskDetail
              key={openTaskId}
              taskId={openTaskId}
              width={detailWidth}
              onClose={() => setOpenTaskId(null)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The « No project » band — the CRM's project-less tasks (an admin task, a phone call…).
 *
 * It owns ONE mutation for the whole band and RENDERS ITS ERROR, exactly like a project
 * card. Before, each row created its own mutation and nobody read the result: a refused
 * write (expired session, offline, a status the CRM rejects) left the row untouched with no
 * message anywhere — indistinguishable from a click that never registered, so the user
 * clicked again and walked away believing the CRM had been updated.
 */
function GeneralTaskBand({
  tasks,
  offBoard,
  selectedTaskId,
  onOpenTask,
}: {
  tasks: TosseTask[];
  /** Off-board tasks that belong to no project either, by status. */
  offBoard: Record<string, TosseTask[]>;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  const taskErrors = useTaskWriteErrors();
  const sections = useMemo(() => statusSections(tasks), [tasks]);
  const folded = useTosseFold((f) => f.folded[GENERAL_FOLD_KEY] === true);
  const toggle = useTosseFold((f) => f.toggle);
  // EVERY row the band holds, off-board ones included — unlike a project card's "N open",
  // which counts live work by definition, this heading claims to count the band's tasks. It
  // read "1 task" above three of them.
  const total =
    tasks.length + Object.values(offBoard).reduce((n, rows) => n + rows.length, 0);
  return (
    <>
      {/* Folds like a client band — it wears the same chevron, so it has to behave the same
          way. Its own fold key, kept out of the client-id namespace. */}
      <button
        className={`${s.band} ${folded ? s.bandFolded : ""}`}
        onClick={() => toggle(GENERAL_FOLD_KEY)}
        aria-expanded={!folded}
        title={folded ? "Show tasks with no project" : "Hide tasks with no project"}
      >
        <span className={s.bandChevron}>
          <Ico name="chevron" className="sm" />
        </span>
        <span className={s.bandName}>No project</span>
        <span className={s.bandRule} />
        <span className={s.bandProjects}>
          {total} task{total > 1 ? "s" : ""}
        </span>
      </button>
      {folded ? null : (
        <div className={s.card}>
          <StatusSections
            sections={sections}
            projectId={null}
            projectName={null}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
            writeErrors={taskErrors.errors}
            onStatus={(task, status) =>
              setTaskStatus.mutate(
                { taskId: task.id, status, title: task.title },
                {
                  onError: (e) => taskErrors.note(task.id, String((e as Error).message)),
                  onSuccess: () => taskErrors.clear(task.id),
                },
              )
            }
          />
          <OffBoardSections
            scopeId={GENERAL_FOLD_KEY}
            offBoard={offBoard}
            projectId={null}
            projectName={null}
            selectedTaskId={selectedTaskId}
            onOpenTask={onOpenTask}
            writeErrors={taskErrors.errors}
            onStatus={(task, status) =>
              setTaskStatus.mutate(
                { taskId: task.id, status, title: task.title },
                {
                  onError: (e) => taskErrors.note(task.id, String((e as Error).message)),
                  onSuccess: () => taskErrors.clear(task.id),
                },
              )
            }
          />
        </div>
      )}
    </>
  );
}
