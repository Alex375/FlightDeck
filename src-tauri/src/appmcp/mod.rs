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

pub mod devices;
pub mod events;
pub mod http;
pub mod device_provision;
pub mod provision;
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

/// How long a Settings rotation waits for the relay's `mac_token_rotated`.
const ROTATION_TIMEOUT: Duration = Duration::from_secs(10);

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

/// The hub's outlet for "a phone token's `{type:"revoke_phone"}` frame was just
/// written to a live, CONNECTED relay socket" — the trigger for durably
/// forgetting it from `Store::pending_relay_phone_revocations` (C10's critical
/// fix). Implemented over `Store::clear_relay_phone_revocation` in
/// `ipc::events` (kept as a trait for the same reason as [`ToolSink`]: this
/// module stays free of Tauri/Store types — `RemoteConfig`'s doc: "the hub
/// never touches the store").
///
/// This exists because the FIRST version of the critical fix cleared the
/// durable queue the moment `ControlHub::apply_remote` merely *spawned* a
/// reconnect task — before the socket even connected, let alone sent the
/// frame — so an app restart or a superseding `set_remote` call (a label
/// edit, a second regenerate) could silently drop the queued revocation
/// forever, reproducing the exact bug this fix exists to close. Routing the
/// "actually sent" moment through this sink (called from
/// [`relay::connect_once`]) closes that window: the row survives until a live
/// socket has genuinely carried the frame.
pub trait RevocationSink: Send + Sync {
    fn relay_revocation_sent(&self, token: &str);
}

/// The hub's outlet for "the relay now authenticates this Mac with `current`" — the moment
/// a token rotation is settled (acknowledged, or proven by a connect with the next token),
/// or abandoned (`next` kept as `None`). Persists both tokens through the store's sealed
/// secrets; implemented in `ipc::events`, like [`RevocationSink`].
pub trait MacTokenSink: Send + Sync {
    fn persist_mac_tokens(&self, current: &str, next: Option<&str>) -> Result<(), String>;
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

/// This Mac's default node display name (C11 decision) — shown in a paired
/// phone's node list (`{type:"set_label"}`, PROTOCOL.md §4) until the user
/// renames it in Settings → Control → Remote access.
pub const DEFAULT_MAC_LABEL: &str = "This Mac";

/// Live state of the outbound remote-access relay connection, for the Settings
/// UI. Honest read-back: `connected` reflects the actual socket, `error` the last
/// failure. `pairing_url` / `pairing_qr_svg` are what a phone scans to pair.
///
/// ⚠️ The raw phone token is deliberately NOT a field (L12): this struct is read by
/// the webview every 2.5 s, and the front only ever needs the pairing link (Copy
/// link) and its QR — exposing the bare credential on every status read added
/// nothing but exposure.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub connected: bool,
    pub relay_url: String,
    pub mac_id: String,
    /// This Mac's node display name (C11), as sent to the relay via `set_label`.
    pub mac_label: String,
    /// The LEGACY (unencrypted, shared-token) pairing link and QR — `None` once
    /// that pairing is retired. Sealed-channel devices are paired one by one
    /// (`pair_remote_device`), never through this.
    pub pairing_url: Option<String>,
    pub pairing_qr_svg: Option<String>,
    pub error: Option<String>,
    /// The legacy shared token is still in use: this Mac (and any server holding
    /// it) still takes cleartext phone frames, which the relay could forge.
    pub legacy_active: bool,
    /// The relay REFUSED this Mac's credentials (another token holds its identity there):
    /// retrying with the same token can't succeed, so it is retried only every few minutes.
    pub refused: bool,
    /// The relay link is up and its relay rotates mac tokens (`welcome.caps`).
    pub can_rotate: bool,
    /// A token rotation is under way: the next token is saved, the relay has not confirmed it.
    pub rotation_pending: bool,
    /// This Mac's remote-access secrets are sealed with a keychain key that is gone: only
    /// a reset of remote access (`reset_remote_secrets`) gets out.
    pub secrets_lost: bool,
}

