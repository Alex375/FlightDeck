// Normalizer for a dynamic-workflow run manifest (`workflows/wf_<id>.json`, loaded via
// `load_workflow_run`). The core keeps the dynamic `workflowProgress` array RAW (its
// entries are per-run-shaped — `{type:"workflow_phase"|"workflow_agent", …}`), so the
// shaping into the `/workflows`-style "phases → agents" tree happens here, on the front.
// Pure + framework-free so it is unit-testable and shared by the detail modal and the
// pinned bar.
//
// The agent entries carry the rich per-agent detail the view shows (state, model, tokens,
// tool-calls, duration, prompt/result previews) and — crucially — the `agentId` that
// bridges to each agent's transcript on disk (`load_subagent_transcript`).

import type { JsonValue, WorkflowRun } from "../../ipc/client";
import type { StreamState } from "../../ui/kit";

/** One agent of a workflow phase, normalized from a `workflow_agent` progress entry. */
export interface WfAgent {
  /** Run-wide ordinal (manifest `index`), or null if absent. */
  index: number | null;
  label: string;
  phaseTitle: string | null;
  phaseIndex: number | null;
  /** The key for the on-disk transcript (`load_subagent_transcript`). */
  agentId: string | null;
  agentType: string | null;
  model: string | null;
  /** Raw lifecycle state: "queued" | "running" | "done" | "error" | … (kept verbatim
   *  for forward-compat; map to a dot via {@link wfStateDot}). */
  state: string;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  promptPreview: string | null;
  resultPreview: string | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
}

/** One phase of a workflow run, with its agents attached in run order. */
export interface WfPhase {
  title: string;
  detail: string | null;
  /** Declared phase ordinal (manifest `phases[]`/`workflow_phase.index`), or null. */
  index: number | null;
  agents: WfAgent[];
}

export interface WfModel {
  phases: WfPhase[];
  /** Every agent, flat and in order — for run-wide counts and the "all phases" view. */
  agents: WfAgent[];
}

// ---- raw-JSON accessors (defensive: the manifest is hand-shaped, kept raw) ----------

