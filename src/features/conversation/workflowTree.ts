// Pure helpers for the workflow detail modal's LIVE per-agent tree.
//
// A workflow is ONE aggregated task on the wire; its inner agents never surface individually,
// and the rich manifest that ties an agent id to its label/phase is written only when the run
// ENDS (verified live on claude 2.1.260). So mid-run we have two SEPARATE spawn-ordered signals:
//   - the run's journal (`WorkflowJournalAgent[]`, in spawn order) → agent ids + done state, and
//   - the wire's `task_progress` accumulated into `OrderedLabel[]` (also spawn order) → labels.
// Neither carries the other's key. Zipping them by index recovers a best-effort agentId↔label
// pairing — approximate (two independent signals can skew), but enough to show a labelled,
// drillable per-agent view instead of opaque ids. All matching is explicitly flagged approximate
// in the UI; the exact mapping arrives with the end-of-run report.

import type { ConversationItem, NormalizedBlock, WorkflowJournalAgent } from "../../ipc/client";
import type { OrderedLabel } from "../../store/workflowLive";

/** One agent in the live tree: its journal identity zipped with its (guessed) label + phase. */
export interface LiveAgent {
  /** The run's agent id — keys its on-disk transcript. Null for a label with no agent yet. */
  agentId: string | null;
  /** The script label, matched by spawn order. Null when we have an id but no label for it. */
  label: string | null;
  /** The phase the label belongs to (compare with `norm`). Null when the label is unknown. */
  phase: string | null;
  /** Whether the journal recorded this agent's result. */
  done: boolean;
}

/** How confidently the two spawn-ordered lists line up — drives the UI's honesty note. */
export type MatchQuality = "aligned" | "partial" | "none";

/** Case/whitespace-insensitive phase-title key, shared with the phase-row builder. */
export const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Zip the journal's spawn-ordered agents with the wire's spawn-ordered labels, index by index.
 * Extra agents (more ids than labels) keep a null label → shown by short id. Extra labels (a
 * label whose agent hasn't registered in the journal yet) keep a null agentId → shown as queued.
 * Order follows the agents when present, else the labels.
 */
export function zipAgentsToLabels(
  agents: WorkflowJournalAgent[],
  labels: OrderedLabel[],
): LiveAgent[] {
  const n = Math.max(agents.length, labels.length);
  const out: LiveAgent[] = [];
  for (let i = 0; i < n; i++) {
    const a = agents[i];
    const l = labels[i];
    out.push({
      agentId: a?.agentId ?? null,
      label: l?.label ?? null,
      phase: l?.phase ?? null,
      done: a?.done ?? false,
    });
  }
  return out;
}

/** Whether the label list and the agent list line up 1:1 (both non-empty and equal length). A
 *  mismatch (retries, same-label fan-out the wire dedups, a lagging signal) means some rows are
 *  a guess or unlabelled → the UI says the mapping is approximate. */
export function matchQuality(agents: WorkflowJournalAgent[], labels: OrderedLabel[]): MatchQuality {
  if (agents.length === 0 && labels.length === 0) return "none";
  return agents.length === labels.length && labels.length > 0 ? "aligned" : "partial";
}

/**
 * Bucket the live agents under phase titles, in the given declared order. An agent whose label
 * (hence phase) is unknown falls into `fallbackPhase` (the wire's current phase) when one is
 * given, else a trailing empty-title bucket — so an unlabelled running agent is still shown,
 * never dropped. Returns entries in `phaseOrder`, then any leftover bucket last.
 */
export function groupAgentsByPhase(
  agents: LiveAgent[],
  phaseOrder: string[],
  fallbackPhase: string | null,
): { phase: string; agents: LiveAgent[] }[] {
  const buckets = new Map<string, LiveAgent[]>();
  const push = (key: string, a: LiveAgent) => {
    const list = buckets.get(key);
    if (list) list.push(a);
    else buckets.set(key, [a]);
  };
  const fallbackKey = fallbackPhase != null ? norm(fallbackPhase) : "";
  for (const a of agents) {
    const key = a.phase != null ? norm(a.phase) : fallbackKey;
    push(key, a);
  }
  const out: { phase: string; agents: LiveAgent[] }[] = [];
  const used = new Set<string>();
  for (const title of phaseOrder) {
    const key = norm(title);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ phase: title, agents: buckets.get(key) ?? [] });
  }
  // Any bucket not covered by a declared phase (incl. the leftover fallback) — keep its agents
  // visible under its own title rather than silently dropping them.
  for (const [key, list] of buckets) {
    if (used.has(key) || list.length === 0) continue;
    used.add(key);
    out.push({ phase: list[0].phase ?? "Agents", agents: list });
  }
  return out;
}

/** One line describing what an agent is doing right now, derived from its transcript tail. */
export interface AgentActivity {
  kind: "tool" | "text" | "thinking" | "starting";
  detail: string;
}

/** The tool-input fields we surface as a target, in priority order — the human-meaningful "what"
 *  of a tool call (a path, a command, a query…). Generic, so an unknown tool still reads well. */
const TARGET_FIELDS = [
  "command",
  "pattern",
  "query",
  "url",
  "file_path",
  "path",
  "notebook_path",
  "description",
  "prompt",
  "subagent_type",
];

/** A compact "<Tool> <target>" label for a tool_use block (target trimmed to one short line). */
export function toolActivityLabel(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    for (const f of TARGET_FIELDS) {
      const v = obj[f];
      if (typeof v === "string" && v.trim()) return `${name} ${clip(oneLine(v), 56)}`;
    }
  }
  return name;
}

/**
 * The last meaningful thing an agent did, read from its normalized transcript (newest last).
 * Walks backward to the last assistant turn and reports its last actionable block: a tool call
 * ("Read src/foo.rs"), else a text/thinking snippet. Null when there's nothing yet (just spawned)
 * — the caller shows a generic "working…".
 */
export function deriveActivity(items: ConversationItem[]): AgentActivity | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "assistant_message") continue;
    const blocks: NormalizedBlock[] = it.blocks;
    for (let b = blocks.length - 1; b >= 0; b--) {
      const blk = blocks[b];
      if (blk.type === "tool_use") return { kind: "tool", detail: toolActivityLabel(blk.name, blk.input) };
      if (blk.type === "text" && blk.text.trim()) return { kind: "text", detail: clip(oneLine(blk.text), 96) };
      if (blk.type === "thinking" && blk.text.trim())
        return { kind: "thinking", detail: clip(oneLine(blk.text), 96) };
    }
  }
  return null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
