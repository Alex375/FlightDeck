// Pure projections of a workflow run's STREAM snapshot (`WorkflowProgress`, see
// `store/workflowProgress`) onto the shapes the workflow surfaces already render:
//  - the live journal view (`WfJournalView`) every tally, peek and live tree reads — so the
//    existing EXACT live path (agents named by label + phase) works from the stream alone;
//  - the declared phases (with their details), known from t=0;
//  - the per-agent detail only the stream carries mid-run (model, tokens, previews, last tool);
//  - a `WorkflowRun`-shaped report once the run settles, for the rich post-run face when no
//    manifest can be read (a remote run's is on its server).
//
// The entries go through the SAME normalizer as the manifest's (`parseWorkflow`), so the live
// view and the report can never word an agent's state two ways.

import type { WorkflowJournalAgent, WorkflowPhase, WorkflowProgress, WorkflowRun } from "../../ipc/client";
import type { WfJournalView } from "../../store/workflowJournal";
import { isFailedState, isTerminalState, parseWorkflow, type WfAgent, type WfModel } from "./workflowModel";

/** The row key of a stream agent: its run-wide index — one per `agent()` CALL, unchanged when
 *  the CLI retries it (a retry bumps `attempt`, keeps `index`). */
export function streamAgentKey(a: Pick<WfAgent, "index" | "label">, i: number): string {
  return a.index != null ? `wf:${a.index}` : `wf#${i}:${a.label}`;
}

/** The snapshot as the normalized "phases → agents" model (declared phases first, with details). */
export function streamModel(p: WorkflowProgress | null | undefined): WfModel {
  if (!p) return { phases: [], agents: [] };
  return parseWorkflow({ phases: p.declared_phases, workflowProgress: p.entries });
}

/** Whether a snapshot says anything a surface can show: an agent, or at least a phase. */
export function streamUsable(p: WorkflowProgress | null | undefined): p is WorkflowProgress {
  if (!p) return false;
  return modelUsable(streamModel(p));
}

function modelUsable(m: WfModel): boolean {
  return m.agents.length > 0 || m.phases.length > 0;
}

/**
 * A snapshot the CLI redacted (`withholdScriptFromSdkEvents`): it strips every agent's phase
 * title and names the phases "phase N". Its counts are still right, but a local journal — which
 * keeps the script's own names — describes the run better when there is one.
 */
export function streamRedacted(p: WorkflowProgress | null | undefined): boolean {
  if (!p) return false;
  return modelRedacted(streamModel(p));
}

function modelRedacted(m: WfModel): boolean {
  if (m.agents.length === 0) return false;
  const generic = /^phase \d+$/i;
  return m.agents.every((a) => a.phaseTitle == null) && m.phases.every((ph) => generic.test(ph.title));
}

/**
 * Everything a surface derives from one snapshot, in ONE walk of its entries — `useWorkflowJournal`
 * runs in every workflow surface on each snapshot change. `null` when there is nothing to show.
 */
export function streamDerived(
  p: WorkflowProgress | null | undefined,
): { view: WfJournalView; redacted: boolean } | null {
  if (!p) return null;
  const model = streamModel(p);
  if (!modelUsable(model)) return null;
  return { view: journalViewOf(model), redacted: modelRedacted(model) };
}

/** The phase an agent belongs to: its own title, else the declared phase at its index. */
function phaseOf(a: WfAgent, model: WfModel): string | null {
  if (a.phaseTitle) return a.phaseTitle;
  if (a.phaseIndex == null) return null;
  return model.phases.find((ph) => ph.index === a.phaseIndex)?.title ?? null;
}

/**
 * The live journal view of a snapshot — the shape every workflow surface reads. One entry per
 * agent CALL, queued ones included (no id yet): a queued agent counts toward the run's agents
 * (`started` — "0/9 done" with 9 planned reads true) but never as running.
 */
export function streamJournalView(p: WorkflowProgress): WfJournalView {
  return journalViewOf(streamModel(p));
}

