// UI-side derived types. The wire types (ConversationItem, NormalizedBlock, …)
// come from the generated IPC bindings and are re-exported here so feature code
// has a single import surface for "everything conversation-shaped".

import type {
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
  SessionStatePayload,
} from "../ipc/client";

export type {
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
  SessionStatePayload,
};

/** Status of a single agent to-do, mirroring the TodoWrite tool's vocabulary. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * One agent to-do, captured from a `TodoWrite` tool_use. `activeForm` is the
 * present-tense phrasing some agents emit for the in-progress label; optional
 * because the official client only relies on `content` + `status`.
 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/**
 * Compact, fully-derived view of a todo list: counts plus the "current" item.
 * Pure-derivable from `TodoItem[]` (see `todoSummary`), so the conversation bar
 * and any other consumer (the multi-agent dashboard) share one definition.
 */
export interface TodoSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  /** First `in_progress` item, else first `pending`, else null. */
  current: TodoItem | null;
  allDone: boolean;
}

/** Lifecycle of a single turn as the UI sees it. */
export type TurnStatus = "streaming" | "final" | "interrupted";

export type TurnRole = "assistant" | "user";

/**
 * One rendered turn. Claude streams a single logical message (one `id`) as a
 * sequence of content blocks (thinking, then text, then tool_use, …), each
 * delivered as its OWN `assistant_message` event. We APPEND those blocks into
 * `blocks` as they finalize, while the live text/thinking buffers hold only the
 * block currently being typed. Render = finalized `blocks` followed by the live
 * buffer tail, so nothing already shown is ever overwritten.
 */
/** An image joined to a user turn, kept for the optimistic bubble (thumbnail) and
 *  ready for the wire (base64 → `image` block). `dataBase64` is raw base64, NO
 *  `data:` prefix; the renderer builds the data URL from `mediaType` + `dataBase64`. */
export interface UserTurnImage {
  mediaType: string;
  dataBase64: string;
  /** Display name (filename, or "Pasted image") — optional, for the chip/title. */
  name?: string;
}

export interface Turn {
  id: string;
  role: TurnRole;
  status: TurnStatus;
  /** User turn only: images joined to this message (attached via the composer's
   *  "+" or pasted). Rendered as thumbnails in the bubble; absent on turns hydrated
   *  from disk (the optimistic-only path carries them). */
  images?: UserTurnImage[];
  /** Live text of the block currently streaming (ignored once status!=="streaming"). */
  streamingText: string;
  /** Live extended-thinking of the block currently streaming. */
  streamingThinking: string;
  /** Authoritative assembled blocks, accumulated in arrival order (starts empty). */
  blocks: NormalizedBlock[];
  /** Non-null => this turn belongs to a sub-agent (Task) sub-thread. */
  parentToolUseId: string | null;
  /** True once a thinking section has been seen, so we can keep it collapsible. */
  hasThinking: boolean;
  /**
   * User turn only: true when the message was sent WHILE the agent was busy, so
   * the CLI queues it and injects it mid-turn rather than starting a fresh turn.
   * Drives the "pending" badge on the bubble. Cleared once the message has been
   * delivered to the agent — at the next ROOT `message_started` (the model call
   * past the injection boundary), with `turn_result` / stop / send-error as safety
   * nets so the badge can never linger.
   */
  queued?: boolean;
  /**
   * User turn only: DURABLE record that this message was injected mid-work (sent while
   * the agent was busy). Unlike `queued` (a transient badge that clears on delivery), this
   * is set once and NEVER cleared, so clean-output can tell a genuine mid-work injection
   * (absorb it into the round as an in-band marker) from a real new prompt (starts its own
   * round) — see `coalesceCleanRounds`. Absent on turns hydrated from disk (the transcript
   * carries no such flag), so a RESUMED conversation's user prompts correctly stay their own
   * rounds instead of collapsing into one fold.
   */
  injectedMidTurn?: boolean;
  /**
   * User turn only, Claude only, LIVE only: the uuid stamped on the wire when WE sent
   * this message (returned by `send_message`). It addresses the message in the binary's
   * command queue, which is what lets a still-pending message be dropped individually
   * (`cancel_queued_message`). Absent on turns restored from disk and on remote turns —
   * neither can be cancelled, since the queue only holds what has not run yet.
   */
  wireUuid?: string;
  /**
   * Codex only: the backend turn id this assistant turn belongs to (the app-server's
   * `turn/start` id, live; the rollout's `turn_context.turn_id`, cold). Lets the thread
   * target a Codex turn boundary by id for native rewind/fork (`thread/fork{lastTurnId}`)
   * instead of Claude's prompt-text locator. Absent on Claude turns and on user turns.
   */
  codexTurnId?: string;
}

