// Pure helpers for the workflow detail modal's LIVE per-agent tree.
//
// A workflow is ONE aggregated task on the wire; its inner agents never surface individually, and
// the rich manifest is written only when the run ENDS. Mid-run, the run's journal is the source:
//   - Recent claude versions (around 2.1.270 and later) write each agent's script `label` +
//     `phase` on its `started` entry, so the journal alone names every agent EXACTLY (see
//     `liveAgents`).
//   - Older binaries wrote ids only. There, the wire's `task_progress` accumulated into
//     `OrderedLabel[]` (spawn order) is zipped by index with the journal's agents (also spawn
//     order) — a best-effort pairing, said to be approximate on screen. It cannot name agents that
//     share a label (the wire accumulation dedups them), which is why the exact path exists.

import type { ConversationItem, NormalizedBlock, WorkflowJournalAgent } from "../../ipc/client";
import { progressText, type WfJournalView } from "../../store/workflowJournal";
import { orderedLabels, type OrderedLabel, type WfLive } from "../../store/workflowLive";

/** One agent in the live tree. */
export interface LiveAgent {
  /** Stable identity of the agent CALL — unchanged when the CLI retries or re-runs it, so it is
   *  what a row and a selection are keyed by (the agent id moves to each new attempt). */
  key: string;
  /** The current attempt's agent id — keys its on-disk transcript. Null when there is none: a
   *  wire label whose agent hasn't registered yet (by-index path), or a call that failed before
   *  it ever spawned. */
  agentId: string | null;
  /** The script label: the journal's own (claude ≥ 2.1.272), or — for an older journal — the
   *  wire label paired by spawn order. Null when unknown. */
  label: string | null;
  /** The phase the agent ran in (compare with `norm`). Null = in NO phase (a named agent the
   *  script spawned before its first phase) or UNKNOWN (an unlabelled agent, a call that failed
   *  before spawning) — {@link bucketOf} tells the two apart. */
  phase: string | null;
  /** Whether the journal recorded this agent as settled (`result` or `failed`). */
  done: boolean;
  /** Whether it settled by failing. */
  failed: boolean;
  /** Journal line of this call's latest start — recency, which list order is not (a re-run call
   *  keeps its first-seen slot). Null for a call that never spawned, or a wire-only label. */
  lastStarted: number | null;
}

/** Bucket key of the agents the script spawned in no phase. A value no phase title can
 *  normalize to, so a real phase of any name never absorbs them. */
export const UNPHASED_KEY = "\u0000unphased";
/** What that bucket is called on screen — parenthesized, so it never reads as a script phase. */
export const UNPHASED_TITLE = "(no phase)";
/** Bucket key of the calls that failed before spawning: the CLI records no phase for them, so
 *  their phase is UNKNOWN — saying "no phase" would be false. */
export const NOSTART_KEY = "\u0000nostart";
/** What that bucket is called on screen. */
export const NOSTART_TITLE = "(failed before start)";
/** Bucket key of the spawned agents whose phase we cannot know: an unlabelled agent no wire
 *  label could be paired with (older journal), or a cross-version resume's old entry. */
export const UNKNOWN_KEY = "\u0000unknown";
/** What that bucket is called on screen. */
export const UNKNOWN_TITLE = "(phase unknown)";

/** Case/whitespace-insensitive phase-title key, shared with the phase-row builders. */
export const norm = (s: string): string => s.trim().toLowerCase();

/**
 * The bucket an agent belongs to — the key its phase row carries:
 *  - its phase, when known;
 *  - a call that failed before spawning (no id, no phase) → {@link NOSTART_KEY};
 *  - a NAMED agent with no phase (spawned outside any phase) → `fallbackKey`, which on the exact
 *    path is {@link UNPHASED_KEY};
 *  - an UNNAMED one → `fallbackKey` when that is a real guess (the by-index path's wire phase),
 *    else {@link UNKNOWN_KEY}: without a label we cannot tell "no phase" from "unknown".
 */
