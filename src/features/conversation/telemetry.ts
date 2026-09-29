// Conversation TELEMETRY — the numbers behind the side panel's opt-in "telemetry deck" (the
// side panel's `telemetry` widget, OFF by default): how many tools of each kind the agent
// has called, which ones failed, which files it changed, what the turns cost, and the last few
// calls as a live feed.
//
// ⚠️ Every instrument must read a REAL signal. The deck is deliberately loud — gauges, rolling
// counters, a histogram — and loud is only fun while it is true: a number that moves for show
// would turn the panel into a screensaver the user can no longer trust. So everything here is
// DERIVED from the message stream already in `conversationStore`, with no guess and no filler;
// what is not known reads as not known ("—"), never as zero.
//
// Pure, no React: derived and memoised exactly like the artifacts registry (artifacts.ts), and
// for the same reason — on the timeline/tool-result/sub-thread/turn-result references, which
// move when a turn settles or a result lands, NOT on every streamed token.

import type { JsonValue, TokenUsage } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import { useConversationStore } from "../../store/conversationStore";
import { basename, toolMeta } from "./toolMeta";

/** The families the deck counts. Everything that is none of them (skills, todos, MCP tools,
 *  artifacts…) still counts in the total — the deck has six dials, the agent has more tools. */
export type ToolFamily = "read" | "edit" | "shell" | "search" | "agent" | "web" | "other";

/** The six dials, in display order. */
export const TELEMETRY_DIALS: readonly Exclude<ToolFamily, "other">[] = [
  "read",
  "edit",
  "shell",
  "search",
  "agent",
  "web",
];

/** Which family a tool belongs to, by its wire name. Codex's tools map onto the same six. */
export function toolFamily(name: string): ToolFamily {
  switch (name) {
    case "Read":
    case "NotebookRead":
    case "LS":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "ApplyPatch":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "Monitor":
      return "shell";
    case "Grep":
    case "Glob":
    case "ToolSearch":
      return "search";
    case "Agent":
    case "Task":
    case "Workflow":
    case "SendMessage":
      return "agent";
    case "WebFetch":
    case "WebSearch":
      return "web";
    default:
      return "other";
  }
}

/** One tool call, as the live feed shows it. */
export interface TelemetryEvent {
  /** The tool_use id — stable, so a row animates in once and then only changes status. */
  id: string;
  family: ToolFamily;
  /** The wire name (`Read`, `mcp__tosse__get_tasks`…). */
  tool: string;
  /** What it acted on — a file's basename, a command's first line, a pattern — or null. */
  target: string | null;
  /** `running` until its result lands; `error` when that result came back `is_error`. */
  status: "running" | "ok" | "error";
  /** Called by a sub-agent rather than the conversation's own agent. */
  sub: boolean;
  /** When the call started (`Date.now()`), stamped by the store as the tool_use arrived — or
   *  null for a call replayed from disk, which carries no wall-clock time. */
  startedAt: number | null;
  /** How long it took (tool_use → tool_result), frozen when its result landed; null while it
   *  runs and for a replayed call. */
  durationMs: number | null;
}

