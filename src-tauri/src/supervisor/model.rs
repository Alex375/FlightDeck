//! Normalized, UI-facing model emitted by a session.
//!
//! Design principle (spec §6.3): **normalize in Rust, keep React dumb.** The
//! core assembles the raw stream-json into these typed events; the UI just
//! renders them. They derive `specta::Type` so the IPC layer can re-export them
//! to TypeScript verbatim.
//!
//! Dynamic, schema-free payloads (a tool's input, a tool_result's content) are
//! kept as [`serde_json::Value`] — they are arbitrary by nature and the UI shows
//! them generically.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// Coarse lifecycle + identity of a session, emitted whenever it changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionStatePayload {
    /// `true` while a turn is in flight (between a user message and its `result`).
    pub busy: bool,
    /// The CLI-assigned conversation id (from `system/init`); enables `--resume`.
    pub session_id: Option<String>,
    /// The session's CURRENT working directory (from `system/init`). The CLI can
    /// move it mid-session when the agent calls `EnterWorktree`/`ExitWorktree`, so
    /// the UI reads this — not the static spawn cwd — to show which worktree the
    /// conversation is in right now.
    pub cwd: Option<String>,
    /// Current model id (from `system/init`, refined by the `get_settings`
    /// read-back to the resolved id, e.g. `claude-opus-4-8[1m]`).
    pub model: Option<String>,
    /// Current permission mode (from `system/init` / the `set_permission_mode` ack).
    pub permission_mode: Option<String>,
    /// Current reasoning-effort level (`low`/`medium`/`high`/`xhigh`). NOT carried
    /// by `system/init` — sourced from the `get_settings` control read-back (and the
    /// spawn seed). `None` until the first read-back. Drives the effort gauge.
    pub effort: Option<String>,
    /// Whether "ultracode" (xhigh effort + standing dynamic-workflow orchestration)
    /// is active right now. A SEPARATE boolean flag in the CLI, not an effort value.
    pub ultracode: bool,
    /// Fine-grained activity hint from `system/status` (e.g. `"requesting"`).
    pub activity: Option<String>,
    /// `true` while waiting on the user to answer a permission prompt.
    pub awaiting_permission: bool,
    /// The API call for the current turn is being RETRIED after a connection failure
    /// (`system/api_error`, which the CLI emits before each automatic retry). Set while
    /// a retry is pending, cleared as soon as the turn produces anything else.
    ///
    /// Without this the user sees a turn that simply hangs: the CLI recovers on its
    /// own, but nothing on screen explains the pause. Carries `attempt`/`max` so the UI
    /// can say how far along the recovery is.
    pub retry: Option<RetryState>,
    /// `true` once the session has ended (the `claude` process exited or was
    /// stopped). A final state event with this set lets the UI mark the session
    /// dead instead of showing it as live forever.
    pub ended: bool,
    /// Tokens occupying the model's context window right now: the last model call's
    /// `input + cache_creation + cache_read` (from `message_start` live, then the
    /// `result`). `None` until the first turn reports usage. Drives the context ring.
    pub context_tokens: Option<u64>,
    /// Size of the active model's context window (from `result.modelUsage[…].contextWindow`,
    /// e.g. 200k or 1M for Opus in 1M mode). `None` until a `result` reports it; once
    /// known it is kept across turns that omit it. The ring's denominator.
    pub context_window: Option<u64>,
    /// Latest subscription rate-limit snapshot (from `rate_limit_event`). `None` until
    /// the CLI emits one. NOTE: the stream only carries status + reset, NOT a usage
    /// percentage — that lives behind the `/api/oauth/usage` endpoint (separate task).
    pub rate_limit: Option<RateLimitSnapshot>,
}

