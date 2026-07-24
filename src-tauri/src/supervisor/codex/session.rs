//! The Codex conversation actor — the Codex sibling of `session::run_actor`.
//!
//! One `run_codex_actor` per Codex conversation: it opens a thread on the shared
//! [`CodexServer`], then drives a `select!` loop over the conversation's inbound
//! app-server messages (routed to it by threadId) and the UI's [`SessionCommand`]s,
//! translating BOTH into the SAME normalized [`SessionEvent`]s the Claude backend
//! emits — so the entire front (rendering, status, clean-output) is reused verbatim.
//!
//! The teardown order mirrors `session::run_actor` byte-for-byte in SHAPE (invariant
//! #4): explain a spontaneous death → announce the end → close the thread → evict from
//! the registry → fire the shutdown ack LAST (the synchronous-stop contract a rewind
//! relies on). The base layer emits enough to "answer text"; rich item rendering is 4.1.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::supervisor::control::PermissionDecision;
use crate::supervisor::model::{
    BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, ConversationItem, McpAuthResult,
    McpServerLive, NormalizedBlock, PermissionRequestPayload, RemoteControlState, SessionEmitter,
    SessionStatePayload,
};
use crate::supervisor::session::{InitialControls, SessionCommand, SessionError, SessionHandle};
use crate::supervisor::transport::{ImageAttachment, SpawnConfig, TransportError};

use super::protocol::{
    reply_result, CodexControls, CommandApprovalParams, ErrorNotification, FileChangeApprovalParams,
    Incoming, ItemDelta, ItemEnvelope, RateLimitSnapshot, RateLimitWindow, ThreadItem,
    TurnCompleted, TurnStartParams, TurnStartResult, UserInput,
};
use super::server::{CodexError, CodexServer};

/// Spawn a Codex session: start the actor task and return a handle to drive it. The
/// signature MIRRORS [`crate::supervisor::session::spawn_session`] (same `SpawnConfig`
/// / `InitialControls` / emitter / `on_exit`) plus the shared [`CodexServer`], so the
/// IPC dispatch is a clean `match` at the single spawn point. `initial` is unused at
/// the base layer (model/effort/permission mapping lands in 4.1).
pub fn spawn_session(
    id: String,
    cfg: SpawnConfig,
    _initial: InitialControls,
    emitter: Arc<dyn SessionEmitter>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    server: Arc<CodexServer>,
) -> Result<SessionHandle, SessionError> {
    // Mirror the Claude transport's SYNCHRONOUS cwd guard (transport.rs): the IPC
    // caller's contract is "Err ⇒ recoverable spawn failure" — on it the front detects
    // a deleted worktree cwd and re-spawns in the repo's main checkout, re-delivering
    // the user's message. Failing only asynchronously (an actor notice) would skip
    // that recovery and LOSE the message. Same error type + wording as Claude so both
    // backends surface the identical, actionable cause.
    if !cfg.cwd.exists() {
        return Err(SessionError::Spawn(TransportError::CwdMissing(cfg.cwd.clone())));
    }
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    tokio::spawn(run_codex_actor(id.clone(), cfg, emitter, cmd_rx, on_exit, server));
    Ok(SessionHandle::from_channel(id, cmd_tx))
}

async fn run_codex_actor(
    id: String,
    cfg: SpawnConfig,
    emitter: Arc<dyn SessionEmitter>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    server: Arc<CodexServer>,
) {
    let mut core = CodexCore::new(id, emitter);

    // Handshake + open this conversation's thread. When the conversation carries a
    // persisted thread id (`cfg.resume`, the analogue of Claude's `--resume`), RESUME it
    // by id so continuing a cold-loaded conversation keeps its full prior context and a
    // STABLE id; otherwise open a fresh thread. A failure here (server won't spawn, cwd
    // vanished, handshake rejected) is surfaced as a visible notice and a clean end —
    // never a silent dead session (invariant #6).
    let model = codex_model(&cfg);
    let resuming = cfg.resume.as_deref().filter(|s| !s.is_empty());
    let open = match resuming {
        Some(resume_id) => server.resume_thread(&cfg.cwd, resume_id, model.as_deref()).await,
        None => server.start_thread(&cfg.cwd, model.as_deref()).await,
    };
    let (thread_id, mut inbound) = match open {
        Ok(pair) => pair,
        Err(e) => {
            // A fresh-start OR a resume failure both end the session cleanly with a surfaced
            // notice (invariant #6). ⚠️ On a RESUME failure we deliberately DO NOT fall back to
            // a fresh `start_thread`: that would mint a NEW thread id, which the front persists
            // over the conversation's real id (`noteSessionId`), ORPHANING the on-disk rollout
            // and permanently hiding its cold history — a silent data loss. Ending here keeps
            // the id (and thus the history) intact; a transient failure (RPC timeout on the
            // shared server) is recoverable by simply resending.
            let msg = if resuming.is_some() {
                format!("Couldn't resume the Codex conversation: {e}. History is kept — try sending again.")
            } else {
                e.to_string()
            };
            core.emit_notice("process_exited", &msg);
            core.emit_ended();
            on_exit();
            return;
        }
    };
    core.on_thread_started(&thread_id, &cfg);

    // Seed the plan ring with a full snapshot right away: the `account/rateLimits/updated`
    // push is SPARSE (may carry only a changed window) and may not arrive until the first
    // turn, so pull the current picture once. DETACHED (spawned) so it never delays the
    // actor's first command; best-effort — a failure just leaves the ring to fill from the
    // first push (a pure optimisation with a guaranteed fallback, so the swallow is safe).
    {
        let server = Arc::clone(&server);
        let emitter = Arc::clone(&core.emitter);
        let id = core.id.clone();
        tokio::spawn(async move {
            if let Ok(v) = server.request("account/rateLimits/read", Value::Null).await {
                let snap = v.get("rateLimits").cloned().unwrap_or(Value::Null);
                if let Ok(parsed) = serde_json::from_value::<RateLimitSnapshot>(snap) {
                    if let Some(usage) = rate_limits_to_plan_usage(&parsed) {
                        emitter.emit_codex_plan_usage(&id, &usage);
                    }
                }
            }
        });
    }

    let mut shutdown_ack: Option<oneshot::Sender<()>> = None;
    let server_gone = loop {
        tokio::select! {
            maybe_in = inbound.recv() => match maybe_in {
                Some(inc) => core.on_incoming(inc),
                None => break true, // route/server closed: the app-server died
            },
            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(SessionCommand::Shutdown { ack }) => { shutdown_ack = ack; break false; }
                None => break false, // command channel closed: requested stop
                Some(cmd) => core.on_command(cmd, &thread_id, &server).await,
            },
        }
    };

    // Same teardown ORDER as the Claude actor (session.rs:400-424):
    if server_gone {
        core.emit_notice(
            "process_exited",
            "the codex app-server stopped unexpectedly",
        );
    } else {
        // An approval the demux ROUTED to us may still be sitting UNPROCESSED in `inbound`
        // when the loop broke (`select!` can take the command branch over a ready inbound).
        // It never entered `pending_approvals`, so drain and `cancel` it here too — else it
        // leaks unanswered and wedges the shared server's turn forever (M1).
        while let Ok(inc) = inbound.try_recv() {
            if let Incoming::ServerRequest { id, .. } = inc {
                server
                    .reply(reply_result(&id, json!({ "decision": "cancel" })))
                    .await;
            }
        }
        // Release any approval already surfaced (in `pending_approvals`) FIRST — an
        // unanswered server-request wedges the shared process — THEN stop the turn itself.
        // Turning the stream OFF (or a rewind) must actually STOP an in-flight turn on the
        // SHARED app-server, not just detach from it — otherwise it keeps running (burning
        // quota, writing the rollout) even though the conversation reads as off. The Claude
        // backend gets this for free by killing its own process; the shared Codex server
        // can't be killed (it serves the OTHER conversations), so we cancel + interrupt.
        core.decline_pending_approvals(&server).await;
        core.interrupt_if_active(&thread_id, &server).await;
    }
    core.emit_ended();
    // Drop this thread's route; if it was the last, the server tears down gracefully.
    server.close_thread(&thread_id).await;
    // Evict the dead session from the IPC registry.
    on_exit();
    // Best-effort cleanup of this session's materialized image attachments (pasted
    // screenshots can hold secrets — never leave them to the OS temp reaper alone).
    core.cleanup_images_dir();
    // Release a `shutdown_and_wait` caller LAST — after the pending approvals were
    // cancelled, the in-flight turn was interrupted (`interrupt_if_active` above, on
    // the requested-stop path), we stopped consuming this conversation's inbound, and
    // its route was dropped. ⚠️ `interrupt_if_active` awaits only the `turn/interrupt`
    // RPC *response*, not the turn's terminal notification — a rewind that truncates
    // the rollout (phase 4.x) may additionally want to await `turn/completed` here
    // before cutting, or it could race the tail of a still-flushing writer.
    if let Some(ack) = shutdown_ack {
        let _ = ack.send(());
    }
}

/// Per-conversation protocol state + the mapping app-server ⇄ [`SessionEvent`]. Holds
/// its OWN small [`SessionStatePayload`]; it never reuses the Claude `Assembler`
/// (which parses stream-json), per invariant #8.
/// The last `mcpServer/startupStatus/updated` push we saw for one MCP server, kept per
/// actor so the on-demand `mcpServerStatus/list` fetch — whose entries carry NO
/// status/failure field — can be enriched with WHY a server failed to start. Overwritten
/// on each push, so a later `ready`/`starting` clears a stale `failed`.
#[derive(Debug, Clone)]
struct McpStartupStatus {
    /// `starting` / `ready` / `failed` / `cancelled` (`McpServerStartupState`).
    state: String,
    /// Structured failure reason (`reauthenticationRequired`), present when `state==failed`.
    failure_reason: Option<String>,
    /// Free-text error the server reported alongside a failure, when present.
    error: Option<String>,
}

struct CodexCore {
    id: String,
    emitter: Arc<dyn SessionEmitter>,
    state: SessionStatePayload,
    /// Message ids we have already opened a `MessageStarted` for. A `TextDelta` /
    /// `ThinkingDelta` is dropped by the front unless its turn already exists and is
    /// streaming, so we emit `MessageStarted` once per item id before its first delta.
    /// Reasoning and assistant-message items each get their own id → their own bubble.
    streaming_ids: HashSet<String>,
    /// Tool item ids that have been carded THIS turn. Gates card emission so a card is
    /// synthesized at most once even across a duplicate/late `item/*` — distinct from
    /// `open_tools`, which is emptied on completion (so it can't double as the card key).
    carded: HashSet<String>,
    /// Tool item ids with a synthesized `ToolUse` but not yet a `ToolResult`. Gates result
    /// emission (no duplicate result) and lets us close any card still open when the turn
    /// ends (interrupted mid-command) — a `ToolUse` with no `ToolResult` renders "running"
    /// forever, so the clean-output round would never fold.
    open_tools: HashSet<String>,
    /// ServerRequest ids of approvals awaiting the user's yes/no (a shell command or file
    /// patch under `approvalPolicy:"on-request"`). We MUST reply to each — on answer, or a
    /// `cancel` at teardown — or the shared app-server blocks that turn forever.
    pending_approvals: HashSet<String>,
    /// The live turn's id, captured from the `turn/start` response and refreshed from
    /// turn-scoped notifications. `turn/interrupt` REQUIRES it alongside the threadId, so
    /// without it the stream-control button can't stop a Codex turn. `None` between turns.
    current_turn_id: Option<String>,
    /// `clientUserMessageId`s WE stamped on `turn/start`. The server echoes each back as the
    /// `userMessage` item's `clientId`, so an item whose id is in here is our own turn
    /// (already shown optimistically) and an item whose id is NOT is a turn that came in
    /// over the bridge — the Codex analogue of the Claude assembler's `sent_user_uuids`.
    /// Consumed on match, so the set self-bounds to in-flight sends.
    sent_client_ids: HashSet<String>,
    /// Wall-clock start of the live turn, stamped when we send `turn/start` (the same edge
    /// as the front's `turnStartedAt`). Consumed at `turn/completed` to fill the timeline
    /// `TurnResult.duration_ms` — Codex's `turn/completed` carries NO server-measured turn
    /// duration (unlike Claude's `result`), so without this the finished-turn footer would
    /// stay hidden on Codex. `None` between turns.
    turn_started_at: Option<Instant>,
    /// The conversation's latest composer controls (model / effort / approval / sandbox
    /// / …), refreshed from each `SendUser` and re-asserted as per-turn overrides on
    /// every `turn/start` — the app-server has no separate settings channel.
    controls: CodexControls,
    /// The controls the backend ACTUALLY consumed on the last `turn/start` we emitted.
    /// Codex has no settings channel: a control change only takes effect (and is only
    /// "confirmed") when the next turn carries it as an override — so this is diffed
    /// against `controls` at each `turn/start` Ok to surface a `control_change` timeline
    /// notice ONLY at that confirmed moment (never on the composer click, never on a
    /// `turn/steer`, which carries no overrides). `None` until the first confirmed turn:
    /// that turn seeds the baseline SILENTLY (no phantom transition), mirroring the Claude
    /// assembler's `Announced` baseline logic.
    applied_controls: Option<CodexControls>,
    /// This session's PRIVATE dir for materialized image attachments (Codex reads
    /// images from a file PATH, not base64 — see [`materialize_image`]). Created
    /// lazily on first image, removed best-effort at actor teardown
    /// ([`Self::cleanup_images_dir`]) so pasted screenshots (which can hold secrets)
    /// don't linger. Uuid-suffixed: unique across app restarts AND concurrent builds
    /// sharing `$TMPDIR`.
    images_dir: PathBuf,
    /// Per-server last-known startup status from the `mcpServer/startupStatus/updated`
    /// push, keyed by server name. Merged into the `McpServerLive` rows on the next
    /// `mcp_status` fetch so a server that failed to start shows its reason instead of a
    /// mute "disconnected" (the `mcpServerStatus/list` entry has no failure field).
    mcp_startup_status: HashMap<String, McpStartupStatus>,
    /// Phase 4.5 (Bloc C) — per-sub-agent metadata, keyed by the sub-agent's THREAD id.
    /// Codex's multi-agent (`collabAgentToolCall` / `subAgentActivity`) is in-turn fan-out
    /// on separate threads our demux does NOT route; the only live signal is the parent's
    /// cumulative `agentsStates` snapshot. This map carries what those snapshots omit — the
    /// sub-agent's NAME (from `subAgentActivity.agentPath`) and the MODEL it was spawned on
    /// (from the `spawnAgent` collab item) — so each `emit_subagent_task` re-emits a stable,
    /// enriched [`BackgroundTask`] (kind `Agent`) keyed by that thread id. Session-scoped
    /// (sub-agents persist across turns via `resumeAgent`); never reset per turn.
    codex_subagents: HashMap<String, CodexSubAgentMeta>,
}

/// The bits of a Codex sub-agent a single `agentsStates` snapshot does not carry, accumulated
/// across the collab/activity items that DO (see [`CodexCore::codex_subagents`]).
#[derive(Default, Clone)]
struct CodexSubAgentMeta {
    /// Readable sub-agent name (tail of `subAgentActivity.agentPath`).
    name: Option<String>,
    /// Model the sub-agent was spawned on (`spawnAgent` collab item only).
    model: Option<String>,
    /// Last non-empty `agentsStates` message. Remembered so a `subAgentActivity` re-emit
    /// (which carries no message) does not blank the live progress back to `None` between
    /// two collab snapshots.
    progress: Option<String>,
    /// The last status we published for this sub-agent. Lets a turn end settle any that is
    /// still `Running` (see [`CodexCore::settle_running_subagents`]) — Codex sub-agents run
    /// in-turn, so a lingering "running" once the turn is over is stale (no fleet false-green).
    last_status: Option<BackgroundTaskStatus>,
}

impl CodexCore {
    fn new(id: String, emitter: Arc<dyn SessionEmitter>) -> Self {
        Self {
            id,
            emitter,
            state: SessionStatePayload::default(),
            streaming_ids: HashSet::new(),
            carded: HashSet::new(),
            open_tools: HashSet::new(),
            pending_approvals: HashSet::new(),
            current_turn_id: None,
            sent_client_ids: HashSet::new(),
            turn_started_at: None,
            controls: CodexControls::default(),
            applied_controls: None,
            images_dir: std::env::temp_dir()
                .join("flightdeck-codex-attachments")
                .join(uuid::Uuid::new_v4().to_string()),
            mcp_startup_status: HashMap::new(),
            codex_subagents: HashMap::new(),
        }
    }

