//! Session — the actor that ties a [`Transport`] together with the control
//! channel, the [`Assembler`], and an event sink (subtask 2 + 3).
//!
//! It runs as a single-task actor: one `tokio::select!` loop owns all per-session
//! state (no shared locks), processing two inputs:
//!   - inbound [`CliMessage`]s from the transport, and
//!   - [`SessionCommand`]s from the UI (via [`SessionHandle`]).
//!
//! The protocol logic lives in [`SessionCore`], which writes outbound lines to a
//! plain channel rather than directly to the process. That decoupling makes the
//! whole control round-trip (a `can_use_tool` prompt → our `control_response`)
//! unit-testable with no live `claude` process — see the tests below.

use std::collections::HashMap;
use std::process::ExitStatus;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use super::assembler::Assembler;
use super::control::{self, InboundControl, PermissionDecision, PermissionMode};
use super::model::{
    ConversationItem, LiveModel, McpAuthResult, McpServerLive, PermissionRequestPayload,
    PermissionResolvedPayload, RemoteControlState, RewindFilesResult, SessionEmitter, SessionEvent,
    SessionOverrides,
};
use super::protocol::CliMessage;
use super::transport::{self, SpawnConfig, Transport, TransportError};

/// A command sent from the UI to a running session.
pub enum SessionCommand {
    /// A user turn: the typed text plus any images joined to it (sent as `image`
    /// blocks in the message `content` array). `images` is empty for a plain text turn.
    /// `controls` carries the Codex composer controls (model / effort / approval /
    /// sandbox / …) applied as per-turn overrides — `None` for Claude, which pushes
    /// each control the moment it changes instead of per-turn.
    SendUser {
        text: String,
        images: Vec<transport::ImageAttachment>,
        controls: Option<crate::supervisor::codex::CodexControls>,
        /// Stamped by the caller (see [`SessionHandle::send_user`]) so it can be
        /// returned with the send and used to cancel this exact message later.
        uuid: String,
    },
    AnswerPermission {
        request_id: String,
        decision: PermissionDecision,
    },
    SetPermissionMode(PermissionMode),
    SetModel(String),
    /// Set a plain reasoning-effort level (low/medium/high/xhigh). Also clears the
    /// ultracode flag — selecting a plain level always turns ultracode off.
    SetEffortLevel(String),
    /// Enable "ultracode" (xhigh effort + standing dynamic-workflow orchestration).
    /// Disabling is done by selecting a plain [`SessionCommand::SetEffortLevel`].
    EnableUltracode,
    /// Ask the binary to generate a short conversation title from `description` (the
    /// user's accumulated messages so far). `seq` is a monotonic per-conversation tag
    /// echoed back in [`SessionEvent::Title`] so the UI can drop an out-of-order
    /// (stale) response. The title comes back asynchronously; a failure is logged but
    /// never surfaced (the UI keeps its optimistic placeholder / last title).
    GenerateTitle { description: String, seq: u32 },
    /// Ask the binary to summarize the user's LAST message in a few words (same wire as
    /// `GenerateTitle` — `generate_session_title` — but fed ONLY that one message, not
    /// the accumulated intent). `seq` is a monotonic per-conversation tag echoed back in
    /// [`SessionEvent::Summary`] so the UI drops a stale (superseded) response. Comes
    /// back asynchronously; a failure is logged, never surfaced (the UI keeps its
    /// optimistic truncation of the message).
    GenerateSummary { text: String, seq: u32 },
    Interrupt,
    /// Stop a single background task (a `run_in_background` Bash / Monitor /
    /// sub-agent) by its `task_id`, without ending the turn or the session.
    StopTask(String),
    /// Query the session's live MCP server status; the reply is delivered back over
    /// the oneshot once the CLI answers. `Err` carries the binary's rejection message
    /// (an error control_response) so a rejected query is NOT mistaken for an empty
    /// success — distinct from a genuinely empty server list (`Ok(vec![])`).
    McpStatus(oneshot::Sender<Result<Vec<McpServerLive>, String>>),
    /// Enable/disable ONE MCP server live (fire-and-correlate; the change shows on
    /// the next `mcp_status` poll, a rejection surfaces as a control error).
    McpToggle { server_name: String, enabled: bool },
    /// Reconnect ONE MCP server (after a failure or once auth is granted).
    McpReconnect { server_name: String },
    /// Forget stored OAuth credentials for ONE server.
    McpClearAuth { server_name: String },
    /// Start the OAuth flow for ONE server; the reply carries the `authUrl` to open.
    McpAuthenticate {
        server_name: String,
        reply: oneshot::Sender<McpAuthResult>,
    },
    /// A control request whose answer we want back VERBATIM, as the raw
    /// `control_response` line. One plumbing path for every query-shaped subtype the
    /// binary exposes (`list_models`, `get_usage`, `rewind_files`,
    /// `cancel_async_message`, …) instead of a bespoke `pending_*` map per subtype:
    /// the parsing stays in [`control`], typed per feature, on the caller's side.
    /// `Err` carries the binary's rejection message, so a refusal is never mistaken
    /// for an empty success.
    ControlQuery {
        request_for: &'static str,
        request: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// Enable/disable this session's Remote Control bridge (native `/remote-control`).
    /// The reply carries the resulting state — on enable, `connected` + the
    /// claude.ai/code `session_url`; on disable, `disconnected`; on rejection, `error`.
    SetRemoteControl {
        enabled: bool,
        name: Option<String>,
        reply: oneshot::Sender<RemoteControlState>,
    },
    /// Hot-reload this session's plugins after a `claude plugin …` mutation (update /
    /// enable / disable), so a running conversation applies it without a restart.
    /// Fire-and-correlate (bare-success ack; rejection surfaces as a control error).
    ReloadPlugins,
    /// The tools Flight Deck's own settings ALLOW for this conversation (the `allow` list
    /// of its [`SessionOverrides`]) — a prompt a settings-file `ask` rule raises for one of
    /// them is answered "allow" on the user's behalf. Claude-only.
    SetAutoAllow(Vec<String>),
    /// Compact the conversation's context. CODEX-ONLY: Claude compacts via the plain
    /// `/compact` text command (a slash-command turn), so its actor treats this as a
    /// no-op; the Codex actor issues the native `thread/compact/start` RPC (there is no
    /// `/compact` text command on the app-server). Fire-and-forget — a failure is
    /// surfaced by the Codex actor as a timeline notice.
    Compact,
    /// Tear the session down. `ack`, when present, is fired by the actor ONLY after the
    /// process is fully reaped (the graceful EOF→SIGTERM→SIGKILL ladder has run), so a
    /// caller can wait for the `claude` process to ACTUALLY be gone — required before any
    /// operation that mutates the on-disk transcript (a rewind), which must NOT race a
    /// still-alive writer. `None` = fire-and-forget (the quit path polls `is_empty`).
    ///
    /// `stop_remote`: for a REMOTE session, also stop the server-side `claude`
    /// (`fd_stop` to the daemon). `false` merely detaches — the session keeps
    /// running on the server (app quit must never kill remote work; only the
    /// user's explicit Stop passes `true`). Ignored for local sessions.
    Shutdown {
        ack: Option<oneshot::Sender<()>>,
        stop_remote: bool,
    },
}

/// The controls a session starts with, threaded from the spawn config so the core
/// can (1) seed its live state immediately (the UI shows the right values before
/// the first `get_settings` round-trip) and (2) restore ultracode after init (the
/// `--effort` flag sets the effort LEVEL but not the separate ultracode flag).
#[derive(Debug, Clone, Default)]
pub struct InitialControls {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub ultracode: bool,
    /// The conversation's own overrides (MCP rules + plugin on/off). They live in the
    /// process's flag settings layer, which dies with it — so they are re-applied after
    /// every `initialize` (a resume, a rewind, an account switch all spawn afresh).
    pub session_overrides: Option<SessionOverrides>,
}

/// What an outbound control_request was, so its ack can be routed (spec §4.1). We
/// correlate by `request_id` and act on the response — never fire-and-forget — so a
/// CLI rejection surfaces instead of silently failing.
#[derive(Debug, Clone, Copy)]
enum PendingControl {
    GetSettings,
    /// Carries the mode we requested, so a bare `success` ack (no echoed `mode`)
    /// still drives the confirmed-mode announce instead of silently dropping it.
    SetPermissionMode(PermissionMode),
    SetModel,
    SetEffort,
    SetUltracode,
    /// A `generate_session_title` request, carrying the monotonic `seq` we were asked
    /// to title with so the ack's title can be tagged with it (the UI drops stale,
    /// out-of-order responses). Swallowed on failure — never surfaced, since the UI
    /// has a placeholder name.
    GenerateTitle(u32),
    /// A `generate_session_title` request used to summarize the user's LAST message (a
    /// distinct routing over the same wire), carrying the monotonic `seq` so the ack's
    /// summary can be tagged with it. Swallowed on failure — never surfaced, since the
    /// UI has an optimistic truncation as fallback.
    GenerateSummary(u32),
    Interrupt,
    /// A `stop_task` request — its failure surfaces as a control error so the user
    /// knows the background task is still running.
    StopTask,
    /// A live MCP action (`mcp_toggle` / `mcp_reconnect` / `mcp_clear_auth`) — its
    /// failure surfaces as a control error so the user knows the action didn't land.
    McpToggle,
    McpReconnect,
    McpClearAuth,
    /// A `reload_plugins` request — its failure surfaces as a control error so the user
    /// knows the freshly-updated plugin was NOT hot-applied (a restart is still needed).
    ReloadPlugins,
    /// The conversation's overrides re-applied after `initialize` — a failure surfaces,
    /// since the conversation would otherwise run WITHOUT what the user set for it.
    SessionOverrides,
}

impl PendingControl {
    /// Human label for a surfaced control error.
    fn label(self) -> &'static str {
        match self {
            PendingControl::GetSettings => "reading settings",
            PendingControl::SetPermissionMode(_) => "permission mode",
            PendingControl::SetModel => "model",
            PendingControl::SetEffort => "effort",
            PendingControl::SetUltracode => "ultracode",
            PendingControl::GenerateTitle(_) => "title generation",
            PendingControl::GenerateSummary(_) => "last-message summary",
            PendingControl::Interrupt => "interrupt",
            PendingControl::StopTask => "stopping a background task",
            PendingControl::McpToggle => "toggling an MCP server",
            PendingControl::McpReconnect => "reconnecting an MCP server",
            PendingControl::McpClearAuth => "resetting MCP authentication",
            PendingControl::ReloadPlugins => "reloading plugins",
            PendingControl::SessionOverrides => "applying this conversation's own settings",
        }
    }
}

/// Errors from driving a session through its handle.
#[derive(Debug)]
pub enum SessionError {
    Spawn(TransportError),
    /// The session task is gone (process exited or shut down).
    Closed,
    /// The binary answered a control request with an explicit error (e.g. an
    /// unsupported / rejected query). Carries the binary's message so the caller
    /// surfaces it instead of mistaking the rejection for an empty success.
    Rejected(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Delegate to the transport error, which already carries a
            // human-readable, actionable message surfaced in the UI.
            SessionError::Spawn(e) => write!(f, "{e}"),
            SessionError::Closed => write!(f, "session is closed"),
            SessionError::Rejected(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for SessionError {}

/// A cloneable handle to a running session. Commands are delivered to the actor
/// over a bounded channel.
#[derive(Clone)]
pub struct SessionHandle {
    pub id: String,
    cmd_tx: mpsc::Sender<SessionCommand>,
}

impl SessionHandle {
    /// Build a handle around a raw command channel. `pub(crate)` so a sibling backend
    /// module (`supervisor::codex`) can wrap its OWN actor's channel in a `SessionHandle`
    /// without the private `cmd_tx` field being exposed — the handle stays "just a
    /// bounded command channel + a stable id", identical for both backends, and all the
    /// downstream IPC commands (send / interrupt / stop / …) drive either backend
    /// unchanged. The Claude path uses the struct literal directly in `spawn_session`.
    pub(crate) fn from_channel(id: String, cmd_tx: mpsc::Sender<SessionCommand>) -> Self {
        Self { id, cmd_tx }
    }

    /// Send a user turn: text, any joined images, and (Codex only) the composer
    /// controls applied as per-turn overrides. `send_user_text` is the text-only
    /// convenience used by internal callers and tests.
    /// Returns the uuid stamped on the turn. Minted HERE rather than inside the actor
    /// so the caller gets it synchronously with the send: it is the handle the UI needs
    /// to cancel THAT message later (`cancel_async_message`), and a message queued
    /// behind a running turn can be dropped individually only if its own uuid is known.
    pub async fn send_user(
        &self,
        text: impl Into<String>,
        images: Vec<transport::ImageAttachment>,
        controls: Option<crate::supervisor::codex::CodexControls>,
    ) -> Result<String, SessionError> {
        let uuid = uuid::Uuid::new_v4().to_string();
        self.send(SessionCommand::SendUser {
            text: text.into(),
            images,
            controls,
            uuid: uuid.clone(),
        })
        .await?;
        Ok(uuid)
    }

    pub async fn send_user_text(&self, text: impl Into<String>) -> Result<String, SessionError> {
        self.send_user(text, Vec::new(), None).await
    }

    pub async fn answer_permission(
        &self,
        request_id: String,
        decision: PermissionDecision,
    ) -> Result<(), SessionError> {
        self.send(SessionCommand::AnswerPermission { request_id, decision })
            .await
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), SessionError> {
        self.send(SessionCommand::SetPermissionMode(mode)).await
    }

    pub async fn set_model(&self, model: String) -> Result<(), SessionError> {
        self.send(SessionCommand::SetModel(model)).await
    }

    pub async fn set_effort_level(&self, level: String) -> Result<(), SessionError> {
        self.send(SessionCommand::SetEffortLevel(level)).await
    }

    pub async fn enable_ultracode(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::EnableUltracode).await
    }

    pub async fn generate_title(&self, description: String, seq: u32) -> Result<(), SessionError> {
        self.send(SessionCommand::GenerateTitle { description, seq }).await
    }

    pub async fn generate_summary(&self, text: String, seq: u32) -> Result<(), SessionError> {
        self.send(SessionCommand::GenerateSummary { text, seq }).await
    }

    pub async fn interrupt(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::Interrupt).await
    }

    pub async fn stop_task(&self, task_id: String) -> Result<(), SessionError> {
        self.send(SessionCommand::StopTask(task_id)).await
    }

    /// Query the live MCP server status (connection state + tools per server),
    /// queried from the running process via the `mcp_status` control request. The
    /// wait is bounded so a non-answering CLI can't hang the caller; a dropped reply
    /// (session ended) or a timeout surfaces as [`SessionError::Closed`].
    pub async fn mcp_status(&self) -> Result<Vec<McpServerLive>, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCommand::McpStatus(tx)).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
            Ok(Ok(Ok(servers))) => Ok(servers),
            // The binary rejected the query — surface its message (never a fake empty).
            Ok(Ok(Err(msg))) => Err(SessionError::Rejected(msg)),
            _ => Err(SessionError::Closed),
        }
    }

    /// Send a query-shaped control request and hand back the raw `control_response`
    /// line. `request` is a FULL envelope built by a [`control`] builder; the actor
    /// overwrites its `request_id` with the one it correlates on, so callers pass an
    /// empty id. The wait is bounded — a non-answering CLI must never hang a caller.
    async fn control_query(
        &self,
        request_for: &'static str,
        request: Value,
        timeout_secs: u64,
    ) -> Result<Value, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCommand::ControlQuery { request_for, request, reply: tx })
            .await?;
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(Ok(line))) => Ok(line),
            Ok(Ok(Err(msg))) => Err(SessionError::Rejected(msg)),
            _ => Err(SessionError::Closed),
        }
    }

    /// Replace this conversation's own overrides in the RUNNING session
    /// (`apply_flag_settings`), awaiting the CLI's answer so a rejection reaches the
    /// caller. Rules bite from the next tool call; a plugin change needs the reload that
    /// `reload_plugins` asks for (verified live against 2.1.280).
    pub async fn apply_session_overrides(
        &self,
        overrides: &SessionOverrides,
        reload_plugins: bool,
    ) -> Result<(), SessionError> {
        self.control_query(
            "apply_flag_settings",
            control::session_overrides_request("", overrides),
            15,
        )
        .await?;
        self.send(SessionCommand::SetAutoAllow(overrides.allow.clone())).await?;
        if reload_plugins {
            self.reload_plugins().await?;
        }
        Ok(())
    }

    /// The session's live model catalogue (`list_models`). Authoritative — it reflects
    /// the provider and the org policy, unlike a hard-coded table.
    pub async fn list_models(&self) -> Result<Vec<LiveModel>, SessionError> {
        let line = self
            .control_query("list_models", control::list_models_request(""), 15)
            .await?;
        Ok(control::parse_list_models(&line))
    }

    /// The structured `/usage` payload from the running session (`get_usage`) — plan
    /// rate limits with NO OAuth token and NO Keychain read. Returned raw: the sole
    /// authority on interpreting a usage payload is [`crate::usage`].
    pub async fn plan_usage_payload(&self) -> Result<Value, SessionError> {
        self.control_query("get_usage", control::get_usage_request(""), 15)
            .await
    }

    /// Restore the files edited since `user_message_id` from the binary's checkpoints.
    /// With `dry_run`, reports what WOULD change without touching the disk. A refusal
    /// (checkpointing off, no checkpoint) comes back inside the result, not as an error.
    pub async fn rewind_files(
        &self,
        user_message_id: String,
        dry_run: bool,
    ) -> Result<RewindFilesResult, SessionError> {
        match self
            .control_query(
                "rewind_files",
                control::rewind_files_request("", &user_message_id, dry_run),
                30,
            )
            .await
        {
            Ok(line) => Ok(control::parse_rewind_files(&line, None)),
            // A routed rejection is a verdict too — surface its reason rather than a
            // bare "closed", so the UI can say WHY nothing was restored.
            Err(SessionError::Rejected(msg)) => Ok(control::parse_rewind_files(
                &Value::Null,
                Some(msg.as_str()),
            )),
            Err(e) => Err(e),
        }
    }

    /// Drop a queued user message from the binary's command queue by the uuid we
    /// stamped on it. `false` = it was never queued or already started executing —
    /// the caller must NOT present that as a successful cancellation.
    pub async fn cancel_async_message(&self, message_uuid: String) -> Result<bool, SessionError> {
        let line = self
            .control_query(
                "cancel_async_message",
                control::cancel_async_message_request("", &message_uuid),
                10,
            )
            .await?;
        Ok(control::parse_cancel_async_message(&line))
    }

    /// Enable/disable a live MCP server (fire-and-correlate; the UI re-polls
    /// `mcp_status` to reflect the change, a rejection surfaces as a control error).
    pub async fn mcp_toggle(&self, server_name: String, enabled: bool) -> Result<(), SessionError> {
        self.send(SessionCommand::McpToggle { server_name, enabled }).await
    }

    /// Reconnect a live MCP server.
    pub async fn mcp_reconnect(&self, server_name: String) -> Result<(), SessionError> {
        self.send(SessionCommand::McpReconnect { server_name }).await
    }

    /// Forget a live MCP server's stored OAuth credentials.
    pub async fn mcp_clear_auth(&self, server_name: String) -> Result<(), SessionError> {
        self.send(SessionCommand::McpClearAuth { server_name }).await
    }

    /// Start the OAuth flow for a live MCP server; returns the `authUrl` to open
    /// (and whether the user must finish a callback). Bounded wait, like `mcp_status`.
    pub async fn mcp_authenticate(&self, server_name: String) -> Result<McpAuthResult, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCommand::McpAuthenticate { server_name, reply: tx }).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => Ok(result),
            _ => Err(SessionError::Closed),
        }
    }

    /// Enable/disable this session's Remote Control bridge (native `/remote-control`),
    /// returning the resulting state (connected + `session_url`, or disconnected, or
    /// error). Bounded wait, like `mcp_authenticate`: a non-answering CLI or a dropped
    /// reply (session ended) surfaces as [`SessionError::Closed`].
    pub async fn set_remote_control(
        &self,
        enabled: bool,
        name: Option<String>,
    ) -> Result<RemoteControlState, SessionError> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCommand::SetRemoteControl { enabled, name, reply: tx }).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(state)) => Ok(state),
            _ => Err(SessionError::Closed),
        }
    }

    /// Hot-reload this session's plugins (after a `claude plugin …` mutation) so a
    /// running conversation applies the change without a restart. Fire-and-correlate.
    pub async fn reload_plugins(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::ReloadPlugins).await
    }

    /// Compact this conversation's context (Codex: the native `thread/compact/start`
    /// RPC; Claude: a no-op — it compacts via the `/compact` text command instead).
    /// Fire-and-forget: a Codex failure surfaces as a timeline notice, so no reply.
    pub async fn compact(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::Compact).await
    }

    /// Request teardown WITHOUT waiting for the process to be reaped (the quit path uses
    /// this and then polls [`Sessions::is_empty`]). For a REMOTE session this only
    /// DETACHES — the server-side `claude` keeps running (quitting the app must never
    /// kill remote work); the explicit-stop path is [`Self::shutdown_and_wait_stopping`].
    pub async fn shutdown(&self) -> Result<(), SessionError> {
        self.send(SessionCommand::Shutdown { ack: None, stop_remote: false }).await
    }

    /// Request teardown AND wait until the `claude` process is actually gone (the actor
    /// fires the ack after `transport.shutdown()` completes). Bounded so a wedged teardown
    /// can't hang the caller. This is the stop a REWIND must use before truncating the
    /// transcript — otherwise the still-alive process can re-write the file after the cut.
    /// Remote sessions: detaches only (see [`Self::shutdown`]).
    pub async fn shutdown_and_wait(&self) -> Result<(), SessionError> {
        self.shutdown_and_wait_inner(false).await
    }

    /// The USER's explicit Stop: like [`Self::shutdown_and_wait`], but a remote
    /// session's server-side `claude` is stopped too (`fd_stop` to the daemon)
    /// instead of merely detached.
    pub async fn shutdown_and_wait_stopping(&self) -> Result<(), SessionError> {
        self.shutdown_and_wait_inner(true).await
    }

    async fn shutdown_and_wait_inner(&self, stop_remote: bool) -> Result<(), SessionError> {
        let (tx, rx) = oneshot::channel();
        self.send(SessionCommand::Shutdown { ack: Some(tx), stop_remote }).await?;
        // The teardown ladder is bounded (~4s worst case); 8s leaves comfortable headroom.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(8), rx).await;
        Ok(())
    }

    async fn send(&self, cmd: SessionCommand) -> Result<(), SessionError> {
        self.cmd_tx.send(cmd).await.map_err(|_| SessionError::Closed)
    }
}

/// Spawn a `claude` session: starts the transport and the actor task, returns a
/// handle to drive it. Events are delivered through `emitter`.
///
/// `on_exit` runs once after the session has fully torn down (process gone),
/// whatever the cause (explicit stop, the process exiting on its own, or the
/// command channel closing). The IPC layer uses it to evict the dead session
/// from its registry so entries never leak.
///
/// `appmcp` is the app-control hub when THIS session must expose the in-process
/// "flightdeck" SDK MCP server (Settings toggle, decided at spawn like the
/// bypass unlock): `Some` advertises it on `initialize` and serves inbound
/// `mcp_message` traffic; `None` keeps the wire identical to the pre-MCP client.
pub fn spawn_session(
    id: String,
    cfg: SpawnConfig,
    initial: InitialControls,
    emitter: Arc<dyn SessionEmitter>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    appmcp: Option<Arc<crate::appmcp::ControlHub>>,
) -> Result<SessionHandle, SessionError> {
    let (transport, msg_rx) = Transport::spawn(cfg.clone()).map_err(SessionError::Spawn)?;
    let core = SessionCore::new(id.clone(), initial, emitter, transport.outbound(), appmcp);
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    tokio::spawn(run_actor(core, transport, msg_rx, cmd_rx, on_exit, cfg));
    Ok(SessionHandle { id, cmd_tx })
}

