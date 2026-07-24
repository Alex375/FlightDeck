//! The shared Codex `app-server` manager + router.
//!
//! ONE `codex app-server` process multiplexes every Codex conversation (one
//! app-server *thread* per conversation), exactly as OpenAI's own VS Code extension
//! does — proven viable live (two concurrent threads streamed in parallel with
//! correct isolation). This module owns that single process and demultiplexes its
//! single stdout stream two ways:
//!   - **responses** (JSON-RPC `id`) → correlated against a `pending` table,
//!   - **notifications / server-requests** (`params.threadId`) → routed to the
//!     matching conversation actor's inbound channel.
//!
//! Lifecycle: lazy (nothing spawned until the first Codex conversation), and torn
//! down GRACEFULLY when the last thread closes or the app quits (invariant #9 —
//! only the app-server itself reaps its `setsid` MCP children, on stdin EOF).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::protocol::{self, Incoming, RequestId};
use super::transport::{CodexSpawnConfig, CodexTransport, CodexTransportError};

/// How long to wait for a JSON-RPC response. The app-server answers `initialize`,
/// `thread/start` and `turn/start` immediately (a turn's COMPLETION arrives later as
/// a notification, not as the response), so a modest bound is safe.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A failure driving the shared Codex server. Codex-worded so the actor can surface
/// it verbatim as a conversation notice.
#[derive(Debug)]
pub enum CodexError {
    /// The app-server failed to spawn / its cwd vanished.
    Transport(CodexTransportError),
    /// The server answered a request with a JSON-RPC error.
    Rpc(String),
    /// A request timed out (server wedged or gone).
    Timeout(&'static str),
    /// The server is gone (never started, torn down, or died mid-request).
    Closed,
}

impl std::fmt::Display for CodexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexError::Transport(e) => write!(f, "{e}"),
            CodexError::Rpc(m) => write!(f, "codex app-server returned an error: {m}"),
            CodexError::Timeout(what) => {
                write!(f, "codex app-server did not respond to \"{what}\" in time")
            }
            CodexError::Closed => write!(f, "the codex app-server is stopped"),
        }
    }
}

impl std::error::Error for CodexError {}

type Pending = Arc<Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, CodexError>>>>>;
type Router = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Incoming>>>>;

/// The running app-server + its shared demux state. Present only while ≥1 Codex
/// conversation is open.
struct Started {
    /// The SOLE clone of the transport's stdin writer held outside the transport.
    /// ⚠️ Never distributed to conversation actors: graceful EOF (teardown) depends
    /// on both this and the transport's own clone being dropped. Actors send only via
    /// `CodexServer::request`/`notify`/`reply` (which borrow `&self`).
    outbound: mpsc::UnboundedSender<Value>,
    /// Monotonic JSON-RPC request ids (global across all threads).
    next_id: AtomicU64,
    /// Awaiting-response table, keyed by request id. Shared with the demux task.
    pending: Pending,
    /// threadId → that conversation actor's inbound sink. `router.len()` IS the open
    /// thread count (teardown fires when it hits zero). Shared with the demux task.
    router: Router,
    /// Kept for the final graceful teardown.
    transport: CodexTransport,
    /// The demultiplexer task. Aborted on teardown (it also ends on its own when the
    /// transport's inbound channel closes).
    reader: tokio::task::JoinHandle<()>,
    /// Thread-open sequences in flight (`thread/start`/`thread/resume` sent, route not
    /// yet registered). Guards the idle teardown ([`CodexServer::take_if_idle`]): the
    /// router alone can't see an open that hasn't registered yet.
    opening: Arc<AtomicU64>,
}

/// The Tauri-managed shared Codex server. Cloneable-by-Arc at the managed-state layer;
/// its interior is guarded by an async mutex so `request` never holds a lock across an
/// await (only a brief clone-out of the send handles).
pub struct CodexServer {
    inner: tokio::sync::Mutex<Option<Started>>,
    /// The `clientInfo.name` sent at `initialize`, which Codex persists as the rollout's
    /// `originator`. Threads WE drive on the user's behalf announce themselves as
    /// [`CLIENT_NAME`]; internal one-shot threads use [`CLIENT_NAME_INTERNAL`] so their
    /// rollouts can be told apart on disk and kept out of the History panel.
    client_name: &'static str,
}

/// `clientInfo.name` for a real user conversation → rollout `originator`.
pub(crate) const CLIENT_NAME: &str = "flight-deck";

/// `clientInfo.name` for an INTERNAL one-shot thread (auto-title, probes) — a thread the
/// user never opened and must never see listed. Its cleanup is best-effort archival, so the
/// rollout can survive; this marker is what lets the reader recognise and skip it.
pub(crate) const CLIENT_NAME_INTERNAL: &str = "flight-deck-internal";

