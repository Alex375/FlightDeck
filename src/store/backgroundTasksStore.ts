// The background-task registry: the UI-side mirror of the core's per-session
// `BackgroundTask` map (the socle — see `supervisor::assembler`). The core emits a
// FULL cumulative snapshot of a task on every `session_task` event, so applying one
// is a replace-by-`task_id`, never a patch-merge.
//
// Keyed by a conversation's STABLE id (the event router maps the live handle →
// stable id before calling in), exactly like `conversationStore`. This is a dumb
// data store: the sub-agent / Bash-bg / Monitor / workflow DISPLAY layers read from
// it; no rendering logic lives here (socle/UI separation).

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BackgroundTask } from "../ipc/client";

/** Field-wise equality (everything but the immutable `task_id`), so a duplicated
 *  snapshot — Tauri delivery is at-least-once — is a no-op instead of a re-render. */
function taskEqual(a: BackgroundTask, b: BackgroundTask): boolean {
  return (
    a.kind === b.kind &&
    a.tool_use_id === b.tool_use_id &&
    a.label === b.label &&
    a.command === b.command &&
    a.subagent_type === b.subagent_type &&
    a.model === b.model &&
    a.agent_id === b.agent_id &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.tokens === b.tokens &&
    a.tool_uses === b.tool_uses &&
    a.duration_ms === b.duration_ms &&
    a.summary === b.summary &&
    a.output_file === b.output_file
  );
}

interface BackgroundTasksState {
  /** convId → (task_id → latest cumulative snapshot). */
  sessions: Record<string, Record<string, BackgroundTask>>;
  /** Apply a `session_task` snapshot (replace by `task_id`). */
  applyTask: (session: string, task: BackgroundTask) => void;
  /**
   * The session's process ended: reconcile any task still marked `running` to
   * `stopped`. The terminal `task_*` event can be missed when the whole session
   * exits (or is stopped), which would otherwise leave a "running" task lingering —
   * showing as live in the FlightDeck badge / status of a conversation that's off.
   */
  endSession: (session: string) => void;
  /** Forget a conversation's tasks (its conversation was deleted). */
  dropSession: (session: string) => void;
  /** Forget everything (wipe-all). */
  clear: () => void;
}

export const useBackgroundTasksStore = create<BackgroundTasksState>((set) => ({
  sessions: {},

  applyTask: (session, task) =>
    set((s) => {
      const cur = s.sessions[session] ?? {};
      const prev = cur[task.task_id];
      if (prev && taskEqual(prev, task)) return s; // idempotent re-delivery
      return {
        sessions: { ...s.sessions, [session]: { ...cur, [task.task_id]: task } },
      };
    }),

  endSession: (session) =>
    set((s) => {
      const cur = s.sessions[session];
      if (!cur) return s;
      let changed = false;
      const next: Record<string, BackgroundTask> = {};
      for (const [id, t] of Object.entries(cur)) {
        if (t.status === "running") {
          next[id] = { ...t, status: "stopped" };
          changed = true;
        } else {
          next[id] = t;
        }
      }
      if (!changed) return s;
      return { sessions: { ...s.sessions, [session]: next } };
    }),

  dropSession: (session) =>
    set((s) => {
      if (!s.sessions[session]) return s;
      const next = { ...s.sessions };
      delete next[session];
      return { sessions: next };
    }),

  clear: () => set({ sessions: {} }),
}));

// ---- Selector hooks --------------------------------------------------------

const EMPTY_TASKS: Record<string, BackgroundTask> = {};

/** All background tasks of a conversation, keyed by `task_id`. */
export const useSessionTasks = (
  session: string,
): Record<string, BackgroundTask> =>
  useBackgroundTasksStore(useShallow((s) => s.sessions[session] ?? EMPTY_TASKS));