/// One selectable model, as the RUNNING session reports it via the `list_models`
/// control request. Authoritative in a way a hard-coded table can never be: the
/// binary resolves the provider, the settings cascade and the org enforcement
/// policy, so this list is exactly what the session may actually run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct LiveModel {
    /// The alias to send back in `set_model` (e.g. `default`, `sonnet`, `opus[1m]`).
    pub value: String,
    /// The concrete model the alias resolves to (e.g. `claude-opus-5[1m]`). Carries the
    /// `[1m]` suffix when the session runs the 1M-context variant — the ONLY wire signal
    /// of the context window, which the model name alone does not give.
    pub resolved_model: Option<String>,
    /// Human label for the picker (e.g. `Opus (1M context)`).
    pub display_name: String,
    /// One-line description shown under the label.
    pub description: Option<String>,
    /// Whether this model accepts an effort level at all.
    pub supports_effort: bool,
    /// The effort ladder this model accepts, in wire order (`low` … `max`). Data-driven:
    /// a binary that adds a rung exposes it here with no code change on our side.
    pub supported_effort_levels: Vec<String>,
}

/// Outcome of a `rewind_files` request — the binary restoring the files it edited
/// since a given user message, from its own checkpoints. Also the shape of a
/// `dry_run` PREVIEW, which reports what *would* change without touching the disk.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RewindFilesResult {
    /// Whether the rewind is possible (dry run) or was performed (real run). `false`
    /// with an `error` when file checkpointing is off or no checkpoint covers the message.
    pub can_rewind: bool,
    /// Absolute paths the rewind would restore / did restore.
    pub files_changed: Vec<String>,
    /// Lines that would be / were added back.
    pub insertions: u32,
    /// Lines that would be / were removed.
    pub deletions: u32,
    /// Why the rewind is unavailable. The binary answers a SUCCESS control_response even
    /// when it refuses, so this is the only signal — never swallow it.
    pub error: Option<String>,
}

/// Live status of one MCP server, queried on demand from the running session via
/// the `mcp_status` control request (NOT the `system/init` snapshot, which is
/// point-in-time and shows servers stuck at `pending`). This is the authoritative
/// real-time picture the conversation view shows — including claude.ai-hosted
/// connectors that only exist in the live session. Distinct from the *configured*
/// on-disk [`crate::extensions::McpServerInfo`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct McpServerLive {
    /// Server name as the session reports it (`plugin:<p>:<s>` for a plugin server,
    /// `claude.ai <Name>` for a connector).
    pub name: String,
    /// `connected` / `disconnected` / `pending` / `checking_status` / `failed` /
    /// `needs-auth` / `disabled`.
    pub status: String,
    /// Where it comes from: `user` / `project` / `local` / `dynamic` (plugin) /
    /// `claudeai` (account connector). `None` if absent.
    pub scope: Option<String>,
    /// Transport from the server config (`stdio` / `http` / `sse`).
    pub transport: Option<String>,
    /// Launch command for a stdio server (args omitted — may carry secrets).
    pub command: Option<String>,
    /// Endpoint for an http/sse server.
    pub url: Option<String>,
    /// Number of tools the server currently exposes (0 unless connected).
    pub tool_count: u32,
    /// Names of the tools the server exposes (empty unless connected) — shown when
    /// the user expands a server row.
    pub tools: Vec<String>,
    /// Why a Codex MCP server failed to start (e.g. `reauthenticationRequired`), captured
    /// from the `mcpServer/startupStatus/updated` push. Turns a mute "disconnected" into a
    /// named "failed" reason. `None` for Claude servers and for Codex servers that started
    /// fine.
    #[serde(default)]
    pub failure_reason: Option<String>,
}

/// Result of an `mcp_authenticate` control request (OAuth start for an http/sse
/// server). The binary returns an `authUrl` to open in the browser; the loopback
/// redirect is handled by the CLI itself in the common case. `requires_user_action`
/// is true when the flow needs the user to paste back a callback URL (the rarer
/// non-loopback path — surfaced to the UI). `error` carries a rejection message
/// (auth not supported, server unknown, …) without it being a fatal session error.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct McpAuthResult {
    pub auth_url: Option<String>,
    pub requires_user_action: bool,
    pub error: Option<String>,
}