    /// Remove this session's attachments dir (see [`materialize_image`]). Best-effort:
    /// a failure is non-fatal (the OS temp reaper collects the dir eventually), but
    /// logged so it never disappears without trace. What REMAINS on disk after a hard
    /// kill (no teardown runs): the session dir under
    /// `$TMPDIR/flightdeck-codex-attachments/`, until the OS reaps it.
    fn cleanup_images_dir(&self) {
        match std::fs::remove_dir_all(&self.images_dir) {
            Ok(()) => {}
            // No image was ever materialized (the dir is created lazily).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!(
                "[codex-session] failed to clean attachments dir {}: {e}",
                self.images_dir.display()
            ),
        }
    }

    fn push_state(&self) {
        self.emitter.emit_state(&self.id, &self.state);
    }

    fn push_item(&self, item: ConversationItem) {
        self.emitter.emit_item(&self.id, &item);
    }

    /// Phase 4.5 (Bloc C) — surface a Codex sub-agent as a fleet [`BackgroundTask`], so it is
    /// counted + listed exactly like a Claude sub-agent (BackgroundTaskBadge / AgentBar / fleet
    /// readout), reusing the whole shared background-task pipeline (`emit_task` → `session_task`).
    /// Keyed by the sub-agent's THREAD id (stable across the collab items that reference it →
    /// replace-by-`task_id` keeps the latest status). `tool_use_id`/`output_file` are `None`: the
    /// sub-agent's own thread is NOT routed to us (no transcript to drill, no per-agent stop), so
    /// the front renders these display-only — and a Codex tool card, having no correlated task,
    /// keeps `atomStillRunning`'s foreground-safe `!tool_result` fallback (Bloc A). Terminal
    /// reconciliation rides the cumulative `agentsStates` snapshots; session-end (running→stopped)
    /// is the backstop.
    fn emit_subagent_task(&mut self, thread_id: &str, status: BackgroundTaskStatus, message: Option<String>) {
        // Track the last published status so a turn end can settle any sub-agent still flagged
        // live (see settle_running_subagents). Done first, as its own borrow, so the reads below
        // don't overlap this mutable borrow of `codex_subagents`.
        self.codex_subagents.entry(thread_id.to_string()).or_default().last_status = Some(status);
        let meta = self.codex_subagents.get(thread_id);
        let name = meta.and_then(|m| m.name.clone());
        let model = meta.and_then(|m| m.model.clone());
        // A message-less emit (a `subAgentActivity` lifecycle marker) keeps the last known
        // progress instead of blanking it — the agentsStates message only rides collab items.
        let progress = message.or_else(|| meta.and_then(|m| m.progress.clone()));
        self.emitter.emit_task(
            &self.id,
            &BackgroundTask {
                task_id: thread_id.to_string(),
                kind: BackgroundTaskKind::Agent,
                tool_use_id: None,
                // The sub-agent's name (agentPath tail) IS the prominent line; leaving
                // `subagent_type` empty avoids echoing it a second time as a meta chip.
                label: Some(name.unwrap_or_else(|| "Sub-agent".to_string())),
                command: None,
                subagent_type: None,
                model,
                agent_id: Some(thread_id.to_string()),
                status,
                progress,
                tokens: None,
                tool_uses: None,
                duration_ms: None,
                summary: None,
                output_file: None,
            },
        );
    }

    /// Phase 4.5 (Bloc C) — promote a `collabAgentToolCall`'s per-sub-agent `agentsStates`
    /// ({threadId → {status, message}}) into fleet tasks, one per sub-agent thread. Every collab
    /// item (spawn / wait / closeAgent) carries the FULL cumulative snapshot, so re-emitting on
    /// each keeps the store's replace-by-`task_id` current. A `spawnAgent` additionally pins the
    /// receivers' model (later items don't re-carry it).
    fn ingest_collab_states(
        &mut self,
        tool: &str,
        model: Option<&str>,
        receiver_thread_ids: &[String],
        agents_states: &Value,
    ) {
        if tool == "spawnAgent" {
            if let Some(m) = model.filter(|m| !m.is_empty()) {
                for tid in receiver_thread_ids {
                    self.codex_subagents.entry(tid.clone()).or_default().model = Some(m.to_string());
                }
            }
        }
        let Some(map) = agents_states.as_object() else {
            return;
        };
        for (tid, state) in map {
            let status = collab_status_to_task_status(state.get("status").and_then(Value::as_str));
            let message = state
                .get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_string);
            // Remember a fresh progress so a later `subAgentActivity` re-emit preserves it.
            if message.is_some() {
                self.codex_subagents.entry(tid.clone()).or_default().progress = message.clone();
            }
            self.emit_subagent_task(tid, status, message);
        }
    }

    /// Normalize a `rateLimits` snapshot (from the `account/rateLimits/updated` push or
    /// the `account/rateLimits/read` response) into the shared [`crate::usage::PlanUsage`]
    /// and emit it. A snapshot with no usable window (both absent) is dropped — never a
    /// spurious empty plan. Decode failures are ignored (tolerance rule 3).
    fn ingest_rate_limits(&self, snapshot: Value) {
        let Ok(snap) = serde_json::from_value::<RateLimitSnapshot>(snapshot) else {
            return;
        };
        if let Some(usage) = rate_limits_to_plan_usage(&snap) {
            self.emitter.emit_codex_plan_usage(&self.id, &usage);
        }
    }

    /// A visible timeline notice (the single "zero silent error" channel, shared with
    /// the Claude backend). `subtype` ∈ `process_exited` / `send_failed` /
    /// `protocol_error` / `error`.
    fn emit_notice(&self, subtype: &str, message: &str) {
        self.push_item(ConversationItem::Notice {
            subtype: subtype.to_string(),
            detail: json!({ "message": message }),
        });
    }

    /// Announce, in the timeline, each Codex control the backend JUST consumed on this
    /// `turn/start`. The FIRST confirmed turn only SEEDS the baseline (no notice); every
    /// later move emits a subtle `control_change` line — the SAME subtype + `{control,
    /// icon, from, to}` detail shape the Claude backend's `change_notice` uses, so the
    /// front's shared `NoticeRow` renders it identically (zero front divergence).
    ///
    /// The composer collapses sandbox × approval into ONE preset ("Cautious" / "Standard" /
    /// "Auto" / "Full access"), so those two axes are reported as a SINGLE "Permissions"
    /// line (reconstructed from the pair) — never two lines for one preset flip.
    fn announce_control_changes(&mut self) {
        let cur = self.controls.clone();
        // `replace` sets the new baseline and hands back the old one; `None` ⇒ first
        // confirmed turn ⇒ baseline seeded, nothing to announce (no phantom transition).
        let Some(prev) = self.applied_controls.replace(cur.clone()) else {
            return;
        };
        self.diff_control(
            "Model",
            "diamond",
            codex_model_label(prev.model.as_deref()),
            codex_model_label(cur.model.as_deref()),
        );
        self.diff_control(
            "Thinking effort",
            "bolt",
            codex_effort_label(prev.effort.as_deref()),
            codex_effort_label(cur.effort.as_deref()),
        );
        self.diff_control(
            "Permissions",
            "shield",
            codex_permissions_label(prev.sandbox.as_deref(), prev.approval_policy.as_deref()),
            codex_permissions_label(cur.sandbox.as_deref(), cur.approval_policy.as_deref()),
        );
        self.diff_control(
            "Network access",
            "globe",
            codex_bool_label(prev.network_access),
            codex_bool_label(cur.network_access),
        );
        self.diff_control(
            "Reasoning summary",
            "list",
            codex_summary_label(prev.summary.as_deref()),
            codex_summary_label(cur.summary.as_deref()),
        );
        self.diff_control(
            "Personality",
            "wand",
            codex_personality_label(prev.personality.as_deref()),
            codex_personality_label(cur.personality.as_deref()),
        );
    }

    /// Push a `control_change` notice IFF the friendly label actually moved. Same wire
    /// (subtype + detail) as the Claude backend's `change_notice`, consumed by the shared
    /// front `NoticeRow` — zero divergence.
    fn diff_control(&self, control: &str, icon: &str, from: String, to: String) {
        if from == to {
            return;
        }
        self.push_item(ConversationItem::Notice {
            subtype: "control_change".to_string(),
            detail: json!({ "control": control, "icon": icon, "from": from, "to": to }),
        });
    }

    fn emit_ended(&mut self) {
        // A spontaneous death (or any teardown) must not leave tool cards "running".
        self.close_dangling_tools();
        self.state.ended = true;
        self.state.busy = false;
        self.push_state();
    }

    /// Seed the live state the moment the thread opens: the thread id (Codex's resume
    /// key, the analogue of Claude's `session_id`) and the cwd.
    fn on_thread_started(&mut self, thread_id: &str, cfg: &SpawnConfig) {
        self.state.session_id = Some(thread_id.to_string());
        self.state.cwd = Some(cfg.cwd.to_string_lossy().to_string());
        self.push_state();
    }

    async fn on_command(&mut self, cmd: SessionCommand, thread_id: &str, server: &Arc<CodexServer>) {
        match cmd {
            SessionCommand::SendUser { text, images, controls } => {
                // Refresh the live controls from this send (they ride each user message,
                // the wire being per-turn). Images become `localImage` inputs pointing at
                // temp files the app-server reads from disk (Codex takes a path, not base64).
                if let Some(c) = controls {
                    self.controls = c;
                }
                let (input, failed_images) = user_inputs(text, &images, &self.images_dir);
                // A dropped attachment must NEVER be silent: the composer showed its
                // thumbnail, so without this the user believes the model saw an image it
                // never received (zero-silent-error rule).
                if !failed_images.is_empty() {
                    let msg = if failed_images.len() == 1 {
                        format!(
                            "an attached image couldn't be sent to Codex: {}",
                            failed_images[0]
                        )
                    } else {
                        format!(
                            "{} attached images couldn't be sent to Codex: {}",
                            failed_images.len(),
                            failed_images.join("; ")
                        )
                    };
                    self.emit_notice("send_failed", &msg);
                    // Nothing survived (no text, every image failed) → refuse the turn:
                    // the notice above told the user, and a blank turn would only burn
                    // quota for an answer to nothing.
                    if input.is_empty() {
                        return;
                    }
                }

                // A message sent WHILE a turn is in flight STEERS the active turn (Codex's
                // analogue of the CLI's mid-turn queue-injection), rather than starting a
                // second turn. `turn/steer` requires the exact active turn id.
                //
                // ⚠️ `busy` LAGS the server: it clears only when the actor DEQUEUES
                // `turn/completed`, not when the server actually finishes. So a message
                // sent just as a turn ends can find `busy` still true with a turn id that
                // has already completed → the steer is rejected. On a steer failure that is
                // PROVABLY atomic (nothing was injected — see `steer_outcome_uncertain`) we
                // FALL THROUGH to `turn/start` rather than drop the message: it can't
                // duplicate, and the message is really a fresh turn. Only a SUCCESSFUL
                // steer returns early.
                if self.state.busy {
                    if let Some(turn_id) = self.current_turn_id.clone() {
                        let params = json!({
                            "threadId": thread_id,
                            "input": &input,
                            "expectedTurnId": turn_id,
                        });
                        match server.request("turn/steer", params).await {
                            Ok(_) => return, // steered into the live turn
                            // ⚠️ A Timeout is NOT atomic: the steer WAS written to the
                            // server, which may have applied it with only its response
                            // arriving late (the pending slot is gone after 30 s, so a
                            // late success is dropped). Re-sending the same input via
                            // `turn/start` could inject the user's message TWICE —
                            // surface the uncertainty instead of guessing.
                            Err(e) if steer_outcome_uncertain(&e) => {
                                self.emit_notice(
                                    "send_failed",
                                    "the server didn't confirm the message was received in time — it may still have been injected into the current turn; check the response before resending",
                                );
                                return;
                            }
                            // Steer rejected in-band (turn already completed / not
                            // steerable) or the server is gone (the live turn died with
                            // it) → fall through and start a fresh turn below; nothing
                            // was injected, so it can't duplicate — never a silent drop.
                            Err(_) => {}
                        }
                    }
                }

                self.state.busy = true;
                // Stamp the turn's wall-clock start (consumed at turn/completed for the
                // footer duration). A steer that injected into a live turn returned earlier,
                // so reaching here is always a fresh turn.
                self.turn_started_at = Some(Instant::now());
                self.push_state();
                let mut params = TurnStartParams::new(thread_id.to_string(), input);
                // Stamp OUR id on this turn and remember it: the server echoes it back as
                // the `userMessage` item's `clientId`, which is how `on_item` tells this
                // turn (already on screen optimistically) from one typed on the phone/web.
                let client_msg_id = uuid::Uuid::new_v4().to_string();
                self.sent_client_ids.insert(client_msg_id.clone());
                params.client_user_message_id = Some(client_msg_id);
                self.controls.apply_to(&mut params);
                let params = serde_json::to_value(params).unwrap_or(Value::Null);
                match server.request("turn/start", params).await {
                    Ok(result) => {
                        // Capture the live turn id so an Interrupt can target THIS turn
                        // (turn/interrupt requires it) — even before the first notification.
                        self.current_turn_id = serde_json::from_value::<TurnStartResult>(result)
                            .ok()
                            .and_then(|r| r.turn.id);
                        // The backend has now CONSUMED this turn's control overrides — the
                        // only confirmed moment for Codex (no settings channel). Announce any
                        // control that moved. NOT reached on a failed turn/start (below) nor a
                        // successful turn/steer (returns early above, carries no overrides), so
                        // a pending change re-announces on the next confirmed turn.
                        self.announce_control_changes();
                    }
                    Err(e) => {
                        self.state.busy = false;
                        // No turn ran → drop the start stamp so it can't leak into the next
                        // turn's measured duration.
                        self.turn_started_at = None;
                        self.push_state();
                        self.emit_notice("send_failed", &e.to_string());
                    }
                }
            }
            SessionCommand::Interrupt => {
                // `turn/interrupt` REQUIRES the live turnId alongside the threadId — the
                // stream-control button is a no-op without it.
                if let Some(turn_id) = self.current_turn_id.clone() {
                    // A failed interrupt means the turn KEEPS RUNNING on the shared
                    // server (burning quota, writing the rollout) while the user believes
                    // they stopped it — surface it (mirror of the Claude backend's
                    // control_error), never a silent no-op.
                    if let Err(e) = server
                        .request(
                            "turn/interrupt",
                            json!({ "threadId": thread_id, "turnId": turn_id }),
                        )
                        .await
                    {
                        self.emit_notice("error", &format!("couldn't interrupt the turn: {e}"));
                    }
                } else if self.state.busy {
                    // Busy with NO turn id (the turn/start response parse missed it and
                    // no notification refilled it yet): the stop cannot be delivered —
                    // say so rather than silently swallowing the click.
                    self.emit_notice(
                        "error",
                        "can't interrupt: turn id not found — the turn will finish on its own",
                    );
                }
                // Not busy → nothing to interrupt; `turn/completed` settles `busy`.
            }
            SessionCommand::AnswerPermission { request_id, decision } => {
                // Reply to the routed approval server-request. Codex approvals can't rewrite
                // the tool input, so Allow → "accept" (this once); Deny → "decline".
                if self.pending_approvals.remove(&request_id) {
                    let decision = match decision {
                        PermissionDecision::Allow { .. } => "accept",
                        PermissionDecision::Deny { .. } => "decline",
                    };
                    server
                        .reply(reply_result(&request_id, json!({ "decision": decision })))
                        .await;
                    self.state.awaiting_permission = false;
                    self.push_state();
                }
                // Unknown / already-answered request id → ignore.
            }
            // Commands carrying a oneshot reply MUST be resolved, never dropped, or the
            // IPC caller blocks until its 15-30s timeout (invariant #3).
            //
            // Live MCP status for the conversation-lens Extensions view: query
            // `mcpServerStatus/list` scoped to this thread and map to the shared
            // `McpServerLive` rows. An RPC rejection is surfaced as `Err` (never a fake
            // empty — distinct from a genuinely server-less conversation).
            //
            // DETACHED (spawned): this is a STATELESS side-channel query, so we run it off
            // the actor's critical path — otherwise awaiting it inline would stop the
            // single-task actor from draining its inbound app-server stream, freezing a live
            // turn's rendering on screen until the RPC returns. The `Arc<CodexServer>` clone
            // keeps the server alive for the request; the oneshot always resolves.
            SessionCommand::McpStatus(tx) => {
                let server = Arc::clone(server);
                let thread_id = thread_id.to_string();
                // Snapshot the per-server startup statuses so the detached fetch can enrich
                // a `failed` server with its reason (the `mcpServerStatus/list` entry lacks it).
                let startup = self.mcp_startup_status.clone();
                tokio::spawn(async move {
                    let _ = tx.send(fetch_mcp_status(&server, &thread_id, &startup).await);
                });
            }
            SessionCommand::McpAuthenticate { reply, .. } => {
                let _ = reply.send(McpAuthResult {
                    error: Some("MCP authentication is not supported for Codex".into()),
                    ..McpAuthResult::default()
                });
            }
            // Native Codex remote control (`remoteControl/enable|disable`). Unlike Claude's
            // bridge (which returns a claude.ai/code URL), Codex's enable returns no URL —
            // a device is linked via a separate pairing flow, so on enable we also fetch a
            // pairing CODE (shown in the chip for the user to enter in the Codex mobile app).
            // Reachable with the plain spawn (the `experimentalApi:true` handshake enables
            // the family — verified live, no CLI flag). Per-conv reply; the app-server-global
            // `remoteControl/status/changed` push is ignored in v1 (no cross-conv coupling).
            // DETACHED (spawned): stateless remote-control RPCs off the actor's critical
            // path (same reason as McpStatus). The oneshot always resolves.
            SessionCommand::SetRemoteControl { enabled, reply, .. } => {
                let server = Arc::clone(server);
                tokio::spawn(async move {
                    let state = if enabled {
                        codex_remote_enable(&server).await
                    } else {
                        codex_remote_disable(&server).await
                    };
                    let _ = reply.send(state);
                });
            }
            // Compact the context — the native RPC (Codex has no `/compact` text command).
            // Fire-and-forget: a failure surfaces as a notice, never silent. The server
            // then emits `thread/compacted` + the next `thread/tokenUsage/updated` drops
            // the ring — no optimistic state needed here. DETACHED (spawned): stateless RPC
            // off the actor's critical path; the failure notice is emitted via a cloned
            // emitter + id (the actor keeps draining inbound meanwhile).
            SessionCommand::Compact => {
                let server = Arc::clone(server);
                let thread_id = thread_id.to_string();
                let emitter = Arc::clone(&self.emitter);
                let id = self.id.clone();
                tokio::spawn(async move {
                    if let Err(e) = server
                        .request("thread/compact/start", json!({ "threadId": thread_id }))
                        .await
                    {
                        emitter.emit_item(
                            &id,
                            &ConversationItem::Notice {
                                subtype: "send_failed".to_string(),
                                detail: json!({
                                    "message": format!("couldn't compact context: {e}")
                                }),
                            },
                        );
                    }
                });
            }
            // Auto-title. Claude asks the binary (a free Haiku call over
            // `generate_session_title`); Codex has NO free server-side title RPC, so we ask a
            // cheap model directly on a one-shot ephemeral `read-only` turn, and fall back to a
            // truncation if that fails. Emitted on the SAME `SessionTitleEvent` wire the front
            // applies. DETACHED (spawned): the model turn must NOT block the actor draining its
            // live app-server stream (a title takes seconds); the ephemeral turn uses its OWN
            // server, so it's fully decoupled from this conversation's thread. Emit via a cloned
            // emitter + id; `seq` rides through so the front drops a stale/out-of-order apply.
            SessionCommand::GenerateTitle { description, seq } => {
                let emitter = Arc::clone(&self.emitter);
                let id = self.id.clone();
                let cwd = self
                    .state
                    .cwd
                    .clone()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir);
                tokio::spawn(async move {
                    // Cheap title model; on failure (unavailable / timeout / empty) fall back to
                    // a truncation so the conversation still gets a name.
                    let title = super::generate_title(&description, Some("gpt-5.4-mini"), &cwd)
                        .await
                        .or_else(|| codex_title_from_description(&description));
                    if let Some(title) = title {
                        emitter.emit_title(&id, &title, seq);
                    }
                });
            }
            // Everything else has no base-layer equivalent on Codex → a clean no-op. (Summary /
            // remaining MCP mutations / plugins / stop-task land across phases 4.4-4.5.)
            // ⚠️ Any FUTURE `SessionCommand` variant carrying a `oneshot` reply MUST be matched
            // explicitly ABOVE this arm and resolve its reply — falling into this no-op would
            // hang the IPC caller for its timeout.
            _ => {}
        }
    }

    /// Interrupt an in-flight turn on the shared server (if any). Used at teardown so
    /// turning the stream off actually STOPS the turn (the Claude backend gets this by
    /// killing its process; the shared Codex server can't be killed). A failure is
    /// surfaced: the conversation is closing, but the turn would keep running
    /// server-side (quota + rollout writes) — the notice (emitted BEFORE the actor's
    /// final `emit_ended`) leaves a visible trace instead of a silent leak.
    async fn interrupt_if_active(&self, thread_id: &str, server: &CodexServer) {
        if let Some(turn_id) = self.current_turn_id.clone() {
            if let Err(e) = server
                .request(
                    "turn/interrupt",
                    json!({ "threadId": thread_id, "turnId": turn_id }),
                )
                .await
            {
                self.emit_notice(
                    "error",
                    &format!("couldn't interrupt the turn while shutting down the session: {e}"),
                );
            }
        }
    }

    /// Inbound routed to this conversation: NOTIFICATIONS drive the whole rendering, and
    /// the shared server routes an APPROVAL server-request here (a command/patch the model
    /// wants to run under `on-request`). Responses are correlated by the server, never here.
    fn on_incoming(&mut self, inc: Incoming) {
        match inc {
            Incoming::Notification { method, params } => self.on_notification(&method, params),
            Incoming::ServerRequest { id, method, params } => {
                self.on_approval_request(id, &method, params)
            }
            _ => {}
        }
    }

    /// Surface an approval server-request as a permission prompt reusing Claude's UI
    /// verbatim (`PermissionRequestPayload` → the composer prompt → `answer_permission`).
    /// The `request_id` IS the ServerRequest id we must reply to; `tool_use_id == itemId`
    /// ties the prompt to the tool card already on the timeline (which shows the command /
    /// diff). We record it as pending so it is always answered (on reply, or `cancel` at
    /// teardown) — the shared server blocks the turn until then, exactly like `can_use_tool`.
    fn on_approval_request(&mut self, id: String, method: &str, params: Value) {
        let payload = match method {
            "item/commandExecution/requestApproval" => {
                let p: CommandApprovalParams = serde_json::from_value(params).unwrap_or_default();
                PermissionRequestPayload {
                    request_id: id.clone(),
                    tool_name: "Bash".into(),
                    tool_use_id: p.item_id.unwrap_or_default(),
                    input: json!({ "command": p.command, "cwd": p.cwd }),
                    title: Some("Run a command".into()),
                    description: p.reason,
                    suggestions: Value::Null,
                }
            }
            "item/fileChange/requestApproval" => {
                let p: FileChangeApprovalParams = serde_json::from_value(params).unwrap_or_default();
                PermissionRequestPayload {
                    request_id: id.clone(),
                    tool_name: "ApplyPatch".into(),
                    tool_use_id: p.item_id.unwrap_or_default(),
                    input: json!({ "reason": p.reason }),
                    title: Some("Edit files".into()),
                    description: p.reason,
                    suggestions: Value::Null,
                }
            }
            // The demux only routes the two approval kinds above; anything else here would
            // be a routing/coupling bug. Don't surface a broken prompt — but STILL record it
            // as pending so the teardown `cancel` releases the server, never leaking a
            // server-request unanswered (which would wedge the turn).
            _ => {
                self.pending_approvals.insert(id);
                return;
            }
        };
        self.pending_approvals.insert(id);
        self.state.awaiting_permission = true;
        self.emitter.emit_permission(&self.id, &payload);
        self.push_state();
    }

    /// Reply "cancel" to every still-pending approval — the turn is ending, so the shared
    /// server must be released or it blocks forever waiting on us.
    async fn decline_pending_approvals(&mut self, server: &CodexServer) {
        if self.pending_approvals.is_empty() {
            return;
        }
        for id in self.pending_approvals.drain() {
            server.reply(reply_result(&id, json!({ "decision": "cancel" }))).await;
        }
        self.state.awaiting_permission = false;
    }

    fn on_notification(&mut self, method: &str, params: Value) {
        // Backstop: recover the live turn id from a turn-scoped notification IF the
        // turn/start response parse missed it. FILL-ONLY — it must NEVER overwrite a
        // freshly-started turn's id with a stale/completed turn's buffered notification:
        // after a steer-race fallthrough (SendUser starts turn B), the just-ended turn A's
        // deltas (each carrying turnId=A) are still queued; overwriting current_turn_id back
        // to A would defeat the stale-completion guard in on_turn_completed and settle B's
        // busy early. Once set (by turn/start or a fill), only on_turn_completed clears it.
        if self.current_turn_id.is_none() {
            if let Some(tid) = params.get("turnId").and_then(Value::as_str) {
                self.current_turn_id = Some(tid.to_string());
            }
        }
        match method {
            // ── Streaming text: assistant answer vs reasoning — the ONLY difference is the
            // block kind (Text vs Thinking). Reasoning must NEVER become Text (it would leak
            // the raw chain into the visible answer).
            "item/agentMessage/delta" => self.stream_delta(params, false),
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                self.stream_delta(params, true)
            }

            // ── Item lifecycle. `item/started` synthesizes the tool card the moment a tool
            // begins; `item/completed` closes it (ToolResult) or emits the authoritative
            // assistant/reasoning message. Same envelope, told apart by the flag.
            "item/started" => self.on_item(params, false),
            "item/completed" => self.on_item(params, true),

            "turn/completed" => self.on_turn_completed(params),

            // ── Subscription rate-limit % (5h + weekly) — the plan ring. A GLOBAL
            // (thread-less) push the shared server broadcasts to every conversation actor
            // (see `server::demux_loop`). Account-global, so any Codex conversation
            // surfacing it feeds the ONE front Codex plan store. Sparse: a push may carry
            // only the window that moved (the front merges onto its last snapshot).
            "account/rateLimits/updated" => {
                self.ingest_rate_limits(params.get("rateLimits").cloned().unwrap_or(Value::Null));
            }

            // ── Extension-inventory invalidation pushes (Extensions v2). All three are
            // GLOBAL notifications the shared server broadcasts to every actor; the front
            // dedupes/coalesces the invalidation, so multiple actors re-emitting the same
            // push is harmless. No payload is forwarded — the front refetches through the
            // normal read commands (whitelisted shapes), never from the raw wire.
            "skills/changed" => self.emitter.emit_extensions_changed(&self.id, "skills"),
            "mcpServer/startupStatus/updated" => {
                // Capture WHY a server failed BEFORE invalidating — the on-demand
                // `mcpServerStatus/list` the front then refetches has no failure field, so
                // this push is the only source of the reason. Overwrite per push so a later
                // `ready` clears a stale `failed`.
                if let Some(name) = params.get("name").and_then(Value::as_str) {
                    self.mcp_startup_status.insert(
                        name.to_string(),
                        McpStartupStatus {
                            state: params
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            failure_reason: params
                                .get("failureReason")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            error: params.get("error").and_then(Value::as_str).map(str::to_string),
                        },
                    );
                }
                self.emitter.emit_extensions_changed(&self.id, "mcp");
            }
            "account/updated" => self.emitter.emit_extensions_changed(&self.id, "accounts"),

            "thread/tokenUsage/updated" => {
                let usage = params.get("tokenUsage");
                if let Some(win) = usage
                    .and_then(|u| u.get("modelContextWindow"))
                    .and_then(Value::as_u64)
                {
                    // Direct + authoritative — no model-name heuristic (unlike Claude).
                    self.state.context_window = Some(win);
                }
                // Context OCCUPANCY = the LAST turn's input tokens (the full prompt = everything
                // currently in the window), the analog of Claude's last-result input+cache. NOT
                // `total.totalTokens`: that is the cumulative LIFETIME sum of input + output +
                // reasoning across EVERY turn, which only ever grows — so the ring would creep
                // toward "near full" turn after turn even on a mostly-empty window (a gpt-5.6
                // conversation reading "near max" at ~350k against its own window is this bug).
                if let Some(used) = usage
                    .and_then(|u| u.get("last"))
                    .and_then(|l| l.get("inputTokens"))
                    .and_then(Value::as_u64)
                {
                    self.state.context_tokens = Some(used);
                }
                self.push_state();
            }
            "error" => {
                // ⚠️ Surface AND settle even if the payload does NOT decode into
                // `ErrorNotification` (a bare string / array / null — its fields are optional so
                // any OBJECT parses, but a non-object does not). Otherwise the error is DROPPED
                // and, with `busy` still true and tool cards still open, the turn renders
                // "running" FOREVER with nothing shown — the exact silent-error the no-silent-
                // failure rule forbids. An undecodable payload is treated as terminal (settle)
                // rather than risk a permanent hang.
                let parsed = serde_json::from_value::<ErrorNotification>(params).ok();
                let turn_err = parsed.as_ref().and_then(|e| e.error.as_ref());
                let msg = turn_err
                    .and_then(|t| t.message.clone())
                    .unwrap_or_else(|| "codex app-server error".into());
                // A `sessionBudgetExceeded` cause (a bare-string `codexErrorInfo`) earns a
                // dedicated notice — distinct from a plan rate-limit or a generic protocol
                // error — so the UI can name it ("Codex session budget exceeded"). Only
                // that one variant is matched; the rest stay `protocol_error`.
                let subtype = if turn_err
                    .and_then(|t| t.codex_error_info.as_ref())
                    .and_then(|c| c.as_str())
                    == Some("sessionBudgetExceeded")
                {
                    "session_budget_exceeded"
                } else {
                    "protocol_error"
                };
                self.emit_notice(subtype, &msg);
                // A transient (will-retry) error keeps the turn going; a terminal one — or an
                // undecodable one — ends it, and a terminal `error` may NOT be followed by
                // `turn/completed`, so it runs the same close-out: settle `busy`, reset the turn
                // id, and close any open tool card (M2).
                let will_retry = parsed.and_then(|e| e.will_retry) == Some(true);
                if !will_retry {
                    self.close_dangling_tools();
                    self.current_turn_id = None;
                    self.state.busy = false;
                    self.push_state();
                }
            }
            // Every other notification (thread/status, turn/diff, plan steps, mcpServer
            // status, …) is additive — ignored here, never fatal. Rich turn-diff view and
            // fleet status land in phases 4.3/4.4.
            _ => {}
        }
    }

    /// Emit a streaming token. `thinking` picks the block kind (reasoning → `ThinkingDelta`,
    /// answer → `TextDelta`). Opens the item's turn (`MessageStarted`) on first sight, since
    /// the front drops a delta whose turn isn't open.
    fn stream_delta(&mut self, params: Value, thinking: bool) {
        let Ok(d) = serde_json::from_value::<ItemDelta>(params) else {
            return;
        };
        let Some(item_id) = d.item_id.filter(|s| !s.is_empty()) else {
            return;
        };
        if self.streaming_ids.insert(item_id.clone()) {
            self.push_item(ConversationItem::MessageStarted {
                id: item_id.clone(),
                role: "assistant".into(),
                parent_tool_use_id: None,
            });
        }
        let item = if thinking {
            ConversationItem::ThinkingDelta {
                message_id: Some(item_id),
                text: d.delta,
            }
        } else {
            ConversationItem::TextDelta {
                message_id: Some(item_id),
                text: d.delta,
            }
        };
        self.push_item(item);
    }

    /// Map one `item/started` (`completed=false`) or `item/completed` (`completed=true`) to
    /// the normalized timeline. Tool items reuse `item.id` as BOTH the synthesized
    /// `tool_use` id and its `tool_result`'s `tool_use_id`, so the front's id-keyed store
    /// pairs them and clean-output folds the round.
    fn on_item(&mut self, params: Value, completed: bool) {
        // The item's OWN turn id (every item/* notification carries `turnId`) — the
        // authoritative turn this item belongs to. Assistant items are stamped with THIS,
        // not `current_turn_id` (the latest-turn pointer): after a steer-race fallthrough
        // started a new turn, a buffered tail item from the superseded turn is still drained
        // here, and tagging it with the new turn would make native rewind/fork cut at the
        // wrong boundary. Read before `from_value` consumes `params`.
        let item_turn = params.get("turnId").and_then(Value::as_str).map(str::to_string);
        // Captured BEFORE `from_value` consumes `params`: the raw `type`/`id` let the
        // `Unknown` arm surface a FUTURE (unmodelled) item as a generic card instead of a
        // silent drop.
        let raw_type = params
            .get("item")
            .and_then(|i| i.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let raw_id = params
            .get("item")
            .and_then(|i| i.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let Ok(env) = serde_json::from_value::<ItemEnvelope>(params) else {
            // A KNOWN-tag item whose fields drifted on the wire (a present-but-wrong-typed
            // field, or a missing required `id`) fails to decode. `#[serde(default)]` fills a
            // MISSING field but never a wrong-TYPED one, and the `Unknown` arm below only
            // catches an unknown TAG — so without this, such an item would be dropped in
            // silence, violating this module's "never a silent drop" contract. Reuse the
            // captured raw type/id to surface a generic card (keyed by the item's own id when
            // present, else a visible protocol notice), marked as an error since the item is
            // genuinely UNREADABLE, not merely unmodelled.
            match raw_id.as_deref() {
                Some(id) => {
                    let name = raw_type.as_deref().unwrap_or("codexItem");
                    self.ensure_tool_use(id, name, json!({}), item_turn.as_deref());
                    if completed {
                        self.emit_tool_result(id, json!(format!("Unreadable Codex item: {name}")), true);
                    }
                }
                None => {
                    let ty = raw_type.as_deref().unwrap_or("unknown");
                    self.emit_notice(
                        "protocol_error",
                        &format!("A Codex item ({ty}) couldn't be decoded and is not shown."),
                    );
                }
            }
            return;
        };
        match env.item {
            // Assistant answer & reasoning: only the authoritative (completed) message is
            // emitted here; the live text arrived via deltas and the front reconciles by id.
            ThreadItem::AgentMessage { id, text } => {
                if completed && !text.is_empty() {
                    self.emit_message(id, NormalizedBlock::Text { text }, item_turn.as_deref());
                }
            }
            ThreadItem::Plan { id, text } => {
                if completed && !text.is_empty() {
                    self.emit_message(id, NormalizedBlock::Text { text }, item_turn.as_deref());
                }
            }
            ThreadItem::Reasoning {
                id,
                summary,
                content,
            } => {
                if completed {
                    let text = join_reasoning(&summary, &content);
                    if !text.is_empty() {
                        self.emit_message(id, NormalizedBlock::Thinking { text }, item_turn.as_deref());
                    }
                }
            }

            // Tool items → a ToolUse card on start, a ToolResult on completion.
            ThreadItem::CommandExecution {
                id,
                command,
                cwd,
                aggregated_output,
                exit_code,
                status,
            } => {
                self.ensure_tool_use(&id, "Bash", json!({ "command": command, "cwd": cwd }), item_turn.as_deref());
                if completed {
                    let is_error =
                        status_is_error(status.as_deref()) || exit_code.is_some_and(|c| c != 0);
                    self.emit_tool_result(&id, json!(aggregated_output.unwrap_or_default()), is_error);
                }
            }
            ThreadItem::FileChange {
                id,
                changes,
                status,
            } => {
                let changes_json = serde_json::to_value(&changes).unwrap_or(Value::Null);
                self.ensure_tool_use(&id, "ApplyPatch", json!({ "changes": changes_json }), item_turn.as_deref());
                if completed {
                    let is_error = status_is_error(status.as_deref());
                    // The per-file diffs ride on the result too, so they're visible even if
                    // the started item carried an empty change list.
                    self.emit_tool_result(
                        &id,
                        json!({ "status": status, "changes": changes_json }),
                        is_error,
                    );
                }
            }
            ThreadItem::McpToolCall {
                id,
                server,
                tool,
                status,
                arguments,
                result,
                error,
            } => {
                let name = format!(
                    "mcp__{}__{}",
                    server.as_deref().unwrap_or("server"),
                    tool.as_deref().unwrap_or("tool")
                );
                self.ensure_tool_use(&id, &name, json!({ "arguments": arguments }), item_turn.as_deref());
                if completed {
                    let is_error = error.is_some() || status_is_error(status.as_deref());
                    let content = error.or(result).unwrap_or(Value::Null);
                    self.emit_tool_result(&id, content, is_error);
                }
            }
            ThreadItem::WebSearch { id, query, action } => {
                self.ensure_tool_use(
                    &id,
                    "WebSearch",
                    json!({ "query": query, "action": action }),
                    item_turn.as_deref(),
                );
                if completed {
                    // The result TEXT is what `WebSearchDetail` parses for source chips, so
                    // fold the query + opened page / searched queries into it (URLs as
                    // markdown links → they render as sources).
                    self.emit_tool_result(&id, json!(web_search_result_text(&query, &action)), false);
                }
            }

            // A local image the model viewed → a `Read` card (its label surfaces the path)
            // whose result carries the base64 image block, reusing the Claude screenshot
            // renderer verbatim. Read on completion via the shared fs service.
            ThreadItem::ImageView { id, path } => {
                self.ensure_tool_use(&id, "Read", json!({ "file_path": path }), item_turn.as_deref());
                if completed {
                    let content = super::image_result_content(&path, self.state.cwd.as_deref());
                    self.emit_tool_result(&id, content, false);
                }
            }
            // An image the model produced → an `ImageGeneration` card with the revised
            // prompt + the produced image (from `saved_path`, else the `result` payload).
            ThreadItem::ImageGeneration {
                id,
                status,
                revised_prompt,
                result,
                saved_path,
            } => {
                self.ensure_tool_use(
                    &id,
                    "ImageGeneration",
                    json!({ "status": status, "revised_prompt": revised_prompt }),
                    item_turn.as_deref(),
                );
                if completed {
                    let mut blocks: Vec<Value> = Vec::new();
                    if let Some(p) = revised_prompt.as_deref().filter(|p| !p.is_empty()) {
                        blocks.push(json!({ "type": "text", "text": format!("Prompt: {p}") }));
                    }
                    match saved_path.as_deref() {
                        Some(p) => match super::image_block(p, self.state.cwd.as_deref()) {
                            Ok(b) => blocks.push(b),
                            Err(note) => {
                                blocks.push(json!({ "type": "text", "text": format!("{note}: {p}") }))
                            }
                        },
                        None => {
                            // No saved file: `result` may be a data-URL image or an opaque
                            // id/url — inline the image if we can, else surface it as text.
                            let r = result.unwrap_or_default();
                            match data_url_image_block(&r) {
                                Some(b) => blocks.push(b),
                                None if !r.is_empty() => {
                                    blocks.push(json!({ "type": "text", "text": format!("Result: {r}") }))
                                }
                                None => {}
                            }
                        }
                    }
                    let is_error = status_is_error(status.as_deref());
                    let content = if blocks.is_empty() {
                        json!("Image generated.")
                    } else {
                        json!(blocks)
                    };
                    self.emit_tool_result(&id, content, is_error);
                }
            }
            // A dynamic (plugin/namespaced) tool call → a generic card named after the tool.
            ThreadItem::DynamicToolCall {
                id,
                namespace,
                tool,
                arguments,
                status,
                content_items,
                success,
                ..
            } => {
                let name = match namespace.as_deref().filter(|ns| !ns.is_empty()) {
                    Some(ns) => format!("{ns}:{tool}"),
                    None => tool.clone(),
                };
                self.ensure_tool_use(&id, &name, json!({ "arguments": arguments }), item_turn.as_deref());
                if completed {
                    let is_error = success == Some(false) || status_is_error(status.as_deref());
                    self.emit_tool_result(&id, dynamic_tool_content(content_items.as_deref()), is_error);
                }
            }
            // A multi-agent (collab) tool call → a generic `Collab:<tool>` card (kept as the
            // in-thread record) PLUS, since Phase 4.5 (Bloc C), each sub-agent promoted into the
            // fleet from this item's `agentsStates` snapshot (see `ingest_collab_states`).
            ThreadItem::CollabAgentToolCall {
                id,
                tool,
                status,
                receiver_thread_ids,
                prompt,
                model,
                reasoning_effort,
                agents_states,
                ..
            } => {
                let name = collab_action_fr(&tool);
                self.ensure_tool_use(
                    &id,
                    &name,
                    json!({
                        "tool": tool,
                        "model": model,
                        "reasoning_effort": reasoning_effort,
                        "receivers": receiver_thread_ids,
                    }),
                    item_turn.as_deref(),
                );
                // Bloc C: reflect each sub-agent in the fleet from the cumulative agentsStates
                // snapshot this item carries (present on both item/started and item/completed).
                self.ingest_collab_states(&tool, model.as_deref(), &receiver_thread_ids, &agents_states);
                if completed {
                    let mut lines: Vec<String> = Vec::new();
                    if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
                        lines.push(format!("Task delegated: {p}"));
                    }
                    let mut model_line = String::new();
                    if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
                        model_line = format!("Model: {m}");
                    }
                    if let Some(e) = reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
                        model_line.push_str(if model_line.is_empty() {
                            ""
                        } else {
                            " · "
                        });
                        model_line.push_str(&format!("effort {e}"));
                    }
                    if !model_line.is_empty() {
                        lines.push(model_line);
                    }
                    if let Some(summary) = collab_states_summary(&agents_states) {
                        lines.push(summary);
                    }
                    let content = if lines.is_empty() {
                        json!(name)
                    } else {
                        json!(lines.join("\n"))
                    };
                    self.emit_tool_result(&id, content, status_is_error(status.as_deref()));
                }
            }
            // A sub-agent lifecycle marker → a compact card. Instantaneous, so the result is
            // emitted unconditionally (idempotent) rather than gated on `completed`.
            ThreadItem::SubAgentActivity {
                id,
                kind,
                agent_thread_id,
                agent_path,
            } => {
                self.ensure_tool_use(
                    &id,
                    "Sub-agent",
                    json!({ "kind": kind, "agent_path": agent_path }),
                    item_turn.as_deref(),
                );
                let kind_fr = subagent_kind_fr(&kind);
                let path = agent_path.as_deref().unwrap_or("");
                let name = agent_name(path);
                let headline = if name.is_empty() {
                    format!("Sub-agent {kind_fr}")
                } else {
                    format!("Sub-agent \"{name}\" {kind_fr}")
                };
                // Keep the full path as a second line when it adds info beyond the short name.
                let body = if path.is_empty() || path == name {
                    headline
                } else {
                    format!("{headline}\n{path}")
                };
                self.emit_tool_result(&id, json!(body), false);
                // Bloc C: this is the ONLY item carrying the sub-agent's NAME (agentsStates
                // omits it) — record it, then reflect the lifecycle in the fleet. `started`/
                // `interacted` → running, `interrupted` → stopped. The richer agentsStates
                // status from a collab item refines it later (replace-by-`task_id`).
                if let Some(tid) = agent_thread_id.as_deref().filter(|t| !t.is_empty()) {
                    if !name.is_empty() {
                        self.codex_subagents.entry(tid.to_string()).or_default().name =
                            Some(name.to_string());
                    }
                    let status = if kind == "interrupted" {
                        BackgroundTaskStatus::Stopped
                    } else {
                        BackgroundTaskStatus::Running
                    };
                    self.emit_subagent_task(tid, status, None);
                }
            }
            // The agent pausing → a small card showing the duration.
            ThreadItem::Sleep { id, duration_ms } => {
                self.ensure_tool_use(&id, "Sleep", json!({ "duration_ms": duration_ms }), item_turn.as_deref());
                if completed {
                    let msg = match duration_ms {
                        Some(ms) => format!("Paused for {:.1} s", ms as f64 / 1000.0),
                        None => "Pause".to_string(),
                    };
                    self.emit_tool_result(&id, json!(msg), false);
                }
            }
            // Review-mode boundaries + compaction → compact marker cards (instantaneous →
            // result unconditional).
            ThreadItem::EnteredReviewMode { id, review } => {
                self.ensure_tool_use(&id, "ReviewMode", json!({ "review": review }), item_turn.as_deref());
                self.emit_tool_result(&id, json!(format!("Entered review mode: {review}").trim()), false);
            }
            ThreadItem::ExitedReviewMode { id, review } => {
                self.ensure_tool_use(&id, "ReviewMode", json!({ "review": review }), item_turn.as_deref());
                self.emit_tool_result(&id, json!(format!("Exited review mode: {review}").trim()), false);
            }
            ThreadItem::ContextCompaction { id } => {
                self.ensure_tool_use(&id, "Compaction", json!({}), item_turn.as_deref());
                self.emit_tool_result(&id, json!("Conversation compacted."), false);
            }

            // A user message echoed back as an item. Ours (already rendered optimistically
            // by the front) → nothing to do. NOT ours → it was typed somewhere else (the
            // phone/web bridge) and this is the only live signal it exists: surface it, or
            // it stays invisible until a reload makes it appear from nowhere. Mirrors the
            // Claude assembler's `was_ours` handling of `--replay-user-messages`.
            ThreadItem::HookPrompt => {}
            ThreadItem::UserMessage { id, content, client_id } => {
                let was_ours = client_id
                    .as_deref()
                    .is_some_and(|c| self.sent_client_ids.remove(c));
                if !was_ours {
                    let text = user_input_text(&content);
                    if !text.trim().is_empty() {
                        self.push_item(ConversationItem::UserMessage {
                            id,
                            text,
                            parent_tool_use_id: None,
                            // Spliced into place: like a Claude bridge turn, it can land
                            // out of order against the streaming reply.
                            replay: true,
                        });
                    }
                }
            }

            // A FUTURE item type this build does not model → a generic card named after the
            // raw wire `type`, keyed by the item's own id. Never a silent drop; a signal to
            // model it. Emitted once (on completion) to avoid a duplicate on `started`.
            ThreadItem::Unknown => {
                if let Some(id) = raw_id.as_deref() {
                    let name = raw_type.as_deref().unwrap_or("codexItem");
                    self.ensure_tool_use(id, name, json!({}), item_turn.as_deref());
                    if completed {
                        self.emit_tool_result(
                            id,
                            json!(format!("Unmodelled Codex item: {name}")),
                            false,
                        );
                    }
                }
            }
        }
    }

    /// Terminal turn handling: emit the timeline `TurnResult`, close any tool card still
    /// open (interrupted mid-command), and — ALWAYS, even on an undecodable payload —
    /// clear `busy` so the UI spinner can never wedge (invariant #7).
    fn on_turn_completed(&mut self, params: Value) {
        let parsed = serde_json::from_value::<TurnCompleted>(params).ok();
        // Stale-completion guard: a `turn/completed` whose id is NOT the current turn
        // arrives after the steer-race fallthrough (SendUser) already started a fresh
        // turn. Ignore it — settling here would clear the LIVE turn's `busy`/`current_turn_id`
        // (breaking its interrupt + flashing the UI to idle). The live turn's own
        // completion settles it. When either id is unknown, fall through and settle (safe
        // default: the common case where the completion IS the current turn).
        if let (Some(done), Some(cur)) = (
            parsed.as_ref().and_then(|t| t.turn.id.as_deref()),
            self.current_turn_id.as_deref(),
        ) {
            if done != cur {
                return;
            }
        }
        let (is_error, message) = match &parsed {
            Some(t) => {
                let is_error = t.turn.error.is_some()
                    || t.turn.status.eq_ignore_ascii_case("failed")
                    || t.turn.status.eq_ignore_ascii_case("error");
                let message = t
                    .turn
                    .error
                    .as_ref()
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (is_error, message)
            }
            None => (false, None),
        };
        // Close any card that never received its own completion (e.g. an interrupted
        // command), so the round is foldable instead of stuck "running".
        self.close_dangling_tools();
        // Settle any sub-agent still flagged live: Codex sub-agents run in-turn, so once this
        // turn is over (normally OR via interrupt, which also lands here) a lingering "running"
        // fleet task is stale and would show a false green / inflate the running count.
        self.settle_running_subagents();
        if let Some(msg) = &message {
            self.emit_notice("error", msg);
        }
        // The turn's wall-clock, derived from the start we stamped at turn/start (Codex's
        // turn/completed provides no server-measured duration). `None` if we somehow never
        // stamped a start → the footer stays hidden rather than showing a bogus 0 ms.
        let duration_ms = self
            .turn_started_at
            .take()
            .map(|t| t.elapsed().as_millis() as u64);
        self.push_item(ConversationItem::TurnResult {
            subtype: if is_error { "error" } else { "success" }.into(),
            is_error,
            result: None,
            api_error_status: None,
            total_cost_usd: None,
            num_turns: None,
            duration_ms,
            // Codex's turn/completed carries no MODEL-time breakdown — the "N s of model"
            // rider + TTFT are Claude-only; None keeps that part of the footer honest.
            duration_api_ms: None,
            ttft_ms: None,
        });
        self.streaming_ids.clear();
        self.carded.clear();
        self.current_turn_id = None;
        self.state.busy = false;
        self.push_state();
    }

    /// Emit an authoritative assistant/reasoning message keyed by `item.id` (one block).
    /// The front reconciles it against the streamed deltas of the same id.
    fn emit_message(&mut self, id: String, block: NormalizedBlock, turn_id: Option<&str>) {
        self.streaming_ids.remove(&id);
        self.push_item(ConversationItem::AssistantMessage {
            id,
            blocks: vec![block],
            parent_tool_use_id: None,
            // Tag with the item's OWN turn (the notification's `turnId`), so the front can
            // target this boundary by Codex turn id for native rewind/fork. NOT
            // `current_turn_id` (the latest-turn pointer) — a buffered tail item from a
            // superseded turn (steer-race fallthrough) would otherwise be mis-tagged.
            turn_id: turn_id.map(str::to_string),
        });
    }

    /// Synthesize a tool card the first time we see a tool item id THIS turn (idempotent
    /// on `carded`, which — unlike `open_tools` — is not emptied on completion, so a
    /// duplicate/late `item/*` can't re-card). Called on BOTH `item/started` and
    /// `item/completed` (from the completed item's fields) so a dropped `item/started`
    /// still yields a card to hang the result on.
    fn ensure_tool_use(&mut self, id: &str, name: &str, input: Value, turn_id: Option<&str>) {
        if self.carded.insert(id.to_string()) {
            self.open_tools.insert(id.to_string());
            self.push_item(ConversationItem::AssistantMessage {
                id: id.to_string(),
                blocks: vec![NormalizedBlock::ToolUse {
                    id: id.to_string(),
                    name: name.to_string(),
                    input,
                }],
                parent_tool_use_id: None,
                // The item's OWN turn (notification `turnId`), not `current_turn_id` — see emit_message.
                turn_id: turn_id.map(str::to_string),
            });
        }
    }

    /// Close a tool card with its result (joined by `tool_use_id == item.id`). Gated on
    /// `open_tools` so a duplicate/late `item/completed` for an already-closed card is a
    /// no-op (no duplicate result).
    fn emit_tool_result(&mut self, id: &str, content: Value, is_error: bool) {
        if self.open_tools.remove(id) {
            self.push_item(ConversationItem::ToolResult {
                tool_use_id: id.to_string(),
                content,
                is_error,
                parent_tool_use_id: None,
            });
        }
    }

    /// Settle any sub-agent still flagged `Running` to `Stopped` at turn end. Codex sub-agents
    /// run IN-TURN (the parent thread blocks on `wait`), so once the turn completes — normally or
    /// via interrupt — a lingering "running" fleet task is stale: it would show a false green and
    /// inflate the fleet's running count with no signal to ever clear it (the sub-agent thread is
    /// unrouted). A later `resumeAgent` re-emits the sub-agent running through
    /// `ingest_collab_states`, so this only clears the phantom, never a genuinely live one.
    fn settle_running_subagents(&mut self) {
        let stale: Vec<String> = self
            .codex_subagents
            .iter()
            .filter(|(_, m)| matches!(m.last_status, Some(BackgroundTaskStatus::Running)))
            .map(|(tid, _)| tid.clone())
            .collect();
        for tid in stale {
            self.emit_subagent_task(&tid, BackgroundTaskStatus::Stopped, None);
        }
    }

    /// Close every tool card still open with an error result, so a round that ended without
    /// each item's own `item/completed` (interrupted, a terminal `error`, a spontaneous
    /// server death) can still fold in clean-output instead of showing "running" forever.
    fn close_dangling_tools(&mut self) {
        for id in self.open_tools.drain().collect::<Vec<_>>() {
            self.push_item(ConversationItem::ToolResult {
                tool_use_id: id,
                content: json!("(interrupted)"),
                is_error: true,
                parent_tool_use_id: None,
            });
        }
    }
}