export interface Telemetry {
  /** Calls per family. */
  counts: Record<ToolFamily, number>;
  /** Failed calls per family (their result came back `is_error`). */
  errors: Record<ToolFamily, number>;
  /** Every call, all families — the number the activity histogram differentiates. */
  totalCalls: number;
  /** How many of {@link totalCalls} a SUB-AGENT made (a call on a sub-thread). Live, the CLI
   *  forwards sub-agents' calls at every depth; after a reload, none (the transcript's
   *  sidechains are not replayed) — see {@link replayedCalls}. Workflow agents never stream. */
  subCalls: number;
  /** How many of {@link totalCalls} were replayed from the transcript rather than seen live: a
   *  call that has its result but neither a start stamp nor a measured duration. Non-zero means
   *  the counts before the reload cover the MAIN thread only: a sub-agent's calls are not in the
   *  replayed history. ⚠️ A call still WITHOUT a result is never counted here: one that was
   *  running when the stream went off loses its start stamp (`clearState`) but was seen live. */
  replayedCalls: number;
  /** Distinct files the edit family wrote — a call that came back `is_error` (an `Edit` whose
   *  `old_string` was not found, a denied `Write`, a rejected patch) wrote nothing and adds no
   *  file. A call still running counts: it is being written. */
  filesTouched: number;
  /** Completed turns (one per `result`). */
  turns: number;
  /** The CLI's API-equivalent cost estimate for the whole session: the session total's
   *  (`state.session_usage.cost_usd`), else the LATEST turn's `total_cost_usd`; null when none
   *  reported one.
   *  ⚠️ Never a sum over turns: the CLI's figure is CUMULATIVE — each result carries the running
   *  total — so adding them counted the first turn N times (a triangular over-count). */
  costUsd: number | null;
  /** Model time summed over the turns that reported it; null when none did. */
  modelMs: number | null;
  /** Sub-agents launched (the `Agent`/`Task` calls). */
  subAgents: number;
  /** The last few calls, NEWEST FIRST. */
  events: TelemetryEvent[];
  /** Calls running RIGHT NOW with a live start stamp, OLDEST first — what the in-flight board
   *  times. A call without a stamp (replayed from disk, its session gone) has nothing to time
   *  and is left out rather than shown counting from an invented zero. */
  inFlight: TelemetryEvent[];
  /** The median measured duration of each family's calls in this conversation, or null
   *  until one of them finished live — the baseline an in-flight call is compared against. */
  familyMedianMs: Record<ToolFamily, number | null>;
  /** The median length of this conversation's completed turns, or null before the first. */
  medianTurnMs: number | null;
  /** The AVERAGE length of the completed turns this app watched finish (`result.duration_ms`),
   *  or null before the first — and after a reload, which replays no `result`. */
  meanTurnMs: number | null;
  /** How many turns {@link meanTurnMs} (and {@link medianTurnMs}) average over: the turns whose
   *  result reported a duration — {@link turns} minus any that did not. */
  timedTurns: number;
  /** The AVERAGE measured duration of each family's calls, or null until one finished live —
   *  what the dials show under their counts. */
  familyMeanMs: Record<ToolFamily, number | null>;
  /** The average measured duration over every call, or null until one finished live. */
  meanCallMs: number | null;
  /** Tokens the session consumed — see {@link tokensScope} for what that covers. Cache
   *  re-reads included (usually the bulk of it). null when nothing reported usage yet. */
  tokens: TokenUsage | null;
  /**
   * What {@link tokens} covers:
   *  - `"session"`: the session total (`state.session_usage`) — every agent's model calls as the
   *    CLI counts them (Claude), or the whole thread (Codex). Preferred whenever known.
   *  - `"turns"`: its fallback, `result.usage` summed over the turns this app watched finish —
   *    the MAIN LOOP only (the CLI's own words: it excludes sub-agents, sidechains and auxiliary
   *    calls). Per-turn, so summing is right there, and it never mixes with the session total.
   *  - null with no tokens.
   */
  tokensScope: "session" | "turns" | null;
}

/** How many calls the feed keeps — four, so the whole deck fits a 13-inch laptop's height. */
export const TELEMETRY_FEED_SIZE = 4;

/**
 * How long a call must have been running before the in-flight board shows it.
 *
 * ⚠️ Not zero, on purpose. Most calls finish in well under a second, and a board listing every
 * one of them flickered rows in and out faster than anyone could read — the "sometimes fast,
 * sometimes slow, you can't tell what's happening" Alexandre saw. The board is for the calls
 * worth watching: the long ones. (Every call still counts on the dials, the gauges and the feed.)
 */
export const LONG_CALL_MS = 40_000;

const FAMILIES: ToolFamily[] = ["read", "edit", "shell", "search", "agent", "web", "other"];

function zeroCounts(): Record<ToolFamily, number> {
  return { read: 0, edit: 0, shell: 0, search: 0, agent: 0, web: 0, other: 0 };
}

const EMPTY: Telemetry = {
  counts: zeroCounts(),
  errors: zeroCounts(),
  totalCalls: 0,
  subCalls: 0,
  replayedCalls: 0,
  filesTouched: 0,
  turns: 0,
  costUsd: null,
  modelMs: null,
  subAgents: 0,
  events: [],
  inFlight: [],
  familyMedianMs: { read: null, edit: null, shell: null, search: null, agent: null, web: null, other: null },
  medianTurnMs: null,
  meanTurnMs: null,
  timedTurns: 0,
  familyMeanMs: { read: null, edit: null, shell: null, search: null, agent: null, web: null, other: null },
  meanCallMs: null,
  tokens: null,
  tokensScope: null,
};

