// Shared, React-free helpers for displaying a sub-agent (the `Agent`/`Task` tool):
// the friendly model label, the background detection, the status-dot mapping, and —
// crucially — resolving the sub-agent's `agent_id` (the key for its on-disk
// transcript) even while it runs in the background.
//
// Used by the inline card (ConductorThread), the conversation AgentBar, and the
// FlightDeck badge so they never drift.

import type { BackgroundTask, BackgroundTaskStatus, JsonValue } from "../ipc/client";
import type { StreamState } from "../ui/kit";

/** "claude-haiku-4-5-20251001" → "haiku-4-5" — the friendly bit of a model id. */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
}

/** Canonical display labels for the reasoning-effort levels, folding the ultracode
 *  tier in. Claude's effort enum is low/medium/high/xhigh/max (2.1.187), `max` the
 *  deepest pure-effort level above `xhigh` ("Extra"); `ultra` is the Codex-only rung
 *  above `max` (gpt-5.6). "Ultra code" is xhigh + a separate `ultracode` flag (see
 *  EffortGauge, which reuses this map so the gauge and every read-only surface never
 *  drift). */
export const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultra code",
} as const;

/** Friendly label for a conversation's live reasoning effort, or null when
 *  unknown (no `get_settings` read-back yet). `ultracode` outranks the raw
 *  effort. An unrecognised effort string falls through to itself (forward-compat). */
export function effortLabel(effort: string | null | undefined, ultracode?: boolean): string | null {
  if (ultracode) return EFFORT_LABELS.ultracode;
  if (!effort) return null;
  return (EFFORT_LABELS as Record<string, string>)[effort] ?? effort;
}

/** ms → "0.8s" / "1m 04s" — compact wall-clock for a finished sub-agent. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
  // Round the WHOLE duration to seconds before splitting it: rounding only the remainder
  // printed an impossible "1m 60s" for 119.6s.
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

/** True when a tool_use was launched detached (`run_in_background: true`) — generic
 *  over the producer (Bash / Agent / …). The shared primitive behind the per-tool
 *  helpers below. */
export function isRunInBackground(input: JsonValue): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>).run_in_background === true
  );
}

/** True when an `Agent` tool_use was launched detached (`run_in_background: true`). */
export function isBackgroundAgentInput(input: JsonValue): boolean {
  return isRunInBackground(input);
}

/**
 * Is this Claude sub-agent task DETACHED background work (AgentBar, background counts) rather
 * than a foreground agent rendering inline in its turn? Either its launching `Agent` tool_use
 * is one of the conversation's detached launches (`bgIds`, from the store's `bgAgentIds`), or
 * its current run was started by a main-thread `SendMessage` wake (`woken_by`) — a woken agent
 * always runs detached, whatever its launch, and may even carry the SendMessage's id, which
 * `bgIds` never holds. Not for Codex, which has no detached/foreground split.
 */
export function isDetachedAgentTask(t: BackgroundTask, bgIds: ReadonlySet<string>): boolean {
  return t.woken_by != null || (t.tool_use_id != null && bgIds.has(t.tool_use_id));
}

/** Is this sub-agent in a run started by a `SendMessage` wake right now? Such a run is
 *  listed in the AgentBar ({@link isDetachedAgentTask}), so the inline card of a
 *  foreground-launched agent steps aside meanwhile — the same agent never shows twice. */
export function isWokenRunLive(t: BackgroundTask | null | undefined): boolean {
  return !!t && t.woken_by != null && t.status === "running";
}

/** A background task's coarse lifecycle → the design's status-dot colour token. */
export function taskStatusDot(s: BackgroundTaskStatus): StreamState {
  switch (s) {
    case "running":
      return "work";
    case "failed":
      return "err";
    case "stopped":
      return "off";
    default:
      return "done";
  }
}

/** Flatten a tool_result's content (string | array of {text} | …) to plain text.
 *  Shared with the worktree-path parser so both stay in sync on content shapes. */
export function resultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

/**
 * Parse a sub-agent's id out of its `Agent` tool_result. A detached (background)
 * Agent returns an immediate ack containing `agentId: <id>` (and an
 * `…/agent-<id>.jsonl` / `…/<id>.output` path) — the id we need to read its
 * transcript BEFORE the terminal `task_notification` (which is the only thing that
 * back-fills `BackgroundTask.agent_id`). Returns null when nothing matches.
 */
export function agentIdFromResult(content: JsonValue | undefined): string | null {
  const own = launchAgentId(content);
  if (own) return own;
  const text = blocksText(content);
  if (!text) return null;
  // A SendMessage answers with JSON (`"resumedAgentId":"<id>"`).
  const json = text.match(/"(?:resumed)?agentId"\s*:\s*"([A-Za-z0-9_-]+)"/i);
  if (json) return json[1];
  // Any labelled id, the LAST one. The colon is required: the 2.1.286 launch ack opens with
  // "…including the agentId below, into a user-facing reply" — a separator-only pattern read
  // "below".
  const labelled = [...text.matchAll(/agent[_ ]?id"?\s*:\s*"?([A-Za-z0-9_-]+)/gi)];
  if (labelled.length > 0) return labelled[labelled.length - 1][1];
  const byFile = text.match(/agent-([A-Za-z0-9_-]+)\.jsonl/);
  if (byFile) return byFile[1];
  return null;
}

/** Does a tool_result body say `{"success": false, …}`? That is how `SendMessage` reports a
 *  failure (agent stopped by the user, could not be resumed, …): the CLI never sets
 *  `is_error` on it. Mirrors the socle's `send_message_reports_failure`. */
