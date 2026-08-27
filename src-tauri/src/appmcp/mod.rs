//! App-hosted MCP servers — the ONE module through which agents pilot the app
//! itself (Phase 2's "MCP server that controls the IDE").
//!
//! Two transports share one tool catalogue ([`tools`]) and one JSON-RPC router
//! ([`router`]):
//!
//! - **In-process SDK MCP server** (`"flightdeck"`), advertised to each Claude
//!   session via `initialize.sdkMcpServers` (an array of NAMES — verified against
//!   the 2.1.233 binary) and served over that session's stdio control channel:
//!   inbound `control_request{subtype:"mcp_message", server_name, message}` →
//!   [`router::handle`] → `control_response{response:{mcp_response:<JSON-RPC>}}`.
//!   The caller's identity is free — the message arrives on the session that
//!   calls — so tools default to "the calling conversation" with no auth.
//!   Claude-only: Codex has no control channel to host an SDK server on.
//!
//! - **Loopback HTTP server** ([`http`], MCP "streamable HTTP") for external
//!   clients — the voice-agent use case. Opt-in (Settings), binds 127.0.0.1
//!   only, requires a Bearer token, and additionally serves [`events`]'s
//!   `wait_for_events` long-poll so a voice agent can react to "a conversation
//!   just finished its turn" without blind polling.
//!
//! Every UI-affecting tool executes IN THE FRONT — the webview owns all UI state
//! (stores, view, editor, live statuses). The hub emits an `app_control_request`
//! event carrying a request id; the front executor (`src/agent/appControl.ts`)
//! runs the action against its stores and answers through the
//! `app_control_respond` IPC command, which completes the pending call here.
//! Only `wait_for_events` is served Rust-side, from the [`events::EventJournal`]
//! the front feeds on agent transitions (`publish_control_event`).

pub mod events;
pub mod http;
pub mod relay;
pub mod router;
pub mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{oneshot, watch};

/// Name of the in-process SDK MCP server as the CLI (and permission rules —
/// `mcp__flightdeck__*`) see it.
pub const SDK_SERVER_NAME: &str = "flightdeck";

/// How long a front-bridged tool call may take before we answer the MCP client
/// with an error instead of hanging it. Generous: `create_conversation` with a
/// first message awaits a session spawn (~1-2 s); everything else is instant.
const FRONT_TIMEOUT: Duration = Duration::from_secs(30);

/// Which transport a tool call arrived on. Gates the visible tool catalogue
/// (see [`tools::for_surface`]): the in-app server exposes the full UI surface,
/// the voice bridge only the conversation-centric subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The in-process SDK server, called by a conversation's own agent.
    App,
    /// The loopback HTTP server, called by an external client (voice agent).
    Voice,
}

/// Who is calling. `Session` carries the live session handle (`session-N`) the
/// `mcp_message` arrived on — the front resolves it to a conversation, which is
/// what lets `whoami` / self-targeting tools work without authentication.
#[derive(Debug, Clone)]
pub enum Caller {
    Session(String),
    External,
}

/// The hub's outlet to the front: emits one `app_control_request` event per
/// bridged tool call. Implemented over the Tauri event bus in `ipc::events`
/// (kept as a trait so this module stays free of Tauri types, like
/// `tosse::sse::LiveSink`).
pub trait ToolSink: Send + Sync {
    fn request(&self, request_id: &str, tool: &str, args: &Value, session: Option<&str>);
}

/// The live state of the voice bridge, as reported to the Settings UI. This is
/// the honest read-back: `running`/`error` reflect what the listener actually
/// did, never what the toggle optimistically hoped (a failed bind must show).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceBridgeStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    /// The MCP endpoint to paste into the external client, when running.
    pub url: Option<String>,
    /// Why the server is not running although enabled (bind failure, …).
    pub error: Option<String>,
}

/// Desired voice-bridge configuration (persisted in SQLite `app_config` by the
/// IPC layer; the hub itself never touches the store).
#[derive(Debug, Clone)]
pub struct VoiceConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// Default loopback port for the voice bridge ("FD" → 70/68).
pub const DEFAULT_VOICE_PORT: u16 = 7068;

/// The cloud relay the app dials for phone remote-access, unless overridden in
/// Settings. Deployed from the `flightdeck-remote` repo (Railway).
pub const DEFAULT_RELAY_URL: &str = "https://relay-production-8fd4.up.railway.app";