/** The mean of a list, or null when it is empty. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The median of a list, or null when it is empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function asObject(v: JsonValue): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
}

/** The paths an edit-family call wrote to — one for Edit/Write, every file of a Codex patch. */
function editedPaths(name: string, input: JsonValue): string[] {
  const obj = asObject(input);
  if (name === "ApplyPatch") {
    const changes = Array.isArray(obj.changes) ? (obj.changes as JsonValue[]) : [];
    return changes.map((c) => asObject(c).path).filter((p): p is string => typeof p === "string");
  }
  const p = obj.file_path ?? obj.notebook_path;
  return typeof p === "string" ? [p] : [];
}

/** A call's target for the feed: its salient argument, reduced to one short line. */
function eventTarget(name: string, input: JsonValue): string | null {
  const arg = toolMeta(name, input).primaryArg;
  if (!arg) return null;
  const line = arg.split("\n", 1)[0].trim();
  // A path reads by its last segment; anything else (a command, a pattern, a URL) as is.
  const short = line.startsWith("/") && !line.includes(" ") ? basename(line) : line;
  return short.length > 60 ? `${short.slice(0, 59)}…` : short;
}

/**
 * The telemetry of one conversation. Walks EVERY turn — sub-agents' included, since their
 * calls are work this conversation set in motion — in the order the store received them.
 */
export function selectTelemetry(entry: SessionEntry | undefined): Telemetry {
  if (!entry) return EMPTY;
  const counts = zeroCounts();
  const errors = zeroCounts();
  const files = new Set<string>();
  const events: TelemetryEvent[] = [];
  const inFlight: TelemetryEvent[] = [];
  const durationsByFamily: Record<ToolFamily, number[]> = {
    read: [], edit: [], shell: [], search: [], agent: [], web: [], other: [],
  };
  let totalCalls = 0;
  let subCalls = 0;
  let replayedCalls = 0;
  let subAgents = 0;

  for (const turn of Object.values(entry.turns)) {
    if (turn.role !== "assistant") continue;
    for (const b of turn.blocks) {
      if (b.type !== "tool_use") continue;
      const family = toolFamily(b.name);
      const result = entry.toolResults[b.id];
      const status: TelemetryEvent["status"] = !result ? "running" : result.isError ? "error" : "ok";
      counts[family] += 1;
      totalCalls += 1;
      if (status === "error") errors[family] += 1;
      if (b.name === "Agent" || b.name === "Task") subAgents += 1;
      if (family === "edit" && status !== "error") for (const p of editedPaths(b.name, b.input)) files.add(p);
      const durationMs = entry.toolDurations[b.id] ?? null;
      if (durationMs != null) durationsByFamily[family].push(durationMs);
      const event: TelemetryEvent = {
        id: b.id,
        family,
        tool: b.name,
        target: eventTarget(b.name, b.input),
        status,
        sub: turn.parentToolUseId !== null,
        startedAt: entry.toolStartedAt[b.id] ?? null,
        durationMs,
      };
      if (event.sub) subCalls += 1;
      // A call seen live carries a start stamp while it runs and a frozen duration once done;
      // one replayed from the transcript has its result and neither. (A call without a result
      // is still running — or was when the stream went off, which drops the stamps: live.)
      if (result && event.startedAt === null && durationMs === null) replayedCalls += 1;
      events.push(event);
      if (status === "running" && event.startedAt != null) inFlight.push(event);
    }
  }

  let turns = 0;
  let lastCost: number | null = null;
  let modelMs: number | null = null;
  const turnMs: number[] = [];
  let turnTokens: TokenUsage | null = null;
  // Insertion order = arrival order (the store keys results `tr_<seq>`), so the last cost
  // seen is the latest one.
  for (const r of Object.values(entry.turnResults)) {
    turns += 1;
    if (r.usage) turnTokens = addUsage(turnTokens, r.usage);
    if (r.totalCostUsd != null) lastCost = r.totalCostUsd;
    if (r.durationApiMs != null) modelMs = (modelMs ?? 0) + r.durationApiMs;
    if (r.durationMs != null) turnMs.push(r.durationMs);
  }
  // The session total wins over the main-loop sum whenever it is known — never added to it
  // (the main loop is a SUBSET of it).
  const session = entry.state?.session_usage ?? null;
  const tokens = session ? session.total : turnTokens;

  if (totalCalls === 0 && turns === 0 && !session) return EMPTY;
  return {
    counts,
    errors,
    totalCalls,
    subCalls,
    replayedCalls,
    filesTouched: files.size,
    turns,
    costUsd: session?.cost_usd ?? lastCost,
    modelMs,
    subAgents,
    events: events.slice(-TELEMETRY_FEED_SIZE).reverse(),
    inFlight,
    familyMedianMs: {
      read: median(durationsByFamily.read),
      edit: median(durationsByFamily.edit),
      shell: median(durationsByFamily.shell),
      search: median(durationsByFamily.search),
      agent: median(durationsByFamily.agent),
      web: median(durationsByFamily.web),
      other: median(durationsByFamily.other),
    },
    medianTurnMs: median(turnMs),
    meanTurnMs: mean(turnMs),
    timedTurns: turnMs.length,
    familyMeanMs: {
      read: mean(durationsByFamily.read),
      edit: mean(durationsByFamily.edit),
      shell: mean(durationsByFamily.shell),
      search: mean(durationsByFamily.search),
      agent: mean(durationsByFamily.agent),
      web: mean(durationsByFamily.web),
      other: mean(durationsByFamily.other),
    },
    meanCallMs: mean(FAMILIES.flatMap((f) => durationsByFamily[f])),
    tokens,
    tokensScope: session ? "session" : turnTokens ? "turns" : null,
  };
}

