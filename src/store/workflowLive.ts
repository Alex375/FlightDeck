// Live, per-phase agent activity for a running workflow, ACCUMULATED from the wire.
//
// Why this exists: the rich manifest (per-phase agents + metrics) is written by the CLI only
// when the run ENDS. During the run the ONLY structured signal is the wire's `task_progress`
// ("<phase>: <label>", emitted once per agent SPAWN). The background-task snapshot keeps just
// the LATEST progress (replace-by-id), so to know how many agents started in EACH phase we
// must accumulate every progress tick here, as it arrives. Combined with the journal's global
// done count (and sequential phases), this drives the per-phase "done/total" the overview shows.
//
// Keyed by a conversation's STABLE id then `task_id` (like backgroundTasksStore). Live-only:
// not persisted, dropped with its conversation.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BackgroundTask } from "../ipc/client";

/** One phase's accumulated agent labels (in first-seen order, deduped). */
export interface WfLivePhase {
  title: string;
  labels: string[];
}

export interface WfLive {
  /** Phases in the order they were first seen on the wire, each with its started agents. */
  phases: WfLivePhase[];
  /** Epoch ms when the app FIRST saw this run running — the only start time we have (the wire
   *  carries none). Approximate (the app is normally open when a run is launched), and used
   *  solely to drive the live view's elapsed timer. Null before the run was ever recorded. */
  startedAt: number | null;
}

const EMPTY: WfLive = { phases: [], startedAt: null };

/** Split a `task_progress` description ("<phase>: <label>") into phase + optional label. */
export function parseWfProgress(progress: string): { phase: string; label: string | null } | null {
  const s = progress.trim();
  if (!s) return null;
  const i = s.indexOf(":");
  if (i < 0) return { phase: s, label: null };
  return { phase: s.slice(0, i).trim(), label: s.slice(i + 1).trim() || null };
}

/** Fold one progress tick into a run's accumulated phases. Returns the SAME object when nothing
 *  changed (idempotent re-delivery) so subscribers don't re-render needlessly. */
export function foldProgress(prev: WfLive, progress: string): WfLive {
  const parsed = parseWfProgress(progress);
  if (!parsed) return prev;
  const { phase, label } = parsed;
  const idx = prev.phases.findIndex((p) => p.title === phase);
  if (idx < 0) {
    return {
      phases: [...prev.phases, { title: phase, labels: label ? [label] : [] }],
      startedAt: prev.startedAt,
    };
  }
  const cur = prev.phases[idx];
  if (!label || cur.labels.includes(label)) return prev; // no new info
  const phases = prev.phases.slice();
  phases[idx] = { title: cur.title, labels: [...cur.labels, label] };
  return { phases, startedAt: prev.startedAt };
}

/** One spawned agent label with the phase it belongs to. */
export interface OrderedLabel {
  label: string;
  phase: string;
}

/** Flatten the accumulated activity into ONE spawn-ordered list of labels (phase order, then
 *  within-phase first-seen order). This mirrors the order the run's journal lists its agents
 *  (both are driven by spawn), so zipping the two by index is what lets the live view attach a
 *  real label to each running agent — approximately, since the two are separate wire signals.
 *  Phases with no label yet contribute nothing. */
export function orderedLabels(live: WfLive): OrderedLabel[] {
  const out: OrderedLabel[] = [];
  for (const p of live.phases) {
    for (const label of p.labels) out.push({ label, phase: p.title });
  }
  return out;
}

interface State {
  runs: Record<string, Record<string, WfLive>>;
  /** Record a workflow task's latest `progress` into its accumulated per-phase activity. */
  record: (session: string, task: BackgroundTask) => void;
  /** Forget a conversation's runs (its conversation was deleted). */
  drop: (session: string) => void;
  /** Forget everything (wipe-all). */
  clear: () => void;
}

export const useWorkflowLiveStore = create<State>((set) => ({
  runs: {},
  record: (session, task) =>
    set((s) => {
      if (task.kind !== "workflow") return s;
      const cur = s.runs[session];
      // A finished run no longer needs its live accumulation — the modal reads the manifest
      // from disk once it's done, and the bar drops it. Purge to bound memory (a long
      // conversation chains many runs). Done BEFORE the progress fold so we never re-add it.
      if (task.status !== "running") {
        if (!cur || !(task.task_id in cur)) return s;
        const next = { ...cur };
        delete next[task.task_id];
        return { runs: { ...s.runs, [session]: next } };
      }
      const map = cur ?? {};
      const prev = map[task.task_id];
      // Stamp the run's first-seen time ONCE (on task_started or the first progress tick),
      // so the live view can show an elapsed timer — the wire carries no start timestamp.
      // A run with no progress yet still gets an entry so the timer can start immediately.
      const base: WfLive = prev ?? { phases: [], startedAt: Date.now() };
      const next = task.progress ? foldProgress(base, task.progress) : base;
      if (prev && next === prev) return s; // idempotent (entry already present, nothing new)
      return { runs: { ...s.runs, [session]: { ...map, [task.task_id]: next } } };
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

/** The accumulated live activity for one workflow run (stable empty fallback). */
export const useWorkflowLive = (session: string, taskId: string): WfLive =>
  useWorkflowLiveStore(useShallow((s) => s.runs[session]?.[taskId] ?? EMPTY));