impl Default for CodexServer {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexServer {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            client_name: CLIENT_NAME,
        }
    }

    /// A server for INTERNAL one-shot work (auto-title, probes). Identical except that its
    /// threads are stamped [`CLIENT_NAME_INTERNAL`] on disk — see the field doc.
    pub(crate) fn internal() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            client_name: CLIENT_NAME_INTERNAL,
        }
    }

    /// Start the app-server + do the `initialize`/`initialized` handshake ONCE for the
    /// whole process, rooted at `cwd` (the first conversation's dir; per-thread cwd is
    /// set at `thread/start`). Idempotent — a no-op once started. `pub(crate)` so the
    /// sibling extensions/accounts modules can run multi-request sequences against a
    /// DEDICATED transient server (always paired with `shutdown_all`).
    pub(crate) async fn ensure_started(&self, cwd: &Path) -> Result<(), CodexError> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let (transport, inbound_rx) = CodexTransport::spawn(CodexSpawnConfig {
            cwd: cwd.to_path_buf(),
        })
        .map_err(CodexError::Transport)?;

        let outbound = transport.outbound();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let router: Router = Arc::new(Mutex::new(HashMap::new()));

        // Start the demux BEFORE the handshake so the `initialize` response correlates.
        // It gets its OWN clone of `outbound` to answer server-requests directly (see
        // `demux_loop`); that clone is dropped on teardown (`shutdown_all` awaits the
        // aborted task) so it never keeps stdin open.
        let reader = tokio::spawn(demux_loop(
            inbound_rx,
            pending.clone(),
            router.clone(),
            outbound.clone(),
        ));

        // initialize → wait for the result → initialized (a bare notification).
        let init_params = serde_json::to_value(protocol::InitializeParams {
            client_info: protocol::ClientInfo {
                name: self.client_name.into(),
                title: "Flight Deck".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: protocol::ClientCapabilities {
                experimental_api: true,
                request_attestation: false,
            },
        })
        .unwrap_or(Value::Null);
        send_request_raw(&outbound, &pending, "0", "initialize", init_params).await?;
        let _ = outbound.send(protocol::notification("initialized", None));

        *guard = Some(Started {
            outbound,
            next_id: AtomicU64::new(1),
            pending,
            router,
            transport,
            reader,
            opening: Arc::new(AtomicU64::new(0)),
        });
        Ok(())
    }

    /// Send a correlated JSON-RPC request from any conversation actor. Never holds the
    /// inner lock across the await (clones the send handles + a fresh id under a brief
    /// lock, then awaits the oneshot lock-free) → requests from different threads run
    /// concurrently.
    pub async fn request(&self, method: &'static str, params: Value) -> Result<Value, CodexError> {
        let (outbound, pending, id) = {
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(CodexError::Closed)?;
            let id = started.next_id.fetch_add(1, Ordering::SeqCst).to_string();
            (started.outbound.clone(), started.pending.clone(), id)
        };
        send_request_raw(&outbound, &pending, &id, method, params).await
    }

    /// Fire ONE stateless server-scoped request (`model/list`, `skills/list`) against a
    /// FRESH, transient app-server, then tear it down. Used for catalogue queries that
    /// need no conversation thread and must not touch the shared long-lived server (nor
    /// leave an idle one running — the perf principle). Spawn → handshake → request →
    /// shutdown; the whole thing lives only for the call.
    pub async fn oneshot(
        method: &'static str,
        params: Value,
        cwd: &Path,
    ) -> Result<Value, CodexError> {
        let server = CodexServer::new();
        if let Err(e) = server.ensure_started(cwd).await {
            server.shutdown_all().await;
            return Err(e);
        }
        let result = server.request(method, params).await;
        server.shutdown_all().await;
        result
    }

    /// Run ONE self-contained model turn against a FRESH, `read-only` + `never`-approval
    /// app-server (spawn → thread/start → turn/start → collect the agent's final text →
    /// archive the ephemeral thread → shutdown) and return the assistant's answer. For a
    /// cheap one-shot query (the Codex auto-title) that must NOT touch the shared server,
    /// invoke a tool, or block on an approval. The thread is best-effort `thread/archive`d
    /// after collection so it never lands in the user's `codex resume` history. Bounded by
    /// a 30s deadline; `Err` on timeout / transport / an empty answer.
    pub async fn run_ephemeral_turn(
        prompt: String,
        model: Option<&str>,
        cwd: &Path,
    ) -> Result<String, CodexError> {
        // Stamped as an INTERNAL client so its rollout is recognisable on disk: the archive
        // below is best-effort, and a surviving rollout used to be listed in the History
        // panel as a real conversation — one whose only "user message" is the title prompt
        // WE wrote, shown under the user's avatar.
        let server = CodexServer::internal();
        let (thread_id, mut inbound) =
            match server.start_thread_with(cwd, model, "read-only", "never").await {
                Ok(p) => p,
                Err(e) => {
                    server.shutdown_all().await;
                    return Err(e);
                }
            };
        let params = serde_json::json!({
            "threadId": &thread_id,
            "input": [{ "type": "text", "text": prompt }],
        });
        if let Err(e) = server.request("turn/start", params).await {
            // No turn ever started → the thread has no on-disk rollout, nothing to archive.
            server.shutdown_all().await;
            return Err(e);
        }
        // Collect the FINAL agentMessage text until the turn completes (bounded). Under
        // `read-only`+`never` no approval ServerRequest can arrive, so a plain notification
        // loop is enough. An `error` notification's message is CAPTURED (not swallowed) so the
        // Err is informative to the caller/logs.
        let mut answer = String::new();
        let mut turn_error: Option<String> = None;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match tokio::time::timeout_at(deadline, inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, params })) => {
                    if method == "item/completed" {
                        if let Some(t) = agent_message_text(&params) {
                            answer = t;
                        }
                    } else if method == "error" {
                        turn_error = Some(
                            params
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("codex app-server error")
                                .to_string(),
                        );
                        break;
                    } else if method == "turn/completed" {
                        break;
                    }
                }
                Ok(Some(_)) => {} // ServerRequest — not expected under never-approval; ignore
                _ => break,       // timeout or channel closed
            }
        }
        // Best-effort cleanup: the binary persists every thread that ran a turn as a
        // rollout under ~/.codex/sessions, so an un-archived ephemeral thread would
        // pollute the user's `codex resume` picker with our internal title prompt —
        // permanently, once per generation attempt. Archive it on the same transient
        // server before teardown; a failure costs one stray rollout, so it is only
        // logged, never surfaced (the collected answer matters more than the cleanup).
        if let Err(e) = server
            .request("thread/archive", serde_json::json!({ "threadId": &thread_id }))
            .await
        {
            eprintln!("[codex-ephemeral] thread/archive of ephemeral thread {thread_id} failed: {e}");
        }
        server.shutdown_all().await;
        let answer = answer.trim().to_string();
        if !answer.is_empty() {
            Ok(answer)
        } else if let Some(e) = turn_error {
            Err(CodexError::Rpc(format!("the model turn failed: {e}")))
        } else {
            Err(CodexError::Rpc("the model returned no text (timeout or empty turn)".into()))
        }
    }

    /// Send a fire-and-forget reply to a server request (echoing its id). Used to
    /// decline approvals defensively so the server never blocks on us.
    pub async fn reply(&self, reply: Value) {
        let outbound = {
            let guard = self.inner.lock().await;
            guard.as_ref().map(|s| s.outbound.clone())
        };
        if let Some(tx) = outbound {
            let _ = tx.send(reply);
        }
    }

    /// Open a thread for `cwd` (starting the server if needed), register its inbound
    /// route, and return the (threadId, inbound receiver) to the conversation actor.
    /// `model` = the conversation's chosen Codex model (`None` → the server's default).
    /// Policy: `sandbox:"workspace-write"` + `approvalPolicy:"on-request"` — Codex can
    /// edit/run inside the workspace like Claude's default, and asks before anything the
    /// model deems risky. Those approvals ride the routed round-trip (demux → actor →
    /// permission prompt → reply); the preset selector that changes this is phase 4.2.
    pub async fn start_thread(
        &self,
        cwd: &Path,
        model: Option<&str>,
    ) -> Result<(String, mpsc::UnboundedReceiver<Incoming>), CodexError> {
        // A real conversation: edit/run inside the workspace like Claude's default, ask before
        // anything risky (approvals ride the routed round-trip).
        self.start_thread_with(cwd, model, "workspace-write", "on-request").await
    }

    /// Open a thread with EXPLICIT sandbox + approval policy — the general form of
    /// [`start_thread`]. A cheap one-shot query (an auto-title) opens a `read-only` +
    /// `never` thread so it can NEVER invoke a tool or block on an approval the ephemeral
    /// server has no one to answer.
    pub async fn start_thread_with(
        &self,
        cwd: &Path,
        model: Option<&str>,
        sandbox: &str,
        approval_policy: &str,
    ) -> Result<(String, mpsc::UnboundedReceiver<Incoming>), CodexError> {
        let params = serde_json::to_value(protocol::ThreadStartParams {
            model: model.map(str::to_string),
            cwd: Some(cwd.to_string_lossy().to_string()),
            sandbox: Some(sandbox.to_string()),
            approval_policy: Some(approval_policy.to_string()),
        })
        .unwrap_or(Value::Null);
        self.open_thread_route(cwd, "thread/start", params).await
    }

    /// RESUME an existing thread by id (`thread/resume`) instead of opening a fresh one —
    /// the analogue of Claude's `--resume`. Verified against the live binary: the server
    /// reloads the thread's rollout from disk, the returned `thread.id` is the SAME id
    /// (stable across resumes), and a subsequent `turn/start` continues it with the full
    /// prior context. Registers the thread's route exactly like [`start_thread_with`], so
    /// the conversation actor receives its live notifications. `model` overrides the
    /// resumed model (the conversation's chosen one); `None` keeps the thread's own.
    pub async fn resume_thread(
        &self,
        cwd: &Path,
        thread_id: &str,
        model: Option<&str>,
    ) -> Result<(String, mpsc::UnboundedReceiver<Incoming>), CodexError> {
        // `thread/resume` returns `{thread:{id,…}, model, …}` — the same envelope shape
        // as `thread/start` for our purposes (we only need `thread.id`); extra fields
        // are ignored by serde. The returned id is the SAME id (stable across resumes).
        let params = serde_json::json!({ "threadId": thread_id, "model": model });
        self.open_thread_route(cwd, "thread/resume", params).await
    }

    /// The ONE open-and-register sequence behind [`start_thread_with`] and
    /// [`resume_thread`] (they only differ by method + params): start the server if
    /// needed, hold the open-guard across the whole round-trip (request → route
    /// registered) so a concurrent last-thread teardown never reaps the server under
    /// us, fire the thread-opening request, parse the `{thread:{id}}` envelope both
    /// methods return, and register the thread's inbound route. On ANY failure after
    /// the server is up, if no thread ended up open, tear the idle server down —
    /// otherwise it (and its MCP children) leaks until quit, and every later Codex
    /// conversation would re-use a possibly-wedged server (MAJEUR 2).
    async fn open_thread_route(
        &self,
        cwd: &Path,
        method: &'static str,
        params: Value,
    ) -> Result<(String, mpsc::UnboundedReceiver<Incoming>), CodexError> {
        self.ensure_started(cwd).await?;
        let Some(_open) = self.begin_open().await else {
            return Err(CodexError::Closed);
        };

        let result = match self.request(method, params).await {
            Ok(r) => r,
            Err(e) => {
                self.shutdown_if_no_threads().await;
                return Err(e);
            }
        };
        let parsed: protocol::ThreadStartResult = match serde_json::from_value(result) {
            Ok(p) => p,
            Err(e) => {
                self.shutdown_if_no_threads().await;
                return Err(CodexError::Rpc(format!("malformed {method} response: {e}")));
            }
        };
        let thread_id = parsed.thread.id;

        let (tx, rx) = mpsc::unbounded_channel::<Incoming>();
        {
            let guard = self.inner.lock().await;
            if let Some(started) = guard.as_ref() {
                started.router.lock().unwrap().insert(thread_id.clone(), tx);
            } else {
                // Torn down between ensure_started and here (extremely unlikely).
                return Err(CodexError::Closed);
            }
        }
        Ok((thread_id, rx))
    }

    /// Tear the server down if NO conversation thread is open — reaps an idle app-server
    /// after a failed `thread/start` so it (and its MCP children) never leaks, and a
    /// wedged server is never re-used by the next conversation.
    async fn shutdown_if_no_threads(&self) {
        if let Some(started) = self.take_if_idle().await {
            teardown(started).await;
        }
    }

    /// Take the running server FOR TEARDOWN — only if it is genuinely idle: no
    /// registered route AND no thread-open sequence in flight. The check and the
    /// `take()` happen under ONE acquisition of `inner`, closing the TOCTOU where a
    /// concurrent `start_thread_with`/`resume_thread` opened (or was opening) a thread
    /// between a caller's "is it empty?" and its unconditional `shutdown_all` — which
    /// EOF'd the brand-new route and killed the fresh conversation (review HIGH).
    async fn take_if_idle(&self) -> Option<Started> {
        let mut guard = self.inner.lock().await;
        let idle = guard
            .as_ref()
            .map(|s| {
                s.router.lock().unwrap().is_empty() && s.opening.load(Ordering::SeqCst) == 0
            })
            .unwrap_or(false);
        if idle {
            guard.take()
        } else {
            None
        }
    }

    /// Mark a thread-open sequence as in flight (guards [`take_if_idle`] across the
    /// whole `thread/start`/`thread/resume` round-trip, BEFORE the route exists).
    /// Returns a drop-guard so every exit path — success, RPC error, parse error —
    /// decrements honestly. `None` when the server is already gone.
    async fn begin_open(&self) -> Option<OpenGuard> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|s| {
            s.opening.fetch_add(1, Ordering::SeqCst);
            OpenGuard(s.opening.clone())
        })
    }

    /// Register a route under a SYNTHETIC key (not a thread id) to receive this
    /// server's GLOBAL (thread-less) notifications — the demux broadcasts those to
    /// every route. For DEDICATED transient servers only (e.g. the account-login
    /// watcher waiting on `account/login/completed`): on the SHARED server the extra
    /// route would keep `shutdown_if_no_threads` from ever seeing an empty router.
    pub(crate) async fn subscribe_global(
        &self,
        key: &str,
    ) -> Result<mpsc::UnboundedReceiver<Incoming>, CodexError> {
        let (tx, rx) = mpsc::unbounded_channel::<Incoming>();
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(CodexError::Closed)?;
        started.router.lock().unwrap().insert(key.to_string(), tx);
        Ok(rx)
    }

    /// Close one conversation's thread: drop its route. When the LAST thread closes,
    /// tear the whole server down gracefully (invariant #9) — via the ATOMIC
    /// idle-check-and-take, so a conversation opening concurrently is never torn down.
    pub async fn close_thread(&self, thread_id: &str) {
        {
            let guard = self.inner.lock().await;
            if let Some(started) = guard.as_ref() {
                started.router.lock().unwrap().remove(thread_id);
            }
        }
        if let Some(started) = self.take_if_idle().await {
            teardown(started).await;
        }
    }

    /// UNCONDITIONAL graceful teardown of the whole server. Reserved for the cases
    /// where killing everything is the point (app quit, dedicated transient servers);
    /// the last-thread-closed path goes through [`take_if_idle`] instead.
    pub async fn shutdown_all(&self) {
        let started = self.inner.lock().await.take();
        if let Some(started) = started {
            teardown(started).await;
        }
    }
}

