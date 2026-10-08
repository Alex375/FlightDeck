// The background time limit of a shell command (claude 2.1.285+), as the UI words it.
//
// The CLI stops a background `Bash` once it has run for its limit — 30 min unless Claude
// asked for longer through the command's `timeout`, 2 h at most — and says so only in the
// summary of a `stopped` task. The core mirrors the CLI's arithmetic (`bash_limits.rs`) and
// stamps each command with `time_limit_ms` / `deadline_at_ms`, and names the cause of a stop
// it did not come from the user (`stop_cause`). Pure helpers, so the wording is testable.

import type { BackgroundStopCause, BackgroundTask } from "../ipc/client";

/** Under this much time left, the countdown turns to the attention tone. */
export const DEADLINE_NEAR_MS = 5 * 60_000;

/** ms left before the CLI stops a RUNNING command, clamped at 0; `null` when it has no
 *  known deadline (another kind, a foreground command, an older CLI) or is not running. */
export function timeLeftMs(task: BackgroundTask, now: number): number | null {
  if (task.status !== "running" || task.deadline_at_ms == null) return null;
  return Math.max(0, task.deadline_at_ms - now);
}

/** A limit, the way a person states one: "30 min", "2 h", "1 h 30 min", "45 s". */
export function fmtLimit(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The countdown on a running command's row: "1 h 05", "29 min", "< 1 min". Rounded UP to
 *  the minute, so it never reads "0 min" while the command still runs. */
export function fmtTimeLeft(ms: number): string {
  if (ms < 60_000) return "< 1 min";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m.toString().padStart(2, "0")}`;
}

/** Why the CLI stopped a task on its own, as a short clause ("reached its 30 min time
 *  limit"), or `null` when it did not (the user's Stop, a normal end). */
export function stopCauseText(
  cause: BackgroundStopCause | null,
  timeLimitMs: number | null,
): string | null {
  switch (cause) {
    case "deadline":
      return timeLimitMs != null
        ? `reached its ${fmtLimit(timeLimitMs)} time limit`
        : "reached its background time limit";
    case "memory_pressure":
      return "the system ran low on memory";
    case "worker_restart":
      return "its worker process restarted";
    case null:
      return null;
  }
}

/** What a task is called in a stop line: a shell command, or any other background task. */
function noun(task: BackgroundTask): string {
  return task.kind === "bash" ? "Background command" : "Background task";
}

/** The `detail` payload of a `task_stopped` notice, built from the stopped task's snapshot —
 *  the twin of `taskFailedDetail`. `message` is the plain-text line (also what
 *  `read_conversation` hands other agents), `label` the task's name, `reason` the clause,
 *  `detail` the collapsed technical detail. */
export function taskStoppedDetail(task: BackgroundTask): Record<string, string | null> {
  const label = task.label?.trim() || task.command?.trim() || null;
  const reason = stopCauseText(task.stop_cause, task.time_limit_ms);
  const heading = `${noun(task)} stopped`;
  const parts: string[] = [];
  if (task.stop_cause === "deadline") {
    parts.push(
      "Claude Code stops a background command once it has run for its time limit: 30 min, " +
        "unless Claude asked for longer through the command's timeout (2 h at most by default).",
    );
  }
  if (task.summary) parts.push(task.summary);
  if (task.output_file) parts.push(`output: ${task.output_file}`);
  return {
    message: [heading + (label ? `: ${label}` : ""), reason].filter(Boolean).join(" — "),
    heading,
    label,
    reason,
    detail: parts.length ? parts.join("\n") : null,
  };
}

/** Whether a `task_stopped` notice is due for this snapshot — once per RUN, like a failure
 *  (`failureNoticeDue`): a running snapshot re-arms it, a snapshot naming a stop cause
 *  claims it. The bare `stopped` edge (`task_updated{killed}`) lands first WITHOUT a cause,
 *  so it neither claims nor shows anything; the notification right behind it does. */
export function stopNoticeDue(seen: Set<string>, task: BackgroundTask): boolean {
  if (task.status === "running") {
    seen.delete(task.task_id);
    return false;
  }
  if (task.status !== "stopped" || task.stop_cause == null || seen.has(task.task_id)) return false;
  seen.add(task.task_id);
  return true;
}