/// The actor loop: drive [`SessionCore`] from the transport stream and the
/// command channel, then tear the process down and announce the exit.
///
/// REMOTE sessions get one extra behavior: the server-side daemon owns the
/// actual `claude` process, so when the ssh transport drops WITHOUT the daemon
/// saying goodbye (`fd_detach`), the session is still alive server-side — the
/// actor re-spawns the transport with the reattach cursor (daemon `fd_attach`
/// base + replayable lines seen on this connection) and the daemon replays what
/// was missed. The same core/assembler keeps running: a network cut mid-turn
/// heals without losing stream. Backoff 1s → ×2 → 30s, forever, interruptible
/// by Shutdown. A6: after [`ADDRESS_ROTATION_THRESHOLD`] consecutive failures to
/// even reach `fd_attach` against the SAME candidate, rotates `cfg.remote.host`
/// to the next recorded [`transport::RemoteTarget::addresses`] (wrapping forever,
/// never giving up) — see [`next_candidate_after_failure`]/[`rotate_remote_address`]
/// for the decision and [`SessionEvent::PreferredHostChanged`] for how a WINNING
/// rotation gets persisted. Never fires for a TERMINAL `reconnect_policy_for_reason`
/// (that path ends the session before reaching the rotation check at all).
async fn run_actor(
    mut core: SessionCore,
    mut transport: Transport,
    mut msg_rx: mpsc::UnboundedReceiver<CliMessage>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    // `mut`: A6's address rotation mutates `cfg.remote.host` in place, so every
    // `cfg2 = cfg.clone()` built for the NEXT spawn attempt (below) already dials
    // whichever candidate the rotation policy last picked.
    mut cfg: SpawnConfig,
) {
    core.initialize();
    // A caller that wants to WAIT for the process to be reaped passes a oneshot on the
    // Shutdown command; we fire it only after `transport.shutdown()` below has run.
    let mut shutdown_ack: Option<oneshot::Sender<()>> = None;
    let mut stop_remote = false;
    // A6: the machine's persisted preferred host as this actor was SPAWNED with it —
    // captured before any rotation ever mutates `cfg.remote.host`. Used ONLY as the
    // FALLBACK baseline for `host_to_persist` (see the `FdAttach` handler below):
    // once `persisted_host` holds a value, IT is the baseline instead — a session
    // that rotates away and later back onto this original host must still persist
    // it, since the DB was last told about the away candidate, not this one.
    let original_host = cfg.remote.as_ref().map(|r| r.host.clone());
    // A6: which candidate `cfg.remote.addresses` we are currently dialing, and how
    // many CONSECUTIVE attempts against it in a row failed to reach `fd_attach`.
    // Seeded from wherever `host` already sits in `addresses` (`host` is always
    // first for a freshly-built `RemoteTarget` — see `ipc::commands::
    // remote_target_addresses` — but resuming after an EARLIER session in this same
    // process already rotated would seed from that instead, if it ever mattered).
    // `unwrap_or(0)` also covers a pre-A5 machine whose `addresses` is just `[host]`:
    // index 0, and `next_candidate_after_failure` never rotates a single-entry list.
    let mut addr_idx: usize = cfg
        .remote
        .as_ref()
        .and_then(|r| r.addresses.iter().position(|a| a == &r.host))
        .unwrap_or(0);
    let mut candidate_failures: u32 = 0;
    // A6: the host already persisted as this machine's preferred address THIS
    // session — `None` until the first successful persist, after which it (not
    // `original_host`) becomes the baseline `host_to_persist` compares against.
    // This is what lets a LATER rotation that lands back on `original_host`
    // still persist correctly: the baseline has moved on from "where we
    // started" to "what the DB last heard", so that reattach is correctly seen
    // as a change again — see `host_to_persist`'s doc.
    let mut persisted_host: Option<String> = None;
    // Remote reattach state, learned from the daemon's fd_attach handshake.
    let mut attach = cfg.attach.clone().unwrap_or_default();
    // The replay position: `attach_base` (the daemon's replay_from) plus the
    // replayable lines counted on the transport that RECEIVED that fd_attach.
    // `cursor` is only advanced when a transport actually got its handshake —
    // a reconnect attempt that dies before fd_attach must not roll it back.
    let mut attach_base: u64 = attach.cursor;
    let mut cursor: u64 = attach.cursor;
    let mut attach_seen = false;
    // True from link-loss until the next fd_attach: gates the one "lost" notice
    // per outage, the "Reconnected" notice, and the backoff escalation.
    let mut reconnect_pending = false;
    // Backoff across the WHOLE outage: ssh spawning is not success (it forks
    // even when the server is unreachable) — only a received fd_attach is, and
    // only that resets the delay.
    let mut delay = std::time::Duration::from_secs(1);
    // Set when the daemon closed the stream ON PURPOSE (replaced / stopped /
    // exited / error) — auto-reconnect must not fight that.
    let mut no_reconnect: Option<String> = None;
    // Whether `no_reconnect`'s reason already got its OWN notice (or, for
    // "stopped", narrates itself elsewhere) — read straight from
    // `reconnect_policy_for_reason`'s table wherever `no_reconnect` is set, so
    // the final exit-explain block below never re-lists reason strings itself
    // (that would be the second hand-edit the table's doc comment promises
    // callers they'll never need).
    let mut deliberate_exit = false;
    // How many CONSECUTIVE reconnects in a row saw at least one replayable line
    // this build could not parse (see `Transport::unparseable_replayable`). The
    // daemon replays deterministically, so a persistently malformed line
    // reappears at the exact same cursor position on every reattach — this
    // bounds how long we keep asking for it (see `malformed_replay_step`).
    let mut malformed_replay_streak: u32 = 0;
    // Why the loop ended: a spontaneous transport close (the process died on its own)
    // must be EXPLAINED in the conversation, while a requested Shutdown is expected.
    let process_gone = 'outer: loop {
        // Drive the CURRENT transport until it closes or a Shutdown lands.
        loop {
            tokio::select! {
                maybe_msg = msg_rx.recv() => {
                    // D6: `reader_loop` folds a valid `fd_skip` straight into
                    // `Transport::lines_seen` and never forwards it here — this is
                    // just the wake-up point where we poll for the one-time note a
                    // MISMATCHED frame would have left (see
                    // `transport::apply_fd_skip`'s doc). Checked on every wake-up
                    // (message OR transport-closed), not only on a specific
                    // message type, so it surfaces promptly without adding any
                    // wire traffic of its own.
                    if let Some(detail) = transport.take_skip_violation() {
                        core.emit_error_notice("protocol_error", json!({ "message": detail }));
                    }
                    match maybe_msg {
                        Some(CliMessage::FdAttach(a)) => {
                            attach.conversation = Some(a.conversation);
                            attach.epoch = Some(a.epoch);
                            attach_base = a.replay_from;
                            attach_seen = true;
                            delay = std::time::Duration::from_secs(1);
                            if reconnect_pending {
                                reconnect_pending = false;
                                core.emit_error_notice("remote_link", json!({
                                    "message": "Reconnected to the server.",
                                }));
                            }
                            // A6: this attach just confirmed a candidate DIFFERENT from
                            // the machine's persisted preferred host actually works —
                            // persist the win (once per distinct winning host this
                            // session; see `persisted_host`'s doc) so the next spawn
                            // dials it first instead of re-paying the backoff against a
                            // dead `host` every time.
                            if let Some(remote) = cfg.remote.as_ref() {
                                // Baseline = the last host we KNOW to be true this
                                // session — what we most recently persisted, or (if we
                                // haven't persisted anything yet) the host we were
                                // spawned with. See `host_to_persist`'s doc for why
                                // this must NOT be the frozen `original_host` alone.
                                let baseline = persisted_host.as_deref().or(original_host.as_deref());
                                if let Some(baseline) = baseline {
                                    if let Some(new_host) = host_to_persist(baseline, &remote.host) {
                                        if let Some(machine_id) = remote.machine_id.clone() {
                                            persisted_host = Some(new_host.clone());
                                            core.emit_preferred_host(&machine_id, &new_host);
                                        }
                                    }
                                }
                            }
                            // Resync with the daemon's truth: turn state + pending
                            // permission prompts (see the core methods' docs).
                            if let Some(daemon_busy) = a.busy {
                                core.sync_remote_busy(daemon_busy);
                            }
                            if let Some(pending) = &a.pending {
                                core.sync_pending_permissions(pending);
                            }
                        }
                        Some(CliMessage::FdDetach(d)) => {
                            let (message, terminal, narrated) =
                                reconnect_policy_for_reason(&d.reason, d.exit_code, d.message.as_deref());
                            if let Some(message) = message {
                                core.emit_error_notice("remote_link", json!({ "message": message }));
                            }
                            if terminal {
                                no_reconnect = Some(d.reason);
                                deliberate_exit = narrated;
                            }
                            // else: "stalled" — non-terminal, fall through to the normal
                            // reconnect path below exactly like a spontaneous transport
                            // close (`None => break`).
                        }
                        Some(msg) => core.on_message(msg),
                        None => break, // transport closed
                    }
                },
                maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                    Some(SessionCommand::Shutdown { ack, stop_remote: sr }) => {
                        shutdown_ack = ack;
                        stop_remote = sr;
                        break 'outer false;
                    }
                    None => break 'outer false, // command channel closed: requested stop
                    Some(cmd) => core.on_command(cmd),
                },
            }
        }
        // The transport closed on its own. Local session, or a deliberate remote
        // goodbye → the normal end-of-life path.
        if cfg.remote.is_none() || no_reconnect.is_some() {
            break 'outer true;
        }
        // Whether THIS transport ever completed the fd_attach handshake —
        // captured now, before the shutdown below reaps the process. A spawn
        // that never attached (the remote command itself failed, e.g. `ssh`
        // exec'd `flightdeckd` and it isn't on PATH) never produces an
        // `FdDetach`, so the existing reason-based exit check above can never
        // fire for it — this is the only case `looks_like_missing_daemon`
        // needs to look at.
        let had_attach = attach_seen;
        if !had_attach {
            // Safe to call before `shutdown` (see their doc comments in
            // transport.rs) — the process already exited on its own; this
            // just reaps it and reads back what it left behind.
            let exit_code = transport.wait_status().await.and_then(|s| s.code());
            // Make sure the stderr pump actually finished draining the pipe
            // before reading it back — otherwise a still-in-flight pump could
            // make the classification below miss the "command not found" line
            // and silently fall back to the old reconnect-forever bug.
            transport.wait_stderr_drained().await;
            let stderr = transport.stderr_tail();
            // The binary THIS session actually invoked — not a hardcoded
            // "flightdeckd" — so a non-default `daemon_bin` (e.g.
            // `TOSSE_REMOTE_FLIGHTDECKD_BIN`, see `ipc/commands.rs`) still gets
            // classified against the name the remote shell actually complained
            // about. `cfg.remote` is guaranteed `Some` here (checked above).
            let daemon_bin = cfg
                .remote
                .as_ref()
                .map(|r| r.daemon_bin.as_str())
                .unwrap_or("flightdeckd");
            if looks_like_missing_daemon(exit_code, &stderr, daemon_bin) {
                let (message, terminal, narrated) = reconnect_policy_for_reason(
                    "daemon_missing",
                    exit_code.map(i64::from),
                    Some(daemon_bin),
                );
                if let Some(message) = &message {
                    core.emit_error_notice(
                        "process_exited",
                        json!({
                            "message": message,
                            // Structured, stable field alongside the free-text
                            // message — a future UI can match on this instead
                            // of parsing English prose (see the pairing-side
                            // daemon-missing wording this doesn't yet share).
                            "reason": "daemon_missing",
                            "detail": if stderr.is_empty() {
                                Value::Null
                            } else {
                                Value::String(stderr.join("\n"))
                            },
                        }),
                    );
                }
                if terminal {
                    // Unlike the `FdDetach` handler, this breaks out of the
                    // outer loop directly instead of falling through to the
                    // top-of-loop `no_reconnect.is_some()` check — so, unlike
                    // there, nothing downstream re-reads `no_reconnect`'s
                    // value on this path; `deliberate_exit` (below) already
                    // carries what the exit-explain block needs.
                    deliberate_exit = narrated;
                    break 'outer true;
                }
                // else: fall through to the normal reconnect path below,
                // exactly like the FdDetach "stalled" case above — the table
                // decides, `run_actor` never hardcodes the outcome.
            } else if looks_like_clap_flag_rejection(exit_code, &stderr) {
                // D6/C9 follow-up (review finding): the CACHED per-machine daemon
                // version (`ipc::commands::daemon_version_for_machine`) said this
                // server's `flightdeckd` understood `--supports-skip`/`--title`, but
                // it just rejected one of them outright — the server was DOWNGRADED
                // below 0.2.0 since that cache entry was learned. Without this,
                // EVERY reconnect would keep passing the same now-unsupported
                // flag(s), clap would reject them identically forever, and the
                // conversation could never reconnect until the app restarts.
                //
                // Invalidate the cache (so the next fresh top-level spawn re-probes
                // for real) and drop BOTH optional flags here, for the REST of this
                // actor's own reconnect loop (both share the same 0.2.0 floor, so a
                // daemon that rejects one can't understand the other either) —
                // never re-offering them again this session, which is what "never
                // loop" requires: a single flip, not a re-arm-and-fail cycle.
                if let Some(machine_id) = cfg.remote.as_ref().and_then(|r| r.machine_id.as_deref()) {
                    crate::ipc::commands::invalidate_daemon_version_cache(machine_id);
                }
                attach.supports_skip = false;
                cfg.conversation_title = None;
                let (message, terminal, narrated) =
                    reconnect_policy_for_reason("flag_rejected", exit_code.map(i64::from), None);
                if let Some(message) = &message {
                    core.emit_error_notice(
                        "process_exited",
                        json!({
                            "message": message,
                            "reason": "flag_rejected",
                            "detail": if stderr.is_empty() {
                                Value::Null
                            } else {
                                Value::String(stderr.join("\n"))
                            },
                        }),
                    );
                }
                if terminal {
                    deliberate_exit = narrated;
                    break 'outer true;
                }
                // else: fall through to the normal reconnect path below, now
                // downgraded — exactly one retry without the flags, per the table.
            }
        }
        // Remote link lost while the server-side session lives on: reconnect.
        // Advance the cursor ONLY if this transport completed its handshake;
        // otherwise keep the last known-good position.
        if attach_seen {
            let unparseable = transport.unparseable_replayable();
            let (force_advance, new_streak, warn) =
                malformed_replay_step(unparseable, malformed_replay_streak);
            malformed_replay_streak = new_streak;
            cursor = attach_base
                + reattach_cursor_delta(
                    transport.lines_seen(),
                    transport.first_unparseable_offset(),
                    force_advance,
                );
            if warn {
                eprintln!(
                    "[session] giving up on {force_advance} replayable line(s) this build \
                     repeatedly failed to parse — skipping them so the daemon stops resending"
                );
                core.emit_error_notice(
                    "protocol_error",
                    json!({ "message": "Some messages from the server could not be displayed and were skipped." }),
                );
            }
            attach_seen = false;
            // A6: this attempt DID reach fd_attach (even if it then later dropped,
            // e.g. a "stalled" detach) — the candidate `cfg.remote.host` currently
            // names is proven alive, so its failure streak resets.
            candidate_failures = 0;
        } else {
            // A6: this attempt (the transport just driven, whichever candidate
            // `cfg.remote.host` named for it) never reached fd_attach at all —
            // count it toward that candidate's consecutive-failure streak.
            candidate_failures += 1;
        }
        transport.shutdown(false).await; // reap the dead ssh client quietly
        if !reconnect_pending {
            reconnect_pending = true;
            core.emit_error_notice("remote_link", json!({
                "message": "Connection to the server lost — reconnecting…",
            }));
        } else {
            // Still in the same outage (the previous attempt spawned ssh but
            // never got an fd_attach): escalate the backoff.
            delay = (delay * 2).min(std::time::Duration::from_secs(30));
        }
        // A6: past the threshold against the SAME candidate, try the next
        // recorded address (see `next_candidate_after_failure`'s doc for the
        // single-candidate / wrap-around rules). Applies BEFORE the backoff wait
        // below, so the very next spawn attempt already dials the new candidate.
        if let Some(new_host) = rotate_remote_address(&mut cfg, &mut addr_idx, candidate_failures) {
            candidate_failures = 0;
            core.emit_error_notice("remote_link", json!({
                "message": format!("Trying another address for this server: {new_host}"),
            }));
        }
        loop {
            // Wait out the backoff, staying responsive to commands (a send while
            // offline surfaces as send_failed instead of blocking).
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                    Some(SessionCommand::Shutdown { ack, stop_remote: sr }) => {
                        shutdown_ack = ack;
                        stop_remote = sr;
                        break 'outer false;
                    }
                    None => break 'outer false,
                    Some(cmd) => { core.on_command(cmd); continue; }
                },
            }
            let mut cfg2 = cfg.clone();
            // Resume by the LIVE claude session id when we know it (a brand-new
            // session learned it from init after spawn), so a daemon that lost
            // the process can restart it from the right transcript.
            cfg2.resume = core.session_id().or_else(|| cfg.resume.clone());
            cfg2.attach = Some(transport::AttachPoint {
                conversation: attach.conversation.clone(),
                epoch: attach.epoch.clone(),
                cursor,
                // D6: decided ONCE at the very first spawn (from a cached per-machine
                // version probe — see `ipc::commands::supports_skip_for_machine`) and
                // never re-decided here: `attach` (this loop's local reattach state)
                // is seeded from `cfg.attach`, so every reconnect for this session's
                // lifetime carries forward the SAME opt-in it started with — with
                // exactly ONE exception, a few lines above in this same loop: a
                // clap-rejection downgrade (`attach.supports_skip = false` in the
                // `looks_like_clap_flag_rejection` branch) flips it mid-session when
                // the server's daemon turns out to have been downgraded below 0.2.0,
                // and it then stays flipped for the rest of the actor's lifetime.
                supports_skip: attach.supports_skip,
            });
            match Transport::spawn(cfg2) {
                Ok((t, rx)) => {
                    transport = t;
                    msg_rx = rx;
                    core.set_outbound(transport.outbound());
                    // NOT success yet — that's the daemon's fd_attach. Go drive
                    // the new transport; an instant EOF loops back here with the
                    // escalated backoff still in force.
                    continue 'outer;
                }
                Err(e) => {
                    eprintln!("[session] remote reconnect failed (retrying in {delay:?}): {e}");
                    delay = (delay * 2).min(std::time::Duration::from_secs(30));
                    // A6: the spawn itself (forking the local ssh client) never even
                    // got off the ground — mirrors the `!attach_seen` failure signal
                    // above, against whichever candidate `cfg2.remote.host` (== the
                    // CURRENT `cfg.remote.host`, `cfg2` is just its clone) just named.
                    candidate_failures += 1;
                    if let Some(new_host) = rotate_remote_address(&mut cfg, &mut addr_idx, candidate_failures) {
                        candidate_failures = 0;
                        core.emit_error_notice("remote_link", json!({
                            "message": format!("Trying another address for this server: {new_host}"),
                        }));
                    }
                }
            }
        }
    };
    // The process vanished without us asking: surface why (exit code + last stderr)
    // so a crash / OOM / auth failure mid-turn is never a silent stop — EXCEPT a
    // deliberate remote goodbye (exited / replaced / stopped) or a classified
    // daemon_missing, both already narrated with their real reason above (see
    // `deliberate_exit`, set straight from `reconnect_policy_for_reason`'s
    // table wherever `no_reconnect` was set — never re-listed here); the local
    // ssh exit status would only add noise ("exited (code 0)") or a second,
    // generic notice on top of the specific one.
    if process_gone {
        let status = transport.wait_status().await;
        if !deliberate_exit {
            core.emit_process_exit(
                status,
                transport.reader_error(),
                transport.writer_error(),
                transport.stderr_tail(),
            );
        }
    }
    // Announce the end so the UI stops showing a live session.
    core.emit_ended();
    // Drop the core (and its outbound sender clone) so the writer's channel can
    // close and stdin can EOF, then run the graceful teardown ladder.
    drop(core);
    transport.shutdown(stop_remote).await;
    // The user's explicit Stop must reach the server even when the attach link
    // is already dead (the fd_stop inside `shutdown` rode a live writer, or
    // died with it). One idempotent `flightdeckd stop` over a fresh ssh makes
    // it deterministic; stopping an already-stopped session is a no-op.
    if stop_remote {
        if let (Some(remote), Some(conversation)) = (cfg.remote.as_ref(), attach.conversation.as_ref()) {
            transport::run_remote_stop(remote, conversation).await;
        }
    }
    // Let the owner (e.g. the IPC registry) evict this dead session.
    on_exit();
    // The process is now fully reaped: release any caller waiting on `shutdown_and_wait`
    // (a rewind about to truncate this session's transcript). A dropped receiver (caller
    // timed out / gave up) is fine — the send just fails silently.
    if let Some(ack) = shutdown_ack {
        let _ = ack.send(());
    }
}

/// Decide what an `FdDetach` notice says, whether `run_actor` may keep
/// auto-reconnecting, and whether this reason already explains itself (skip
/// the generic exit-explain notice for it), from a `reason` plus the two
/// fields the message text draws from (`exit_code` for `"exited"`; `message`
/// for the wildcard fallback AND for `"daemon_missing"`'s invoked-binary
/// name). Pure and unit-testable — the SINGLE table `run_actor` wires BOTH the
/// inline `match d.reason.as_str() { .. }` on a real `FdDetach` AND the
/// synthesized `"daemon_missing"` reason (from `looks_like_missing_daemon`
/// classifying a transport that closed before ever attaching) into — the ONE
/// place a new reason gets added, never a second hand-edit of `run_actor`'s
/// match OR of its final exit-explain check (`deliberate_exit` is read
/// straight off this table's 3rd return value, never re-listed by reason
/// string at the call site).
///
/// `"stalled"` is the ONLY reconnect-eligible reason; every other or unknown
/// reason keeps today's terminal behavior (mirrors `FdDetachMsg`'s doc comment
/// in `protocol.rs` — keep both in sync).
fn reconnect_policy_for_reason(
    reason: &str,
    exit_code: Option<i64>,
    message: Option<&str>,
) -> (Option<String>, bool, bool) {
    match reason {
        "exited" => (
            Some(match exit_code {
                Some(c) => format!("The remote session exited (code {c})."),
                None => "The remote session exited.".to_string(),
            }),
            true,
            true,
        ),
        "replaced" => (
            Some("Another client took over this remote session.".to_string()),
            true,
            true,
        ),
        // we asked; the stop path narrates itself (no notice here, but still
        // "already explained" — the exit-explain block must not add its own)
        "stopped" => (None, true, true),
        "stalled" => (
            Some("Connection stalled — reconnecting…".to_string()),
            false,
            false, // not terminal, so never reaches the exit-explain check
        ),
        // Synthesized locally by `looks_like_missing_daemon`, never sent by the
        // daemon (a missing daemon can't send anything) — a hard precondition
        // failure, not a retryable blip, so this must stop the auto-reconnect
        // loop instead of retrying forever on a binary that will never appear.
        // `message` carries the ACTUAL invoked binary name (the session's
        // configured `daemon_bin`, not a hardcoded "flightdeckd") so the
        // notice names what was really looked for.
        "daemon_missing" => {
            let bin = message.unwrap_or("flightdeckd");
            (
                Some(format!(
                    "{bin} isn't installed or isn't on PATH on the server — install it, \
                     then reopen this conversation."
                )),
                true,
                true,
            )
        }
        // Synthesized locally by `looks_like_clap_flag_rejection`, never sent by the
        // daemon. Non-terminal: `run_actor` has ALREADY invalidated the machine's
        // cached daemon version and dropped the optional flags for the rest of this
        // actor's reconnect loop by the time this is reached — this just decides the
        // one-time notice, same as `"stalled"`.
        "flag_rejected" => (
            Some(
                "The server's flightdeckd no longer understands an optional flag this \
                 Mac was sending — retrying without it."
                    .to_string(),
            ),
            false,
            false, // not applicable — never reaches the exit-explain check (non-terminal)
        ),
        _ => (
            Some(message.map(str::to_string).unwrap_or_else(|| "Remote attach failed.".to_string())),
            true,
            // Pre-existing (not this task's scope to change): an unrecognized
            // reason is NOT treated as already-narrated, so the exit-explain
            // block still adds its generic notice on top of this one.
            false,
        ),
    }
}

/// Hard-precondition classifier: does a just-closed remote transport's exit
/// look like the remote command itself was never found — `daemon_bin` isn't
/// installed or isn't on `PATH` on the server — rather than a retryable
/// network blip? Requires BOTH an exit code of 127 (the shell convention for
/// "command not found") AND the LAST non-empty stderr line naming `daemon_bin`
/// specifically (case-insensitive substring, matched on its basename so a
/// full-path `daemon_bin` still matches the shell's bare-name wording).
///
/// `daemon_bin` is the binary THIS session actually invoked — normally
/// `"flightdeckd"`, but configurable via `RemoteTarget::daemon_bin` (see
/// `ipc/commands.rs`'s `TOSSE_REMOTE_FLIGHTDECKD_BIN`) — never hardcode
/// `"flightdeckd"` here, or a session using a non-default binary name would
/// never get classified when THAT binary is the one missing.
///
/// Anchoring on the command name — not a generic "command not found" / "no
/// such file" phrase alone — is load-bearing: a looser match would
/// false-positive on unrelated remote-shell noise that happens to share exit
/// code 127 (a stale MOTD script, a broken dotfile, some other command
/// failing in the same ssh session on a real Ubuntu box) and PERMANENTLY kill
/// a retryable blip instead of reconnecting. Covers the common shell
/// wordings: `bash: flightdeckd: command not found`, `zsh: command not
/// found: flightdeckd`, `sh: 1: flightdeckd: not found`, `exec: flightdeckd:
/// not found`.
fn looks_like_missing_daemon(exit_code: Option<i32>, stderr_tail: &[String], daemon_bin: &str) -> bool {
    if exit_code != Some(127) {
        return false;
    }
    let needle = daemon_bin.rsplit('/').next().unwrap_or(daemon_bin).trim().to_lowercase();
    if needle.is_empty() {
        return false;
    }
    stderr_tail
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.to_lowercase().contains(&needle))
}

/// D6/C9 follow-up (review finding): does a just-closed remote transport's exit look
/// like clap rejecting one of our two version-gated OPTIONAL attach flags
/// (`--supports-skip` — D6 — or `--title` — C9) outright, rather than a network blip?
/// Requires BOTH clap's own exit code for an unrecognized argument (2) AND the LAST
/// non-empty stderr line naming one of the two flags specifically alongside clap's
/// "unexpected argument" wording (case-insensitive, so a clap wording tweak across a
/// future major still matches on the flag name, mirroring `looks_like_missing_daemon`'s
/// own anchoring discipline — a looser match on exit code 2 ALONE would false-positive
/// on an unrelated usage error and could misclassify a real problem as "just retry
/// without the flags").
///
/// This can only fire when the CACHED per-machine version gate
/// (`ipc::commands::daemon_version_for_machine`) was WRONG for the server's ACTUAL,
/// now-downgraded `flightdeckd` — the version is learned once per app run and never
/// re-checked mid-run otherwise (see that cache's doc).
fn looks_like_clap_flag_rejection(exit_code: Option<i32>, stderr_tail: &[String]) -> bool {
    if exit_code != Some(2) {
        return false;
    }
    stderr_tail
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            let lower = line.to_lowercase();
            lower.contains("unexpected argument")
                && (lower.contains("--supports-skip") || lower.contains("--title"))
        })
}

