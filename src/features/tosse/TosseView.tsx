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
import { useMemo, useState } from "react";
import { Ico, Menu, MenuItem, TosseCrmMark } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import {
  useCreateTosseTask,
  useSetTosseProjectStatus,
  useSetTosseTaskStatus,
  useTosseBriefing,
  useTosseTaskDetail,
} from "../../ipc/useTosse";
import { useTosseFold } from "../../store/tosseFold";
import type { TosseProject, TosseTask } from "../../ipc/client";
import {
  groupByClient,
  isOverdue,
  projectActions,
  shortDate,
  statusSections,
  STATUS_TONE,
  TASK_STATUS_CHOICES,
  type ProjectAction,
} from "./tosseModel";
import s from "./TosseView.module.css";

/** Initials for a client with no logo — two letters, never an empty plate. */
function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

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
      {task.subtaskCount > 0 ? (
        <span className={s.subs}>
          {task.subtaskDone}/{task.subtaskCount}
        </span>
      ) : null}
      {task.assignedTo ? (
        <span className={s.who} title={task.assignedTo}>
          {task.assignedTo === "Les deux" ? "2" : initials(task.assignedTo)}
        </span>
      ) : null}
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

/** One project: the Briefing's card, with a state control instead of a state label. */
function ProjectCard({
  project,
  paused,
  selectedTaskId,
  onOpenTask,
}: {
  project: TosseProject;
  paused?: boolean;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  const setProjectStatus = useSetTosseProjectStatus();
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
    <div className={`${s.card} ${paused ? s.cardPaused : ""}`}>
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

      {/* A refused write is shown where it happened, not swallowed by the next refetch. */}
      {setProjectStatus.error ? (
        <div className={s.rowError}>{String(setProjectStatus.error.message)}</div>
      ) : null}
      {setTaskStatus.error ? (
        <div className={s.rowError}>{String(setTaskStatus.error.message)}</div>
      ) : null}

      {paused ? (
        <div className={s.pausedNote}>Paused — its tasks are hidden. Resume to work on it.</div>
      ) : (
        <>
          <div className={s.cardRule} />
          {sections.map((section) => (
            <div key={section.status} className={s.section} data-tone={STATUS_TONE[section.status] ?? "todo"}>
              <div className={s.sectionHead}>
                <span className={s.sectionDot} />
                <span className={s.sectionLabel}>{section.status}</span>
                <span className={s.sectionCount}>{section.tasks.length}</span>
                <span className={s.sectionRule} />
              </div>
              {section.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  onOpen={() => onOpenTask(task.id)}
                  onStatus={(status) =>
                    setTaskStatus.mutate({ taskId: task.id, status, title: task.title })
                  }
                />
              ))}
            </div>
          ))}
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
function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { data, isLoading, error } = useTosseTaskDetail(taskId);
  const setTaskStatus = useSetTosseTaskStatus();
  return (
    <aside className={s.detail}>
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
            <span className={`${s.state} ${s[`state_${stateClass(data.task.status)}`]}`}>
              {data.task.status}
            </span>
            {data.task.priority ? (
              <span className={`${s.pri} ${s[`pri_${priorityClass(data.task.priority)}`]}`}>
                {data.task.priority}
              </span>
            ) : null}
            {data.task.kind ? <span className={s.kind}>{data.task.kind}</span> : null}
            {data.task.assignedTo ? <span className={s.kind}>{data.task.assignedTo}</span> : null}
          </div>
        ) : null}
      </div>

      <div className={s.detailBody}>
        {isLoading ? <div className={s.muted}>Loading…</div> : null}
        {error ? <div className={s.rowError}>{String(error.message)}</div> : null}

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

        {data?.task.notes ? (
          <section>
            <div className={s.detailKey}>Notes</div>
            <div className={s.md}>
              <StreamMarkdown text={data.task.notes} />
            </div>
          </section>
        ) : null}

        {data?.context ? (
          <section>
            <div className={s.detailKey}>Context</div>
            <div className={s.md}>
              <StreamMarkdown text={data.context} />
            </div>
          </section>
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
      >
        <span className={s.bandChevron}>{folded ? "▸" : "▾"}</span>
        <span className={s.bandAvatar}>{initials(band.name)}</span>
        <span className={s.bandName}>{band.name}</span>
        <span className={s.bandRule} />
        {/* Counts stay on a FOLDED band on purpose: a closed client still has to tell you
            whether something in there is running or waiting. */}
        <span className={s.bandCounts}>
          {running > 0 ? <b className={s.cRun}>{running} en cours</b> : null}
          {review > 0 ? <b className={s.cRev}>{review} review</b> : null}
          {todo > 0 ? <b className={s.cTodo}>{todo} à faire</b> : null}
        </span>
        <span className={s.bandProjects}>
          {band.projects.length} project{band.projects.length > 1 ? "s" : ""}
        </span>
      </button>
      {folded
        ? null
        : band.projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
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
  const bands = useMemo(
    () => groupByClient(data?.projects ?? [], data?.pausedProjects ?? []),
    [data],
  );
  const totals = useMemo(() => {
    const all = (data?.projects ?? []).flatMap((p) => p.tasks);
    return {
      running: all.filter((t) => t.status === "En cours").length,
      review: all.filter((t) => t.status === "Review").length,
      todo: all.filter((t) => t.status === "À faire").length,
    };
  }, [data]);

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <TosseCrmMark className="sm" />
        <span className={s.toolbarTitle}>Tasks</span>
        <span className={s.toolbarCounts}>
          {totals.running > 0 ? (
            <span>
              <b className={s.cRun}>{totals.running}</b> En cours
            </span>
          ) : null}
          {totals.review > 0 ? (
            <span>
              <b className={s.cRev}>{totals.review}</b> Review
            </span>
          ) : null}
          {totals.todo > 0 ? (
            <span>
              <b className={s.cTodo}>{totals.todo}</b> À faire
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

      <div className={s.body}>
        <div className={s.scroll}>
          <div className={s.column}>
            {isLoading ? <div className={s.muted}>Loading the briefing…</div> : null}

            {!isLoading && bands.length === 0 && !error ? (
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
              <>
                <div className={`${s.band} ${s.bandStatic}`}>
                  <span className={s.bandChevron}>▾</span>
                  <span className={s.bandName}>No project</span>
                  <span className={s.bandRule} />
                  <span className={s.bandProjects}>
                    {data.generalTasks.length} task{data.generalTasks.length > 1 ? "s" : ""}
                  </span>
                </div>
                <div className={s.card}>
                  {statusSections(data.generalTasks).map((section) => (
                    <div key={section.status} className={s.section} data-tone={STATUS_TONE[section.status] ?? "todo"}>
                      <div className={s.sectionHead}>
                        <span className={s.sectionDot} />
                        <span className={s.sectionLabel}>{section.status}</span>
                        <span className={s.sectionCount}>{section.tasks.length}</span>
                        <span className={s.sectionRule} />
                      </div>
                      {section.tasks.map((task) => (
                        <GeneralTaskRow
                          key={task.id}
                          task={task}
                          selected={task.id === openTaskId}
                          onOpen={() => setOpenTaskId(task.id)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>

        {openTaskId ? <TaskDetail taskId={openTaskId} onClose={() => setOpenTaskId(null)} /> : null}
      </div>
    </div>
  );
}

/** A project-less task: same row, but its status writes go through the shared mutation
 *  (there is no card around it to own one). */
function GeneralTaskRow({
  task,
  selected,
  onOpen,
}: {
  task: TosseTask;
  selected: boolean;
  onOpen: () => void;
}) {
  const setTaskStatus = useSetTosseTaskStatus();
  return (
    <TaskRow
      task={task}
      selected={selected}
      onOpen={onOpen}
      onStatus={(status) => setTaskStatus.mutate({ taskId: task.id, status })}
    />
  );
}
