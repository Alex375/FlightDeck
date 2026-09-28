// The Stats widget's numbers and — as much as the numbers — what each one COVERS.
//
// Four compact readings of one conversation: the average turn, the files the agent changed, the
// tool calls it made, and the tokens the whole session consumed. Each comes from a different
// source with a different reach, and a figure that silently covers less than it seems to is
// worse than no figure: « 148 tool calls » after a reload is the MAIN thread's calls only (the
// transcript does not replay sub-agents), a token total read back from disk is « as of the last
// close », and a Codex total is one thread, not its sub-agents. So every tile carries its
// coverage — a short hint under the value where it changes the reading, the full wording in the
// tile's tooltip — and whatever is not known reads « — », never 0.
//
// Pure, no React: the widget feeds it the store's readings and renders what comes back.
//
// ⚠️ The token total is ONE cumulative snapshot (`state.session_usage`, see SessionUsage in the
// bindings), never a sum. Nothing is ever added to it: not the per-turn `result.usage` (a subset:
// the main loop), not any per-agent « tokens » figure of the wire (a different unit: an agent's
// last call ≈ its final context size). The tool calls are the one place two sources ARE added —
// the stream's calls and the finished workflow runs' roll-ups — because they do not overlap:
// workflow agents never reach the stream.

import type { BackgroundTask, SessionUsage, TokenUsage } from "../../../ipc/client";
import type { SessionUsageSource } from "../../../store/types";
import { fmtSpan, tokenTotal, type Telemetry } from "../telemetry";

/** The telemetry fields the widget reads (the rest of `Telemetry` moves on every call). */
export type StatsTelemetry = Pick<
  Telemetry,
  "turns" | "timedTurns" | "meanTurnMs" | "totalCalls" | "subCalls" | "replayedCalls" | "filesTouched"
>;

export interface StatsInput {
  kind: "claude" | "codex";
  t: StatsTelemetry;
  /** The session total (`state.session_usage`), or null when unknown. */
  usage: SessionUsage | null;
  /** Where {@link usage} came from — what it covers. */
  source: SessionUsageSource;
  /** Tool calls reported by FINISHED workflow runs, and how many runs are still going. */
  workflows: WorkflowCalls;
  /** Background work still running (sub-agents, workflows, shells): the Claude total only moves
   *  at a turn end, so it cannot include what that work is spending right now. */
  backgroundRunning: boolean;
}

export type StatKey = "turn" | "files" | "calls" | "tokens";

export interface StatTile {
  key: StatKey;
  /** The 9px caption under the value. */
  label: string;
  /** The reading, compact — or « — » when not known. */
  value: string;
  known: boolean;
  /** One short coverage line under the label, only where it changes the reading. */
  hint: string | null;
  /** The hint is a CAVEAT (the figure covers less than it seems): drawn in the warning tone. */
  caveat: boolean;
  /** The tooltip: a headline, then the full coverage wording. */
  tip: string[];
}

export interface StatsView {
  tiles: StatTile[];
}

/** « — »: the one way the widget says « not known ». */
export const UNKNOWN = "—";

/**
 * A token count at three significant figures at most — 812, 5.07k, 512k, 5.12M, 592M, 1.21B — so
 * the header capsule and a quarter-width tile both hold it. `fmtTokens` (store/contextData) keeps
 * a decimal at every scale (« 592.1M »), a digit too many for a tile.
 */
export function fmtCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i];
    if (n < size) continue;
    const v = n / size;
    const text = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    // Rounding can carry into the next unit (999,960 → « 1000k »): say « 1M » instead.
    if (Number(text) >= 1000 && i > 0) return `1${units[i - 1][1]}`;
    return `${trimZeros(text)}${suffix}`;
  }
  return String(n);
}

/** « 5.10 » → « 5.1 », « 12.0 » → « 12 ». */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** A token count in full, for a tooltip: « 592,114,302 ». */
function fmtExact(n: number): string {
  return n.toLocaleString("en-US");
}

/** The share of `part` in `whole` as a whole percent — « <1% » for a sliver and « >99% » for
 *  all but a sliver: rounding must never print a fake 0% or a fake 100%. */
function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return `${Math.round(p)}%`;
}

/** A cost estimate in dollars — « <$0.01 » below half a cent, which `toFixed(2)` would print
 *  as a fake « $0.00 ». */