/// How many consecutive reconnects in a row may see the SAME unparseable
/// replayable line before `run_actor` gives up on it. Chosen to comfortably
/// exceed a transient hiccup (one bad transmission, healed on replay) while
/// still bounding a genuinely corrupt daemon-side record to a handful of
/// wasted round trips, not forever.
const MAX_MALFORMED_REPLAY_ATTEMPTS: u32 = 3;

/// One step of the cross-reconnect bookkeeping for replayable lines this build
/// could not parse (see `Transport::unparseable_replayable`'s doc for why they
/// are excluded from the reattach cursor by default).
///
/// The daemon replays deterministically, so a persistently malformed line
/// reappears at the exact same cursor position on every single reattach —
/// without a bound, the actor would ask for it, fail to parse it, and ask
/// again forever, taking every line after it down with it (their real
/// positions never get acknowledged either). Past
/// [`MAX_MALFORMED_REPLAY_ATTEMPTS`] consecutive reconnects that each saw at
/// least one such failure, we accept the loss: the returned `forced_advance`
/// tells the caller to move the cursor past those bytes (so the daemon stops
/// resending something we can never parse) and `warn` tells it to surface a
/// ONE-TIME `protocol_error` notice — silently dropping messages forever would
/// violate the zero-silent-error contract.
///
/// A healthy reconnect (`unparseable == 0`) resets the streak: this only fires
/// for a reason that reproduces on EVERY attempt, not an occasional blip.
fn malformed_replay_step(unparseable: u64, streak: u32) -> (u64, u32, bool) {
    if unparseable == 0 {
        return (0, 0, false);
    }
    let streak = streak + 1;
    if streak >= MAX_MALFORMED_REPLAY_ATTEMPTS {
        (unparseable, 0, true)
    } else {
        (0, streak, false)
    }
}

/// The CURRENT transport's contribution to the reattach cursor (`run_actor`
/// adds the daemon's `replay_from` base on top). Pure and unit-testable —
/// kept separate from `run_actor` so the composition of `lines_seen` /
/// `first_unparseable_offset` / `force_advance` can be exercised without a
/// live transport.
///
/// `lines_seen` (a raw count of SUCCESSFULLY parsed replayable lines this
/// connection) is NOT the daemon's wire position: if later replayable lines
/// go on to parse fine after an EARLIER one this build could not, `lines_seen`
/// silently overtakes that earlier failure's true position. Reattaching with
/// it would tell the daemon we already have everything through a point that
/// includes a line we actually never received — permanently, silently lost,
/// never replayed again.
///
/// - Still retrying (`force_advance == 0`): roll back to
///   `first_unparseable_offset` when the transport saw a failure this
///   connection (the count of successes strictly BEFORE it), so the daemon
///   resends starting right before it — at the cost of re-delivering any
///   later lines that DID already parse fine (a bounded duplicate, not a
///   silent loss). No failure at all → `lines_seen` is exact, use it.
/// - Giving up (`force_advance > 0`, from [`malformed_replay_step`]): skip
///   past EVERYTHING this connection delivered, failures included —
///   `lines_seen + force_advance` is the true total and thus the correct
///   position; `first_unparseable_offset` must NOT be used here; it would
///   roll back to a bad line we have just decided to stop asking for.
fn reattach_cursor_delta(lines_seen: u64, first_unparseable_offset: Option<u64>, force_advance: u64) -> u64 {
    if force_advance > 0 {
        lines_seen + force_advance
    } else {
        first_unparseable_offset.unwrap_or(lines_seen)
    }
}

/// A6 — sustained reconnect failure address rotation: how many CONSECUTIVE
/// attempts against the SAME candidate must fail before `run_actor` tries the
/// next recorded address. Small on purpose: a dead preferred address should not
/// be re-tried for long before falling back to a known-good one, but more than
/// one blip stays enough margin that a single transient failure never rotates.
const ADDRESS_ROTATION_THRESHOLD: u32 = 2;

/// A6's pure rotation decision: given how many consecutive attempts against the
/// candidate at `addr_idx` have failed to reach `fd_attach`, and how many
/// candidates exist in total, decide whether — and to which index — `run_actor`
/// should rotate. Pure and unit-testable, deliberately knowing nothing about
/// *why* the last attempt failed: `run_actor` only ever calls this from paths
/// that are ALREADY retry-eligible (a terminal `reconnect_policy_for_reason`
/// breaks the outer loop before reaching either call site — see its doc), so
/// this function has no "reason" to weigh.
///
/// - A single candidate (`addr_count <= 1`, true for every machine paired
///   before A5, whose `addresses` is just `[host]`) never rotates: there is
///   nothing else to try, so the existing generic backoff-forever behavior is
///   preserved byte-for-byte.
/// - Below [`ADDRESS_ROTATION_THRESHOLD`] consecutive failures, stays put — one
///   blip against an otherwise-fine candidate must not go address-hunting.
/// - At or past the threshold, advances to `(addr_idx + 1) % addr_count`:
///   WRAPPING, so a machine whose every candidate is currently dead just keeps
///   cycling through them forever (with the existing generic "reconnecting…"
///   notice) rather than ever giving up — `run_actor` has no "give up" state
///   for a remote session the daemon still owns server-side.
fn next_candidate_after_failure(
    addr_idx: usize,
    consecutive_failures: u32,
    addr_count: usize,
) -> Option<usize> {
    if addr_count <= 1 || consecutive_failures < ADDRESS_ROTATION_THRESHOLD {
        return None;
    }
    Some((addr_idx + 1) % addr_count)
}

/// Apply [`next_candidate_after_failure`]'s decision to a live [`SpawnConfig`]:
/// bump `*addr_idx` and mutate `cfg.remote.host` to the new candidate, returning
/// the new host when a rotation actually happened (so the caller can reset its
/// failure counter and emit the one-time notice) — `None` when the threshold
/// wasn't crossed, there's only one candidate, or (defense-in-depth)
/// `addresses` is empty despite [`transport::RemoteTarget::addresses`]'s
/// documented invariant that it never is.
fn rotate_remote_address(
    cfg: &mut SpawnConfig,
    addr_idx: &mut usize,
    consecutive_failures: u32,
) -> Option<String> {
    let remote = cfg.remote.as_mut()?;
    let next_idx = next_candidate_after_failure(*addr_idx, consecutive_failures, remote.addresses.len())?;
    let new_host = remote.addresses.get(next_idx)?.clone();
    *addr_idx = next_idx;
    if new_host == remote.host {
        // Defensive: `remote_target_addresses` dedupes, so two distinct indices
        // naming the same value shouldn't happen — but if it ever did, this is
        // not a rotation worth narrating (nothing actually changes to dial).
        return None;
    }
    remote.host = new_host.clone();
    Some(new_host)
}

/// A6's pure persist decision: given `last_known_host` — the most recently
/// known-true host for THIS session (whatever `run_actor` most recently told
/// the DB, or the host it was SPAWNED with if it hasn't told the DB anything
/// yet) — and the host a just-confirmed `fd_attach` landed on, decide whether
/// that attach should be persisted as the machine's new preferred address.
/// `None` means "already known to be on this host", so the caller must not
/// re-emit the persist signal.
///
/// Comparing only against the frozen SPAWN-TIME host (what an earlier version
/// of this logic did) misses a LATER rotation that lands back on an address
/// already superseded by an EARLIER rotation within the same session: spawn
/// on X, rotate to Y (persist Y), later rotate back to X — the spawn-time
/// host is still X, so `attached_host != original_host` sees "no change" and
/// skips persisting X even though the DB still (wrongly) says Y. Passing the
/// last-PERSISTED host as the baseline instead (falling back to the spawn
/// host only until the first persist) catches this: on that second rotation
/// the baseline is Y, `X != Y`, so X gets persisted as it must.
fn host_to_persist(last_known_host: &str, attached_host: &str) -> Option<String> {
    (last_known_host != attached_host).then(|| attached_host.to_string())
}

/// A `can_use_tool` request we have surfaced and are waiting to answer.
struct PendingPermission {
    tool_use_id: String,
    input: Value,
}

/// Protocol logic for one session, decoupled from process I/O via `outbound`.
struct SessionCore {
    id: String,
    emitter: Arc<dyn SessionEmitter>,
    assembler: Assembler,
    /// Whether a user message was written to the CURRENT outbound link (reset when a
    /// reconnect swaps the link in — see [`Self::set_outbound`]). Read by
    /// [`Self::sync_remote_busy`]: a message written on this same link is ordered
    /// AFTER the daemon's `fd_attach` on the pipe, so the attach's `busy: false`
    /// predates it and says nothing about it being lost.
    sent_on_current_link: bool,
    /// Inbound permission prompts keyed by their `request_id`.
    pending: HashMap<String, PendingPermission>,
    /// Our OUTBOUND control requests awaiting their ack, keyed by `request_id`, so
    /// the response can be routed (read-back applied, surface an error). Distinct
    /// from `pending` (inbound permission prompts).
    pending_control: HashMap<String, PendingControl>,
    /// The `request_id` of our outbound `initialize` request, kept so we can pick
    /// its `control_response` out of the stream and harvest the slash commands.
    /// Cleared once consumed (the handshake happens once per session).
    init_request_id: Option<String>,
    /// Whether to restore the ultracode flag after init (the `--effort` spawn flag
    /// sets the effort level but not the separate ultracode flag).
    restore_ultracode: bool,
    /// The conversation's own overrides, to re-apply after `initialize` (see
    /// [`InitialControls::session_overrides`]). `None` when it has none.
    restore_session_overrides: Option<SessionOverrides>,
    /// Tools Flight Deck's settings allow for this conversation: a prompt that only a
    /// settings-file `ask` rule raised for one of them is answered for the user — Flight
    /// Deck's choice overrides Claude Code's own files wherever the CLI lets it.
    auto_allow: std::collections::HashSet<String>,
    /// In-flight `mcp_status` queries, keyed by their outbound `request_id`. The
    /// matching `control_response` fulfills (and removes) the reply channel.
    pending_mcp: HashMap<String, oneshot::Sender<Result<Vec<McpServerLive>, String>>>,
    /// In-flight `mcp_authenticate` requests, keyed by `request_id` — the reply
    /// (authUrl / requiresUserAction) is delivered back over the oneshot.
    pending_mcp_auth: HashMap<String, oneshot::Sender<McpAuthResult>>,
    /// In-flight [`SessionCommand::ControlQuery`] requests, keyed by `request_id`. The
    /// matching `control_response` is handed back whole, for the caller to parse.
    pending_query: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    /// In-flight `remote_control` requests, keyed by `request_id`. The stored `bool`
    /// is the direction we asked for (enable/disable), so the ack is parsed as a
    /// `session_url` grant or a plain disconnect; the reply carries the result state.
    pending_remote_control: HashMap<String, (bool, oneshot::Sender<RemoteControlState>)>,
    next_req: u64,
    /// Outbound JSON lines (→ the process stdin in production, → a test channel
    /// in unit tests).
    outbound: mpsc::UnboundedSender<Value>,
    /// The app-control hub, when this session hosts the in-process "flightdeck"
    /// SDK MCP server (advertised on `initialize`, served on `mcp_message`).
    /// `None` = the server is not exposed to this session (Settings toggle off,
    /// or a unit test).
    appmcp: Option<Arc<crate::appmcp::ControlHub>>,
}

impl SessionCore {
    fn new(
        id: String,
        initial: InitialControls,
        emitter: Arc<dyn SessionEmitter>,
        outbound: mpsc::UnboundedSender<Value>,
        appmcp: Option<Arc<crate::appmcp::ControlHub>>,
    ) -> Self {
        let mut assembler = Assembler::new();
        // Seed the live state with the spawn controls so the UI shows the right
        // values from t=0 — before system/init (model + permission) and the first
        // get_settings read-back (effort + ultracode) land.
        assembler.seed_controls(
            initial.model.clone(),
            initial.effort.clone(),
            initial.permission_mode.clone(),
            initial.ultracode,
        );
        Self {
            id,
            emitter,
            assembler,
            pending: HashMap::new(),
            pending_control: HashMap::new(),
            init_request_id: None,
            restore_ultracode: initial.ultracode,
            auto_allow: initial
                .session_overrides
                .as_ref()
                .map(|o| o.allow.iter().cloned().collect())
                .unwrap_or_default(),
            restore_session_overrides: initial.session_overrides.filter(|o| !o.is_empty()),
            pending_mcp: HashMap::new(),
            pending_mcp_auth: HashMap::new(),
            pending_query: HashMap::new(),
            pending_remote_control: HashMap::new(),
            next_req: 0,
            outbound,
            appmcp,
            sent_on_current_link: false,
        }
    }

    /// Swap the outbound line sender for a NEW transport's writer — the remote
    /// reconnect path. The core's state (assembler, pendings) carries over; only
    /// the pipe changes.
    fn set_outbound(&mut self, tx: mpsc::UnboundedSender<Value>) {
        self.outbound = tx;
        self.sent_on_current_link = false;
    }

    /// The claude session id the assembler learned from `system/init`, if any.
    fn session_id(&self) -> Option<String> {
        self.assembler.state().session_id.clone()
    }

    /// Remote-attach resync: adopt the DAEMON's turn state when it disagrees
    /// with ours. Our busy flag is optimistic (set on send) — a message that
    /// died in a dead link leaves it stuck `true` forever, since the turn it
    /// announced never runs. The daemon KNOWS whether a turn is running.
    ///
    /// Not when the busy flag comes from a message written on THIS link: the daemon
    /// sends `fd_attach` first and only then reads what we wrote, so its `busy:
    /// false` is simply older than our message (found on the first real remote
    /// conversation, 19/09: the very first message of a fresh conversation always
    /// flashed "The server has no turn running…" half a second before its turn ran).
    fn sync_remote_busy(&mut self, daemon_busy: bool) {
        if !daemon_busy && self.sent_on_current_link {
            return;
        }
        if self.assembler.state().busy != daemon_busy {
            if !daemon_busy {
                self.emit_error_notice(
                    "remote_link",
                    json!({ "message": "The server has no turn running — your last message may not have been delivered. Send it again." }),
                );
            }
            let ev = self.assembler.set_busy(daemon_busy);
            self.emit(ev);
        }
    }

    /// Remote-attach resync: permission prompts answered or withdrawn while we
    /// were detached never reach us as `control_cancel_request` — the daemon's
    /// `fd_attach.pending` list is the truth. Resolve away anything stale so no
    /// dead card stays clickable.
    fn sync_pending_permissions(&mut self, live: &[String]) {
        let stale: Vec<String> = self
            .pending
            .keys()
            .filter(|k| !live.iter().any(|l| l == *k))
            .cloned()
            .collect();
        if stale.is_empty() {
            return;
        }
        for request_id in stale {
            self.pending.remove(&request_id);
            self.emit(SessionEvent::PermissionResolved(PermissionResolvedPayload { request_id }));
        }
        let ev = self.awaiting_permission_event();
        self.emit(ev);
    }

    /// Queue an outbound line. Returns `false` if the writer channel is closed (the
    /// process is gone but the actor hasn't observed it yet) so user-facing callers
    /// can surface "not delivered" instead of dropping it silently.
    fn send(&self, line: Value) -> bool {
        if self.outbound.send(line).is_err() {
            eprintln!("[session {}] outbound channel closed; dropped a line", self.id);
            return false;
        }
        true
    }

    fn next_request_id(&mut self) -> String {
        self.next_req += 1;
        format!("tosse-{}", self.next_req)
    }

    /// Send an outbound control request and remember what it was, so its ack can be
    /// routed (read-back / error) instead of silently dropped. `make` builds the
    /// wire line from the allocated `request_id`.
    fn send_tracked(&mut self, kind: PendingControl, make: impl FnOnce(&str) -> Value) {
        let rid = self.next_request_id();
        let line = make(&rid);
        // Only track the ack if the line actually went out. If the outbound channel
        // is closed (process gone, not yet observed), surface it as a control error
        // instead of silently dropping the request and leaking a pending entry that
        // will never be acked — same "no silent failure" guard as SendUser.
        if self.send(line) {
            self.pending_control.insert(rid, kind);
        } else {
            self.emit_control_error(kind, "session closed: the request could not be sent");
        }
    }

    /// Query the session's live applied settings (model/effort/ultracode). The ack
    /// is the authoritative read-back — the ONLY reliable source of the effort level
    /// (absent from system/init) and proof a change really landed.
    fn refresh_settings(&mut self) {
        self.send_tracked(PendingControl::GetSettings, control::get_settings_request);
    }

    /// Surface a control-request failure as a visible notice — never a silent error.
    fn emit_control_error(&self, kind: PendingControl, detail: &str) {
        self.emit(SessionEvent::Item(ConversationItem::Notice {
            subtype: "control_error".to_string(),
            detail: serde_json::json!({ "control": kind.label(), "message": detail }),
        }));
    }

    /// Surface ANY error as a visible timeline notice — the single core-side entry
    /// point for the "zero silent error" contract. `subtype` selects the heading the
    /// UI renders (`process_exited` / `send_failed` / `protocol_error` / `error`);
    /// `detail` carries `message` (+ optional `detail`/`stderr`/`exit_code`).
    fn emit_error_notice(&self, subtype: &str, detail: Value) {
        self.emit(SessionEvent::Item(ConversationItem::Notice {
            subtype: subtype.to_string(),
            detail,
        }));
    }

