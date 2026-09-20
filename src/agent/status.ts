// The agent/conversation STATUS model — a rich, UI-agnostic discriminated union
// derived from the raw session signals. This is the SINGLE source of truth for
// "what is this agent doing right now", shared by:
//   - the sidebar status dot + row highlight (this task), and
//   - the upcoming fleet / agent-management view, which renders the SAME status
//     differently and needs the carried context (the pending question, the
//     blocking tool, the error message) — not just a colour.
//
// Keep this module PURE: no React, no store imports beyond the `StreamState`
// colour type. Everything here is unit-testable in isolation (see status.test.ts).
//
// On the hard case — "open question" vs "ready for review": the protocol gives NO
// native signal for "Claude asked a question in plain text and is waiting". An
// open question and a finished statement BOTH end a turn with stop_reason
// "end_turn"/subtype "success" — they are indistinguishable on the wire. The only
// 100%-native question signal is the `AskUserQuestion` tool (a questionnaire). For
// everything else we fall back to a heuristic (`looksLikeQuestion`), and let the
// user dismiss a false positive with the "Seen" button.
import type { StreamState } from "../ui/kit";

export type AgentStatus =
  | { kind: "off" } // no live `claude` process (never started / stopped / exited)
  | { kind: "idle" } // live, nothing pending, last result already consumed
  | { kind: "running"; activity: string | null } // a turn is in flight
  | { kind: "backgrounding"; count: number } // main loop idle, but N background tools still running
  | { kind: "needInput"; via: "questionnaire" | "openQuestion"; prompt: string | null; bg?: number }
  | { kind: "needIntervention"; tool: string } // a permission prompt is blocking
  | { kind: "error"; message: string; bg?: number } // last finished turn ended in error
  | { kind: "review" }; // turn finished cleanly, not yet seen by the user

// The `bg?` on the two SETTLED-unseen ALERT states (open-question / error) carries how
// many background tools are STILL running while that alert is surfaced — i.e. "the agent
// wants you (a question / an error) AND work continues in the background". It drives the
// distinct violet accent, so the user can tell a lone alert from one raised while the
// background is still busy. A CLEAN finish while background work runs is NOT an alert and
// has nothing to review: it routes to the green `backgrounding` state instead (see
// {@link deriveAgentStatus}), so `review` never carries `bg`. Absent/0 = nothing in the
// background. See {@link backgroundCount}.

/**
 * The acknowledgeable, non-blocking reminders — the ONLY statuses that persist
 * across restarts (see `AgentSignals.persistedReminder`). A finished turn awaiting
 * a look (`review`), a turn that errored (`error`), or a heuristically-flagged open
 * question (`openQuestion`). Blocking states (questionnaire / permission) are NOT
 * here: they live only while the process does and must be answered, not dismissed.
 */
export type ReminderKind = "review" | "error" | "openQuestion";

/**
 * The minimal raw signals needed to derive an {@link AgentStatus}. All primitives
 * so a store selector can produce them shallow-stably (no nested objects).
 */
