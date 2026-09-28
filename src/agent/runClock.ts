// The RUN clock: how long a prompt took, measured from the user's Enter to the moment
// everything it set in motion was done.
//
// A turn is the wrong unit for that. Verified live (claude 2.1.283): one prompt that
// launches background work (a detached sub-agent, a background Bash, a Monitor, a
// workflow…) produces SEVERAL `result`s — the main answer, then one follow-up turn per
// background task that reports back, which the CLI starts on its own (no user line on
// the wire). Timing each turn restarted the live counter on every follow-up and printed
// a short, unrelated duration under each of them ("6s", then "2s", "2s", "1s").
//
// A run groups all of it:
//   - it OPENS on the user's send (a message sent mid-turn joins the turn in flight);
//   - it owns the background tasks first seen while it was the latest run;
//   - a turn the CLI starts on its own JOINS the latest run while that run still has
//     work running, or when its last task just finished (the CLI is waking the agent to
//     report on it) — any other autonomous turn (a scheduled wake-up…) opens a run of
//     its own;
//   - it ENDS the moment nothing of it is left: its main loop is idle and none of its
//     tasks runs. A task that restarts (a sub-agent woken again) reopens it.
//
// Pure and immutable (the store holds one clock per conversation, the UI only reads it),
// so the rules are pinned by tests. Every transition returns the SAME object when nothing
// changes: task snapshots arrive on every progress tick and must not re-render anything.

/** One prompt and everything it set in motion. */
export interface Run {
  /** Wall-clock start: the user's Enter, or the busy edge of an autonomous turn. */
  startedAt: number;
  /** The run's first `turn_result` (the main agent's answer) and when it landed. */
  mainResultId: string | null;
  mainEndedAt: number | null;
  /** The run's latest `turn_result` — where its footer renders — and when it landed. */
  lastResultId: string | null;
  lastResultAt: number | null;
  /** Model time summed over the run's results; `null` once any of them is unknown. */
  modelMs: number | null;
  /** The run's background tasks still running. */
  running: string[];
  /** The run went through a background phase: its main loop idle, work still running. */
  backgrounded: boolean;
  /** Turns the run has started (its main turn + the follow-ups it was woken for). */
  turns: number;
  /** When the run went fully quiet; `null` while any of it is still going. */
  endedAt: number | null;
  /** What made it quiet: its last TASK finishing (the CLI is about to wake the agent to
   *  report on it, and that follow-up belongs here) or a turn ending with nothing left. */
  quietBy: "result" | "task" | null;
  /** When one of its tasks last finished with no turn of the run started since — the CLI
   *  owes it a follow-up turn to report on that task. Cleared when a turn of it starts. */
  wakePendingSince: number | null;
}

/** One conversation's runs, plus the live signals they are settled against. */
export interface RunClock {
  /** Chronological. The last one is "the latest run". */
  runs: Run[];
  /** `turn_result` id → index of its run in {@link runs}. */
  resultRun: Record<string, number>;
  /** Background task id → index of the run that owns it. */
  taskRun: Record<string, number>;
  /** The main loop is running a turn. */
  busy: boolean;
  /** The user's send opened the latest run and its turn has not started yet. */
  awaitingTurn: boolean;
}

export const EMPTY_RUN_CLOCK: RunClock = {
  runs: [],
  resultRun: {},
  taskRun: {},
  busy: false,
  awaitingTurn: false,
};

function newRun(startedAt: number, turns: number): Run {
  return {
    startedAt,
    mainResultId: null,
    mainEndedAt: null,
    lastResultId: null,
    lastResultAt: null,
    modelMs: 0,
    running: [],
    backgrounded: false,
    turns,
    endedAt: null,
    quietBy: null,
    wakePendingSince: null,
  };
}

/** How long after a run went quiet an autonomous turn may still be its follow-up when one
 *  of its tasks finished WHILE a turn ran (the report may have been folded into that turn,
 *  or may come as a turn of its own right after). When the run went quiet BECAUSE a task
 *  finished, the follow-up is certain and no window applies. */
export const FOLLOW_UP_WINDOW_MS = 30_000;

/** The latest run's main loop is working (or about to, right after a send). */
function mainLoopActive(clock: RunClock, idx: number): boolean {
  return idx === clock.runs.length - 1 && (clock.busy || clock.awaitingTurn);
}

/** Re-evaluate run `idx` against the clock's signals: end it when nothing of it is left
 *  (stamping why), reopen it when something of it is going again, and note a background
 *  phase. Returns the same run object when nothing moved. */
function settleRun(clock: RunClock, idx: number, now: number, cause: "result" | "task"): Run {
  const run = clock.runs[idx];
  const loop = mainLoopActive(clock, idx);
  const active = loop || run.running.length > 0;
  let next = run;
  if (!loop && run.running.length > 0 && !run.backgrounded) next = { ...next, backgrounded: true };
  if (!active && next.endedAt == null) next = { ...next, endedAt: now, quietBy: cause };
  else if (active && next.endedAt != null) next = { ...next, endedAt: null, quietBy: null };
  return next;
}

