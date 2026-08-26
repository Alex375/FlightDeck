//! The session supervisor: one actor per conversation OWNS a persistent
//! `claude` process (stream-json, stdin held open across turns), detached from
//! every client. Clients come and go:
//!  - the Mac attaches over SSH (`flightdeckd attach` → unix socket) and gets a
//!    transparent pipe plus seq-numbered replay of what it missed;
//!  - the phone drives the same session through relay RPCs.
//!
//! The supervision model (spawn args, pumps, teardown ladder, control-channel
//! semantics) is ported from tosse-code `supervisor/transport.rs` — the daemon
//! is that transport's server side.

use crate::config::Config;
use crate::events::Event;
use crate::frames;
use crate::registry::{ConversationRow, Registry};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};
use tracing::{info, warn};

/// Ring budget: how many bytes of replayable stream lines each session keeps.
const RING_BYTES_MAX: usize = 64 * 1024 * 1024;
/// Teardown ladder pauses (mirrors tosse-code: EOF → SIGTERM(group) → SIGKILL).
const LADDER_STEP: std::time::Duration = std::time::Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Messages into a session actor

pub struct AttachReq {
    pub client_id: u64,
    /// The epoch the client last saw (None = fresh client).
    pub epoch: Option<String>,
    /// Count of replayable lines the client has already received this epoch.
    pub cursor: u64,
    /// Where daemon→client lines go (each item is one line, no trailing \n).
    pub lines_tx: mpsc::UnboundedSender<String>,
}

#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub request_id: String,
    pub tool_name: String,
    pub tool_use_id: String,
    pub input: Value,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The original wire line, re-emitted verbatim on attach so a new client
    /// sees the outstanding prompt.
    pub raw_line: String,
}

#[derive(Debug, Clone)]
pub struct StatusSnapshot {
    pub running: bool,
    pub busy: bool,
    pub session_id: Option<String>,
    pub pending: Vec<PendingPermission>,
    pub last_assistant_text: Option<String>,
}

pub enum SessionMsg {
    FromClaude(String),
    ClaudeExited(Option<i32>),
    Attach(AttachReq),
    /// The attach connection with this client_id went away.
    ClientGone(u64),
    ClientLine(String),
    Send { text: String, ack: oneshot::Sender<Result<String, String>> },
    Interrupt { ack: oneshot::Sender<Result<(), String>> },
    AnswerPermission {
        request_id: String,
        behavior: String,
        message: Option<String>,
        updated_input: Option<Value>,
        ack: oneshot::Sender<Result<(), String>>,
    },
    Status { reply: oneshot::Sender<StatusSnapshot> },
    /// Kill the claude process (explicit stop — fd_stop or phone stop_stream).
    Stop { ack: oneshot::Sender<()> },
}

// ---------------------------------------------------------------------------
// The manager

struct SessionEntry {
    msg_tx: mpsc::UnboundedSender<SessionMsg>,
}

pub struct SessionManager {
    pub cfg: Config,
    registry: StdMutex<Registry>,
    sessions: Mutex<HashMap<String, SessionEntry>>,
    pub events_tx: broadcast::Sender<Event>,
    ids: AtomicU64,
}