function fmtCost(usd: number): string {
  return usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** A turn length — « <1s » below half a second, which `fmtSpan` would round to a fake « 0s »
 *  (a local slash command's turn takes a few milliseconds). */
function fmtTurn(ms: number): string {
  return ms < 500 ? "<1s" : fmtSpan(ms);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** A model id the way a tooltip line can afford it: « claude-opus-5[1m] » → « opus-5[1m] »,
 *  a dated snapshot without its date (« claude-haiku-4-5-20251001 » → « haiku-4-5 »). */
export function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}(?=\[|$)/, "");
}

/** The tool calls finished workflow runs reported, and how many runs are still going. */
export interface WorkflowCalls {
  calls: number;
  running: number;
}

/**
 * Tool calls made by workflow agents: the `tool_uses` roll-up each FINISHED workflow run reports
 * (its `task_notification`). Workflow agents never reach the stream, so these are not in the
 * stream's count — adding them is additive, not a double count. ⚠️ Workflow runs only: a
 * sub-agent (`Agent`) task's roll-up would double-count the calls its forwarded turns already
 * brought into the stream. A running run has no roll-up yet; it is counted in `running`.
 */
export function workflowCalls(tasks: Record<string, BackgroundTask> | undefined): WorkflowCalls {
  let calls = 0;
  let running = 0;
  if (!tasks) return { calls, running };
  for (const task of Object.values(tasks)) {
    if (task.kind !== "workflow") continue;
    if (task.status === "running") running += 1;
    else if (task.tool_uses != null) calls += task.tool_uses;
  }
  return { calls, running };
}

/** The header's reading: the session total, compact, or « — ». Cheap — it is all a folded
 *  section shows. */
export function statsMeta(usage: SessionUsage | null): string {
  return usage ? fmtCompactTokens(tokenTotal(usage.total)) : UNKNOWN;
}

/** What the header's reading is, for its tooltip — folded, the capsule is the whole section. */
export function statsMetaTip(kind: "claude" | "codex", usage: SessionUsage | null, source: SessionUsageSource): string {
  if (!usage) {
    const what = kind === "codex" ? "Tokens this thread used" : "Tokens this session used";
    return source === "missing" ? `${what} — no spend on record` : `${what} — not known yet`;
  }
  const reach =
    kind === "codex"
      ? "Tokens this thread used, cache reads included"
      : "Tokens this session used — every agent, cache reads included";
  if (source === "reopened") return `${reach} — since it was reopened`;
  if (source === "disk") return `${reach} — as of its last close`;
  return reach;
}

/** The whole widget: four tiles, each with its value, coverage hint and tooltip. */
export function statsView(input: StatsInput): StatsView {
  return { tiles: [turnTile(input), filesTile(input), callsTile(input), tokensTile(input)] };
}

/** Counts restored from the transcript cover the main thread only (no sidechain is replayed). */
const RESTORED_NOTE =
  "Restored from the transcript: the main thread only — sub-agents' work before the reload is not on record.";

/** Codex: a collab sub-agent is a thread of its own, never on this one's stream or rollout. */
const CODEX_THREAD_NOTE =
  "This thread only — Codex sub-agents run as threads of their own and are not counted here.";

/**
 * Whether the counts were partly restored from disk AND lost something doing so. Claude only: a
 * transcript does not replay the sidechains, so a sub-agent's calls before the reload are gone.
 * A Codex rollout replays the thread in full and its sub-agents were never on it — nothing is
 * lost, so no « main thread » caveat there (it would misname the thread, too).
 */
function restoredPartially({ kind, t }: StatsInput): boolean {
  return kind === "claude" && t.replayedCalls > 0;
}

function turnTile({ t }: StatsInput): StatTile {
  const mean = t.meanTurnMs;
  // The turns measured are those that finished while the app watched: a reload replays none.
  // ⚠️ The count shown is the TIMED turns (`timedTurns`), the ones the mean is over — a turn
  // whose result reported no duration is not in it.
  if (mean == null) {
    return {
      key: "turn",
      label: "Avg turn",
      value: UNKNOWN,
      known: false,
      hint: null,
      caveat: false,
      tip: [
        "No turn time yet",
        t.turns > 0
          ? "The turns that finished since this conversation was opened reported no duration."
          : "Turn times are measured live: no turn has finished since this conversation was opened or its stream restarted.",
      ],
    };
  }
  return {
    key: "turn",
    label: "Avg turn",
    value: fmtTurn(mean),
    known: true,
    hint: t.timedTurns > 0 ? plural(t.timedTurns, "turn") : null,
    caveat: false,
    tip: [
      `${fmtTurn(mean)} per turn on average`,
      `Over the ${plural(t.timedTurns, "turn")} that finished while this conversation was open, as timed at each turn end.`,
    ],
  };
}

function filesTile(input: StatsInput): StatTile {
  const { kind, t, workflows } = input;
  const restored = restoredPartially(input);
  const tip = [
    `${plural(t.filesTouched, "file")} changed`,
    "Distinct files the agent wrote through its edit tools (Edit, Write, patches) — failed edits and changes made from the shell are not counted.",
  ];
  if (kind === "codex") tip.push(CODEX_THREAD_NOTE);
  if (restored) tip.push(RESTORED_NOTE);
  if (workflows.calls > 0 || workflows.running > 0)
    tip.push("Workflow agents' edits are not on the stream and are not counted.");
  return {
    key: "files",
    label: "Files",
    value: t.filesTouched.toLocaleString("en-US"),
    known: true,
    hint: restored ? "main thread" : null,
    caveat: false,
    tip,
  };
}

function callsTile(input: StatsInput): StatTile {
  const { kind, t, workflows } = input;
  const total = t.totalCalls + workflows.calls;
  const bySub = t.subCalls + workflows.calls;
  const restored = restoredPartially(input);
  const tip = [`${plural(total, "tool call")}`];
  if (bySub > 0) {
    const parts = [];
    if (t.subCalls > 0) parts.push(`${t.subCalls.toLocaleString("en-US")} by sub-agents`);
    if (workflows.calls > 0) parts.push(`${workflows.calls.toLocaleString("en-US")} by workflow agents`);
    tip.push(`${(total - bySub).toLocaleString("en-US")} on the main thread, ${parts.join(", ")}.`);
  } else if (kind === "codex") {
    tip.push(CODEX_THREAD_NOTE);
  } else if (!restored) {
    // (Restored, the note below says what the count covers instead.)
    tip.push("Every call made on the main thread and by the sub-agents it launched.");
  }
  if (restored) tip.push(RESTORED_NOTE);
  if (workflows.running > 0)
    tip.push(
      `${plural(workflows.running, "workflow")} still running: ${workflows.running === 1 ? "its" : "their"} agents' calls count once ${workflows.running === 1 ? "it ends" : "they end"}.`,
    );
  return {
    key: "calls",
    // "Calls", not "Tool calls": four columns at the panel's width leave no room for the longer
    // word, and the tile's tooltip says what they are.
    label: "Calls",
    value: total.toLocaleString("en-US"),
    known: true,
    hint: bySub > 0 ? `${bySub.toLocaleString("en-US")} by sub-agents` : restored ? "main thread" : null,
    caveat: false,
    tip,
  };
}

/** The four parts of a total as shares, for the tooltip's breakdown line — in a FIXED order
 *  (cache reads first: the bulk of any long session), so the line reads the same way as it
 *  updates; a part with no tokens is left out. */
function breakdown(u: TokenUsage): string {
  const whole = tokenTotal(u);
  return [
    ["cached", u.cache_read],
    ["cache writes", u.cache_creation],
    ["input", u.input],
    ["output", u.output],
  ]
    .filter(([, n]) => (n as number) > 0)
    .map(([label, n]) => `${pct(n as number, whole)} ${label}`)
    .join(" · ");
}

function tokensTile({ kind, usage, source, backgroundRunning }: StatsInput): StatTile {
  const codex = kind === "codex";
  if (!usage) {
    return {
      key: "tokens",
      label: "Tokens",
      value: UNKNOWN,
      known: false,
      hint: null,
      caveat: false,
      tip:
        source === "missing"
          ? [
              "No spend on record",
              codex
                ? "This thread's log holds no token count yet."
                : "The transcript holds no spend record (the last process was killed, the conversation was rewound or forked early, or an older Claude Code wrote it). The count restarts at the next turn end, from the reopen.",
            ]
          : [
              "Not known yet",
              codex
                ? "This thread's total arrives with its first model reply."
                : "The session total arrives with the first turn end.",
            ],
    };
  }
  const total = tokenTotal(usage.total);
  const reopened = source === "reopened";
  const tip = [`${fmtExact(total)} tokens`];
  const parts = breakdown(usage.total);
  if (parts) tip.push(parts);
  if (codex) {
    tip.push(CODEX_THREAD_NOTE);
  } else {
    tip.push(
      "Every model call Claude Code counted for this session — main thread, sub-agents, workflow agents, compaction. The permission classifier is not included.",
    );
  }
  if (source === "disk") {
    tip.push(
      codex
        ? "As of the thread's last recorded count — refreshed with its next model reply."
        : "As of the session's last close — refreshed at the next turn end.",
    );
  } else if (reopened) {
    tip.push(
      codex
        ? "Since the thread was reopened: its earlier count was not carried over."
        : "Since the session was reopened: the earlier spend was not carried over (a killed process, a rewind, or a /clear).",
    );
  } else if (!codex) {
    tip.push(
      backgroundRunning
        ? "Refreshed at each turn end — the background work still running is counted at the next one."
        : "Refreshed at each turn end.",
    );
  }
  if (usage.cost_usd != null)
    tip.push(`≈ ${fmtCost(usage.cost_usd)} at API list prices — an estimate, not a bill.`);
  if (usage.per_model.length > 1)
    tip.push(
      `By model: ${usage.per_model
        .map((m) => `${shortModel(m.model)} ${fmtCompactTokens(tokenTotal(m.usage))}`)
        .join(" · ")}`,
    );
  return {
    key: "tokens",
    label: "Tokens",
    value: fmtCompactTokens(total),
    known: true,
    // Coverage first when it is partial; otherwise the cached share — cache re-reads are most
    // of any long session, and « 600M tokens » without it reads like a bill.
    hint: reopened ? "since reopened" : total > 0 ? `${pct(usage.total.cache_read, total)} cached` : null,
    caveat: reopened,
    tip,
  };
}

/** The whole tile as one flat line, for assistive tech (the tooltip is pointer-only). */
export function tileLabel(tile: StatTile): string {
  return `${tile.label}: ${tile.value}. ${tile.tip.join(" ")}`;
}