function asObj(v: JsonValue | undefined): Record<string, JsonValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : null;
}
function str(o: Record<string, JsonValue>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" ? v : null;
}
function num(o: Record<string, JsonValue>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toAgent(o: Record<string, JsonValue>): WfAgent {
  return {
    index: num(o, "index"),
    label: str(o, "label") ?? str(o, "agentId") ?? "agent",
    phaseTitle: str(o, "phaseTitle"),
    phaseIndex: num(o, "phaseIndex"),
    agentId: str(o, "agentId"),
    agentType: str(o, "agentType"),
    model: str(o, "model"),
    state: str(o, "state") ?? "running",
    tokens: num(o, "tokens"),
    toolCalls: num(o, "toolCalls"),
    durationMs: num(o, "durationMs"),
    promptPreview: str(o, "promptPreview"),
    resultPreview: str(o, "resultPreview"),
    lastToolName: str(o, "lastToolName"),
    lastToolSummary: str(o, "lastToolSummary"),
  };
}

/**
 * Shape a manifest into ordered phases with their agents.
 *
 * The declared `phases[]` (the script's `meta.phases`) seed the order and are pushed
 * UNCONDITIONALLY — even two phases with the SAME title both appear (a homonym phase is never
 * merged away / lost). The lookup maps (by title / by declared index) exist only to ATTACH
 * agents to an existing phase; an agent/progress entry that matches none creates a new phase,
 * and an orphan agent (no phase info) lands in a synthetic "—" phase so it's never dropped.
 */
export function parseWorkflow(run: WorkflowRun | null | undefined): WfModel {
  if (!run) return { phases: [], agents: [] };

  const phases: WfPhase[] = [];
  const byTitle = new Map<string, WfPhase>(); // first phase of a given title (for agent attach)
  const byIndex = new Map<number, WfPhase>(); // phase by its declared progress index

  function register(p: WfPhase): WfPhase {
    phases.push(p);
    if (p.title && !byTitle.has(p.title)) byTitle.set(p.title, p);
    if (p.index != null && !byIndex.has(p.index)) byIndex.set(p.index, p);
    return p;
  }

  // Find the phase an agent/progress entry belongs to (by title, then declared index); only
  // create a NEW phase when none matches. Backfills detail/index onto the matched phase.
  function phaseFor(title: string | null, index: number | null, detail: string | null): WfPhase {
    const existing =
      (title != null ? byTitle.get(title) : undefined) ??
      (index != null ? byIndex.get(index) : undefined);
    if (existing) {
      if (detail && !existing.detail) existing.detail = detail;
      if (existing.index == null && index != null) {
        existing.index = index;
        if (!byIndex.has(index)) byIndex.set(index, existing);
      }
      return existing;
    }
    return register({ title: title ?? "—", detail, index, agents: [] });
  }

  // 1. Declared phases, in order — ALWAYS pushed (homonyms preserved).
  for (const ph of run.phases ?? []) register({ title: ph.title, detail: ph.detail ?? null, index: null, agents: [] });

  // 2. Walk the raw progress: match phases it mentions (or create), attach every agent.
  const agents: WfAgent[] = [];
  const progress = Array.isArray(run.workflowProgress) ? (run.workflowProgress as JsonValue[]) : [];
  for (const entry of progress) {
    const o = asObj(entry);
    if (!o) continue;
    const type = str(o, "type");
    if (type === "workflow_phase") {
      phaseFor(str(o, "title"), num(o, "index"), null);
    } else if (type === "workflow_agent") {
      const a = toAgent(o);
      agents.push(a);
      phaseFor(a.phaseTitle, a.phaseIndex, null).agents.push(a);
    }
  }

  return { phases, agents };
}

/** Settled (`done`, failures included), failed and total counts over a list of agents — the same
 *  three numbers the live journal gives, so the report words a run exactly like the live view. */
function progressOf(agents: WfAgent[]): { done: number; failed: number; total: number } {
  let done = 0;
  let failed = 0;
  for (const a of agents) {
    if (isTerminalState(a.state)) done++;
    if (isFailedState(a.state)) failed++;
  }
  return { done, failed, total: agents.length };
}

/** A phase's settled/failed/total — the phase row shows "delivered/total" + failures from it. */
export function phaseProgress(phase: WfPhase): { done: number; failed: number; total: number } {
  return progressOf(phase.agents);
}

/** Run-wide settled/failed/total across every agent. */
export function runProgress(model: WfModel): { done: number; failed: number; total: number } {
  return progressOf(model.agents);
}

/**
 * Whether a manifest on disk is THIS execution's end-of-run report. Never while the run is going
 * (it has none yet — any report under the run id is a PREVIOUS execution's, from before a
 * resume), and only when it was written by this execution's task. Anything else would show an
 * earlier run's outcome — a re-executed call as delivered, its failure as a success — in place
 * of this one's. An unknown id on either side (an old manifest without `taskId`, a card whose ack
 * carried none) cannot be told apart, so it is accepted.
 */
export function acceptReport(
  run: WorkflowRun | null,
  running: boolean,
  taskId: string | null | undefined,
): WorkflowRun | null {
  if (running || run == null) return null;
  return taskId == null || run.taskId == null || run.taskId === taskId ? run : null;
}

/** A workflow agent state that means "no longer working" (settled), for the X/N count. */
export function isTerminalState(state: string): boolean {
  const s = state.toLowerCase();
  return s === "done" || s === "completed" || s === "error" || s === "failed" || s === "skipped";
}

/** A settled state that is a FAILURE — counted apart, never as delivered. */
export function isFailedState(state: string): boolean {
  const s = state.toLowerCase();
  return s === "error" || s === "failed";
}

/** Map a raw workflow-agent state to the design's status-dot colour token. Unknown
 *  states fall through to the running look (forward-compat). */
export function wfStateDot(state: string): StreamState {
  switch (state.toLowerCase()) {
    case "done":
    case "completed":
      return "done";
    case "error":
    case "failed":
      return "err";
    case "queued":
    case "pending":
    case "skipped":
      return "off";
    default:
      return "work";
  }
}
