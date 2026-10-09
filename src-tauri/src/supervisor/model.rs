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
    /// Current permission mode: what the CLI reports (`initialize`'s
    /// `current_permission_mode`, `system/init`, `system/status`, the
    /// `set_permission_mode` ack), moved optimistically by a click until its ack lands.
    pub permission_mode: Option<String>,
    /// Whether THIS process can run `bypassPermissions` at all — the CLI refuses a
    /// runtime switch to bypass unless the process was launched with the unlock flag
    /// (or in bypass). `None` = not known: the UI then relies on the opt-in the process
    /// was spawned with. Known for a REMOTE session from the daemon's `fd_attach` (it may
    /// be a process this Mac did not start), and for any session once the CLI shows it
    /// (running in bypass → `true`; a switch refused for want of the unlock → `false`).
    /// `serde(default)` keeps it optional on the TypeScript side.
    #[serde(default)]
    pub bypass_available: Option<bool>,
    /// The output style the RUNNING binary is using right now (from `system/init`,
    /// re-emitted each turn). Output style is USER-GLOBAL — the CLI has no per-session
    /// style — so this is the live reflection of the `outputStyle` we persist in
    /// `settings.json`. `None` on old CLIs (field absent). Lets the UI show whether a
    /// just-picked style is already active or still pending the session's next (re)start.
    pub output_style: Option<String>,
    /// Current reasoning-effort level (`low`/`medium`/`high`/`xhigh`). NOT carried
    /// by `system/init` — sourced from the `get_settings` control read-back (and the
    /// spawn seed). `None` until the first read-back. Drives the effort gauge.
    pub effort: Option<String>,
    /// Whether "ultracode" (standing dynamic-workflow orchestration) is RUNNING right
    /// now. A boolean flag of its own in the CLI, independent of the effort level since
    /// 2.1.284 (it stays on at any effort). Effective value: requested AND available.
    pub ultracode: bool,
    /// Whether ultracode CAN run in this session (`get_settings.applied.ultracodeAvailable`:
    /// workflows enabled AND a model that takes `xhigh`). `None` until a read-back carries
    /// it (an older CLI never does). The switch is offered only while this isn't `false`.
    pub ultracode_available: Option<bool>,
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
    /// The live SSH link's own lifecycle, for a REMOTE conversation only — `None` for
    /// every local conversation, by construction (nothing ever sets it there). Set the
    /// instant a remote actor spawns (`Connecting`), cleared to `None` the instant
    /// `fd_attach` lands, and set again to `Reconnecting` on every later drop —
    /// mirrors `retry` in shape but is orthogonal to it: `retry` is the CLI's own
    /// per-turn API retry, this is ssh itself never having reached the daemon yet.
    /// Drives `WorkingIndicator`'s "Connecting…"/"Reconnecting…" line (highest
    /// priority, above `retry`) — see `ConductorThread.tsx`.
    pub link: Option<RemoteLinkState>,
    /// `true` once the session has ended (the `claude` process exited or was
    /// stopped). A final state event with this set lets the UI mark the session
    /// dead instead of showing it as live forever.
    pub ended: bool,
    /// Tokens occupying the model's context window right now: the last model call's
    /// `input + cache_creation + cache_read` (from `message_start` live, then the
    /// `result`). `None` until the first turn reports usage. Drives the context ring.
    pub context_tokens: Option<u64>,
    /// The same last model call, broken down: what `context_tokens` is made of (fresh input,
    /// cache written, cache read) plus the tokens it generated. `None` until a call reports
    /// usage. Set wherever `context_tokens` is, from the same `usage` object — the two never
    /// disagree — and its `output` completed by the call's `message_delta`. Drives the
    /// telemetry deck's token breakdown.
    pub context_usage: Option<TokenUsage>,
    /// Size of the active model's context window (from `result.modelUsage[…].contextWindow`,
    /// e.g. 200k or 1M for Opus in 1M mode). `None` until a `result` reports it; once
    /// known it is kept across turns that omit it. The ring's denominator.
    pub context_window: Option<u64>,
    /// Latest subscription rate-limit snapshot (from `rate_limit_event`). `None` until
    /// the CLI emits one. NOTE: the stream only carries status + reset, NOT a usage
    /// percentage — that lives behind the `/api/oauth/usage` endpoint (separate task).
    pub rate_limit: Option<RateLimitSnapshot>,
    /// What the WHOLE session has consumed so far, every agent included — see
    /// [`SessionUsage`]. Claude: the latest `result.modelUsage` (a cumulative snapshot the CLI
    /// re-sends in full at each turn end). Codex: the latest `thread/tokenUsage/updated`
    /// `total` (this thread only). `None` until the first of those arrives; once known it is
    /// REPLACED by each newer snapshot, never summed with it.
    ///
    /// `serde(default)` keeps it OPTIONAL on the TypeScript side (`session_usage?:`), so the
    /// hand-written state literals of older tests and mocks stay valid without it.
    #[serde(default)]
    pub session_usage: Option<SessionUsage>,
    /// The plugins the RUNNING binary actually loaded, as it reports them itself
    /// (`system/init.plugins`, re-emitted each turn, and the `reload_plugins` response).
    /// `None` until one of those arrives — a session that has not run a turn yet.
    ///
    /// This is the only truthful source for a REMOTE conversation: the on-disk
    /// inventory (`list_extensions`) reads THIS Mac's `~/.claude`, not the server's.
    /// `serde(default)` keeps it optional on the TypeScript side, like `session_usage`.
    #[serde(default)]
    pub loaded_plugins: Option<Vec<LoadedPlugin>>,
    /// The skill names the running binary loaded (`system/init.skills`, each turn) — bare,
    /// or `plugin:skill`. `None` until the first turn (no control response carries them),
    /// and again after a `reload_plugins`, which may have changed them.
    /// Same purpose as `loaded_plugins` (the truthful list for a remote session).
    #[serde(default)]
    pub loaded_skills: Option<Vec<String>>,
    /// The sub-agents the running binary knows, built-ins included. Known from SPAWN: the
    /// `initialize` response carries them with their description (so does `reload_plugins`);
    /// `system/init` re-lists their names each turn.
    #[serde(default)]
    pub loaded_agents: Option<Vec<LoadedAgent>>,
}

