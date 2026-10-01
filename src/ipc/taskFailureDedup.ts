// De-dup of the inline "background task failed" notice. The core re-emits a task's full
// snapshot on every transition, so a failed task is seen several times — one notice per RUN.
// A run is delimited by `running` snapshots: a sub-agent woken by SendMessage re-uses its
// task_id for a new run, which may fail again and must be surfaced again.

import type { BackgroundTask } from "./client";

/** Should this snapshot raise the failure notice? Updates `seen` (task ids whose current run
 *  already raised it). */
export function failureNoticeDue(seen: Set<string>, task: BackgroundTask): boolean {
  if (task.status === "running") {
    seen.delete(task.task_id);
    return false;
  }
  if (task.status !== "failed" || seen.has(task.task_id)) return false;
  seen.add(task.task_id);
  return true;
}
