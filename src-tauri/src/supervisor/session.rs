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
/// by Shutdown.
async fn run_actor(
    mut core: SessionCore,
    mut transport: Transport,
    mut msg_rx: mpsc::UnboundedReceiver<CliMessage>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    cfg: SpawnConfig,
) {
    core.initialize();
    // A caller that wants to WAIT for the process to be reaped passes a oneshot on the
    // Shutdown command; we fire it only after `transport.shutdown()` below has run.
    let mut shutdown_ack: Option<oneshot::Sender<()>> = None;
    let mut stop_remote = false;
    // Remote reattach state, learned from the daemon's fd_attach handshake.
    let mut attach = cfg.attach.clone().unwrap_or_default();
    let mut attach_base: u64 = attach.cursor;
    // Set when the daemon closed the stream ON PURPOSE (replaced / stopped /
    // exited / error) — auto-reconnect must not fight that.
    let mut no_reconnect: Option<String> = None;
    // Why the loop ended: a spontaneous transport close (the process died on its own)
    // must be EXPLAINED in the conversation, while a requested Shutdown is expected.
    let process_gone = 'outer: loop {
        // Drive the CURRENT transport until it closes or a Shutdown lands.
        loop {
            tokio::select! {
                maybe_msg = msg_rx.recv() => match maybe_msg {
                    Some(CliMessage::FdAttach(a)) => {
                        attach.conversation = Some(a.conversation);
                        attach.epoch = Some(a.epoch);
                        attach_base = a.replay_from;
                    }
                    Some(CliMessage::FdDetach(d)) => {
                        if d.reason == "error" {
                            core.emit_error_notice("error", json!({
                                "message": d.message.clone().unwrap_or_else(|| "remote attach failed".to_string()),
                            }));
                        }
                        no_reconnect = Some(d.reason);
                    }
                    Some(msg) => core.on_message(msg),
                    None => break, // transport closed
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
        // Remote link lost while the server-side session lives on: reconnect.
        let cursor = attach_base + transport.lines_seen();
        transport.shutdown(false).await; // reap the dead ssh client quietly
        core.emit_error_notice("remote_link", json!({
            "message": "Connection to the server lost — reconnecting…",
        }));
        let mut delay = std::time::Duration::from_secs(1);
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
            });
            match Transport::spawn(cfg2) {
                Ok((t, rx)) => {
                    transport = t;
                    msg_rx = rx;
                    core.set_outbound(transport.outbound());
                    core.emit_error_notice("remote_link", json!({
                        "message": "Reconnected to the server.",
                    }));
                    continue 'outer;
                }
                Err(e) => {
                    eprintln!("[session] remote reconnect failed (retrying in {delay:?}): {e}");
                    delay = (delay * 2).min(std::time::Duration::from_secs(30));
                }
            }
        }
    };
    // The process vanished without us asking: surface why (exit code + last stderr)
    // so a crash / OOM / auth failure mid-turn is never a silent stop.
    if process_gone {
        let status = transport.wait_status().await;
        core.emit_process_exit(
            status,
            transport.reader_error(),
            transport.writer_error(),
            transport.stderr_tail(),
        );
    }
    // Announce the end so the UI stops showing a live session.
    core.emit_ended();
    // Drop the core (and its outbound sender clone) so the writer's channel can
    // close and stdin can EOF, then run the graceful teardown ladder.
    drop(core);
    transport.shutdown(stop_remote).await;
    // Let the owner (e.g. the IPC registry) evict this dead session.
    on_exit();
    // The process is now fully reaped: release any caller waiting on `shutdown_and_wait`
    // (a rewind about to truncate this session's transcript). A dropped receiver (caller
    // timed out / gave up) is fine — the send just fails silently.
    if let Some(ack) = shutdown_ack {
        let _ = ack.send(());
    }
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
            pending_mcp: HashMap::new(),
            pending_mcp_auth: HashMap::new(),
            pending_query: HashMap::new(),
            pending_remote_control: HashMap::new(),
            next_req: 0,
            outbound,
            appmcp,
        }
    }

    /// Swap the outbound line sender for a NEW transport's writer — the remote
    /// reconnect path. The core's state (assembler, pendings) carries over; only
    /// the pipe changes.
    fn set_outbound(&mut self, tx: mpsc::UnboundedSender<Value>) {
        self.outbound = tx;
    }

    /// The claude session id the assembler learned from `system/init`, if any.
    fn session_id(&self) -> Option<String> {
        self.assembler.state().session_id.clone()
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
        }
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
            | PendingControl::McpClearAuth => {}
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

    /// Live M1 acceptance check, Mac side: "piloting a remote session from the
    /// Mac must survive a network cut". Full actor path: spawn a real remote
    /// session (ssh → flightdeckd → daemon-owned claude), start a slow tool
    /// turn, SIGKILL the ssh client mid-turn (the network cut), and assert the
    /// ACTOR reconnects by itself and the turn's result still arrives (the
    /// daemon kept the session alive and replayed what we missed).
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (flightdeck-server: `m1-daemon/scripts/up.sh`). Run with:
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
}