/// One sub-agent as the live session reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LoadedAgent {
    pub name: String,
    /// From the `initialize` / `reload_plugins` responses; `system/init` gives names only.
    pub description: Option<String>,
}

/// One plugin as the live session reports it (`{name, path, source, version}` on the
/// wire). The CLI's own internal plugins (`path: "builtin"`) are dropped at parse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LoadedPlugin {
    pub name: String,
    /// `<plugin>@<marketplace>` (the wire's `source`) — the same key as the
    /// on-disk inventory's `PluginInfo.id`.
    pub id: Option<String>,
    pub version: Option<String>,
}

/// A session's CUMULATIVE token spend, as the CLI itself counts it.
///
/// ⚠️ ONE snapshot, never a sum. On Claude it is `result.modelUsage` summed over its models:
/// every model call the CLI's query pipeline made — the main loop, `Task` sub-agents at every
/// depth, sidechains, compaction and Workflow agents (the binary's own schema text), the
/// permission classifier excepted. Each `result` carries the running total, so the latest
/// one REPLACES the previous: adding results would count turn 1 N times. `result.usage` (the
/// main loop's turn only) and every per-agent "tokens" figure of the wire (`task_notification`,
/// `<subagent_tokens>`, a workflow manifest's `totalTokens`) are SUBSETS or a different unit
/// (an agent's last call ≈ its final context size) — none of them may ever be added to this.
///
/// Claude restores it on `--resume` from the transcript's last `cost-state` line (written when
/// the process exits), which is also what [`super::history::load_session_usage`] reads to seed
/// a reopened conversation. A mid-session `/clear` resets it: the value can go DOWN.
///
/// Codex: the thread's lifetime `tokenUsage.total` — collab sub-agents run as SEPARATE threads
/// and are NOT in it; no cost, no per-model split.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionUsage {
    /// Every model's usage added up. `thinkingTokens` is already INSIDE `output` (never added
    /// again); on Codex the cached input is inside the input, split out as `cache_read`.
    pub total: TokenUsage,
    /// The CLI's cost ESTIMATE for the same calls at API list prices (`result.total_cost_usd`
    /// live, `totalCostUSD` on disk) — cumulative like the tokens, and not a bill on a plan.
    /// `None` when the CLI reports none (Codex never does).
    pub cost_usd: Option<f64>,
    /// The same total split per model (a helper Haiku next to the conversation's Opus…),
    /// largest first. Empty on Codex, which reports the thread as a whole.
    pub per_model: Vec<ModelTokenUsage>,
}