/// Live state of a session's Remote Control ("bridge") — the native Claude Code
/// feature (`/remote-control`) that mirrors this local session onto claude.ai/code
/// and the Claude mobile app so it can be viewed/driven from another device. Toggled
/// via a `remote_control` control request; enabling returns `session_url` (the
/// claude.ai/code link to open). A `connected` bridge can later be DOWNGRADED by a
/// `system/bridge_state` health message (the phone/web dropped, or the bridge
/// errored) — "connected" is only ever reached from the control response, never from
/// `bridge_state`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RemoteControlState {
    /// `"disconnected"` | `"connecting"` | `"connected"` | `"error"`.
    pub status: String,
    /// The claude.ai/code URL to view & control this session — present when
    /// `status == "connected"`. CLAUDE only (its bridge hands back a URL to open).
    pub session_url: Option<String>,
    /// A rejection / bridge-error message — present when `status == "error"`.
    pub error: Option<String>,
    /// A device-pairing code to enter in the Codex mobile app to link a device to this
    /// remote-controlled session — CODEX only (its `remoteControl/enable` returns no URL;
    /// a device is linked via a separate pairing flow). `None` for Claude and when not
    /// enabled. The front keeps it visible across status-only pushes while still active.
    pub pairing_code: Option<String>,
}

/// Context-meter seed for a conversation, read from its on-disk transcript so the
/// ring shows the real fill the moment a conversation is opened / its stream turned
/// on — before the first new turn streams live usage. `context_window` is the model's
/// provisional window (the transcript carries no authoritative `modelUsage`); the
/// first live `result` later refines it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ContextFill {
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

/// The active `/goal` of a conversation (Claude Code's native goal feature: Claude keeps
/// working across turns until a small fast model confirms the condition holds). Reconstructed
/// from the on-disk transcript — the CLI records goal state as `attachment` lines of
/// `type:"goal_status"`, which are **DISK-ONLY** (never emitted on the live stream), so this is
/// the only place to read it. `None` when no goal is active (never set, achieved, or cleared).
/// Mirrors the CLI's own `restoreGoalFromTranscript`: walk the goal_status snapshots and keep the
/// last un-terminated one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct GoalState {
    /// The completion condition the user set (`/goal <condition>`).
    pub condition: String,
    /// The evaluator's most recent reason (why the condition is / isn't met yet). `None`
    /// before the first post-turn evaluation.
    pub reason: Option<String>,
}

/// Subscription rate-limit status, normalized from `rate_limit_event.rate_limit_info`.
/// Carries only what the stream-json protocol exposes: the coarse `status`, the
/// reset time, the window type, and whether overage is active. The precise usage
/// percentage is NOT in the stream (it comes from `GET /api/oauth/usage`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RateLimitSnapshot {
    /// `"allowed"` (no warning), `"allowed_warning"` (approaching), `"rejected"` (limited), …
    pub status: Option<String>,
    /// Unix epoch seconds when the current window resets.
    pub resets_at: Option<i64>,
    /// Which window this refers to: `"five_hour"`, `"seven_day"`, …
    pub limit_type: Option<String>,
    /// `true` while the account is spending overage credits.
    pub using_overage: bool,
}

/// One authoritative content block of an assistant message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedBlock {
    Text { text: String },
    Thinking { text: String },
    ToolUse { id: String, name: String, input: Value },
    /// Any block kind we do not specialize (images, documents, …) kept raw.
    Other { raw: Value },
}