    /// The `claude` process died without us asking. Emit a `process_exited` notice that
    /// explains it — exit code / signal, the reader/writer failure that preceded it,
    /// and the tail of stderr — so an unexpected crash (OOM, auth failure, panic) is
    /// visible in the conversation instead of the agent merely "stopping".
    fn emit_process_exit(
        &self,
        status: Option<ExitStatus>,
        reader_err: Option<String>,
        writer_err: Option<String>,
        stderr_tail: Vec<String>,
    ) {
        let message = describe_exit(status);
        let mut parts: Vec<String> = Vec::new();
        if let Some(r) = reader_err {
            parts.push(format!("stream interrupted: {r}"));
        }
        if let Some(w) = writer_err {
            parts.push(format!("write interrupted: {w}"));
        }
        if let Some(code) = status.and_then(|s| s.code()) {
            parts.push(format!("exit code: {code}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(sig) = status.and_then(|s| s.signal()) {
                parts.push(format!("signal: {sig}"));
            }
        }
        if !stderr_tail.is_empty() {
            parts.push(format!("stderr:\n{}", stderr_tail.join("\n")));
        }
        let detail = if parts.is_empty() {
            Value::Null
        } else {
            Value::String(parts.join("\n\n"))
        };
        self.emit_error_notice(
            "process_exited",
            json!({ "message": message, "detail": detail }),
        );
    }

    /// State event carrying whether ANY permission prompt is still outstanding.
    ///
    /// The CLI checks permissions for parallel tool calls concurrently, so several
    /// `can_use_tool` requests can be in flight at once and `self.pending` is the
    /// only truth. Every site that resolves ONE prompt must go through this rather
    /// than hardcoding `false`: the flag drives the Flight Deck card, the fleet
    /// readout and the attention ping, so clearing it early makes a still-blocked
    /// agent look free and suppresses the notification for the prompts left over.
    fn awaiting_permission_event(&mut self) -> SessionEvent {
        self.assembler
            .set_awaiting_permission(!self.pending.is_empty())
    }

    fn emit(&self, ev: SessionEvent) {
        match ev {
            SessionEvent::State(s) => self.emitter.emit_state(&self.id, &s),
            SessionEvent::Item(i) => self.emitter.emit_item(&self.id, &i),
            SessionEvent::Permission(p) => self.emitter.emit_permission(&self.id, &p),
            SessionEvent::PermissionResolved(r) => {
                self.emitter.emit_permission_resolved(&self.id, &r)
            }
            SessionEvent::Commands(c) => self.emitter.emit_commands(&self.id, &c),
            SessionEvent::Task(t) => self.emitter.emit_task(&self.id, &t),
            SessionEvent::Title { title, seq } => self.emitter.emit_title(&self.id, &title, seq),
            SessionEvent::Summary { summary, seq } => {
                self.emitter.emit_summary(&self.id, &summary, seq)
            }
            SessionEvent::RemoteControl(s) => self.emitter.emit_remote_control(&self.id, &s),
            SessionEvent::PreferredHostChanged { machine_id, host } => {
                self.emitter.emit_preferred_host(&self.id, &machine_id, &host)
            }
        }
    }

    /// A6: see [`SessionEvent::PreferredHostChanged`]. Thin wrapper so `run_actor`'s
    /// reconnect loop (the only caller) reads like its sibling `emit_error_notice`.
    fn emit_preferred_host(&self, machine_id: &str, host: &str) {
        self.emit(SessionEvent::PreferredHostChanged {
            machine_id: machine_id.to_string(),
            host: host.to_string(),
        });
    }

    /// Initialize handshake at startup (spec §4.4). We do NOT block on it, but we
    /// remember its `request_id` so the matching `control_response` — which carries
    /// the session's slash commands — is harvested when it arrives. We then restore
    /// ultracode if needed and read the live settings back so the UI reflects the
    /// real spawn state (the effort level is absent from system/init).
    fn initialize(&mut self) {
        let rid = self.next_request_id();
        self.init_request_id = Some(rid.clone());
        // Advertise the in-process app-control MCP server when this session got
        // the hub — the CLI then drives the MCP handshake through `mcp_message`.
        let sdk_servers: &[&str] = if self.appmcp.is_some() {
            &[crate::appmcp::SDK_SERVER_NAME]
        } else {
            &[]
        };
        self.send(control::initialize_request(&rid, sdk_servers));
        // The `--effort` spawn flag set the effort LEVEL; if this conversation was
        // running ultracode, re-enable the separate flag (it has no spawn flag).
        if self.restore_ultracode {
            self.send_tracked(PendingControl::SetUltracode, |rid| {
                control::set_ultracode_request(rid, true)
            });
        }
        // The conversation's own overrides live in the process's flag layer — gone with
        // the previous process, so put them back before the first turn can run. Written
        // right after `initialize` on the same stdin, ahead of any user message. Plugins
        // were loaded at startup, so a plugin override also needs a reload to bite.
        if let Some(overrides) = self.restore_session_overrides.clone() {
            self.send_tracked(PendingControl::SessionOverrides, |rid| {
                control::session_overrides_request(rid, &overrides)
            });
            if !overrides.enabled_plugins.is_empty() {
                self.send_tracked(PendingControl::ReloadPlugins, control::reload_plugins_request);
            }
        }
        // Read the applied settings back so effort + ultracode (and the resolved
        // model id) reflect reality, not just the optimistic seed.
        self.refresh_settings();
    }

    /// Emit a terminal state event (the session has ended).
    fn emit_ended(&mut self) {
        let ev = self.assembler.set_ended();
        self.emit(ev);
    }

    fn on_message(&mut self, msg: CliMessage) {
        match msg {
            // Outbound control acks. The `initialize` ack carries the session's
            // slash commands; the rest are correlated by `request_id` so a
            // get_settings read-back is applied and any rejection is surfaced.
            CliMessage::ControlResponse(v) => self.on_control_response(v),
            CliMessage::ControlRequest(v) => self.on_control_request(v),
            CliMessage::ControlCancelRequest { request_id } => {
                if self.pending.remove(&request_id).is_some() {
                    // Tell the front the card is gone: it prunes `pendingPermissions`
                    // only when the USER answers, so without this a cancelled prompt
                    // stays on screen, clickable and answering nothing.
                    self.emit(SessionEvent::PermissionResolved(PermissionResolvedPayload {
                        request_id,
                    }));
                    let ev = self.awaiting_permission_event();
                    self.emit(ev);
                }
            }
            other => {
                for ev in self.assembler.ingest(&other) {
                    self.emit(ev);
                }
            }
        }
    }

    /// Handle an outbound-request acknowledgement (spec §4.1, keyed on the nested
    /// `response.request_id`). Three cases:
    ///   - the one-shot `initialize` ack → harvest the slash commands (spec §4.4);
    ///   - a tracked control request → apply its read-back / confirm, or surface a
    ///     rejection (never a silent failure);
    ///   - anything else → an unmatched ack we ignore.
    fn on_control_response(&mut self, v: Value) {
        let Some(resp) = control::parse_control_response(&v) else {
            // A control_response with no nested request_id — we can't route it. Rare,
            // internal; log (not a thread notice) so protocol drift is diagnosable.
            eprintln!("[session {}] unparseable control_response (no request_id)", self.id);
            return;
        };
        // An `mcp_status` reply we are awaiting: fulfill its channel and stop. A
        // rejection (resp.ok == false) is surfaced as Err — NOT swallowed into an
        // empty "success" list (which would be indiscernible from a real no-MCP
        // session). Ignore a closed receiver (caller gave up / timed out).
        if let Some(reply) = self.pending_mcp.remove(&resp.request_id) {
            let result = if resp.ok {
                Ok(control::parse_mcp_status(&v))
            } else {
                Err(resp
                    .error
                    .clone()
                    .unwrap_or_else(|| "mcp_status request rejected".to_string()))
            };
            let _ = reply.send(result);
            return;
        }
        // A generic query reply (`list_models`, `get_usage`, `rewind_files`, …): hand
        // the WHOLE line back so the caller parses it with its own typed parser. A
        // rejection becomes `Err(message)` — never an empty success, which would be
        // indiscernible from a genuinely empty answer.
        if let Some(reply) = self.pending_query.remove(&resp.request_id) {
            let result = if resp.ok {
                Ok(v.clone())
            } else {
                Err(resp
                    .error
                    .clone()
                    .unwrap_or_else(|| "control request rejected".to_string()))
            };
            let _ = reply.send(result);
            return;
        }
        // An `mcp_authenticate` reply: fulfill with the parsed authUrl. A rejection
        // (resp.error) is carried INSIDE the result (surfaced in the UI), not as a
        // timeline control error — auth failures are expected and actionable there.
        if let Some(reply) = self.pending_mcp_auth.remove(&resp.request_id) {
            let _ = reply.send(control::parse_mcp_authenticate(&v, resp.error.as_deref()));
            return;
        }
        // A `remote_control` reply: parse the ack into a bridge state (connected +
        // session_url / disconnected / error) and fulfill the caller's oneshot. A
        // rejection (resp.error) is carried INSIDE the state (surfaced on the toggle),
        // not as a timeline control error — a refused bridge is expected/actionable.
        if let Some((enabled, reply)) = self.pending_remote_control.remove(&resp.request_id) {
            let _ = reply.send(control::parse_remote_control(&v, enabled, resp.error.as_deref()));
            return;
        }
        // The initialize handshake completes exactly once.
        if Some(resp.request_id.as_str()) == self.init_request_id.as_deref() {
            self.init_request_id = None;
            if let Some(commands) = control::parse_initialize_commands(&v) {
                self.emit(SessionEvent::Commands(commands));
            }
            return;
        }
        let Some(kind) = self.pending_control.remove(&resp.request_id) else {
            // An ack we did not track (or already consumed). Benign in the common
            // case; log it so a control command that silently never completes is
            // diagnosable instead of vanishing.
            eprintln!(
                "[session {}] control_response for an untracked request '{}'",
                self.id, resp.request_id
            );
            return;
        };
        if !resp.ok {
            // Title generation is cosmetic and has an optimistic placeholder as its
            // fallback, so a rejection here is logged but NOT surfaced as a timeline
            // error (and triggers no settings re-read) — unlike model/effort/mode.
            if matches!(kind, PendingControl::GenerateTitle(_) | PendingControl::GenerateSummary(_)) {
                eprintln!(
                    "[session {}] generate_session_title rejected: {}",
                    self.id,
                    resp.error.as_deref().unwrap_or("(no error)")
                );
                return;
            }
            // A rejection (invalid model, unsupported mode/effort, …) must be
            // visible. Then re-read the truth so the indicator never lies.
            let detail = resp.error.as_deref().unwrap_or("control request rejected");
            self.emit_control_error(kind, detail);
            if !matches!(kind, PendingControl::GetSettings) {
                self.refresh_settings();
            }
            return;
        }
        match kind {
            // The authoritative read-back: model + effort + ultracode, live. Emits the
            // state PLUS a "control changed" notice for whatever actually moved.
            PendingControl::GetSettings => {
                if let Some(applied) = control::parse_get_settings_applied(&v) {
                    for ev in
                        self.assembler
                            .apply_settings(applied.model, applied.effort, applied.ultracode)
                    {
                        self.emit(ev);
                    }
                }
            }
            // The ack echoes the mode the CLI ACTUALLY applied (may differ from the
            // requested one, e.g. a downgrade) — trust it over the optimistic value.
            // Some CLI builds reply with a bare `success` and no `mode`; falling
            // back to the requested mode keeps the confirmed-transition announce
            // from vanishing silently (the four reachable modes are never
            // downgraded, so requested == applied on that path).
            PendingControl::SetPermissionMode(requested) => {
                let mode = control::parse_set_permission_mode_ack(&v)
                    .unwrap_or_else(|| requested.as_wire().to_string());
                for ev in self.assembler.confirm_permission_mode(&mode) {
                    self.emit(ev);
                }
            }
            // The generated conversation title, tagged with the `seq` we sent so the UI
            // can drop a stale, out-of-order response. Emit it for the UI to apply
            // (unless the user has set a custom title since). A success ack with no
            // usable title is a no-op — the placeholder / last title stays.
            PendingControl::GenerateTitle(seq) => {
                if let Some(title) = control::parse_generate_session_title(&v) {
                    self.emit(SessionEvent::Title { title, seq });
                }
            }
            // The few-word summary of the last message, tagged with the `seq` we sent so
            // the UI can drop a stale (superseded) response. Same response shape as the
            // title (`response.response.title`). A success ack with no usable text is a
            // no-op — the UI's optimistic truncation stays.
            PendingControl::GenerateSummary(seq) => {
                if let Some(summary) = control::parse_generate_session_title(&v) {
                    self.emit(SessionEvent::Summary { summary, seq });
                }
            }
            // The bare success of set_model / apply_flag_settings carries no payload;
            // the follow-up get_settings (queued right after) reports the truth.
            // `Interrupt`/`StopTask` acks are bare too — the visible effect arrives via
            // the stream (turn ends / the task's `task_*` lifecycle flips to stopped).
            PendingControl::SetModel
            | PendingControl::SetEffort
            | PendingControl::SetUltracode
            | PendingControl::Interrupt
            | PendingControl::StopTask
            | PendingControl::McpToggle
            | PendingControl::McpReconnect
            | PendingControl::McpClearAuth
            | PendingControl::SessionOverrides => {}
            // A hot-reload's ack is NOT bare: it returns the same
            // `response.response.commands` catalogue as `initialize`, freshly rescanned
            // (a plugin's skills appear/disappear here). Harvesting it means the `/`
            // menu is correct the moment the reload lands, without a second round trip.
            PendingControl::ReloadPlugins => {
                if let Some(cmds) = control::parse_initialize_commands(&v) {
                    self.emit(SessionEvent::Commands(cmds));
                }
            }
        }
    }

    fn on_control_request(&mut self, v: Value) {
        let Some((request_id, parsed)) = control::parse_inbound_control(&v) else {
            // No usable request_id → we can't even send a correlated error back; the
            // CLI may hang. Surface it so a stuck turn is at least explained.
            eprintln!("[session {}] control_request without a usable request_id", self.id);
            self.emit_error_notice("protocol_error", json!({
                "message": "A Claude Code request was unreadable (no identifier) and could not be processed.",
            }));
            return;
        };
        // A known-but-malformed (or otherwise un-typeable) request still gets an
        // error response — otherwise the CLI hangs waiting on us (e.g. a
        // can_use_tool with a missing field would never be answered).
        let body = match parsed {
            Ok(body) => body,
            Err(e) => {
                eprintln!("[session {}] malformed control_request: {e}", self.id);
                self.send(control::control_error_response(&request_id, "malformed control request"));
                // The most likely malformed request is a `can_use_tool` — i.e. a
                // permission prompt the user will never see. Make that visible.
                self.emit_error_notice("protocol_error", json!({
                    "message": "A Claude Code request could not be interpreted (a permission prompt may have been skipped).",
                    "detail": e,
                }));
                return;
            }
        };
        match body {
            InboundControl::CanUseTool(req) => {
                // Dedupe re-delivery of an in-flight prompt.
                if self.pending.contains_key(&request_id) {
                    return;
                }
                // Flight Deck's own "Allow" for this tool beats an `ask` rule from Claude
                // Code's settings files: answer it for the user. Only that case — never a
                // prompt the mode, the classifier or a safety check raised, and never a
                // tool that itself demands a human.
                if self.auto_allow.contains(&req.tool_name)
                    && req.decision_reason_type.as_deref() == Some("rule")
                    && !req.requires_user_interaction.unwrap_or(false)
                {
                    self.send(control::permission_allow_response(&request_id, &req.tool_use_id, req.input));
                    return;
                }
                let payload = PermissionRequestPayload {
                    request_id: request_id.clone(),
                    tool_name: req.tool_name,
                    tool_use_id: req.tool_use_id.clone(),
                    input: req.input.clone(),
                    title: req.title,
                    description: req.description,
                    suggestions: req.permission_suggestions,
                    blocked_path: req.blocked_path,
                    decision_reason: req.decision_reason,
                    agent_id: req.agent_id,
                };
                self.pending.insert(
                    request_id,
                    PendingPermission {
                        tool_use_id: req.tool_use_id,
                        input: req.input,
                    },
                );
                let state_ev = self.assembler.set_awaiting_permission(true);
                self.emit(SessionEvent::Permission(payload));
                self.emit(state_ev);
            }
            // MCP client traffic for an SDK server we host ("flightdeck"): route the
            // JSON-RPC to the app-control hub. Handled on a SPAWNED task, never inline —
            // a tool call round-trips through the front (and `create_conversation` can
            // await a session spawn), and the actor must keep draining the stream
            // meanwhile. The response rides the cloned outbound sender; a notification
            // still gets the `{result:{}, id:0}` ack the CLI expects (see
            // `control::mcp_control_response`).
            InboundControl::McpMessage { server_name, message } => {
                let hub = self
                    .appmcp
                    .clone()
                    .filter(|_| server_name == crate::appmcp::SDK_SERVER_NAME);
                let Some(hub) = hub else {
                    // Unknown server, or the session was spawned without the hub
                    // (toggle off): same error the SDK client raises in that case.
                    self.send(control::control_error_response(
                        &request_id,
                        &format!("SDK MCP server not found: {server_name}"),
                    ));
                    return;
                };
                // A WEAK outbound sender, upgraded only at reply time: a strong
                // clone held for up to the bridge timeout (30s) would keep the
                // writer channel open across `drop(core)` and structurally defeat
                // the graceful EOF rung of the teardown ladder (stdin could never
                // close while a bridged call was in flight). With the weak handle,
                // teardown proceeds normally and a reply that loses the race is
                // simply dropped — the process is gone, nobody is listening.
                let outbound = self.outbound.downgrade();
                let session_id = self.id.clone();
                tokio::spawn(async move {
                    let caller = crate::appmcp::Caller::Session(session_id);
                    let response = hub
                        .handle_mcp(crate::appmcp::Surface::App, &caller, &message)
                        .await
                        .unwrap_or_else(crate::appmcp::router::notification_ack);
                    if let Some(outbound) = outbound.upgrade() {
                        let _ = outbound.send(control::mcp_control_response(&request_id, response));
                    }
                });
            }
            // Hooks / dialogs are not supported yet. Reply with an error so the
            // CLI does not hang waiting on us (spec §4.1/§4.6). These are benign and
            // routine, so they're LOGGED (no longer 100% silent) but not surfaced as a
            // thread error — that would be noise, not signal.
            InboundControl::Unknown => {
                eprintln!("[session {}] unsupported inbound control_request (replied with error)", self.id);
                self.send(control::control_error_response(&request_id, "unsupported control request"));
            }
        }
    }

    fn on_command(&mut self, cmd: SessionCommand) {
        match cmd {
            // `controls` is Codex-only (per-turn overrides); the Claude backend pushes
            // each control the moment it changes, so it's ignored here.
            SessionCommand::SendUser { text, images, uuid, .. } => {
                // The uuid was stamped by the caller. It serves two purposes: the
                // `--replay-user-messages` echo of THIS turn is recognised as our own and
                // suppressed (the UI shows it optimistically) — a remote turn carries a
                // uuid we never recorded, so it surfaces live — and it is the handle the
                // UI keeps to cancel this specific message while it is still queued.
                if self.send(transport::user_message_with_images(
                    text.clone(),
                    &images,
                    &uuid,
                )) {
                    self.assembler.note_sent_user_message(&uuid);
                    self.sent_on_current_link = true;
                    let ev = self.assembler.set_busy(true);
                    self.emit(ev);
                } else {
                    // The line never reached the (dead) process: say so, instead of
                    // flipping to "busy" for a turn that will never start.
                    self.emit_error_notice("send_failed", json!({
                        "message": "Your message couldn't be delivered to Claude Code: the session closed. Send it again to restart it.",
                    }));
                }
            }
            SessionCommand::AnswerPermission { request_id, decision } => {
                match self.pending.remove(&request_id) {
                    Some(p) => {
                        let line = match decision {
                            PermissionDecision::Allow { updated_input } => control::permission_allow_response(
                                &request_id,
                                &p.tool_use_id,
                                updated_input.unwrap_or(p.input),
                            ),
                            PermissionDecision::Deny { message } => {
                                control::permission_deny_response(&request_id, &p.tool_use_id, &message)
                            }
                        };
                        let delivered = self.send(line);
                        // This prompt is answered, but OTHER prompts may still be
                        // outstanding: the CLI runs permission checks for parallel tool
                        // calls concurrently. Derive the flag from the map instead of
                        // forcing `false`, otherwise answering one of N tells the UI the
                        // agent is free while it is still blocked on the rest.
                        let ev = self.awaiting_permission_event();
                        self.emit(ev);
                        if !delivered {
                            self.emit_error_notice("send_failed", json!({
                                "message": "Your response to the permission prompt couldn't be delivered: the session closed.",
                            }));
                        }
                    }
                    // The prompt is gone (cancelled by the CLI, or already answered), so
                    // the user's click did nothing. Say so in the thread: swallowing it
                    // to stderr leaves them believing they answered something.
                    None => {
                        eprintln!(
                            "[session {}] answer for unknown permission request '{request_id}'",
                            self.id
                        );
                        self.emit_error_notice("permission_error", json!({
                            "message": "That permission prompt is no longer awaiting an answer — Claude Code withdrew it. If it still matters, Claude will ask again.",
                        }));
                    }
                }
            }
            SessionCommand::SetPermissionMode(mode) => {
                // Optimistic for snappy UX (the four reachable modes are never
                // downgraded); the ack then confirms the mode the CLI really applied.
                let ev = self.assembler.set_permission_mode(mode.as_wire());
                self.emit(ev);
                self.send_tracked(PendingControl::SetPermissionMode(mode), |rid| {
                    control::set_permission_mode_request(rid, mode)
                });
            }
            SessionCommand::SetModel(model) => {
                // Optimistic (the alias); the get_settings read-back replaces it with
                // the resolved id and confirms effort/ultracode under the new model.
                let ev = self.assembler.set_model(&model);
                self.emit(ev);
                self.send_tracked(PendingControl::SetModel, |rid| {
                    control::set_model_request(rid, &model)
                });
                self.refresh_settings();
            }
            SessionCommand::SetEffortLevel(level) => {
                // Selecting a plain level always clears ultracode first (mirrors the
                // extension), then sets the level. get_settings reads the truth back.
                self.send_tracked(PendingControl::SetUltracode, |rid| {
                    control::set_ultracode_request(rid, false)
                });
                self.send_tracked(PendingControl::SetEffort, |rid| {
                    control::set_effort_level_request(rid, &level)
                });
                // Optimistic (snappy chip) WITHOUT announcing — the timeline line is
                // emitted by the get_settings read-back below, i.e. the confirmed value.
                let ev = self.assembler.set_effort_optimistic(Some(level), false);
                self.emit(ev);
                self.refresh_settings();
            }
            SessionCommand::EnableUltracode => {
                // Ultracode = effortLevel xhigh + the separate ultracode flag, in
                // that order (the extension's sequence).
                self.send_tracked(PendingControl::SetEffort, |rid| {
                    control::set_effort_level_request(rid, "xhigh")
                });
                self.send_tracked(PendingControl::SetUltracode, |rid| {
                    control::set_ultracode_request(rid, true)
                });
                let ev = self
                    .assembler
                    .set_effort_optimistic(Some("xhigh".to_string()), true);
                self.emit(ev);
                self.refresh_settings();
            }
            SessionCommand::GenerateTitle { description, seq } => {
                // Fire-and-correlate: the ack carries the title, emitted as
                // SessionEvent::Title with this `seq` (see on_control_response). No
                // optimistic state — the UI already shows a placeholder it will replace.
                self.send_tracked(PendingControl::GenerateTitle(seq), |rid| {
                    control::generate_session_title_request(rid, &description)
                });
            }
            SessionCommand::GenerateSummary { text, seq } => {
                // Same wire as GenerateTitle, fed ONLY the last message; the ack carries
                // the summary, emitted as SessionEvent::Summary with this `seq` (see
                // on_control_response). No optimistic state — the UI shows a truncation
                // it will replace.
                self.send_tracked(PendingControl::GenerateSummary(seq), |rid| {
                    control::generate_summary_request(rid, &text)
                });
            }
            SessionCommand::Interrupt => {
                self.send_tracked(PendingControl::Interrupt, control::interrupt_request);
            }
            SessionCommand::StopTask(task_id) => {
                // Fire-and-correlate: the CLI kills the background task and replies with
                // a bare success; the task then settles to `stopped` via its normal
                // `task_*` lifecycle (no optimistic state here). A rejection surfaces as
                // a control error (the user must know the task is still alive).
                self.send_tracked(PendingControl::StopTask, |rid| {
                    control::stop_task_request(rid, &task_id)
                });
            }
            SessionCommand::McpStatus(reply) => {
                let rid = self.next_request_id();
                // Only park the reply if the line actually went out. If the outbound
                // channel is closed (process gone, not yet observed), dropping `reply`
                // here resolves the caller's oneshot to `Err` immediately, so it returns
                // `SessionError::Closed` at once instead of blocking the full 15s timeout
                // on a request that can never be acked — same guard as `send_tracked`.
                if self.send(control::mcp_status_request(&rid)) {
                    self.pending_mcp.insert(rid, reply);
                }
            }
            // Live MCP actions — fire-and-correlate: the bare-success ack is a no-op
            // (the UI re-polls `mcp_status`), a rejection surfaces as a control error.
            SessionCommand::McpToggle { server_name, enabled } => {
                self.send_tracked(PendingControl::McpToggle, |rid| {
                    control::mcp_toggle_request(rid, &server_name, enabled)
                });
            }
            SessionCommand::McpReconnect { server_name } => {
                self.send_tracked(PendingControl::McpReconnect, |rid| {
                    control::mcp_reconnect_request(rid, &server_name)
                });
            }
            SessionCommand::McpClearAuth { server_name } => {
                self.send_tracked(PendingControl::McpClearAuth, |rid| {
                    control::mcp_clear_auth_request(rid, &server_name)
                });
            }
            SessionCommand::ControlQuery { request_for, request, reply } => {
                let rid = self.next_request_id();
                // Same closed-channel guard as McpStatus: drop `reply` on a failed send so
                // the caller returns at once instead of waiting out the full timeout on a
                // request that can never be acked.
                let mut line = request;
                line["request_id"] = json!(rid.clone());
                if self.send(line) {
                    self.pending_query.insert(rid, reply);
                } else {
                    eprintln!("[session {}] {request_for} not sent (outbound closed)", self.id);
                }
            }
            SessionCommand::McpAuthenticate { server_name, reply } => {
                let rid = self.next_request_id();
                // Same closed-channel guard as McpStatus: drop `reply` on a failed send
                // so the caller returns at once instead of blocking the full 30s timeout.
                if self.send(control::mcp_authenticate_request(&rid, &server_name)) {
                    self.pending_mcp_auth.insert(rid, reply);
                }
            }
            SessionCommand::SetRemoteControl { enabled, name, reply } => {
                let rid = self.next_request_id();
                // Same closed-channel guard: drop `reply` on a failed send so the caller
                // returns at once (SessionError::Closed) instead of blocking the timeout.
                if self.send(control::remote_control_request(&rid, enabled, name.as_deref())) {
                    self.pending_remote_control.insert(rid, (enabled, reply));
                }
            }
            SessionCommand::ReloadPlugins => {
                // Fire-and-correlate: the bare-success ack is a no-op (the reloaded
                // plugins take effect for the next turn); a rejection surfaces as a
                // control error so the user knows the update wasn't hot-applied.
                self.send_tracked(PendingControl::ReloadPlugins, control::reload_plugins_request);
            }
            SessionCommand::SetAutoAllow(tools) => {
                self.auto_allow = tools.into_iter().collect();
            }
            // Codex-only: Claude compacts via the `/compact` text command (a normal
            // slash-command turn the composer sends directly), so there's nothing to do
            // on the control channel here.
            SessionCommand::Compact => {}
            // Shutdown is handled in the run loop (breaks before reaching here).
            SessionCommand::Shutdown { .. } => {}
        }
    }
}

/// Human-readable summary of how the `claude` process exited (the `message` of a
/// `process_exited` notice). The raw exit code / signal go in the detail.
fn describe_exit(status: Option<ExitStatus>) -> String {
    let Some(status) = status else {
        return "The Claude Code process stopped unexpectedly.".to_string();
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return format!("The Claude Code process was interrupted by a signal ({sig}).");
        }
    }
    match status.code() {
        Some(0) | None => "The Claude Code process stopped unexpectedly.".to_string(),
        Some(code) => format!("The Claude Code process exited (code {code})."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::{ConversationItem, PermissionRequestPayload, SessionStatePayload};
    use serde_json::json;

    /// Serialises tests that mutate the process-wide `TOSSE_SSH_BIN` env var —
    /// the SAME crate-wide lock `transport::tests` uses for its own direct
    /// `push_remote_title`/`run_remote_stop` tests (see
    /// [`transport::SSH_ENV_LOCK`]'s doc for why this must be ONE shared lock
    /// rather than a second independent one: two different modules' tests
    /// mutating the SAME real env var need to serialise against EACH OTHER,
    /// not just against their own module).
    use transport::SSH_ENV_LOCK as ENV_LOCK;

    /// Test sink: forwards every event onto a channel for assertions.
    struct ChannelEmitter {
        tx: mpsc::UnboundedSender<SessionEvent>,
    }

    impl SessionEmitter for ChannelEmitter {
        fn emit_state(&self, _session: &str, state: &SessionStatePayload) {
            let _ = self.tx.send(SessionEvent::State(state.clone()));
        }
        fn emit_item(&self, _session: &str, item: &ConversationItem) {
            let _ = self.tx.send(SessionEvent::Item(item.clone()));
        }
        fn emit_permission(&self, _session: &str, request: &PermissionRequestPayload) {
            let _ = self.tx.send(SessionEvent::Permission(request.clone()));
        }
        fn emit_permission_resolved(
            &self,
            _session: &str,
            resolved: &crate::supervisor::model::PermissionResolvedPayload,
        ) {
            let _ = self.tx.send(SessionEvent::PermissionResolved(resolved.clone()));
        }
        fn emit_commands(&self, _session: &str, commands: &[crate::supervisor::model::SlashCommand]) {
            let _ = self.tx.send(SessionEvent::Commands(commands.to_vec()));
        }
        fn emit_task(&self, _session: &str, task: &crate::supervisor::model::BackgroundTask) {
            let _ = self.tx.send(SessionEvent::Task(task.clone()));
        }
        fn emit_title(&self, _session: &str, title: &str, seq: u32) {
            let _ = self.tx.send(SessionEvent::Title { title: title.to_string(), seq });
        }
        fn emit_summary(&self, _session: &str, summary: &str, seq: u32) {
            let _ = self.tx.send(SessionEvent::Summary { summary: summary.to_string(), seq });
        }
        fn emit_remote_control(&self, _session: &str, state: &RemoteControlState) {
            let _ = self.tx.send(SessionEvent::RemoteControl(state.clone()));
        }
        fn emit_codex_plan_usage(&self, _session: &str, _usage: &crate::usage::PlanUsage) {
            // Codex-only push; the Claude core never emits it.
        }
        fn emit_preferred_host(&self, _session: &str, machine_id: &str, host: &str) {
            let _ = self.tx.send(SessionEvent::PreferredHostChanged {
                machine_id: machine_id.to_string(),
                host: host.to_string(),
            });
        }
    }

    /// Build a `SessionCore` wired to two inspectable channels (events, outbound).
    fn test_core() -> (
        SessionCore,
        mpsc::UnboundedReceiver<SessionEvent>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let core = SessionCore::new(
            "s".to_string(),
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            out_tx,
            None,
        );
        (core, event_rx, out_rx)
    }

    fn lost_message_notices(events: &mut mpsc::UnboundedReceiver<SessionEvent>) -> usize {
        drain(events)
            .into_iter()
            .filter(|e| format!("{e:?}").contains("has no turn running"))
            .count()
    }

    /// First real remote conversation (19/09): the first message of a fresh
    /// conversation is written on the same link, right behind the daemon's
    /// `fd_attach{busy:false}` — not a lost message.
    #[test]
    fn a_message_sent_on_the_current_link_is_not_reported_lost_by_the_attach() {
        let (mut core, mut events, _out) = test_core();
        core.on_command(SessionCommand::SendUser { text: "hi".into(), images: Vec::new(), controls: None, uuid: "u1".into() });
        drain(&mut events);
        core.sync_remote_busy(false);
        assert_eq!(lost_message_notices(&mut events), 0);
        assert!(core.assembler.state().busy, "the turn is still expected");
    }

    /// The case the notice exists for: a message written on a link that then died,
    /// reattached (new link) to a daemon with no turn running.
    #[test]
    fn a_message_sent_before_a_reconnect_is_reported_lost_when_the_daemon_is_idle() {
        let (mut core, mut events, _out) = test_core();
        core.on_command(SessionCommand::SendUser { text: "hi".into(), images: Vec::new(), controls: None, uuid: "u1".into() });
        let (new_tx, _new_rx) = mpsc::unbounded_channel();
        core.set_outbound(new_tx);
        drain(&mut events);
        core.sync_remote_busy(false);
        assert_eq!(lost_message_notices(&mut events), 1);
        assert!(!core.assembler.state().busy);
    }

    /// Find the first outbound control_request with the given subtype.
    fn find_req<'a>(lines: &'a [Value], subtype: &str) -> Option<&'a Value> {
        lines.iter().find(|l| l["request"]["subtype"] == json!(subtype))
    }

    fn drain<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> Vec<T> {
        let mut v = Vec::new();
        while let Ok(item) = rx.try_recv() {
            v.push(item);
        }
        v
    }