/** Replace run `idx`, keeping the clock identical when the run did not change. */
function withRun(clock: RunClock, idx: number, run: Run): RunClock {
  if (clock.runs[idx] === run) return clock;
  const runs = clock.runs.slice();
  runs[idx] = run;
  return { ...clock, runs };
}

/** Settle every run (a signal that can end several at once: a new run makes the previous
 *  one "not latest", a session end stops everything). */
function settleAll(clock: RunClock, now: number, cause: "result" | "task"): RunClock {
  let out = clock;
  for (let i = 0; i < clock.runs.length; i++) out = withRun(out, i, settleRun(out, i, now, cause));
  return out;
}

/**
 * The user sent a message. Sent while a turn is in flight (`midTurn`), it is injected
 * into that turn — same run. Otherwise it opens a new run; the previous one stays alive
 * as long as its own background tasks run.
 */
export function runSend(clock: RunClock, now: number, midTurn: boolean): RunClock {
  // Busy by the clock's own account counts too: whatever the caller believed, the CLI
  // queues a message sent during a turn into that turn.
  if (midTurn || clock.busy) return clock;
  const opened: RunClock = {
    ...clock,
    runs: [...clock.runs, newRun(now, 0)],
    awaitingTurn: true,
  };
  return settleAll(opened, now, "result");
}

/**
 * The main loop's busy flag moved. A turn starting right after a send is that send's
 * turn; any other start is the CLI's own doing — it joins the latest run while that run
 * is still going or was just emptied by a finishing task, and opens a run otherwise.
 */
export function runBusy(clock: RunClock, busy: boolean, now: number): RunClock {
  if (busy === clock.busy) return clock;
  if (!busy) {
    const idle: RunClock = { ...clock, busy: false };
    const last = idle.runs.length - 1;
    return last < 0 ? idle : withRun(idle, last, settleRun(idle, last, now, "result"));
  }
  const last = clock.runs.length - 1;
  const latest = last >= 0 ? clock.runs[last] : null;
  if (clock.awaitingTurn && latest) {
    const started: RunClock = { ...clock, busy: true, awaitingTurn: false };
    return withRun(started, last, { ...latest, turns: latest.turns + 1, wakePendingSince: null });
  }
  const joins =
    latest != null &&
    (latest.endedAt == null ||
      latest.quietBy === "task" ||
      (latest.wakePendingSince != null && now - latest.endedAt <= FOLLOW_UP_WINDOW_MS));
  if (joins) {
    const started: RunClock = { ...clock, busy: true, awaitingTurn: false };
    const run = { ...latest, turns: latest.turns + 1, wakePendingSince: null };
    return withRun(started, last, settleRun(withRun(started, last, run), last, now, "result"));
  }
  const opened: RunClock = {
    ...clock,
    busy: true,
    awaitingTurn: false,
    runs: [...clock.runs, newRun(now, 1)],
  };
  return settleAll(opened, now, "result");
}

/**
 * A turn finished (`turn_result` `resultId`), with the model time it spent (`null` when
 * unknown). It belongs to the latest run: the first one is the main answer, each later
 * one moves the run's footer down to it. Ignored when no run exists (a turn already in
 * flight before this app instance saw it start) — its footer then falls back to the
 * turn's own duration.
 */
export function runResult(
  clock: RunClock,
  resultId: string,
  now: number,
  modelMs: number | null,
): RunClock {
  const last = clock.runs.length - 1;
  if (last < 0 || clock.resultRun[resultId] != null) return clock;
  const run = clock.runs[last];
  const next: Run = {
    ...run,
    mainResultId: run.mainResultId ?? resultId,
    mainEndedAt: run.mainEndedAt ?? now,
    lastResultId: resultId,
    lastResultAt: now,
    modelMs: run.modelMs == null || modelMs == null ? null : run.modelMs + modelMs,
  };
  return withRun({ ...clock, resultRun: { ...clock.resultRun, [resultId]: last } }, last, next);
}

/**
 * A background task snapshot: `taskId` is (still) running or not. A task is owned by
 * the run that was latest when it was first seen. Its stop can end that run; a restart
 * (a sub-agent woken again) reopens it.
 */