/// A normalized conversation event the UI applies incrementally. Tagged on
/// `kind` so the TS side is a simple discriminated union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationItem {
    /// An assistant turn began (from `stream_event/message_start`).
    MessageStarted {
        id: String,
        role: String,
        parent_tool_use_id: Option<String>,
    },
    /// Live assistant text token(s) (from `content_block_delta/text_delta`).
    TextDelta {
        message_id: Option<String>,
        text: String,
    },
    /// Live extended-thinking token(s).
    ThinkingDelta {
        message_id: Option<String>,
        text: String,
    },
    /// A past user turn, replayed from Claude's transcript when a conversation is
    /// resumed. The live path never emits this — the UI adds user turns
    /// optimistically on send — so it only appears during history restore.
    UserMessage {
        id: String,
        text: String,
        parent_tool_use_id: Option<String>,
        /// `true` for a LIVE echo re-emitted by `--replay-user-messages` (a remote
        /// phone/web turn): the UI splices it before the current turn's response (it
        /// can arrive out-of-order). `false` for a chronological transcript restore,
        /// which the UI appends. See the front `user_message` reducer.
        replay: bool,
    },
    /// The authoritative assembled assistant message (text + tool_use blocks).
    /// Carries the same `id` as the streamed `message_start` — the UI reconciles.
    AssistantMessage {
        id: String,
        blocks: Vec<NormalizedBlock>,
        parent_tool_use_id: Option<String>,
        /// The CODEX turn id this item belongs to (the app-server's `turn/start` id, live;
        /// the rollout's `turn_context.turn_id`, cold). Lets the front target a Codex turn
        /// boundary by id for native rewind/fork (`thread/fork{lastTurnId}`) instead of the
        /// Claude text-match locator. Always `None` on the Claude backend (which has no such
        /// id and targets by prompt text).
        #[serde(default)]
        turn_id: Option<String>,
    },
    /// A tool result, delivered by the CLI as a `user` message.
    ToolResult {
        tool_use_id: String,
        content: Value,
        is_error: bool,
        parent_tool_use_id: Option<String>,
    },
    /// End of a turn (`result`).
    TurnResult {
        subtype: String,
        is_error: bool,
        result: Option<Value>,
        /// API-level error status on an errored turn (e.g. `"overloaded"`); `None` on
        /// success or when the CLI omits it. Drives a typed error heading in the UI.
        api_error_status: Option<String>,
        total_cost_usd: Option<f64>,
        num_turns: Option<u64>,
        duration_ms: Option<u64>,
        /// Cumulative model/API time this turn (the "N s of model" breakdown).
        duration_api_ms: Option<u64>,
        /// Time-to-first-token this turn; captured but not yet surfaced in the UI.
        ttft_ms: Option<u64>,
    },
    /// A non-conversational notice surfaced in the timeline. Two families:
    ///  - informational: `control_change` (a confirmed model/effort/mode move),
    ///    compact boundaries, …
    ///  - errors: `control_error`, `process_exited`, `send_failed`, `protocol_error`,
    ///    and the generic `error` — each carries `detail.message` (+ optional
    ///    `detail.detail`/`stderr`/`exit_code`) and renders as a visible error bubble.
    ///    This is the single channel any layer uses to surface an error without new
    ///    plumbing (the "zero silent error" contract).
    Notice {
        subtype: String,
        detail: Value,
    },
}

/// An in-flight automatic retry of the current turn's API call.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RetryState {
    /// Which attempt is being made (1-based), when the CLI reports it.
    pub attempt: Option<u32>,
    /// How many attempts the CLI will make in total.
    pub max: Option<u32>,
    /// Short human reason ("Connection error."), when one is available.
    pub reason: Option<String>,
}

/// A `can_use_tool` permission prompt surfaced to the UI. The UI answers it via
/// the `answer_permission` command, echoing `request_id`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRequestPayload {
    pub request_id: String,
    pub tool_name: String,
    pub tool_use_id: String,
    pub input: Value,
    pub title: Option<String>,
    pub description: Option<String>,
    /// CLI-provided suggestions (kept raw).
    pub suggestions: Value,
    /// The path that triggered the check, when the CLI blocked on one (e.g. an edit
    /// outside the session's worktree, or outside the allowed directories). Carries
    /// the "why" of a prompt that would otherwise read as an ordinary tool request.
    pub blocked_path: Option<String>,
    /// The CLI's own reason for asking (kept raw — the shape is not contractual).
    /// Rendered as free text when it holds a human-readable string.
    pub decision_reason: Value,
    /// Set when the prompt comes from a background sub-agent task rather than the
    /// main thread, so the card can attribute it instead of implying the user's own
    /// turn is blocked.
    pub agent_id: Option<String>,
}

/// A pending permission prompt is no longer answerable — the CLI withdrew it
/// (`control_cancel_request`). The UI drops the card: without this it prunes
/// `pendingPermissions` only when the user answers, leaving a dead card on screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionResolvedPayload {
    pub request_id: String,
}