    fn can_use_tool(request_id: &str, tool: &str) -> CliMessage {
        serde_json::from_value(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "can_use_tool",
                "tool_name": tool,
                "input": { "command": "echo hi" },
                "tool_use_id": "toolu_1"
            }
        }))
        .unwrap()
    }

    /// ACCEPTANCE (deterministic): an inbound `can_use_tool` surfaces a permission
    /// event, and answering DENY writes the correct doubly-nested control_response.
    #[test]
    fn permission_prompt_can_be_denied() {
        let (mut core, mut events, mut out) = test_core();

        core.on_message(can_use_tool("req-1", "Bash"));

        let perm = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Permission(p) => Some(p),
                _ => None,
            })
            .expect("a permission event should be emitted");
        assert_eq!(perm.request_id, "req-1");
        assert_eq!(perm.tool_name, "Bash");
        assert_eq!(perm.tool_use_id, "toolu_1");

        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-1".to_string(),
            decision: PermissionDecision::Deny { message: "no".to_string() },
        });

        let line = drain(&mut out)
            .into_iter()
            .find(|l| l["type"] == json!("control_response"))
            .expect("a control_response should be written");
        assert_eq!(line["response"]["subtype"], json!("success"));
        assert_eq!(line["response"]["request_id"], json!("req-1"));
        assert_eq!(line["response"]["response"]["behavior"], json!("deny"));
        assert_eq!(line["response"]["response"]["message"], json!("no"));
        assert_eq!(line["response"]["response"]["toolUseID"], json!("toolu_1"));
    }

    /// Flight Deck's own "Allow" beats a settings-file `ask` rule: that prompt is answered
    /// for the user (no card) — but never one the mode / classifier raised, a consent step
    /// the tool itself demands, or a tool Flight Deck doesn't allow.
    #[test]
    fn a_settings_file_ask_is_answered_for_a_tool_flight_deck_allows() {
        let tool = "mcp__claude_ai_Gmail__send_message";
        let prompt = |rid: &str, reason: &str, needs_human: bool| -> CliMessage {
            serde_json::from_value(json!({
                "type": "control_request",
                "request_id": rid,
                "request": {
                    "subtype": "can_use_tool", "tool_name": tool, "input": { "to": "x" },
                    "tool_use_id": "toolu_1", "decision_reason_type": reason,
                    "requires_user_interaction": needs_human
                }
            }))
            .unwrap()
        };
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetAutoAllow(vec![tool.to_string()]));

        core.on_message(prompt("r1", "rule", false));
        let answered = drain(&mut out);
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0]["response"]["request_id"], json!("r1"));
        assert_eq!(answered[0]["response"]["response"]["behavior"], json!("allow"));
        assert!(!drain(&mut events).iter().any(|e| matches!(e, SessionEvent::Permission(_))));

        for (rid, reason, human) in [("r2", "mode", false), ("r3", "rule", true)] {
            core.on_message(prompt(rid, reason, human));
            assert!(drain(&mut out).is_empty(), "{rid}: must reach the user");
            assert!(drain(&mut events).iter().any(|e| matches!(e, SessionEvent::Permission(_))));
        }
        core.on_command(SessionCommand::SetAutoAllow(vec![]));
        core.on_message(prompt("r4", "rule", false));
        assert!(drain(&mut out).is_empty(), "no longer allowed: the user decides");
    }

    /// Build a `SessionCore` that HOSTS the app-control MCP server (a fresh hub).
    fn test_core_with_hub() -> (
        SessionCore,
        Arc<crate::appmcp::ControlHub>,
        mpsc::UnboundedReceiver<SessionEvent>,
        mpsc::UnboundedReceiver<Value>,
    ) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let hub = Arc::new(crate::appmcp::ControlHub::new());
        let core = SessionCore::new(
            "session-9".to_string(),
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            out_tx,
            Some(hub.clone()),
        );
        (core, hub, event_rx, out_rx)
    }

    fn mcp_message(request_id: &str, server: &str, message: Value) -> CliMessage {
        serde_json::from_value(json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "mcp_message", "server_name": server, "message": message }
        }))
        .unwrap()
    }

    /// ACCEPTANCE: with the hub attached, `initialize` advertises the flightdeck
    /// SDK MCP server; without it the field is absent (wire parity with the
    /// pre-MCP client).
    #[test]
    fn initialize_advertises_the_sdk_server_only_with_a_hub() {
        let (mut core, _hub, _events, mut out) = test_core_with_hub();
        core.initialize();
        let lines = drain(&mut out);
        let init = find_req(&lines, "initialize").expect("initialize sent");
        assert_eq!(init["request"]["sdkMcpServers"], json!(["flightdeck"]));

        let (mut core, _events, mut out) = test_core();
        core.initialize();
        let lines = drain(&mut out);
        let init = find_req(&lines, "initialize").expect("initialize sent");
        assert!(init["request"].get("sdkMcpServers").is_none());
    }

    /// ACCEPTANCE: an inbound `mcp_message` tools/list is answered on the wire as
    /// a success control_response carrying `{mcp_response}` — without blocking the
    /// actor (the handler runs on a spawned task).
    #[tokio::test]
    async fn mcp_message_tools_list_round_trips() {
        let (mut core, _hub, _events, mut out) = test_core_with_hub();
        core.on_message(mcp_message(
            "mcp-req-1",
            "flightdeck",
            json!({ "jsonrpc": "2.0", "id": 42, "method": "tools/list" }),
        ));
        // The reply arrives from the spawned task; await it (bounded).
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), out.recv())
            .await
            .expect("a reply within 5s")
            .expect("channel alive");
        assert_eq!(line["type"], json!("control_response"));
        assert_eq!(line["response"]["subtype"], json!("success"));
        assert_eq!(line["response"]["request_id"], json!("mcp-req-1"));
        let mcp = &line["response"]["response"]["mcp_response"];
        assert_eq!(mcp["id"], json!(42));
        let tools = mcp["result"]["tools"].as_array().expect("tools array");
        assert!(tools.iter().any(|t| t["name"] == json!("open_file")));
    }

    /// A NOTIFICATION (no id) still gets the `{result:{}, id:0}` ack the CLI's
    /// SDK transport expects — never silence (the CLI would hang on the request).
    #[tokio::test]
    async fn mcp_notification_is_acked() {
        let (mut core, _hub, _events, mut out) = test_core_with_hub();
        core.on_message(mcp_message(
            "mcp-req-2",
            "flightdeck",
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        ));
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), out.recv())
            .await
            .expect("a reply within 5s")
            .expect("channel alive");
        assert_eq!(line["response"]["request_id"], json!("mcp-req-2"));
        assert_eq!(
            line["response"]["response"]["mcp_response"],
            json!({ "jsonrpc": "2.0", "result": {}, "id": 0 })
        );
    }

    /// REGRESSION (spec §4.6): an `mcp_message` for a server we do NOT host — or
    /// arriving on a session spawned without the hub — answers the standard
    /// "SDK MCP server not found" error instead of hanging the CLI.
    #[test]
    fn mcp_message_without_a_matching_server_errors() {
        // Hub attached, wrong server name.
        let (mut core, _hub, _events, mut out) = test_core_with_hub();
        core.on_message(mcp_message("mcp-req-3", "elsewhere", json!({"id": 1, "method": "ping"})));
        let line = drain(&mut out).pop().expect("an error reply");
        assert_eq!(line["response"]["subtype"], json!("error"));
        assert_eq!(
            line["response"]["error"],
            json!("SDK MCP server not found: elsewhere")
        );
        // No hub at all (toggle off): same contract.
        let (mut core, _events, mut out) = test_core();
        core.on_message(mcp_message("mcp-req-4", "flightdeck", json!({"id": 1, "method": "ping"})));
        let line = drain(&mut out).pop().expect("an error reply");
        assert_eq!(line["response"]["subtype"], json!("error"));
    }

    /// REGRESSION: the CLI checks permissions for parallel tool calls concurrently,
    /// so several prompts can be outstanding at once. Answering ONE must not report
    /// the session as free — the flag drives the Flight Deck card, the fleet readout
    /// and the attention ping, so clearing it early makes a still-blocked agent look
    /// idle and suppresses the notification for the prompt left behind.
    #[test]
    fn answering_one_of_two_parallel_prompts_keeps_awaiting_permission() {
        let (mut core, mut events, _out) = test_core();

        core.on_message(can_use_tool("req-1", "Bash"));
        core.on_message(can_use_tool("req-2", "Read"));
        let _ = drain(&mut events);

        // Answer only the first: the second is still blocking the agent.
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-1".to_string(),
            decision: PermissionDecision::Allow { updated_input: None },
        });
        let awaiting = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::State(s) => Some(s.awaiting_permission),
                _ => None,
            })
            .next_back()
            .expect("answering should emit a state event");
        assert!(
            awaiting,
            "one prompt is still pending — the session is NOT free"
        );

        // Answering the last one finally clears it.
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-2".to_string(),
            decision: PermissionDecision::Allow { updated_input: None },
        });
        let awaiting = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::State(s) => Some(s.awaiting_permission),
                _ => None,
            })
            .next_back()
            .expect("answering should emit a state event");
        assert!(!awaiting, "no prompt left — the session is free again");
    }

    /// REGRESSION: a withdrawn prompt must be retracted from the UI. The front prunes
    /// `pendingPermissions` only when the USER answers, so without this event the
    /// card stays on screen, clickable, and answering it does nothing.
    #[test]
    fn a_cancelled_prompt_is_retracted_and_answering_it_is_surfaced() {
        let (mut core, mut events, _out) = test_core();

        core.on_message(can_use_tool("req-1", "Bash"));
        let _ = drain(&mut events);

        core.on_message(CliMessage::ControlCancelRequest {
            request_id: "req-1".to_string(),
        });
        let evs = drain(&mut events);
        assert!(
            evs.iter().any(|e| matches!(
                e,
                SessionEvent::PermissionResolved(r) if r.request_id == "req-1"
            )),
            "the cancelled prompt must be retracted from the UI"
        );

        // Answering the now-gone prompt must not be swallowed to stderr.
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-1".to_string(),
            decision: PermissionDecision::Allow { updated_input: None },
        });
        let notice = drain(&mut events).into_iter().any(|e| {
            matches!(
                e,
                SessionEvent::Item(ConversationItem::Notice { ref subtype, .. })
                    if subtype == "permission_error"
            )
        });
        assert!(
            notice,
            "answering a withdrawn prompt must say so in the thread"
        );
    }

    /// ACCEPTANCE (deterministic): answering ALLOW echoes the original tool input
    /// in `updatedInput` when no rewrite is supplied.
    #[test]
    fn permission_prompt_can_be_allowed_echoing_input() {
        let (mut core, _events, mut out) = test_core();

        core.on_message(can_use_tool("req-2", "Read"));
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "req-2".to_string(),
            decision: PermissionDecision::Allow { updated_input: None },
        });

        let line = drain(&mut out)
            .into_iter()
            .find(|l| l["type"] == json!("control_response"))
            .expect("a control_response should be written");
        assert_eq!(line["response"]["response"]["behavior"], json!("allow"));
        assert_eq!(line["response"]["response"]["updatedInput"], json!({ "command": "echo hi" }));
        assert_eq!(line["response"]["response"]["toolUseID"], json!("toolu_1"));
    }

    #[test]
    fn answering_an_unknown_permission_is_a_no_op() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::AnswerPermission {
            request_id: "ghost".to_string(),
            decision: PermissionDecision::Deny { message: "x".to_string() },
        });
        assert!(drain(&mut out).is_empty(), "no control_response for an unknown request");
    }

    /// REGRESSION (silent error): a user message that can't be delivered because the
    /// session is gone (writer channel closed) must surface a `send_failed` notice —
    /// not silently flip to "busy" for a turn that will never start.
    #[test]
    fn send_user_text_on_a_dead_session_surfaces_a_notice() {
        let (mut core, mut events, out) = test_core();
        drop(out); // the process is gone: the outbound channel is closed
        core.on_command(SessionCommand::SendUser { text: "hello".to_string(), images: Vec::new(), controls: None, uuid: "u-test".to_string() });
        let notice = drain(&mut events).into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::Notice { subtype, .. }) => Some(subtype),
            _ => None,
        });
        assert_eq!(notice.as_deref(), Some("send_failed"));
    }

    /// REGRESSION (silent error): a malformed `can_use_tool` (missing the required
    /// `tool_use_id`) must STILL answer the CLI (anti-hang) AND surface a
    /// `protocol_error` notice — the user otherwise never sees the prompt and gets no
    /// hint why a tool didn't run.
    #[test]
    fn malformed_can_use_tool_answers_cli_and_surfaces_a_notice() {
        let (mut core, mut events, mut out) = test_core();
        let msg: CliMessage = serde_json::from_value(json!({
            "type": "control_request",
            "request_id": "req-bad",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash" }
        }))
        .unwrap();
        core.on_message(msg);
        // Anti-hang: an error control_response still goes out to the CLI.
        assert!(
            drain(&mut out).iter().any(|l| l["type"] == json!("control_response")),
            "a malformed control_request must still be answered"
        );
        // And the failure is visible in the thread.
        let found = drain(&mut events).into_iter().any(|e| matches!(
            e,
            SessionEvent::Item(ConversationItem::Notice { subtype, .. }) if subtype == "protocol_error"
        ));
        assert!(found, "a malformed can_use_tool must surface a protocol_error notice");
    }

    /// REGRESSION (silent error): a `set_permission_mode` ack that succeeds but
    /// carries NO echoed `mode` must still announce the confirmed transition,
    /// falling back to the requested mode — the timeline notice must never vanish.
    #[test]
    fn set_permission_mode_announces_even_when_ack_omits_mode() {
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let (out_tx, mut out) = mpsc::unbounded_channel();
        let mut core = SessionCore::new(
            "s".to_string(),
            InitialControls {
                permission_mode: Some("auto".to_string()),
                ..InitialControls::default()
            },
            Arc::new(ChannelEmitter { tx: event_tx }),
            out_tx,
            None,
        );

        core.on_command(SessionCommand::SetPermissionMode(PermissionMode::Plan));

        // The request_id of the outbound set_permission_mode we must ack.
        let sent = drain(&mut out);
        let rid = find_req(&sent, "set_permission_mode")
            .expect("a set_permission_mode request")["request_id"]
            .as_str()
            .expect("request_id")
            .to_string();

        // The CLI acks success but WITHOUT echoing a `mode` field.
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": rid }
            }))
            .unwrap(),
        );

        let detail = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Item(ConversationItem::Notice { subtype, detail })
                    if subtype == "control_change" =>
                {
                    Some(detail)
                }
                _ => None,
            })
            .expect("a permission control_change notice should be emitted");
        assert_eq!(detail["control"], json!("Permission mode"));
        assert_eq!(detail["from"], json!("Auto mode"));
        assert_eq!(detail["to"], json!("Plan mode"));
    }

    #[test]
    fn initialize_is_sent_first_then_reads_settings_back() {
        let (mut core, _events, mut out) = test_core();
        core.initialize();
        let lines = drain(&mut out);
        // initialize first, then a get_settings read-back (no ultracode to restore
        // with the default InitialControls).
        assert_eq!(lines[0]["type"], json!("control_request"));
        assert_eq!(lines[0]["request"]["subtype"], json!("initialize"));
        assert!(
            find_req(&lines, "get_settings").is_some(),
            "init should also read the live settings back"
        );
        assert!(
            find_req(&lines, "apply_flag_settings").is_none(),
            "no ultracode restore when it wasn't enabled"
        );
    }

    /// A get_settings ack updates the live state with the applied effort + ultracode
    /// (the model id is the resolved one) — the read-back source of truth.
    #[test]
    fn get_settings_ack_applies_live_settings() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetEffortLevel("high".to_string()));
        // The get_settings request id is whatever was allocated last; find it.
        let gid = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("get_settings"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("a get_settings request should be sent");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": gid,
                    "response": { "applied": { "model": "claude-opus-4-8", "effort": "high", "ultracode": false } }
                }
            }))
            .unwrap(),
        );
        let last_state = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::State(s) => Some(s),
                _ => None,
            })
            .last()
            .expect("a state event");
        assert_eq!(last_state.effort.as_deref(), Some("high"));
        assert!(!last_state.ultracode);
        assert_eq!(last_state.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// Selecting a plain effort level clears ultracode (off) then sets the level,
    /// then reads back — and the optimistic state reflects it immediately.
    #[test]
    fn set_effort_clears_ultracode_then_sets_level() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetEffortLevel("medium".to_string()));
        let lines = drain(&mut out);
        // ultracode:null (off) BEFORE the effortLevel, plus a get_settings read-back.
        let flags: Vec<_> = lines
            .iter()
            .filter(|l| l["request"]["subtype"] == json!("apply_flag_settings"))
            .collect();
        assert_eq!(flags[0]["request"]["settings"]["ultracode"], Value::Null);
        assert_eq!(flags[1]["request"]["settings"]["effortLevel"], json!("medium"));
        assert!(find_req(&lines, "get_settings").is_some());
        let s = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e { SessionEvent::State(s) => Some(s), _ => None })
            .last()
            .unwrap();
        assert_eq!(s.effort.as_deref(), Some("medium"));
        assert!(!s.ultracode);
    }

    /// Enabling ultracode sends xhigh then ultracode:true (in that order).
    #[test]
    fn enable_ultracode_sends_xhigh_then_flag() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::EnableUltracode);
        let lines = drain(&mut out);
        let flags: Vec<_> = lines
            .iter()
            .filter(|l| l["request"]["subtype"] == json!("apply_flag_settings"))
            .collect();
        assert_eq!(flags[0]["request"]["settings"]["effortLevel"], json!("xhigh"));
        assert_eq!(flags[1]["request"]["settings"]["ultracode"], json!(true));
        let s = drain(&mut events)
            .into_iter()
            .filter_map(|e| match e { SessionEvent::State(s) => Some(s), _ => None })
            .last()
            .unwrap();
        assert_eq!(s.effort.as_deref(), Some("xhigh"));
        assert!(s.ultracode);
    }

    /// A rejected control request surfaces a `control_error` notice — never silent.
    #[test]
    fn rejected_control_surfaces_a_notice() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SetModel("bogus".to_string()));
        let sm_id = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("set_model"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("a set_model request");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "error", "request_id": sm_id, "error": "unknown model" }
            }))
            .unwrap(),
        );
        let notice = drain(&mut events).into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => Some((subtype, detail)),
            _ => None,
        });
        let (subtype, detail) = notice.expect("a control_error notice");
        assert_eq!(subtype, "control_error");
        assert_eq!(detail["message"], json!("unknown model"));
    }

    #[test]
    fn send_user_text_writes_a_user_message() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::SendUser { text: "hello".to_string(), images: Vec::new(), controls: None, uuid: "u-test".to_string() });
        let lines = drain(&mut out);
        assert_eq!(lines[0]["type"], json!("user"));
        assert_eq!(lines[0]["message"]["content"][0]["text"], json!("hello"));
        // The turn is stamped with a uuid (so `--replay-user-messages` echo dedup works).
        assert!(lines[0]["uuid"].as_str().is_some_and(|u| !u.is_empty()));
    }

    /// ACCEPTANCE (Remote Control live sync): with `--replay-user-messages`, the CLI
    /// echoes every user turn on stdout. The echo of OUR OWN turn (same uuid we stamped)
    /// must be SUPPRESSED (the UI shows it optimistically), while a REMOTE turn (a uuid
    /// we never sent — typed on the phone) must be SURFACED as a `UserMessage`.
    #[test]
    fn own_user_message_echo_suppressed_remote_surfaced() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::SendUser { text: "hello".to_string(), images: Vec::new(), controls: None, uuid: "u-test".to_string() });
        let uuid = drain(&mut out)[0]["uuid"].as_str().unwrap().to_string();
        let _ = drain(&mut events); // the busy state event from the send

        // The binary replays OUR message back with the uuid we stamped.
        core.on_message(
            serde_json::from_value(json!({
                "type": "user", "uuid": uuid, "isReplay": true,
                "message": { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
            }))
            .unwrap(),
        );
        assert!(
            drain(&mut events).iter().all(|e| !matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { .. })
            )),
            "our own replayed turn must be suppressed"
        );

        // A remote turn (uuid we never sent) IS surfaced.
        core.on_message(
            serde_json::from_value(json!({
                "type": "user", "uuid": "remote-xyz", "isReplay": true,
                "message": { "role": "user", "content": "from the phone" }
            }))
            .unwrap(),
        );
        assert!(
            drain(&mut events).iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { id, text, .. })
                    if id == "remote-xyz" && text == "from the phone"
            )),
            "a remote turn must be surfaced as a UserMessage"
        );
    }

    /// ACCEPTANCE (deterministic): a GenerateTitle command sends a
    /// `generate_session_title` control request carrying the description, and its
    /// success ack (title at `response.response.title`) surfaces a `Title` event.
    #[test]
    fn generate_title_round_trip_emits_title_event() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::GenerateTitle {
            description: "Fix the login bug".to_string(),
            seq: 2,
        });

        let sent = drain(&mut out);
        let req = find_req(&sent, "generate_session_title").expect("a generate_session_title request");
        // The description carries the user's text (verbatim, leading) plus the appended
        // brevity hint (control.rs::TITLE_BREVITY_HINT) — see `generate_session_title_request`.
        let desc = req["request"]["description"].as_str().expect("description is a string");
        assert!(desc.starts_with("Fix the login bug"), "user text leads, got: {desc:?}");
        assert!(desc.contains("at most 5 words"), "brevity hint appended, got: {desc:?}");
        assert_eq!(req["request"]["persist"], json!(false));
        let rid = req["request_id"].as_str().expect("request_id").to_string();

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": rid,
                    "response": { "title": "Login bug" }
                }
            }))
            .unwrap(),
        );

        let title = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                // The emitted Title echoes the seq we sent, so the UI can order applies.
                SessionEvent::Title { title, seq } => Some((title, seq)),
                _ => None,
            })
            .expect("a Title event should be emitted");
        assert_eq!(title, ("Login bug".to_string(), 2));
    }

    /// ACCEPTANCE (deterministic): a GenerateSummary command sends a
    /// `generate_session_title` control request (the shared wire) carrying ONLY the last
    /// message plus the ≤6-word summary hint, and its success ack surfaces a `Summary`
    /// event tagged with the seq we sent.
    #[test]
    fn generate_summary_round_trip_emits_summary_event() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::GenerateSummary {
            text: "Can you fix the login crash please".to_string(),
            seq: 5,
        });

        let sent = drain(&mut out);
        let req = find_req(&sent, "generate_session_title").expect("a generate_session_title request");
        let desc = req["request"]["description"].as_str().expect("description is a string");
        assert!(desc.starts_with("Can you fix the login crash please"), "message leads, got: {desc:?}");
        assert!(desc.contains("at most 6 words"), "summary hint appended, got: {desc:?}");
        assert_eq!(req["request"]["persist"], json!(false));
        let rid = req["request_id"].as_str().expect("request_id").to_string();

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": rid,
                    "response": { "title": "Fix the login crash" }
                }
            }))
            .unwrap(),
        );

        let summary = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Summary { summary, seq } => Some((summary, seq)),
                _ => None,
            })
            .expect("a Summary event should be emitted");
        assert_eq!(summary, ("Fix the login crash".to_string(), 5));
    }

    /// REGRESSION (no noisy error): a REJECTED generate_session_title must NOT
    /// surface a `control_error` notice — it's cosmetic, with a placeholder fallback.
    #[test]
    fn rejected_title_generation_is_silent() {
        let (mut core, mut events, mut out) = test_core();
        core.on_command(SessionCommand::GenerateTitle { description: "whatever".to_string(), seq: 1 });
        let rid = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("generate_session_title"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("a generate_session_title request");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "error", "request_id": rid, "error": "unsupported" }
            }))
            .unwrap(),
        );
        assert!(
            !drain(&mut events).iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::Notice { subtype, .. }) if subtype == "control_error"
            )),
            "a rejected title generation must not surface a control_error notice"
        );
    }

    /// ACCEPTANCE: the `initialize` control_response (matched by its echoed
    /// request_id) is harvested into a single `Commands` event, with the
    /// camelCase `argumentHint` wire key mapped to `argument_hint`.
    #[test]
    fn initialize_response_harvests_slash_commands() {
        let (mut core, mut events, _out) = test_core();
        core.initialize(); // sends "tosse-1" and remembers it

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "tosse-1",
                    "response": {
                        "commands": [
                            { "name": "compact", "description": "Compact the conversation", "argumentHint": "" },
                            { "name": "tosse-workflow:pickup", "description": "Start a task", "argumentHint": "<task_id>" }
                        ],
                        "models": []
                    }
                }
            }))
            .unwrap(),
        );

        let cmds = drain(&mut events)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Commands(c) => Some(c),
                _ => None,
            })
            .expect("a Commands event should be emitted");
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].name, "compact");
        assert_eq!(cmds[1].name, "tosse-workflow:pickup");
        assert_eq!(cmds[1].argument_hint, "<task_id>");

        // A second matching response must NOT re-emit (handshake is one-shot).
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": "tosse-1",
                    "response": { "commands": [{ "name": "x", "description": "", "argumentHint": "" }] } }
            }))
            .unwrap(),
        );
        assert!(
            !drain(&mut events).iter().any(|e| matches!(e, SessionEvent::Commands(_))),
            "the initialize handshake should be consumed exactly once"
        );
    }

    /// ACCEPTANCE (deterministic): an `McpStatus` command writes an `mcp_status`
    /// control request, and the matching `control_response` is parsed and delivered
    /// back over the reply channel (request/response correlation by request_id).
    #[test]
    fn mcp_status_round_trips_request_and_reply() {
        let (mut core, _events, mut out) = test_core();
        let (tx, mut rx) = oneshot::channel();

        core.on_command(SessionCommand::McpStatus(tx));
        let req = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("mcp_status"))
            .expect("an mcp_status control_request should be written");
        let rid = req["request_id"].as_str().expect("request has an id").to_string();

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": rid,
                    "response": { "mcpServers": [
                        { "name": "playwright", "status": "connected", "scope": "user", "tools": [{ "name": "x" }] }
                    ] }
                }
            }))
            .unwrap(),
        );

        let servers = rx
            .try_recv()
            .expect("the reply should be delivered")
            .expect("a success reply yields Ok");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "playwright");
        assert_eq!(servers[0].status, "connected");
        assert_eq!(servers[0].tool_count, 1);
    }

    /// ACCEPTANCE: a REJECTED mcp_status (control_response with ok=false) is delivered
    /// as Err carrying the binary's message — never swallowed into an empty Ok list.
    #[test]
    fn mcp_status_rejection_surfaces_as_error_not_empty() {
        let (mut core, _events, mut out) = test_core();
        let (tx, mut rx) = oneshot::channel();
        core.on_command(SessionCommand::McpStatus(tx));
        let rid = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("mcp_status"))
            .and_then(|l| l["request_id"].as_str().map(str::to_string))
            .expect("an mcp_status request_id");
        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": { "subtype": "error", "request_id": rid, "error": "mcp_status not supported" }
            }))
            .unwrap(),
        );
        let reply = rx.try_recv().expect("the reply should be delivered");
        assert_eq!(reply, Err("mcp_status not supported".to_string()));
    }

    /// ACCEPTANCE: an `McpToggle` command writes an `mcp_toggle` control_request with
    /// the exact wire shape (`serverName` + `enabled`) the binary expects.
    #[test]
    fn mcp_toggle_writes_expected_wire() {
        let (mut core, _events, mut out) = test_core();
        core.on_command(SessionCommand::McpToggle {
            server_name: "qonto".to_string(),
            enabled: false,
        });
        let req = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("mcp_toggle"))
            .expect("an mcp_toggle control_request should be written");
        assert_eq!(req["request"]["serverName"], json!("qonto"));
        assert_eq!(req["request"]["enabled"], json!(false));
    }

    /// ACCEPTANCE: an `McpAuthenticate` command round-trips — the request carries
    /// `serverName`, and the response's `authUrl` / `requiresUserAction` are parsed
    /// back over the reply channel.
    #[test]
    fn mcp_authenticate_round_trips_auth_url() {
        let (mut core, _events, mut out) = test_core();
        let (tx, mut rx) = oneshot::channel();
        core.on_command(SessionCommand::McpAuthenticate {
            server_name: "linear".to_string(),
            reply: tx,
        });
        let req = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("mcp_authenticate"))
            .expect("an mcp_authenticate control_request should be written");
        assert_eq!(req["request"]["serverName"], json!("linear"));
        let rid = req["request_id"].as_str().unwrap().to_string();

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": rid,
                    "response": { "authUrl": "https://auth.example/x", "requiresUserAction": true }
                }
            }))
            .unwrap(),
        );

        let res = rx.try_recv().expect("the auth reply should be delivered");
        assert_eq!(res.auth_url.as_deref(), Some("https://auth.example/x"));
        assert!(res.requires_user_action);
        assert_eq!(res.error, None);
    }

    /// ACCEPTANCE: a `SetRemoteControl{enabled:true}` command round-trips — the request
    /// carries `{subtype:"remote_control", enabled:true}`, and the response's
    /// `session_url` comes back over the reply channel as a `connected` state.
    #[test]
    fn set_remote_control_round_trips_session_url() {
        let (mut core, _events, mut out) = test_core();
        let (tx, mut rx) = oneshot::channel();
        core.on_command(SessionCommand::SetRemoteControl {
            enabled: true,
            name: None,
            reply: tx,
        });
        let req = drain(&mut out)
            .into_iter()
            .find(|l| l["request"]["subtype"] == json!("remote_control"))
            .expect("a remote_control control_request should be written");
        assert_eq!(req["request"]["enabled"], json!(true));
        let rid = req["request_id"].as_str().unwrap().to_string();

        core.on_message(
            serde_json::from_value(json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": rid,
                    "response": { "session_url": "https://claude.ai/code?session=abc" }
                }
            }))
            .unwrap(),
        );

        let state = rx.try_recv().expect("the remote-control reply should be delivered");
        assert_eq!(state.status, "connected");
        assert_eq!(state.session_url.as_deref(), Some("https://claude.ai/code?session=abc"));
    }

    /// LIVE end-to-end: spawn a real `claude`, run a tool to completion. In this
    /// environment the tool is auto-allowed by settings (so no prompt arrives) —
    /// we still validate the full pipeline: tool_result is delivered and the turn
    /// succeeds. If a permission prompt *does* arrive, we allow it (read/echo are
    /// harmless). The precise allow/deny response wiring is covered by the
    /// deterministic tests above.
    ///
    /// Ignored by default (needs the binary, network, auth, quota). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored live_session_runs_a_tool --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn live_session_runs_a_tool_end_to_end() {
        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEvent>();
        let emitter = Arc::new(ChannelEmitter { tx });
        let cwd = std::env::current_dir().unwrap();
        let handle = spawn_session(
            "test".to_string(),
            SpawnConfig::new(cwd),
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
            None,
        )
        .expect("session should spawn");

        handle
            .send_user_text("Use the Bash tool to run: echo tosse-probe. You MUST call the Bash tool.")
            .await
            .expect("send should queue");

        let mut saw_tool_result = false;
        let mut turn_ok = None;

        let drain_loop = async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    SessionEvent::Permission(p) => {
                        handle
                            .answer_permission(p.request_id, PermissionDecision::Allow { updated_input: None })
                            .await
                            .expect("answer should queue");
                    }
                    SessionEvent::Item(ConversationItem::ToolResult { .. }) => saw_tool_result = true,
                    SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) => {
                        turn_ok = Some(!is_error);
                        break;
                    }
                    _ => {}
                }
            }
        };

        tokio::time::timeout(std::time::Duration::from_secs(120), drain_loop)
            .await
            .expect("turn should complete within the deadline");
        handle.shutdown().await.ok();

        assert!(saw_tool_result, "expected a tool_result from the Bash call");
        assert_eq!(turn_ok, Some(true), "expected a successful turn");
    }

    /// LIVE end-to-end for the app-hosted MCP server: spawn a real `claude` that
    /// ADVERTISES `sdkMcpServers: ["flightdeck"]`, ask the model to call
    /// `mcp__flightdeck__whoami`, and assert the whole loop closes: the CLI drives
    /// the MCP handshake over `mcp_message`, our router serves tools/list, the
    /// tools/call reaches the (test) front bridge, and the canned answer comes back
    /// in the assistant's reply.
    ///
    /// Also PROBES the audit's open security question (A5): does an SDK-MCP tool
    /// call go through `can_use_tool`? We spawn in permission mode "default" (so
    /// non-allowlisted tools prompt) and report whether a permission request for
    /// the MCP tool arrived. Finding (claude 2.1.233, 2026-08-17): YES — the MCP
    /// tool triggers `can_use_tool` like any other tool (tool_name
    /// `mcp__flightdeck__whoami`), so the app's permission system gates these
    /// tools for free.
    ///
    /// Ignored by default (needs the binary, network, auth, quota). Run with:
    ///   cargo test --lib -- --ignored live_sdk_mcp_server --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn live_sdk_mcp_server_round_trips() {
        use std::sync::{Mutex, OnceLock};

        /// A front-bridge stand-in that answers every bridged tool call at once
        /// with a canned whoami payload (there is no webview in a live test).
        struct AutoSink {
            hub: OnceLock<Arc<crate::appmcp::ControlHub>>,
            calls: Mutex<Vec<String>>,
        }
        impl crate::appmcp::ToolSink for AutoSink {
            fn request(&self, request_id: &str, tool: &str, _args: &Value, session: Option<&str>) {
                self.calls.lock().unwrap().push(tool.to_string());
                if let Some(hub) = self.hub.get() {
                    hub.respond(
                        request_id,
                        Ok(json!({
                            "conversation_id": "conv-live-probe",
                            "title": "Live probe conversation",
                            "session": session,
                        })),
                    );
                }
            }
        }

        let hub = Arc::new(crate::appmcp::ControlHub::new());
        let sink = Arc::new(AutoSink { hub: OnceLock::new(), calls: Mutex::new(Vec::new()) });
        let _ = sink.hub.set(hub.clone());
        hub.set_sink(sink.clone());

        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEvent>();
        let emitter = Arc::new(ChannelEmitter { tx });
        let cwd = std::env::current_dir().unwrap();
        // "default" permission mode so non-allowlisted tools PROMPT — that is what
        // makes the A5 probe conclusive (mode "auto" could auto-allow silently).
        let mut cfg = SpawnConfig::new(cwd);
        cfg.permission_mode = Some("default".to_string());
        let handle = spawn_session(
            "test-mcp".to_string(),
            cfg,
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
            Some(hub.clone()),
        )
        .expect("session should spawn");

        handle
            .send_user_text(
                "Call the MCP tool mcp__flightdeck__whoami (from the flightdeck MCP server), \
                 then reply with EXACTLY the conversation_id value it returned and nothing else. \
                 You MUST call that tool. Do not use any other tool.",
            )
            .await
            .expect("send should queue");

        let mut mcp_permission_prompted = false;
        let mut final_text = String::new();
        let mut turn_ok = None;

        let drain_loop = async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    SessionEvent::Permission(p) => {
                        // The A5 probe: did the MCP tool route through can_use_tool?
                        if p.tool_name.contains("flightdeck") {
                            mcp_permission_prompted = true;
                        }
                        handle
                            .answer_permission(
                                p.request_id,
                                PermissionDecision::Allow { updated_input: None },
                            )
                            .await
                            .expect("answer should queue");
                    }
                    SessionEvent::Item(ConversationItem::AssistantMessage { blocks, .. }) => {
                        for b in &blocks {
                            if let crate::supervisor::model::NormalizedBlock::Text { text } = b {
                                final_text.push_str(text);
                            }
                        }
                    }
                    SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) => {
                        turn_ok = Some(!is_error);
                        break;
                    }
                    _ => {}
                }
            }
        };

        tokio::time::timeout(std::time::Duration::from_secs(180), drain_loop)
            .await
            .expect("turn should complete within the deadline");
        handle.shutdown().await.ok();

        let calls = sink.calls.lock().unwrap().clone();
        eprintln!("[live] bridged tool calls: {calls:?}");
        eprintln!("[live] can_use_tool fired for the MCP tool: {mcp_permission_prompted}");
        eprintln!("[live] final assistant text: {final_text:?}");

        assert_eq!(turn_ok, Some(true), "expected a successful turn");
        assert!(
            calls.iter().any(|t| t == "whoami"),
            "the whoami tools/call should reach the front bridge (got {calls:?})"
        );
        assert!(
            final_text.contains("conv-live-probe"),
            "the model should echo the canned conversation_id"
        );
    }

    /// LIVE: the whole feature hinges on the binary supporting the
    /// `generate_session_title` control request. Spawn a real `claude`, ask it to
    /// title a description, and assert a non-empty `Title` event comes back. No user
    /// turn is needed — the binary titles from the `description` string itself
    /// (exactly how the VS Code extension calls it).
    ///
    /// Ignored by default (needs the binary, network, auth, quota). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored live_generate_session_title --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn live_generate_session_title_returns_a_title() {
        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEvent>();
        let emitter = Arc::new(ChannelEmitter { tx });
        let cwd = std::env::current_dir().unwrap();
        let handle = spawn_session(
            "test-title".to_string(),
            SpawnConfig::new(cwd),
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
            None,
        )
        .expect("session should spawn");

        handle
            .generate_title(
                "Help me fix the connection bug on the login page".to_string(),
                1,
            )
            .await
            .expect("generate_title should queue");

        let title = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while let Some(ev) = rx.recv().await {
                if let SessionEvent::Title { title, .. } = ev {
                    return Some(title);
                }
            }
            None
        })
        .await
        .expect("a Title event should arrive within the deadline");

        handle.shutdown().await.ok();
        let title = title.expect("the stream closed before a Title event arrived");
        let words = title.split_whitespace().count();
        eprintln!("[live] generated title: {title:?} ({words} words, {} chars)", title.chars().count());
        assert!(!title.trim().is_empty(), "the generated title should be non-empty");
        // The brevity hint (control.rs::TITLE_BREVITY_HINT) asks for ≤5 words; allow a
        // little slack but flag a hint that's being ignored or echoed back as prose.
        assert!(
            words <= 8,
            "the brevity hint should keep the title short, got {words} words: {title:?}"
        );
        assert!(
            !title.to_lowercase().contains("title"),
            "the title must not echo the brevity instruction, got: {title:?}"
        );
    }

    /// LIVE end-to-end for the BACKGROUND-TASK socle: spawn a real `claude`, ask it
    /// to run a `Bash` command with `run_in_background:true`, and prove the whole new
    /// pipeline works against the real binary —
    ///   1. the `task_*` lifecycle is INGESTED (it used to drop to `SystemMsg::Unknown`):
    ///      we receive normalized [`SessionEvent::Task`] events,
    ///   2. the producer is CLASSIFIED as [`BackgroundTaskKind::Bash`],
    ///   3. the task reaches a terminal status with an `output_file`, and
    ///   4. the DISK READER ([`super::subagents::read_task_output_file`]) reads it back
    ///      from the absolute `output_file` path the wire carried.
    ///
    /// Ignored by default (needs the binary, network, auth, quota). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored live_background_task --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn live_background_task_is_ingested_and_readable() {
        use crate::supervisor::model::BackgroundTaskKind;

        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEvent>();
        let emitter = Arc::new(ChannelEmitter { tx });
        let cwd = std::env::current_dir().unwrap();
        let handle = spawn_session(
            "test-bg".to_string(),
            SpawnConfig::new(cwd),
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
            None,
        )
        .expect("session should spawn");

        handle
            .send_user_text(
                "Use the Bash tool to run this command IN THE BACKGROUND \
                 (set run_in_background to true): `sleep 3; echo tosse-bg-done`. \
                 Do NOT run it in the foreground. You MUST call the Bash tool with \
                 run_in_background true.",
            )
            .await
            .expect("send should queue");

        let mut bg_task: Option<crate::supervisor::model::BackgroundTask> = None;

        let drain_loop = async {
            while let Some(ev) = rx.recv().await {
                match ev {
                    SessionEvent::Permission(p) => {
                        // Auto-allow (the background command is harmless).
                        handle
                            .answer_permission(p.request_id, PermissionDecision::Allow { updated_input: None })
                            .await
                            .ok();
                    }
                    SessionEvent::Task(t) => {
                        // Keep the latest snapshot of our background Bash task. The
                        // lifecycle is task_started → task_updated{completed} →
                        // task_notification{output_file,summary}, so we wait for the
                        // NOTIFICATION (the richest, final snapshot) before stopping —
                        // breaking on the earlier task_updated would miss output_file.
                        if t.kind == BackgroundTaskKind::Bash {
                            let got_notification = t.output_file.is_some() || t.summary.is_some();
                            bg_task = Some(t);
                            if got_notification {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        };

        tokio::time::timeout(std::time::Duration::from_secs(120), drain_loop)
            .await
            .expect("a background task should be ingested within the deadline");
        handle.shutdown().await.ok();

        let task = bg_task.expect("a SessionEvent::Task with kind Bash should be emitted");
        eprintln!("[live] ingested background task: {task:#?}");
        assert_eq!(task.kind, BackgroundTaskKind::Bash);

        // The disk reader reads the task's output back from the ABSOLUTE path the CLI
        // reported on the wire (the CLI writes background output to a temp dir, not the
        // session dir, so this echoed `output_file` is the only reliable source).
        let output_file = task.output_file.expect("a finished background task carries an output_file");
        let out = crate::supervisor::subagents::read_task_output_file(&output_file)
            .expect("output file should be readable via the absolute path");
        eprintln!("[live] read_task_output_file {output_file}:\n{out}");
        assert!(out.contains("tosse-bg-done"), "output file should hold the echo");
    }

    /// Table-driven: every named reason (the daemon-sent `FdDetach` ones plus
    /// the locally-synthesized `"daemon_missing"`) plus one truly unknown
    /// reason, asserting the EXACT (message, terminal, narrated) triple — the
    /// shared table `run_actor` wires the inline reason match (AND its final
    /// exit-explain `deliberate_exit` check) into. `"stalled"` must be the
    /// only reconnect-eligible (non-terminal) entry; every other NAMED reason
    /// (including `"stopped"`, whose own message is `None`) is already
    /// narrated; only the truly unknown wildcard is not.
    #[test]
    fn reconnect_policy_covers_every_reason() {
        assert_eq!(
            reconnect_policy_for_reason("exited", Some(1), None),
            (Some("The remote session exited (code 1).".to_string()), true, true),
        );
        assert_eq!(
            reconnect_policy_for_reason("exited", None, None),
            (Some("The remote session exited.".to_string()), true, true),
            "a missing exit_code must not be treated as code 0",
        );
        assert_eq!(
            reconnect_policy_for_reason("replaced", None, None),
            (
                Some("Another client took over this remote session.".to_string()),
                true,
                true,
            ),
        );
        assert_eq!(
            reconnect_policy_for_reason("stopped", None, None),
            (None, true, true),
            "the stop path narrates itself — no notice here, but still already-explained",
        );
        assert_eq!(
            reconnect_policy_for_reason("stalled", None, None),
            (Some("Connection stalled — reconnecting…".to_string()), false, false),
            "stalled is the ONLY reconnect-eligible reason",
        );
        // Today's wildcard ("error" and anything else unrecognized): terminal,
        // preferring the daemon's own message text when it sent one, and NOT
        // already-narrated (pre-existing behavior, unchanged by A2) — the
        // exit-explain block still adds its own generic notice on top.
        assert_eq!(
            reconnect_policy_for_reason("error", Some(99), Some("custom detail")),
            (Some("custom detail".to_string()), true, false),
        );
        assert_eq!(
            reconnect_policy_for_reason("error", None, None),
            (Some("Remote attach failed.".to_string()), true, false),
        );
        // The dedicated entry `looks_like_missing_daemon` routes into (A2):
        // terminal, already-narrated, with its own explanatory message
        // regardless of exit_code — never the wildcard's "Remote attach
        // failed.". No `message` (bin name) given: falls back to the default
        // "flightdeckd", matching the common case.
        assert_eq!(
            reconnect_policy_for_reason("daemon_missing", Some(127), None),
            (
                Some(
                    "flightdeckd isn't installed or isn't on PATH on the server — install it, \
                     then reopen this conversation."
                        .to_string()
                ),
                true,
                true,
            ),
        );
        // A NON-default configured `daemon_bin` (e.g. via
        // `TOSSE_REMOTE_FLIGHTDECKD_BIN`) must be named in the message too —
        // the regression test for A2's review finding that this arm used to
        // hardcode "flightdeckd" regardless of `message`.
        assert_eq!(
            reconnect_policy_for_reason("daemon_missing", Some(127), Some("flightdeckd-canary")),
            (
                Some(
                    "flightdeckd-canary isn't installed or isn't on PATH on the server — \
                     install it, then reopen this conversation."
                        .to_string()
                ),
                true,
                true,
            ),
        );
        assert_eq!(
            reconnect_policy_for_reason("banana_unrecognized_reason", None, None),
            (Some("Remote attach failed.".to_string()), true, false),
            "a truly unknown reason must fall back to the wildcard, terminal, never panic",
        );
        // The dedicated entry `looks_like_clap_flag_rejection` routes into (D6/C9
        // follow-up): non-terminal — like "stalled", this is the SECOND
        // reconnect-eligible reason, and by design (`run_actor` has already
        // downgraded the flags and invalidated the cache by the time this table is
        // consulted, purely for the notice).
        assert_eq!(
            reconnect_policy_for_reason("flag_rejected", Some(2), None),
            (
                Some(
                    "The server's flightdeckd no longer understands an optional flag this \
                     Mac was sending — retrying without it."
                        .to_string()
                ),
                false,
                false,
            ),
        );
    }

    /// [`looks_like_clap_flag_rejection`] unit coverage: exit code 2 alone is not
    /// enough (any other usage error also exits 2) — the stderr must ALSO name one
    /// of the two version-gated flags specifically.
    #[test]
    fn looks_like_clap_flag_rejection_requires_both_exit_code_and_flag_name() {
        assert!(looks_like_clap_flag_rejection(
            Some(2),
            &["error: unexpected argument '--supports-skip' found".to_string()],
        ));
        assert!(looks_like_clap_flag_rejection(
            Some(2),
            &["error: unexpected argument '--title' found".to_string()],
        ));
        // Case-insensitive, and matched against the LAST non-empty line (clap
        // prints usage/help lines after the actual error).
        assert!(looks_like_clap_flag_rejection(
            Some(2),
            &[
                "noise".to_string(),
                "".to_string(),
                "ERROR: UNEXPECTED ARGUMENT '--title' FOUND".to_string(),
            ],
        ));
        assert!(
            !looks_like_clap_flag_rejection(Some(2), &["error: unexpected argument '--socket' found".to_string()]),
            "a rejection of an UNRELATED flag must not trigger the downgrade",
        );
        assert!(
            !looks_like_clap_flag_rejection(Some(1), &["error: unexpected argument '--title' found".to_string()]),
            "the wrong exit code must never match, even with the right wording",
        );
        assert!(!looks_like_clap_flag_rejection(None, &["unexpected argument '--title'".to_string()]));
        assert!(!looks_like_clap_flag_rejection(Some(2), &[]));
    }

    /// A6 — table-driven coverage of the pure rotation decision.
    #[test]
    fn next_candidate_after_failure_table() {
        // A single address (every machine paired before A5) never rotates, no
        // matter how many consecutive failures pile up.
        assert_eq!(next_candidate_after_failure(0, 0, 1), None);
        assert_eq!(next_candidate_after_failure(0, 1, 1), None);
        assert_eq!(next_candidate_after_failure(0, 100, 1), None);
        // Defense-in-depth: an empty list (should never happen — see
        // `RemoteTarget::addresses`'s doc) must not panic or index out of bounds.
        assert_eq!(next_candidate_after_failure(0, 100, 0), None);

        // Below threshold: stays put.
        assert_eq!(next_candidate_after_failure(0, 0, 2), None);
        assert_eq!(
            next_candidate_after_failure(0, ADDRESS_ROTATION_THRESHOLD - 1, 2),
            None,
            "one below the threshold must not rotate yet",
        );

        // At the threshold: advances to the next index.
        assert_eq!(
            next_candidate_after_failure(0, ADDRESS_ROTATION_THRESHOLD, 2),
            Some(1),
        );
        // Past the threshold: still rotates (doesn't require an exact match).
        assert_eq!(
            next_candidate_after_failure(0, ADDRESS_ROTATION_THRESHOLD + 5, 2),
            Some(1),
        );

        // Wrap-around: the LAST candidate rotates back to the first, forever —
        // never "gives up" even with every candidate exhausted.
        assert_eq!(
            next_candidate_after_failure(2, ADDRESS_ROTATION_THRESHOLD, 3),
            Some(0),
            "the last index (2, of 3) must wrap back to 0",
        );
        // A middle index just advances by one.
        assert_eq!(
            next_candidate_after_failure(0, ADDRESS_ROTATION_THRESHOLD, 3),
            Some(1),
        );
        assert_eq!(
            next_candidate_after_failure(1, ADDRESS_ROTATION_THRESHOLD, 3),
            Some(2),
        );
    }

    /// A6 — table-driven coverage of the pure persist decision, INCLUDING the
    /// rotate-away-then-back-within-one-session regression this review closes:
    /// a naive "differs from the SPAWN-time host" check would wrongly skip
    /// persisting X on the second rotation, because X == the spawn host even
    /// though the DB currently (wrongly) says Y. Passing the last-PERSISTED
    /// host as the baseline (not the frozen spawn host) is what makes this
    /// third case come out `Some("a")` instead of `None`.
    #[test]
    fn host_to_persist_table() {
        // Same host: an ordinary reattach to the candidate we're already known
        // to be on — never re-persist.
        assert_eq!(host_to_persist("a", "a"), None);

        // First rotation: spawned on "a", attach confirms "b" — persist "b".
        assert_eq!(host_to_persist("a", "b"), Some("b".to_string()));

        // Second rotation, wrapping BACK to the original host: baseline is now
        // "b" (the LAST PERSISTED host, not the frozen spawn host "a"), attach
        // confirms "a" again — must still persist "a", even though "a" equals
        // where this session started.
        assert_eq!(host_to_persist("b", "a"), Some("a".to_string()));
    }

    /// [`rotate_remote_address`] applies the decision to a real `SpawnConfig`:
    /// mutates `remote.host` + `addr_idx` and reports the new host, without ever
    /// touching a `cfg` that has no `remote` (a local session) or indexing past
    /// a single-element `addresses` list.
    #[test]
    fn rotate_remote_address_mutates_host_and_reports_it() {
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.remote = Some(transport::RemoteTarget {
            host: "dead.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["dead.invalid".into(), "good.invalid".into()],
            machine_id: Some("m1".into()),
        });
        let mut addr_idx = 0usize;

        // Below threshold: no mutation.
        assert_eq!(rotate_remote_address(&mut cfg, &mut addr_idx, ADDRESS_ROTATION_THRESHOLD - 1), None);
        assert_eq!(cfg.remote.as_ref().unwrap().host, "dead.invalid");
        assert_eq!(addr_idx, 0);

        // At threshold: rotates to the second candidate.
        let rotated = rotate_remote_address(&mut cfg, &mut addr_idx, ADDRESS_ROTATION_THRESHOLD);
        assert_eq!(rotated.as_deref(), Some("good.invalid"));
        assert_eq!(cfg.remote.as_ref().unwrap().host, "good.invalid");
        assert_eq!(addr_idx, 1);

        // A local (non-remote) config is a documented no-op, never a panic.
        let mut local_cfg = SpawnConfig::new("/work/demo");
        let mut local_idx = 0usize;
        assert_eq!(rotate_remote_address(&mut local_cfg, &mut local_idx, 999), None);

        // A single-address remote never indexes past it, however high the
        // failure count climbs.
        let mut single = SpawnConfig::new("/work/demo");
        single.remote = Some(transport::RemoteTarget {
            host: "only.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["only.invalid".into()],
            machine_id: Some("m1".into()),
        });
        let mut single_idx = 0usize;
        assert_eq!(rotate_remote_address(&mut single, &mut single_idx, 1000), None);
        assert_eq!(single.remote.as_ref().unwrap().host, "only.invalid");
    }

    /// The common shell wordings for "the remote command wasn't found" — all
    /// must be recognized when the exit code is 127.
    #[test]
    fn looks_like_missing_daemon_recognizes_the_common_shell_wordings() {
        assert!(looks_like_missing_daemon(
            Some(127),
            &["bash: flightdeckd: command not found".to_string()],
            "flightdeckd",
        ));
        assert!(looks_like_missing_daemon(
            Some(127),
            &["zsh: command not found: flightdeckd".to_string()],
            "flightdeckd",
        ));
        assert!(looks_like_missing_daemon(
            Some(127),
            &["sh: 1: flightdeckd: not found".to_string()],
            "flightdeckd",
        ));
        assert!(looks_like_missing_daemon(
            Some(127),
            &["exec: flightdeckd: not found".to_string()],
            "flightdeckd",
        ));
    }

    /// The direct regression test for the false-positive risk the doc comment
    /// warns about: an UNRELATED command failing with the same exit code (e.g.
    /// a stale MOTD script or a broken dotfile) must never be mistaken for a
    /// missing `flightdeckd` — the anchor is the command NAME, not the exit
    /// code or the generic "command not found" phrasing.
    #[test]
    fn looks_like_missing_daemon_rejects_unrelated_command_not_found() {
        assert!(!looks_like_missing_daemon(
            Some(127),
            &["sl: command not found".to_string()],
            "flightdeckd",
        ));
    }

    /// Exit-code precondition is required: even the exact daemon-missing
    /// stderr wording must not classify without a 127 (e.g. the process is
    /// still alive / hasn't been reaped yet, `wait_status` returned `None`).
    #[test]
    fn looks_like_missing_daemon_requires_exit_code_127() {
        assert!(!looks_like_missing_daemon(
            None,
            &["bash: flightdeckd: command not found".to_string()],
            "flightdeckd",
        ));
    }

    /// A NON-default configured `daemon_bin` (e.g. a server running a
    /// differently-named/versioned daemon via `TOSSE_REMOTE_FLIGHTDECKD_BIN`,
    /// see `ipc/commands.rs`) must be classified against ITS OWN name, not a
    /// hardcoded "flightdeckd" — the direct regression test for the review
    /// finding that this classifier ignored the session's actual configured
    /// binary name entirely.
    #[test]
    fn looks_like_missing_daemon_uses_the_configured_binary_name() {
        assert!(
            looks_like_missing_daemon(
                Some(127),
                &["bash: flightdeckd-canary: command not found".to_string()],
                "flightdeckd-canary",
            ),
            "a non-default daemon_bin must still be recognized when IT is the one missing",
        );
        assert!(
            !looks_like_missing_daemon(
                Some(127),
                &["bash: flightdeckd: command not found".to_string()],
                "flightdeckd-canary",
            ),
            "the DEFAULT binary being missing must not falsely classify a session configured \
             for a DIFFERENT (also missing, but unrelated) binary name",
        );
        // A full remote path still matches on its basename, the way a shell's
        // "command not found" wording would name it.
        assert!(looks_like_missing_daemon(
            Some(127),
            &["bash: flightdeckd: command not found".to_string()],
            "/usr/local/bin/flightdeckd",
        ));
    }

    /// An unrelated failure (e.g. SSH auth) sharing neither the exit code nor
    /// the stderr wording must not classify.
    #[test]
    fn looks_like_missing_daemon_rejects_unrelated_failure() {
        assert!(!looks_like_missing_daemon(
            Some(255),
            &["Permission denied (publickey)".to_string()],
            "flightdeckd",
        ));
    }

    /// A healthy reconnect (no unparseable replayable lines) never accumulates
    /// a streak and never forces the cursor forward.
    #[test]
    fn malformed_replay_step_is_a_no_op_when_nothing_failed_to_parse() {
        assert_eq!(malformed_replay_step(0, 0), (0, 0, false));
        assert_eq!(
            malformed_replay_step(0, 2),
            (0, 0, false),
            "a clean reconnect resets a prior streak",
        );
    }

    /// The core bug this guards against: an unparseable line that reproduces on
    /// EVERY reconnect (the daemon replays deterministically) must eventually
    /// be skipped — not retried forever — and the caller must be told to warn
    /// exactly once per bound crossed, not on every attempt below it.
    #[test]
    fn malformed_replay_step_gives_up_after_the_bound_then_resets() {
        let mut streak = 0;
        for attempt in 1..MAX_MALFORMED_REPLAY_ATTEMPTS {
            let (advance, new_streak, warn) = malformed_replay_step(1, streak);
            assert_eq!(advance, 0, "attempt {attempt}: still within the bound, no skip yet");
            assert!(!warn, "attempt {attempt}: no warning below the bound");
            assert_eq!(new_streak, attempt);
            streak = new_streak;
        }
        // The attempt that crosses the bound: give up on the 1 unparseable line,
        // warn once, and reset the streak so a DIFFERENT poison-pill later in the
        // stream gets its own fresh chances rather than warning again immediately.
        let (advance, new_streak, warn) = malformed_replay_step(1, streak);
        assert_eq!(advance, 1, "the unparseable line count is what the cursor must skip");
        assert_eq!(new_streak, 0, "streak resets after giving up");
        assert!(warn, "must surface a protocol_error notice exactly once here");

        // A subsequent CLEAN reconnect (the poison pill is now behind the
        // cursor) does not warn again.
        assert_eq!(malformed_replay_step(0, new_streak), (0, 0, false));
    }

    /// A burst of several DIFFERENT unparseable lines in the same connection
    /// (not just one) is still bounded by attempt count, and the forced advance
    /// equals however many lines were actually unparseable that attempt — never
    /// under-skipping (which would loop) or over-skipping (which would drop a
    /// line we never even saw).
    #[test]
    fn malformed_replay_step_advances_by_the_real_unparseable_count() {
        let mut streak = 0;
        for _ in 1..MAX_MALFORMED_REPLAY_ATTEMPTS {
            let (_, new_streak, _) = malformed_replay_step(3, streak);
            streak = new_streak;
        }
        let (advance, _, warn) = malformed_replay_step(5, streak);
        assert_eq!(advance, 5, "must skip exactly the lines this attempt reported, not a stale count");
        assert!(warn);
    }

    /// A clean connection (no failures) uses the exact success count, same as
    /// before this table existed.
    #[test]
    fn reattach_cursor_delta_uses_lines_seen_when_nothing_failed() {
        assert_eq!(reattach_cursor_delta(4, None, 0), 4);
    }

    /// The blocker this guards against: OK, FAIL, OK, OK within ONE connection
    /// (a bad line NOT last) — `lines_seen` (3, both successes before AND
    /// after the failure) would silently overtake the failure's true position
    /// and the daemon would never re-offer it. The correct delta rolls back to
    /// `first_unparseable_offset` (1, the success BEFORE the failure), even
    /// though `lines_seen` disagrees — this is exactly the case where using
    /// `lines_seen` alone drops a message forever.
    #[test]
    fn reattach_cursor_delta_rolls_back_to_the_first_failure_not_lines_seen() {
        let lines_seen = 3; // 1 success before FAIL, 2 more after it
        let first_unparseable_offset = Some(1); // success count strictly before FAIL
        assert_eq!(
            reattach_cursor_delta(lines_seen, first_unparseable_offset, 0),
            1,
            "must resume right before the still-unrecovered failure, not past it",
        );
        assert_ne!(
            reattach_cursor_delta(lines_seen, first_unparseable_offset, 0),
            lines_seen,
            "lines_seen is exactly the wrong answer here — it would skip the failure",
        );
    }

    /// Once `malformed_replay_step` decides to give up (`force_advance > 0`),
    /// the delta must skip past EVERYTHING this connection delivered —
    /// successes before AND after the failure, plus the failure(s) themselves
    /// — never roll back to `first_unparseable_offset` (that would ask for the
    /// very line we just gave up on, forever).
    #[test]
    fn reattach_cursor_delta_skips_everything_when_giving_up() {
        let lines_seen = 4; // successes both sides of the 2 failures
        let force_advance = 2; // malformed_replay_step's give-up count
        assert_eq!(
            reattach_cursor_delta(lines_seen, Some(1), force_advance),
            6,
            "giving up must use lines_seen + force_advance (the true total), \
             ignoring first_unparseable_offset entirely",
        );
    }

    /// Actor-level regression for A2: a remote spawn whose command fails
    /// immediately because `flightdeckd` isn't on the remote `PATH` must stop
    /// with EXACTLY ONE terminal notice and never loop retrying forever — the
    /// bug this task fixes (today, before this fix, this would hang until the
    /// timeout below fires, since no `FdDetach` is ever produced by a spawn
    /// failure).
    ///
    /// Fakes the remote command by pointing `$TOSSE_SSH_BIN` (a test-only
    /// escape hatch, see `transport::resolve_ssh_bin`) at a tiny script that
    /// ignores every `ssh` flag/arg and just prints the exact wording a real
    /// remote shell prints for a command that isn't on `PATH`, then exits 127
    /// — precisely what a real Ubuntu box without `flightdeckd` installed
    /// would produce over the wire.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_actor_stops_cleanly_when_the_remote_daemon_is_missing() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("tosse-daemon-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            "#!/bin/sh\necho \"bash: flightdeckd: command not found\" 1>&2\nexit 127\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        // `TOSSE_SSH_BIN` is a test-only escape hatch read once at spawn time;
        // `ENV_LOCK` serialises the mutation against any other test in this
        // module that might one day also touch it, under the parallel test
        // runner (mirrors `transport::tests::ENV_LOCK`'s pattern for the
        // sibling `TOSSE_CLAUDE_BIN`). Held across the spawn, which is where
        // the var is actually read.
        let env_guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "example.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["example.invalid".into()],
            machine_id: None,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "daemon-missing-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        );
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(env_guard);
        let handle = handle.expect("fake ssh should spawn (it's a real, if tiny, process)");

        // Drain every notice until the actor tears itself down and the event
        // channel closes on its own (nothing left holding `event_tx` once
        // `run_actor` drops `core`) — the actor reconnecting forever instead
        // would never close it, so the timeout is the "it looped" assertion.
        let mut process_exited_notices: Vec<Value> = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::Notice { subtype, detail }) = ev {
                    if subtype == "process_exited" {
                        process_exited_notices.push(detail);
                    }
                }
            }
        })
        .await
        .expect(
            "the actor must stop on its own instead of reconnecting forever \
             on a daemon binary that will never appear",
        );

        handle.shutdown_and_wait_stopping().await.ok();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            process_exited_notices.len(),
            1,
            "expected exactly one terminal notice, not a reconnect loop nor a double notice: {process_exited_notices:?}",
        );
        let message = process_exited_notices[0]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("flightdeckd isn't installed"),
            "expected the daemon-missing message, got: {message:?}",
        );
        assert_eq!(
            process_exited_notices[0]["reason"].as_str(),
            Some("daemon_missing"),
            "the notice must carry a stable, structured reason alongside the free-text \
             message, so a future UI can match on it instead of parsing English prose",
        );
    }

    /// D6/C9 follow-up (review finding) end-to-end: a daemon DOWNGRADED below 0.2.0
    /// mid-run rejects `--supports-skip`/`--title` with clap's unknown-argument exit
    /// (2). The actor must invalidate the machine's cached version, retry EXACTLY
    /// ONCE without either flag, and then behave completely normally (reconnect
    /// succeeds, no loop) — never keep re-offering the flags the daemon just proved
    /// it doesn't understand.
    ///
    /// Fakes the remote command like `run_actor_stops_cleanly_when_the_remote_daemon_
    /// is_missing`, except this script behaves DIFFERENTLY on its first vs later
    /// invocation (a call counter sidecar file): first call → clap's rejection
    /// message + exit 2; every later call → a normal successful attach. It also logs
    /// the exact command line each invocation received, so the test can assert the
    /// SECOND attempt genuinely dropped both flags.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_actor_retries_once_without_the_flags_after_a_clap_rejection() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("tosse-flag-rejected-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