impl SessionManager {
    pub fn new(cfg: Config, registry: Registry) -> Arc<Self> {
        let (events_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            cfg,
            registry: StdMutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
            events_tx,
            ids: AtomicU64::new(1),
        })
    }

    pub fn next_client_id(&self) -> u64 {
        self.ids.fetch_add(1, Ordering::Relaxed)
    }

    pub fn with_registry<T>(&self, f: impl FnOnce(&Registry) -> T) -> T {
        let guard = self.registry.lock().expect("registry lock");
        f(&guard)
    }

    async fn entry_tx(&self, conv_id: &str) -> Option<mpsc::UnboundedSender<SessionMsg>> {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(conv_id) {
            Some(e) if !e.msg_tx.is_closed() => Some(e.msg_tx.clone()),
            Some(_) => {
                sessions.remove(conv_id);
                None
            }
            None => None,
        }
    }

    pub async fn status(&self, conv_id: &str) -> Option<StatusSnapshot> {
        let tx = self.entry_tx(conv_id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(SessionMsg::Status { reply }).ok()?;
        rx.await.ok()
    }

    /// Find the live conversation currently running claude session `sid`.
    pub async fn conv_for_claude_session(&self, sid: &str) -> Option<String> {
        let ids: Vec<String> = { self.sessions.lock().await.keys().cloned().collect() };
        for id in ids {
            if let Some(st) = self.status(&id).await {
                if st.running && st.session_id.as_deref() == Some(sid) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// Attach a client. Resolution order:
    ///  1. explicit conversation id, if it has a live actor;
    ///  2. the live session running `resume_session`;
    ///  3. cold start: spawn claude (client args, `--resume` injected as needed)
    ///     under the given — or a fresh — conversation id.
    #[allow(clippy::too_many_arguments)]
    pub async fn attach(
        self: &Arc<Self>,
        conversation: Option<String>,
        cwd: Option<String>,
        resume_session: Option<String>,
        claude_args: Vec<String>,
        epoch: Option<String>,
        cursor: u64,
        lines_tx: mpsc::UnboundedSender<String>,
    ) -> Result<(String, u64)> {
        let client_id = self.next_client_id();

        // 1. by conversation id
        let mut conv_id = conversation.clone();
        if let Some(id) = &conv_id {
            if let Some(tx) = self.entry_tx(id).await {
                tx.send(SessionMsg::Attach(AttachReq { client_id, epoch, cursor, lines_tx }))
                    .map_err(|_| anyhow!("session just ended — retry"))?;
                return Ok((id.clone(), client_id));
            }
        }
        // 2. by running claude session id
        if conv_id.is_none() {
            if let Some(sid) = &resume_session {
                if let Some(found) = self.conv_for_claude_session(sid).await {
                    if let Some(tx) = self.entry_tx(&found).await {
                        tx.send(SessionMsg::Attach(AttachReq { client_id, epoch, cursor, lines_tx }))
                            .map_err(|_| anyhow!("session just ended — retry"))?;
                        return Ok((found, client_id));
                    }
                }
                // known-but-cold conversation for this session id?
                let cold = self.with_registry(|r| {
                    r.list(true).ok().and_then(|rows| {
                        rows.into_iter().find(|row| row.session_id.as_deref() == Some(sid)).map(|r| r.id)
                    })
                });
                conv_id = cold;
            }
        }

        // 3. cold start
        let conv_id = match conv_id {
            Some(id) => id,
            None => uuid::Uuid::new_v4().to_string(),
        };
        let known = self.with_registry(|r| r.get(&conv_id).ok().flatten());
        let cwd = cwd
            .or_else(|| known.as_ref().map(|k| k.repo_path.clone()))
            .ok_or_else(|| anyhow!("attach needs --cwd for a new conversation"))?;
        let resume = resume_session.or_else(|| known.as_ref().and_then(|k| k.session_id.clone()));
        if known.is_none() {
            let now = frames::now_ms();
            self.with_registry(|r| {
                r.upsert(&ConversationRow {
                    id: conv_id.clone(),
                    session_id: resume.clone(),
                    title: String::new(),
                    repo_path: cwd.clone(),
                    created_at: now,
                    last_activity_at: now,
                    archived: false,
                })
            })?;
        }
        let args = ensure_args(claude_args, resume.as_deref(), &self.cfg);
        self.spawn_session(&conv_id, &cwd, args).await?;
        let tx = self
            .entry_tx(&conv_id)
            .await
            .ok_or_else(|| anyhow!("session failed to start"))?;
        tx.send(SessionMsg::Attach(AttachReq { client_id, epoch: None, cursor: 0, lines_tx }))
            .map_err(|_| anyhow!("session failed to start"))?;
        Ok((conv_id, client_id))
    }

    /// Make sure a conversation's claude process is up (lazy respawn with
    /// --resume), e.g. before a phone send lands on a cold conversation.
    pub async fn ensure_running(self: &Arc<Self>, conv_id: &str) -> Result<()> {
        if self.entry_tx(conv_id).await.is_some() {
            return Ok(());
        }
        let row = self
            .with_registry(|r| r.get(conv_id).ok().flatten())
            .ok_or_else(|| anyhow!("no such conversation"))?;
        let args = ensure_args(Vec::new(), row.session_id.as_deref(), &self.cfg);
        self.spawn_session(conv_id, &row.repo_path, args).await
    }

    pub async fn create_conversation(self: &Arc<Self>, repo_path: &str, title: &str) -> Result<String> {
        let path = PathBuf::from(repo_path);
        if !path.is_dir() {
            bail!("no such folder on the server: {repo_path}");
        }
        let conv_id = uuid::Uuid::new_v4().to_string();
        let now = frames::now_ms();
        self.with_registry(|r| {
            r.upsert(&ConversationRow {
                id: conv_id.clone(),
                session_id: None,
                title: title.to_string(),
                repo_path: repo_path.to_string(),
                created_at: now,
                last_activity_at: now,
                archived: false,
            })
        })?;
        let args = ensure_args(Vec::new(), None, &self.cfg);
        self.spawn_session(&conv_id, repo_path, args).await?;
        Ok(conv_id)
    }

    pub async fn route(&self, conv_id: &str, msg: SessionMsg) -> Result<()> {
        let tx = self
            .entry_tx(conv_id)
            .await
            .ok_or_else(|| anyhow!("conversation is not running"))?;
        tx.send(msg).map_err(|_| anyhow!("conversation just ended"))?;
        Ok(())
    }

    // -- spawning ----------------------------------------------------------

    async fn spawn_session(self: &Arc<Self>, conv_id: &str, cwd: &str, args: Vec<String>) -> Result<()> {
        let cwd_path = PathBuf::from(cwd);
        if !cwd_path.is_dir() {
            bail!("working folder is missing on the server: {cwd}");
        }
        info!(conv = conv_id, cwd, "spawning claude: {}", args.join(" "));

        let mut std_cmd = std::process::Command::new(&self.cfg.claude_bin);
        std_cmd
            .args(&args)
            .current_dir(&cwd_path)
            .env("CLAUDE_CODE_ENTRYPOINT", "tosse-code")
            .env("MCP_CONNECTION_NONBLOCKING", "true")
            .env("CLAUDE_CODE_ENABLE_TASKS", "0")
            .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        {
            use std::os::unix::process::CommandExt;
            std_cmd.process_group(0);
        }
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true);
        let mut child: Child = cmd.spawn().with_context(|| {
            format!("cannot start {} — is claude installed on this server?", self.cfg.claude_bin)
        })?;
        let pid = child.id();
        let stdin = child.stdin.take().context("claude stdin")?;
        let stdout = child.stdout.take().context("claude stdout")?;
        let stderr = child.stderr.take().context("claude stderr")?;

        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<SessionMsg>();

        // stdout pump: complete lines only (an EOF-truncated tail is dropped —
        // the replay-cursor contract counts newline-terminated lines).
        {
            let tx = msg_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) => break,
                        Ok(_) => {
                            if buf.last() != Some(&b'\n') {
                                break; // truncated tail at EOF — not a line
                            }
                            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                            if !line.is_empty() && tx.send(SessionMsg::FromClaude(line)).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }
        // stderr pump: log through the daemon's own stderr (visible in journald
        // / docker logs; the attach stream carries stdout only).
        {
            let conv = conv_id.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    warn!(conv = conv.as_str(), "claude stderr: {l}");
                }
            });
        }
        // wait task: owns the child, reports the exit.
        {
            let tx = msg_tx.clone();
            tokio::spawn(async move {
                let status = child.wait().await.ok();
                let code = status.and_then(|s| s.code());
                let _ = tx.send(SessionMsg::ClaudeExited(code));
            });
        }

        let actor = SessionActor {
            conv_id: conv_id.to_string(),
            manager: Arc::downgrade(self),
            epoch: uuid::Uuid::new_v4().to_string(),
            seq: 0,
            ring: VecDeque::new(),
            ring_bytes: 0,
            stdin: Some(stdin),
            pid,
            exited: watch::channel(false),
            attached: None,
            pending: HashMap::new(),
            session_id: None,
            busy: false,
            running: true,
            last_assistant_text: None,
            control_seq: 0,
        };
        tokio::spawn(actor.run(msg_rx));

        self.sessions
            .lock()
            .await
            .insert(conv_id.to_string(), SessionEntry { msg_tx });
        Ok(())
    }

    async fn forget(&self, conv_id: &str) {
        self.sessions.lock().await.remove(conv_id);
    }

    fn emit(&self, ev: Event) {
        let _ = self.events_tx.send(ev);
    }
}