/// One model's share of a [`SessionUsage`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ModelTokenUsage {
    /// The model id as the CLI keys it (it may carry a `[1m]` suffix).
    pub model: String,
    pub usage: TokenUsage,
    /// This model's share of the cost estimate (`costUSD`), when reported.
    pub cost_usd: Option<f64>,
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
    /// The same tools with what the server says about each one (description, read-only /
    /// destructive hints) — what the per-tool permission rows are built from. Claude only
    /// (`mcp_status` carries it); empty for Codex, whose rows show plain names.
    #[serde(default)]
    pub tool_info: Vec<McpToolInfo>,
    /// Why a Codex MCP server failed to start (e.g. `reauthenticationRequired`), captured
    /// from the `mcpServer/startupStatus/updated` push. Turns a mute "disconnected" into a
    /// named "failed" reason. `None` for Claude servers and for Codex servers that started
    /// fine.
    #[serde(default)]
    pub failure_reason: Option<String>,
}

/// What ONE conversation changes for itself from its extensions panel (scope
/// "Conversation"): MCP permission rules and plugin on/off. Both live in the session's
/// flag settings layer (`apply_flag_settings`), never in a file, so they reach that
/// conversation alone. Verified live (2.1.280):
///   • `permissions` — a second apply REPLACES the key (a rule can be removed), `null`
///     clears it, `list_permission_rules` reports the rules as `flagSettings`;
///   • `enabledPlugins` — `{id:false}` then `reload_plugins` drops the plugin's commands,
///     clearing it and reloading brings them back.
/// The layer dies with the process, so the app keeps these per conversation and
/// re-applies them after every `initialize` (with a plugin reload when there are any).
///
/// A rule can only ADD to what applies (deny > ask > allow across every source), so a
/// conversation can tighten the repository or global rules, never loosen them. A plugin
/// override, by contrast, wins over the files: the flag layer ranks above them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionOverrides {
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub deny: Vec<String>,
    /// Plugin id (`name@marketplace`) → on/off for this conversation.
    #[serde(default)]
    pub enabled_plugins: std::collections::BTreeMap<String, bool>,
}

impl SessionOverrides {
    pub fn has_rules(&self) -> bool {
        !(self.allow.is_empty() && self.ask.is_empty() && self.deny.is_empty())
    }

    pub fn is_empty(&self) -> bool {
        !self.has_rules() && self.enabled_plugins.is_empty()
    }

    /// Only MCP rule names (a whole server or one tool) and well-formed plugin ids — the
    /// conversation panel manages nothing else, and this keeps a caller from slipping a
    /// broad rule (`*`, `Bash`) into a live session.
    pub fn validate(&self) -> Result<(), String> {
        for rule in self.allow.iter().chain(&self.ask).chain(&self.deny) {
            if !is_mcp_rule_name(rule) {
                return Err(format!("not an MCP rule: {rule:?}"));
            }
        }
        for id in self.enabled_plugins.keys() {
            if !is_plugin_id(id) {
                return Err(format!("not a plugin id: {id:?}"));
            }
        }
        Ok(())
    }