export interface AgentSignals {
  /** Live Rust session handle, or null when no `claude` process is running. */
  handle: string | null;
  /** True while a turn is in flight. */
  busy: boolean;
  /** True while a permission prompt is awaiting the user's answer. */
  awaitingPermission: boolean;
  /** tool_name of the first pending permission (null when none). */
  pendingToolName: string | null;
  /** A human prompt for the pending permission (title/description), for the fleet view. */
  pendingPrompt: string | null;
  /** Fine-grained activity hint from system/status (e.g. "requesting"). */
  activity: string | null;
  /** subtype of the last finished turn's turn_result (e.g. "success", "error_*"). */
  lastTurnSubtype: string | null;
  /** is_error flag of the last finished turn. */
  lastTurnIsError: boolean;
  /** Whether the user has consumed (replied to / dismissed) the last finished turn. */
  turnSeen: boolean;
  /** Text of the last assistant turn, for the open-question heuristic. */
  lastAssistantText: string | null;
  /**
   * Number of background tools (sub-agents, Monitor, Bash-bg, workflows) currently
   * RUNNING for this conversation. When the main loop is idle but this is > 0 the
   * conversation is "backgrounding" — calm, still interactive — rather than idle.
   */
  runningBackgroundTasks: number;
  /**
   * Of {@link runningBackgroundTasks}, how many are background *Bash commands*
   * (`kind:"bash"`). A subset; when it EQUALS `runningBackgroundTasks` (and both are
   * non-zero) the background set is exclusively Bash — the only case the
   * {@link reAlertOnBackgroundBash} setting acts on. See {@link reAlertOnBashFinish}.
   */
  runningBackgroundBashTasks: number;
  /**
   * The user's "re-alert on background Bash" setting (Settings → Notifications; OFF by
   * default). When ON, a turn that finishes cleanly while a background Bash command is the
   * SOLE remaining background task surfaces a ONE-TIME `review` (blue) alert that pings — the
   * "go look" the silent green `backgrounding` state would otherwise swallow. It changes ONLY
   * that finish edge (see {@link reAlertOnBashFinish}): once the user marks the turn seen, the
   * conversation falls back to the normal green `backgrounding` while the Bash keeps running.
   * It only bites in the Bash-only case; a mixed background set (a sub-agent / workflow / Monitor
   * also running) keeps the calm green state throughout. Sub-agents / workflows / Monitor are
   * unaffected regardless, as are error / open-question alerts (which alert either way).
   */
  reAlertOnBackgroundBash: boolean;
  /**
   * A reminder persisted from a previous run (or while live), surfaced ONLY when
   * the process is off (`handle === null`): it re-displays a finished-but-unseen
   * turn / error / open question across an app restart, since a settled state is
   * otherwise live-only and lost when the process dies. Null when nothing is
   * pending. While the process is live, the live signals above take precedence —
   * this is purely the off-state fallback. See `conversationsStore.pendingReminder`.
   */
  persistedReminder: ReminderKind | null;
}

/** The native questionnaire tool — the only 100%-reliable "Claude asks a question". */
export const QUESTIONNAIRE_TOOL = "AskUserQuestion";

/**
 * Heuristic: does this assistant text read as a question awaiting a reply? Used
 * only as a fallback because the protocol exposes no native "waiting on an open
 * question" signal (see the module header). Peels trailing whitespace / markdown
 * emphasis / closers so "**…?**", "(… ?)" and "…?\n```" still count as ending on
 * a "?". Imperfect by design — a rhetorical "?" trips it, a question phrased
 * without "?" misses it — but a false positive is one "Vu" click away.
 */
export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const stripped = text.replace(/[\s*_)\]"'`~>]+$/u, "");
  return stripped.endsWith("?");
}

/**
 * The question itself, out of an assistant message that {@link looksLikeQuestion}: the
 * trailing sentence(s) ending in "?" on its last line, with Markdown markers dropped and
 * whitespace collapsed, capped at `max` characters. `null` when there is none. Shown as the
 * detail of the "Waiting for your reply" status — the message's opening lines are rarely
 * the question, which by the heuristic's own definition is at the END.
 */