/// Live state of the outbound remote-access relay connection, for the Settings
/// UI. Honest read-back: `connected` reflects the actual socket, `error` the last
/// failure. `pairing_url` / `pairing_qr_svg` are what a phone scans to pair.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub connected: bool,
    pub relay_url: String,
    pub mac_id: String,
    pub phone_token: String,
    pub pairing_url: Option<String>,
    pub pairing_qr_svg: Option<String>,
    pub error: Option<String>,
}

/// Desired remote-access configuration (persisted in SQLite `meta` by the IPC
/// layer; the hub never touches the store).
#[derive(Debug, Clone)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub relay_url: String,
    pub mac_id: String,
    pub mac_token: String,
    pub phone_token: String,
}

/// Runtime half of the voice bridge: the desired config plus what the listener
/// actually achieved (`running`/`error`), the stop signal of the accept loop,
/// and the loop's task handle (awaited on restart so the old listener socket is
/// actually RELEASED before the new bind — same-port re-applies would otherwise
/// race the old task's wakeup straight into EADDRINUSE).
struct VoiceRuntime {
    cfg: VoiceConfig,
    running: bool,
    error: Option<String>,
    stop: Option<watch::Sender<bool>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// Runtime half of the outbound relay connection. Unlike the voice bridge (which
/// binds a listener synchronously), connectedness changes over the connection's
/// life, so [`relay::serve`]'s reconnect loop updates `connected`/`error` as it goes.
struct RemoteRuntime {
    cfg: RemoteConfig,
    connected: bool,
    error: Option<String>,
    stop: Option<watch::Sender<bool>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// The app-control hub: pending front-bridge calls, the fleet event journal and
/// the voice-bridge runtime. One per app, shared with every session actor
/// (`Arc`) and managed as Tauri state for the IPC commands.
pub struct ControlHub {
    sink: OnceLock<Arc<dyn ToolSink>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_req: AtomicU64,
    pub events: events::EventJournal,
    voice: Mutex<VoiceRuntime>,
    remote: Mutex<RemoteRuntime>,
}

impl Default for ControlHub {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlHub {
    pub fn new() -> Self {
        Self {
            sink: OnceLock::new(),
            pending: Mutex::new(HashMap::new()),
            next_req: AtomicU64::new(1),
            events: events::EventJournal::new(),
            voice: Mutex::new(VoiceRuntime {
                cfg: VoiceConfig {
                    enabled: false,
                    port: DEFAULT_VOICE_PORT,
                    token: String::new(),
                },
                running: false,
                error: None,
                stop: None,
                task: None,
            }),
            remote: Mutex::new(RemoteRuntime {
                cfg: RemoteConfig {
                    enabled: false,
                    relay_url: DEFAULT_RELAY_URL.to_string(),
                    mac_id: String::new(),
                    mac_token: String::new(),
                    phone_token: String::new(),
                },
                connected: false,
                error: None,
                stop: None,
                task: None,
            }),
        }
    }

    /// Install the front outlet (once, at app setup). Calls made before this
    /// point fail cleanly ("app UI not ready").
    pub fn set_sink(&self, sink: Arc<dyn ToolSink>) {
        let _ = self.sink.set(sink);
    }

    /// Handle one MCP JSON-RPC message for a surface/caller. `None` means the
    /// message was a notification (no response on the wire).
    pub async fn handle_mcp(
        self: &Arc<Self>,
        surface: Surface,
        caller: &Caller,
        message: &Value,
    ) -> Option<Value> {
        router::handle(self, surface, caller, message).await
    }

    /// Execute one tool (already resolved by the router against the surface's
    /// catalogue). Errors are tool-execution errors (→ `isError` result), never
    /// protocol errors.
    pub(crate) async fn execute_tool(
        &self,
        def: &tools::ToolSpec,
        caller: &Caller,
        args: &Value,
    ) -> Result<Value, String> {
        match def.kind {
            tools::ToolKind::Front => {
                let session = match caller {
                    Caller::Session(s) => Some(s.as_str()),
                    Caller::External => None,
                };
                self.call_front(def.name, args, session).await
            }
            tools::ToolKind::WaitForEvents => Ok(self.events.wait_from_args(args).await),
        }
    }