    /// The `settings` object for `apply_flag_settings`. Both keys are ALWAYS sent (`null`
    /// when empty): the CLI merges at the top level, so this replaces exactly the two
    /// keys the conversation owns and nothing else in the layer.
    pub fn flag_settings(&self) -> Value {
        let permissions = if self.has_rules() {
            let mut map = serde_json::Map::new();
            for (key, list) in [("allow", &self.allow), ("ask", &self.ask), ("deny", &self.deny)] {
                if !list.is_empty() {
                    map.insert(key.to_string(), serde_json::json!(list));
                }
            }
            Value::Object(map)
        } else {
            Value::Null
        };
        let plugins = if self.enabled_plugins.is_empty() {
            Value::Null
        } else {
            serde_json::json!(self.enabled_plugins)
        };
        serde_json::json!({ "permissions": permissions, "enabledPlugins": plugins })
    }
}

/// `mcp__<server>` (the whole server) or `mcp__<server>__<tool>`: non-empty parts, no
/// glob, no parentheses, no whitespace.
pub fn is_mcp_rule_name(rule: &str) -> bool {
    let Some(rest) = rule.strip_prefix("mcp__") else {
        return false;
    };
    let parts_ok = match rest.split_once("__") {
        Some((server, tool)) => !server.is_empty() && !tool.is_empty(),
        None => !rest.is_empty(),
    };
    parts_ok && !rule.contains(['*', '(', ')']) && !rule.chars().any(char::is_whitespace)
}

/// `name@marketplace`, both non-empty, no whitespace.
pub fn is_plugin_id(id: &str) -> bool {
    id.split_once('@').is_some_and(|(n, m)| !n.is_empty() && !m.is_empty())
        && !id.chars().any(char::is_whitespace)
}

/// One tool of a live MCP server, as the session's `mcp_status` reports it. The hints are
/// SERVER-SUPPLIED (`annotations.readOnly` / `.destructive`): a connector can omit them or
/// get them wrong, so the UI treats them as a suggestion, never as a guarantee.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpToolInfo {
    /// The tool's own name, as the server declares it (not the `mcp__…` rule name).
    pub name: String,
    /// The server's description of the tool, capped for display.
    pub description: Option<String>,
    /// `annotations.readOnly` — the tool claims not to change anything.
    pub read_only: Option<bool>,
    /// `annotations.destructive` — the tool claims it may change or delete data.
    pub destructive: Option<bool>,
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
    /// The breakdown of `context_tokens` (see `SessionState::context_usage`), from the same
    /// transcript line.
    pub context_usage: Option<TokenUsage>,
}

/// The four token counts of one model call's `usage` (or a turn's aggregate): the prompt as
/// the API bills it — fresh `input`, `cache_creation` (prompt written to the cache),
/// `cache_read` (prompt served from it) — and the `output` generated. Their prompt part sums
/// to the context occupancy: `input + cache_creation + cache_read`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TokenUsage {
    pub input: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub output: u64,
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
        /// `true` when the message reached the agent WHILE a turn was running (the CLI queued
        /// it and injected it mid-work) — restored from a transcript's `queued_command`
        /// attachment. The UI keeps it as the durable `injectedMidTurn` flag its own mid-turn
        /// sends set, so clean output groups a restored round exactly as it did live.
        #[serde(default)]
        mid_turn: bool,
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
        /// Model/API time spent during THIS turn (the "N s of model" breakdown), derived
        /// from the CLI's cumulative per-session counter by the assembler. `None` when
        /// unknown — the first turn of a resumed process (see
        /// `Assembler::api_ms_baseline`) — or on a backend without the breakdown (Codex).
        duration_api_ms: Option<u64>,
        /// Time-to-first-token this turn; captured but not yet surfaced in the UI.
        ttft_ms: Option<u64>,
        /// What the turn consumed: `result.usage`, the aggregate over every model call the
        /// turn made (not its last call — that is `SessionState::context_usage`). `None` when
        /// the result carries none (Codex reports usage per thread, not per turn).
        usage: Option<TokenUsage>,
    },
    /// A non-conversational notice surfaced in the timeline. Two families:
    ///  - informational: `control_change` (a confirmed model/effort/mode move),
    ///    `compact_boundary` (a context compaction — the thread separator), …
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