/// Decrements the thread-open in-flight counter on drop, so every exit path of an
/// open sequence (success, RPC error, malformed response) releases its guard.
struct OpenGuard(Arc<AtomicU64>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The one teardown routine for a TAKEN server. Drops OUR writer clone FIRST so the
/// transport's own clone becomes the only one → its `shutdown` EOFs stdin → the
/// app-server reaps its MCP children. Also FAILS every in-flight request with
/// `Closed`: `reader.abort()` cancels the demux BEFORE its own epilogue drains
/// `pending`, so without this drain a request in flight at teardown would sit on its
/// oneshot until the full 30s REQUEST_TIMEOUT (review HIGH) instead of erroring now.
async fn teardown(started: Started) {
    let Started {
        outbound,
        pending,
        router,
        mut transport,
        reader,
        ..
    } = started;
    // Stop the demux and WAIT for it to finish, so ITS clone of `outbound` is
    // dropped — otherwise stdin never EOFs and the graceful teardown can't reap
    // the app-server's (setsid) MCP children (invariant #9).
    reader.abort();
    let _ = reader.await;
    // Fail every awaiting request immediately (the demux epilogue only runs on a
    // natural EOF, not on abort).
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err(CodexError::Closed));
    }
    // Release our own writer clone → the transport's is now the last one.
    drop(outbound);
    // EOF every remaining actor's inbound so they run their own teardown.
    router.lock().unwrap().clear();
    transport.shutdown().await;
}