/// A Codex status/exit is an error when it FAILED or was DECLINED (`PatchApplyStatus` /
/// `CommandExecutionStatus` share these strings). `inProgress`/`completed` are not errors.
fn status_is_error(status: Option<&str>) -> bool {
    matches!(status, Some(s) if s.eq_ignore_ascii_case("failed") || s.eq_ignore_ascii_case("declined") || s.eq_ignore_ascii_case("error"))
}

/// A `CollabAgentTool` action → a human card label. The full sub-agent-as-background-task
/// treatment (transcript, live status, fleet) is Phase 4.5; here the card just reads clearly.
fn collab_action_fr(tool: &str) -> String {
    match tool {
        "spawnAgent" => "Spawning a sub-agent".to_string(),
        "sendInput" => "Message to a sub-agent".to_string(),
        "resumeAgent" => "Resuming a sub-agent".to_string(),
        "wait" => "Waiting on a sub-agent".to_string(),
        "closeAgent" => "Closing a sub-agent".to_string(),
        other => format!("Sub-agent: {other}"),
    }
}

/// A `CollabAgentStatus` → an English word for the card body.
fn collab_status_fr(status: &str) -> &'static str {
    match status {
        "pendingInit" => "pending",
        "running" => "running",
        "interrupted" => "interrupted",
        "completed" => "completed",
        "errored" => "errored",
        "shutdown" => "stopped",
        "notFound" => "not found",
        _ => "unknown state",
    }
}