function journalViewOf(model: WfModel): WfJournalView {
  const agents: WorkflowJournalAgent[] = model.agents.map((a, i) => ({
    key: streamAgentKey(a, i),
    agentId: a.agentId,
    label: a.label,
    phase: phaseOf(a, model),
    done: isTerminalState(a.state),
    failed: isFailedState(a.state),
    lastStarted: a.startedAt,
  }));
  let done = 0;
  let failed = 0;
  let running = 0;
  let queued = 0;
  for (const a of agents) {
    if (a.done) done++;
    if (a.failed) failed++;
    if (!a.done && a.agentId != null) running++;
    if (!a.done && a.agentId == null) queued++;
  }
  return {
    started: agents.length,
    done,
    failed,
    delivered: Math.max(0, done - failed),
    running,
    queued,
    agents,
    namesAgents: true,
    fromStream: true,
    error: null,
  };
}

/** When the run started, on the CLI's own clock: its first agent's queue (else spawn) time. Null
 *  before any agent exists. Survives a reattach that replays the run, unlike a time the app
 *  stamps when it first sees the run. */
export function streamStartedAt(p: WorkflowProgress | null | undefined): number | null {
  if (!p || !Array.isArray(p.entries)) return null;
  let first: number | null = null;
  for (const e of p.entries) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    if (o.type !== "workflow_agent") continue;
    const t = typeof o.queuedAt === "number" ? o.queuedAt : typeof o.startedAt === "number" ? o.startedAt : null;
    if (t != null && Number.isFinite(t) && (first == null || t < first)) first = t;
  }
  return first;
}

/** The declared phases to show: the script's (with details) when the stream carried it, else the
 *  phases the run itself names (titles only), in order. */
export function streamPhases(p: WorkflowProgress | null | undefined): WorkflowPhase[] {
  if (!p) return [];
  if (p.declared_phases.length > 0) return p.declared_phases;
  // Only a phase the run NAMES: a `workflow_phase` entry (always indexed), or one an agent points
  // at by title or index. `parseWorkflow` also opens a "—" bucket for an agent spawned outside any
  // phase — not a phase: the live tree lists those agents under "(no phase)", and a "—" row here
  // would sit beside it, empty, for the whole run.
  return streamModel(p)
    .phases.filter((ph) => ph.index != null || ph.agents.some((a) => a.phaseTitle != null || a.phaseIndex != null))
    .map((ph) => ({ title: ph.title, detail: ph.detail }));
}

/** Each agent's normalized stream detail, by its row key (see {@link streamAgentKey}). */
export function streamAgentDetails(p: WorkflowProgress | null | undefined): Map<string, WfAgent> {
  const out = new Map<string, WfAgent>();
  if (!p) return out;
  streamModel(p).agents.forEach((a, i) => out.set(streamAgentKey(a, i), a));
  return out;
}

/** "Read src/foo.ts" — what an agent last did, from the stream (refreshed with the snapshot, so
 *  up to ~10 s behind while the agent only works). Null when it has not called a tool yet. */
export function streamActivity(a: Pick<WfAgent, "lastToolName" | "lastToolSummary">): string | null {
  if (!a.lastToolName) return null;
  return a.lastToolSummary ? `${a.lastToolName} ${a.lastToolSummary}` : a.lastToolName;
}

/**
 * A settled run's report, shaped like the end-of-run manifest so the rich face renders it as is.
 * What only the manifest has (the run's return value, its default model) is left empty.
 */
export function streamReport(p: WorkflowProgress, status: string | null | undefined): WorkflowRun {
  const model = streamModel(p);
  return {
    runId: "",
    taskId: p.task_id,
    status: status ?? null,
    workflowName: null,
    defaultModel: null,
    durationMs: p.elapsed_ms,
    agentCount: model.agents.length,
    totalTokens: p.tokens,
    totalToolCalls: p.tool_uses,
    summary: null,
    phases: p.declared_phases,
    workflowProgress: p.entries,
    result: null,
  };
}