/// One slash command available in the session, as advertised by the CLI in its
/// `initialize` control response (spec §4.4). The same shape the official VS Code
/// extension consumes to drive its `/` autocomplete menu. `name` carries NO
/// leading slash (e.g. `"compact"`, `"tosse-workflow:pickup"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SlashCommand {
    pub name: String,
    /// Human-readable description (may be empty). For skills, the CLI prefixes a
    /// `(plugin)` / `(dynamic workflow)` source hint.
    pub description: String,
    /// Hint for the command's arguments (e.g. `"<task_id>"`), empty when none.
    pub argument_hint: String,
}

/// Which producer a background task came from. The `claude` binary runs ONE generic
/// background-task system for four producers; we tell them apart from `task_type`
/// plus the correlated `tool_use` name (see [`super::assembler`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskKind {
    /// A sub-agent launched by the `Agent` tool (`task_type:"local_agent"`).
    Agent,
    /// A dynamic-workflow run launched by the `Workflow` tool.
    Workflow,
    /// A shell command launched by `Bash` with `run_in_background:true`.
    Bash,
    /// A live watch launched by the `Monitor` tool.
    Monitor,
    /// A background task whose producer could not be classified yet.
    Other,
}

/// Coarse lifecycle status of a background task, normalized from `task_*` events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskStatus {
    /// Created and not yet finished (`task_started`, or a non-terminal patch).
    Running,
    /// Finished successfully (`patch.status`/notification `"completed"`).
    Completed,
    /// Finished with an error (`"failed"`/`"error"`).
    Failed,
    /// Cancelled via `TaskStop` / session end (`"stopped"`/`"cancelled"`).
    Stopped,
}

/// A normalized background task, keyed by `task_id` and updated in place as its
/// `task_*` lifecycle events arrive. The single model behind the (future) sub-agent /
/// workflow / Monitor / background-Bash views — the rich per-producer detail (full
/// transcript, manifest, output) is read from disk on demand (see
/// [`super::subagents`]), never carried here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct BackgroundTask {
    /// Stable id that ties every `task_*` event of this task together.
    pub task_id: String,
    pub kind: BackgroundTaskKind,
    /// The `tool_use` block that spawned the task (== `parent_tool_use_id` of any
    /// streamed child content). Lets the UI anchor the task under its tool card.
    pub tool_use_id: Option<String>,
    /// Human label = the NAME the agent gave the task (the tool's `description`, e.g.
    /// "build the app"). This is the meaningful, readable line shown pinned in the UI.
    /// `None` when the agent gave no description (the UI then falls back to `command`).
    pub label: Option<String>,
    /// The raw shell command of a `Bash` task (captured from the tool_use input). Shown
    /// IN ADDITION to `label` in the output popover (the name says what, the command
    /// says how), and used as the pinned-line fallback when there is no `label`. `None`
    /// for non-Bash tasks.
    pub command: Option<String>,
    /// Sub-agent type (`Agent` only, e.g. `"Explore"`).
    pub subagent_type: Option<String>,
    /// Model the sub-agent ran on (`Agent` only), e.g. `"claude-haiku-4-5"`. Captured
    /// from the sub-agent's streamed `assistant` message (`message.model`) — the wire's
    /// ONLY place a sub-agent's model surfaces (it is absent from every `task_*` event
    /// and from the normalized transcript). `None` for non-agent tasks, or until the
    /// sub-agent streams its first assistant message.
    pub model: Option<String>,
    /// The sub-agent's id (`Agent` only), i.e. the key for [`super::subagents::load_subagent_transcript`].
    /// Derived from the `output_file` basename (`subagents/agent-<agentId>.jsonl`), since
    /// the wire carries it only inside that path. Lets the UI drill into the transcript
    /// without re-parsing the path itself.
    pub agent_id: Option<String>,
    pub status: BackgroundTaskStatus,
    /// Latest live progress text (`Workflow`: `"<phase>: <label>"`).
    pub progress: Option<String>,
    /// Total tokens used (from the `task_notification` usage roll-up).
    pub tokens: Option<u64>,
    /// Tool-call count (from the usage roll-up).
    pub tool_uses: Option<u64>,
    /// Wall-clock duration in ms (from the usage roll-up).
    pub duration_ms: Option<u64>,
    /// End-of-task human summary (from the `task_notification`).
    pub summary: Option<String>,
    /// ABSOLUTE on-disk path holding the task's full output. The CLI writes a Bash-bg /
    /// Monitor output to a TEMP dir (`/tmp/claude-<uid>/<slug>/<session>/tasks/<id>.output`),
    /// NOT under the session dir — so this path (taken verbatim from the wire: the Bash
    /// tool_result at start, then `task_notification.output_file`) is the ONLY reliable
    /// way to read it back. For an `Agent` it is the sub-agent transcript path.
    pub output_file: Option<String>,
}