export function questionExcerpt(text: string | null, max = 200): string | null {
  if (!text) return null;
  const lines = text
    .replace(/```[\s\S]*?```/gu, " ") // a fenced block is never the question
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const plain = last
    .replace(/^(?:[-*+]|\d+[.)]|>|#{1,6})\s+/u, "") // list / quote / heading marker
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1") // [label](url) → label
    .replace(/[*_`~]+/gu, "") // emphasis / code markers
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s)\]"'>]+$/u, "");
  if (!plain.endsWith("?")) return null;
  // Keep the trailing run of sentences that are themselves questions ("A? Or B?").
  // Split by MATCHING sentences rather than a lookbehind: WKWebView only gained lookbehind
  // in Safari 16.4, and an unsupported one throws at PARSE time — taking the module with it.
  const sentences = (plain.match(/[^.!?]+[.!?]+(?:\s+|$)/gu) ?? [plain]).map((s) => s.trim());
  const keep: string[] = [];
  for (let i = sentences.length - 1; i >= 0 && sentences[i].endsWith("?"); i--) {
    keep.unshift(sentences[i]);
  }
  // A closer peeled off the end above leaves its opener dangling: "(Shall I?)".
  const q = keep.join(" ").replace(/^\((?!.*\))/u, "");
  return q.length > max ? `${q.slice(0, max - 1).trimEnd()}…` : q;
}

/** Human label for an error turn_result subtype. */
function errorMessage(subtype: string | null): string {
  switch (subtype) {
    case "error_max_turns":
      return "Turn limit reached";
    case "error_during_execution":
      return "Error during execution";
    default:
      return "The last response ended in an error";
  }
}

/**
 * Rebuild the off-state {@link AgentStatus} a persisted {@link ReminderKind}
 * stands for, or null when nothing is pending. The carried detail (exact error
 * subtype, the question text) isn't persisted — only the kind — so a restored
 * reminder shows the generic label; the precise text returns once the
 * conversation is live again. Inverse of {@link statusReminderKind}.
 */
function reminderStatus(kind: ReminderKind | null): AgentStatus | null {
  switch (kind) {
    case "review":
      return { kind: "review" };
    case "error":
      return { kind: "error", message: errorMessage(null) };
    case "openQuestion":
      return { kind: "needInput", via: "openQuestion", prompt: null };
    default:
      return null;
  }
}

/**
 * Whether a CLEAN turn end should surface a ONE-TIME `review` alert (+ ping) instead of falling
 * straight through to the silent green `backgrounding` state. True only when the user's
 * {@link AgentSignals.reAlertOnBackgroundBash} setting is ON and the running background set is
 * EXCLUSIVELY Bash commands (`runningBackgroundBashTasks === runningBackgroundTasks`, both > 0).
 *
 * This gates ONLY the finish edge: the goal is a single "go look" at the moment the turn ends, NOT
 * a persistent mode. Once the user marks the turn seen, {@link deriveAgentStatus} routes the
 * conversation back to the normal green `backgrounding` (full count) while the Bash keeps running —
 * exactly today's calm behaviour. The moment any non-Bash background work is also running (a
 * sub-agent / workflow / Monitor) the set is no longer Bash-only, so the setting doesn't bite and
 * the finish stays green. Error / open-question alerts are unaffected — they alert regardless, and
 * still carry the full background count for their violet "…but work continues" accent.
 */
export function reAlertOnBashFinish(s: AgentSignals): boolean {
  const bashOnly =
    s.runningBackgroundTasks > 0 &&
    s.runningBackgroundBashTasks === s.runningBackgroundTasks;
  return s.reAlertOnBackgroundBash && bashOnly;
}

/**
 * Derive the rich status from the raw signals. Order encodes priority:
 * off → blocking permission → running → (settled: error / open-question / review)
 * → idle. The "settled" branch only fires when the session is live, not busy, not
 * awaiting, and the last finished turn has NOT been consumed (`!turnSeen`).
 */
export function deriveAgentStatus(s: AgentSignals): AgentStatus {
  // A null handle subsumes "never started", "stopped", and "exited" — the
  // protocol does not distinguish them, and none has a live state to report. But
  // a settled reminder (review / error / open question) the user never acknowledged
  // is re-surfaced here even with no live process, so quitting the app doesn't lose
  // "go look at this". Cleared by "Vu" or the next message (see persistedReminder).
  if (!s.handle) return reminderStatus(s.persistedReminder) ?? { kind: "off" };

  // A pending permission genuinely BLOCKS the agent — it cannot proceed until the
  // user answers. The questionnaire is a need-input; any other tool is a blocking
  // intervention (Bash/Edit/Write/…).
  if (s.awaitingPermission) {
    if (s.pendingToolName === QUESTIONNAIRE_TOOL)
      return { kind: "needInput", via: "questionnaire", prompt: s.pendingPrompt };
    return { kind: "needIntervention", tool: s.pendingToolName ?? "tool" };
  }

  if (s.busy) return { kind: "running", activity: s.activity };

  // Live and idle. If the last turn just finished and the user hasn't acted on it,
  // surface it (error / open-question / review). Otherwise there's nothing to show.
  // An ALERT (error / open-question) genuinely wants the user, so it fires even while
  // background work runs — carrying that count as `bg` for the "…but work continues"
  // violet accent.
  if (!s.turnSeen) {
    const bg = s.runningBackgroundTasks > 0 ? s.runningBackgroundTasks : undefined;
    if (s.lastTurnIsError || (s.lastTurnSubtype?.startsWith("error") ?? false))
      return { kind: "error", message: errorMessage(s.lastTurnSubtype), bg };
    if (looksLikeQuestion(s.lastAssistantText))
      return { kind: "needInput", via: "openQuestion", prompt: s.lastAssistantText, bg };
    // Clean finish. If background work is STILL running there is NOTHING to review yet —
    // the workflow / sub-agents are churning and the agent will resume on its own — so this is
    // NOT a blue "review": fall through to the green `backgrounding` state below. EXCEPTION: the
    // "re-alert on background Bash" setting turns THIS finish edge into a one-time blue review
    // (+ ping) when the sole background work is a Bash command (see {@link reAlertOnBashFinish}) —
    // the "go look" the calm state would otherwise swallow. It is a one-shot: once the user marks
    // the turn seen (`turnSeen`), the block above is skipped and the conversation falls back to
    // the green `backgrounding` below while the Bash keeps running.
    if (!bg || reAlertOnBashFinish(s)) return { kind: "review" };
  }

  // Settled with nothing to review — but if background tools are still running, the
  // conversation isn't truly idle: it's quietly waiting on them (and stays interactive).
  // A calm, distinct GREEN "running-family" state rather than the dormant "idle" — reached
  // both when nothing was unseen and when a clean finish had background work still running
  // (including, after "Vu", the Bash-only case the setting re-alerted on at the finish edge).
  if (s.runningBackgroundTasks > 0)
    return { kind: "backgrounding", count: s.runningBackgroundTasks };

  return { kind: "idle" };
}

/**
 * Map a status onto the design's status-dot colour token (the 4-colour grouping:
 * green run / orange attention / blue review / grey idle-off, plus red error).
 * The fleet view can choose a finer rendering — this is the compact dot.
 */
export function agentStatusToDot(s: AgentStatus): StreamState {
  switch (s.kind) {
    case "off":
      return "off"; // grey outline
    case "idle":
      return "done"; // grey
    case "running":
      return "work"; // green
    case "backgrounding":
      return "bg"; // green (running-family) — main turn done, background work still running
    case "needInput":
    case "needIntervention":
      return "ask"; // orange
    case "review":
      return "review"; // blue
    case "error":
      return "err"; // red
  }
}

/**
 * Whole-row emphasis bucket for the sidebar (tints the entire conversation case),
 * or null for no emphasis. `running` stays quiet — only its dot pulses — so a
 * normally-working agent doesn't "shout"; off/idle are neutral.
 */
export function rowAttention(s: AgentStatus): "input" | "review" | "error" | null {
  switch (s.kind) {
    case "needInput":
    case "needIntervention":
      return "input";
    case "review":
      return "review";
    case "error":
      return "error";
    // The calm states get no whole-row emphasis. Listed explicitly (not a `default`)
    // so adding a future status kind is a compile error here until it's classified —
    // matching `agentStatusToDot` / `statusRank`. `backgrounding` is calm by design.
    case "running":
    case "backgrounding":
    case "idle":
    case "off":
      return null;
  }
}

/**
 * The importance "rail": which conversations light up their left rail (Flight Deck
 * card + sidebar row) because they deserve a glance — actively working, or waiting on
 * the user. The two CALM states (`idle` = lit but at rest, `off` = shut off) return
 * null: they recede together, since a live-but-idle conversation is no more important
 * to the eye than a stopped one. Distinct from `rowAttention` (which tints the whole
 * sidebar row background): the rail ALSO covers `running`/`backgrounding`, which stay
 * background-calm but earn a lit edge. Each token maps to a semantic colour already in
 * the palette — no new colour is introduced.
 */
export function railState(
  s: AgentStatus,
): "run" | "bg" | "review" | "att" | "err" | null {
  switch (s.kind) {
    case "running":
      return "run"; // green, flowing (most alive)
    case "backgrounding":
      return "bg"; // green → violet (working in the background)
    case "review":
      return "review"; // blue (finished, worth a look)
    case "needInput":
    case "needIntervention":
      return "att"; // orange, pulsed (needs you)
    case "error":
      return "err"; // red, pulsed (needs you)
    // Calm states: no rail. Listed explicitly (not a `default`) so a future status kind
    // is a compile error here until it's classified — matching the other classifiers.
    case "idle":
    case "off":
      return null;
  }
}

/**
 * Whether the conversation is actively doing work right now — a turn in flight
 * (`running`) or background tools still running (`backgrounding`). Deleting it in
 * these states kills live work, so the sidebar gates the otherwise friction-free,
 * ⌘Z-undoable delete behind a confirm here. The blocked states
 * (needInput / needIntervention) are paused waiting on the user — not running — and
 * a settled review/error/idle/off is inert; those keep the one-click delete.
 */
export function isActivelyRunning(s: AgentStatus): boolean {
  return s.kind === "running" || s.kind === "backgrounding";
}

/**
 * How many background tools are still running behind a SETTLED-unseen ALERT
 * (open-question / error) — i.e. "the agent wants you, but work also continues". 0 for
 * every other status, including `review` (a clean finish with background work running is
 * never `review` — it routes to `backgrounding`) and `backgrounding` itself (whose count
 * is its own `count` field, and whose green dot already conveys the running work). Drives
 * the alert's violet accent (the dot ring + the "N en fond" chip). See {@link AgentStatus}.
 */
export function backgroundCount(s: AgentStatus): number {
  switch (s.kind) {
    case "needInput":
    case "error":
      return s.bg ?? 0;
    default:
      return 0;
  }
}

/**
 * Collapse a status onto one of the four fleet-readout STAGES the "Fleet readout"
 * banner counts (sidebar + FlightDeck top). Coarser than {@link agentStatusToDot}:
 * the calm background state (`backgrounding`) folds into `running` (work is still
 * happening), the three attention states (`needInput` / `needIntervention` / `error`)
 * all fold into `needAttention`, and the two dormant states (`idle` / `off`) fold
 * into `idle`. Listed explicitly (not a `default`) so a new status kind is a compile
 * error here until it's classified — same discipline as `rowAttention`/`statusRank`.
 */
export function readoutBucket(s: AgentStatus): "running" | "review" | "needAttention" | "idle" {
  switch (s.kind) {
    case "running":
    case "backgrounding":
      return "running";
    case "review":
      return "review";
    case "needInput":
    case "needIntervention":
    case "error":
      return "needAttention";
    case "idle":
    case "off":
      return "idle";
  }
}

/**
 * Sort key for the FlightDeck: what to surface first. Lower = more important, so
 * action-required and errors come first (leftmost in a lane / top repo), then
 * review, then running, then the inactive history (idle, off). Ties are broken by
 * recency at the call site.
 */
export function statusRank(s: AgentStatus): number {
  switch (s.kind) {
    case "needInput":
    case "needIntervention":
    case "error":
      return 0; // action required / error
    case "review":
      return 1; // to review
    case "running":
      return 2; // running
    case "backgrounding":
      return 3; // background tasks running (calm)
    case "idle":
      return 4;
    case "off":
      return 5;
  }
}

/**
 * The {@link ReminderKind} a status maps to, or null when it isn't an
 * acknowledgeable reminder. This is the single definition of "which statuses
 * persist": the event router writes its result to `pendingReminder`, and
 * {@link isDismissable} / {@link reminderStatus} are its two faces. A real block
 * (questionnaire / permission) is NOT a reminder — it must be answered live, not
 * dismissed — so it maps to null.
 */
export function statusReminderKind(s: AgentStatus): ReminderKind | null {
  if (s.kind === "review") return "review";
  if (s.kind === "error") return "error";
  if (s.kind === "needInput" && s.via === "openQuestion") return "openQuestion";
  return null;
}

/**
 * Whether the user can acknowledge ("Vu") this status to clear it back to idle.
 * Exactly the statuses that map to a {@link ReminderKind} — a finished turn
 * awaiting review, an error to acknowledge, or a heuristically-flagged open
 * question. A real block (questionnaire / permission) is not dismissable.
 */
export function isDismissable(s: AgentStatus): boolean {
  return statusReminderKind(s) !== null;
}