export function bucketOf(a: LiveAgent, fallbackKey: string = UNPHASED_KEY): string {
  if (a.phase != null) return norm(a.phase);
  if (a.failed && a.agentId == null) return NOSTART_KEY;
  if (a.label == null && fallbackKey === UNPHASED_KEY) return UNKNOWN_KEY;
  return fallbackKey;
}

/** Whether a bucket key is one of ours rather than a script phase. */
export function isSyntheticKey(key: string): boolean {
  return key === UNPHASED_KEY || key === NOSTART_KEY || key === UNKNOWN_KEY;
}

/** The title of a synthetic bucket (or `null` for a real phase key). */
function bucketTitle(key: string): string | null {
  return key === UNPHASED_KEY
    ? UNPHASED_TITLE
    : key === NOSTART_KEY
      ? NOSTART_TITLE
      : key === UNKNOWN_KEY
        ? UNKNOWN_TITLE
        : null;
}

type Dated = { phase: string | null; label?: string | null; lastStarted: number | null };

/** The most recently STARTED agent that has a phase (by `lastStarted`, not list order — a call a
 *  resumed run re-executes keeps its first-seen slot), or null. */
function latestPhased<T extends Dated>(agents: T[]): T | null {
  let best: T | null = null;
  for (const a of agents) {
    if (a.phase == null) continue;
    if (best == null || (a.lastStarted ?? -1) >= (best.lastStarted ?? -1)) best = a;
  }
  return best;
}

/**
 * The phase the run is in right now, from the journal alone: while it runs, the phase of the
 * most recently started agent that has one. The wire's `task_progress` is NOT used: for an agent
 * spawned outside any phase it carries the bare label, which would read as a phase (and
 * "review:tests" as the phase "review"). `null` once the run is over, or before any phased agent
 * spawned.
 */
export function journalCurrentPhase(agents: Dated[], running: boolean): string | null {
  return running ? latestPhased(agents)?.phase ?? null : null;
}

/** {@link journalCurrentPhase} as a bucket key. */
export function journalCurrentPhaseKey(agents: Dated[], running: boolean): string | null {
  const phase = journalCurrentPhase(agents, running);
  return phase != null ? norm(phase) : null;
}

/** The label of the most recently started agent of a phase bucket — "what the run is doing". */
export function latestLabelIn(agents: LiveAgent[], key: string): string | null {
  return latestPhased(agents.filter((a) => a.phase != null && norm(a.phase) === key))?.label ?? null;
}

/**
 * The current step a compact surface (inline card, Flight Deck peek) names: the journal's own
 * current phase when it names its agents and can still be read; else the wire's "<phase>:" word;
 * nothing once the run is over. One rule, so two surfaces never name different phases.
 */
export function currentStepLabel(
  journal: Pick<WfJournalView, "agents" | "namesAgents" | "error">,
  progress: string | null | undefined,
  running: boolean,
): string | null {
  if (!running) return null;
  if (!journal.error && journalNamesAgents(journal)) return journalCurrentPhase(journal.agents, true);
  return progress ? progress.split(":")[0]?.trim() || null : null;
}

/** Whether the journal names its agents itself (a recent claude) — i.e. the live tree can be
 *  exact instead of a by-index guess. The journal's own flag (its `launched` header) decides from
 *  the first line; any label or phase seen also proves it. */
export function journalNamesAgents(journal: {
  agents: WorkflowJournalAgent[];
  namesAgents?: boolean;
}): boolean {
  return (
    journal.namesAgents === true || journal.agents.some((a) => a.label != null || a.phase != null)
  );
}

/**
 * The live per-agent list. When the journal names its agents (`exact`), each one carries its OWN
 * label and phase — exact, whatever the fan-out (two agents sharing a label stay two named
 * agents). Only an older journal falls back to the by-index zip with the wire's labels.
 */
export function liveAgents(
  agents: WorkflowJournalAgent[],
  labels: OrderedLabel[],
  exact: boolean,
): LiveAgent[] {
  if (!exact) return zipAgentsToLabels(agents, labels);
  return agents.map((a) => ({
    key: a.key,
    agentId: a.agentId,
    label: a.label,
    phase: a.phase,
    done: a.done,
    failed: a.failed,
    lastStarted: a.lastStarted,
  }));
}