DIR="$(dirname "$0")"
for last; do :; done
printf '%s\n' "$last" >> "$DIR/args.log"
N=0
[ -f "$DIR/calls" ] && N=$(cat "$DIR/calls")
N=$((N + 1))
echo "$N" > "$DIR/calls"
if [ "$N" -eq 1 ]; then
    echo "error: unexpected argument '--supports-skip' found" 1>&2
    exit 2
fi
printf '%s\n' '{"type":"fd_attach","conversation":"c1","epoch":"e1","replay_from":0}'
sleep 30
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        // Arrange "this machine's daemon version is already cached" (as a real
        // spawn's D6/C9 gate would have left it) so the assertion below can prove
        // the clap-rejection path actually invalidates it, not just that the retry
        // behaves correctly.
        let machine_id = "m-flag-test-clap-rejection";
        crate::ipc::commands::seed_daemon_version_cache_for_test(
            machine_id,
            Some("flightdeckd 0.2.0".to_string()),
        );
        assert!(crate::ipc::commands::daemon_version_cache_contains(machine_id));

        // Unlike a single-attempt test, this actor spawns TWO transports over its
        // lifetime (the reconnect re-reads `TOSSE_SSH_BIN` — see
        // `transport::resolve_ssh_bin`), so the guard is held for the WHOLE test
        // body, exactly like `run_actor_rotates_to_the_next_address_after_repeated_
        // failures_and_persists_it` — released only once no more spawns are coming.
        let env_guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "example.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["example.invalid".into()],
            machine_id: Some(machine_id.to_string()),
        });
        cfg.conversation_title = Some("My Feature".into());
        cfg.attach = Some(transport::AttachPoint {
            conversation: None,
            epoch: None,
            cursor: 0,
            supports_skip: true,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "flag-rejected-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        );
        let handle = handle.expect("fake ssh should spawn");

        // Wait for the "Reconnected" notice — proof the SECOND (downgraded) attempt
        // actually succeeded, rather than the actor giving up or looping the first
        // failure forever.
        let mut reconnected_msg: Option<String> = None;
        let mut flag_rejected_msg: Option<String> = None;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::Notice { subtype, detail }) = ev {
                    let text = detail["message"].as_str().unwrap_or_default().to_string();
                    if subtype == "process_exited" && detail["reason"].as_str() == Some("flag_rejected") {
                        flag_rejected_msg = Some(text);
                    } else if subtype == "remote_link" && text.contains("Reconnected") {
                        reconnected_msg = Some(text);
                        break;
                    }
                }
            }
        })
        .await
        .expect("the actor must recover from the clap rejection within the deadline, not hang or loop");

        // Safe to release now: the winning (downgraded) transport is already
        // attached above — no more spawns are coming.
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(env_guard);

        handle.shutdown_and_wait_stopping().await.ok();

        assert!(flag_rejected_msg.is_some(), "expected the one-time flag_rejected notice");
        assert!(reconnected_msg.is_some(), "expected the downgraded retry to succeed");

        let calls: u32 = fs::read_to_string(dir.join("calls")).unwrap().trim().parse().unwrap();
        assert_eq!(calls, 2, "expected EXACTLY one retry (two total attempts), never a loop");

        let log = fs::read_to_string(dir.join("args.log")).unwrap();
        let attempts: Vec<&str> = log.lines().collect();
        assert_eq!(attempts.len(), 2);
        assert!(
            attempts[0].contains("--supports-skip") && attempts[0].contains("--title="),
            "the FIRST attempt should still ask for both flags: {}",
            attempts[0],
        );
        assert!(
            !attempts[1].contains("--supports-skip") && !attempts[1].contains("--title="),
            "the SECOND (retry) attempt must drop BOTH optional flags: {}",
            attempts[1],
        );
        assert!(
            !crate::ipc::commands::daemon_version_cache_contains(machine_id),
            "the clap rejection must invalidate the machine's cached daemon version, \
             so the NEXT top-level spawn re-probes for real instead of repeating the \
             now-stale answer",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// D6 wiring end-to-end: a daemon that sends a MISMATCHED `fd_skip` (a protocol
    /// violation it should never produce) must surface exactly one `protocol_error`
    /// notice through `run_actor` — proving `Transport::take_skip_violation`
    /// actually reaches the session's event stream, not just the transport-level
    /// unit tests. Fakes the remote command the same way
    /// `run_actor_stops_cleanly_when_the_remote_daemon_is_missing` does
    /// (`$TOSSE_SSH_BIN` pointed at a script), except this one behaves like a live
    /// `flightdeckd attach`: prints a handshake, a normal replayable line, the
    /// violating `fd_skip`, then one more replayable line (the actor's natural
    /// wake-up point to check the flag — see `run_actor`'s `maybe_msg` arm) before
    /// going quiet.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_actor_surfaces_a_skip_violation_as_one_protocol_error_notice() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("tosse-skip-violation-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' '{"type":"fd_attach","conversation":"c1","epoch":"e1","replay_from":0}'
printf '%s\n' '{"type":"result","subtype":"success"}'
printf '%s\n' '{"type":"fd_skip","from":5,"to":8}'
printf '%s\n' '{"type":"result","subtype":"success"}'
sleep 30
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let env_guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "example.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["example.invalid".into()],
            machine_id: None,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "skip-violation-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        );
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(env_guard);
        let handle = handle.expect("fake ssh should spawn (it's a real, if tiny, process)");

        // The fake daemon goes quiet (just `sleep`s) right after the 4 scripted
        // lines, so drain only until the ONE notice we're looking for shows up.
        let mut protocol_error_notices: Vec<Value> = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::Notice { subtype, detail }) = ev {
                    if subtype == "protocol_error" {
                        protocol_error_notices.push(detail);
                        break;
                    }
                }
            }
        })
        .await
        .expect("expected a protocol_error notice for the mismatched fd_skip");

        handle.shutdown_and_wait_stopping().await.ok();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(protocol_error_notices.len(), 1, "exactly one notice for the one violation");
        let message = protocol_error_notices[0]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("fd_skip"),
            "expected the fd_skip violation wording, got: {message:?}"
        );
    }

    /// A6 end-to-end (non-live): a preferred `host` that is simply DEAD must, after
    /// [`ADDRESS_ROTATION_THRESHOLD`] consecutive failed attempts against it, rotate
    /// to the next recorded candidate — and once THAT one attaches, emit the
    /// preferred-host persist signal with the winning address. Fakes the remote
    /// command the same way the daemon-missing / skip-violation tests above do
    /// (`$TOSSE_SSH_BIN` pointed at a script), except this one behaves DIFFERENTLY
    /// depending on which host it was dialed for — inspecting its own argv (ssh
    /// always includes `user@host`) — exactly like a real ssh client whose outcome
    /// depends on whether THAT address is reachable: `dead.invalid` fails instantly
    /// with no output (a connection refused/timeout, exit code far from 127 so this
    /// is never misclassified as `daemon_missing`), `good.invalid` behaves like a
    /// live `flightdeckd attach`.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_actor_rotates_to_the_next_address_after_repeated_failures_and_persists_it() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("tosse-addr-rotation-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