function addUsage(acc: TokenUsage | null, u: TokenUsage): TokenUsage {
  if (!acc) return { ...u };
  return {
    input: acc.input + u.input,
    cache_creation: acc.cache_creation + u.cache_creation,
    cache_read: acc.cache_read + u.cache_read,
    output: acc.output + u.output,
  };
}

/** Everything a render reads, as one string — so an unrelated change returns the SAME object
 *  and nothing re-renders (see memoizedTelemetry). */
function telemetrySig(t: Telemetry): string {
  return (
    FAMILIES.map((f) => `${t.counts[f]}.${t.errors[f]}`).join(",") +
    `|${t.subCalls}|${t.replayedCalls}` +
    `|${t.filesTouched}|${t.turns}|${t.costUsd ?? ""}|${t.modelMs ?? ""}|${t.subAgents}|` +
    t.events.map((e) => `${e.id}:${e.status}:${e.durationMs ?? ""}`).join(",") +
    `|${t.inFlight.map((e) => `${e.id}@${e.startedAt}`).join(",")}` +
    `|${FAMILIES.map((f) => t.familyMedianMs[f] ?? "").join(",")}|${t.medianTurnMs ?? ""}|${t.meanTurnMs ?? ""}|${t.timedTurns}` +
    `|${FAMILIES.map((f) => t.familyMeanMs[f] ?? "").join(",")}|${t.meanCallMs ?? ""}` +
    `|${t.tokens ? `${t.tokens.input}.${t.tokens.cache_creation}.${t.tokens.cache_read}.${t.tokens.output}` : ""}` +
    `|${t.tokensScope ?? ""}`
  );
}

const cache = new Map<
  string,
  {
    timeline: SessionEntry["timeline"];
    toolResults: SessionEntry["toolResults"];
    subThreads: SessionEntry["subThreads"];
    turnResults: SessionEntry["turnResults"];
    toolStartedAt: SessionEntry["toolStartedAt"];
    sessionUsage: SessionEntry["state"]["session_usage"];
    sig: string;
    result: Telemetry;
  }
>();

/**
 * `selectTelemetry` memoised per session. Keyed on the references that move when a call can
 * appear or settle — the timeline (a main-thread turn settled), the sub-threads (a sub-agent
 * turn arrived), the tool start stamps (a call began), the tool results (a call finished, its
 * duration frozen in the same update), the turn results (a turn ended) and the session total —
 * and NOT on `turns`, which is replaced on every streamed token, nor on `state`, replaced on
 * every state push (the store keeps `state.session_usage`'s reference while its value holds).
 * Ref-stable across recomputes that change nothing, via the signature.
 */