/**
 * A conversation's RUNNING background shell commands (`kind: "bash"`, status
 * `running`), ordered by `task_id` (stable). The pinned <BashBar> lists exactly these
 * — a finished command drops out of the bar (mirrors AgentBar, which drops a finished
 * agent). The store still keeps the finished snapshot, so an output popover opened
 * mid-run survives the command finishing (it reads the full task map, not this list).
 * Pure (no hook) so it is unit-testable; the hook below wraps it. Monitor (also
 * `local_bash`) is intentionally excluded — it has its own display task.
 */
export function orderBashTasks(
  tasks: Record<string, BackgroundTask>,
): BackgroundTask[] {
  return Object.values(tasks)
    .filter((t) => t.kind === "bash" && t.status === "running")
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/** A conversation's background Bash tasks, ordered for the pinned BashBar. The array
 *  elements are referentially stable across no-op re-deliveries (`taskEqual`), so
 *  `useShallow` re-renders only when a task actually changes or the set changes. */
export const useBackgroundBashTasks = (session: string): BackgroundTask[] =>
  useBackgroundTasksStore(
    useShallow((s) => orderBashTasks(s.sessions[session] ?? EMPTY_TASKS)),
  );

/**
 * A conversation's RUNNING live watches (`kind: "monitor"`, status `running`), ordered
 * by `task_id` (stable). The pinned <MonitorBar> lists exactly these — the watcher drops
 * out of the bar the moment its stream ends (mirrors <BashBar>). A Monitor and a
 * background Bash share `task_type:"local_bash"` on the wire; the core tells them apart
 * by the spawning tool name, so `kind` is the only discriminator here. Pure (no hook) so
 * it is unit-testable; the hook below wraps it. */
export function orderMonitorTasks(
  tasks: Record<string, BackgroundTask>,
): BackgroundTask[] {
  return Object.values(tasks)
    .filter((t) => t.kind === "monitor" && t.status === "running")
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/** A conversation's background Monitor watches, ordered for the pinned MonitorBar. Same
 *  referential-stability guarantee as {@link useBackgroundBashTasks}. */
export const useBackgroundMonitorTasks = (session: string): BackgroundTask[] =>
  useBackgroundTasksStore(
    useShallow((s) => orderMonitorTasks(s.sessions[session] ?? EMPTY_TASKS)),
  );

/**
 * A conversation's RUNNING dynamic-workflow runs (`kind: "workflow"`, status `running`),
 * ordered by `task_id` (stable). The pinned <WorkflowBar> lists exactly these — like every
 * other background-tools bar, a FINISHED run drops out (the bar shows only what is currently
 * running). The post-run rich report is reached from the PERSISTENT inline <WorkflowCard> in
 * the conversation thread, not from this transient bar. A Workflow is ALWAYS a background task
 * (the tool returns immediately with a task id), so there is no foreground variant to exclude.
 * Pure (no hook) so it is unit-testable; the hook below wraps it. */
export function orderWorkflowTasks(
  tasks: Record<string, BackgroundTask>,
): BackgroundTask[] {
  return Object.values(tasks)
    .filter((t) => t.kind === "workflow" && t.status === "running")
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/** A conversation's RUNNING workflow runs, ordered for the pinned WorkflowBar. Same
 *  referential-stability guarantee as {@link useBackgroundBashTasks}. */
export const useBackgroundWorkflowTasks = (session: string): BackgroundTask[] =>
  useBackgroundTasksStore(
    useShallow((s) => orderWorkflowTasks(s.sessions[session] ?? EMPTY_TASKS)),
  );

/** How many background tasks are currently RUNNING for a conversation. Drives the
 *  "backgrounding" agent status (idle main loop + live background work). A plain
 *  number → referentially stable, re-renders only when the count changes. */
/** Running background tasks for ONE conversation, off a raw `sessions` snapshot.
 *
 *  The plain counterpart of {@link useRunningTaskCount}, for callers that already hold the
 *  snapshot and want a single conversation's number — building a whole-fleet map (and its
 *  object) to read one key out of it is the shape this exists to avoid. */
export function runningCountFor(
  sessions: Record<string, Record<string, BackgroundTask>>,
  convId: string,
): number {
  const tasks = sessions[convId];
  if (!tasks) return 0;
  let n = 0;
  for (const t of Object.values(tasks)) if (t.status === "running") n++;
  return n;
}

/** The Bash-only subset of {@link runningCountFor}. Read from the SAME snapshot as the total
 *  so the two stay consistent. */
export function runningBashCountFor(
  sessions: Record<string, Record<string, BackgroundTask>>,
  convId: string,
): number {
  const tasks = sessions[convId];
  if (!tasks) return 0;
  let n = 0;
  for (const t of Object.values(tasks)) if (t.kind === "bash" && t.status === "running") n++;
  return n;
}

export const useRunningTaskCount = (session: string): number =>
  useBackgroundTasksStore((s) => runningCountFor(s.sessions, session));

/** How many background *Bash commands* (`kind: "bash"`) are currently RUNNING for a
 *  conversation. A SUBSET of {@link useRunningTaskCount}; when the two are equal (and
 *  non-zero) the background set is EXCLUSIVELY Bash — the case the "re-alert on background
 *  Bash" setting acts on (see {@link deriveAgentStatus}). A plain number → referentially
 *  stable, re-renders only when the bash count changes. */
export const useRunningBashTaskCount = (session: string): number =>
  useBackgroundTasksStore((s) => runningBashCountFor(s.sessions, session));

/** Running background-task count for EVERY conversation at once, `{ convId → n }`,
 *  omitting the zeros so the object stays small and shallow-stable — re-renders only
 *  when some conversation's count actually moves (a task starts/stops), not on the
 *  frequent progress/token ticks. Feeds the fleet-wide status derivation (readout +
 *  lanes), which must reflect background work without mounting one hook per card. */
export function runningCountsByConv(
  sessions: Record<string, Record<string, BackgroundTask>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [conv, tasks] of Object.entries(sessions)) {
    let n = 0;
    for (const t of Object.values(tasks)) if (t.status === "running") n++;
    if (n > 0) out[conv] = n;
  }
  return out;
}

export const useRunningCountsByConv = (): Record<string, number> =>
  useBackgroundTasksStore(useShallow((s) => runningCountsByConv(s.sessions)));

/** Running background *Bash-command* count for EVERY conversation at once, `{ convId → n }`,
 *  omitting the zeros — the Bash-only counterpart of {@link runningCountsByConv}, feeding the
 *  fleet-wide derivation so it can tell a Bash-only background set from a mixed one without a
 *  per-card hook. Read alongside `runningCountsByConv` from the SAME `sessions` snapshot so the
 *  total and the Bash subset stay consistent within a render. */
export function runningBashCountsByConv(
  sessions: Record<string, Record<string, BackgroundTask>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [conv, tasks] of Object.entries(sessions)) {
    let n = 0;
    for (const t of Object.values(tasks)) if (t.kind === "bash" && t.status === "running") n++;
    if (n > 0) out[conv] = n;
  }
  return out;
}

export const useRunningBashCountsByConv = (): Record<string, number> =>
  useBackgroundTasksStore(useShallow((s) => runningBashCountsByConv(s.sessions)));

/**
 * The background task spawned by a given `tool_use` block (an `Agent` / `Bash` /
 * `Monitor` / `Workflow` card), matched on `tool_use_id`, or `undefined` if the
 * core hasn't reported one (e.g. a resumed conversation — task lifecycle is
 * live-only). The snapshot reference is stable across no-op re-deliveries
 * (`taskEqual`), so this drives a re-render only on a real change.
 */
export const useTaskByToolUse = (
  session: string,
  toolUseId: string,
): BackgroundTask | undefined =>
  useBackgroundTasksStore((s) => {
    const tasks = s.sessions[session];
    if (!tasks) return undefined;
    for (const t of Object.values(tasks)) {
      if (t.tool_use_id === toolUseId) return t;
    }
    return undefined;
  });