/// Guarantee the fixed stream-json prefix and a `--resume` when we know the
/// session id. Client-supplied args (Mac attach) already carry the prefix; the
/// daemon's own spawns (phone create / lazy respawn) start empty.
fn ensure_args(mut args: Vec<String>, resume: Option<&str>, cfg: &Config) -> Vec<String> {
    if args.is_empty() {
        args = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--include-partial-messages".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--replay-user-messages".into(),
            "--forward-subagent-text".into(),
            "--permission-mode".into(),
            cfg.permission_mode.clone(),
        ];
    }
    if let Some(sid) = resume {
        if let Some(i) = args.iter().position(|a| a == "--resume") {
            if args.get(i + 1).map(String::as_str) != Some(sid) {
                args[i + 1] = sid.to_string();
            }
        } else {
            args.push("--resume".into());
            args.push(sid.to_string());
        }
    }
    args
}

// ---------------------------------------------------------------------------
// The per-session actor

struct SessionActor {
    conv_id: String,
    manager: std::sync::Weak<SessionManager>,
    epoch: String,
    /// Count of replayable lines emitted by this claude process so far.
    seq: u64,
    ring: VecDeque<(u64, String)>,
    ring_bytes: usize,
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
    exited: (watch::Sender<bool>, watch::Receiver<bool>),
    attached: Option<(u64, mpsc::UnboundedSender<String>)>,
    pending: HashMap<String, PendingPermission>,
    session_id: Option<String>,
    busy: bool,
    running: bool,
    last_assistant_text: Option<String>,
    control_seq: u64,
}