export function memoizedTelemetry(session: string, entry: SessionEntry | undefined): Telemetry {
  if (!entry) return EMPTY;
  const cached = cache.get(session);
  if (
    cached &&
    cached.timeline === entry.timeline &&
    cached.toolResults === entry.toolResults &&
    cached.subThreads === entry.subThreads &&
    cached.turnResults === entry.turnResults &&
    cached.toolStartedAt === entry.toolStartedAt &&
    cached.sessionUsage === entry.state?.session_usage
  ) {
    return cached.result;
  }
  const result = selectTelemetry(entry);
  const sig = telemetrySig(result);
  const kept = cached && cached.sig === sig ? cached.result : result;
  cache.set(session, {
    timeline: entry.timeline,
    toolResults: entry.toolResults,
    subThreads: entry.subThreads,
    turnResults: entry.turnResults,
    toolStartedAt: entry.toolStartedAt,
    sessionUsage: entry.state?.session_usage,
    sig,
    result: kept,
  });
  return kept;
}

/** Forget one conversation's memoised telemetry (a removed conversation must not pin its
 *  whole transcript in memory). */
export function clearTelemetryCache(session: string): void {
  cache.delete(session);
}

/** Test helper: forget every memoised entry. */
export function clearAllTelemetryCache(): void {
  cache.clear();
}

export function useTelemetry(session: string): Telemetry {
  return useConversationStore((s) => memoizedTelemetry(session, s.sessions[session]));
}

// ---- Activity histogram ---------------------------------------------------------------

/** Width of one histogram bucket, and how many the deck shows: one bar a second over the last
 *  minute — fine enough that a burst of calls reads as a burst, and the chart visibly moves. */
export const HISTOGRAM_BUCKET_MS = 1_000;
export const HISTOGRAM_BUCKETS = 60;

/**
 * Close the live bucket: shift the window one step left and start a fresh bucket. Pure — the
 * hook that drives it only supplies the clock.
 *
 * ⚠️ LIVE-ONLY by construction. Calls carry no timestamp in the store (a transcript replayed
 * from disk arrives all at once), so the histogram measures arrivals WHILE THE DECK IS OPEN and
 * starts flat. A reloaded conversation's history does not show up as one giant spike at the
 * moment it was loaded — see {@link histogramArrivals}.
 */
export function closeBucket(done: readonly number[], live: number): number[] {
  const next = [...done, live];
  return next.length > HISTOGRAM_BUCKETS - 1 ? next.slice(next.length - (HISTOGRAM_BUCKETS - 1)) : next;
}

/** One bar of the activity histogram, keyed by the SECOND it counts. */
export interface HistogramBar {
  key: string;
  value: number;
  /** The bucket still filling (the rightmost one). */
  live: boolean;
}

/**
 * The bars to draw: `done` (closed buckets, oldest first) then the live one, left-padded with
 * empty bars to the full window. `seq` is the live bucket's absolute index.
 *
 * ⚠️ Each bar is keyed by its ABSOLUTE bucket — the second it counts — never by its position.
 * Keyed by position, every tick handed each DOM bar its neighbour's value, so every bar's height
 * changed at once and every peak animated down and back up on each second. Keyed by bucket, a
 * tick only MOVES the bars one step left (a layout shift, no height change, nothing animates);
 * the only bar whose height changes is the live one, as calls land in it.
 */
export function histogramBars(done: readonly number[], live: number, seq: number): HistogramBar[] {
  const bars: HistogramBar[] = [];
  const pad = Math.max(0, HISTOGRAM_BUCKETS - 1 - done.length);
  for (let i = 0; i < pad; i++) bars.push({ key: `pad${i}`, value: 0, live: false });
  const first = seq - done.length;
  for (let i = 0; i < done.length; i++) bars.push({ key: `b${first + i}`, value: done[i], live: false });
  bars.push({ key: `b${seq}`, value: live, live: true });
  return bars;
}

/**
 * How many calls ARRIVED between two readings of the total: its growth, and nothing else. A
 * total that did not grow (or shrank — a rewind cut the transcript) is no arrival, and the
 * FIRST reading is none either: it is the history that was already there when the deck opened.
 */
export function histogramArrivals(previous: number | null, current: number): number {
  if (previous === null) return 0;
  return current > previous ? current - previous : 0;
}