/// One phase of a workflow run, from a `workflows/wf_<id>.json` manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    pub title: String,
    pub detail: Option<String>,
}

/// A workflow run's manifest (`workflows/wf_<id>.json`), the data model behind the
/// `/workflows`-style view. Field names mirror the on-disk camelCase manifest. The
/// dynamic, per-entry-shaped `workflowProgress` and `result` are kept raw
/// ([`Value`]) — the Workflow display task types them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub workflow_name: Option<String>,
    pub default_model: Option<String>,
    pub duration_ms: Option<u64>,
    pub agent_count: Option<u64>,
    pub total_tokens: Option<u64>,
    pub total_tool_calls: Option<u64>,
    pub summary: Option<String>,
    /// `#[serde(default)]` alone covers a MISSING key, but an explicit `"phases":null`
    /// would still fail the WHOLE manifest parse (blanking the entire workflow view).
    /// `deserialize_null_default` maps null → empty, mirroring the stream structs'
    /// `Option` null-tolerance ([`super::protocol::TaskNotificationMsg::usage`]).
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub phases: Vec<WorkflowPhase>,
    /// Array of `{type:"workflow_phase"|"workflow_agent", …}` entries — kept raw.
    #[serde(default)]
    pub workflow_progress: Value,
    /// The workflow's final return value — kept raw.
    #[serde(default)]
    pub result: Value,
}

/// One agent of a running workflow, as the live journal knows it. The journal carries
/// ONLY the agent's id (plus a cache `key` we ignore) — no label, no phase, no metrics:
/// those exist solely in the end-of-run manifest. The id is what matters, because it is
/// the key to that agent's transcript on disk
/// (`subagents/workflows/<run_id>/agent-<agentId>.jsonl`), which the CLI writes
/// INCREMENTALLY — so a still-running agent can be read live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJournalAgent {
    /// Key for [`super::subagents::load_subagent_transcript`].
    pub agent_id: String,
    /// Whether a `result` entry closed this agent. `false` = still in flight.
    pub done: bool,
}

/// Live progress of a RUNNING workflow, derived from its append-only
/// `subagents/workflows/<run_id>/journal.jsonl`. The rich manifest (`wf_<id>.json`) is
/// only written when the run FINISHES, so during the run the journal is the sole on-disk
/// source of "how far along are we": one `{"type":"started",…}` per agent spawn and one
/// `{"type":"result",…}` per agent completion.
///
/// The counts are derived from [`Self::agents`] (one entry per DISTINCT agent id) rather
/// than from raw line counts, so a re-emitted entry can never inflate the total past the
/// number of agents that actually exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJournal {
    /// Distinct agents the journal knows about (== `agents.len()`).
    pub started: u64,
    /// Agents whose `result` entry has landed.
    pub done: u64,
    /// Every agent, in first-seen (spawn) order. Lets the UI show the EXACT in-flight
    /// set — and drill into a running agent's incrementally-written transcript — instead
    /// of only a launched/done tally.
    pub agents: Vec<WorkflowJournalAgent>,
}