/** A tool result, joined to its tool_use by id. */
export interface ToolResult {
  toolUseId: string;
  content: JsonValue;
  isError: boolean;
  parentToolUseId: string | null;
}

/** The footer payload of a finished turn (cost / duration / num_turns). */
export interface TurnResultMeta {
  subtype: string;
  isError: boolean;
  result: JsonValue | null;
  /** API-level error status carried by an errored `result` (e.g. `"overloaded"`),
   *  surfaced as a typed heading. `null` on success / when the CLI omits it. */
  apiErrorStatus: string | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  /** Cumulative model/API time this turn (the "N s of model" breakdown of durationMs). */
  durationApiMs: number | null;
  /** Time-to-first-token this turn. Captured but not surfaced in the UI yet. */
  ttftMs: number | null;
}

/** A surfaced system notice (compact boundary, sub-agent lifecycle, …). */
export interface NoticeItem {
  id: string;
  subtype: string;
  detail: JsonValue;
}

/**
 * A local, client-side error surfaced in the timeline — e.g. a message that could
 * not be sent because the `claude` session failed to spawn. Not from the core's
 * event stream: it makes an otherwise-silent command failure visible to the user.
 */
export interface ErrorItem {
  id: string;
  message: string;
  /** Optional raw technical detail (stderr / stack / raw line), shown behind a
   *  collapsed "Technical details" disclosure. */
  detail?: string | null;
}

/**
 * The ordered render stream for a session: turns, notices and turn-footers are all
 * positioned by a single id list so they render in arrival order.
 */
export type TimelineEntry =
  | { kind: "turn"; id: string }
  | { kind: "notice"; id: string }
  | { kind: "turn_result"; id: string }
  | { kind: "error"; id: string };

/**
 * A neutral in-band marker absorbed into a clean-output assistant round (see
 * `coalesceCleanRounds`): either a control-change bar (a `notice`) or a message the user
 * injected mid-work (a `user` turn). It renders inline in the response flow at its
 * chronological place WITHOUT breaking the work fold — the fix for "a mid-turn marker cuts
 * clean output in two". `after` = how many of the round's assistant turns precede it (0 =
 * before the first turn); the referenced `id` is resolved to content only at render time.
 */
export interface RoundMarker {
  markerKind: "notice" | "user";
  id: string;
  after: number;
}