export function reportsFailure(content: JsonValue | undefined): boolean {
  const failed = (text: string) => {
    if (!text.includes('"success"')) return false;
    try {
      const v = JSON.parse(text) as { success?: unknown } | null;
      return v !== null && typeof v === "object" && v.success === false;
    } catch {
      return false; // not JSON: prose from an older binary — no evidence of failure
    }
  };
  if (typeof content === "string") return failed(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => !!b && typeof b === "object" && "text" in b && typeof b.text === "string" && failed(b.text),
  );
}

/** A tool_result's text blocks joined by NEWLINES (not {@link resultText}'s spaces), so a
 *  line the CLI puts in its own block still starts a line. */
function blocksText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
    .join("\n");
}

const launchIds = new WeakMap<object, string | null>();

/**
 * The id an `Agent`/`Task` LAUNCH result gives its own sub-agent — only the line the CLI
 * writes itself, `agentId: <id>` at the start of a line: the background launch ack, or the
 * trailer appended to a foreground agent's report (`agentId: <id> (use SendMessage…)`). The
 * LAST such line: a report is free prose and may quote such a line before the trailer; no id
 * mentioned anywhere else (prose, paths, JSON) counts — that would tie a card to an agent it
 * merely talks about. Memoised per content object (store contents are stable references), so
 * selectors may call it on every update.
 */
export function launchAgentId(content: JsonValue | undefined): string | null {
  if (content !== null && typeof content === "object") {
    const hit = launchIds.get(content);
    if (hit !== undefined) return hit;
  }
  const lines = [...blocksText(content).matchAll(/^agentId:\s*([A-Za-z0-9_-]+)/gm)];
  const id = lines.length > 0 ? lines[lines.length - 1][1] : null;
  if (content !== null && typeof content === "object") launchIds.set(content, id);
  return id;
}

/**
 * True when an `Agent` tool_result is the immediate ACK a DETACHED (background) sub-agent
 * returns at launch — "Async agent launched successfully … The agent is working in the
 * background. You will be notified automatically when it completes … output_file:
 * …/tasks/<id>.output". A FOREGROUND sub-agent never returns this (its tool_result is the
 * agent's final output), so it is an INDEPENDENT background signal.
 *
 * Why it exists: background-vs-foreground is otherwise told APART only by
 * `input.run_in_background === true` on the live `tool_use` block (the `task_*` lifecycle is
 * emitted by BOTH kinds). If that flag is missing from the live block — a transient wire
 * drop — a detached agent would render inline as a foreground card instead of going to the
 * AgentBar. This ack recovers the "detached" truth from the result.
 *
 * MUST be specific: a false positive folds a FOREGROUND sub-agent's id into `bgAgentIds`,
 * which HIDES its card + transcript from the thread with no compensating surface (silent
 * content loss). A foreground agent's free-prose output can easily mention "agent id" and
 * "working in the background" — especially when summarizing this very codebase. So we DON'T
 * trust any single loose phrase: we require ≥2 of the launch ACK's machine-generated,
 * near-unique markers to co-occur (a real ack carries all three; an ordinary summary carries
 * none). This also stays robust to the binary rewording ONE phrase (the other two still hit). */
export function isDetachedAgentAck(content: JsonValue | undefined): boolean {
  const text = resultText(content);
  if (!text) return false;
  let markers = 0;
  if (/async agent launched successfully/i.test(text)) markers++;
  if (/\boutput_file\b["\s:]+\S*\/tasks\/\S+\.output/i.test(text)) markers++;
  if (/notified automatically when it completes/i.test(text)) markers++;
  return markers >= 2;
}

/**
 * Parse a dynamic-workflow run's id out of its `Workflow` tool_result. A workflow ALWAYS
 * runs in the background — the tool returns an immediate ack whose text carries the run id
 * verbatim ("Run ID: wf_cb719d53-406", plus a "Transcript dir: …/wf_<id>" path). That id
 * is the key for [`super::subagents::load_workflow_run`] (which accepts the `wf_`-prefixed
 * form). The wire's `task_*` lifecycle events do NOT carry it, so this ack is the only live
 * source — exactly the role {@link agentIdFromResult} plays for sub-agents. Null when
 * nothing matches (e.g. resumed conversation: the result lives only in the transcript).
 */
export function runIdFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const byLabel = text.match(/run[_ ]?id["\s:]+(?:wf_)?([A-Za-z0-9-]+)/i);
  if (byLabel) return byLabel[1].startsWith("wf_") ? byLabel[1] : `wf_${byLabel[1]}`;
  // Fallback: any `wf_<id>` token (Transcript dir / Script file paths in the ack).
  const byToken = text.match(/\bwf_[A-Za-z0-9-]+/);
  return byToken ? byToken[0] : null;
}

/**
 * Best available `agent_id` for drilling into a sub-agent's transcript:
 *  1. the BackgroundTask's own `agent_id` (set at task_notification, foreground), else
 *  2. parsed from the immediate tool_result ack (background, available during the run), else
 *  3. derived from the task's `output_file` basename (`…/<id>.output` for an Agent).
 */
export function resolveAgentId(
  task: BackgroundTask | undefined,
  resultContent: JsonValue | undefined,
): string | null {
  if (task?.agent_id) return task.agent_id;
  const fromResult = agentIdFromResult(resultContent);
  if (fromResult) return fromResult;
  if (task?.kind === "agent" && task.output_file) {
    const m = task.output_file.match(/([A-Za-z0-9_-]+)\.(?:jsonl|output)$/);
    if (m) return m[1].replace(/^agent-/, "");
  }
  return null;
}