/// A `CollabAgentStatus` → the fleet [`BackgroundTaskStatus`] (Phase 4.5, Bloc C). `pendingInit`
/// and `running` are live; an unknown/missing status is treated as `Running` (fail-safe: stays
/// visible + counted, and the session-end backstop settles it) rather than silently dropped.
fn collab_status_to_task_status(status: Option<&str>) -> BackgroundTaskStatus {
    match status {
        Some("completed") => BackgroundTaskStatus::Completed,
        Some("errored") | Some("notFound") => BackgroundTaskStatus::Failed,
        Some("interrupted") | Some("shutdown") => BackgroundTaskStatus::Stopped,
        // "pendingInit" | "running" | unknown → still working.
        _ => BackgroundTaskStatus::Running,
    }
}

/// A `SubAgentActivityKind` → an English verb for the card body.
fn subagent_kind_fr(kind: &str) -> &'static str {
    match kind {
        "started" => "started",
        "interacted" => "interacted",
        "interrupted" => "interrupted",
        _ => "activity",
    }
}

/// The readable tail of a sub-agent path (`/root/react_frontend` → `react_frontend`).
fn agent_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(trimmed)
}

/// Summarize a `collabAgentToolCall`'s `agentsStates` ({threadId:{status,message}}) as a
/// count-by-status line ("Sub-agents (2): 1 running, 1 completed"). `None` when empty.
fn collab_states_summary(states: &Value) -> Option<String> {
    let obj = states.as_object().filter(|o| !o.is_empty())?;
    let mut counts: std::collections::BTreeMap<&'static str, usize> = std::collections::BTreeMap::new();
    for v in obj.values() {
        let st = v.get("status").and_then(Value::as_str).unwrap_or("");
        *counts.entry(collab_status_fr(st)).or_insert(0) += 1;
    }
    let detail = counts
        .iter()
        .map(|(label, n)| format!("{n} {label}"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("Sub-agents ({}): {detail}", obj.len()))
}

/// A `data:<mime>;base64,<data>` URL → the inline image block the front renders. Only a
/// base64 data-URL is inlineable (an `http(s)` url would be skipped by the front's
/// `source.type:"url"` guard) — returns `None` otherwise so the caller falls back to text.
fn data_url_image_block(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if !meta.contains("base64") {
        return None;
    }
    let media_type = meta.split(';').next().filter(|m| !m.is_empty()).unwrap_or("image/png");
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data },
    }))
}

/// Map a `dynamicToolCall`'s `contentItems` (`inputText` / `inputImage`) to a `tool_result`
/// content array: text blocks verbatim, data-URL images inlined (else surfaced as a text
/// mention), so nothing the tool returned is dropped. Empty / absent → a neutral note.
fn dynamic_tool_content(items: Option<&[Value]>) -> Value {
    let Some(items) = items.filter(|i| !i.is_empty()) else {
        return json!("(no output)");
    };
    let mut out: Vec<Value> = Vec::new();
    for it in items {
        match it.get("type").and_then(Value::as_str) {
            Some("inputText") => {
                let text = it.get("text").and_then(Value::as_str).unwrap_or("");
                out.push(json!({ "type": "text", "text": text }));
            }
            Some("inputImage") => {
                let url = it.get("imageUrl").and_then(Value::as_str).unwrap_or("");
                match data_url_image_block(url) {
                    Some(block) => out.push(block),
                    None => out.push(json!({ "type": "text", "text": format!("[image] {url}") })),
                }
            }
            _ => out.push(json!({ "type": "text", "text": it.to_string() })),
        }
    }
    json!(out)
}

