//! The relay client: the daemon presents itself to the Railway relay as a
//! "mac" node so phones reach it DIRECTLY (no Mac in the data path). Ported
//! from tosse-code appmcp/relay.rs: outbound WS, `authorize_phone` on every
//! (re)connect, single-writer channel, 30 s heartbeat, `_cid` echo on replies,
//! events broadcast without `_cid`, reconnect with 1 s → ×2 → 30 s backoff.
//!
//! Phone access is LIVE: each connect replays the manager's current phone
//! state (tombstones re-revoked, tokens authorized) and then `set_label`; the
//! connection's writer is published in `manager.relay_out` so a phone added or
//! removed mid-connection reaches the relay without a reconnect.
//!
//! Revocations are CONFIRMED (see [`RevokeAcks`]): a tombstone the relay has
//! not confirmed is never evicted and goes out first on every connect.

use crate::config::PushSubscription;
use crate::frames;
use crate::rpc;
use crate::session::{PhoneAccess, SessionManager};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tarmac_e2e::keys::DeviceId;
use tarmac_e2e::handshake::RejectReason;
use tarmac_e2e::node::{Inbound, NodeChannel, SessionRef};
use tarmac_e2e::rand::SystemRandom;
use tarmac_e2e::push;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

/// The relay's `/mac` endpoint for this node. The secret is NOT in it: query
/// strings end up in proxy and edge access logs (see [`relay_request`]).
pub fn ws_url(cfg_relay: &str, mac_id: &str) -> String {
    let base = cfg_relay.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/mac?macId={mac_id}")
}

/// The upgrade request: the macToken travels as `Authorization: Bearer`, which
/// the relay has always read before its `token` query fallback.
pub fn relay_request(cfg_relay: &str, mac_id: &str, mac_token: &str) -> Result<Request> {
    let mut req = ws_url(cfg_relay, mac_id).into_client_request()?;
    let mut auth = HeaderValue::from_str(&format!("Bearer {mac_token}"))?;
    auth.set_sensitive(true);
    req.headers_mut().insert(AUTHORIZATION, auth);
    Ok(req)
}

/// Largest relay message — and frame — the node accepts. The relay refuses
/// anything past 256 KiB itself (`maxPayload`), so this is ample headroom
/// while keeping a broken or hostile relay from making the node buffer up to
/// tungstenite's defaults (64 MiB messages); past it, the link is dropped and
/// re-dialed like any read error.
const MAX_INBOUND_BYTES: usize = 1 << 20;

fn relay_ws_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_INBOUND_BYTES),
        max_frame_size: Some(MAX_INBOUND_BYTES),
        ..WebSocketConfig::default()
    }
}

/// Marks the pings that request a revocation confirmation (then: link id and
/// sequence number, big-endian `u64`s).
const REVOKE_PING_TAG: &[u8; 4] = b"fdrv";

/// Which revocations the relay has confirmed. The relay never acknowledges a
/// `revoke_phone` frame, so each batch of them is followed on the SAME link by
/// a WebSocket ping carrying a sequence number. The relay handles a socket's
/// frames in order, running each frame's handler before it reads the next
/// one, and answers a ping as it reads it: the matching pong proves every
/// revocation queued before that ping was processed. (It can still have been
/// dropped by the relay's rate budget — that is why confirmed tombstones keep
/// being re-sent on every connect, after the unconfirmed ones.)
#[derive(Debug, Default)]
pub struct RevokeAcks {
    /// The current link; bumped on every connect.
    link: u64,
    seq: u64,
    /// (sequence number, token), sent on `link` and not confirmed yet.
    pending: Vec<(u64, String)>,
}

impl RevokeAcks {
    /// A new relay link: whatever awaited confirmation on the previous one
    /// stays unconfirmed — undelivered, so the new link's burst re-sends it.
    pub fn new_link(&mut self) -> u64 {
        self.link += 1;
        self.pending.clear();
        self.link
    }

    pub fn link(&self) -> u64 {
        self.link
    }

    /// Track `tokens`, just queued on `link`; returns the ping payload to
    /// queue right behind them. `None` for an outdated link or no tokens.
    pub fn track(&mut self, link: u64, tokens: Vec<String>) -> Option<Vec<u8>> {
        if link != self.link || tokens.is_empty() {
            return None;
        }
        self.seq += 1;
        self.pending.extend(tokens.into_iter().map(|t| (self.seq, t)));
        let mut ping = REVOKE_PING_TAG.to_vec();
        ping.extend_from_slice(&link.to_be_bytes());
        ping.extend_from_slice(&self.seq.to_be_bytes());
        Some(ping)
    }

    /// A re-authorized token: a confirmation in flight for its earlier revoke
    /// must not count for a later one.
    pub fn forget(&mut self, token: &str) {
        self.pending.retain(|(_, t)| t != token);
    }

    /// A pong from the relay: the tokens it confirms — everything tracked on
    /// this link up to its sequence number. Any other pong confirms nothing.
    pub fn confirm(&mut self, pong: &[u8]) -> Vec<String> {
        let Some(rest) = pong.strip_prefix(REVOKE_PING_TAG.as_slice()) else { return Vec::new() };
        let Ok(ids) = <[u8; 16]>::try_from(rest) else { return Vec::new() };
        let link = u64::from_be_bytes(ids[..8].try_into().expect("8 bytes"));
        let seq = u64::from_be_bytes(ids[8..].try_into().expect("8 bytes"));
        if link != self.link {
            return Vec::new();
        }
        let (done, left): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending).into_iter().partition(|(s, _)| *s <= seq);
        self.pending = left;
        done.into_iter().map(|(_, t)| t).collect()
    }
}

/// rustls 0.23 needs a process-wide crypto provider before the first TLS
/// connect (same fix as tosse-code relay.rs).
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