/** Everything we hold for one live session. */
export interface SessionEntry {
  session: string;
  state: SessionStatePayload;
  timeline: TimelineEntry[];
  turns: Record<string, Turn>;
  notices: Record<string, NoticeItem>;
  /** Client-side error entries (failed sends), keyed by generated id. */
  errors: Record<string, ErrorItem>;
  turnResults: Record<string, TurnResultMeta>;
  /** tool_use_id -> result, joined lazily (core does not pre-link them). */
  toolResults: Record<string, ToolResult>;
  /** Pending permission prompts, queued by request_id (order preserved). */
  pendingPermissions: PermissionRequestPayload[];
  /**
   * Per (parent_tool_use_id|"root") pointer to the currently-open assistant turn,
   * so a text_delta with a null message_id can be attributed correctly.
   */
  openBubble: Record<string, string | undefined>;
  /** Ordered turn ids per sub-agent (Task) thread, keyed by parent_tool_use_id. */
  subThreads: Record<string, string[]>;
  /**
   * tool_use ids of the sub-agents (`Agent`/`Task`) launched DETACHED
   * (`input.run_in_background === true`). Captured once per assistant_message (not
   * re-scanned per token) so the pinned AgentBar reads them in O(1). Detached
   * sub-agents are shown in that bar, not inline in the thread.
   */
  bgAgentIds: string[];
  /**
   * The agent's current to-do list (last `TodoWrite` on the MAIN thread wins; a
   * sub-agent keeps its own and does not clobber this). Empty until the agent
   * writes one. Read via `useTodos` / `useTodoSummary`.
   */
  todos: TodoItem[];
  /**
   * Has the user consumed (replied to / acknowledged) the LAST finished turn?
   * The protocol only says "busy" or "not busy"; it cannot tell "just finished,
   * go look" (→ review) apart from "already seen, dormant" (→ idle) — that
   * distinction is about the USER, not Claude. So we track it ourselves, like an
   * unread badge: set false when a turn finishes (`turn_result`), set true when
   * the user sends the next message or clicks "Vu" (`markSeen`). Drives the
   * review / need-input(open-question) states (see agent/status.ts).
   */
  turnSeen: boolean;
  /** Monotonic counter for generated ids (user turns, notices, turn footers). */
  seq: number;
  /**
   * Insert position (into `timeline`) for an OUT-OF-ORDER replayed user turn — a
   * message typed on the phone/web while Remote Control is on. With
   * `--replay-user-messages` the CLI echoes that turn on the stream, but it can arrive
   * AFTER the assistant response it triggered has already begun streaming (or even
   * finished). Appending it would render it after the answer; instead we splice it at
   * this anchor. The anchor freezes at each turn boundary (`turn_result` → end of
   * timeline) and does NOT move while assistant/tool messages stream, so a replay lands
   * right BEFORE the whole current-turn response. Replicates the official extension's
   * `replayInsertIndex`. (Our OWN turns never reach here — the core suppresses their
   * echo by uuid — so this only orders remote turns and history replays.)
   */
  replayAnchor: number;
  /**
   * Wall-clock start (`Date.now()`) of the turn currently in flight, or `null` when no
   * turn is running. Stamped when `state.busy` goes false→true and cleared on true→false
   * (and on `clearState`). Drives the LIVE elapsed counter in the working indicator (shown
   * once a turn runs past a threshold, like the CLI). NOT the finished turn's duration — that
   * is `TurnResultMeta.durationMs`, measured by the binary and delivered in `turn_result`.
   */
  turnStartedAt: number | null;
  /**
   * Number of turns started in this conversation, incremented on each `state.busy` false→true
   * edge (same edge as {@link turnStartedAt}). `0` before the first turn. Feeds the playful
   * "Thinking…" word rotation as a per-turn seed (the word re-draws on every new turn); the
   * TIER is driven by cumulative thinking time, not this count. See `store/thinkingWords.ts`.
   */
  turnCount: number;
  /**
   * Cumulative wall-clock (ms) the generic "Thinking…" spinner has been shown across the whole
   * discussion — the measure that drives the playful word's difficulty tier. A global ticker
   * (`useGlobalSessionEvents`) accrues it on the busy-and-generic-thinking transitions; the live
   * open spell (since {@link thinkingSince}) is added at display time. In-memory (resets on
   * reload). We measure the visible spinner, NOT internal reasoning-block time (often ~0).
   */
  thinkingMs: number;
  /** Start (`Date.now()`) of the current "Thinking…" spinner spell, or `null` when not in it. */
  thinkingSince: number | null;
  /**
   * Wall-clock start of the thinking block currently streaming, or `null` when no thinking
   * is in flight. Stamped on the `streamingThinking` empty→non-empty edge (a new block —
   * the buffer is reset and this cleared each time a thinking block finalizes), cleared on
   * finalize / turn-end / `clearState`. Drives the LIVE counter on a streaming ThinkingBlock.
   */
  thinkingStartedAt: number | null;
  /**
   * Frozen duration (ms) of each FINALIZED thinking block, keyed by the block's text (which
   * is unique per block and is exactly what the renderer receives). Front-only, never wiped
   * mid-session so a settled block keeps its number. Absent on blocks hydrated from disk
   * (no deltas → no start stamp) → the renderer shows no duration there.
   */
  thinkingDurations: Record<string, number>;
  /**
   * Wall-clock start of each tool call in flight, keyed by tool_use_id. Stamped when the
   * tool_use block appears (`assistant_message`), consumed when its `tool_result` lands.
   * Drives the LIVE counter on a running tool row. Front-only.
   */
  toolStartedAt: Record<string, number>;
  /**
   * Frozen duration (ms) of each finished tool call (tool_use → tool_result), keyed by
   * tool_use_id. Front-measured (≈ execution time as seen by the client), never wiped
   * mid-session. Absent on tools hydrated from disk → no duration shown there.
   */
  toolDurations: Record<string, number>;
}