/** How confidently the two spawn-ordered lists line up — drives the UI's honesty note. */
export type MatchQuality = "aligned" | "partial" | "none";

/**
 * Zip the journal's spawn-ordered agents with the wire's spawn-ordered labels, index by index.
 * Only SPAWNED agents (with an id) take part: a call that died before spawning is assumed to have
 * emitted no wire label on the older CLIs this path serves (unverifiable — no such binary at
 * hand; recent ones do emit one, but they take the exact path). Extra agents (more ids than labels)
 * keep a null label → shown by short id. Extra labels (a label whose agent hasn't registered in
 * the journal yet) keep a null agentId → shown as queued. The unspawned entries follow, unlabelled.
 */
export function zipAgentsToLabels(
  agents: WorkflowJournalAgent[],
  labels: OrderedLabel[],
): LiveAgent[] {
  // "Spawned" = it has a `started` (`lastStarted`). A missing agentId alone is not enough: a
  // call re-run after a resume that then dies before spawning loses its id, yet it DID emit a
  // wire label the first time.
  const spawned = agents.filter((a) => a.lastStarted != null || a.agentId != null);
  const n = Math.max(spawned.length, labels.length);
  const out: LiveAgent[] = [];
  for (let i = 0; i < n; i++) {
    const a = spawned[i];
    const l = labels[i];
    out.push({
      key: a?.key ?? `queued:${i}`,
      agentId: a?.agentId ?? null,
      label: l?.label ?? null,
      phase: l?.phase ?? null,
      done: a?.done ?? false,
      failed: a?.failed ?? false,
      lastStarted: a?.lastStarted ?? null,
    });
  }
  for (const a of agents) {
    if (a.lastStarted != null || a.agentId != null) continue;
    out.push({
      key: a.key,
      agentId: null,
      label: null,
      phase: null,
      done: a.done,
      failed: a.failed,
      lastStarted: a.lastStarted,
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
 * Bucket the live agents by {@link bucketOf}, in list order. A phase-less agent goes to
 * `fallbackKey`: the phase-less bucket on the exact path; on the by-index path the wire's current
 * phase (an unlabelled agent there is most likely one that phase just spawned). Pair with
 * {@link withOrphanRows} so a bucket no phase row covers is still shown, never dropped.
 */
export function agentsByPhaseKey(agents: LiveAgent[], fallbackKey: string): Map<string, LiveAgent[]> {
  const out = new Map<string, LiveAgent[]>();
  for (const a of agents) {
    const k = bucketOf(a, fallbackKey);
    const list = out.get(k);
    if (list) list.push(a);
    else out.set(k, [a]);
  }
  return out;
}

/** A live phase row's state: settled, in progress, or not reached yet. */
export type LivePhaseState = "done" | "cur" | "todo";

/** One live phase row: its agent counts and state. */
export interface LivePhaseRow {
  /** Bucket key of the row's agents ({@link bucketOf}); unique per row — a repeated (homonym)
   *  title gets a private key so its slot never shows the first slot's agents twice. */
  key: string;
  title: string;
  /** One of OUR buckets ("(no phase)", "(failed before start)", "(phase unknown)"), not a script
   *  phase — rendered apart, since a script may name a phase the same. */
  synthetic: boolean;
  detail: string | null;
  /** Agents launched in this phase. */
  started: number;
  /** Of those, the agents that have settled — delivered OR failed. */
  done: number;
  /** Of `done`, the agents that failed. */
  failed: number;
  state: LivePhaseState;
}

/**
 * The live phase rows when the journal names its agents — built from the journal ALONE (the
 * wire's progress string misreads a phase-less agent's bare label as a phase; see
 * {@link journalCurrentPhaseKey}). Each phase's counts are those of the journal agents in THAT
 * phase — the same list the Agents column shows — so an agent can never be listed under a phase
 * yet missing from its count (the bug of the by-index path, whose counts came from the wire's
 * deduped labels).
 *
 * Order: declared phases first (a homonym gets its own slot, but only the FIRST occurrence
 * carries the agents, so a duplicate title is never double-counted), then the buckets only the
 * agents know (first-seen order: undeclared phases and our synthetic buckets). State: a phase
 * with an agent in flight — or, while the run lives, the current phase, which may still spawn
 * more — is current; one whose agents have all settled is done; an empty DECLARED phase before
 * the last declared phase that ran was passed through (whether or not the run still lives); the
 * rest are upcoming.
 */
export function exactPhaseRows(
  declared: { title: string; detail?: string | null }[],
  agents: LiveAgent[],
  running: boolean,
): LivePhaseRow[] {
  const tally = new Map<string, { started: number; done: number; failed: number; title: string }>();
  for (const a of agents) {
    const k = bucketOf(a);
    const t = tally.get(k) ?? { started: 0, done: 0, failed: 0, title: a.phase ?? bucketTitle(k) ?? k };
    t.started += 1;
    if (a.done) t.done += 1;
    if (a.failed) t.failed += 1;
    tally.set(k, t);
  }
  const order: Omit<LivePhaseRow, "state">[] = [];
  const used = new Set<string>();
  const add = (k: string, title: string, detail: string | null) => {
    const synthetic = isSyntheticKey(k);
    if (used.has(k)) {
      order.push({ key: `${k}\u0000${order.length}`, title, detail, synthetic, started: 0, done: 0, failed: 0 });
      return;
    }
    used.add(k);
    const t = tally.get(k);
    order.push({
      key: k,
      title,
      detail,
      synthetic,
      started: t?.started ?? 0,
      done: t?.done ?? 0,
      failed: t?.failed ?? 0,
    });
  };
  for (const p of declared) add(norm(p.title), p.title, p.detail ?? null);
  for (const [k, t] of tally) if (!used.has(k)) add(k, t.title, null);

  const curKey = journalCurrentPhaseKey(agents, running);
  const curIdx = curKey != null ? order.findIndex((p) => p.key === curKey) : -1;
  // The last DECLARED phase the run reached: an empty declared phase before it was skipped. Only
  // declared order counts — an undeclared phase is appended last and says nothing about which
  // declared phases are behind the run.
  let reached = -1;
  for (let i = 0; i < declared.length; i++) if (order[i].started > 0) reached = i;
  return order.map((p, i) => {
    let state: LivePhaseState;
    if (p.done < p.started || i === curIdx) state = "cur";
    else if (p.started > 0 || (i < declared.length && i < reached)) state = "done";
    else state = "todo";
    return { ...p, state };
  });
}

/**
 * Append a row for every agent bucket no row covers, so no agent is ever listed nowhere: on the
 * by-index path an agent's guessed phase (or the fallback bucket) may match no declared phase.
 * A no-op on the exact path, whose rows are built from the agents themselves.
 */
export function withOrphanRows(rows: LivePhaseRow[], byKey: Map<string, LiveAgent[]>): LivePhaseRow[] {
  const have = new Set(rows.map((r) => r.key));
  const extra: LivePhaseRow[] = [];
  for (const [key, list] of byKey) {
    if (have.has(key) || list.length === 0) continue;
    const done = list.filter((a) => a.done).length;
    extra.push({
      key,
      title: bucketTitle(key) ?? list[0].phase ?? UNKNOWN_TITLE,
      synthetic: isSyntheticKey(key),
      detail: null,
      started: list.length,
      done,
      failed: list.filter((a) => a.failed).length,
      state: done < list.length ? "cur" : "done",
    });
  }
  return extra.length > 0 ? [...rows, ...extra] : rows;
}

/** The tone a phase's dot and count badge take: its state, except that a phase with a failed
 *  agent reads as an ERROR once it is no longer in progress — never as a green success. */
export type PhaseTone = LivePhaseState | "err";

/**
 * How a phase row reads, worded like every other workflow surface: "delivered/started" plus the
 * failures (see `progressText`).
 *
 * `settled` = the RUN is over: nothing can then be "in progress" whatever the state says (a
 * killed run leaves agents unclosed; a report marks an incomplete phase current). Failures show
 * in the error tone, agents the journal never closed are named ("· N no result") and the phase
 * loses its in-progress accent; nothing is "upcoming" any more. A phase nothing was launched in
 * reads `emptyText` while upcoming in a live run, else a neutral "—" — never a green "done".
 */
export function phaseRowView(
  r: { started: number; done: number; failed: number; state: LivePhaseState },
  emptyText = "upcoming",
  settled = false,
): { count: string; tone: PhaseTone } {
  if (r.started === 0) {
    return {
      count: r.state === "todo" && !settled ? emptyText : "—",
      tone: r.state === "cur" && !settled ? "cur" : "todo",
    };
  }
  const noResult = settled ? Math.max(0, r.started - r.done) : 0;
  return {
    count: progressText(r.done - r.failed, r.started, r.failed, undefined, noResult),
    tone:
      r.failed > 0 && (settled || r.state !== "cur")
        ? "err"
        : settled && r.state === "cur"
          ? "todo"
          : r.state,
  };
}

/** The live per-phase tree both live faces render. */
export interface LiveTree {
  /** Whether the journal names its agents (a recent claude) — the exact path. */
  exact: boolean;
  agents: LiveAgent[];
  byPhase: Map<string, LiveAgent[]>;
  rows: LivePhaseRow[];
  /** The current phase's row key, and what the run is doing in it. */
  curKey: string | null;
  curLabel: string | null;
}

/**
 * Derive the live tree — ONE derivation for the 3-panel view and the classic overview.
 *
 * EXACT path (the journal names its agents): everything from the journal — rows, counts, the
 * current phase and its latest label (see `exactPhaseRows` / `journalCurrentPhaseKey`; the
 * wire's progress string misreads a phase-less agent's bare label as a phase). A journal that
 * can no longer be read (`error`) is NOT trusted for the current phase: its last snapshot would
 * freeze it — the wire's word is used instead.
 *
 * LEGACY path (a journal without labels): see {@link legacyPhaseRows}; the current phase and
 * label come from the wire, and only while the run lives.
 */
export function liveTree(
  phases: { title: string; detail?: string | null }[],
  journal: Pick<WfJournalView, "agents" | "namesAgents" | "delivered" | "error">,
  liveActivity: WfLive,
  wireCur: { phase: string; label: string | null } | null,
  running: boolean,
): LiveTree {
  const exact = journalNamesAgents(journal);
  const agents = liveAgents(journal.agents, orderedLabels(liveActivity), exact);
  const wireCurKey = running && wireCur ? norm(wireCur.phase) : null;
  // Phase-less agents: on the exact path, the "(no phase)" bucket (or "(phase unknown)" for an
  // unnamed one); on the by-index path an unlabelled one is most likely what the wire's current
  // phase just spawned — and, with no current phase to guess from, of unknown phase.
  const byPhase = agentsByPhaseKey(agents, exact ? UNPHASED_KEY : wireCurKey ?? UNKNOWN_KEY);
  const rows = withOrphanRows(
    exact
      ? exactPhaseRows(phases, agents, running && !journal.error)
      : legacyPhaseRows(phases, liveActivity, journal.delivered, wireCurKey != null ? wireCur!.phase : null, byPhase),
    byPhase,
  );
  if (!exact || journal.error) {
    return { exact, agents, byPhase, rows, curKey: wireCurKey, curLabel: wireCurKey ? wireCur?.label ?? null : null };
  }
  const curKey = journalCurrentPhaseKey(agents, running);
  return { exact, agents, byPhase, rows, curKey, curLabel: curKey ? latestLabelIn(agents, curKey) : null };
}

/**
 * The LEGACY (by-index) phase rows, for a journal without labels — approximate by nature (the
 * live view says so). Structure (which phases, in order, incl. upcoming) comes from the script's
 * declared `phases` plus the phases the wire reached.
 *
 * Counts, made consistent with the Agents column the user sees beside them:
 *  - `started` of a phase = the larger of its wire count (deduped labels undercount a shared-label
 *    fan-out) and the agents bucketed under it;
 *  - `failed` = the failures bucketed under it — counted ONCE, exactly where its agents are listed;
 *  - `done` = its failures + its share of the journal's DELIVERIES. Only deliveries are shared out
 *    across phases (a failure is never passed off as an earlier phase's delivery): sequentially
 *    up to the wire's current phase while the run lives (earlier phases fully delivered, the
 *    current one taking what is left), greedily in phase order otherwise.
 * State: phases before the current one are done, the current one is current, later ones
 * upcoming — but when the wire's current phase is not a DECLARED one (it is appended after them,
 * and an agent outside any phase shows on the wire as its bare label), only declared phases
 * before the last declared phase that ran are taken as passed.
 */
export function legacyPhaseRows(
  phases: { title: string; detail?: string | null }[],
  liveActivity: WfLive,
  globalDelivered: number,
  curTitle: string | null,
  byPhase: Map<string, LiveAgent[]>,
): LivePhaseRow[] {
  const startedBy = new Map(liveActivity.phases.map((p) => [norm(p.title), p.labels.length]));
  const bucket = (k: string) => byPhase.get(k) ?? [];
  // Ordered titles: declared phases first (homonyms each get their OWN slot, but only the FIRST
  // occurrence of a title carries the counts, under a private key for the others), then any
  // wire-only phase not declared.
  const order: { key: string; title: string; detail: string | null; started: number; failed: number }[] = [];
  const titleUsed = new Set<string>();
  const declaredTitles = new Set<string>();
  const slot = (k: string, title: string, detail: string | null, wireStarted: number) => {
    const failed = bucket(k).filter((a) => a.failed).length;
    order.push({ key: k, title, detail, started: Math.max(wireStarted, bucket(k).length), failed });
  };
  for (const p of phases) {
    const k = norm(p.title);
    declaredTitles.add(k);
    if (titleUsed.has(k)) {
      order.push({ key: `${k}\u0000${order.length}`, title: p.title, detail: p.detail ?? null, started: 0, failed: 0 });
      continue;
    }
    titleUsed.add(k);
    slot(k, p.title, p.detail ?? null, startedBy.get(k) ?? 0);
  }
  for (const p of liveActivity.phases) {
    const k = norm(p.title);
    if (!declaredTitles.has(k) && !titleUsed.has(k)) {
      titleUsed.add(k);
      slot(k, p.title, null, p.labels.length);
    }
  }

  const declaredCount = phases.length;
  const curIdx = curTitle != null ? order.findIndex((p) => p.key === norm(curTitle)) : -1;
  let reached = -1;
  for (let i = 0; i < declaredCount; i++) if (order[i].started > 0) reached = i;
  let remaining = Math.max(0, globalDelivered);
  const share = (p: { started: number; failed: number }, want: number) => {
    const n = Math.min(remaining, Math.max(0, Math.min(want, p.started - p.failed)));
    remaining -= n;
    return n;
  };
  const row = (p: (typeof order)[number], delivered: number, state: LivePhaseState): LivePhaseRow => ({
    ...p,
    synthetic: false,
    done: Math.min(p.started, delivered + p.failed),
    state,
  });

  if (curIdx < 0) {
    // No current phase known (just started, or the run is over): greedy fill in phase order.
    return order.map((p) => {
      const delivered = share(p, p.started);
      const done = Math.min(p.started, delivered + p.failed);
      return row(p, delivered, p.started > 0 && done >= p.started ? "done" : p.started > 0 ? "cur" : "todo");
    });
  }
  const curDeclared = curIdx < declaredCount;
  return order.map((p, i) => {
    const passed = i < curIdx && (curDeclared || i < reached || i >= declaredCount);
    if (passed) return row(p, share(p, p.started), "done"); // an earlier (sequential) phase
    if (i === curIdx) return row(p, share(p, p.started), "cur");
    return row(p, 0, p.started > 0 ? "cur" : "todo");
  });
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