pub async fn serve(manager: Arc<SessionManager>) {
    ensure_crypto_provider();
    let mut backoff = Duration::from_secs(1);
    loop {
        // `connect_once` only ever returns Err (a healthy connection runs until
        // it breaks) — so the backoff reset keys off whether a connection was
        // actually ESTABLISHED this round, not off the return value.
        let mut was_connected = false;
        if let Err(e) = connect_once(&manager, &mut was_connected).await {
            warn!("relay connection ended: {e:#} — retrying in {backoff:?}");
        }
        if was_connected {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_once(manager: &Arc<SessionManager>, was_connected: &mut bool) -> Result<()> {
    let cfg = &manager.cfg;
    let request = relay_request(&cfg.relay_url, &cfg.mac_id, &cfg.mac_token)?;
    info!("connecting to relay {}", cfg.relay_url);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(request, Some(relay_ws_config()), false).await?;
    *was_connected = true;
    info!("relay connected (macId {})", cfg.mac_id);
    let (mut sink, mut stream) = ws.split();

    // Single writer.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });

    // Publish this link and snapshot the phone access in ONE critical
    // section: a concurrent add/remove then lands live on this link or in the
    // snapshot. The burst replays the snapshot PACED (the relay drops frames
    // past its 60-frame bucket), re-checking every frame against the live
    // state as it goes out — so a phone removed meanwhile is never
    // re-authorized after its live revoke. The guard unpublishes the link
    // however this returns.
    let (_published, keys, link) = {
        let phones = manager.phones.lock().expect("phones lock");
        // Sealed sessions belong to a link: phones handshake again on `welcome`.
        *manager.channel.lock().expect("channel lock") = NodeChannel::new(cfg.mac_id.clone());
        *manager.relay_out.lock().expect("relay_out lock") = Some(out_tx.clone());
        let link = manager.revoke_acks.lock().expect("revoke_acks lock").new_link();
        (RelayOutGuard { manager, tx: out_tx.clone() }, burst_keys(&phones), link)
    };
    let burst = tokio::spawn(send_burst(manager.clone(), out_tx.clone(), keys, cfg.label.clone(), link, BURST_PAUSE));

    // Heartbeat: a dead relay makes the write fail → reconnect.
    let hb = {
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if out_tx.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
        })
    };

    // Events (turn_completed / needs_attention / …): in clear to legacy phones
    // while any is authorized, sealed for each proven sealed session, and as
    // node-sealed Web Pushes for the devices that registered one.
    let events = {
        let out_tx = out_tx.clone();
        let manager = manager.clone();
        let mut rx = manager.events_tx.subscribe();
        tokio::spawn(async move {
            let rng = SystemRandom::new();
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let text = ev.to_frame();
                        if manager.legacy_open() && out_tx.send(Message::Text(text.clone())).is_err() {
                            break;
                        }
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                        {
                            let mut channel = manager.channel.lock().expect("channel lock");
                            for f in channel.seal_broadcast(&frame, wall_clock_ms()) {
                                let _ = out_tx.send(Message::Text(f.to_string()));
                            }
                        }
                        send_pushes(&manager, &out_tx, &frame["event"], &rng);
                        if out_tx.is_closed() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        })
    };

    let result = read_loop(manager, &out_tx, &mut stream).await;
    burst.abort();
    hb.abort();
    events.abort();
    drop(out_tx);
    writer.abort();
    result
}

/// Frames per burst batch, and the pause between batches: the relay allows
/// a node a 60-frame burst refilled at 30/s and SILENTLY drops the rest, and
/// the burst shares that budget with RPC replies and events.
const BURST_BATCH: usize = 20;
const BURST_PAUSE: Duration = Duration::from_secs(1);

/// One frame of the connect burst, resolved against the live phone access
/// only when it goes out.
#[derive(Debug, Clone, PartialEq)]
enum BurstKey {
    Revoke(String),
    Authorize(String),
    /// A sealed-channel device's relay token, by device id.
    AuthorizeDevice(String),
    Label,
}

/// What every (re)connect sends: revocations of the tombstoned tokens the
/// relay has not confirmed (the relay keeps authorizations across reconnects,
/// so a revoke that never landed must be retried), authorizations of the live
/// ones, re-revocations of the confirmed tombstones (a relay that lost recent
/// state re-learns them, without delaying the phones), then the node's label
/// — last.
fn burst_keys(phones: &PhoneAccess) -> Vec<BurstKey> {
    let (confirmed, unconfirmed): (Vec<&String>, Vec<&String>) =
        phones.revoked.iter().partition(|t| phones.delivered.contains(t));
    let mut keys: Vec<BurstKey> = unconfirmed.into_iter().map(|t| BurstKey::Revoke(t.clone())).collect();
    keys.extend(phones.tokens.iter().map(|p| BurstKey::Authorize(p.token.clone())));
    // A device whose keys have all expired can no longer handshake: its relay token
    // is not re-authorized (the Mac purges it, and removes it here, in time).
    let now = frames::now_ms().max(0) as u64;
    keys.extend(
        phones
            .devices
            .iter()
            .filter(|d| d.keys.iter().any(|k| k.expires_at_ms > now))
            .map(|d| BurstKey::AuthorizeDevice(d.device_id.clone())),
    );
    keys.extend(confirmed.into_iter().map(|t| BurstKey::Revoke(t.clone())));
    keys.push(BurstKey::Label);
    keys
}

/// Send the burst in batches of at most BURST_BATCH frames, `pause` apart.
/// Each frame is re-checked against the live phone access under its lock
/// (the same lock live add/remove send under): a token revoked meanwhile is
/// not authorized, a tombstone cleared by a re-add is not revoked, and the
/// current label is used. A batch carrying unconfirmed revocations is
/// followed by their confirmation ping (`link` is this connection's).
async fn send_burst(
    manager: Arc<SessionManager>,
    out: mpsc::UnboundedSender<Message>,
    keys: Vec<BurstKey>,
    label: String,
    link: u64,
    pause: Duration,
) {
    for (i, batch) in keys.chunks(BURST_BATCH).enumerate() {
        if i > 0 {
            tokio::time::sleep(pause).await;
        }
        let phones = manager.phones.lock().expect("phones lock");
        let mut unconfirmed = Vec::new();
        for key in batch {
            let frame = match key {
                BurstKey::Revoke(t) if phones.revoked.contains(t) => {
                    if !phones.delivered.contains(t) {
                        unconfirmed.push(t.clone());
                    }
                    json!({"type": "revoke_phone", "phoneToken": t})
                }
                BurstKey::Authorize(t) => match phones.tokens.iter().find(|p| &p.token == t) {
                    Some(p) => json!({"type": "authorize_phone", "phoneToken": p.token, "label": p.label}),
                    None => continue,
                },
                BurstKey::AuthorizeDevice(id) => match phones.devices.iter().find(|d| &d.device_id == id) {
                    Some(d) => json!({"type": "authorize_phone", "phoneToken": d.relay_token, "label": d.label}),
                    None => continue,
                },
                BurstKey::Label => json!({"type": "set_label", "label": label}),
                BurstKey::Revoke(_) => continue,
            };
            if out.send(Message::Text(frame.to_string())).is_err() {
                return; // the link is gone
            }
        }
        if let Some(ping) = manager.revoke_acks.lock().expect("revoke_acks lock").track(link, unconfirmed) {
            if out.send(Message::Ping(ping)).is_err() {
                return;
            }
        }
    }
}

/// Unpublishes a connection's writer from `manager.relay_out` when the
/// connection ends — including on cancellation — unless a newer one took over.
struct RelayOutGuard<'a> {
    manager: &'a SessionManager,
    tx: mpsc::UnboundedSender<Message>,
}