/// Extract the text of an `item/completed` notification whose item is an `agentMessage`
/// (the assistant's final answer). `None` for any other item type — so a tool card or a
/// reasoning item is skipped and only the spoken answer is captured.
fn agent_message_text(params: &Value) -> Option<String> {
    let item = params.get("item")?;
    if item.get("type").and_then(Value::as_str)? != "agentMessage" {
        return None;
    }
    item.get("text").and_then(Value::as_str).map(str::to_string)
}

/// Low-level correlated send: register a oneshot under `id`, write the request line,
/// await the response (bounded). Used by both `ensure_started` (for `initialize`,
/// before `Started` exists) and `request`.
async fn send_request_raw(
    outbound: &mpsc::UnboundedSender<Value>,
    pending: &Pending,
    id: &str,
    method: &'static str,
    params: Value,
) -> Result<Value, CodexError> {
    let (tx, rx) = oneshot::channel();
    pending.lock().unwrap().insert(id.to_string(), tx);
    outbound
        .send(protocol::request(id, method, params))
        .map_err(|_| CodexError::Closed)?;
    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(CodexError::Closed), // oneshot dropped → server died
        Err(_) => {
            pending.lock().unwrap().remove(id); // clean up the abandoned slot
            Err(CodexError::Timeout(method))
        }
    }
}