impl SessionActor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<SessionMsg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                SessionMsg::FromClaude(line) => self.on_claude_line(line).await,
                SessionMsg::ClaudeExited(code) => {
                    self.on_exited(code);
                    break;
                }
                SessionMsg::Attach(req) => self.on_attach(req),
                SessionMsg::ClientGone(id) => {
                    if self.attached.as_ref().map(|(cid, _)| *cid) == Some(id) {
                        self.attached = None;
                        info!(conv = self.conv_id.as_str(), "client detached — session keeps running");
                    }
                }
                SessionMsg::ClientLine(line) => self.on_client_line(line).await,
                SessionMsg::Send { text, ack } => {
                    let uuid = uuid::Uuid::new_v4().to_string();
                    let res = self.write_claude(&frames::user_message(&text, &uuid)).await;
                    if res.is_ok() {
                        self.busy = true;
                        self.touch();
                    }
                    let _ = ack.send(res.map(|_| uuid).map_err(|e| e.to_string()));
                }
                SessionMsg::Interrupt { ack } => {
                    self.control_seq += 1;
                    let id = format!("fdd-{}", self.control_seq);
                    let res = self.write_claude(&frames::interrupt_request(&id)).await;
                    let _ = ack.send(res.map_err(|e| e.to_string()));
                }
                SessionMsg::AnswerPermission { request_id, behavior, message, updated_input, ack } => {
                    let res = self.answer_permission(&request_id, &behavior, message, updated_input).await;
                    let _ = ack.send(res.map_err(|e| e.to_string()));
                }
                SessionMsg::Status { reply } => {
                    let _ = reply.send(StatusSnapshot {
                        running: self.running,
                        busy: self.busy,
                        session_id: self.session_id.clone(),
                        pending: self.pending.values().cloned().collect(),
                        last_assistant_text: self.last_assistant_text.clone(),
                    });
                }
                SessionMsg::Stop { ack } => {
                    self.stop_claude().await;
                    let _ = ack.send(());
                    // stay in the loop: ClaudeExited arrives and finishes us.
                }
            }
        }
        if let Some(m) = self.manager.upgrade() {
            m.forget(&self.conv_id).await;
        }
    }

    // -- claude → world ----------------------------------------------------

    async fn on_claude_line(&mut self, line: String) {
        let probe = frames::probe(&line);
        let kind = probe.as_ref().and_then(|p| p.kind.clone()).unwrap_or_default();

        match kind.as_str() {
            "control_request" => {
                self.track_inbound_control(&line);
                self.forward(&line);
            }
            "control_cancel_request" => {
                if let Some(id) = probe.as_ref().and_then(|p| p.request_id.clone()) {
                    if self.pending.remove(&id).is_some() {
                        self.emit_event("attention_cleared", None, json!({"reason": "withdrawn", "request_id": id}));
                    }
                }
                self.forward(&line);
            }
            "control_response" => {
                // Answers to the daemon's own fdd-* requests are consumed here;
                // everything else belongs to the attached client.
                let rid = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| v["response"]["request_id"].as_str().map(String::from));
                if rid.as_deref().map(|r| r.starts_with("fdd-")) != Some(true) {
                    self.forward(&line);
                }
            }
            k if frames::is_replayable_type(k) && !k.is_empty() => {
                self.seq += 1;
                self.ring_push(&line);
                match k {
                    "system" => {
                        if probe.as_ref().and_then(|p| p.subtype.as_deref()) == Some("init") {
                            if let Some(sid) = probe.as_ref().and_then(|p| p.session_id.clone()) {
                                if self.session_id.as_deref() != Some(sid.as_str()) {
                                    self.session_id = Some(sid.clone());
                                    if let Some(m) = self.manager.upgrade() {
                                        let _ = m.with_registry(|r| r.set_session_id(&self.conv_id, &sid));
                                    }
                                }
                            }
                        }
                    }
                    "assistant" => self.note_assistant(&line),
                    "user" => {}
                    "result" => {
                        self.busy = false;
                        self.touch();
                        let is_error = serde_json::from_str::<Value>(&line)
                            .ok()
                            .and_then(|v| v["is_error"].as_bool())
                            .unwrap_or(false);
                        let text = self.last_assistant_text.clone().unwrap_or_default();
                        self.emit_event(
                            "turn_completed",
                            Some(text.clone()),
                            json!({
                                "outcome": if is_error { "error" } else { "success" },
                                "last_assistant_text": text,
                            }),
                        );
                    }
                    _ => {}
                }
                self.forward(&line);
            }
            _ => self.forward(&line),
        }
    }

    fn track_inbound_control(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let Some(request_id) = v["request_id"].as_str().map(String::from) else { return };
        let req = &v["request"];
        if req["subtype"].as_str() != Some("can_use_tool") {
            return;
        }
        let tool_name = req["tool_name"].as_str().unwrap_or("tool").to_string();
        let perm = PendingPermission {
            request_id: request_id.clone(),
            tool_name: tool_name.clone(),
            tool_use_id: req["tool_use_id"].as_str().unwrap_or_default().to_string(),
            input: req["input"].clone(),
            title: req["title"].as_str().map(String::from),
            description: req["description"].as_str().map(String::from),
            raw_line: line.to_string(),
        };
        self.pending.insert(request_id, perm);
        self.emit_event(
            "needs_attention",
            Some(format!("Permission needed: {tool_name}")),
            json!({"reason": "permission", "tool": tool_name}),
        );
    }

    fn note_assistant(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if !v["parent_tool_use_id"].is_null() {
            return; // sub-agent thread
        }
        let Some(blocks) = v["message"]["content"].as_array() else { return };
        let text: Vec<&str> = blocks
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect();
        if !text.is_empty() {
            self.last_assistant_text = Some(text.join("\n"));
        }
    }

    // -- client → claude ---------------------------------------------------

    async fn on_client_line(&mut self, line: String) {
        let kind = frames::probe(&line).and_then(|p| p.kind).unwrap_or_default();
        match kind.as_str() {
            "fd_stop" => {
                info!(conv = self.conv_id.as_str(), "explicit stop from client");
                self.detach_current("stopped", None);
                self.stop_claude().await;
            }
            "control_response" => {
                if let Some(rid) = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| v["response"]["request_id"].as_str().map(String::from))
                {
                    if self.pending.remove(&rid).is_some() {
                        self.emit_event("attention_cleared", None, json!({"reason": "answered", "request_id": rid}));
                    }
                }
                let _ = self.write_claude(&line).await;
            }
            "user" => {
                self.busy = true;
                self.touch();
                let _ = self.write_claude(&line).await;
            }
            _ => {
                let _ = self.write_claude(&line).await;
            }
        }
    }

    async fn answer_permission(
        &mut self,
        request_id: &str,
        behavior: &str,
        message: Option<String>,
        updated_input: Option<Value>,
    ) -> Result<()> {
        let perm = self
            .pending
            .remove(request_id)
            .ok_or_else(|| anyhow!("no pending request {request_id}"))?;
        let line = if behavior == "allow" {
            frames::permission_allow_response(
                request_id,
                &perm.tool_use_id,
                updated_input.unwrap_or_else(|| perm.input.clone()),
            )
        } else {
            frames::permission_deny_response(
                request_id,
                &perm.tool_use_id,
                message.as_deref().unwrap_or("Rejected."),
            )
        };
        self.write_claude(&line).await?;
        self.emit_event(
            "attention_cleared",
            None,
            json!({"reason": "answered", "request_id": request_id, "behavior": behavior}),
        );
        Ok(())
    }

    async fn write_claude(&mut self, line: &str) -> Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| anyhow!("claude stdin is closed"))?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    // -- attach / replay ---------------------------------------------------

    fn on_attach(&mut self, req: AttachReq) {
        self.detach_current("replaced", None);

        // Same epoch → resume from the client's cursor; different/unknown epoch
        // → full replay of what the ring still holds.
        let from = if req.epoch.as_deref() == Some(self.epoch.as_str()) {
            req.cursor.min(self.seq)
        } else {
            0
        };
        let effective_from = match self.ring.front() {
            Some((first_seq, _)) => from.max(first_seq.saturating_sub(1)),
            None => self.seq,
        };
        let _ = req
            .lines_tx
            .send(frames::fd_attach(&self.conv_id, &self.epoch, effective_from, self.seq));
        for (s, line) in self.ring.iter() {
            if *s > effective_from {
                if req.lines_tx.send(line.clone()).is_err() {
                    return;
                }
            }
        }
        // Outstanding permission prompts re-arrive after the replay.
        for perm in self.pending.values() {
            let _ = req.lines_tx.send(perm.raw_line.clone());
        }
        info!(
            conv = self.conv_id.as_str(),
            "client {} attached (replay from {} of {})", req.client_id, effective_from, self.seq
        );
        self.attached = Some((req.client_id, req.lines_tx));
    }

    fn detach_current(&mut self, reason: &str, exit_code: Option<i32>) {
        if let Some((_, tx)) = self.attached.take() {
            let _ = tx.send(frames::fd_detach(reason, exit_code));
        }
    }

    fn forward(&mut self, line: &str) {
        if let Some((_, tx)) = &self.attached {
            if tx.send(line.to_string()).is_err() {
                self.attached = None;
            }
        }
    }

    fn ring_push(&mut self, line: &str) {
        self.ring_bytes += line.len();
        self.ring.push_back((self.seq, line.to_string()));
        while self.ring_bytes > RING_BYTES_MAX {
            if let Some((_, dropped)) = self.ring.pop_front() {
                self.ring_bytes -= dropped.len();
            } else {
                break;
            }
        }
    }

    // -- lifecycle ---------------------------------------------------------

    /// EOF → SIGTERM(group) → SIGKILL(group), checking for exit between rungs.
    async fn stop_claude(&mut self) {
        self.stdin = None; // EOF
        let Some(pid) = self.pid else { return };
        let mut exited = self.exited.1.clone();
        let already = *exited.borrow();
        if already {
            return;
        }
        tokio::spawn(async move {
            let step = |sig: i32| unsafe {
                libc::kill(-(pid as i32), sig);
            };
            for sig in [libc::SIGTERM, libc::SIGKILL] {
                let wait = tokio::time::timeout(LADDER_STEP, async {
                    while !*exited.borrow() {
                        if exited.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await;
                if wait.is_ok() {
                    return; // exited
                }
                step(sig);
            }
        });
    }

    fn on_exited(&mut self, code: Option<i32>) {
        info!(conv = self.conv_id.as_str(), code = ?code, "claude exited");
        self.running = false;
        self.busy = false;
        let _ = self.exited.0.send(true);
        self.detach_current("exited", code);
        let pending: Vec<String> = self.pending.keys().cloned().collect();
        for rid in pending {
            self.pending.remove(&rid);
            self.emit_event("attention_cleared", None, json!({"reason": "withdrawn", "request_id": rid}));
        }
        self.touch();
    }

    fn touch(&self) {
        if let Some(m) = self.manager.upgrade() {
            let _ = m.with_registry(|r| r.touch(&self.conv_id, frames::now_ms()));
        }
    }

    fn emit_event(&self, kind: &str, text: Option<String>, detail: Value) {
        if let Some(m) = self.manager.upgrade() {
            m.emit(Event {
                conversation_id: self.conv_id.clone(),
                kind: kind.to_string(),
                title: None,
                text,
                detail,
                at_ms: frames::now_ms(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> Config {
        Config {
            relay_url: "http://localhost:1".into(),
            mac_id: "m".into(),
            mac_token: "t".into(),
            phone_tokens: vec![],
            label: "test".into(),
            default_workdir: None,
            claude_bin: "claude".into(),
            permission_mode: "bypassPermissions".into(),
        }
    }

    #[test]
    fn ensure_args_injects_resume_and_defaults() {
        let cfg = test_cfg();
        let a = ensure_args(Vec::new(), Some("sid-1"), &cfg);
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "sid-1"));
        assert!(a.contains(&"--replay-user-messages".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "bypassPermissions"));

        // client args with a stale --resume get it corrected
        let client = vec!["--output-format".to_string(), "stream-json".to_string(), "--resume".to_string(), "old".to_string()];
        let a = ensure_args(client, Some("new"), &cfg);
        assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "new"));
        // client args without resume, none known → untouched
        let client = vec!["--output-format".to_string(), "stream-json".to_string()];
        let a = ensure_args(client.clone(), None, &cfg);
        assert_eq!(a, client);
    }
}