impl Drop for RelayOutGuard<'_> {
    fn drop(&mut self) {
        let mut slot = self.manager.relay_out.lock().expect("relay_out lock");
        if slot.as_ref().is_some_and(|t| t.same_channel(&self.tx)) {
            *slot = None;
        }
    }
}

/// A pong that confirms revocations: recorded off the read loop (file I/O).
/// Recording can fail (disk full, config lock held too long): the tombstones
/// then simply stay unconfirmed, re-sent first on the next connect.
fn confirm_revocations(manager: &Arc<SessionManager>, pong: &[u8]) {
    let confirmed = manager.revoke_acks.lock().expect("revoke_acks lock").confirm(pong);
    if confirmed.is_empty() {
        return;
    }
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || match manager.mark_revocations_delivered(&confirmed) {
        Ok(_) => info!("relay confirmed {} phone revocation(s)", confirmed.len()),
        Err(e) => warn!(
            "relay confirmed {} phone revocation(s) but recording it failed: {e:#} — they stay pending and are re-sent",
            confirmed.len()
        ),
    });
}

async fn read_loop(
    manager: &Arc<SessionManager>,
    out_tx: &mpsc::UnboundedSender<Message>,
    stream: &mut (impl StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<()> {
    // Read-side liveness: the relay pings every ~30s (tungstenite auto-pongs),
    // so a healthy link ALWAYS delivers something within 90s. A silently-dead
    // TCP path (no FIN) would otherwise leave the daemon "connected" but deaf
    // until the OS gives up on the socket — many minutes.
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(90), stream.next()).await {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(_) => return Err(anyhow!("relay silent for 90s — assuming a dead link")),
        };
        let msg = msg.map_err(|e| anyhow!("relay read: {e}"))?;
        if let Message::Pong(payload) = &msg {
            confirm_revocations(manager, payload);
            continue;
        }
        let Message::Text(raw) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { continue };
        let cid = v.get("_cid").and_then(Value::as_str).map(String::from);
        match v.get("type").and_then(Value::as_str) {
            Some("welcome") => info!("relay welcome as {:?}", v.get("role")),
            Some("error") => warn!("relay error frame: {:?}", v.get("error")),
            Some("ping") => {
                let mut pong = json!({"type": "pong"});
                if let Some(c) = &cid {
                    pong["_cid"] = json!(c);
                }
                let _ = out_tx.send(Message::Text(pong.to_string()));
            }
            Some("e2e_hello") => match &cid {
                Some(c) => on_hello(manager, out_tx, c, &v),
                None => warn!("e2e_hello without a connection id — dropped"),
            },
            Some("e2e") => match &cid {
                Some(c) => on_sealed(manager, out_tx, c, &v),
                None => warn!("sealed frame without a connection id — dropped"),
            },
            Some("phone_left") => {
                if let Some(c) = &cid {
                    manager.channel.lock().expect("channel lock").on_phone_left(c);
                }
            }
            Some("rpc") if !manager.legacy_open() => {
                // No legacy phone is authorized here: a cleartext rpc is either
                // forged by the relay or from a phone that must re-pair.
                let f = tarmac_e2e::node::encryption_required_frame(&v, cid.as_deref());
                warn!("refused a cleartext rpc: no legacy phone is authorized on this node");
                let _ = out_tx.send(Message::Text(f.to_string()));
            }
            Some("rpc") => {
                let id = v.get("id").cloned().unwrap_or(Value::Null);
                let method = v.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                let params = v.get("params").cloned().unwrap_or_else(|| json!({}));
                let manager = manager.clone();
                let out_tx = out_tx.clone();
                tokio::spawn(async move {
                    let reply = match rpc::handle(&manager, &method, &params).await {
                        Ok(result) => {
                            let mut f = json!({"type": "rpc_result", "id": id, "result": result});
                            if let Some(c) = &cid {
                                f["_cid"] = json!(c);
                            }
                            f
                        }
                        Err(e) => {
                            let mut f = json!({"type": "rpc_error", "id": id, "error": e.to_string()});
                            if let Some(c) = &cid {
                                f["_cid"] = json!(c);
                            }
                            f
                        }
                    };
                    let _ = out_tx.send(Message::Text(reply.to_string()));
                });
            }
            _ => {} // subscribe / unsubscribe / anything else: no-op
        }
    }
    Err(anyhow!("relay connection closed"))
}

// -- sealed channel (docs/tarmac-sealed-channel.md) ---------------------------

/// What a sealed `ready` advertises.
const SEALED_CAPS: &[&str] = &["sealed-push", "forget-device"];

fn wall_clock_ms() -> u64 {
    frames::now_ms().max(0) as u64
}

/// Seal `frame` for socket `cid` and queue it — both under the channel lock,
/// so the frames of one session leave in counter order (the phone drops any
/// counter below the last it saw).
///
/// Sealed for `session` — the one the request came in on — or not at all: a socket
/// whose session changed meanwhile never gets another session's answer.
fn send_sealed(
    manager: &SessionManager,
    out: &mpsc::UnboundedSender<Message>,
    cid: &str,
    session: SessionRef,
    frame: &Value,
) {
    let mut channel = manager.channel.lock().expect("channel lock");
    match channel.seal_for(cid, session, frame) {
        Ok(f) => {
            let _ = out.send(Message::Text(f.to_string()));
        }
        Err(e) => {
            // Outside the macro: tracing's own `Value` trait is in scope inside it.
            let kind = frame.get("type").and_then(Value::as_str).unwrap_or("frame");
            warn!("could not seal a {kind} for phone socket {cid}: {e}");
        }
    }
}

/// Tell socket `cid` it has no session here (never opened, or just dropped):
/// the phone handshakes again. Unauthenticated, like every reject.
fn ask_for_handshake(out: &mpsc::UnboundedSender<Message>, cid: &str) {
    let _ = out.send(Message::Text(tarmac_e2e::node::no_session_frame(cid).to_string()));
}