    /// Bridge one tool call to the front executor and await its answer.
    async fn call_front(
        &self,
        tool: &str,
        args: &Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let Some(sink) = self.sink.get() else {
            return Err("the app UI is not ready yet".to_string());
        };
        let request_id = format!("appctl-{}", self.next_req.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("appmcp pending lock")
            .insert(request_id.clone(), tx);
        sink.request(&request_id, tool, args, session);
        match tokio::time::timeout(FRONT_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            // The sender was dropped without answering — the hub was torn down.
            Ok(Err(_)) => Err("the app dropped the request".to_string()),
            Err(_) => {
                // Forget the stale entry so a very late answer is ignored.
                self.pending
                    .lock()
                    .expect("appmcp pending lock")
                    .remove(&request_id);
                Err("the app did not answer in time".to_string())
            }
        }
    }

    /// Complete a bridged call with the front's answer. Returns false when the
    /// request id is unknown (already timed out / already answered) — the IPC
    /// command surfaces that as an error so a wiring bug is never silent.
    pub fn respond(&self, request_id: &str, result: Result<Value, String>) -> bool {
        match self
            .pending
            .lock()
            .expect("appmcp pending lock")
            .remove(request_id)
        {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    /// The voice bridge's current status (config + honest runtime read-back).
    pub fn voice_status(&self) -> VoiceBridgeStatus {
        let v = self.voice.lock().expect("voice lock");
        VoiceBridgeStatus {
            enabled: v.cfg.enabled,
            running: v.running,
            port: v.cfg.port,
            token: v.cfg.token.clone(),
            url: v
                .running
                .then(|| format!("http://127.0.0.1:{}/mcp", v.cfg.port)),
            error: v.error.clone(),
        }
    }

    /// Apply a (new) voice-bridge configuration: stop the running listener if
    /// any, then start one when enabled. The outcome — including a failed bind —
    /// is recorded for [`Self::voice_status`], never thrown away: the Settings
    /// switch must reflect what actually happened.
    pub async fn apply_voice(self: &Arc<Self>, cfg: VoiceConfig) {
        // Stop the previous listener (if any) and store the desired config. The
        // handles are taken OUT of the lock so the await below never holds it.
        let (old_stop, old_task) = {
            let mut v = self.voice.lock().expect("voice lock");
            v.cfg = cfg.clone();
            v.running = false;
            v.error = None;
            (v.stop.take(), v.task.take())
        };
        if let Some(stop) = old_stop {
            let _ = stop.send(true);
        }
        // Await the old accept loop's exit so its listener socket is RELEASED
        // before we bind again — a same-port re-apply (the common case: toggling
        // or rotating the token) would otherwise race straight into EADDRINUSE.
        // Bounded + abort as a backstop: a wedged loop must not hang the toggle.
        if let Some(mut task) = old_task {
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                eprintln!("[appmcp] the previous voice-bridge listener did not stop in time");
            }
        }
        if !cfg.enabled {
            return;
        }
        // Loopback ONLY — the bridge must never listen on a routable interface.
        match tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await {
            Ok(listener) => {
                let (stop_tx, stop_rx) = watch::channel(false);
                let task =
                    tokio::spawn(http::serve(listener, self.clone(), cfg.token.clone(), stop_rx));
                let mut v = self.voice.lock().expect("voice lock");
                v.running = true;
                v.error = None;
                v.stop = Some(stop_tx);
                v.task = Some(task);
            }
            Err(e) => {
                let mut v = self.voice.lock().expect("voice lock");
                v.running = false;
                v.error = Some(format!("could not listen on 127.0.0.1:{}: {e}", cfg.port));
            }
        }
    }

    /// The remote-access relay's current status (Settings read-back): config plus
    /// the honest connection state and the pairing QR/link.
    pub fn remote_status(&self) -> RemoteStatus {
        let r = self.remote.lock().expect("remote lock");
        let pairing = (!r.cfg.mac_id.is_empty() && !r.cfg.phone_token.is_empty())
            .then(|| relay::pairing_url(&r.cfg.relay_url, &r.cfg.mac_id, &r.cfg.phone_token));
        let qr = pairing.as_deref().and_then(relay::qr_svg);
        RemoteStatus {
            enabled: r.cfg.enabled,
            connected: r.connected,
            relay_url: r.cfg.relay_url.clone(),
            mac_id: r.cfg.mac_id.clone(),
            phone_token: r.cfg.phone_token.clone(),
            pairing_url: pairing,
            pairing_qr_svg: qr,
            error: r.error.clone(),
        }
    }

    /// Called by the relay connection loop as the socket connects/drops.
    pub(crate) fn set_remote_connected(&self, connected: bool) {
        let mut r = self.remote.lock().expect("remote lock");
        r.connected = connected;
        if connected {
            r.error = None;
        }
    }

    /// Record the last relay failure (surfaced in [`Self::remote_status`]).
    pub(crate) fn set_remote_error(&self, error: Option<String>) {
        let mut r = self.remote.lock().expect("remote lock");
        r.connected = false;
        r.error = error;
    }

    /// Apply a (new) remote-access configuration: stop the running relay
    /// connection if any, store the config (so the pairing QR is available even
    /// when disabled), then dial out when enabled. The connection loop keeps
    /// `connected`/`error` current for [`Self::remote_status`].
    pub async fn apply_remote(self: &Arc<Self>, cfg: RemoteConfig) {
        let (old_stop, old_task) = {
            let mut r = self.remote.lock().expect("remote lock");
            r.cfg = cfg.clone();
            r.connected = false;
            r.error = None;
            (r.stop.take(), r.task.take())
        };
        if let Some(stop) = old_stop {
            let _ = stop.send(true);
        }
        if let Some(mut task) = old_task {
            if tokio::time::timeout(std::time::Duration::from_secs(3), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        if !cfg.enabled {
            return;
        }
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(relay::serve(self.clone(), cfg, stop_rx));
        let mut r = self.remote.lock().expect("remote lock");
        r.stop = Some(stop_tx);
        r.task = Some(task);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A sink that records requests and lets the test answer them.
    struct RecordingSink {
        seen: Mutex<Vec<(String, String, Value, Option<String>)>>,
    }
    impl ToolSink for RecordingSink {
        fn request(&self, request_id: &str, tool: &str, args: &Value, session: Option<&str>) {
            self.seen.lock().unwrap().push((
                request_id.to_string(),
                tool.to_string(),
                args.clone(),
                session.map(str::to_string),
            ));
        }
    }

    /// ACCEPTANCE: a bridged call reaches the sink with the caller's session and
    /// resolves with the front's answer once `respond` is called.
    #[tokio::test]
    async fn bridged_call_round_trips_through_the_sink() {
        let hub = Arc::new(ControlHub::new());
        let sink = Arc::new(RecordingSink { seen: Mutex::new(Vec::new()) });
        hub.set_sink(sink.clone());

        let def = tools::for_surface(Surface::App)
            .into_iter()
            .find(|t| t.name == "whoami")
            .expect("whoami exists");
        let caller = Caller::Session("session-7".into());
        let hub2 = hub.clone();
        let task = tokio::spawn(async move {
            hub2.execute_tool(&def, &caller, &json!({})).await
        });
        // Wait for the sink to receive the request, then answer it.
        let rid = loop {
            if let Some((rid, tool, _, session)) = sink.seen.lock().unwrap().first().cloned() {
                assert_eq!(tool, "whoami");
                assert_eq!(session.as_deref(), Some("session-7"));
                break rid;
            }
            tokio::task::yield_now().await;
        };
        assert!(hub.respond(&rid, Ok(json!({"conversation_id": "c1"}))));
        let out = task.await.unwrap().unwrap();
        assert_eq!(out["conversation_id"], "c1");
    }

    /// REGRESSION (silent error): answering an unknown / already-settled request
    /// id reports false instead of quietly doing nothing.
    #[tokio::test]
    async fn responding_to_an_unknown_request_reports_false() {
        let hub = ControlHub::new();
        assert!(!hub.respond("appctl-404", Ok(Value::Null)));
    }

    /// REGRESSION (EADDRINUSE): re-applying the SAME port (the token-rotation /
    /// quick-retoggle path) must release the old listener before rebinding —
    /// apply_voice awaits the old accept loop, so this restarts cleanly.
    #[tokio::test]
    async fn re_applying_the_same_port_restarts_cleanly() {
        let hub = Arc::new(ControlHub::new());
        // Discover a free port, then release it for the bridge to claim.
        let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let cfg = |token: &str| VoiceConfig { enabled: true, port, token: token.to_string() };
        hub.apply_voice(cfg("t1")).await;
        assert!(hub.voice_status().running, "first bind: {:?}", hub.voice_status().error);
        hub.apply_voice(cfg("t2")).await;
        let st = hub.voice_status();
        assert!(st.running, "same-port re-apply must not EADDRINUSE: {:?}", st.error);
        assert_eq!(st.token, "t2");
        hub.apply_voice(VoiceConfig { enabled: false, port, token: "t2".to_string() }).await;
        assert!(!hub.voice_status().running);
    }

    /// A call made before the front installed its sink fails cleanly (no hang).
    #[tokio::test]
    async fn call_without_a_sink_errors_immediately() {
        let hub = Arc::new(ControlHub::new());
        let def = tools::for_surface(Surface::App)
            .into_iter()
            .find(|t| t.name == "open_file")
            .unwrap();
        let err = hub
            .execute_tool(&def, &Caller::External, &json!({"path": "x"}))
            .await
            .unwrap_err();
        assert!(err.contains("not ready"));
    }
}