/// The single consumer of the transport's inbound stream. Correlates responses by id
/// and routes thread-scoped messages by threadId. On the stream closing (server died)
/// it fails every pending request and EOFs every actor route, then ends.
async fn demux_loop(
    mut inbound_rx: mpsc::UnboundedReceiver<Incoming>,
    pending: Pending,
    router: Router,
    outbound: mpsc::UnboundedSender<Value>,
) {
    while let Some(incoming) = inbound_rx.recv().await {
        match incoming {
            Incoming::Response { id, result, error } => {
                if let Some(tx) = pending.lock().unwrap().remove(&id) {
                    let outcome = match (result, error) {
                        (_, Some(e)) => Err(CodexError::Rpc(error_message(&e))),
                        (Some(r), None) => Ok(r),
                        (None, None) => Ok(Value::Null),
                    };
                    let _ = tx.send(outcome);
                }
            }
            // A server request EXPECTS a reply keyed by its id. An APPROVAL request (a
            // shell command / file patch awaiting the user's yes/no) is ROUTED to its
            // thread's actor, which surfaces a permission prompt and replies when the user
            // answers (or declines it at teardown). EVERY other server request — and any
            // approval whose thread has no live route (thread-less or torn down) — is
            // answered HERE, so the shared stdio process can never block on us (review
            // MAJEUR 3). The actor holding an approval is the intended block (a turn waiting
            // on the user), exactly like Claude's `can_use_tool`.
            Incoming::ServerRequest { id, method, params } => {
                let routed = if is_approval_request(&method) {
                    let sink = params
                        .get("threadId")
                        .and_then(Value::as_str)
                        .and_then(|tid| router.lock().unwrap().get(tid).cloned());
                    match sink {
                        // Clone `method` for the route so it's still available for the
                        // fallback reply below (the None/non-approval paths never send).
                        Some(tx) => tx
                            .send(Incoming::ServerRequest {
                                id: id.clone(),
                                method: method.clone(),
                                params,
                            })
                            .is_ok(),
                        None => false,
                    }
                } else {
                    false
                };
                if !routed {
                    let reply = if method == "currentTime/read" {
                        protocol::reply_result(&id, serde_json::json!({ "currentTimeMs": now_ms() }))
                    } else {
                        protocol::reply_error(&id, -32601, "not handled by Flight Deck")
                    };
                    let _ = outbound.send(reply);
                }
            }
            Incoming::Notification { method, params } => {
                match params.get("threadId").and_then(Value::as_str) {
                    // Thread-scoped: route to the owning conversation actor. An unknown
                    // route (thread torn down) is a harmless drop.
                    Some(tid) => {
                        let sink = router.lock().unwrap().get(tid).cloned();
                        if let Some(tx) = sink {
                            let _ = tx.send(Incoming::Notification { method, params });
                        }
                    }
                    // GLOBAL (thread-less): account/rateLimits/updated, skills/changed,
                    // remoteControl/status/changed, … These aren't scoped to a conversation,
                    // so broadcast to EVERY open actor (each ignores methods it doesn't
                    // handle). Account-global state (rate limits, remote status) reaches the
                    // one front store whichever actor surfaces it. Previously such lines were
                    // dropped at the socle — that would silence every global push.
                    None => {
                        let sinks: Vec<_> =
                            router.lock().unwrap().values().cloned().collect();
                        for tx in sinks {
                            let _ = tx.send(Incoming::Notification {
                                method: method.clone(),
                                params: params.clone(),
                            });
                        }
                    }
                }
            }
            Incoming::Malformed(v) => {
                eprintln!("[codex-server] malformed line ignored: {v}");
            }
        }
    }
    // Inbound closed → the app-server is gone. Fail every waiter and EOF every route so
    // each actor surfaces the spontaneous death (invariant #6) instead of hanging.
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err(CodexError::Closed));
    }
    router.lock().unwrap().clear();
}

/// Whether a server request is a user-decidable APPROVAL (routed to the owning thread's
/// actor) vs an infra request answered centrally. Phase 4.1 routes shell-command and
/// file-patch approvals; the richer `permissions`/`requestUserInput`/`elicitation`
/// requests are declined centrally until their UIs land (4.2/4.4).
fn is_approval_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    )
}