export function runTask(clock: RunClock, taskId: string, running: boolean, now: number): RunClock {
  let owner = clock.taskRun[taskId];
  let base = clock;
  if (owner == null) {
    if (clock.runs.length === 0) return clock;
    owner = clock.runs.length - 1;
    base = { ...clock, taskRun: { ...clock.taskRun, [taskId]: owner } };
  }
  const run = base.runs[owner];
  const has = run.running.includes(taskId);
  if (running === has) return base;
  const nextRun: Run = {
    ...run,
    running: running ? [...run.running, taskId] : run.running.filter((id) => id !== taskId),
    wakePendingSince: running ? run.wakePendingSince : now,
  };
  const moved = withRun(base, owner, nextRun);
  return withRun(moved, owner, settleRun(moved, owner, now, "task"));
}

/** The session is gone (process ended, or turned off): nothing of any run can still be
 *  running, so every open run ends now. */
export function runEndAll(clock: RunClock, now: number): RunClock {
  if (!clock.busy && !clock.awaitingTurn && clock.runs.every((r) => r.endedAt != null)) return clock;
  const runs = clock.runs.map((r) =>
    r.endedAt != null ? r : { ...r, running: [], endedAt: now, quietBy: "result" as const },
  );
  return { ...clock, runs, busy: false, awaitingTurn: false };
}

// ---- reading it ------------------------------------------------------------------

/** What a `turn_result` footer shows for its run. */
export interface RunFooter {
  /** Enter → the main agent's answer. */
  mainMs: number;
  /** Enter → the last of the run's work, once it is all done; `null` while it runs. */
  totalMs: number | null;
  /** Start of the live counter while the main agent is done but background work still
   *  runs (the counter reads from the Enter), `null` otherwise. */
  backgroundSince: number | null;
  /** Background tasks still running (the count shown next to the live counter). */
  backgroundCount: number;
  /** The run outlived its main answer (background phase or follow-up turns): its total
   *  is worth showing next to the main time. */
  extended: boolean;
  /** Model time over the run's turns, `null` when unknown. */
  modelMs: number | null;
}

/**
 * The footer of `turn_result` `resultId`: `null` when its run is unknown (the caller
 * falls back to the turn's own duration), `"hidden"` for a result that is not its run's
 * latest (the run's single footer sits under its latest result, never one per turn).
 */
export function runFooterFor(clock: RunClock | undefined, resultId: string): RunFooter | "hidden" | null {
  if (!clock) return null;
  const idx = clock.resultRun[resultId];
  if (idx == null) return null;
  const run = clock.runs[idx];
  if (run.lastResultId !== resultId) return "hidden";
  const live = run.endedAt == null;
  const backgroundPhase = live && run.running.length > 0 && !mainLoopActive(clock, idx);
  return {
    mainMs: Math.max(0, (run.mainEndedAt ?? run.startedAt) - run.startedAt),
    totalMs: live ? null : Math.max(0, run.endedAt! - run.startedAt),
    backgroundSince: backgroundPhase ? run.startedAt : null,
    backgroundCount: backgroundPhase ? run.running.length : 0,
    extended: run.backgrounded || run.turns > 1,
    modelMs: run.modelMs,
  };
}

/** Start of the latest run while it is still going (the live "working" counter reads
 *  from here, so a follow-up turn never restarts it), `null` otherwise. */
export function liveRunStart(clock: RunClock | undefined): number | null {
  const latest = clock?.runs[clock.runs.length - 1];
  return latest && latest.endedAt == null ? latest.startedAt : null;
}

/** How long the latest run took, Enter → the last of its work, once it is done and has
 *  answered; `null` otherwise (the caller falls back to the last turn's own duration). */
export function settledRunMs(clock: RunClock | undefined): number | null {
  const latest = clock?.runs[clock.runs.length - 1];
  if (!latest || latest.endedAt == null || latest.lastResultId == null) return null;
  return Math.max(0, latest.endedAt - latest.startedAt);
}

/** The run timing a sidebar row needs (see `rowTiming`). All primitives, so a shallow
 *  selector over it re-renders only when one of them moves. */
export interface RowRunClock {
  /** The latest run's start, while it is still going. */
  runLiveSince: number | null;
  /** The latest run's span once it settled: start → end (or → its latest answer while
   *  background work still runs). `null` ends when unknown. */
  runStartedAt: number | null;
  runSettledAt: number | null;
  /** Earliest start among the runs whose background work still runs. */
  backgroundRunSince: number | null;
}

export function rowRunClock(clock: RunClock | undefined): RowRunClock {
  const latest = clock?.runs[clock.runs.length - 1];
  let backgroundRunSince: number | null = null;
  for (const r of clock?.runs ?? []) {
    if (r.endedAt == null && r.running.length > 0) {
      if (backgroundRunSince == null || r.startedAt < backgroundRunSince) backgroundRunSince = r.startedAt;
    }
  }
  return {
    runLiveSince: latest && latest.endedAt == null ? latest.startedAt : null,
    runStartedAt: latest?.startedAt ?? null,
    runSettledAt: latest ? (latest.endedAt ?? latest.lastResultAt) : null,
    backgroundRunSince,
  };
}