/// One context compaction ("the conversation was condensed into a summary"), whichever side
/// of the CLI reported it. The live `system/compact_boundary` carries `compact_metadata` in
/// snake_case; its transcript twin carries `compactMetadata` in camelCase — two readers, one
/// shape, so live and reload render the same marker. Every field is optional: Codex reports a
/// compaction with no numbers at all, and an older `claude` only sends `trigger` + `pre_tokens`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompactInfo {
    /// `"manual"` (`/compact`) or `"auto"` (the context filled up).
    pub trigger: Option<String>,
    /// Context size before the compaction.
    pub pre_tokens: Option<u64>,
    /// Context size right after it — the new fill of the context ring.
    pub post_tokens: Option<u64>,
    /// How long the summarization took.
    pub duration_ms: Option<u64>,
}

/// The `Notice` subtype of a compaction marker — the front renders it as a thread separator.
pub const COMPACT_BOUNDARY_NOTICE: &str = "compact_boundary";

impl CompactInfo {
    /// From the live wire's `compact_metadata` (snake_case).
    pub fn from_wire(meta: &Value) -> Self {
        Self::read(meta, ["pre_tokens", "post_tokens", "duration_ms"])
    }

    /// From a transcript line's `compactMetadata` (camelCase).
    pub fn from_disk(meta: &Value) -> Self {
        Self::read(meta, ["preTokens", "postTokens", "durationMs"])
    }

    /// Lenient on purpose: a field of an unexpected type reads as absent rather than failing
    /// the whole line, so a CLI that reshapes one number still gets its marker.
    fn read(meta: &Value, [pre, post, duration]: [&str; 3]) -> Self {
        let num = |k: &str| meta.get(k).and_then(Value::as_u64);
        Self {
            trigger: meta
                .get("trigger")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(str::to_string),
            pre_tokens: num(pre),
            post_tokens: num(post),
            duration_ms: num(duration),
        }
    }