fn on_hello(manager: &SessionManager, out: &mpsc::UnboundedSender<Message>, cid: &str, v: &Value) {
    let Some(device_id) = v.get("d").and_then(Value::as_str).and_then(|d| DeviceId::from_b64(d).ok()) else {
        warn!("malformed e2e_hello on phone socket {cid} — dropped");
        return;
    };
    // Resolved before taking `channel` (lock order: phones, then channel).
    let lookup = manager.device_lookup(&device_id);
    let reply =
        manager.channel.lock().expect("channel lock").on_hello(cid, v, |_| lookup, wall_clock_ms(), Instant::now());
    match reply {
        Ok(mut f) => {
            if f["type"] == "e2e_accept" {
                info!("sealed handshake accepted for device {} (phone socket {cid})", device_id.to_b64());
            } else {
                info!("sealed session refused for device {}: {}", device_id.to_b64(), f["reason"]);
            }
            f["_cid"] = json!(cid);
            let _ = out.send(Message::Text(f.to_string()));
        }
        Err(e) => warn!("malformed e2e_hello on phone socket {cid}: {e} — dropped"),
    }
}

fn on_sealed(manager: &Arc<SessionManager>, out: &mpsc::UnboundedSender<Message>, cid: &str, v: &Value) {
    let inbound = manager.channel.lock().expect("channel lock").on_sealed(cid, v, wall_clock_ms());
    let (device_id, frame, session) = match inbound {
        Inbound::App { device_id, frame, session, first_proof } => {
            if first_proof {
                manager.note_seen(&device_id);
                info!("sealed session proved for device {} (phone socket {cid})", device_id.to_b64());
            }
            (device_id, frame, session)
        }
        Inbound::NoSession => return ask_for_handshake(out, cid),
        Inbound::Expired => {
            info!("sealed session on phone socket {cid} ended: its key expired");
            let _ = out.send(Message::Text(tarmac_e2e::node::to_socket(RejectReason::Expired.to_frame(), cid).to_string()));
            return;
        }
        Inbound::Dropped { error, closed } => {
            let tail = if closed { " — too many failures, session closed (the phone will handshake again)" } else { "" };
            warn!("dropped a sealed frame on phone socket {cid}: {error}{tail}");
            if closed {
                ask_for_handshake(out, cid);
            }
            return;
        }
    };
    match frame.get("type").and_then(Value::as_str) {
        // The phone's first sealed frame: it holds the key. Tell it who we are.
        Some("subscribe") => {
            let g = session.generation;
            let device = manager.device_summary(&device_id, g).map(|(label, issued_at_ms, expires_at_ms)| {
                tarmac_e2e::node::ReadyDevice {
                    label,
                    generation: g,
                    expires_at_ms: i64::try_from(expires_at_ms).unwrap_or(i64::MAX),
                    renew_after_ms: tarmac_e2e::keys::renew_after_ms(g, i64::try_from(issued_at_ms).unwrap_or(i64::MAX)),
                }
            });
            let ready = tarmac_e2e::node::ready_frame(&manager.cfg.label, device.as_ref(), SEALED_CAPS);
            send_sealed(manager, out, cid, session, &ready);
        }
        Some("ping") => send_sealed(manager, out, cid, session, &json!({"type": "pong"})),
        Some("rpc") => {
            tokio::spawn(sealed_rpc(manager.clone(), out.clone(), cid.to_string(), session, device_id, frame));
        }
        _ => {}
    }
}

fn rpc_reply(id: Value, result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"type": "rpc_result", "id": id, "result": result}),
        Err(e) => json!({"type": "rpc_error", "id": id, "error": format!("{e:#}")}),
    }
}

/// A sealed `rpc`: the device-only methods, else the same catalogue as a
/// cleartext phone (`rpc::handle`). The answer goes back sealed.
async fn sealed_rpc(
    manager: Arc<SessionManager>,
    out: mpsc::UnboundedSender<Message>,
    cid: String,
    session: SessionRef,
    device_id: DeviceId,
    frame: Value,
) {
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let device = device_id.to_b64();
    let result = match method.as_str() {
        "forget_device" => {
            // Answered BEFORE the revoke is queued: the relay closes the socket on it.
            let (m, o, c, i) = (manager.clone(), out.clone(), cid.clone(), id.clone());
            let res = tokio::task::spawn_blocking(move || {
                m.remove_device_then(&device, || {
                    send_sealed(&m, &o, &c, session, &json!({"type": "rpc_result", "id": i, "result": {"forgotten": true}}))
                })
            })
            .await;
            match res.map_err(anyhow::Error::from).and_then(|r| r) {
                Ok(true) => return,
                Ok(false) => Err(anyhow!("this device is not paired with this machine")),
                Err(e) => Err(e),
            }
        }
        "push_register" | "push_prefs" | "push_unregister" => {
            let m = manager.clone();
            tokio::task::spawn_blocking(move || push_rpc(&m, &device, &method, &params))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|r| r)
        }
        _ => rpc::handle(&manager, &method, &params).await,
    };
    send_sealed(&manager, &out, &cid, session, &rpc_reply(id, result));
}

/// `push_register {subscription:{endpoint, keys:{p256dh, auth}}, prefs?}`,
/// `push_prefs {prefs}`, `push_unregister {endpoint?}`. Blocking (config file).
fn push_rpc(manager: &SessionManager, device: &str, method: &str, params: &Value) -> Result<Value> {
    let prefs_json = |p: crate::config::PushPrefs| push::PushPrefs::from(p).to_json();
    match method {
        "push_register" => {
            let sub = params.get("subscription").context("subscription is required")?;
            let field = |v: Option<&Value>, what: &str| -> Result<String> {
                Ok(v.and_then(Value::as_str).with_context(|| format!("subscription.{what} is required"))?.to_string())
            };
            let given = params.get("prefs").filter(|p| p.is_object());
            let prefs = push::PushPrefs::default().merged(given.unwrap_or(&Value::Null));
            let record = PushSubscription {
                endpoint: field(sub.get("endpoint"), "endpoint")?,
                p256dh: field(sub.get("keys").and_then(|k| k.get("p256dh")), "keys.p256dh")?,
                auth: field(sub.get("keys").and_then(|k| k.get("auth")), "keys.auth")?,
                prefs: prefs.into(),
            };
            let stored = manager.register_push(device, record, given.is_some())?;
            Ok(json!({"registered": true, "prefs": prefs_json(stored)}))
        }
        "push_prefs" => {
            let prefs = params.get("prefs").filter(|p| p.is_object()).context("prefs is required")?;
            Ok(json!({"prefs": prefs_json(manager.set_push_prefs(device, prefs)?)}))
        }
        _ => {
            let endpoint = params.get("endpoint").and_then(Value::as_str);
            Ok(json!({"removed": manager.unregister_push(device, endpoint)?}))
        }
    }
}