/// Build the `WebSearch` card's result TEXT from the query + its `WebSearchAction`. The
/// front's `WebSearchDetail` parses this text for markdown links → source chips, so an
/// opened/searched page is emitted as `[host](url)`. Enriches the bare-query card
/// (`webSearch` gained `action` in 0.144.1).
fn web_search_result_text(query: &str, action: &Value) -> String {
    // Emit the SAME shape a Claude WebSearch result takes so it flows through the identical
    // `WebSearchDetail` renderer: a `Links: [{title,url}]` JSON array → favicon source chips,
    // plus a text summary. Codex's item carries only the searched queries / opened URL (no
    // result set), so a `search` yields a query summary (no chips) while `open_page` /
    // `find_in_page` yield one source chip for the page the model actually visited.
    let host = |url: &str| -> String {
        url.split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or(url)
            .to_string()
    };
    let links_line = |url: &str| format!("Links: {}", json!([{ "title": host(url), "url": url }]));
    match action.get("type").and_then(Value::as_str) {
        Some("open_page") => match action.get("url").and_then(Value::as_str) {
            Some(url) => links_line(url),
            None => String::new(),
        },
        Some("find_in_page") => {
            let pattern = action.get("pattern").and_then(Value::as_str).unwrap_or("");
            let note = if pattern.is_empty() {
                String::new()
            } else {
                format!("\n\nSearch \"{pattern}\" in the page.")
            };
            match action.get("url").and_then(Value::as_str) {
                Some(url) => format!("{}{note}", links_line(url)),
                None if !pattern.is_empty() => format!("Search \"{pattern}\" in the page."),
                None => String::new(),
            }
        }
        Some("search") => {
            let queries: Vec<String> = action
                .get("queries")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|q| q.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let list: Vec<String> = if !queries.is_empty() {
                queries
            } else {
                action
                    .get("query")
                    .and_then(Value::as_str)
                    .filter(|q| !q.is_empty())
                    .or(if query.is_empty() { None } else { Some(query) })
                    .map(|q| vec![q.to_string()])
                    .unwrap_or_default()
            };
            match list.len() {
                0 => String::new(),
                1 => format!("Search: {}", list[0]),
                _ => format!(
                    "Searches:\n{}",
                    list.iter().map(|q| format!("- {q}")).collect::<Vec<_>>().join("\n")
                ),
            }
        }
        // Unknown/absent action → fall back to the bare query (never blank if we know it).
        _ => {
            if query.is_empty() {
                String::new()
            } else {
                format!("Search: {query}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Friendly labels for the `control_change` timeline notices (see
// `CodexCore::announce_control_changes`). They mirror the composer's own labels
// so a line reads like exactly what the user just picked, and match the Claude
// backend's English effort wording ("Extra high") for cross-backend parity.
// `None` (a field the front didn't send) renders as "(default)" so a first-set
// never reads as a move from an empty string. An unmodelled string passes
// through verbatim rather than being dropped.
// ---------------------------------------------------------------------------

/// A Codex model id → the composer picker's friendly label: `gpt-5.6-sol` → `GPT-5.6 Sol`,
/// `gpt-5.5` → `GPT-5.5`. Unknown shapes fall back to the raw id.
fn codex_model_label(id: Option<&str>) -> String {
    let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) else {
        return "(default)".to_string();
    };
    let Some(rest) = id.strip_prefix("gpt-") else {
        return id.to_string();
    };
    match rest.split_once('-') {
        Some((ver, name)) if !name.is_empty() => {
            let mut chars = name.chars();
            let capitalized = match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => name.to_string(),
            };
            format!("GPT-{ver} {capitalized}")
        }
        _ => format!("GPT-{rest}"),
    }
}

/// Reasoning effort → English label, matching the Claude backend's `effort_label`
/// ("Extra high") plus the deeper `max`/`ultra` rungs the gpt-5.6 family exposes.
fn codex_effort_label(effort: Option<&str>) -> String {
    match effort {
        Some("low") => "Low",
        Some("medium") => "Medium",
        Some("high") => "High",
        Some("xhigh") => "Extra high",
        Some("max") => "Max",
        Some("ultra") => "Ultra",
        Some(other) => other,
        None => "(default)",
    }
    .to_string()
}

/// The sandbox × approval pair, folded back into the composer's preset label (the four
/// combinations the picker offers). An unknown pairing degrades to describing both axes
/// so the notice never lies.
fn codex_permissions_label(sandbox: Option<&str>, approval: Option<&str>) -> String {
    match (sandbox, approval) {
        (Some("readOnly"), Some("on-request")) => "Cautious".to_string(),
        (Some("workspaceWrite"), Some("on-request")) => "Standard".to_string(),
        (Some("workspaceWrite"), Some("never")) => "Auto".to_string(),
        (Some("dangerFullAccess"), Some("never")) => "Full access".to_string(),
        (None, None) => "(default)".to_string(),
        (s, a) => format!("{} · {}", codex_sandbox_label(s), codex_approval_label(a)),
    }
}

fn codex_sandbox_label(sandbox: Option<&str>) -> String {
    match sandbox {
        Some("readOnly") => "Read-only",
        Some("workspaceWrite") => "Workspace write",
        Some("dangerFullAccess") => "Full access",
        Some(other) => other,
        None => "(default)",
    }
    .to_string()
}

fn codex_approval_label(approval: Option<&str>) -> String {
    match approval {
        Some("untrusted") => "Always ask",
        Some("on-failure") => "Ask on failure",
        Some("on-request") => "Ask when needed",
        Some("never") => "Never ask",
        Some(other) => other,
        None => "(default)",
    }
    .to_string()
}

fn codex_summary_label(summary: Option<&str>) -> String {
    match summary {
        Some("auto") => "Auto",
        Some("concise") => "Concise",
        Some("detailed") => "Detailed",
        Some("none") => "None",
        Some(other) => other,
        None => "(default)",
    }
    .to_string()
}

fn codex_personality_label(personality: Option<&str>) -> String {
    match personality {
        Some("none") => "Neutral",
        Some("friendly") => "Friendly",
        Some("pragmatic") => "Pragmatic",
        Some(other) => other,
        None => "(default)",
    }
    .to_string()
}

fn codex_bool_label(v: Option<bool>) -> String {
    match v {
        Some(true) => "On",
        Some(false) => "Off",
        None => "(default)",
    }
    .to_string()
}

/// Derive a concise conversation title from the accumulated user intent — the Codex
/// backend's auto-title (it has no server-side "generate a title" RPC in our client, so we
/// truncate rather than round-trip). Takes the first non-empty line, drops a leading
/// `/slash-command` token (noise as a title), and caps to a few words / ~48 chars, trimming
/// trailing punctuation. Returns `None` when nothing usable remains, so the caller leaves the
/// placeholder name rather than applying a blank title.
pub(super) fn codex_title_from_description(description: &str) -> Option<String> {
    const MAX_WORDS: usize = 8;
    const MAX_CHARS: usize = 48;

    let first = description.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut words: Vec<&str> = first.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    // Drop a leading "/command" token when there's more after it (a bare "/foo" keeps it).
    if words[0].starts_with('/') && words.len() > 1 {
        words.remove(0);
    }

    let mut title = String::new();
    for w in words.iter().take(MAX_WORDS) {
        let extra = if title.is_empty() { w.chars().count() } else { w.chars().count() + 1 };
        if title.chars().count() + extra > MAX_CHARS {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(w);
    }
    // A single first word longer than the cap: hard-truncate it by chars so we still show
    // something rather than nothing.
    if title.is_empty() {
        title = words[0].chars().take(MAX_CHARS).collect();
    }

    let title = title
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '.' | ',' | ':' | ';' | '!' | '?'))
        .to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// The Codex model to open the thread with, derived from the shared `SpawnConfig`.
/// The config's `model` is set for every conversation (defaults to a Claude alias),
/// but a Claude alias would be REJECTED by the Codex binary — so a Claude-family value
/// yields `None` (the server falls back to its own default model) rather than failing
/// the thread start. A blank/empty value is likewise `None`. The front seeds a Codex
/// conversation with a real Codex id (see `DEFAULT_CODEX_MODEL`), so in practice this
/// passes that id through; the filter is the safety net for a stale/mismatched record.
fn codex_model(cfg: &SpawnConfig) -> Option<String> {
    let m = cfg.model.as_deref()?.trim();
    if m.is_empty() {
        return None;
    }
    let lower = m.to_ascii_lowercase();
    const CLAUDE_FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "claude"];
    if CLAUDE_FAMILIES.iter().any(|c| lower.contains(c)) {
        return None;
    }
    Some(m.to_string())
}

/// Enable Codex remote control: bring the bridge up (`remoteControl/enable`), then fetch a
/// device-pairing code (`remoteControl/pairing/start`) so the user can link a device — the
/// enable response carries NO URL (unlike Claude). The pairing fetch is best-effort: the
/// bridge is up even if it fails (the chip just won't show a code). An enable RPC failure
/// surfaces as an `error` state.
async fn codex_remote_enable(server: &CodexServer) -> RemoteControlState {
    let status = match server.request("remoteControl/enable", json!({})).await {
        Ok(v) => codex_remote_status(&v),
        Err(e) => {
            return RemoteControlState {
                status: "error".into(),
                error: Some(e.to_string()),
                ..RemoteControlState::default()
            }
        }
    };
    // Fetch a device-pairing code. A FAILURE here is NOT swallowed (the no-silent-error
    // rule): the bridge is up but unusable without a code, so carry the reason in `error`
    // — the front surfaces it AND still lets the user disable the bridge. Prefer the
    // human-typeable manual code (`manualCode:true`), falling back to the long QR payload.
    let (pairing_code, error) = match server
        .request("remoteControl/pairing/start", json!({ "manualCode": true }))
        .await
    {
        Ok(v) => {
            let code = v
                .get("manualPairingCode")
                .and_then(Value::as_str)
                .or_else(|| v.get("pairingCode").and_then(Value::as_str))
                .map(str::to_string);
            match code {
                Some(_) => (code, None),
                // Enable succeeded but the server minted no code — say so, don't show OFF.
                None => (None, Some("no pairing code returned".to_string())),
            }
        }
        Err(e) => (None, Some(format!("pairing code unavailable: {e}"))),
    };
    RemoteControlState {
        status,
        pairing_code,
        error,
        ..RemoteControlState::default()
    }
}

/// Disable Codex remote control (`remoteControl/disable`). A failure surfaces as `error`.
async fn codex_remote_disable(server: &CodexServer) -> RemoteControlState {
    match server.request("remoteControl/disable", json!({})).await {
        Ok(_) => RemoteControlState {
            status: "disconnected".into(),
            ..RemoteControlState::default()
        },
        Err(e) => RemoteControlState {
            status: "error".into(),
            error: Some(e.to_string()),
            ..RemoteControlState::default()
        },
    }
}

/// Map a Codex `RemoteControlConnectionStatus` (`disabled`|`connecting`|`connected`|
/// `errored`) to the shared front status (`disconnected`|`connecting`|`connected`|`error`).
fn codex_remote_status(v: &Value) -> String {
    match v.get("status").and_then(Value::as_str) {
        Some("connected") => "connected",
        Some("connecting") => "connecting",
        Some("errored") => "error",
        _ => "disconnected",
    }
    .to_string()
}

/// Query the live MCP server status for a Codex conversation (`mcpServerStatus/list`,
/// thread-scoped) and map each entry to the shared [`McpServerLive`] the conversation-lens
/// Extensions view renders. An RPC rejection is surfaced as `Err` (never a fake empty —
/// distinct from a genuinely server-less conversation, `Ok(vec![])`).
async fn fetch_mcp_status(
    server: &CodexServer,
    thread_id: &str,
    startup: &HashMap<String, McpStartupStatus>,
) -> Result<Vec<McpServerLive>, String> {
    let params = json!({ "threadId": thread_id, "detail": "toolsAndAuthOnly" });
    let value = server
        .request("mcpServerStatus/list", params)
        .await
        .map_err(|e| e.to_string())?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(data.iter().map(|v| mcp_server_live(v, startup)).collect())
}

/// Map one `mcpServerStatus/list` entry to a [`McpServerLive`] row. Codex's list has no
/// top-level status field, so status is INFERRED: a not-logged-in auth status → needs-auth,
/// a present `serverInfo` (the server answered `initialize`) → connected, else disconnected.
/// A live `failed` startup status (captured from the `mcpServer/startupStatus/updated`
/// push into `startup`) OVERRIDES that inference and carries its reason, so a server that
/// failed to start shows "Failed · <reason>" instead of a mute "Disconnected". Codex MCP
/// servers are user-global (`~/.codex/config.toml`), hence scope `user`; the launch
/// command/url live in the config, not this live entry, so they stay `None` here.
fn mcp_server_live(v: &Value, startup: &HashMap<String, McpStartupStatus>) -> McpServerLive {
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let auth = v.get("authStatus").and_then(Value::as_str);
    let has_info = v.get("serverInfo").map(|s| !s.is_null()).unwrap_or(false);
    let tools: Vec<String> = v
        .get("tools")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let inferred = if auth == Some("notLoggedIn") {
        "needs-auth"
    } else if has_info {
        "connected"
    } else {
        "disconnected"
    };
    // A recorded `failed` startup wins over the inference and supplies the reason
    // (the structured `reauthenticationRequired`, or the free-text error as a fallback).
    let (status, failure_reason) = match startup.get(name.as_str()) {
        Some(s) if s.state == "failed" => (
            "failed".to_string(),
            s.failure_reason.clone().or_else(|| s.error.clone()),
        ),
        _ => (inferred.to_string(), None),
    };
    McpServerLive {
        name,
        status,
        scope: Some("user".to_string()),
        transport: None,
        command: None,
        url: None,
        tool_count: tools.len() as u32,
        tools,
        failure_reason,
    }
}

/// Map a Codex `RateLimitSnapshot` to the shared [`crate::usage::PlanUsage`] the plan
/// popover renders. The two windows are told apart by `windowDurationMins` (300 → 5h,
/// 10080 → weekly); a window with any other/absent duration is skipped rather than
/// mislabeled. `None` when neither window is usable (the actor then emits nothing).
fn rate_limits_to_plan_usage(snap: &RateLimitSnapshot) -> Option<crate::usage::PlanUsage> {
    let mut five_hour = None;
    let mut seven_day = None;
    for w in [snap.primary.as_ref(), snap.secondary.as_ref()]
        .into_iter()
        .flatten()
    {
        match w.window_duration_mins {
            Some(300) => five_hour = Some(rate_limit_window(w)),
            Some(10080) => seven_day = Some(rate_limit_window(w)),
            _ => {}
        }
    }
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(crate::usage::PlanUsage {
        five_hour,
        seven_day,
        // Codex has no per-model allowance: its snapshot carries exactly two windows
        // (`primary`/`secondary`), so there is nothing scoped to report.
        scoped: Vec::new(),
    })
}

/// One Codex rate-limit window → the shared UI window shape. `usedPercent` is already
/// 0–100 (used verbatim, the UI clamps). `resetsAt` is normalized to an epoch-SECONDS
/// digit string — the exact form the front's `resetToEpochSeconds` reads (it treats a
/// digits-only value as seconds), so the unit can never be misread.
fn rate_limit_window(w: &RateLimitWindow) -> crate::usage::UsageWindow {
    crate::usage::UsageWindow {
        used_percentage: w.used_percent,
        resets_at: w.resets_at.map(epoch_to_seconds_string),
    }
}

/// Normalize an epoch reset time to a Unix-SECONDS digit string. Codex may send seconds
/// or milliseconds; we disambiguate by magnitude (any plausible date is < 1e11 s but
/// > 1e11 ms), so a ms value is divided down. Matches the "epoch-seconds digits" shape
/// the front already parses.
fn epoch_to_seconds_string(n: f64) -> String {
    let secs = if n >= 1e11 {
        (n / 1000.0).round() as i64
    } else {
        n.round() as i64
    };
    secs.to_string()
}

/// Whether a failed `turn/steer` may have actually been APPLIED server-side — in which
/// case re-sending the same input as a fresh `turn/start` could inject the user's
/// message TWICE. Only a `Timeout` is uncertain: the request WAS written to the server
/// and only the response is missing (a late success is dropped by the demux). An
/// in-band `Rpc` rejection is provably atomic (nothing injected), and `Closed`/
/// `Transport` mean the server is gone — the live turn died with it, so a re-send
/// can't duplicate.
fn steer_outcome_uncertain(e: &CodexError) -> bool {
    matches!(e, CodexError::Timeout(_))
}

/// The display text of an echoed `userMessage` item's `content` (a raw `UserInput[]`):
/// its text parts joined, or the `[image]` placeholder for an attachment-only turn —
/// the same placeholder the cold rollout reader and the Claude path use, so a bridge turn
/// reads identically live and after a reload.
fn user_input_text(content: &[Value]) -> String {
    let mut text = String::new();
    let mut has_image = false;
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
            }
            // `localImage` (what we send) and any future image variant.
            Some(t) if t.to_ascii_lowercase().contains("image") => has_image = true,
            _ => {}
        }
    }
    if text.trim().is_empty() && has_image {
        return "[image]".to_string();
    }
    text
}

/// Build the `turn/start` input blocks from a message: the text (if any) then one
/// `localImage` per joined image. Codex reads images from a file PATH (unlike Claude's
/// inline base64), so each attachment is materialized under `dir` (the session's
/// private attachments dir). Returns the inputs PLUS one human-readable reason per
/// attachment that could NOT be materialized — the caller surfaces them, never a
/// silently amputated send. Guarantees at least one block (an empty text) so an
/// image-only turn still has valid input, EXCEPT when every block failed (empty
/// inputs + non-empty failures): then the caller refuses the turn instead of
/// fabricating a blank one.
fn user_inputs(
    text: String,
    images: &[ImageAttachment],
    dir: &Path,
) -> (Vec<UserInput>, Vec<String>) {
    let mut inputs = Vec::new();
    let mut failed = Vec::new();
    if !text.trim().is_empty() {
        inputs.push(UserInput::text(text));
    }
    for img in images {
        match materialize_image(img, dir) {
            Ok(path) => inputs.push(UserInput::local_image(path)),
            Err(reason) => failed.push(reason),
        }
    }
    if inputs.is_empty() && failed.is_empty() {
        inputs.push(UserInput::text(String::new()));
    }
    (inputs, failed)
}