/// Desired remote-access configuration (persisted in SQLite `meta` by the IPC
/// layer; the hub never touches the store).
#[derive(Debug, Clone)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub relay_url: String,
    pub mac_id: String,
    pub mac_token: String,
    /// The token a rotation is moving to, until the relay confirms it — kept across
    /// restarts: if the relay took it but the answer was lost, `mac_token` is refused and
    /// this one is tried (see `relay::dial`).
    pub mac_token_next: Option<String>,
    pub phone_token: String,
    /// Why the secrets above could not be read (the keychain key is unavailable): the
    /// relay is then never dialed — the tokens are empty, NOT freshly minted ones.
    pub secrets_error: Option<String>,
    /// That key is GONE (see [`RemoteStatus::secrets_lost`]).
    pub secrets_lost: bool,
    /// This Mac's node display name (C11) — sent as `{type:"set_label"}` right
    /// after the authorize burst on every (re)connect (see
    /// `relay::post_connect_frames`).
    pub mac_label: String,
    /// Phone tokens still awaiting `{type:"revoke_phone"}` on THIS Mac's own relay
    /// connection (C10's critical fix: a regenerated pairing must forget the OLD
    /// token, not just mint a new one). Loaded fresh from
    /// [`crate::store::Store::pending_relay_phone_revocations`] every time this
    /// config is built, and sent — best-effort, the wire has no delivery ack — on
    /// every (re)connect until `Store::clear_relay_phone_revocation` drops them.
    pub revoke_phone_tokens: Vec<String>,
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
    /// `error` is the relay refusing this Mac's credentials (see [`RemoteStatus::refused`]).
    refused: bool,
    /// The live link's `welcome.caps` — `None` until the relay welcomed it.
    caps: Option<Vec<String>>,
    /// Fleet events up to this cursor reached the relay (confirmed by a pong). Survives
    /// reconnects and restarts of the link, so a drop never loses an event; `None` while
    /// remote access is off — turning it back on starts from the journal's present.
    event_cursor: Option<u64>,
    stop: Option<watch::Sender<bool>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// The app-control hub: pending front-bridge calls, the fleet event journal and