    /// The timeline marker. `message` is the plain-text line; the numbers ride alongside for
    /// the front to format (one formatter, shared by the thread and `read_conversation`).
    pub fn into_notice(self) -> ConversationItem {
        ConversationItem::Notice {
            subtype: COMPACT_BOUNDARY_NOTICE.to_string(),
            detail: serde_json::json!({
                "message": "Conversation compacted",
                "trigger": self.trigger,
                "pre_tokens": self.pre_tokens,
                "post_tokens": self.post_tokens,
                "duration_ms": self.duration_ms,
            }),
        }
    }
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

/// A remote (SSH) conversation's live link lifecycle — see
/// [`SessionStatePayload::link`]'s own doc for when each variant applies and how it is
/// cleared. `None` on [`SessionStatePayload`] for every local conversation; this enum
/// itself only ever describes "not attached yet".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteLinkState {
    /// This actor has never yet received `fd_attach` this session.
    Connecting,
    /// Has attached before (or is on a later retry of the same outage). `attempt`
    /// is `run_actor`'s own `outage_attempts` counter: how many failed reconnect
    /// attempts THIS outage has made, 1 at the very first drop, reset to 0 only
    /// on a genuine return to attached (never by an address rotation).
    Reconnecting { attempt: u32 },
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

/// Why the CLI stopped a background task ON ITS OWN — not the user's Stop, not the
/// command ending. Each of these lands as a plain `stopped` status on the wire, which
/// read as a crash ("it just went away") until the reason was surfaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundStopCause {
    /// The command reached its background time limit (CLI 2.1.285+: 30 min by default,
    /// longer when the model asked for it through the Bash `timeout`, 2 h at most).
    Deadline,
    /// Reaped under critical system memory pressure while the session sat idle.
    MemoryPressure,
    /// The process hosting it restarted (a remote/cloud worker), killing it.
    WorkerRestart,
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
    /// streamed child content). Lets the UI anchor the task under its tool card. One
    /// exception: a sub-agent woken by `SendMessage` in a process that never saw its launch,
    /// when the launch could not be found on disk (a session hosted on another machine) —
    /// then the waking `SendMessage`'s id, while its content keeps streaming under the
    /// launch (the front resolves it: `agentStreamKey`).
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
    /// Derived from the `output_file` basename (`subagents/agent-<agentId>.jsonl`), or — for
    /// a sub-agent woken by `SendMessage` — its task_id, which IS its agentId (the
    /// SendMessage's `to`). Lets the UI drill into the transcript without re-parsing.
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
    /// `Agent` only: the tool_use id of the MAIN-THREAD `SendMessage` that started this
    /// sub-agent's CURRENT run (a wake re-uses its task_id), or `None` when the current run is
    /// not such a wake. A woken agent works detached — the caller is never blocked on it — so
    /// it is the conversation's background work whatever its launch was, and the UI lists it
    /// as such; the id also tells the drill-in which message that run answers. Per run: a
    /// later run started otherwise (a sub-agent waking it) clears it. Not derivable from
    /// `tool_use_id`, which names the launch (or, when it could not be found, the waking
    /// SendMessage — see `tool_use_id`).
    pub woken_by: Option<String>,
    /// The wire's `is_backgrounded`: `Some(false)` = a FOREGROUND task its spawning tool
    /// call is blocking on (a foreground sub-agent, or a foreground `Bash` the CLI
    /// registered after ~2 s) — it is not background work and must stay out of every
    /// "in the background" display. `Some(true)` = detached (from the start, or moved
    /// there mid-run). `None` = the CLI did not say (a `Workflow`, a CLI before 2.1.283,
    /// a task joined mid-run) → treated as background, as before the flag existed.
    pub backgrounded: Option<bool>,
    /// Housekeeping, not activity (the wire's `ambient` / `skip_transcript`: memory
    /// consolidation, auto-mode scan, a forked skill…). Kept out of the running counts,
    /// the badges and the green `backgrounding` state, as the CLI asks of hosts.
    pub ambient: bool,
    /// Launched from INSIDE a sub-agent (a `Bash` it ran, or a nested sub-agent), not by
    /// the conversation's own thread. Still real work of this session, but never listed
    /// as something the user's conversation launched (the AgentBar's main-thread scope).
    pub owned_by_subagent: bool,
    /// How long the CLI lets this command run in the background before stopping it
    /// (`Bash` only — a Monitor watch has no such limit). Not on the wire: derived from
    /// the command's `timeout` input and the CLI's limits, see
    /// [`super::bash_limits::BashTimeLimits`]. `None` = no limit known (another kind, a
    /// foreground command, a CLI older than 2.1.285).
    pub time_limit_ms: Option<u64>,
    /// When the CLI will stop it (epoch ms): the moment it entered the background plus
    /// [`Self::time_limit_ms`]. Stamped on OUR clock as the background edge arrives — the
    /// wire carries no timestamp — so it is accurate to the event latency.
    pub deadline_at_ms: Option<u64>,
    /// Why the CLI stopped it on its own, when it did (see [`BackgroundStopCause`]).
    /// `None` for anything else, including the user's Stop.
    pub stop_cause: Option<BackgroundStopCause>,
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

/// One agent of a running workflow, as the live journal knows it — one per `agent()` CALL of
/// the script (the journal's per-call `key`), not per spawned process: a call the CLI runs
/// again (a retry, or a re-execution when the run is resumed) keeps ONE entry, pointing at its
/// latest attempt. That attempt's id keys its transcript on disk
/// (`subagents/workflows/<run_id>/agent-<agentId>.jsonl`), which the CLI writes
/// INCREMENTALLY — so a still-running agent can be read live.
///
/// Recent claude versions (around 2.1.270 and later; absent on 2.1.263) also write the script's
/// `label` and `phase` on the `started` entry, so the live view can name every agent EXACTLY;
/// older ones wrote neither (both `None`). Metrics (model, tokens) still exist only in the
/// end-of-run manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJournalAgent {
    /// Stable identity of the CALL, unchanged across its attempts: the journal `key`, else the
    /// first agent id seen, else a positional placeholder. Opaque — a row/selection key for the
    /// UI, NEVER a transcript key.
    pub key: String,
    /// The latest attempt's id — the key for [`super::subagents::load_subagent_transcript`].
    /// `None` when the latest execution never got an id: it failed before spawning (unknown
    /// agent type, a call refused by the safety classifier…), so no transcript of it exists —
    /// even when an EARLIER execution of the same call (before a resume) had one.
    pub agent_id: Option<String>,
    /// The script's `label` for this call (`None` on an older journal, or on a call the CLI
    /// never recorded a `started` for).
    pub label: Option<String>,
    /// The phase the call ran in. `None` on an older journal, for an agent the script spawned
    /// outside any phase (before its first `phase()`, or in a phase-less script), and for a call
    /// that failed before spawning (the CLI records no phase for it).
    pub phase: Option<String>,
    /// Whether the agent has SETTLED — a `result` or a `failed` entry closed it. `false` =
    /// still in flight.
    pub done: bool,
    /// Whether it settled by FAILING (a `failed` entry). Implies `done`.
    pub failed: bool,
    /// Journal line index of this call's latest `started` — RECENCY, which the list order is
    /// not: a call the CLI re-runs (a retry, or a re-execution after a resume) keeps its
    /// first-seen slot. `None` for a call that never spawned.
    pub last_started: Option<u64>,
}