/// Seal `event`'s notification for every subscription that wants its state and
/// hand each to the relay as a `push_send` (the relay adds VAPID and POSTs it;
/// it sees neither the content nor the subscription keys).
fn send_pushes(manager: &SessionManager, out: &mpsc::UnboundedSender<Message>, event: &Value, rng: &SystemRandom) {
    let Some(state) = push::push_state(event) else { return };
    let now = wall_clock_ms();
    for (target, generation, key) in manager.push_targets(state, now) {
        let signer = push::PushSigner { generation, key: &key };
        match push::push_send_frame(&manager.cfg.mac_id, event, state, &target, signer, now, rng) {
            Ok(f) => {
                let _ = out.send(Message::Text(f.to_string()));
            }
            // Never the endpoint (it identifies the device) nor a key.
            Err(e) => warn!("could not seal a {} push for a device: {e}", state.as_str()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The answer to a cleartext `rpc` once no legacy phone is authorized here.
    use tarmac_e2e::node::ENCRYPTION_REQUIRED;

    use crate::config::PhoneToken;
    use tokio::net::TcpListener;

    #[test]
    fn burst_revokes_then_authorizes_then_labels() {
        let phones = PhoneAccess {
            tokens: vec![PhoneToken { token: "a".into(), label: "iPhone".into(), init_minted: false }],
            revoked: vec!["gone".into()],
            ..Default::default()
        };
        assert_eq!(
            burst_keys(&phones),
            vec![BurstKey::Revoke("gone".into()), BurstKey::Authorize("a".into()), BurstKey::Label]
        );
    }

    #[test]
    fn unconfirmed_revocations_lead_the_burst_confirmed_ones_follow_the_phones() {
        let phones = PhoneAccess {
            tokens: vec![PhoneToken { token: "a".into(), label: String::new(), init_minted: false }],
            revoked: vec!["old-ok".into(), "pending".into(), "new-ok".into()],
            delivered: vec!["new-ok".into(), "old-ok".into()],
            devices: vec![],
        };
        assert_eq!(
            burst_keys(&phones),
            vec![
                BurstKey::Revoke("pending".into()),
                BurstKey::Authorize("a".into()),
                BurstKey::Revoke("old-ok".into()),
                BurstKey::Revoke("new-ok".into()),
                BurstKey::Label,
            ]
        );
    }

    fn pong_for(ping: &[u8]) -> Vec<u8> {
        ping.to_vec() // a pong echoes its ping's payload
    }

    #[test]
    fn a_pong_confirms_what_was_tracked_before_its_ping_on_the_same_link() {
        let mut acks = RevokeAcks::default();
        let link = acks.new_link();
        let p1 = acks.track(link, vec!["a".into(), "b".into()]).unwrap();
        let p2 = acks.track(link, vec!["c".into()]).unwrap();
        assert!(acks.track(link, Vec::new()).is_none(), "nothing to confirm, no ping");
        assert_eq!(acks.confirm(&pong_for(&p1)), vec!["a".to_string(), "b".to_string()]);
        assert!(acks.confirm(&pong_for(&p1)).is_empty(), "confirmed once");
        assert_eq!(acks.confirm(&pong_for(&p2)), vec!["c".to_string()]);
        // a later pong also covers what an earlier, lost one would have
        let _p3 = acks.track(link, vec!["d".into()]).unwrap();
        let p4 = acks.track(link, vec!["e".into()]).unwrap();
        assert_eq!(acks.confirm(&pong_for(&p4)), vec!["d".to_string(), "e".to_string()]);
    }

    #[test]
    fn nothing_crosses_links_and_foreign_pongs_confirm_nothing() {
        let mut acks = RevokeAcks::default();
        let old = acks.new_link();
        let p_old = acks.track(old, vec!["a".into()]).unwrap();
        let new = acks.new_link();
        assert!(acks.confirm(&pong_for(&p_old)).is_empty(), "a new link drops the old one's pending");
        assert!(acks.track(old, vec!["late".into()]).is_none(), "an outdated link tracks nothing");
        let p = acks.track(new, vec!["b".into()]).unwrap();
        assert!(acks.confirm(&[]).is_empty(), "the heartbeat's empty pong");
        assert!(acks.confirm(b"fdrv-garbage").is_empty());
        assert_eq!(acks.confirm(&pong_for(&p)), vec!["b".to_string()]);
    }

    #[test]
    fn a_re_authorized_token_is_not_confirmed_by_its_old_revoke() {
        let mut acks = RevokeAcks::default();
        let link = acks.new_link();
        let p1 = acks.track(link, vec!["t".into()]).unwrap();
        acks.forget("t"); // re-added
        let p2 = acks.track(link, vec!["t".into()]).unwrap(); // removed again
        assert!(acks.confirm(&pong_for(&p1)).is_empty());
        assert_eq!(acks.confirm(&pong_for(&p2)), vec!["t".to_string()]);
    }

    fn crowded_manager(revoked: usize, tokens: usize) -> Arc<SessionManager> {
        let m = crate::testutil::test_manager(crate::testutil::test_cfg());
        {
            let mut p = m.phones.lock().unwrap();
            p.revoked = (0..revoked).map(|i| format!("r{i}")).collect();
            p.tokens = (0..tokens)
                .map(|i| PhoneToken { token: format!("t{i}"), label: String::new(), init_minted: false })
                .collect();
        }
        m
    }

    async fn collect_burst(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<(tokio::time::Instant, Value)> {
        let mut got = Vec::new();
        loop {
            let t = match rx.recv().await {
                Some(Message::Text(t)) => t,
                Some(Message::Ping(_)) => continue, // confirmation requests: not relay frames
                _ => panic!("burst ended without set_label"),
            };
            let v: Value = serde_json::from_str(&t).unwrap();
            let done = v["type"] == "set_label";
            got.push((tokio::time::Instant::now(), v));
            if done {
                return got;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_large_burst_never_exceeds_twenty_frames_a_second() {
        let m = crowded_manager(10, 40);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let keys = burst_keys(&m.phones.lock().unwrap());
        let link = m.revoke_acks.lock().unwrap().new_link();
        tokio::spawn(send_burst(m.clone(), tx, keys, "node".into(), link, BURST_PAUSE));
        let got = collect_burst(&mut rx).await;
        assert_eq!(got.len(), 51);
        for (i, (t, _)) in got.iter().enumerate() {
            let in_window = got[i..].iter().take_while(|(u, _)| *u < *t + Duration::from_secs(1)).count();
            assert!(in_window <= BURST_BATCH, "{in_window} frames within 1 s of frame {i}");
        }
        let kinds: Vec<&str> = got.iter().map(|(_, v)| v["type"].as_str().unwrap()).collect();
        assert!(kinds[..10].iter().all(|k| *k == "revoke_phone"));
        assert!(kinds[10..50].iter().all(|k| *k == "authorize_phone"));
        assert_eq!(kinds[50], "set_label");
        // the ten unconfirmed revocations await the relay's pong
        assert_eq!(m.revoke_acks.lock().unwrap().pending.len(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn a_phone_removed_mid_burst_is_not_reauthorized() {
        let m = crowded_manager(0, 30);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let keys = burst_keys(&m.phones.lock().unwrap());
        tokio::spawn(send_burst(m.clone(), tx, keys, "node".into(), 0, BURST_PAUSE));
        for _ in 0..BURST_BATCH {
            rx.recv().await.unwrap(); // first batch: t0..t19
        }
        {
            // during the pause: t25 is revoked live
            let mut p = m.phones.lock().unwrap();
            p.tokens.retain(|t| t.token != "t25");
            p.revoked.push("t25".into());
        }
        let rest = collect_burst(&mut rx).await;
        let tokens: Vec<&str> = rest.iter().filter_map(|(_, v)| v["phoneToken"].as_str()).collect();
        assert!(!tokens.contains(&"t25"), "a revoked phone was re-authorized by a stale burst");
        assert_eq!(tokens.len(), 9);
    }

    /// A minimal relay: accepts /mac websockets and reports every text frame
    /// as (connection number, frame); `drop_tx` closes the current connection.
    /// It answers pings like the real one (tungstenite auto-pongs) — except on
    /// connection `deaf_conn`, which drops the socket on its first
    /// `revoke_phone`, before reading the ping behind it: a revocation that
    /// never gets confirmed.
    async fn mock_relay_with(
        deaf_conn: Option<usize>,
    ) -> (String, mpsc::UnboundedReceiver<(usize, Value)>, mpsc::UnboundedSender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (frames_tx, frames_rx) = mpsc::unbounded_channel();
        let (drop_tx, mut drop_rx) = mpsc::unbounded_channel::<()>();
        tokio::spawn(async move {
            let mut conn = 0;
            while let Ok((tcp, _)) = listener.accept().await {
                conn += 1;
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let welcome = json!({"type": "welcome", "role": "mac"}).to_string();
                ws.send(Message::Text(welcome)).await.unwrap();
                loop {
                    tokio::select! {
                        m = ws.next() => match m {
                            Some(Ok(Message::Text(t))) => {
                                let f: Value = serde_json::from_str(&t).unwrap();
                                let cut = deaf_conn == Some(conn) && f["type"] == "revoke_phone";
                                let _ = frames_tx.send((conn, f));
                                if cut {
                                    break;
                                }
                            }
                            Some(Ok(_)) => {}
                            _ => break,
                        },
                        _ = drop_rx.recv() => break, // drops the socket: the node sees a dead link
                    }
                }
            }
        });
        (url, frames_rx, drop_tx)
    }

    async fn mock_relay() -> (String, mpsc::UnboundedReceiver<(usize, Value)>, mpsc::UnboundedSender<()>) {
        mock_relay_with(None).await
    }

    /// A relay that also forwards frames to the node (as a phone's, `_cid`
    /// included): what the node sends comes out of the receiver.
    async fn phone_relay() -> (String, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedSender<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (from_node_tx, from_node_rx) = mpsc::unbounded_channel();
        let (to_node_tx, mut to_node_rx) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.send(Message::Text(json!({"type": "welcome", "role": "mac"}).to_string())).await.unwrap();
            loop {
                tokio::select! {
                    m = ws.next() => match m {
                        Some(Ok(Message::Text(t))) => {
                            let _ = from_node_tx.send(serde_json::from_str::<Value>(&t).unwrap());
                        }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    f = to_node_rx.recv() => match f {
                        Some(f) => ws.send(Message::Text(f.to_string())).await.unwrap(),
                        None => break,
                    },
                }
            }
        });
        (url, from_node_rx, to_node_tx)
    }

    /// The next frame from the node that is not part of its connect burst.
    async fn reply(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        loop {
            let f = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("no frame from the node").unwrap();
            if f["type"] != "authorize_phone" && f["type"] != "set_label" && f["type"] != "revoke_phone" {
                return f;
            }
        }
    }

    fn with_cid(mut f: Value, cid: &str) -> Value {
        f["_cid"] = json!(cid);
        f
    }

    #[tokio::test]
    async fn a_sealed_phone_drives_the_node_and_cleartext_is_refused() {
        use tarmac_e2e::b64;
        use tarmac_e2e::handshake::{Accept, PhoneHandshake};
        use tarmac_e2e::keys::DeviceSecret;
        use tarmac_e2e::session::Sealed;

        let (url, mut from_node, to_node) = phone_relay().await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::testutil::test_cfg();
        cfg.relay_url = url;
        cfg.devices = vec![crate::testutil::test_device(1, 1)];
        let m = crate::testutil::manager_with_config(dir.path(), cfg);
        let relay = tokio::spawn(serve(m.clone()));
        let rng = SystemRandom::new();

        // The device's relay token is authorized like a phone token.
        loop {
            let f = tokio::time::timeout(Duration::from_secs(10), from_node.recv()).await.unwrap().unwrap();
            if f["type"] == "authorize_phone" {
                assert_eq!(f, json!({"type": "authorize_phone", "phoneToken": "rt-1", "label": "phone 1"}));
                break;
            }
        }

        // No legacy phone here: a cleartext rpc is refused, said in clear.
        to_node.send(json!({"type": "rpc", "id": "x", "method": "ping", "_cid": "c1"})).unwrap();
        assert_eq!(
            reply(&mut from_node).await,
            json!({"type": "rpc_error", "id": "x", "error": ENCRYPTION_REQUIRED, "_cid": "c1"})
        );

        // A sealed frame before any handshake: the node asks for one.
        to_node.send(json!({"type": "e2e", "n": 0, "c": "AAAAAAAAAAAAAAAAAAAAAA", "_cid": "c1"})).unwrap();
        assert_eq!(
            reply(&mut from_node).await,
            json!({"type": "e2e_reject", "v": 1, "reason": "no_session", "_cid": "c1"})
        );

        // Handshake.
        let (hs, hello) = PhoneHandshake::start(DeviceId::from_bytes([1; 16]), 1, &rng).unwrap();
        to_node.send(with_cid(hello.to_frame(), "c1")).unwrap();
        let accept = reply(&mut from_node).await;
        assert_eq!(accept["type"], "e2e_accept");
        assert_eq!(accept["_cid"], "c1");
        let key = DeviceSecret::from_bytes([1; 32]).node_key("m");
        let mut phone_session = hs.finish(&Accept::from_frame(&accept).unwrap(), "m", &key).unwrap();
        let roundtrip = |phone: &mut tarmac_e2e::session::Session, f: Value| {
            to_node.send(with_cid(phone.seal_json(&f).unwrap().to_frame(), "c1")).unwrap();
        };

        // subscribe → ready; then an rpc, answered sealed.
        roundtrip(&mut phone_session, json!({"type": "subscribe"}));
        let f = reply(&mut from_node).await;
        assert_eq!(f["_cid"], "c1");
        let ready = phone_session.open_json(&Sealed::from_frame(&f).unwrap()).unwrap();
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["label"], "test");
        assert_eq!(ready["device"]["label"], "phone 1");
        assert_eq!(ready["device"]["generation"], 1);
        // Generation 1 is the pairing's bootstrap key: due for renewal at once.
        assert_eq!(ready["device"]["renew_after_ms"], 1_000);

        roundtrip(&mut phone_session, json!({"type": "rpc", "id": "r1", "method": "ping", "params": {}}));
        let pong = phone_session.open_json(&Sealed::from_frame(&reply(&mut from_node).await).unwrap()).unwrap();
        assert_eq!(pong["type"], "rpc_result");
        assert_eq!(pong["result"]["pong"], true);

        // A push subscription, then an event: sealed for the session, and a
        // node-sealed push — never in clear (no legacy phone).
        let endpoint = "https://fcm.googleapis.com/fcm/send/abc";
        let sub = json!({"endpoint": endpoint, "keys": {"p256dh": b64::encode(&hello.ephemeral), "auth": b64::encode(&[7u8; 16])}});
        roundtrip(&mut phone_session, json!({"type": "rpc", "id": "r2", "method": "push_register", "params": {"subscription": sub, "prefs": {"review": false}}}));
        let reg = phone_session.open_json(&Sealed::from_frame(&reply(&mut from_node).await).unwrap()).unwrap();
        assert_eq!(reg["result"], json!({"registered": true, "prefs": {"question": true, "error": true, "review": false}}));

        let event = |kind: &str, detail: Value| crate::events::Event {
            conversation_id: "conv-1".into(),
            kind: kind.into(),
            title: Some("t".into()),
            text: Some("Shall I continue?".into()),
            detail,
            at_ms: 1,
        };
        m.events_tx.send(event("turn_completed", json!({"outcome": "success", "open_question": true}))).unwrap();
        let sealed_event = reply(&mut from_node).await;
        let ev = phone_session.open_json(&Sealed::from_frame(&sealed_event).unwrap()).unwrap();
        assert_eq!(ev["type"], "event");
        assert_eq!(ev["event"]["conversationId"], "conv-1");
        let push = reply(&mut from_node).await;
        assert_eq!(push["type"], "push_send");
        assert_eq!(push["endpoint"], tarmac_e2e::push::endpoint_hash(endpoint));
        assert_eq!(push["urgency"], "high");
        assert!(b64::decode(push["body"].as_str().unwrap(), "body").unwrap().len() > 86);
        // The device turned "review" off: a clean finish is sealed for the
        // session but never pushed.
        m.events_tx.send(event("turn_completed", json!({"outcome": "success", "open_question": false}))).unwrap();
        assert_eq!(reply(&mut from_node).await["type"], "e2e");
        to_node.send(json!({"type": "ping", "_cid": "c9"})).unwrap();
        assert_eq!(reply(&mut from_node).await, json!({"type": "pong", "_cid": "c9"}), "no push went out");

        // forget_device: answered sealed BEFORE the revoke, then gone for good.
        roundtrip(&mut phone_session, json!({"type": "rpc", "id": "r3", "method": "forget_device", "params": {}}));
        let mut after = Vec::new();
        while after.len() < 2 {
            let f = tokio::time::timeout(Duration::from_secs(10), from_node.recv()).await.unwrap().unwrap();
            after.push(f);
        }
        let bye = phone_session.open_json(&Sealed::from_frame(&after[0]).unwrap()).unwrap();
        assert_eq!(bye["result"], json!({"forgotten": true}));
        assert_eq!(after[1], json!({"type": "revoke_phone", "phoneToken": "rt-1"}));
        assert!(crate::config::Config::load(&dir.path().join("config.json")).unwrap().devices.is_empty());

        tokio::time::sleep(tarmac_e2e::node::HELLO_INTERVAL).await;
        let (_, hello) = PhoneHandshake::start(DeviceId::from_bytes([1; 16]), 1, &rng).unwrap();
        to_node.send(with_cid(hello.to_frame(), "c1")).unwrap();
        assert_eq!(reply(&mut from_node).await["reason"], "unknown_device");

        relay.abort();
        let _ = relay.await;
    }

    /// Wait (real time) until `f` holds on the manager's live phone access.
    async fn until(m: &SessionManager, what: &str, f: impl Fn(&PhoneAccess) -> bool) {
        for _ in 0..500 {
            if f(&m.phones.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<(usize, Value)>) -> (usize, Value) {
        tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("no frame from the node").unwrap()
    }

    /// Frames until (and including) the connection's set_label.
    async fn burst(rx: &mut mpsc::UnboundedReceiver<(usize, Value)>) -> (usize, Vec<Value>) {
        let mut frames = Vec::new();
        loop {
            let (conn, f) = next(rx).await;
            let done = f["type"] == "set_label";
            frames.push(f);
            if done {
                return (conn, frames);
            }
        }
    }

    #[tokio::test]
    async fn phone_access_is_live_and_replayed_on_every_connect() {
        let (url, mut frames, drop_conn) = mock_relay().await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::testutil::test_cfg();
        cfg.relay_url = url;
        cfg.label = "node-x".into();
        cfg.phone_tokens = vec![PhoneToken { token: "seed".into(), label: "old".into(), init_minted: false }];
        cfg.revoked_phone_tokens = vec!["gone".into()];
        let m = crate::testutil::manager_with_config(dir.path(), cfg);
        let relay = tokio::spawn(serve(m.clone()));

        let (c1, b1) = burst(&mut frames).await;
        assert_eq!(
            b1,
            vec![
                json!({"type": "revoke_phone", "phoneToken": "gone"}),
                json!({"type": "authorize_phone", "phoneToken": "seed", "label": "old"}),
                json!({"type": "set_label", "label": "node-x"}),
            ]
        );
        // The relay's pong confirms the burst's revocation.
        until(&m, "the burst's revocation to be confirmed", |p| p.delivered == ["gone"]).await;

        // Mid-connection changes reach the relay on the SAME connection.
        let m2 = m.clone();
        assert!(tokio::task::spawn_blocking(move || m2.add_phone_token("pt-live", "Pixel")).await.unwrap().unwrap());
        assert_eq!(next(&mut frames).await, (c1, json!({"type": "authorize_phone", "phoneToken": "pt-live", "label": "Pixel"})));
        let m2 = m.clone();
        assert!(tokio::task::spawn_blocking(move || m2.remove_phone_token("seed")).await.unwrap().unwrap());
        assert_eq!(next(&mut frames).await, (c1, json!({"type": "revoke_phone", "phoneToken": "seed"})));
        until(&m, "the live revocation to be confirmed", |p| p.delivered.len() == 2).await;
        let disk = crate::config::Config::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(disk.delivered_phone_revocations, vec!["gone".to_string(), "seed".to_string()]);

        // A new connection replays the CURRENT state, set_label exactly once;
        // the confirmed revocations are re-asserted after the phones.
        drop_conn.send(()).unwrap();
        let (c2, b2) = burst(&mut frames).await;
        assert_eq!(c2, c1 + 1);
        assert_eq!(
            b2,
            vec![
                json!({"type": "authorize_phone", "phoneToken": "pt-live", "label": "Pixel"}),
                json!({"type": "revoke_phone", "phoneToken": "gone"}),
                json!({"type": "revoke_phone", "phoneToken": "seed"}),
                json!({"type": "set_label", "label": "node-x"}),
            ]
        );
        assert!(m.relay_out.lock().unwrap().is_some());

        relay.abort();
        let _ = relay.await;
        assert!(m.relay_out.lock().unwrap().is_none(), "a dead link stayed published");
    }

    #[tokio::test]
    async fn an_unconfirmed_revocation_survives_the_link_and_goes_out_first() {
        // Connection 1 dies right after the live revoke, before the relay
        // could answer its confirmation ping.
        let (url, mut frames, _drop) = mock_relay_with(Some(1)).await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::testutil::test_cfg();
        cfg.relay_url = url;
        cfg.phone_tokens = vec![
            PhoneToken { token: "lost".into(), label: String::new(), init_minted: false },
            PhoneToken { token: "kept".into(), label: String::new(), init_minted: false },
        ];
        let m = crate::testutil::manager_with_config(dir.path(), cfg);
        let relay = tokio::spawn(serve(m.clone()));
        let (c1, _) = burst(&mut frames).await;

        let m2 = m.clone();
        assert!(tokio::task::spawn_blocking(move || m2.remove_phone_token("lost")).await.unwrap().unwrap());
        assert_eq!(next(&mut frames).await, (c1, json!({"type": "revoke_phone", "phoneToken": "lost"})));

        // The reconnect leads with it, and THIS relay confirms it.
        let (c2, b2) = burst(&mut frames).await;
        assert_eq!(c2, c1 + 1);
        assert_eq!(
            b2,
            vec![
                json!({"type": "revoke_phone", "phoneToken": "lost"}),
                json!({"type": "authorize_phone", "phoneToken": "kept", "label": ""}),
                json!({"type": "set_label", "label": "test"}),
            ]
        );
        until(&m, "the re-sent revocation to be confirmed", |p| p.delivered == ["lost"]).await;
        let disk = crate::config::Config::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(disk.delivered_phone_revocations, vec!["lost".to_string()]);
        relay.abort();
    }

    #[test]
    fn ws_url_upgrades_scheme_and_carries_no_secret() {
        assert_eq!(ws_url("https://relay.example.app/", "m1"), "wss://relay.example.app/mac?macId=m1");
        assert_eq!(ws_url("http://localhost:8080", "m"), "ws://localhost:8080/mac?macId=m");
        let req = relay_request("https://relay.example.app", "m1", "s3cret").unwrap();
        assert_eq!(req.uri().to_string(), "wss://relay.example.app/mac?macId=m1");
        assert_eq!(req.headers()[AUTHORIZATION], "Bearer s3cret");
        assert!(req.headers()[AUTHORIZATION].is_sensitive());
    }

    #[tokio::test]
    async fn the_upgrade_request_authenticates_by_header_not_query() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = crate::testutil::test_cfg();
        cfg.relay_url = format!("http://{}", listener.local_addr().unwrap());
        cfg.mac_id = "node-1".into();
        cfg.mac_token = "mac-secret".into();
        let m = crate::testutil::test_manager(cfg);
        let relay = tokio::spawn(serve(m));
        let (tcp, _) = listener.accept().await.unwrap();
        let (seen_tx, seen_rx) = std::sync::mpsc::channel();
        let callback = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                             resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let auth = req.headers().get(AUTHORIZATION).map(|v| v.to_str().unwrap().to_string());
            seen_tx.send((req.uri().to_string(), auth)).unwrap();
            Ok(resp)
        };
        let _ws = tokio_tungstenite::accept_hdr_async(tcp, callback).await.unwrap();
        let (uri, auth) = seen_rx.recv().unwrap();
        assert_eq!(uri, "/mac?macId=node-1");
        assert_eq!(auth.as_deref(), Some("Bearer mac-secret"));
        relay.abort();
    }

    #[tokio::test]
    async fn an_oversized_relay_message_drops_the_link() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = crate::testutil::test_cfg();
        cfg.relay_url = format!("http://{}", listener.local_addr().unwrap());
        let m = crate::testutil::test_manager(cfg);
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            // Under the cap: handled (the node answers the ping)...
            let fits = json!({"type": "ping", "_cid": "c", "pad": "x".repeat(MAX_INBOUND_BYTES - 1024)});
            ws.send(Message::Text(fits.to_string())).await.unwrap();
            let pong = loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) if t.contains("\"pong\"") => break t,
                    Some(Ok(_)) => continue,
                    other => panic!("link lost before the pong: {other:?}"),
                }
            };
            // ...over it: the node hangs up instead of buffering it.
            let _ = ws.send(Message::Text("x".repeat(MAX_INBOUND_BYTES + 1))).await;
            (pong, ws.next().await)
        });
        let mut was_connected = false;
        let err = tokio::time::timeout(Duration::from_secs(10), connect_once(&m, &mut was_connected))
            .await
            .expect("the node kept an oversized message")
            .unwrap_err();
        assert!(was_connected);
        assert!(err.to_string().contains("too long"), "{err:#}");
        let (pong, _) = server.await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&pong).unwrap(), json!({"type": "pong", "_cid": "c"}));
    }
}
