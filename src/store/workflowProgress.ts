// The live per-agent snapshot of each workflow run, as the STREAM carries it
// (`SessionWorkflowProgressEvent`, from `task_progress.workflow_progress`).
//
// Why this exists: a workflow's per-agent state used to come only from disk (the run's journal,
// its script, its end-of-run manifest). For a conversation running on a paired server those files
// live on THAT machine, so the Mac read nothing and every agent showed as "queued". The CLI
// streams the same state, the daemon forwards and replays it, and every workflow surface now
// reads it first — for a local conversation too, so the path the daily local use exercises is the
// one a remote conversation depends on.
//
// Keyed by a conversation's STABLE id, then the run's `task_id` (the wire's run id is not the
// `wf_…` id the ack and the files use). Live-only: not persisted, dropped with its conversation.
// Kept after the run ends — its final snapshot is the post-run report when no manifest can be read.

import { create } from "zustand";
import type { WorkflowProgress } from "../ipc/client";

interface State {
  /** convId → (task_id → latest snapshot). */
  runs: Record<string, Record<string, WorkflowProgress>>;
  /** Store a run's latest snapshot (the core only emits a changed one; a replayed identical
   *  one is still a no-op here, Tauri delivery being at-least-once). */
  apply: (session: string, progress: WorkflowProgress) => void;
  /** Forget a conversation's runs (its conversation was deleted). */
  drop: (session: string) => void;
  /** Forget everything (wipe-all). */
  clear: () => void;
}

/** Field-wise equality of two snapshots — `entries` compared structurally (it is plain JSON). */
export function sameProgress(a: WorkflowProgress, b: WorkflowProgress): boolean {
  return (
    a.task_id === b.task_id &&
    a.tool_use_id === b.tool_use_id &&
    a.settled === b.settled &&
    a.elapsed_ms === b.elapsed_ms &&
    a.tokens === b.tokens &&
    a.tool_uses === b.tool_uses &&
    JSON.stringify(a.declared_phases) === JSON.stringify(b.declared_phases) &&
    JSON.stringify(a.entries) === JSON.stringify(b.entries)
  );
}

export const useWorkflowProgressStore = create<State>((set) => ({
  runs: {},

  apply: (session, progress) =>
    set((s) => {
      const cur = s.runs[session] ?? {};
      const prev = cur[progress.task_id];
      if (prev && sameProgress(prev, progress)) return s;
      return { runs: { ...s.runs, [session]: { ...cur, [progress.task_id]: progress } } };
    }),

  drop: (session) =>
    set((s) => {
      if (!s.runs[session]) return s;
      const runs = { ...s.runs };
      delete runs[session];
      return { runs };
    }),

  clear: () => set({ runs: {} }),
}));

/** One run's stream snapshot, or `null` (none seen yet — an older CLI that streams none, a run
 *  this app session never saw, or no task id to key it by). */
export const useWorkflowProgress = (
  session: string,
  taskId: string | null | undefined,
): WorkflowProgress | null =>
  useWorkflowProgressStore((s) => (taskId ? s.runs[session]?.[taskId] ?? null : null));