/// Write a base64 image attachment under `dir` (the session's attachments dir, created
/// lazily here) and return its path, so it can be referenced as a Codex `localImage`.
/// `Err` carries a human-readable (UI-bound) reason — undecodable base64 or an
/// unwritable temp dir — for the caller to surface. Files must OUTLIVE the turn (the
/// app-server reads them from disk mid-turn), so no per-file deletion here: the whole
/// dir is removed at actor teardown (`CodexCore::cleanup_images_dir`).
fn materialize_image(img: &ImageAttachment, dir: &Path) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(img.data.trim())
        .map_err(|e| format!("unreadable image (invalid base64: {e})"))?;
    let ext = match img.media_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("temp dir unreachable ({}): {e}", dir.display()))?;
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("couldn't write the image ({}): {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

/// Join a reasoning item's `summary` (human-facing) then `content` (raw chain, often
/// redacted/empty) into one Thinking blob, dropping empties.
fn join_reasoning(summary: &[String], content: &[String]) -> String {
    summary
        .iter()
        .chain(content.iter())
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::{BackgroundTask, SlashCommand};
    use std::sync::Mutex;

    /// A synchronous sink that records everything the actor emits, for assertions.
    #[derive(Default)]
    struct Sink {
        items: Mutex<Vec<ConversationItem>>,
        perms: Mutex<Vec<PermissionRequestPayload>>,
        states: Mutex<Vec<SessionStatePayload>>,
        plan_usages: Mutex<Vec<crate::usage::PlanUsage>>,
        tasks: Mutex<Vec<BackgroundTask>>,
    }
    impl SessionEmitter for Sink {
        fn emit_state(&self, _s: &str, state: &SessionStatePayload) {
            self.states.lock().unwrap().push(state.clone());
        }
        fn emit_item(&self, _s: &str, item: &ConversationItem) {
            self.items.lock().unwrap().push(item.clone());
        }
        fn emit_permission(&self, _s: &str, r: &PermissionRequestPayload) {
            self.perms.lock().unwrap().push(r.clone());
        }
        fn emit_commands(&self, _s: &str, _c: &[SlashCommand]) {}
        fn emit_task(&self, _s: &str, t: &BackgroundTask) {
            self.tasks.lock().unwrap().push(t.clone());
        }
        fn emit_title(&self, _s: &str, _t: &str, _q: u32) {}
        fn emit_summary(&self, _s: &str, _t: &str, _q: u32) {}
        fn emit_remote_control(&self, _s: &str, _st: &RemoteControlState) {}
        fn emit_codex_plan_usage(&self, _s: &str, usage: &crate::usage::PlanUsage) {
            self.plan_usages.lock().unwrap().push(usage.clone());
        }
    }

    fn core() -> (CodexCore, Arc<Sink>) {
        let sink = Arc::new(Sink::default());
        let emitter: Arc<dyn SessionEmitter> = sink.clone();
        (CodexCore::new("c".into(), emitter), sink)
    }

    fn items(sink: &Sink) -> Vec<ConversationItem> {
        sink.items.lock().unwrap().clone()
    }

    /// Does any emitted item carry a ToolUse block with this name + id?
    fn has_tool_use(items: &[ConversationItem], name: &str, id: &str) -> bool {
        items.iter().any(|i| {
            matches!(i, ConversationItem::AssistantMessage { blocks, .. }
                if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name: n, id: i, .. } if n == name && i == id)))
        })
    }
    fn tool_result<'a>(items: &'a [ConversationItem], id: &str) -> Option<&'a ConversationItem> {
        items
            .iter()
            .find(|i| matches!(i, ConversationItem::ToolResult { tool_use_id, .. } if tool_use_id == id))
    }

    fn notice<'a>(items: &'a [ConversationItem]) -> Vec<(&'a str, &'a str, &'a str)> {
        items
            .iter()
            .filter_map(|i| match i {
                ConversationItem::Notice { subtype, detail } if subtype == "control_change" => Some((
                    detail["control"].as_str().unwrap_or(""),
                    detail["from"].as_str().unwrap_or(""),
                    detail["to"].as_str().unwrap_or(""),
                )),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn announce_control_changes_seeds_baseline_then_diffs_backend_confirmed() {
        let (mut c, sink) = core();
        // FIRST confirmed turn only SEEDS the baseline — never a phantom transition.
        c.controls = CodexControls {
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
            sandbox: Some("workspaceWrite".into()),
            approval_policy: Some("on-request".into()),
            network_access: Some(true),
            summary: Some("auto".into()),
            personality: Some("none".into()),
            service_tier: None,
        };
        c.announce_control_changes();
        assert!(
            notice(&items(&sink)).is_empty(),
            "the first confirmed turn seeds the baseline and announces nothing"
        );

        // Effort moves high → low: exactly one line, English labels (Claude parity).
        c.controls.effort = Some("low".into());
        c.announce_control_changes();
        assert_eq!(
            notice(&items(&sink)),
            vec![("Thinking effort", "High", "Low")],
            "only the moved control announces, once, with the friendly English label"
        );
    }

    #[test]
    fn preset_flip_is_a_single_permissions_line_not_two() {
        let (mut c, sink) = core();
        // Baseline = "Standard" (workspaceWrite + on-request).
        c.controls = CodexControls {
            sandbox: Some("workspaceWrite".into()),
            approval_policy: Some("on-request".into()),
            ..Default::default()
        };
        c.announce_control_changes(); // seed
        // "Standard" → "Auto" flips the approval axis, but it is ONE preset the user picked —
        // so exactly ONE "Permissions" line, not a separate sandbox + approval pair.
        c.controls.approval_policy = Some("never".into());
        c.announce_control_changes();
        assert_eq!(
            notice(&items(&sink)),
            vec![("Permissions", "Standard", "Auto")],
        );
    }

    #[test]
    fn codex_model_label_mirrors_the_composer_picker() {
        assert_eq!(codex_model_label(Some("gpt-5.6-sol")), "GPT-5.6 Sol");
        assert_eq!(codex_model_label(Some("gpt-5.4-mini")), "GPT-5.4 Mini");
        assert_eq!(codex_model_label(Some("gpt-5.5")), "GPT-5.5");
        assert_eq!(codex_model_label(None), "(default)");
    }

    #[test]
    fn assistant_item_is_tagged_with_its_own_turn_not_the_latest_turn_pointer() {
        // Guards the steer-race: a buffered tail item from turn A can be drained AFTER turn B
        // has started (current_turn_id = B). It must be tagged with ITS OWN turn (A), not the
        // latest-turn pointer (B), so native rewind/fork cuts at the right boundary.
        let (mut c, sink) = core();
        c.current_turn_id = Some("B".into());
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"agentMessage","id":"mA","text":"tail of turn A"},"threadId":"t","turnId":"A","completedAtMs":0}),
        );
        let tagged = items(&sink).into_iter().find_map(|i| match i {
            ConversationItem::AssistantMessage { id, turn_id, .. } if id == "mA" => Some(turn_id),
            _ => None,
        });
        assert_eq!(
            tagged,
            Some(Some("A".to_string())),
            "tagged with its own turn (A), not the latest-turn pointer (B)"
        );
    }

    #[test]
    fn token_usage_ring_uses_last_turn_input_not_cumulative_total() {
        // The context ring must show CURRENT occupancy (the last turn's input = the full
        // prompt), not the cumulative lifetime `total.totalTokens` (which only grows → a false
        // "near max"). Window is the authoritative wire `modelContextWindow`.
        let (mut c, sink) = core();
        c.on_notification(
            "thread/tokenUsage/updated",
            json!({
                "threadId": "t",
                "turnId": "u",
                "tokenUsage": {
                    "modelContextWindow": 400000,
                    "total": { "cachedInputTokens": 0, "inputTokens": 900000, "outputTokens": 40000, "reasoningOutputTokens": 10000, "totalTokens": 950000 },
                    "last": { "cachedInputTokens": 20000, "inputTokens": 42000, "outputTokens": 500, "reasoningOutputTokens": 100, "totalTokens": 42600 }
                }
            }),
        );
        let st = sink.states.lock().unwrap().last().cloned().expect("a state was emitted");
        assert_eq!(st.context_window, Some(400_000), "window = authoritative modelContextWindow");
        assert_eq!(
            st.context_tokens,
            Some(42_000),
            "ring = last turn's input (current occupancy), NOT the 950k cumulative total"
        );
    }

    #[test]
    fn codex_title_truncates_to_a_few_words_from_the_first_line() {
        // Multi-message intent (joined with newlines): the title comes from the FIRST line.
        let t = codex_title_from_description("ajoute un bouton de export\nfais aussi les tests");
        assert_eq!(t.as_deref(), Some("ajoute un bouton de export"));
    }

    #[test]
    fn codex_title_drops_a_leading_slash_command() {
        assert_eq!(
            codex_title_from_description("/pickup refonte de la page login").as_deref(),
            Some("refonte de la page login"),
        );
        // A bare slash-command with nothing after it keeps the token (better than nothing).
        assert_eq!(codex_title_from_description("/done").as_deref(), Some("/done"));
    }

    #[test]
    fn codex_title_caps_length_and_trims_trailing_punctuation() {
        let long = "un deux trois quatre cinq six sept huit neuf dix onze douze";
        let t = codex_title_from_description(long).unwrap();
        assert!(t.chars().count() <= 48, "title too long: {t:?}");
        assert!(long.starts_with(&t));
        // Trailing punctuation is stripped.
        assert_eq!(codex_title_from_description("corrige le bug !").as_deref(), Some("corrige le bug"));
    }

    #[test]
    fn codex_title_is_none_for_blank_input() {
        assert_eq!(codex_title_from_description(""), None);
        assert_eq!(codex_title_from_description("   \n  \n"), None);
    }

    /// A throwaway attachments dir for `user_inputs` tests (the per-session dir the
    /// actor normally owns).
    fn tmp_images_dir() -> PathBuf {
        std::env::temp_dir()
            .join("flightdeck-codex-attachments")
            .join(format!("test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn user_inputs_builds_text_then_images_and_never_empty() {
        let dir = tmp_images_dir();
        // Plain text → a single text block, no failures.
        let (inputs, failed) = user_inputs("hello".into(), &[], &dir);
        assert!(failed.is_empty());
        let v = serde_json::to_value(&inputs).unwrap();
        assert_eq!(v, serde_json::json!([{"type":"text","text":"hello"}]));
        // Empty text, no image → still one (empty) text block so the turn has valid input.
        let (inputs, failed) = user_inputs("   ".into(), &[], &dir);
        assert!(failed.is_empty());
        assert_eq!(inputs.len(), 1);
        // A real image materializes to a localImage pointing at a file in the given dir.
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, 0x50, 0x4e, 0x47]);
        let img = ImageAttachment { media_type: "image/png".into(), data: png };
        let (inputs, failed) = user_inputs("look".into(), std::slice::from_ref(&img), &dir);
        assert!(failed.is_empty());
        let v = serde_json::to_value(&inputs).unwrap();
        assert_eq!(v[0]["type"], "text");
        assert_eq!(v[1]["type"], "localImage");
        let path = v[1]["path"].as_str().unwrap();
        assert!(std::path::Path::new(path).is_file(), "the image must be written to disk");
        assert!(path.starts_with(dir.to_string_lossy().as_ref()), "the file lives in the session dir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_inputs_reports_failed_attachments_instead_of_silently_dropping() {
        let dir = tmp_images_dir();
        // Undecodable base64 → the attachment comes back as a FAILURE, never vanishes.
        let bad = ImageAttachment { media_type: "image/png".into(), data: "not!base64!!".into() };
        let (inputs, failed) = user_inputs("look".into(), std::slice::from_ref(&bad), &dir);
        assert_eq!(inputs.len(), 1, "the text still goes");
        assert_eq!(failed.len(), 1, "the dropped attachment must be reported");
        // An image-only send where EVERY attachment failed yields NO inputs (the caller
        // then refuses the turn) rather than a fabricated blank turn.
        let (inputs, failed) = user_inputs("  ".into(), std::slice::from_ref(&bad), &dir);
        assert!(inputs.is_empty(), "nothing survived → no fabricated empty input");
        assert_eq!(failed.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn steer_timeout_is_uncertain_but_rejection_and_closed_are_not() {
        // A Timeout may have been APPLIED server-side (only the response is missing) →
        // re-sending could duplicate the message; an in-band rejection is atomic and
        // Closed means the live turn died with the server → both safe to fall through.
        assert!(steer_outcome_uncertain(&CodexError::Timeout("turn/steer")));
        assert!(!steer_outcome_uncertain(&CodexError::Rpc("not steerable".into())));
        assert!(!steer_outcome_uncertain(&CodexError::Closed));
    }

    #[test]
    fn codex_model_passes_codex_ids_and_drops_claude_aliases() {
        let mut cfg = SpawnConfig::new(std::env::temp_dir());
        // A real Codex id (what the front seeds a Codex conversation with) passes through.
        cfg.model = Some("gpt-5.5".into());
        assert_eq!(codex_model(&cfg).as_deref(), Some("gpt-5.5"));
        // A Claude alias / resolved id would be rejected by Codex → fall back to default.
        for alias in ["opus", "sonnet", "haiku", "fable", "claude-opus-4-8"] {
            cfg.model = Some(alias.into());
            assert_eq!(codex_model(&cfg), None, "claude alias {alias} must yield None");
        }
        // Blank / unset → None (server default).
        cfg.model = Some("   ".into());
        assert_eq!(codex_model(&cfg), None);
        cfg.model = None;
        assert_eq!(codex_model(&cfg), None);
    }

    #[test]
    fn agent_message_streams_then_finalizes_as_text() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/agentMessage/delta",
            json!({"threadId":"t","turnId":"u","itemId":"m1","delta":"Hel"}),
        );
        c.on_notification(
            "item/agentMessage/delta",
            json!({"threadId":"t","turnId":"u","itemId":"m1","delta":"lo"}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"agentMessage","id":"m1","text":"Hello"},"threadId":"t","turnId":"u","completedAtMs":0}),
        );
        let items = items(&sink);
        // One MessageStarted (only on the first delta), two TextDeltas, one authoritative message.
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::MessageStarted { .. })).count(),
            1
        );
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::TextDelta { .. })).count(),
            2
        );
        assert!(items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { id, blocks, .. }
            if id == "m1" && matches!(blocks.as_slice(), [NormalizedBlock::Text { text }] if text == "Hello"))));
    }

    #[test]
    fn reasoning_maps_to_thinking_never_text() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/reasoning/textDelta",
            json!({"threadId":"t","turnId":"u","itemId":"r1","delta":"think","contentIndex":0}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"reasoning","id":"r1","summary":["planning the fix"],"content":[]}}),
        );
        let items = items(&sink);
        // The streamed token is a ThinkingDelta, and the final block is Thinking — NEVER Text
        // (a Text block would leak the raw reasoning into the visible answer).
        assert!(items.iter().any(|i| matches!(i, ConversationItem::ThinkingDelta { .. })));
        assert!(items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if matches!(blocks.as_slice(), [NormalizedBlock::Thinking { text }] if text == "planning the fix"))));
        assert!(!items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::Text { .. })))));
        assert!(!items.iter().any(|i| matches!(i, ConversationItem::TextDelta { .. })));
    }

    #[test]
    fn command_synthesizes_tool_use_result_pair() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"ls -la","cwd":"/tmp","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"c1","command":"ls -la","cwd":"/tmp","aggregatedOutput":"a\nb","exitCode":0,"status":"completed"}}),
        );
        let items = items(&sink);
        // A Bash tool card keyed by item.id, then a ToolResult with the same id — the pair
        // that lets clean-output fold. The card is emitted ONCE (only on start).
        assert!(has_tool_use(&items, "Bash", "c1"));
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "c1")).count(),
            1,
            "the ToolUse card must not be duplicated on completion"
        );
        match tool_result(&items, "c1") {
            Some(ConversationItem::ToolResult { is_error, content, .. }) => {
                assert!(!is_error);
                assert_eq!(content, &json!("a\nb"));
            }
            _ => panic!("expected a ToolResult for c1"),
        }
    }

    #[test]
    fn command_nonzero_exit_is_an_error() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"c9","command":"false","exitCode":1,"status":"completed"}}),
        );
        let items = items(&sink);
        // Even with no item/started, the pair is synthesized (dropped-start robustness).
        assert!(has_tool_use(&items, "Bash", "c9"));
        assert!(matches!(tool_result(&items, "c9"), Some(ConversationItem::ToolResult { is_error: true, .. })));
    }

    #[test]
    fn file_change_maps_to_apply_patch_with_diffs() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"src/a.rs","kind":"modify","diff":"@@ -1 +1 @@"}]}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "ApplyPatch", "f1"));
        // The diffs are on the result too, so they're visible regardless of the started item.
        match tool_result(&items, "f1") {
            Some(ConversationItem::ToolResult { content, is_error, .. }) => {
                assert!(!is_error);
                assert!(content.to_string().contains("src/a.rs"));
            }
            _ => panic!("expected a ToolResult for f1"),
        }
    }

    #[test]
    fn mcp_tool_call_maps_to_namespaced_tool() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"mcpToolCall","id":"x1","server":"tosse","tool":"get_tasks","status":"completed","arguments":{"a":1},"result":{"ok":true}}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "mcp__tosse__get_tasks", "x1"));
        assert!(matches!(tool_result(&items, "x1"), Some(ConversationItem::ToolResult { is_error: false, .. })));
    }

    /// The result `content` of the tool card keyed `id`, for asserting on synthesized cards.
    fn result_content<'a>(items: &'a [ConversationItem], id: &str) -> Option<&'a Value> {
        items.iter().find_map(|i| match i {
            ConversationItem::ToolResult { tool_use_id, content, .. } if tool_use_id == id => Some(content),
            _ => None,
        })
    }

    /// A unique temp file holding `bytes`, so `read_image` has something real to encode.
    fn temp_image(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("tosse_codex_item_{tag}.png"));
        std::fs::write(&p, bytes).expect("write temp image");
        p
    }

    #[test]
    fn image_view_maps_to_read_card_with_inline_image_block() {
        let path = temp_image("iv", b"\x89PNG\r\n\x1a\nfake-bytes");
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"imageView","id":"iv1","path": path.to_string_lossy()}}),
        );
        let items = items(&sink);
        // Rendered as a Read card (its label surfaces the path) — the SAME vehicle as a
        // Claude screenshot read — carrying the base64 image block the front already renders.
        assert!(has_tool_use(&items, "Read", "iv1"));
        match result_content(&items, "iv1") {
            Some(content) => {
                let arr = content.as_array().expect("image result is an array");
                assert_eq!(arr[0]["type"], "image");
                assert_eq!(arr[0]["source"]["type"], "base64");
                assert_eq!(arr[0]["source"]["media_type"], "image/png");
                assert!(arr[0]["source"]["data"].as_str().is_some_and(|d| !d.is_empty()));
            }
            None => panic!("expected a ToolResult for iv1"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn image_view_missing_file_degrades_to_text_note_never_a_blank_card() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"imageView","id":"iv2","path":"/nope/does-not-exist.png"}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "Read", "iv2"));
        let content = result_content(&items, "iv2").expect("a ToolResult for iv2");
        // Not an image array — a human note that still names the path (never a silent blank).
        assert!(content.as_str().is_some_and(|s| s.contains("does-not-exist.png")));
    }

    #[test]
    fn image_generation_card_carries_prompt_and_produced_image() {
        let path = temp_image("ig", b"generated-bytes");
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"imageGeneration","id":"ig1","status":"completed","revisedPrompt":"a red fox","result":"","savedPath": path.to_string_lossy()}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "ImageGeneration", "ig1"));
        let arr = result_content(&items, "ig1").and_then(Value::as_array).expect("array content");
        assert!(arr.iter().any(|b| b["type"] == "text" && b["text"].as_str().is_some_and(|t| t.contains("a red fox"))));
        assert!(arr.iter().any(|b| b["type"] == "image"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn dynamic_tool_call_maps_to_namespaced_generic_card() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"dynamicToolCall","id":"dt1","namespace":"plugins","tool":"lint","arguments":{"file":"a.rs"},"status":"completed","success":true,"contentItems":[{"type":"inputText","text":"no issues found"}]}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "plugins:lint", "dt1"));
        let arr = result_content(&items, "dt1").and_then(Value::as_array).expect("array content");
        assert!(arr.iter().any(|b| b["text"].as_str() == Some("no issues found")));
        assert!(matches!(tool_result(&items, "dt1"), Some(ConversationItem::ToolResult { is_error: false, .. })));
    }

    #[test]
    fn dynamic_tool_call_failure_marks_result_as_error() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"dynamicToolCall","id":"dt2","tool":"deploy","arguments":{},"status":"failed","success":false}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "deploy", "dt2"));
        assert!(matches!(tool_result(&items, "dt2"), Some(ConversationItem::ToolResult { is_error: true, .. })));
    }

    #[test]
    fn collab_agent_tool_call_renders_a_readable_spawn_card() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"collabAgentToolCall","id":"co1","tool":"spawnAgent","status":"completed","senderThreadId":"s","receiverThreadIds":["r1","r2"],"prompt":"refactor the auth module","model":"gpt-5.6","reasoningEffort":"ultra","agentsStates":{"r1":{"status":"running"},"r2":{"status":"completed"}}}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "Spawning a sub-agent", "co1"), "readable action label");
        let text = result_content(&items, "co1").and_then(Value::as_str).expect("collab card body");
        assert!(text.contains("refactor the auth module"), "the delegated task is shown");
        assert!(text.contains("gpt-5.6") && text.contains("ultra"), "model + effort shown");
        assert!(text.contains("Sub-agents (2)") && text.contains("1 running") && text.contains("1 completed"), "states summarized, not raw JSON");
    }

    fn tasks(sink: &Sink) -> Vec<BackgroundTask> {
        sink.tasks.lock().unwrap().clone()
    }
    /// The LAST emitted task for a given task_id (the store keeps the latest via
    /// replace-by-`task_id`), so assertions read the settled state.
    fn last_task(sink: &Sink, task_id: &str) -> Option<BackgroundTask> {
        tasks(sink).into_iter().rev().find(|t| t.task_id == task_id)
    }

    #[test]
    fn collab_promotes_each_sub_agent_into_a_fleet_task_keyed_by_thread() {
        let (mut c, sink) = core();
        // A subAgentActivity carries the NAME (agentsStates omits it); it should enrich the
        // fleet task for that thread.
        c.on_notification(
            "item/started",
            json!({"item":{"type":"subAgentActivity","id":"sa1","kind":"started","agentThreadId":"r1","agentPath":"agents/reviewer"}}),
        );
        // spawnAgent: two receivers, one running one completed → two Agent tasks, keyed by
        // their thread ids, with the spawned model pinned.
        c.on_notification(
            "item/started",
            json!({"item":{"type":"collabAgentToolCall","id":"co1","tool":"spawnAgent","status":"inProgress","senderThreadId":"s","receiverThreadIds":["r1","r2"],"prompt":"refactor auth","model":"gpt-5.6","reasoningEffort":"ultra","agentsStates":{"r1":{"status":"running","message":"lecture des fichiers"},"r2":{"status":"pendingInit"}}}}),
        );

        let r1 = last_task(&sink, "r1").expect("a fleet task for sub-agent r1");
        assert!(matches!(r1.kind, BackgroundTaskKind::Agent), "sub-agent counts as an Agent task");
        assert!(matches!(r1.status, BackgroundTaskStatus::Running), "running → Running");
        assert_eq!(r1.label.as_deref(), Some("reviewer"), "name enriched from subAgentActivity path");
        assert_eq!(r1.model.as_deref(), Some("gpt-5.6"), "spawned model pinned onto the task");
        assert_eq!(r1.progress.as_deref(), Some("lecture des fichiers"), "agentsStates message = live progress");
        // No thread routing → nothing to drill / no per-agent stop wire: front renders these
        // display-only, and a Codex tool card keeps its foreground-safe atomStillRunning fallback.
        assert!(r1.tool_use_id.is_none() && r1.output_file.is_none(), "no anchor / no transcript file");

        let r2 = last_task(&sink, "r2").expect("a fleet task for sub-agent r2");
        assert!(matches!(r2.status, BackgroundTaskStatus::Running), "pendingInit → Running (still working)");
        // r2 never got a subAgentActivity (its name is unknown) → a stable fallback label,
        // never an empty string.
        assert_eq!(r2.label.as_deref(), Some("Sub-agent"), "unnamed sub-agent falls back to a stable label");

        // A later `wait` completing flips both to terminal via the cumulative snapshot.
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"collabAgentToolCall","id":"co2","tool":"wait","status":"completed","senderThreadId":"s","receiverThreadIds":[],"agentsStates":{"r1":{"status":"completed"},"r2":{"status":"errored"}}}}),
        );
        assert!(matches!(last_task(&sink, "r1").unwrap().status, BackgroundTaskStatus::Completed), "completed → Completed");
        assert!(matches!(last_task(&sink, "r2").unwrap().status, BackgroundTaskStatus::Failed), "errored → Failed");
        // The collab item itself is STILL rendered as an in-thread card (never dropped).
        assert!(has_tool_use(&items(&sink), "Spawning a sub-agent", "co1"));
    }

    #[test]
    fn spawn_before_activity_names_the_subagent_and_preserves_progress() {
        let (mut c, sink) = core();
        // Realistic Codex order: spawnAgent FIRST (carries agentsStates + a live message),
        // THEN a subAgentActivity that only adds the sub-agent's name.
        c.on_notification(
            "item/started",
            json!({"item":{"type":"collabAgentToolCall","id":"co1","tool":"spawnAgent","status":"inProgress","senderThreadId":"s","receiverThreadIds":["r9"],"prompt":"build","model":"gpt-5.6","reasoningEffort":"high","agentsStates":{"r9":{"status":"running","message":"compilation"}}}}),
        );
        let before = last_task(&sink, "r9").expect("task from the spawn snapshot");
        assert_eq!(before.label.as_deref(), Some("Sub-agent"), "no name yet → stable fallback");
        assert_eq!(before.progress.as_deref(), Some("compilation"), "agentsStates message = live progress");

        // The subAgentActivity carries NO message — it must ENRICH the name WITHOUT wiping the
        // live progress back to None (replace-by-task_id would otherwise clobber it).
        c.on_notification(
            "item/started",
            json!({"item":{"type":"subAgentActivity","id":"sa1","kind":"started","agentThreadId":"r9","agentPath":"agents/builder"}}),
        );
        let after = last_task(&sink, "r9").expect("task after the activity marker");
        assert_eq!(after.label.as_deref(), Some("builder"), "name enriched from agentPath");
        assert_eq!(after.progress.as_deref(), Some("compilation"), "progress preserved, not blanked to None");
    }

    #[test]
    fn interrupted_sub_agent_activity_stops_its_fleet_task() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"subAgentActivity","id":"sa1","kind":"interrupted","agentThreadId":"z9","agentPath":"agents/foo"}}),
        );
        let t = last_task(&sink, "z9").expect("a fleet task keyed by the sub-agent thread");
        assert!(matches!(t.status, BackgroundTaskStatus::Stopped), "interrupted → Stopped (no fake green backgrounding)");
    }

    #[test]
    fn turn_end_settles_a_still_running_sub_agent_no_false_green() {
        let (mut c, sink) = core();
        // A spawn snapshot: sub1 is still running, sub2 already completed.
        c.on_notification(
            "item/started",
            json!({"item":{"type":"collabAgentToolCall","id":"co1","tool":"spawnAgent","status":"inProgress","senderThreadId":"s","receiverThreadIds":["sub1","sub2"],"model":"gpt-5.6","agentsStates":{"sub1":{"status":"running"},"sub2":{"status":"completed"}}}}),
        );
        assert!(matches!(last_task(&sink, "sub1").unwrap().status, BackgroundTaskStatus::Running), "sub1 starts Running");

        // The turn ends — a normal completion OR an interrupt both land in on_turn_completed.
        c.on_turn_completed(json!({}));

        // The still-running, in-turn sub-agent settles to a terminal status: no phantom fleet
        // "running" (false-green) left once the turn is over and its thread is unrouted.
        assert!(
            matches!(last_task(&sink, "sub1").unwrap().status, BackgroundTaskStatus::Stopped),
            "a still-running Codex sub-agent settles to Stopped at turn end",
        );
        // An already-terminal sub-agent is NOT downgraded — its real outcome is preserved.
        assert!(
            matches!(last_task(&sink, "sub2").unwrap().status, BackgroundTaskStatus::Completed),
            "an already-terminal sub-agent keeps its real outcome",
        );
    }

    #[test]
    fn sleep_and_review_and_compaction_render_marker_cards() {
        let (mut c, sink) = core();
        c.on_notification("item/completed", json!({"item":{"type":"sleep","id":"sl1","durationMs":2500}}));
        c.on_notification("item/completed", json!({"item":{"type":"enteredReviewMode","id":"rm1","review":"security"}}));
        c.on_notification("item/completed", json!({"item":{"type":"contextCompaction","id":"cc1"}}));
        c.on_notification("item/completed", json!({"item":{"type":"subAgentActivity","id":"sa1","kind":"started","agentThreadId":"t","agentPath":"agents/foo"}}));
        let items = items(&sink);
        assert!(has_tool_use(&items, "Sleep", "sl1"));
        assert!(result_content(&items, "sl1").and_then(Value::as_str).is_some_and(|s| s.contains("2.5")));
        assert!(has_tool_use(&items, "ReviewMode", "rm1"));
        assert!(result_content(&items, "rm1").and_then(Value::as_str).is_some_and(|s| s.contains("security")));
        assert!(has_tool_use(&items, "Compaction", "cc1"));
        assert!(has_tool_use(&items, "Sub-agent", "sa1"));
        // The bare path is turned into a readable name + an English verb.
        assert!(result_content(&items, "sa1").and_then(Value::as_str).is_some_and(|s| s.contains("\"foo\"") && s.contains("started")));
    }

    #[test]
    fn web_search_open_page_renders_a_claude_style_source_chip() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"webSearch","id":"ws1","query":"","action":{"type":"open_page","url":"https://serde.rs/enum-representations.html"}}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "WebSearch", "ws1"));
        let text = result_content(&items, "ws1").and_then(Value::as_str).expect("web result text");
        // Same `Links: [{title,url}]` shape a Claude WebSearch takes → parseWebSearch chips it.
        assert!(text.starts_with("Links: ["), "emits the Claude Links array shape");
        assert!(text.contains("\"url\":\"https://serde.rs/enum-representations.html\""), "carries the visited URL");
        assert!(text.contains("\"title\":\"serde.rs\""), "host as the chip title");
    }

    #[test]
    fn web_search_search_action_lists_the_queries() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"webSearch","id":"ws2","query":"","action":{"type":"search","query":"gpt-5.6 release","queries":["gpt-5.6 release","openai gpt-5.6 docs"]}}}),
        );
        let items = items(&sink);
        assert!(has_tool_use(&items, "WebSearch", "ws2"));
        let text = result_content(&items, "ws2").and_then(Value::as_str).expect("web result text");
        // A search has no result set → the queries are surfaced as a summary (no fake chips).
        assert!(!text.contains("Links:"), "a bare search emits no source chips");
        assert!(text.contains("gpt-5.6 release") && text.contains("openai gpt-5.6 docs"), "lists the searched queries");
    }

    #[test]
    fn unknown_future_item_surfaces_a_generic_card_never_a_silent_drop() {
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"quantumTool","id":"q1","payload":42}}),
        );
        let items = items(&sink);
        // A type this build does not model still gets a named card keyed by its own id.
        assert!(has_tool_use(&items, "quantumTool", "q1"));
        assert!(result_content(&items, "q1").and_then(Value::as_str).is_some_and(|s| s.contains("Unmodelled")));
    }

    #[test]
    fn a_known_item_with_a_drifted_field_surfaces_a_card_not_a_silent_drop() {
        // A future wire drift on a MODELED item (here commandExecution.exitCode arrives as a
        // string, not an i64) makes ItemEnvelope decode fail. It must NOT vanish: the raw
        // type/id surface a generic error card, honoring "never a silent drop" even when the
        // whole-item decode fails (not just for an unknown tag).
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"cx1","command":"ls","exitCode":"boom"}}),
        );
        let items = items(&sink);
        assert!(!items.is_empty(), "a decode failure must not be a silent drop");
        assert!(has_tool_use(&items, "commandExecution", "cx1"), "surfaced as a card named after the raw type");
        match tool_result(&items, "cx1") {
            Some(ConversationItem::ToolResult { is_error, content, .. }) => {
                assert!(is_error, "an undecodable item is flagged as an error");
                assert!(content.as_str().is_some_and(|s| s.contains("Unreadable")));
            }
            _ => panic!("expected an error ToolResult for cx1"),
        }
    }

    #[test]
    fn a_drifted_item_without_an_id_surfaces_a_protocol_notice() {
        // No id to key a card on → a visible protocol_error notice rather than a silent drop.
        let (mut c, sink) = core();
        c.on_notification(
            "item/completed",
            json!({"item":{"type":"commandExecution","exitCode":"boom"}}),
        );
        let items = items(&sink);
        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "protocol_error")),
            "an undecodable id-less item surfaces a protocol_error notice"
        );
    }

    #[test]
    fn user_message_and_hook_prompt_items_are_not_surfaced() {
        let (mut c, sink) = core();
        c.on_notification("item/completed", json!({"item":{"type":"userMessage","id":"um1","clientId":null,"content":[]}}));
        c.on_notification("item/completed", json!({"item":{"type":"hookPrompt","id":"hp1","fragments":[]}}));
        assert!(items(&sink).is_empty(), "echoed user/hook items must not add timeline items");
    }

    #[test]
    fn stale_turn_completed_does_not_settle_the_live_turn() {
        let (mut c, _sink) = core();
        c.current_turn_id = Some("T_new".into());
        c.state.busy = true;
        // A late completion for a DIFFERENT (already-superseded) turn — as produced by
        // the steer-race fallthrough — must NOT clear the live turn's busy/id.
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"T_old","status":"completed"}}),
        );
        assert!(c.state.busy, "a stale completion must not clear the live turn's busy");
        assert_eq!(c.current_turn_id.as_deref(), Some("T_new"), "live turn id preserved");
        // The live turn's own completion settles it.
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"T_new","status":"completed"}}),
        );
        assert!(!c.state.busy, "the current turn's completion settles busy");
        assert!(c.current_turn_id.is_none(), "current turn id cleared on its own completion");
    }

    /// The finished-turn footer duration (`TurnResult.duration_ms`) is derived from the
    /// start stamped at turn/start — Codex's turn/completed carries no server duration, so
    /// without this the footer would never show on Codex (parity with Claude's `result`).
    #[test]
    fn turn_completed_fills_duration_from_the_stamped_start() {
        let (mut c, sink) = core();
        c.state.busy = true;
        c.current_turn_id = Some("u".into());
        c.turn_started_at = Some(Instant::now());
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"u","status":"completed"}}),
        );
        let dur = items(&sink).into_iter().find_map(|i| match i {
            ConversationItem::TurnResult { duration_ms, .. } => Some(duration_ms),
            _ => None,
        });
        assert!(
            matches!(dur, Some(Some(_))),
            "the turn footer must carry a derived duration_ms"
        );
        assert!(
            c.turn_started_at.is_none(),
            "the start stamp is consumed at completion"
        );
    }

    /// ⚠️ No-fake-0ms guard: a completion with no stamped start (shouldn't happen in the
    /// normal flow) leaves `duration_ms` None so the footer stays HIDDEN — never a bogus 0 ms.
    #[test]
    fn turn_completed_without_a_stamp_leaves_duration_none() {
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"status":"completed"}}),
        );
        let dur = items(&sink).into_iter().find_map(|i| match i {
            ConversationItem::TurnResult { duration_ms, .. } => Some(duration_ms),
            _ => None,
        });
        assert_eq!(dur, Some(None), "no start stamp → no duration (footer hidden)");
    }

    /// A stale completion (a superseded turn's late notification) must NOT consume the live
    /// turn's start stamp — otherwise the real completion would measure a bogus duration.
    #[test]
    fn stale_completion_preserves_the_start_stamp() {
        let (mut c, _sink) = core();
        c.current_turn_id = Some("T_new".into());
        c.state.busy = true;
        c.turn_started_at = Some(Instant::now());
        c.on_notification(
            "turn/completed",
            json!({"threadId":"t","turn":{"id":"T_old","status":"completed"}}),
        );
        assert!(
            c.turn_started_at.is_some(),
            "a stale completion must not consume the live start stamp"
        );
    }

    #[test]
    fn turn_completed_closes_dangling_tools_and_clears_busy() {
        let (mut c, sink) = core();
        c.state.busy = true;
        // A command that started but never completes (interrupted).
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"sleep 99","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("turn/completed", json!({"threadId":"t","turn":{"id":"u","status":"interrupted"}}));
        let items = items(&sink);
        // The open card is closed with an error result so the round can fold.
        assert!(matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })));
        assert!(items.iter().any(|i| matches!(i, ConversationItem::TurnResult { .. })));
        assert!(!c.state.busy, "busy must clear on turn/completed");
    }

    #[test]
    fn busy_clears_even_on_undecodable_turn_payload() {
        let (mut c, _sink) = core();
        c.state.busy = true;
        // A turn payload that fails to decode must STILL clear busy (invariant #7).
        c.on_notification("turn/completed", json!({"turn": 12345}));
        assert!(!c.state.busy);
    }

    #[test]
    fn approval_request_surfaces_a_permission_and_tracks_pending() {
        let (mut c, sink) = core();
        c.on_incoming(Incoming::ServerRequest {
            id: "req-7".into(),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"threadId":"t","turnId":"u","itemId":"c1","command":"rm -rf x","cwd":"/tmp","reason":"cleanup"}),
        });
        let perms = sink.perms.lock().unwrap().clone();
        assert_eq!(perms.len(), 1);
        let p = &perms[0];
        assert_eq!(p.request_id, "req-7");
        assert_eq!(p.tool_name, "Bash");
        assert_eq!(p.tool_use_id, "c1"); // ties the prompt to the already-rendered card
        assert_eq!(p.input["command"], json!("rm -rf x"));
        assert!(c.pending_approvals.contains("req-7"));
        assert!(c.state.awaiting_permission);
    }

    /// Replay a REAL captured turn (reasoning + a shell command + a file creation) through
    /// the actor and assert it renders. Guards against wire drift AND regressions like the
    /// `fileChange.kind` object-vs-string trap (a plain-string `kind` would drop the card).
    /// Refresh via the ignored `capture_live_turn_to_fixture` after a `codex` upgrade.
    #[test]
    fn replay_captured_turn_renders_text_command_and_file() {
        let fixture = include_str!("../fixtures/capture_codex_turn.jsonl");
        let (mut c, sink) = core();
        for line in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(line).expect("fixture line is JSON");
            if let Some(method) = v.get("method").and_then(Value::as_str) {
                c.on_notification(method, v.get("params").cloned().unwrap_or(Value::Null));
            }
            // `serverRequest` lines (approvals) aren't part of the rendering replay.
        }
        let items = items(&sink);
        let has_text = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::Text { .. }))));
        let has_bash = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "Bash"))));
        let has_patch = items.iter().any(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "ApplyPatch"))));
        let results = items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { .. })).count();
        assert!(has_text, "the assistant's answer must render as Text");
        assert!(has_bash, "the shell command must render as a Bash card");
        assert!(has_patch, "the file creation must render as an ApplyPatch card (kind-object decode)");
        assert!(results >= 2, "each tool card must be closed by a ToolResult (got {results})");
        assert!(items.iter().any(|i| matches!(i, ConversationItem::TurnResult { is_error: false, .. })));
        assert!(!c.state.busy, "the turn settled → busy cleared");
    }

    #[test]
    fn terminal_error_closes_open_tool_cards() {
        // A terminal `error` (not will_retry) may arrive WITHOUT a following turn/completed;
        // it must still close any open card, or clean-output shows it "running" forever (M2).
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!({"error":{"message":"boom"},"willRetry":false}));
        let items = items(&sink);
        assert!(matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })));
        assert!(!c.state.busy);
    }

    #[test]
    fn transient_error_keeps_the_turn_and_its_cards() {
        // A retryable error must NOT close cards or clear busy (the turn continues).
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!({"error":{"message":"retrying"},"willRetry":true}));
        assert!(c.state.busy, "a retryable error keeps the turn busy");
        assert!(tool_result(&items(&sink), "c1").is_none(), "the open card stays open");
    }

    #[test]
    fn error_reads_the_nested_message_and_names_session_budget_exceeded() {
        // The real message is NESTED under `error.message` (fixing the latent top-level-message
        // bug), and a `codexErrorInfo:"sessionBudgetExceeded"` cause earns its OWN notice
        // subtype so the UI can name it, rather than the generic `protocol_error`.
        let (mut c, sink) = core();
        c.state.busy = true;
        c.on_notification(
            "error",
            json!({"error":{"message":"session budget exceeded","codexErrorInfo":"sessionBudgetExceeded"},"willRetry":false}),
        );
        let items = items(&sink);
        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, detail }
                if subtype == "session_budget_exceeded"
                    && detail.get("message").and_then(Value::as_str) == Some("session budget exceeded"))),
            "sessionBudgetExceeded must emit a dedicated notice carrying the real nested message"
        );
        assert!(!c.state.busy, "a terminal budget error settles the turn");
    }

    #[test]
    fn undecodable_error_payload_still_surfaces_and_settles() {
        // ⚠️ Silent-error guard: an `error` notification whose payload is NOT an object (a bare
        // string / array / null) must STILL emit a protocol_error notice AND settle the turn —
        // otherwise it is dropped and the turn renders "running" forever with nothing shown.
        let (mut c, sink) = core();
        c.state.busy = true;
        c.current_turn_id = Some("u".into());
        c.on_notification(
            "item/started",
            json!({"item":{"type":"commandExecution","id":"c1","command":"x","status":"inProgress"},"threadId":"t","turnId":"u","startedAtMs":0}),
        );
        c.on_notification("error", json!("boom, not an object"));
        assert!(!c.state.busy, "an undecodable error must still clear busy");
        assert!(c.current_turn_id.is_none(), "an undecodable error must reset the turn id");
        let items = items(&sink);
        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "protocol_error")),
            "an undecodable error must still surface a protocol_error notice"
        );
        assert!(
            matches!(tool_result(&items, "c1"), Some(ConversationItem::ToolResult { is_error: true, .. })),
            "an undecodable error must still close the open tool card"
        );
    }

    #[test]
    fn duplicate_item_completed_does_not_double_the_card_or_result() {
        // A duplicate/late item/completed for the same id must be a no-op (idempotent on
        // `carded` for the card, on `open_tools` for the result) — m3.
        let (mut c, sink) = core();
        let done = json!({"item":{"type":"commandExecution","id":"c1","command":"ls","aggregatedOutput":"o","exitCode":0,"status":"completed"}});
        c.on_notification("item/completed", done.clone());
        c.on_notification("item/completed", done);
        let items = items(&sink);
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { id, .. } if id == "c1")).count(),
            1,
            "exactly one Bash card despite the duplicate completion"
        );
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { tool_use_id, .. } if tool_use_id == "c1")).count(),
            1,
            "exactly one ToolResult despite the duplicate completion"
        );
    }

    #[test]
    fn codex_remote_status_maps_to_shared_vocabulary() {
        assert_eq!(codex_remote_status(&json!({"status":"connected"})), "connected");
        assert_eq!(codex_remote_status(&json!({"status":"connecting"})), "connecting");
        assert_eq!(codex_remote_status(&json!({"status":"errored"})), "error");
        assert_eq!(codex_remote_status(&json!({"status":"disabled"})), "disconnected");
        // Unknown / missing → disconnected (safe default, never a fake "connected").
        assert_eq!(codex_remote_status(&json!({"status":"weird"})), "disconnected");
        assert_eq!(codex_remote_status(&json!({})), "disconnected");
    }

    #[test]
    fn mcp_server_live_infers_status_and_counts_tools() {
        let none = HashMap::new();
        // A connected server: serverInfo present, two tools, auth ok → connected + tools.
        let connected = mcp_server_live(
            &json!({
                "name":"tosse","authStatus":"oAuth","serverInfo":{"name":"tosse"},
                "tools":{"get_tasks":{},"create_task":{}}
            }),
            &none,
        );
        assert_eq!(connected.status, "connected");
        assert_eq!(connected.tool_count, 2);
        assert_eq!(connected.scope.as_deref(), Some("user"));
        assert!(connected.tools.contains(&"get_tasks".to_string()));
        assert_eq!(connected.failure_reason, None);
        // Not logged in → needs-auth (takes precedence over serverInfo).
        let unauth = mcp_server_live(
            &json!({"name":"x","authStatus":"notLoggedIn","serverInfo":{"name":"x"}}),
            &none,
        );
        assert_eq!(unauth.status, "needs-auth");
        // No serverInfo → disconnected.
        let down = mcp_server_live(&json!({"name":"y","authStatus":"unsupported","serverInfo":null}), &none);
        assert_eq!(down.status, "disconnected");
        assert_eq!(down.tool_count, 0);
    }

    #[test]
    fn mcp_server_live_surfaces_a_recorded_startup_failure() {
        // A `failed` startup status recorded from the push OVERRIDES the inferred status
        // (would otherwise be a mute "disconnected") and carries its structured reason.
        let mut startup = HashMap::new();
        startup.insert(
            "gh".to_string(),
            McpStartupStatus {
                state: "failed".to_string(),
                failure_reason: Some("reauthenticationRequired".to_string()),
                error: None,
            },
        );
        let row = mcp_server_live(&json!({"name":"gh","authStatus":"oAuth","serverInfo":null}), &startup);
        assert_eq!(row.status, "failed");
        assert_eq!(row.failure_reason.as_deref(), Some("reauthenticationRequired"));
        // The free-text error is the fallback when no structured reason is present.
        startup.insert(
            "gh".to_string(),
            McpStartupStatus { state: "failed".to_string(), failure_reason: None, error: Some("boom".to_string()) },
        );
        let row = mcp_server_live(&json!({"name":"gh","serverInfo":null}), &startup);
        assert_eq!(row.failure_reason.as_deref(), Some("boom"));
        // A non-failed recorded state does NOT override the normal inference.
        startup.insert(
            "gh".to_string(),
            McpStartupStatus { state: "ready".to_string(), failure_reason: None, error: None },
        );
        let row = mcp_server_live(&json!({"name":"gh","serverInfo":{"name":"gh"}}), &startup);
        assert_eq!(row.status, "connected");
        assert_eq!(row.failure_reason, None);
    }

    #[test]
    fn rate_limits_push_emits_normalized_plan_usage() {
        let (mut c, sink) = core();
        // A full snapshot: primary = 5h window (300 min), secondary = weekly (10080).
        c.on_notification(
            "account/rateLimits/updated",
            json!({"rateLimits":{
                "primary":{"usedPercent":29.0,"windowDurationMins":300,"resetsAt":1750000000},
                "secondary":{"usedPercent":27.0,"windowDurationMins":10080,"resetsAt":1750500000}
            }}),
        );
        let usages = sink.plan_usages.lock().unwrap().clone();
        assert_eq!(usages.len(), 1, "one plan-usage emitted");
        let u = &usages[0];
        let fh = u.five_hour.as_ref().expect("five_hour from the 300-min window");
        assert_eq!(fh.used_percentage, 29.0);
        assert_eq!(fh.resets_at.as_deref(), Some("1750000000"));
        let sd = u.seven_day.as_ref().expect("seven_day from the 10080-min window");
        assert_eq!(sd.used_percentage, 27.0);
        assert_eq!(sd.resets_at.as_deref(), Some("1750500000"));
    }

    #[test]
    fn rate_limits_map_windows_by_duration_and_normalize_ms_resets() {
        // Windows are told apart by windowDurationMins, not slot order: even if the
        // 5h window is `secondary`, it lands in five_hour. A millisecond reset is
        // normalized to seconds (magnitude heuristic).
        let snap: RateLimitSnapshot = serde_json::from_value(json!({
            "secondary":{"usedPercent":50.0,"windowDurationMins":300,"resetsAt":1750000000000i64},
            "primary":{"usedPercent":10.0,"windowDurationMins":10080,"resetsAt":1750500000i64}
        }))
        .unwrap();
        let u = rate_limits_to_plan_usage(&snap).expect("a usable snapshot");
        // The 300-min window (in `secondary`) → five_hour, its ms reset → seconds.
        assert_eq!(u.five_hour.as_ref().unwrap().used_percentage, 50.0);
        assert_eq!(u.five_hour.as_ref().unwrap().resets_at.as_deref(), Some("1750000000"));
        assert_eq!(u.seven_day.as_ref().unwrap().used_percentage, 10.0);
        // An unknown-duration window is skipped (never mislabeled) → None overall.
        let unknown: RateLimitSnapshot =
            serde_json::from_value(json!({"primary":{"usedPercent":5.0,"windowDurationMins":42}})).unwrap();
        assert!(rate_limits_to_plan_usage(&unknown).is_none());
        // An empty snapshot yields no usage (no spurious empty plan).
        assert!(rate_limits_to_plan_usage(&RateLimitSnapshot::default()).is_none());
    }

    #[test]
    fn distinct_items_get_distinct_bubbles() {
        // Reasoning (r1) then the answer (m1): two ids → two turns, thinking then text.
        let (mut c, sink) = core();
        c.on_notification("item/completed", json!({"item":{"type":"reasoning","id":"r1","summary":["s"],"content":[]}}));
        c.on_notification("item/completed", json!({"item":{"type":"agentMessage","id":"m1","text":"done"}}));
        let ids: Vec<String> = items(&sink)
            .into_iter()
            .filter_map(|i| match i {
                ConversationItem::AssistantMessage { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["r1", "m1"]);
    }

    /// Count the emitted notices of a given subtype.
    fn notice_count(items: &[ConversationItem], wanted: &str) -> usize {
        items
            .iter()
            .filter(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == wanted))
            .count()
    }

    /// A plain-text SendUser command, for the on_command error-path tests.
    fn send_user(text: &str) -> SessionCommand {
        SessionCommand::SendUser { text: text.into(), images: vec![], controls: None }
    }

    // Mirror of the Claude backend's `send_user_text_on_a_dead_session_surfaces_a_notice`:
    // a `turn/start` that can't reach the server (never-started server → Closed at once)
    // must surface a `send_failed` notice AND settle `busy` — never a silent drop with a
    // spinner stuck forever.
    #[tokio::test]
    async fn send_user_failure_surfaces_a_notice_and_settles_busy() {
        let (mut c, sink) = core();
        let server = Arc::new(CodexServer::new()); // never started → requests fail Closed
        c.on_command(send_user("hello"), "t1", &server).await;
        assert!(!c.state.busy, "a failed turn/start must settle busy");
        assert_eq!(notice_count(&items(&sink), "send_failed"), 1);
    }

    // The steer fall-through: busy + a live turn id → SendUser first tries `turn/steer`;
    // on an ATOMIC failure (here Closed) it must FALL THROUGH to `turn/start` — whose own
    // failure then surfaces as send_failed + settles busy. Without the fall-through there
    // would be NO notice and `busy` would stay true forever (the silent-swallow class).
    #[tokio::test]
    async fn rejected_steer_falls_through_to_turn_start_whose_failure_is_surfaced() {
        let (mut c, sink) = core();
        c.state.busy = true;
        c.current_turn_id = Some("T1".into());
        let server = Arc::new(CodexServer::new());
        c.on_command(send_user("mid-turn message"), "t1", &server).await;
        assert!(!c.state.busy, "the fall-through turn/start failed → busy settled");
        assert_eq!(
            notice_count(&items(&sink), "send_failed"),
            1,
            "the fall-through's failure must be surfaced, not swallowed"
        );
    }

    // Findings 18/22: a SendUser whose ONLY content is an unmaterializable image must be
    // REFUSED with a visible notice — exactly one send_failed (the dropped attachment),
    // proving no blank turn/start was attempted (that would add a second notice here).
    #[tokio::test]
    async fn send_user_with_only_a_failed_image_refuses_the_turn_with_a_notice() {
        let (mut c, sink) = core();
        let server = Arc::new(CodexServer::new());
        let bad = ImageAttachment { media_type: "image/png".into(), data: "!!!".into() };
        c.on_command(
            SessionCommand::SendUser { text: "  ".into(), images: vec![bad], controls: None },
            "t1",
            &server,
        )
        .await;
        assert!(!c.state.busy, "a refused turn must not leave busy set");
        assert_eq!(
            notice_count(&items(&sink), "send_failed"),
            1,
            "one notice for the dropped attachment, and NO turn attempted"
        );
    }

    // A failed `turn/interrupt` (server unreachable) means the turn keeps running
    // server-side — the Stop click must surface an error notice, never a silent no-op.
    #[tokio::test]
    async fn failed_interrupt_surfaces_an_error_notice() {
        let (mut c, sink) = core();
        c.state.busy = true;
        c.current_turn_id = Some("T1".into());
        let server = Arc::new(CodexServer::new());
        c.on_command(SessionCommand::Interrupt, "t1", &server).await;
        assert_eq!(notice_count(&items(&sink), "error"), 1);
        // Busy with NO turn id: the stop cannot be delivered — also surfaced.
        let (mut c2, sink2) = core();
        c2.state.busy = true;
        c2.on_command(SessionCommand::Interrupt, "t1", &server).await;
        assert_eq!(notice_count(&items(&sink2), "error"), 1);
        // Idle (not busy, no turn): nothing to interrupt, nothing to report.
        let (mut c3, sink3) = core();
        c3.on_command(SessionCommand::Interrupt, "t1", &server).await;
        assert_eq!(notice_count(&items(&sink3), "error"), 0);
    }

    #[test]
    fn unknown_approval_method_is_tracked_pending_without_a_prompt() {
        let (mut c, sink) = core();
        c.on_incoming(Incoming::ServerRequest {
            id: "req-9".into(),
            method: "item/somethingNew/requestApproval".into(),
            params: json!({}),
        });
        assert!(sink.perms.lock().unwrap().is_empty(), "no broken prompt for an unknown method");
        // ⚠️ The id MUST still be pending: the teardown `cancel` is what releases the
        // shared server — dropping it here would wedge the turn for every conversation.
        assert!(c.pending_approvals.contains("req-9"));
        assert!(!c.state.awaiting_permission, "no prompt → the composer is not blocked");
    }

    #[test]
    fn file_change_approval_maps_to_an_apply_patch_prompt() {
        let (mut c, sink) = core();
        c.on_incoming(Incoming::ServerRequest {
            id: "req-8".into(),
            method: "item/fileChange/requestApproval".into(),
            params: json!({"threadId":"t","turnId":"u","itemId":"f1","reason":"apply the patch"}),
        });
        let perms = sink.perms.lock().unwrap().clone();
        assert_eq!(perms.len(), 1);
        assert_eq!(perms[0].request_id, "req-8");
        assert_eq!(perms[0].tool_name, "ApplyPatch");
        assert_eq!(perms[0].tool_use_id, "f1"); // ties the prompt to the rendered card
        assert!(c.pending_approvals.contains("req-8"));
        assert!(c.state.awaiting_permission);
    }

    // The approval answer cycle: Allow and Deny both resolve the pending slot and clear
    // `awaiting_permission`; an unknown / already-answered id is a clean no-op. (`reply`
    // on a never-started server is itself a no-op, so this runs hermetically.)
    #[tokio::test]
    async fn answer_permission_resolves_pending_and_ignores_unknown_ids() {
        let server = Arc::new(CodexServer::new());
        for decision in [
            PermissionDecision::Allow { updated_input: None },
            PermissionDecision::Deny { message: "no".into() },
        ] {
            let (mut c, _sink) = core();
            c.on_approval_request(
                "req-1".into(),
                "item/commandExecution/requestApproval",
                json!({"itemId":"c1","command":"ls"}),
            );
            assert!(c.state.awaiting_permission);
            c.on_command(
                SessionCommand::AnswerPermission { request_id: "req-1".into(), decision },
                "t1",
                &server,
            )
            .await;
            assert!(c.pending_approvals.is_empty(), "the answered id leaves the pending set");
            assert!(!c.state.awaiting_permission, "the composer prompt is released");
            // Answering the same id again (unknown by now) must be a clean no-op.
            c.on_command(
                SessionCommand::AnswerPermission {
                    request_id: "req-1".into(),
                    decision: PermissionDecision::Allow { updated_input: None },
                },
                "t1",
                &server,
            )
            .await;
            assert!(c.pending_approvals.is_empty());
            assert!(!c.state.awaiting_permission);
        }
    }

    // Finding 33: the spawn contract must fail SYNCHRONOUSLY on a vanished cwd (same
    // error as the Claude transport), so the front's worktree-recovery branch fires
    // instead of the message dying against an async-doomed actor.
    #[tokio::test]
    async fn spawn_session_fails_synchronously_when_the_cwd_is_missing() {
        let cwd = std::env::temp_dir().join(format!("gone-{}", uuid::Uuid::new_v4()));
        let cfg = SpawnConfig::new(cwd.clone());
        let sink = Arc::new(Sink::default());
        let emitter: Arc<dyn SessionEmitter> = sink.clone();
        let r = spawn_session(
            "s1".into(),
            cfg,
            InitialControls::default(),
            emitter,
            Box::new(|| {}),
            Arc::new(CodexServer::new()),
        );
        let err = r.err().expect("a missing cwd must fail the spawn synchronously");
        assert!(
            err.to_string().contains(&cwd.display().to_string()),
            "the error names the missing dir: {err}"
        );
    }
}