// ---- Status lamp + run clock ----------------------------------------------------------

/** What the agent is doing right now, as the deck's status lamp names it. */
export type DeckStatusKey =
  | "permission"
  | "retry"
  | "tool"
  | "streaming"
  | "thinking"
  | "background"
  | "standby";

export interface DeckStatus {
  key: DeckStatusKey;
  label: string;
}

/** The short name of a tool for the lamp: an MCP tool by its own name, not its server's. */
function shortToolName(name: string): string {
  const last = name.split("__").pop() || name;
  return last.replace(/_/g, " ");
}

/**
 * The calls to show as RUNNING: those with a live start stamp — but only while the session is
 * demonstrably doing something (a turn, background work, text streaming).
 *
 * ⚠️ A session that dies mid-call never delivers that call's result, so its stamp would stay
 * "in flight" forever: a timer counting up for good, and a deck that never settles (its frame
 * loop runs while anything is in flight). No activity, nothing in flight.
 */
export function liveInFlight(
  inFlight: TelemetryEvent[],
  s: { busy: boolean; backgroundOps: number; streaming: boolean },
): TelemetryEvent[] {
  return s.busy || s.backgroundOps > 0 || s.streaming ? inFlight : NO_EVENTS;
}
const NO_EVENTS: TelemetryEvent[] = [];

/**
 * The one line the lamp reads — in priority order, since several can hold at once: a question
 * waiting on the USER beats everything (the agent is stopped until it is answered), a retry
 * beats the work it interrupts, and among the work the most specific signal wins (a named tool
 * running, then text streaming, then the silent "thinking" in between).
 *
 * A running tool and streaming text are FACTS, read as such even when the session has not (yet)
 * reported itself busy; `runningTool` must come through {@link liveInFlight}, which is what
 * keeps a dead session's orphan call from being named here.
 */
export function deckStatus(s: {
  busy: boolean;
  awaitingPermission: boolean;
  retrying: boolean;
  /** The newest call still running (through {@link liveInFlight}), if any. */
  runningTool: string | null;
  streaming: boolean;
  backgroundOps: number;
}): DeckStatus {
  if (s.awaitingPermission) return { key: "permission", label: "Awaiting permission" };
  if (s.retrying) return { key: "retry", label: "Retrying" };
  if (s.runningTool) return { key: "tool", label: `Running ${shortToolName(s.runningTool)}` };
  if (s.streaming) return { key: "streaming", label: "Streaming" };
  if (s.busy) return { key: "thinking", label: "Thinking" };
  if (s.backgroundOps > 0) return { key: "background", label: "Background ops" };
  return { key: "standby", label: "Standby" };
}

// ---- Tokens -----------------------------------------------------------------------------------

/** The four kinds of token a model call reports, in the order the deck's bars stack them: the
 *  prompt (cached, being cached, fresh), then what the model wrote. */
export type TokenPart = "cache_read" | "cache_creation" | "input" | "output";

export const TOKEN_PARTS: ReadonlyArray<{ key: TokenPart; label: string; title: string }> = [
  { key: "cache_read", label: "Cached", title: "Prompt tokens read back from the prompt cache" },
  { key: "cache_creation", label: "Caching", title: "Prompt tokens written to the prompt cache" },
  { key: "input", label: "Input", title: "Prompt tokens sent fresh — neither read from nor written to the cache" },
  { key: "output", label: "Output", title: "Tokens the model wrote" },
];

/** Every token a usage counts — its prompt and its reply. */
export function tokenTotal(u: TokenUsage): number {
  return u.input + u.cache_creation + u.cache_read + u.output;
}

/** Each part's share of the whole, for the stacked bar; all zero on an empty usage (an empty
 *  bar, never a division by zero). */
export function tokenShares(u: TokenUsage): Record<TokenPart, number> {
  const total = tokenTotal(u);
  const share = (n: number) => (total > 0 ? n / total : 0);
  return {
    cache_read: share(u.cache_read),
    cache_creation: share(u.cache_creation),
    input: share(u.input),
    output: share(u.output),
  };
}

/** A run's elapsed time on the deck's clock: `m:ss` under an hour, `h:mm:ss` beyond. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Model time for the stats strip: `42s`, `3m 12s`, `1h 04m`. */
export function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