/// Live progress of a RUNNING workflow, derived from its append-only
/// `subagents/workflows/<run_id>/journal.jsonl`. The rich manifest (`wf_<id>.json`) is
/// only written when the run FINISHES, so during the run the journal is the sole on-disk
/// source of "how far along are we": one `{"type":"started",…}` per agent spawn (or retry),
/// then one `{"type":"result",…}` or `{"type":"failed",…}` per agent that settles.
///
/// The counts are derived from [`Self::agents`] (one entry per DISTINCT agent call) rather
/// than from raw line counts, so a re-emitted entry or a retry can never inflate the total
/// past the number of agents that actually exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJournal {
    /// Distinct agents the journal knows about (== `agents.len()`).
    pub started: u64,
    /// Agents that have SETTLED (`result` or `failed`) — includes [`Self::failed`].
    pub done: u64,
    /// Of [`Self::done`], the agents that settled by failing.
    pub failed: u64,
    /// Whether this journal names its agents itself: it was written by a claude that records
    /// each agent's `label`/`phase` (its `launched` header, or any label/phase, says so). Lets
    /// the UI pick the exact path from the very first line — even before a labelled agent shows
    /// up (a journal whose only entries so far are calls that failed before spawning).
    pub names_agents: bool,
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
    /// A6: a remote session's reconnect loop rotated onto a DIFFERENT candidate
    /// address and confirmed it works (`fd_attach` received) — the IPC layer (which
    /// owns the [`crate::store::Store`], never the supervisor — see the encapsulation
    /// rule) should persist `host` as this machine's new preferred address, so the
    /// NEXT spawn dials it first instead of re-paying the backoff against a dead one
    /// every session. Fire-and-forget: `run_actor` does not wait for (or learn the
    /// outcome of) the write.
    PreferredHostChanged { machine_id: String, host: String },
    /// The binary's predicted next user prompt (`prompt_suggestion`), shown as ghost text
    /// in the composer and accepted with Tab. Only emitted between turns: one that lands
    /// while a turn is already running is stale and dropped by the assembler.
    PromptSuggestion { suggestion: String },
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
    /// A6: see [`SessionEvent::PreferredHostChanged`]. Default no-op so the Codex
    /// sink (which never carries a `RemoteTarget` — remote is Claude-only) and test
    /// sinks that don't care stay unchanged; only [`crate::ipc::events::TauriEmitter`]
    /// (which can reach the `Store` through its `AppHandle`) overrides it.
    fn emit_preferred_host(&self, _session: &str, _machine_id: &str, _host: &str) {}
    /// See [`SessionEvent::PromptSuggestion`]. Default no-op: only the Claude backend
    /// produces it, and only the Tauri emitter forwards it.
    fn emit_prompt_suggestion(&self, _session: &str, _suggestion: &str) {}
}