case "$*" in
  *dead.invalid*)
    exit 7
    ;;
  *)
    printf '%s\n' '{"type":"fd_attach","conversation":"c1","epoch":"e1","replay_from":0}'
    sleep 30
    ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        // Unlike the daemon-missing / skip-violation tests above, this actor spawns
        // MULTIPLE transports over its lifetime (each reconnect re-reads
        // `TOSSE_SSH_BIN` — see `transport::resolve_ssh_bin`), so the guard is held
        // for the WHOLE test body, not just the first spawn.
        let env_guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "dead.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["dead.invalid".into(), "good.invalid".into()],
            machine_id: Some("m1".into()),
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "addr-rotation-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        );
        let handle = handle.expect("fake ssh should spawn (it's a real, if tiny, process)");

        let mut remote_link_messages: Vec<String> = Vec::new();
        let mut persisted: Option<(String, String)> = None;
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::Notice { subtype, detail })
                        if subtype == "remote_link" =>
                    {
                        remote_link_messages
                            .push(detail["message"].as_str().unwrap_or_default().to_string());
                    }
                    SessionEvent::PreferredHostChanged { machine_id, host } => {
                        persisted = Some((machine_id, host));
                        break; // the one signal this test is after
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("expected a rotation to good.invalid followed by a preferred-host persist signal");

        // Safe to release now: the actor holds no live handle to `TOSSE_SSH_BIN`
        // past a spawn (it reads the env var fresh each time), and the winning
        // transport is already attached above — no more spawns are coming.
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(env_guard);

        handle.shutdown_and_wait_stopping().await.ok();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            persisted,
            Some(("m1".to_string(), "good.invalid".to_string())),
            "the persist signal must name the machine and the WINNING address",
        );
        assert_eq!(
            remote_link_messages.iter().filter(|m| m.contains("Trying another address")).count(),
            1,
            "exactly one rotation notice, not one per failed attempt: {remote_link_messages:?}",
        );
        assert!(
            remote_link_messages.iter().any(|m| m.contains("good.invalid")),
            "the rotation notice must name the new address: {remote_link_messages:?}",
        );
        assert!(
            remote_link_messages.iter().any(|m| m.contains("Connection to the server lost")),
            "the existing generic outage notice must still fire: {remote_link_messages:?}",
        );
        assert!(
            remote_link_messages.iter().any(|m| m.contains("Reconnected")),
            "the winning candidate must still produce the normal 'Reconnected' notice: {remote_link_messages:?}",
        );
    }

    /// A6: a TERMINAL reconnect reason (here, `daemon_missing`, exit 127) must end the
    /// session exactly as it did before A6 — even with a SECOND candidate address
    /// recorded, rotation must never fire and `good.invalid` must never be dialed.
    /// Reuses `run_actor_stops_cleanly_when_the_remote_daemon_is_missing`'s fake
    /// script (every host gets the same "command not found" response).
    #[cfg(unix)]
    #[tokio::test]
    async fn run_actor_never_rotates_on_a_terminal_reconnect_reason() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("tosse-no-rotate-terminal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            "#!/bin/sh\necho \"bash: flightdeckd: command not found\" 1>&2\nexit 127\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let env_guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "example.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            // A second candidate that WOULD be dialed if (incorrectly) rotated onto.
            addresses: vec!["example.invalid".into(), "good.invalid".into()],
            machine_id: Some("m1".into()),
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "no-rotate-terminal-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        );
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(env_guard);
        let handle = handle.expect("fake ssh should spawn (it's a real, if tiny, process)");

        let mut remote_link_messages: Vec<String> = Vec::new();
        let mut process_exited_notices = 0;
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::Notice { subtype, detail }) = ev {
                    if subtype == "remote_link" {
                        remote_link_messages
                            .push(detail["message"].as_str().unwrap_or_default().to_string());
                    } else if subtype == "process_exited" {
                        process_exited_notices += 1;
                    }
                }
            }
        })
        .await
        .expect(
            "the actor must stop on its own (terminal reason) instead of ever considering rotation",
        );

        handle.shutdown_and_wait_stopping().await.ok();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(process_exited_notices, 1, "exactly one terminal notice, no reconnect loop");
        assert!(
            remote_link_messages.iter().all(|m| !m.contains("Trying another address")),
            "a terminal reason must never rotate, even with a second candidate available: {remote_link_messages:?}",
        );
    }

    /// Live M1 acceptance check (C9): spawning a REMOTE conversation with a title
    /// set must have the daemon record it as the conversation's AUTHORITATIVE title
    /// — verified the same way an operator would: `ssh … flightdeckd status` and
    /// look for it in the JSON. Full path: `SpawnConfig::conversation_title` →
    /// `build_remote_command`'s `--title=` → the daemon's `attach.rs::handle_conn`
    /// (`set_title_authoritative`, run BEFORE the `fd_attach` ack — see
    /// `transport::push_remote_title`'s doc) → `flightdeckd status`'s `title` field.
    /// A distinctive, uuid-suffixed title makes a raw substring match in the status
    /// JSON an unambiguous signal without needing to correlate rows by conversation
    /// id (the daemon mints its own on a cold start).
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`), daemon >= 0.2.0. Run with:
    ///   cargo test -p tosse-code --lib -- --ignored spawn_with_a_title_sets_it_on_the_m1_daemon --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container, daemon >= 0.2.0)"]
    async fn spawn_with_a_title_sets_it_on_the_m1_daemon() {
        use std::time::Duration;
        let identity = std::env::var("TOSSE_M1_KEY").unwrap_or_else(|_| {
            format!("{}/.ssh/flightdeck_m0_ed25519", std::env::var("HOME").unwrap_or_default())
        });
        let title = format!("tosse-c9-live-test-{}", uuid::Uuid::new_v4());

        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.conversation_title = Some(title.clone());
        cfg.remote = Some(transport::RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(identity.clone()),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "live-title-test".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        )
        .expect("remote spawn should start");

        handle
            .send_user_text("Reply with exactly the two words: hello world. Do not use any tools.")
            .await
            .expect("send should queue");

        let mut result_ok: Option<bool> = None;
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) = ev {
                    result_ok = Some(!is_error);
                    break;
                }
            }
        })
        .await
        .expect("the turn should complete within the deadline");
        assert_eq!(result_ok, Some(true), "expected a successful remote turn");

        handle.shutdown_and_wait_stopping().await.ok();

        // `ssh <dest> 'exec flightdeckd status'` — the same one-shot pattern
        // `transport::run_remote_stop` uses — read back the daemon's own view.
        let out = tokio::process::Command::new("ssh")
            .arg("-T")
            .arg("-p")
            .arg("2224")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("UserKnownHostsFile=/dev/null")
            .arg("-i")
            .arg(&identity)
            .arg("-o")
            .arg("IdentitiesOnly=yes")
            .arg("agent@127.0.0.1")
            .arg("exec flightdeckd status")
            .output()
            .await
            .expect("ssh status should run");
        let status_json = String::from_utf8_lossy(&out.stdout);
        eprintln!("[live] flightdeckd status: {status_json}");
        assert!(
            status_json.contains(&title),
            "expected the daemon's status to carry the title '{title}' — got: {status_json}",
        );
    }

    /// Live M1 acceptance check, Mac side: "piloting a remote session from the
    /// Mac must survive a network cut". Full actor path: spawn a real remote
    /// session (ssh → flightdeckd → daemon-owned claude), start a slow tool
    /// turn, SIGKILL the ssh client mid-turn (the network cut), and assert the
    /// ACTOR reconnects by itself and the turn's result still arrives (the
    /// daemon kept the session alive and replayed what we missed).
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored actor_survives_ssh_cut --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container)"]
    async fn actor_survives_ssh_cut_and_replays() {
        use std::time::Duration;
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.remote = Some(transport::RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(format!(
                "{}/.ssh/flightdeck_m0_ed25519",
                std::env::var("HOME").unwrap_or_default()
            )),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "live-cut".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        )
        .expect("remote spawn should start");

        handle
            .send_user_text(
                "Run: sleep 8 && echo CUT_SURVIVED. Then reply with exactly the single word DONE_ACTOR.",
            )
            .await
            .expect("send should queue");

        // Wait for evidence the turn is really streaming, then cut the link.
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::MessageStarted { .. })
                    | SessionEvent::Item(ConversationItem::TextDelta { .. }) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("the turn should start streaming");

        // The "network cut": kill the ssh client (the attach channel) hard.
        let killed = std::process::Command::new("pkill")
            .args(["-9", "-f", "2224.*flightdeckd.*attach"])
            .status()
            .expect("pkill should run");
        assert!(killed.success(), "expected to kill the live ssh attach client");

        // The actor must reconnect on its own and the turn must complete.
        let mut reconnected = false;
        let mut result: Option<bool> = None;
        tokio::time::timeout(Duration::from_secs(90), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::Notice { ref subtype, ref detail })
                        if subtype == "remote_link" =>
                    {
                        eprintln!("[live] remote_link: {detail}");
                        if detail.to_string().contains("Reconnected") {
                            reconnected = true;
                        }
                    }
                    SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) => {
                        result = Some(!is_error);
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the cut turn should still complete after auto-reconnect");

        handle.shutdown_and_wait_stopping().await.ok();

        assert!(reconnected, "expected a 'Reconnected to the server.' notice");
        assert_eq!(result, Some(true), "the interrupted turn's result should arrive via replay");
    }

    /// A6 live acceptance check: a machine whose PREFERRED address is genuinely dead
    /// must still reach the m1 container, by rotating onto a second recorded
    /// candidate — `203.0.113.1` (TEST-NET-3, RFC 5737: guaranteed unroutable, never
    /// answers) FIRST, `127.0.0.1` (the real container) second. Full actor path, no
    /// faked ssh: the actor's own reconnect loop must fail against the dead address
    /// (`ConnectTimeout=10` per attempt — see `build_remote_command`'s ssh options),
    /// cross [`ADDRESS_ROTATION_THRESHOLD`], rotate, attach for real, persist the win,
    /// and still carry a normal turn to completion on the winning candidate.
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored actor_rotates_to_a_live_address_on_the_m1_container --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container)"]
    async fn actor_rotates_to_a_live_address_on_the_m1_container() {
        use std::time::Duration;
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.remote = Some(transport::RemoteTarget {
            // The PREFERRED (first) address is the dead one on purpose — this is
            // what a stale `machines.host` looks like the morning after a server's
            // address changed.
            host: "203.0.113.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(
                std::env::var("TOSSE_M1_KEY").unwrap_or_else(|_| {
                    format!(
                        "{}/.ssh/flightdeck_m0_ed25519",
                        std::env::var("HOME").unwrap_or_default()
                    )
                }),
            ),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["203.0.113.1".into(), "127.0.0.1".into()],
            machine_id: Some("live-m1".into()),
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "live-addr-rotation".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        )
        .expect("remote spawn should start (it dials the dead address first, which forks fine)");

        // Phase 1: drain events until the actor has rotated onto the live candidate
        // AND attached for real — sending a turn any earlier (while the dead address
        // is still being dialed) would just be lost (no live channel yet to carry
        // it), which is not what this test is measuring. This phase alone already
        // proves the rotation notice, the persist signal, and the reconnect.
        let mut remote_link_messages: Vec<String> = Vec::new();
        let mut persisted: Option<(String, String)> = None;
        let mut reconnected = false;
        // Generous: `ConnectTimeout=10` per dead-address attempt, times up to
        // `ADDRESS_ROTATION_THRESHOLD` consecutive failures, plus backoff sleeps —
        // easily 30-40s before the FIRST good-address attempt even starts.
        tokio::time::timeout(Duration::from_secs(90), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::Notice { ref subtype, ref detail })
                        if subtype == "remote_link" =>
                    {
                        eprintln!("[live] remote_link: {detail}");
                        let msg = detail["message"].as_str().unwrap_or_default().to_string();
                        if msg.contains("Reconnected") {
                            reconnected = true;
                        }
                        remote_link_messages.push(msg);
                    }
                    SessionEvent::PreferredHostChanged { machine_id, host } => {
                        eprintln!("[live] preferred host persist signal: {machine_id} -> {host}");
                        persisted = Some((machine_id, host));
                    }
                    _ => {}
                }
                if reconnected && persisted.is_some() {
                    break;
                }
            }
        })
        .await
        .expect("the actor should rotate onto 127.0.0.1, attach, and persist the winning address");

        let rotation_notices: Vec<&String> =
            remote_link_messages.iter().filter(|m| m.contains("Trying another address")).collect();
        assert_eq!(
            rotation_notices.len(),
            1,
            "exactly one rotation notice, not one per failed attempt: {remote_link_messages:?}",
        );
        assert!(
            rotation_notices[0].contains("127.0.0.1"),
            "the rotation notice must name the winning address: {rotation_notices:?}",
        );
        assert_eq!(
            persisted,
            Some(("live-m1".to_string(), "127.0.0.1".to_string())),
            "the preferred-host persist signal must fire with the WINNING address",
        );

        // Phase 2: a plain post-rotation sanity turn (NOT a replay/dedup test —
        // nothing here disconnects or replays) — now that a real link exists on
        // the winning candidate, a normal turn must still go through cleanly
        // (exactly one result, no error), proving the rotation left the session
        // in a perfectly ordinary working state, not a half-attached one. The
        // actual replay/dedup invariant is exercised by
        // `actor_survives_stalled_link_and_replays` (D4).
        handle
            .send_user_text("Reply with exactly the word: PING. Nothing else, no tools.")
            .await
            .expect("send should queue now that a live channel exists");
        let mut result: Option<bool> = None;
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(ev) = event_rx.recv().await {
                if let SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) = ev {
                    result = Some(!is_error);
                    break;
                }
            }
        })
        .await
        .expect("the turn on the winning candidate should complete normally");

        handle.shutdown_and_wait_stopping().await.ok();

        assert_eq!(result, Some(true), "the turn must complete normally on the live candidate");
    }

    /// PNG CRC-32 (ISO 3309 / ITU-T V.42) — the checksum every PNG chunk footer
    /// carries. Hand-rolled (no compression/image crate — this repo deliberately
    /// avoids pulling one in just for a lazily-decoded SVG icon; see `qrcode`'s own
    /// `default-features = false` comment in `Cargo.toml`) for
    /// [`noise_png`] alone.
    #[cfg(unix)]
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// The zlib stream footer's Adler-32 checksum of the UNCOMPRESSED payload
    /// (RFC 1950 §2.2), for [`noise_png`].
    #[cfg(unix)]
    fn adler32(data: &[u8]) -> u32 {
        let mut a: u32 = 1;
        let mut b: u32 = 0;
        for &byte in data {
            a = (a + byte as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }

    /// A structurally VALID but incompressible PNG (`w`×`h`, 8-bit truecolor, random
    /// noise) — the same technique and purpose as `flightdeckd/live/m1/tests/
    /// detach_test.py`'s `noise_png` (ported to Rust so the D4 live test below runs
    /// through OUR actor, not the raw protocol), just with the zlib/DEFLATE stream
    /// built as STORED (uncompressed) blocks (RFC 1951 §3.2.4) instead of calling a
    /// compression library: this repo has none in the tree, and stored blocks are
    /// exactly as valid to any PNG decoder — irrelevant here anyway, since random
    /// noise barely compresses. `seed` is a tiny xorshift64* PRNG state (no `rand`
    /// dependency needed either) so each of the 4 images in the burst differs.
    #[cfg(unix)]
    fn noise_png(w: u32, h: u32, seed: u64) -> Vec<u8> {
        let mut state = seed.max(1);
        let mut next_byte = move || -> u8 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state & 0xff) as u8
        };
        let mut raw = Vec::with_capacity((1 + w as usize * 3) * h as usize);
        for _ in 0..h {
            raw.push(0u8); // scanline filter type 0 ("None")
            for _ in 0..(w as usize * 3) {
                raw.push(next_byte());
            }
        }

        let mut zlib = vec![0x78u8, 0x01u8]; // zlib header: default window, no preset dict
        let mut offset = 0usize;
        loop {
            let remaining = raw.len() - offset;
            let block_len = remaining.min(65535);
            let is_final = offset + block_len >= raw.len();
            // BFINAL (bit 0) + BTYPE=00 stored (bits 1-2) + zero padding — a stored
            // block is always byte-aligned already, so this single byte IS the whole
            // (padded) block header.
            zlib.push(if is_final { 1 } else { 0 });
            let len = block_len as u16;
            zlib.extend_from_slice(&len.to_le_bytes());
            zlib.extend_from_slice(&(!len).to_le_bytes()); // NLEN: one's complement of LEN
            zlib.extend_from_slice(&raw[offset..offset + block_len]);
            offset += block_len;
            if is_final {
                break;
            }
        }
        zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

        let chunk = |typ: &[u8; 4], data: &[u8]| -> Vec<u8> {
            let mut c = Vec::with_capacity(8 + data.len() + 4);
            c.extend_from_slice(&(data.len() as u32).to_be_bytes());
            c.extend_from_slice(typ);
            c.extend_from_slice(data);
            let mut crc_input = Vec::with_capacity(4 + data.len());
            crc_input.extend_from_slice(typ);
            crc_input.extend_from_slice(data);
            c.extend_from_slice(&crc32(&crc_input).to_be_bytes());
            c
        };

        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit depth, color type 2 (truecolor)

        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(chunk(b"IHDR", &ihdr));
        png.extend(chunk(b"IDAT", &zlib));
        png.extend(chunk(b"IEND", b""));
        png
    }

    /// D4 live regression: the actor survives a link that goes STALLED-BUT-ALIVE
    /// (not a clean cut) — the end-to-end proof of D1 (daemon write timeout) + D2
    /// (this Mac's reconnect policy already treats `fd_detach{stalled}`/bare-EOF as
    /// reconnect-eligible) + the cursor math, driven through the REAL actor and a
    /// REAL `claude` turn instead of the raw protocol
    /// (`flightdeckd/live/m1/tests/detach_test.py`'s `scenario_d`, which this
    /// ports: same technique, same daemon, now proving OUR client survives it too).
    ///
    /// Flow: attach, start a turn that interleaves small `Bash echo`s with `Read`s of
    /// 4 incompressible ~3 MB PNGs (a small burst is not enough — the measured ssh
    /// path buffers ~2.2 MB before the daemon's write blocks at all), SIGSTOP the
    /// LOCAL ssh attach child (the link stalls but stays alive — unlike a kill, which
    /// the daemon sees as an immediate clean cut), wait for the turn to finish
    /// DAEMON-side (polled via a SEPARATE, unaffected `flightdeckd status` ssh call)
    /// plus the daemon's `ATTACH_WRITE_TIMEOUT` (20s, `flightdeckd/src/session.rs`),
    /// SIGCONT, then assert: the actor sees the stream END, reconnects and replays on
    /// its own, the turn completes with the correct final result, and NOTHING in the
    /// assembled transcript is duplicated, garbled, or missing (message ids / tool_use
    /// ids / the DONE marker).
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`). Slow (uploads ~12 MB, pauses
    /// ~25s+). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored actor_survives_stalled_link_and_replays --nocapture
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude, SIGSTOPs the local ssh child for ~25-90s (needs the flightdeck-m1 container, not for CI)"]
    async fn actor_survives_stalled_link_and_replays() {
        use std::io::Write as _;
        use std::time::Duration;

        // The daemon's ATTACH_WRITE_TIMEOUT (flightdeckd/src/session.rs) — how long
        // it keeps trying to write to a stalled client before
        // dropping it. `+5` matches detach_test.py's own margin.
        const ATTACH_WRITE_TIMEOUT_SECS: u64 = 20;

        let key = std::env::var("TOSSE_M1_KEY").unwrap_or_else(|_| {
            format!("{}/.ssh/flightdeck_m0_ed25519", std::env::var("HOME").unwrap_or_default())
        });
        let ssh_flags: Vec<String> = [
            "-T", "-p", "2224", "-i", &key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o",
            "StrictHostKeyChecking=accept-new", "agent@127.0.0.1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        // INSIDE the cwd (`/work/demo`), not `/tmp` (unlike detach_test.py, which
        // drives the raw protocol with no extra `claude` args and so never hits
        // this): our actor's `build_claude_args` always appends `--permission-mode
        // auto`, and a Read OUTSIDE the working directory still prompts for
        // approval under that mode (`SpawnConfig::add_dirs`/`--add-dir` would
        // widen it, but nothing populates that today — see the repo's own doc on
        // it) — confirmed live: the exact same scenario with a `/tmp` burst dir
        // left the daemon-side turn stuck on an unanswered `can_use_tool` this
        // test never answers, indefinitely `busy`.
        let burst_dir = format!("/work/demo/.tosse-scenario-d-{}", std::process::id());
        let mkdir = std::process::Command::new("ssh")
            .args(&ssh_flags)
            .arg(format!("mkdir -p {burst_dir}"))
            .status()
            .expect("ssh mkdir should run");
        assert!(mkdir.success(), "failed to create the burst dir on the container");

        // Upload 4 incompressible ~3 MB PNGs — comfortably over the ~2.2 MB measured
        // buffering threshold, interleaved below with small Bash echos.
        for i in 0..4u64 {
            let png = noise_png(1000, 1000, i + 1);
            let mut child = std::process::Command::new("ssh")
                .args(&ssh_flags)
                .arg(format!("cat > {burst_dir}/noise{i}.png"))
                .stdin(std::process::Stdio::piped())
                .spawn()
                .expect("ssh upload should spawn");
            child.stdin.take().unwrap().write_all(&png).expect("upload write should succeed");
            let status = child.wait().expect("ssh upload should exit");
            assert!(status.success(), "uploading noise{i}.png failed");
        }

        // Pre-mint the daemon-side conversation id (mirrors `ipc::commands::
        // spawn_session`'s idempotent-retry pattern) so this test can poll
        // `flightdeckd status` for THIS conversation specifically over a SEPARATE,
        // short-lived ssh call — unaffected by the one we're about to SIGSTOP.
        let conversation_id = uuid::Uuid::new_v4().to_string();

        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.attach = Some(transport::AttachPoint {
            conversation: Some(conversation_id.clone()),
            epoch: None,
            cursor: 0,
            supports_skip: false,
        });
        cfg.remote = Some(transport::RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(key.clone()),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        });

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let handle = spawn_session(
            "live-stalled".to_string(),
            cfg,
            InitialControls::default(),
            Arc::new(ChannelEmitter { tx: event_tx }),
            Box::new(|| {}),
            None,
        )
        .expect("remote spawn should start");

        let steps: Vec<String> = (0..4u64)
            .flat_map(|i| {
                vec![format!("Bash: echo step-{}", 2 * i), format!("Read: {burst_dir}/noise{i}.png")]
            })
            .collect();
        let prompt = format!(
            "Do these steps strictly in order, ONE tool call per step, no commentary between \
             them:\n{}\nThen reply with exactly the single word DONE_D.",
            steps.iter().enumerate().map(|(n, s)| format!("{}. {s}", n + 1)).collect::<Vec<_>>().join("\n"),
        );
        handle.send_user_text(prompt).await.expect("send should queue");

        // Wait for evidence the burst is really streaming before pausing mid-flight.
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::MessageStarted { .. })
                    | SessionEvent::Item(ConversationItem::TextDelta { .. }) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("the burst turn should start streaming");

        // SIGSTOP the LOCAL ssh attach child: the link stalls but stays alive (TCP
        // up, zero window) — unlike a kill, which is a clean cut the daemon sees at
        // once. Guarded so a panic mid-pause can't leave the process stuck stopped
        // for the next run.
        struct SigcontGuard(String);
        impl Drop for SigcontGuard {
            fn drop(&mut self) {
                let _ = std::process::Command::new("pkill")
                    .args(["-CONT", "-f", &self.0])
                    .status();
            }
        }
        // Scoped to THIS test's own ssh attach child by its unique
        // `conversation_id` (present in the remote command line ssh execs,
        // `--conversation <uuid>` — see `build_remote_command`), not just
        // "2224.*flightdeckd.*attach": that looser pattern would also match a
        // DIFFERENT live test's attach child if run concurrently against the
        // same m1 container (the default multi-threaded test harness the repo
        // documents for `--ignored` runs), SIGSTOPping someone else's link too.
        let ssh_child_pattern = format!("2224.*flightdeckd.*attach.*{conversation_id}");
        let _sigcont_guard = SigcontGuard(ssh_child_pattern.clone());
        let stopped = std::process::Command::new("pkill")
            .args(["-STOP", "-f", &ssh_child_pattern])
            .status()
            .expect("pkill should run");
        assert!(stopped.success(), "expected to SIGSTOP the live ssh attach client");
        eprintln!("[live] ssh attach child SIGSTOPped mid-burst");

        // Let the whole burst land daemon-side (the daemon's write blocks once the
        // in-flight buffers are full and our client stops reading), polled over a
        // FRESH ssh call each time — unaffected by the paused one.
        let status_flags = ssh_flags.clone();
        let poll_deadline = std::time::Instant::now() + Duration::from_secs(300);
        loop {
            assert!(
                std::time::Instant::now() < poll_deadline,
                "burst turn did not finish daemon-side within 300s"
            );
            let out = std::process::Command::new("ssh")
                .args(&status_flags)
                .args(["flightdeckd", "status"])
                .output()
                .expect("status ssh call should run");
            if out.status.success() {
                if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                    let busy = v
                        .get("conversations")
                        .and_then(|c| c.as_array())
                        .and_then(|rows| {
                            rows.iter().find(|c| {
                                c.get("conversation").and_then(|x| x.as_str())
                                    == Some(conversation_id.as_str())
                            })
                        })
                        .and_then(|row| row.get("busy"))
                        .and_then(|b| b.as_bool());
                    if busy == Some(false) {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        eprintln!(
            "[live] burst turn finished daemon-side; waiting {}s more (ATTACH_WRITE_TIMEOUT + margin)",
            ATTACH_WRITE_TIMEOUT_SECS + 5
        );
        tokio::time::sleep(Duration::from_secs(ATTACH_WRITE_TIMEOUT_SECS + 5)).await;

        // SIGCONT and let the actor's own reconnect take over from here.
        let resumed = std::process::Command::new("pkill")
            .args(["-CONT", "-f", &ssh_child_pattern])
            .status()
            .expect("pkill should run");
        assert!(resumed.success(), "expected to SIGCONT the stalled ssh client");
        eprintln!("[live] ssh attach child SIGCONTed");

        // The actor must reconnect on its own, replay, and the turn must complete —
        // with NO duplicated, garbled, or missing message. `phase` tags every item
        // with which transport delivered it (diagnostic only): 0 = the ORIGINAL
        // (pre-pause) transport, still draining whatever the daemon buffered while
        // paused, right up to EOF; 1+ = after the actor's own reconnect(s).
        let mut phase: u32 = 0;
        let mut reconnected = false;
        let mut message_ids: Vec<(u32, String)> = Vec::new();
        let mut tool_use_ids: Vec<(u32, String)> = Vec::new();
        let mut done_seen = false;
        let mut result: Option<bool> = None;
        let t0 = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(120), async {
            while let Some(ev) = event_rx.recv().await {
                match ev {
                    SessionEvent::Item(ConversationItem::Notice { ref subtype, ref detail })
                        if subtype == "remote_link" =>
                    {
                        eprintln!("[live +{:>5.1}s] remote_link: {detail}", t0.elapsed().as_secs_f32());
                        let msg = detail["message"].as_str().unwrap_or_default();
                        if msg.contains("Reconnected") {
                            reconnected = true;
                        }
                        if msg.contains("lost") {
                            phase += 1;
                        }
                    }
                    SessionEvent::Item(ConversationItem::AssistantMessage { ref id, ref blocks, .. }) => {
                        eprintln!("[live +{:>5.1}s] phase {phase} AssistantMessage {id}", t0.elapsed().as_secs_f32());
                        message_ids.push((phase, id.clone()));
                        for b in blocks {
                            if let crate::supervisor::model::NormalizedBlock::Text { text } = b {
                                if text.contains("DONE_D") {
                                    done_seen = true;
                                }
                            }
                        }
                    }
                    SessionEvent::Item(ConversationItem::TextDelta { ref text, .. }) if text.contains("DONE_D") => {
                        done_seen = true;
                    }
                    SessionEvent::Item(ConversationItem::ToolResult { ref tool_use_id, .. }) => {
                        eprintln!(
                            "[live +{:>5.1}s] phase {phase} ToolResult {tool_use_id}",
                            t0.elapsed().as_secs_f32()
                        );
                        tool_use_ids.push((phase, tool_use_id.clone()));
                    }
                    SessionEvent::Item(ConversationItem::TurnResult { is_error, .. }) => {
                        eprintln!("[live +{:>5.1}s] TurnResult is_error={is_error}", t0.elapsed().as_secs_f32());
                        result = Some(!is_error);
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("the stalled turn should still complete after auto-reconnect + replay");

        drop(_sigcont_guard); // already resumed above; this is now a harmless no-op CONT

        let _ = std::process::Command::new("ssh")
            .args(&ssh_flags)
            .arg(format!("rm -rf {burst_dir}"))
            .status();
        let _ = std::process::Command::new("ssh")
            .args(&ssh_flags)
            .args(["flightdeckd", "stop", "--conversation", &conversation_id])
            .status();
        handle.shutdown_and_wait_stopping().await.ok();

        assert!(reconnected, "expected a 'Reconnected to the server.' notice after SIGCONT");
        assert_eq!(result, Some(true), "the stalled turn's result should arrive via replay");
        assert!(done_seen, "the DONE_D reply should be present in the replayed transcript");
        // `phase` must actually straddle the pause: some items delivered live
        // BEFORE it (phase 0), some only via replay AFTER reconnect (phase 1+).
        // Without this, the assertions below would pass identically whether the
        // SIGSTOP genuinely interrupted mid-burst or the whole thing streamed
        // live before the pause ever took effect (or vice versa) — the exact
        // failure mode this test exists to rule out.
        assert!(
            message_ids.iter().any(|(p, _)| *p == 0),
            "nothing was delivered live before the pause — the SIGSTOP didn't land \
             mid-burst: {message_ids:?}",
        );
        assert!(
            tool_use_ids.iter().any(|(p, _)| *p >= 1),
            "nothing was delivered via replay after reconnect — the pause never \
             actually interrupted the stream: {tool_use_ids:?}",
        );

        // `AssistantMessage` is a RECONCILING update, not an append-only event — its
        // doc comment is explicit: "carries the SAME id as the streamed
        // `message_start` — the UI reconciles". Confirmed live: a message with one
        // `tool_use` block legitimately arrives as `AssistantMessage` twice back to
        // back, WITHIN THE SAME phase (once as its content block completes, once at
        // `message_stop`), even with NO reconnect involved. That is a normal
        // "redraw with the same id", not a replay bug — the invariant D4 actually
        // cares about is that no id repeats beyond that normal double-fire: group
        // ADJACENT, SAME-PHASE runs of the same id (`dedup_by` alone is not enough —
        // it ignores `phase`, so a genuine replay duplicate that happens to land
        // right next to the message's own normal double-fire would be silently
        // swallowed with it), cap every such run at 2, THEN the collapsed ids must
        // already be globally unique (a same id split across two DIFFERENT phases,
        // or a same-phase run longer than 2, is exactly what a cursor/replay bug
        // would look like).
        let mut coalesced_groups: Vec<(u32, String, usize)> = Vec::new();
        for (phase, id) in &message_ids {
            match coalesced_groups.last_mut() {
                Some(last) if last.0 == *phase && &last.1 == id => last.2 += 1,
                _ => coalesced_groups.push((*phase, id.clone(), 1)),
            }
        }
        for (phase, id, run_len) in &coalesced_groups {
            assert!(
                *run_len <= 2,
                "assistant message {id} repeated {run_len} times back-to-back within \
                 phase {phase} — expected at most the normal content-block/message_stop \
                 double-fire: {message_ids:?}",
            );
        }
        let mut sorted_ids: Vec<&String> = coalesced_groups.iter().map(|(_, id, _)| id).collect();
        sorted_ids.sort();
        let coalesced_count = sorted_ids.len();
        sorted_ids.dedup();
        assert_eq!(
            sorted_ids.len(),
            coalesced_count,
            "an assistant message id reappeared across a phase boundary (or a distinct \
             same-phase run) — a genuine replay duplicate, not just a reconciling redraw \
             (phase, id): {message_ids:?}",
        );
        // `ToolResult` has no such reconciling redraw (one-shot, unlike
        // `AssistantMessage`) — every id must be unique outright.
        let mut dedup_tools: Vec<&String> = tool_use_ids.iter().map(|(_, id)| id).collect();
        dedup_tools.sort();
        dedup_tools.dedup();
        assert_eq!(
            dedup_tools.len(),
            tool_use_ids.len(),
            "no tool_use_id should be delivered twice (phase, id): {tool_use_ids:?}",
        );
        // 4 Bash echos + 4 Reads = 8 tool results expected in a clean, non-garbled run.
        assert_eq!(
            tool_use_ids.len(),
            8,
            "expected exactly 8 tool results (4 Bash + 4 Read), none missing/duplicated: \
             {tool_use_ids:?}",
        );
    }
}