/// Deserialize that maps an explicit JSON `null` to `T::default()`. `#[serde(default)]`
/// alone only substitutes the default for a MISSING key — an explicit `"field": null`
/// still fails the whole struct. Pair the two (`#[serde(default, deserialize_with = …)]`)
/// for a manifest field the CLI may write as `null`.
fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// What a session emits to the outside world.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    State(SessionStatePayload),
    Item(ConversationItem),
    Permission(PermissionRequestPayload),
    /// A permission prompt was withdrawn by the CLI and can no longer be answered.
    PermissionResolved(PermissionResolvedPayload),
    /// The session's available slash commands (one-shot, from the `initialize`
    /// control response). Drives the composer's `/` autocomplete.
    Commands(Vec<SlashCommand>),
    /// A background task was created or changed state. Emitted on every `task_*`
    /// transition, keyed by `task_id`, so the UI tracks the live fleet of
    /// sub-agents / workflows / watches / background shells.
    Task(BackgroundTask),
    /// A model-generated conversation title (from a `generate_session_title` control
    /// response). The UI triggers it on each of the first few user messages of an
    /// untitled conversation (regenerated from the accumulated intent until it
    /// settles), carrying the monotonic `seq` it sent so the UI can drop an
    /// out-of-order (stale) response. Applied as the name UNLESS the user set a
    /// custom title in the meantime.
    Title { title: String, seq: u32 },
    /// A model-generated few-word summary of the user's LAST message (from a
    /// `generate_session_title` control response — the same wire, a distinct routing).
    /// The UI triggers it on each user send, passing ONLY that message (not the
    /// accumulated intent), and shows it on the Flight Deck so the fleet's last asks are
    /// legible at a glance. Carries the monotonic `seq` it sent so a stale (superseded
    /// by a newer message) response is dropped. Distinct from [`SessionEvent::Title`]:
    /// the title names the whole conversation; this summarizes only the latest message.
    Summary { summary: String, seq: u32 },
    /// The session's Remote Control ("bridge") state changed — either the ack of a
    /// `remote_control` request we sent (→ connected, carrying the claude.ai/code
    /// `session_url`, or → disconnected), or an async `system/bridge_state` health
    /// downgrade (the remote surface dropped / the bridge errored). Drives the
    /// composer's Remote Control chip.
    RemoteControl(RemoteControlState),
}

/// Sink for a session's events. The IPC layer implements this over a Tauri
/// `AppHandle` (emitting tauri-specta events); tests implement it over a channel.
pub trait SessionEmitter: Send + Sync + 'static {
    fn emit_state(&self, session: &str, state: &SessionStatePayload);
    fn emit_item(&self, session: &str, item: &ConversationItem);
    fn emit_permission(&self, session: &str, request: &PermissionRequestPayload);
    /// A permission prompt was withdrawn and must be removed from the UI. Default
    /// no-op so test sinks that don't observe it stay unchanged.
    fn emit_permission_resolved(&self, _session: &str, _resolved: &PermissionResolvedPayload) {}
    fn emit_commands(&self, session: &str, commands: &[SlashCommand]);
    fn emit_task(&self, session: &str, task: &BackgroundTask);
    fn emit_title(&self, session: &str, title: &str, seq: u32);
    fn emit_summary(&self, session: &str, summary: &str, seq: u32);
    fn emit_remote_control(&self, session: &str, state: &RemoteControlState);
    /// The Codex backend's subscription rate-limit snapshot (5h + weekly windows),
    /// normalized to the SAME [`crate::usage::PlanUsage`] shape as Claude's OAuth
    /// endpoint so the popover renders it verbatim. Codex has NO HTTP/Keychain path —
    /// the figure arrives as a PUSH (`account/rateLimits/updated`) on the live session,
    /// so it is emitted here rather than pulled by a command. Claude never calls this.
    fn emit_codex_plan_usage(&self, session: &str, usage: &crate::usage::PlanUsage);
    /// An extension-inventory invalidation push from the live Codex session
    /// (`skills/changed`, `mcpServer/startupStatus/updated`, `account/updated` →
    /// `area` = `"skills"` | `"mcp"` | `"accounts"`). The front only INVALIDATES its
    /// cached queries on it — no payload beyond the area, so a default no-op is safe
    /// (only the Tauri emitter forwards it; test sinks don't observe it).
    fn emit_extensions_changed(&self, _session: &str, _area: &str) {}
}