/// Unix-ms now, for answering the server's `currentTime/read` request.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pull a human message out of a JSON-RPC error object (`{code, message}` or a bare
/// string), for surfacing without leaking raw JSON.
fn error_message(e: &Value) -> String {
    e.get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| e.as_str().map(str::to_string))
        .unwrap_or_else(|| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_message_extracts_or_falls_back() {
        assert_eq!(error_message(&serde_json::json!({"code":-1,"message":"boom"})), "boom");
        assert_eq!(error_message(&serde_json::json!("plain")), "plain");
        assert_eq!(error_message(&serde_json::json!({"code":-1})), "{\"code\":-1}");
    }

    #[tokio::test]
    async fn request_on_unstarted_server_is_closed() {
        let s = CodexServer::new();
        // No conversation has opened a thread → no process → request must not hang.
        let r = s.request("turn/start", serde_json::json!({})).await;
        assert!(matches!(r, Err(CodexError::Closed)));
    }

    /// End-to-end proof against the REAL `codex app-server`: handshake → open a thread
    /// → run a text turn → receive assistant text → `turn/completed` → graceful
    /// teardown. Ignored by default (spawns the real binary; needs ChatGPT auth + burns
    /// a sliver of quota). Run with: `cargo test --lib -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server (network + ChatGPT auth + quota)"]
    async fn live_handshake_thread_and_text_turn() {
        let server = CodexServer::new();
        let cwd = std::env::temp_dir();

        let (thread_id, mut inbound) = server
            .start_thread(&cwd, None)
            .await
            .expect("handshake + thread/start should succeed against the real binary");
        assert!(!thread_id.is_empty(), "thread id must be non-empty");

        // The turn/start RESPONSE is correlated by the server; the turn's OUTPUT arrives
        // as notifications routed to our `inbound`.
        server
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"Reply with exactly the single word: pong"}],
                }),
            )
            .await
            .expect("turn/start should be accepted");

        // Collect (bounded) until this thread's turn completes; assert we saw text.
        let mut saw_text = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            match tokio::time::timeout_at(deadline, inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, .. })) => {
                    if method == "item/agentMessage/delta" || method == "item/completed" {
                        saw_text = true;
                    }
                    if method == "turn/completed" {
                        break;
                    }
                }
                Ok(Some(_)) => {}
                _ => break, // timeout or channel closed
            }
        }
        assert!(saw_text, "expected at least one assistant-text notification");

        server.shutdown_all().await;
    }

    /// PROBE: what context window does the server actually report PER MODEL? The context ring's
    /// denominator is `thread/tokenUsage/updated.tokenUsage.modelContextWindow`; a user reported
    /// it reads the SAME (~353k) for every model, doubting gpt-5.6 is really that small. This
    /// runs a one-token turn for gpt-5.6-sol vs gpt-5.5 and prints the reported window (plus any
    /// model REROUTE / safety-buffer note), to tell a genuine bug from the wire's real value.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_model_context_window`.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server (network + ChatGPT auth + a sliver of quota)"]
    async fn live_probe_model_context_window() {
        for model in ["gpt-5.6-sol", "gpt-5.5"] {
            let server = CodexServer::new();
            let cwd = std::env::temp_dir();
            let (thread_id, mut inbound) = match server.start_thread(&cwd, Some(model)).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("CTX PROBE [{model}]: thread/start failed → {e}");
                    server.shutdown_all().await;
                    continue;
                }
            };
            server
                .request(
                    "turn/start",
                    serde_json::json!({ "threadId": thread_id, "input": [{"type":"text","text":"hi"}] }),
                )
                .await
                .expect("turn/start accepted");
            let mut window: Option<u64> = None;
            let mut notes: Vec<String> = Vec::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                match tokio::time::timeout_at(deadline, inbound.recv()).await {
                    Ok(Some(Incoming::Notification { method, params })) => {
                        if method == "thread/tokenUsage/updated" {
                            if let Some(w) = params
                                .get("tokenUsage")
                                .and_then(|u| u.get("modelContextWindow"))
                                .and_then(Value::as_u64)
                            {
                                window = Some(w);
                            }
                        } else if method.to_lowercase().contains("rerout")
                            || method.to_lowercase().contains("safetybuffer")
                        {
                            notes.push(format!("{method}: {params}"));
                        } else if method == "turn/completed" {
                            break;
                        }
                    }
                    Ok(Some(_)) => {}
                    _ => break,
                }
            }
            eprintln!("CTX PROBE [{model}]: modelContextWindow = {window:?}");
            for n in &notes {
                eprintln!("  note: {n}");
            }
            let _ = server
                .request("thread/archive", serde_json::json!({ "threadId": thread_id }))
                .await;
            server.shutdown_all().await;
        }
    }

    /// End-to-end proof of RESUME-by-id (the cold-history continuation path): server A
    /// opens a thread and runs a turn (writing its rollout to disk), then a SEPARATE server
    /// B `resume_thread`s it by id and runs ANOTHER turn — proving a resumed thread keeps a
    /// STABLE id and accepts further turns (so continuing a cold-loaded conversation works).
    /// Self-contained: it creates its OWN throwaway thread in a temp dir, never touching a
    /// real user thread. Ignored by default (real binary + auth + a sliver of quota).
    /// Run: `cargo test --lib -- --ignored --nocapture live_resume_thread_and_continue`.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server (network + ChatGPT auth + quota)"]
    async fn live_resume_thread_and_continue() {
        let cwd = std::env::temp_dir();

        // Server A: create a thread + one turn so a rollout is persisted on disk.
        let server_a = CodexServer::new();
        let (thread_id, mut inbound_a) = server_a
            .start_thread(&cwd, None)
            .await
            .expect("thread/start should succeed");
        server_a
            .request(
                "turn/start",
                serde_json::json!({ "threadId": thread_id, "input": [{"type":"text","text":"Reply with exactly: un"}] }),
            )
            .await
            .expect("first turn/start accepted");
        drain_until_turn_completed(&mut inbound_a).await;
        server_a.shutdown_all().await;

        // Server B (fresh process): RESUME the thread by id and run another turn.
        let server_b = CodexServer::new();
        let (resumed_id, mut inbound_b) = server_b
            .resume_thread(&cwd, &thread_id, None)
            .await
            .expect("thread/resume by id should succeed against the real binary");
        assert_eq!(resumed_id, thread_id, "resume must keep the SAME thread id (stable)");

        server_b
            .request(
                "turn/start",
                serde_json::json!({ "threadId": resumed_id, "input": [{"type":"text","text":"Reply with exactly: deux"}] }),
            )
            .await
            .expect("turn/start on the RESUMED thread should be accepted");
        let saw_text = drain_until_turn_completed(&mut inbound_b).await;
        assert!(saw_text, "the resumed thread must produce assistant text on its next turn");

        server_b.shutdown_all().await;
    }

    /// Drain a thread's inbound until `turn/completed`, reporting whether any assistant-text
    /// notification was seen. Bounded so a stuck turn fails the test instead of hanging.
    async fn drain_until_turn_completed(inbound: &mut mpsc::UnboundedReceiver<Incoming>) -> bool {
        let mut saw_text = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            match tokio::time::timeout_at(deadline, inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, .. })) => {
                    if method == "item/agentMessage/delta" || method == "item/completed" {
                        saw_text = true;
                    }
                    if method == "turn/completed" {
                        break;
                    }
                }
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        saw_text
    }

    /// Does the stream-control button work for Codex? It sends `SessionCommand::Interrupt`
    /// → `turn/interrupt`. This proves what SETTLES the turn afterwards: if the binary
    /// emits `turn/completed`, the actor clears `busy` (spinner stops); anything else and
    /// `busy` would hang. Prints the exact notification sequence for the record.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server (network + ChatGPT auth + quota)"]
    async fn live_interrupt_settles_the_turn() {
        let server = CodexServer::new();
        let (thread_id, mut inbound) = server.start_thread(&std::env::temp_dir(), None).await.unwrap();
        let start = server
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"Count slowly from 1 to 60, one number per line."}],
                }),
            )
            .await
            .unwrap();
        let turn_id = start["turn"]["id"].as_str().unwrap_or_default().to_string();
        assert!(!turn_id.is_empty(), "turn/start response must carry the turn id");

        // Wait until the turn is actually streaming, then interrupt it.
        let mut underway = false;
        for _ in 0..300 {
            match tokio::time::timeout(Duration::from_millis(200), inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, .. })) if method.contains("agentMessage") => {
                    underway = true;
                    break;
                }
                Ok(Some(_)) => {}
                _ => {}
            }
        }
        assert!(underway, "the turn should start streaming before we interrupt");
        server
            .request(
                "turn/interrupt",
                serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await
            .unwrap();

        // What notification SETTLES the turn after an interrupt?
        let mut seen = Vec::new();
        let mut settled = None;
        for _ in 0..200 {
            match tokio::time::timeout(Duration::from_millis(400), inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, .. })) => {
                    seen.push(method.clone());
                    if method == "turn/completed" {
                        settled = Some(method);
                        break;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break, // went idle
            }
        }
        eprintln!("AFTER INTERRUPT saw: {seen:?} ; settled={settled:?}");
        server.shutdown_all().await;
        assert_eq!(
            settled.as_deref(),
            Some("turn/completed"),
            "interrupt must settle with turn/completed so `busy` clears; saw {seen:?}"
        );
    }

    #[tokio::test]
    async fn demux_routes_by_thread_and_correlates_by_id() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let router: Router = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Incoming>();
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
        let task = tokio::spawn(demux_loop(
            inbound_rx,
            pending.clone(),
            router.clone(),
            outbound_tx,
        ));

        // Register a waiter for id "5" and a route for thread "t1".
        let (rtx, rrx) = oneshot::channel();
        pending.lock().unwrap().insert("5".into(), rtx);
        let (ttx, mut trx) = mpsc::unbounded_channel::<Incoming>();
        router.lock().unwrap().insert("t1".into(), ttx);

        // A response correlates to the waiter.
        inbound_tx
            .send(Incoming::Response { id: "5".into(), result: Some(serde_json::json!("ok")), error: None })
            .unwrap();
        assert_eq!(rrx.await.unwrap().unwrap(), serde_json::json!("ok"));

        // A thread-scoped notification routes to that thread's actor.
        inbound_tx
            .send(Incoming::Notification {
                method: "turn/completed".into(),
                params: serde_json::json!({"threadId":"t1"}),
            })
            .unwrap();
        assert!(matches!(trx.recv().await, Some(Incoming::Notification { .. })));

        // A server request is ALWAYS answered here — even with NO matching route — so the
        // shared process never blocks on us (review MAJEUR 3): `currentTime/read` → a
        // result, anything else → a JSON-RPC decline.
        inbound_tx
            .send(Incoming::ServerRequest {
                id: "42".into(),
                method: "item/fileChange/requestApproval".into(),
                params: serde_json::json!({ "threadId": "no-such-route" }),
            })
            .unwrap();
        let reply = outbound_rx.recv().await.expect("server request must be answered");
        // The hand-built id "42" mimics `classify`'s raw-JSON-text encoding of a NUMERIC
        // wire id → the decline echoes it back as the number 42 (original JSON type).
        assert_eq!(reply["id"], 42);
        assert!(reply.get("error").is_some(), "an unhandleable server request is declined");

        // Closing the stream fails outstanding waiters and EOFs routes.
        drop(inbound_tx);
        let _ = task.await;
        assert!(trx.recv().await.is_none(), "route EOFs when the server dies");
    }

    #[tokio::test]
    async fn global_notification_broadcasts_to_every_route() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let router: Router = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Incoming>();
        let (outbound_tx, _outbound_rx) = mpsc::unbounded_channel::<Value>();
        let task = tokio::spawn(demux_loop(inbound_rx, pending, router.clone(), outbound_tx));

        // Two live conversation routes.
        let (t1tx, mut t1rx) = mpsc::unbounded_channel::<Incoming>();
        let (t2tx, mut t2rx) = mpsc::unbounded_channel::<Incoming>();
        router.lock().unwrap().insert("t1".into(), t1tx);
        router.lock().unwrap().insert("t2".into(), t2tx);

        // A thread-less (global) notification — no `threadId` — must reach BOTH actors
        // (account-global pushes like rate limits), not be dropped.
        inbound_tx
            .send(Incoming::Notification {
                method: "account/rateLimits/updated".into(),
                params: serde_json::json!({ "rateLimits": { "primary": { "usedPercent": 5.0 } } }),
            })
            .unwrap();
        assert!(matches!(t1rx.recv().await, Some(Incoming::Notification { method, .. }) if method == "account/rateLimits/updated"));
        assert!(matches!(t2rx.recv().await, Some(Incoming::Notification { method, .. }) if method == "account/rateLimits/updated"));

        drop(inbound_tx);
        let _ = task.await;
    }

    /// End-to-end proof of the approval round-trip against the REAL binary: whenever the
    /// server asks for approval, replying `{decision:"accept"}` (exactly what the actor
    /// does on the user's Allow) must let the turn proceed to `turn/completed`. Whether an
    /// approval actually fires is policy/model-dependent (an in-workspace write is
    /// auto-allowed under `workspace-write`), so we LOG that but hard-assert only that the
    /// turn — with our approval handling in the loop — completes. A restrictive command is
    /// used to make an approval likely.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server (network + ChatGPT auth + quota)"]
    async fn live_approval_round_trip_unblocks_the_turn() {
        let server = CodexServer::new();
        let dir = std::env::temp_dir().join("fd-codex-approval-probe");
        let _ = std::fs::create_dir_all(&dir);
        let (thread_id, mut inbound) = server.start_thread(&dir, None).await.unwrap();
        server
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"Run the shell command `rm -rf /tmp/fd-codex-approval-probe/x && echo done`."}],
                }),
            )
            .await
            .unwrap();

        let mut saw_approval = false;
        let mut completed = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            match tokio::time::timeout_at(deadline, inbound.recv()).await {
                Ok(Some(Incoming::ServerRequest { id, method, .. }))
                    if method.contains("requestApproval") =>
                {
                    saw_approval = true;
                    server
                        .reply(protocol::reply_result(
                            &id,
                            serde_json::json!({ "decision": "accept" }),
                        ))
                        .await;
                }
                Ok(Some(Incoming::Notification { method, .. })) => {
                    if method == "turn/completed" {
                        completed = true;
                        break;
                    }
                }
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        server.shutdown_all().await;
        eprintln!("approval fired during the turn: {saw_approval}");
        assert!(completed, "accepting approvals (if any) must let the turn complete");
    }

    /// Capture a real turn's inbound NDJSON into `fixtures/capture_codex_turn.jsonl` — the
    /// non-regression fixture the `replay_captured_turn_*` test replays through the actor
    /// (the Codex analogue of `capture_text.jsonl`). Re-run after a `codex` upgrade to
    /// refresh the recorded item shapes: `cargo test --lib -- --ignored capture_live_turn`.
    #[tokio::test]
    #[ignore = "spawns a real codex app-server; (re)writes the capture fixture"]
    async fn capture_live_turn_to_fixture() {
        let server = CodexServer::new();
        let dir = std::env::temp_dir().join("fd-codex-capture");
        let _ = std::fs::create_dir_all(&dir);
        let (thread_id, mut inbound) = server.start_thread(&dir, None).await.unwrap();
        server
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type":"text","text":"Think briefly, then run the shell command `echo hello from codex`, then create a file note.txt containing the single word: ok"}],
                }),
            )
            .await
            .unwrap();

        let mut lines: Vec<String> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            match tokio::time::timeout_at(deadline, inbound.recv()).await {
                Ok(Some(Incoming::Notification { method, params })) => {
                    lines.push(serde_json::json!({ "method": method, "params": params }).to_string());
                    if method == "turn/completed" {
                        break;
                    }
                }
                Ok(Some(Incoming::ServerRequest { id, method, params })) => {
                    lines.push(
                        serde_json::json!({ "serverRequest": { "id": id, "method": method, "params": params } })
                            .to_string(),
                    );
                    server
                        .reply(protocol::reply_result(
                            &id,
                            serde_json::json!({ "decision": "accept" }),
                        ))
                        .await;
                }
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        server.shutdown_all().await;

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/supervisor/fixtures/capture_codex_turn.jsonl"
        );
        std::fs::write(path, lines.join("\n") + "\n").expect("write fixture");
        eprintln!("captured {} lines → {path}", lines.len());
        assert!(
            lines.iter().any(|l| l.contains("agentMessage")),
            "expected at least one assistant-message notification"
        );
    }

    /// Verify the native Codex remote-control wire end-to-end: enable brings the bridge up,
    /// pairing/start returns a code, disable returns to "disabled". Runs on ONE server so it
    /// ALWAYS disables at the end (never leaves the user's remote control on). Ignored:
    /// spawns the real binary + toggles a real bridge (network + ChatGPT auth).
    /// Run: `cargo test --lib -- --ignored --nocapture live_remote_control_enable`.
    #[tokio::test]
    #[ignore = "spawns real codex app-server + toggles the remote-control bridge (network + auth)"]
    async fn live_remote_control_enable_pairing_disable() {
        let server = CodexServer::new();
        // Start the server (a throwaway thread does the handshake); enable/disable are
        // server-scoped (no threadId).
        let (_tid, _inbound) = server.start_thread(&std::env::temp_dir(), None).await.unwrap();

        let enabled = server
            .request("remoteControl/enable", serde_json::json!({}))
            .await
            .expect("enable should be accepted");
        eprintln!("REMOTE ENABLE → {enabled}");

        // Pairing is best-effort — log it, never unwrap (so we always reach disable below).
        let pairing = server
            .request("remoteControl/pairing/start", serde_json::json!({ "manualCode": true }))
            .await;
        eprintln!("REMOTE PAIRING → {pairing:?}");

        let disabled = server
            .request("remoteControl/disable", serde_json::json!({}))
            .await
            .expect("disable should be accepted");
        eprintln!("REMOTE DISABLE → {disabled}");
        server.shutdown_all().await;

        let en_status = enabled.get("status").and_then(|s| s.as_str());
        assert!(
            matches!(en_status, Some("connecting") | Some("connected")),
            "enable should report connecting/connected, got {en_status:?}"
        );
        assert_eq!(
            disabled.get("status").and_then(|s| s.as_str()),
            Some("disabled"),
            "disable must return the bridge to disabled"
        );
    }

    #[tokio::test]
    async fn approval_with_a_live_route_is_forwarded_to_the_actor() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let router: Router = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel::<Incoming>();
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
        let task = tokio::spawn(demux_loop(inbound_rx, pending, router.clone(), outbound_tx));

        // A live thread route exists…
        let (ttx, mut trx) = mpsc::unbounded_channel::<Incoming>();
        router.lock().unwrap().insert("t1".into(), ttx);

        // …so a command-approval server-request for that thread is ROUTED to its actor
        // (surfaced as a permission prompt there), NOT answered centrally.
        inbound_tx
            .send(Incoming::ServerRequest {
                id: "77".into(),
                method: "item/commandExecution/requestApproval".into(),
                params: serde_json::json!({ "threadId": "t1", "command": "ls" }),
            })
            .unwrap();
        match trx.recv().await {
            Some(Incoming::ServerRequest { id, method, .. }) => {
                assert_eq!(id, "77");
                assert_eq!(method, "item/commandExecution/requestApproval");
            }
            other => panic!("approval must reach the actor, got {other:?}"),
        }
        // Nothing was auto-answered centrally (the actor owns the reply now).
        assert!(
            outbound_rx.try_recv().is_err(),
            "a routed approval must NOT be answered by the demux"
        );

        drop(inbound_tx);
        let _ = task.await;
    }
}
