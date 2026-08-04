// The TOSSE tasks view — the app's third top-level view (⌘3), listing the CRM's active
// projects by client with their open tasks.
//
// Structure is lifted from the CRM's own Briefing page (project card: client, progress
// ring, tasks in status sections), because that page is the one Alexandre already reads
// every morning — but the COLOURS are Flight Deck's, not the CRM's: here blue means "needs
// your eyes" and green means "running", and two views of one app must not disagree.
//
// One request feeds all of it (`tosse_briefing`); the detail panel fetches a task in full
// only when a row is opened. Writes are optimistic with a whole-board rollback, and a
// refused write says why — see `useTosse`.
import { useEffect, useMemo, useRef, useState } from "react";
import { Ico, Menu, MenuItem, TosseCrmMark } from "../../ui/kit";
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
  useTosseBriefing,
  useTosseTaskDetail,
  useTosseWebUrl,
} from "../../ipc/useTosse";
import { AssigneeAvatar, splitMcpActor } from "./AssigneeAvatar";
import { ClientAvatar } from "./ClientAvatar";
import { useTosseFold } from "../../store/tosseFold";

/** Fold key for the project-less band. Prefixed so it can never collide with a client id. */
const GENERAL_FOLD_KEY = "band:general";
import type { TosseProject, TosseTask } from "../../ipc/client";
import {
  briefingTotals,
  groupByClient,
  isOverdue,
  projectActions,
  sectionIcon,
  sectionLabel,
  shortDate,
  statusSections,
  STATUS_TONE,
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

/** A task row. The status dot is the write surface: click it, pick a status. NOT a drag —
 *  dragging means "manual order" everywhere else in this app, and a mis-drop here would
 *  write to the CRM. */
function TaskRow({
  task,
  selected,
  onOpen,
  onStatus,
}: {
  task: TosseTask;
  selected: boolean;
  onOpen: () => void;
  onStatus: (status: string) => void;
}) {
  const tone = STATUS_TONE[task.status] ?? "todo";
  const due = shortDate(task.dueDate);
  const late = isOverdue(task.dueDate, Date.now());
  return (
    <div
      className={`${s.row} ${selected ? s.rowSel : ""}`}
      data-tone={tone}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
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
      {task.assignedTo ? <AssigneeAvatar name={task.assignedTo} /> : null}
      {due ? <span className={`${s.due} ${late ? s.dueLate : ""}`}>{due}</span> : null}
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
  selectedTaskId,
  onOpenTask,
  onStatus,
  writeErrors,
}: {
  sections: StatusSection[];
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
  selectedTaskId,
  onOpenTask,
}: {
  project: TosseProject;
  paused?: boolean;
  /** Position in its band — drives the entry cascade (capped in CSS at 6 steps). */
  index?: number;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  const setProjectStatus = useSetTosseProjectStatus();
  const taskErrors = useTaskWriteErrors();
  const [confirming, setConfirming] = useState<ProjectAction | null>(null);
  const sections = useMemo(() => statusSections(project.tasks), [project.tasks]);
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
      className={`${s.card} ${paused ? s.cardPaused : ""}`}
      style={{ "--i": index ?? 0 } as React.CSSProperties}
    >
      <div className={s.cardHead}>
        <div className={s.cardIdent}>
          <div className={s.cardName}>{project.name}</div>
          <div className={s.cardMeta}>
            {start ? <span>Started {start}</span> : null}
            {due ? <span className={late ? s.dueLate : ""}>Due {due}</span> : null}
            <span>
              {project.tasks.length} open
              {paused ? " · paused" : ""}
            </span>
          </div>
        </div>
        <div className={s.cardTools}>
          {project.taskCount > 0 ? (
            <ProgressRing done={project.taskDone} total={project.taskCount} />
          ) : null}
          <span className={`${s.state} ${s[`state_${stateClass(project.status)}`]}`}>
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
          is the PROJECT's own state change, which has no row to sit under. */}
      {setProjectStatus.error ? (
        <div className={s.rowError}>{String(setProjectStatus.error.message)}</div>
      ) : null}

      {paused ? (
        <div className={s.pausedNote}>Paused — its tasks are hidden. Resume to work on it.</div>
      ) : (
        <>
          <div className={s.cardRule} />
          <StatusSections
            sections={sections}
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
          {sections.length === 0 ? <div className={s.cardEmpty}>No open task</div> : null}
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

function stateClass(status: string | null): string {
  switch (status) {
    case "En cours":
      return "run";
    case "En pause":
      return "pause";
    default:
      return "todo";
  }
}

/** The detail panel: the CRM's task panel, trimmed to what this app can act on. */
function TaskDetail({
  taskId,
  width,
  onClose,
}: {
  taskId: string;
  width: number;
  onClose: () => void;
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
      className={s.detail}
      style={{ "--tosse-detail-w": `${width}px` } as React.CSSProperties}
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
            {/* A TASK's status, so it uses the task colour language — `stateClass` maps
                PROJECT states, and sent everything it didn't know to "todo": a task in
                « Review » came out grey here while the board painted it blue, in the one
                place meant to tell you what the task is. */}
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

      {/* Lot 3 wires "Discuss" and "Start" here — the space is reserved, not faked: an
          inert button that looks live would be worse than none. */}
      <div className={s.detailFoot}>
        <div className={s.muted}>Discuss / Start land here (lot 3).</div>
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
  selectedTaskId,
  onOpenTask,
}: {
  band: ReturnType<typeof groupByClient>[number];
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
              selectedTaskId={selectedTaskId}
              onOpenTask={onOpenTask}
            />
          ))}
    </>
  );
}

export function TosseView() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useTosseBriefing();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const detailWidth = useTosseDetail((d) => d.width);
  const setDetailWidth = useTosseDetail((d) => d.setWidth);
  const bands = useMemo(
    () => groupByClient(data?.projects ?? [], data?.pausedProjects ?? []),
    [data],
  );
  const totals = useMemo(
    () => briefingTotals(data?.projects ?? [], data?.generalTasks ?? []),
    [data],
  );

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
            {!isLoading && bands.length === 0 && (data?.generalTasks.length ?? 0) === 0 && !error ? (
              <div className={s.empty}>
                <div className={s.emptyBig}>Nothing open in TOSSE</div>
                <div>Every active project is clear. Backlog and done tasks live in the CRM.</div>
              </div>
            ) : null}

            {bands.map((band) => (
              <ClientBand
                key={band.key}
                band={band}
                selectedTaskId={openTaskId}
                onOpenTask={setOpenTaskId}
              />
            ))}

            {data && data.generalTasks.length > 0 ? (
              <GeneralTaskBand
                tasks={data.generalTasks}
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
  selectedTaskId,
  onOpenTask,
}: {
  tasks: TosseTask[];
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  const taskErrors = useTaskWriteErrors();
  const sections = useMemo(() => statusSections(tasks), [tasks]);
  const folded = useTosseFold((f) => f.folded[GENERAL_FOLD_KEY] === true);
  const toggle = useTosseFold((f) => f.toggle);
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
          {tasks.length} task{tasks.length > 1 ? "s" : ""}
        </span>
      </button>
      {folded ? null : (
        <div className={s.card}>
          <StatusSections
            sections={sections}
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