/// the voice-bridge runtime. One per app, shared with every session actor
/// (`Arc`) and managed as Tauri state for the IPC commands.
pub struct ControlHub {
    sink: OnceLock<Arc<dyn ToolSink>>,
    revocation_sink: OnceLock<Arc<dyn RevocationSink>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_req: AtomicU64,
    pub events: events::EventJournal,
    voice: Mutex<VoiceRuntime>,
    remote: Mutex<RemoteRuntime>,
    /// Phones paired on the sealed channel (see [`devices`]). Lock order:
    /// `remote`, then `devices`, then `channel`, then `remote_out`.
    devices: Mutex<Vec<devices::LiveDevice>>,
    /// The sealed sessions of the current relay link, one per phone socket.
    /// Reset on every connect. Frames are sealed AND queued under this lock, so a
    /// session's counters leave in order.
    channel: Mutex<tarmac_e2e::node::NodeChannel>,
    /// The live relay link's single-writer queue (`None` while offline), for
    /// authorizations and revocations sent mid-connection.
    remote_out: Mutex<Option<tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>>>,
    device_sink: OnceLock<Arc<dyn devices::DeviceSink>>,
    mac_token_sink: OnceLock<Arc<dyn MacTokenSink>>,
    /// The Settings call waiting for the relay's `mac_token_rotated`.
    rotation_waiter: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
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
            revocation_sink: OnceLock::new(),
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
                    mac_token_next: None,
                    phone_token: String::new(),
                    secrets_error: None,
                    secrets_lost: false,
                    mac_label: DEFAULT_MAC_LABEL.to_string(),
                    revoke_phone_tokens: Vec::new(),
                },
                connected: false,
                error: None,
                refused: false,
                caps: None,
                event_cursor: None,
                stop: None,
                task: None,
            }),
            devices: Mutex::new(Vec::new()),
            channel: Mutex::new(tarmac_e2e::node::NodeChannel::new(String::new())),
            remote_out: Mutex::new(None),
            device_sink: OnceLock::new(),
            mac_token_sink: OnceLock::new(),
            rotation_waiter: Mutex::new(None),
        }
    }

    /// Install the front outlet (once, at app setup). Calls made before this
    /// point fail cleanly ("app UI not ready").
    pub fn set_sink(&self, sink: Arc<dyn ToolSink>) {
        let _ = self.sink.set(sink);
    }

    /// Install the [`RevocationSink`] (once, at app setup — mirrors
    /// [`Self::set_sink`]).
    pub fn set_revocation_sink(&self, sink: Arc<dyn RevocationSink>) {
        let _ = self.revocation_sink.set(sink);
    }

    /// Install the [`MacTokenSink`] (once, at app setup).
    pub fn set_mac_token_sink(&self, sink: Arc<dyn MacTokenSink>) {
        let _ = self.mac_token_sink.set(sink);
    }

    /// Called by [`relay::connect_once`] once the relay answered the ping sent
    /// behind a `revoke_phone` frame for `token` on a connected socket — never
    /// merely because a reconnect task was spawned, or the frame written. The
    /// token leaves the durable queue and this run's list. A missing sink (a
    /// relay reconnect racing app setup, vanishingly unlikely) is logged and
    /// otherwise harmless: the token stays queued and is simply sent — and
    /// this called again — on the next connect.
    pub(crate) fn notify_relay_revocation_sent(&self, token: &str) {
        match self.revocation_sink.get() {
            Some(sink) => {
                sink.relay_revocation_sent(token);
                self.remote.lock().expect("remote lock").cfg.revoke_phone_tokens.retain(|t| t != token);
            }
            None => eprintln!(
                "[appmcp] relay revocation sent before the revocation sink was installed; will resend on next connect"
            ),
        }
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
            mac_label: r.cfg.mac_label.clone(),
            pairing_url: pairing,
            pairing_qr_svg: qr,
            error: r.error.clone(),
            legacy_active: relay::legacy_open(&r.cfg),
            refused: r.refused,
            can_rotate: r.connected && relay::rotates_mac_token(r.caps.as_deref()),
            rotation_pending: r.cfg.mac_token_next.is_some(),
            secrets_lost: r.cfg.secrets_lost,
        }
    }

    /// The relay welcomed this link (its credentials are accepted), with its `caps`.
    pub(crate) fn set_remote_welcomed(&self, caps: Vec<String>) {
        let mut r = self.remote.lock().expect("remote lock");
        r.connected = true;
        r.error = None;
        r.refused = false;
        r.caps = Some(caps);
    }

    /// The link dropped (or never came up).
    pub(crate) fn set_remote_disconnected(&self) {
        let mut r = self.remote.lock().expect("remote lock");
        r.connected = false;
        r.caps = None;
    }

    /// Record the last relay failure (surfaced in [`Self::remote_status`]); `refused`: the
    /// relay refused this Mac's credentials.
    pub(crate) fn set_remote_error(&self, error: Option<String>, refused: bool) {
        let mut r = self.remote.lock().expect("remote lock");
        r.connected = false;
        r.caps = None;
        r.error = error;
        r.refused = refused;
    }

    /// The token this Mac connects with, and the one a rotation is moving to.
    pub(crate) fn mac_tokens(&self) -> (String, Option<String>) {
        let r = self.remote.lock().expect("remote lock");
        (r.cfg.mac_token.clone(), r.cfg.mac_token_next.clone())
    }

    /// Where the relay link's event pump starts: just past the last event the relay
    /// confirmed (the journal's present when none was ever sent).
    pub(crate) fn relay_event_cursor(&self) -> u64 {
        let latest = self.events.latest_cursor();
        let mut r = self.remote.lock().expect("remote lock");
        *r.event_cursor.get_or_insert(latest)
    }

    /// The relay answered a ping sent behind the events up to `cursor`: they reached it.
    pub(crate) fn confirm_relay_event_cursor(&self, cursor: u64) {
        let mut r = self.remote.lock().expect("remote lock");
        if r.cfg.enabled {
            r.event_cursor = Some(r.event_cursor.map_or(cursor, |c| c.max(cursor)));
        }
    }

    /// The relay now authenticates this Mac with `token`: it becomes THE token, the
    /// rotation (if any) is over. Persisted through the [`MacTokenSink`]; a failed write
    /// is logged and harmless — the next token stays saved, and the next connect, refused
    /// with the old one, proves the new one and settles it again.
    pub(crate) fn settle_mac_token(&self, token: &str) {
        {
            let mut r = self.remote.lock().expect("remote lock");
            r.cfg.mac_token = token.to_string();
            r.cfg.mac_token_next = None;
        }
        self.persist_mac_tokens(token, None);
    }

    fn persist_mac_tokens(&self, current: &str, next: Option<&str>) {
        match self.mac_token_sink.get() {
            Some(sink) => {
                if let Err(e) = sink.persist_mac_tokens(current, next) {
                    eprintln!("[relay] could not save this Mac's relay token: {e} — settled again at the next connect");
                }
            }
            None => eprintln!("[relay] mac token sink not installed; this Mac's relay token is not saved"),
        }
    }

    /// The relay answered `rotate_mac_token`. `ok`: it holds the next token now — settle
    /// it. Refused (an unfit token, which this app never mints): the rotation is dropped.
    /// Either way the waiting Settings call, if any, hears it.
    pub(crate) fn on_mac_token_rotated(&self, ok: bool, error: Option<String>) {
        let (current, next) = self.mac_tokens();
        let outcome = match (ok, next) {
            (true, Some(next)) => {
                self.settle_mac_token(&next);
                Ok(())
            }
            // Nothing under way: a duplicate answer. Nothing to change.
            (true, None) => Ok(()),
            (false, next) => {
                if next.is_some() {
                    self.remote.lock().expect("remote lock").cfg.mac_token_next = None;
                    self.persist_mac_tokens(&current, None);
                }
                let why = error.unwrap_or_else(|| "no reason given".into());
                eprintln!("[relay] the relay refused the new mac token: {why}");
                Err(format!("The relay refused the new token: {why}"))
            }
        };
        if let Some(waiter) = self.rotation_waiter.lock().expect("rotation lock").take() {
            let _ = waiter.send(outcome);
        }
    }

    /// Send the pending rotation (if any) on the live link — at each welcome, so a rotation
    /// whose answer was lost, or that was started while the link was down, completes.
    pub(crate) fn resume_mac_token_rotation(&self) {
        let (_, next) = self.mac_tokens();
        let rotates = relay::rotates_mac_token(self.remote.lock().expect("remote lock").caps.as_deref());
        if let (Some(next), true) = (next, rotates) {
            if let Some(out) = self.remote_out.lock().expect("remote_out lock").as_ref() {
                let _ = out.send(relay::rotate_frame(&next));
            }
        }
    }

    /// Rotate this Mac's relay token to `next` — which the caller has ALREADY saved as the
    /// next token, so that a relay that takes it while its answer is lost never locks this
    /// Mac out. Needs a live link to a relay that rotates; resolves on the relay's answer.
    pub(crate) async fn rotate_mac_token(&self, next: String) -> Result<(), String> {
        let out = {
            let r = self.remote.lock().expect("remote lock");
            if !r.connected {
                return Err("This Mac is not connected to the relay — rotate once it is.".into());
            }
            if !relay::rotates_mac_token(r.caps.as_deref()) {
                return Err("This relay can't rotate a Mac's token yet — update it (flightdeck-remote).".into());
            }
            self.remote_out.lock().expect("remote_out lock").clone().ok_or("The relay link just dropped — try again.")?
        };
        let (tx, rx) = oneshot::channel();
        *self.rotation_waiter.lock().expect("rotation lock") = Some(tx);
        self.remote.lock().expect("remote lock").cfg.mac_token_next = Some(next.clone());
        if out.send(relay::rotate_frame(&next)).is_err() {
            self.rotation_waiter.lock().expect("rotation lock").take();
            return Err("The relay link just dropped — the rotation completes at the next connection.".into());
        }
        match tokio::time::timeout(ROTATION_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => outcome,
            _ => {
                self.rotation_waiter.lock().expect("rotation lock").take();
                Err("The relay did not confirm the new token in time — the rotation completes at the next connection."
                    .into())
            }
        }
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
            r.refused = false;
            r.caps = None;
            // Off: forget where the event pump was. On: keep it (a restart of the link —
            // a label edit — must not drop or replay anything), or start from now.
            r.event_cursor = if cfg.enabled { Some(r.event_cursor.unwrap_or_else(|| self.events.latest_cursor())) } else { None };
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
        // Secrets that won't open (keychain key unavailable): say why, never dial with the
        // empty tokens the config then holds.
        if let Some(e) = cfg.secrets_error.clone() {
            self.set_remote_error(Some(e), false);
            return;
        }
        // I5: never dial a relay URL that would carry the mac token and every phone
        // RPC unencrypted to another host (a value stored before this check existed,
        // or written to the database directly). Say why instead of retrying forever.
        if let Err(e) = relay::check_relay_url(&cfg.relay_url) {
            self.set_remote_error(Some(e), false);
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

    /// A [`RevocationSink`] that just records every token it was told about.
    struct RecordingRevocationSink {
        seen: Mutex<Vec<String>>,
    }
    impl RevocationSink for RecordingRevocationSink {
        fn relay_revocation_sent(&self, token: &str) {
            self.seen.lock().unwrap().push(token.to_string());
        }
    }

    /// Review-fix coverage: once a [`RevocationSink`] is installed,
    /// `notify_relay_revocation_sent` reaches it (verbatim token, no
    /// transformation) — the path `relay::connect_once` drives after actually
    /// sending a `revoke_phone` frame.
    #[test]
    fn notify_relay_revocation_sent_reaches_the_installed_sink() {
        let hub = ControlHub::new();
        let sink = Arc::new(RecordingRevocationSink { seen: Mutex::new(Vec::new()) });
        hub.set_revocation_sink(sink.clone());

        hub.notify_relay_revocation_sent("old-token-1");
        hub.notify_relay_revocation_sent("old-token-2");

        assert_eq!(*sink.seen.lock().unwrap(), vec!["old-token-1", "old-token-2"]);
    }

    /// REGRESSION (silent error, inverse direction): calling
    /// `notify_relay_revocation_sent` before a sink is installed must not
    /// panic — a relay reconnect that (implausibly) races app setup degrades to
    /// "resend next connect", never a crash.
    #[test]
    fn notify_relay_revocation_sent_without_a_sink_does_not_panic() {
        let hub = ControlHub::new();
        hub.notify_relay_revocation_sent("old-token");
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

    /// `apply_voice`, plus — on Linux only — a short retry while the port reads as in use.
    ///
    /// Linux spawns a child as fork → exec, and the child holds a copy of every fd open at
    /// the fork until its exec closes them (`CLOEXEC`). Another test spawning a process just
    /// then keeps a listener we have already dropped alive for a few ms, and a same-port
    /// bind sees EADDRINUSE. macOS spawns atomically (`posix_spawn`), so there this never
    /// retries and the regression below stays strict on the platform CI gates on.
    async fn apply_voice_settled(hub: &Arc<ControlHub>, cfg: VoiceConfig) {
        hub.apply_voice(cfg.clone()).await;
        #[cfg(target_os = "linux")]
        for _ in 0..20 {
            let in_use = hub
                .voice_status()
                .error
                .is_some_and(|e| e.contains("Address already in use"));
            if !in_use {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            hub.apply_voice(cfg.clone()).await;
        }
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
        apply_voice_settled(&hub, cfg("t1")).await;
        assert!(hub.voice_status().running, "first bind: {:?}", hub.voice_status().error);
        apply_voice_settled(&hub, cfg("t2")).await;
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

    fn remote_cfg(relay_url: &str) -> RemoteConfig {
        RemoteConfig {
            enabled: true,
            relay_url: relay_url.to_string(),
            mac_id: "mac1".into(),
            mac_token: "mactok".into(),
            mac_token_next: None,
            phone_token: "phonetok".into(),
            secrets_error: None,
            secrets_lost: false,
            mac_label: DEFAULT_MAC_LABEL.into(),
            revoke_phone_tokens: Vec::new(),
        }
    }

    /// I5: a stored unencrypted relay URL on another host is never dialed — the status
    /// says why (and no reconnect loop is left running).
    #[tokio::test]
    async fn apply_remote_refuses_an_unencrypted_remote_relay_and_says_why() {
        let hub = Arc::new(ControlHub::new());
        hub.apply_remote(remote_cfg("http://relay.example.app")).await;
        let st = hub.remote_status();
        assert!(st.enabled && !st.connected);
        assert!(st.error.as_deref().unwrap_or_default().contains("not encrypted"), "{:?}", st.error);
        assert!(hub.remote.lock().unwrap().task.is_none(), "nothing was spawned to dial it");
    }

    /// Secrets that won't open are never dialed with: the status says why.
    #[tokio::test]
    async fn apply_remote_with_unreadable_secrets_never_dials() {
        let hub = Arc::new(ControlHub::new());
        let mut c = remote_cfg("https://relay.example.app");
        c.mac_token = String::new();
        c.secrets_error = Some("the keychain is locked".into());
        hub.apply_remote(c).await;
        let st = hub.remote_status();
        assert_eq!(st.error.as_deref(), Some("the keychain is locked"));
        assert!(!st.connected && !st.refused);
        assert!(hub.remote.lock().unwrap().task.is_none(), "nothing was spawned to dial it");
    }

    /// The relay link's event cursor survives a restart of the link (a label edit), is
    /// forgotten when access is turned off, and starts from the journal's present when it
    /// is turned on — never replaying what happened while it was off.
    #[tokio::test]
    async fn the_event_cursor_survives_a_link_restart_and_resets_when_access_is_off() {
        let hub = Arc::new(ControlHub::new());
        // A refused (unencrypted) URL: nothing is dialed, the cursor logic still runs.
        let mut c = remote_cfg("http://relay.example.app");
        hub.events.publish("turn_completed", "c1", "t", Value::Null);
        hub.apply_remote(c.clone()).await;
        assert_eq!(hub.relay_event_cursor(), 1, "on: from the present");
        hub.events.publish("turn_completed", "c2", "t", Value::Null);
        hub.apply_remote(c.clone()).await;
        assert_eq!(hub.relay_event_cursor(), 1, "a restart keeps it: event 2 is still owed");
        hub.confirm_relay_event_cursor(2);
        assert_eq!(hub.relay_event_cursor(), 2);
        hub.confirm_relay_event_cursor(1);
        assert_eq!(hub.relay_event_cursor(), 2, "never backwards");
        c.enabled = false;
        hub.apply_remote(c.clone()).await;
        assert!(hub.remote.lock().unwrap().event_cursor.is_none());
        hub.events.publish("turn_completed", "c3", "t", Value::Null);
        c.enabled = true;
        hub.apply_remote(c).await;
        assert_eq!(hub.relay_event_cursor(), 3, "back on: from the present, not what happened while off");
    }

    /// L12: the status carries the pairing link and QR, never the bare phone token
    /// as a field of its own.
    #[test]
    fn remote_status_exposes_the_pairing_link_but_not_the_raw_token_field() {
        let hub = ControlHub::new();
        hub.remote.lock().unwrap().cfg = remote_cfg("https://relay.example.app");
        let st = serde_json::to_value(hub.remote_status()).unwrap();
        assert_eq!(st["pairing_url"], "https://relay.example.app/#macId=mac1&pt=phonetok");
        assert!(st["pairing_qr_svg"].as_str().is_some_and(|s| s.starts_with("<svg")));
        assert!(st.get("phone_token").is_none(), "{st}");
    }
}
