//! Outbound WebSocket "relay" transport — the phone-access counterpart of the
//! loopback [`super::http`] voice bridge. Instead of LISTENING, the app DIALS OUT
//! to a cloud relay and authenticates as a "mac"; the relay forwards a paired
//! phone's RPC frames to us and our replies + pushed events back. This lets a
//! phone reach the app from anywhere (off the local network) with nothing to
//! install but a web app, and no inbound port on the Mac.
//!
//! Everything flows through the SAME hub pipeline as the voice bridge: an inbound
//! `rpc` frame resolves a tool on [`Surface::Voice`] (the safe, conversation-
//! centric subset — the blacklist is enforced by the surface) and runs it via
//! [`ControlHub::execute_tool`], which bridges to the front executor exactly like
//! any other transport. Only the transport is new here; no tool logic is copied.
//!
//! Wire (see the flightdeck-remote `PROTOCOL.md`, the shared contract):
//! - We connect to `wss://<relay>/mac?macId=<id>` with `Authorization: Bearer
//!   <macToken>` on the upgrade (PROTOCOL.md §2; the relay has always read the
//!   header first and `?token=` only as a fallback) — the secret stays out of the
//!   URL, which proxies and edge logs record.
//! - We tell the relay which phone token is allowed: `{type:"authorize_phone", phoneToken}`.
//! - We publish this Mac's node display name: `{type:"set_label", label}` (C11) —
//!   sent right after the authorize burst on every (re)connect, per PROTOCOL.md §4
//!   ("idempotent — send it after each welcome").
//! - We flush any phone token still awaiting revocation on THIS connection:
//!   `{type:"revoke_phone", phoneToken}` (C10's critical fix — a regenerated
//!   pairing must forget the OLD token, not just authorize the new one). See
//!   [`post_connect_frames`] and `RemoteConfig::revoke_phone_tokens`'s doc.
//! - Phone → us: `{type:"rpc", id, method, params, _cid}` (`_cid` = the relay's
//!   ephemeral phone connection id, echoed back so the reply is routed to the
//!   right phone), plus `{type:"ping", _cid}`.
//! - Us → phone: `{type:"rpc_result"|"rpc_error", id, _cid, ...}`, `{type:"pong", _cid}`,
//!   and `{type:"event", event}` (fleet events from [`super::events`], broadcast).

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use tarmac_e2e::keys::DeviceId;
use tarmac_e2e::node::{Inbound, NodeChannel};
use tarmac_e2e::rand::SystemRandom;
use tarmac_e2e::{b64, push, webpush};

use super::devices::{now_ms, LivePush};
use super::{tools, Caller, ControlHub, RemoteConfig, Surface};

/// Largest relay message (and frame) we accept. The relay caps what a phone may send
/// at 256 KiB per frame (`MAX_PAYLOAD`) and only adds its routing stamp before
/// forwarding, so 1 MiB is ample headroom — while tungstenite's default (64 MiB a
/// message) would let a hostile relay make us buffer that much per frame.
const MAX_RELAY_MESSAGE_BYTES: usize = 1024 * 1024;

/// Phone RPCs one connection runs at once. Each holds a task (and possibly a 30 s
/// front-bridge wait) — without a cap, a relay could spawn work without limit. The
/// PWA issues its calls one user action at a time, so 16 is far above real use; an
/// RPC past the cap is answered at once with [`RPC_BUSY_ERROR`].
const MAX_INFLIGHT_RPCS: usize = 16;

/// The `rpc_error` an RPC gets when [`MAX_INFLIGHT_RPCS`] are already running.
const RPC_BUSY_ERROR: &str = "busy: too many requests in progress on this Mac, try again";

/// Install the process-wide rustls crypto provider (ring) once before the first
/// TLS handshake. Mirrors the app's reqwest path; idempotent — if another caller
/// already installed a default, this is a harmless no-op.
fn ensure_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Check a relay base URL before it is stored or dialed (I5). The relay sees this
/// Mac's secret and every phone RPC, so it is only reached over TLS (`https://` /
/// `wss://`); plain `http://` / `ws://` is accepted for a relay on this very machine
/// (`localhost`, `127.0.0.1`, `::1` — a loopback address), i.e. local development,
/// and refused for any other host. The `Err` is the user-facing explanation.
pub(crate) fn check_relay_url(base: &str) -> Result<(), String> {
    let b = base.trim();
    let (encrypted, rest) = if let Some(rest) = b.strip_prefix("https://").or_else(|| b.strip_prefix("wss://")) {
        (true, rest)
    } else if let Some(rest) = b.strip_prefix("http://").or_else(|| b.strip_prefix("ws://")) {
        (false, rest)
    } else {
        return Err(format!("The relay URL must start with https:// or wss:// (got \"{b}\")."));
    };
    let host = url_host(rest);
    if host.is_empty() {
        return Err(format!("The relay URL has no host (got \"{b}\")."));
    }
    if encrypted || is_loopback_host(host) {
        Ok(())
    } else {
        Err(format!(
            "Not connecting: the relay URL \"{b}\" is not encrypted. Use https:// or wss:// \
             (plain http:// or ws:// is only allowed for a relay on this Mac, e.g. localhost)."
        ))
    }
}

/// The host of a URL's remainder after `scheme://`: the authority (up to the first
/// `/`, `?` or `#`), minus any `user@` part and `:port`, with an IPv6 literal's
/// brackets removed.
fn url_host(after_scheme: &str) -> &str {
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(v6) = host_port.strip_prefix('[') {
        return v6.split(']').next().unwrap_or("");
    }
    host_port.split(':').next().unwrap_or("")
}

/// `localhost` or a loopback IP literal — the only hosts an unencrypted relay URL
/// may name.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Build the `wss://…/mac?macId=…` control URL from the stored relay base (an
/// http(s) or ws(s) origin, vetted by [`check_relay_url`]). `mac_id` is a uuid, so it
/// needs no escaping. The mac token is NOT in the URL — see [`mac_upgrade_request`].
fn to_ws_url(base: &str, mac_id: &str) -> Result<String, String> {
    check_relay_url(base)?;
    let b = base.trim().trim_end_matches('/');
    let ws = if let Some(rest) = b.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = b.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        b.to_string()
    };
    Ok(format!("{ws}/mac?macId={mac_id}"))
}

/// The `/mac` upgrade request (L1): the URL carries only the mac id, and the mac token
/// travels as `Authorization: Bearer <token>` — a header, unlike a query string, is
/// not written to proxy/edge access logs. PROTOCOL.md §2 documents both forms and the
/// relay has read the header first since its first version, so no relay predates it.
fn mac_upgrade_request(base: &str, mac_id: &str, mac_token: &str) -> Result<Request, String> {
    let mut request = to_ws_url(base, mac_id)?
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let bearer = HeaderValue::from_str(&format!("Bearer {mac_token}"))
        .map_err(|_| "the stored mac token is not a valid header value".to_string())?;
    request.headers_mut().insert(AUTHORIZATION, bearer);
    Ok(request)
}

/// Inbound limits for the relay socket (L11) — see [`MAX_RELAY_MESSAGE_BYTES`].
fn relay_ws_config() -> WebSocketConfig {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_RELAY_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_RELAY_MESSAGE_BYTES);
    config
}

/// The deep link a phone scans to pair: the relay's HTTPS origin plus the mac id
/// and phone token in the URL FRAGMENT (never sent to the server, never logged).
pub(crate) fn pairing_url(base: &str, mac_id: &str, phone_token: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    format!("{b}/#macId={mac_id}&pt={phone_token}")
}

/// The sealed-channel pairing link (`docs/tarmac-sealed-channel.md` §3.1): the
/// issuer's mac id, the device id, its relay token (`rt`, renamed from `pt` so an
/// outdated PWA refuses the link instead of pairing in clear), its master secret
/// (`k`) and key generation (`g`) — all in the FRAGMENT, never sent to a server.
pub(crate) fn pairing_url_v2(
    base: &str,
    mac_id: &str,
    device_id: &str,
    relay_token: &str,
    secret: &str,
    generation: u32,
) -> String {
    let b = base.trim().trim_end_matches('/');
    format!("{b}/#v=2&macId={mac_id}&d={device_id}&rt={relay_token}&k={secret}&g={generation}")
}

/// Render `data` as a minimal, dependency-light inline SVG QR code (no `image`
/// crate). A white quiet-zone border plus one 1×1 rect per dark module; the
/// `viewBox` lets the front scale it to any size. `None` if the data is too long
/// for a QR code.
pub(crate) fn qr_svg(data: &str) -> Option<String> {
    use qrcode::types::Color;
    let code = qrcode::QrCode::new(data.as_bytes()).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    let quiet = 4usize;
    let dim = width + quiet * 2;
    let mut rects = String::new();
    for y in 0..width {
        for x in 0..width {
            if matches!(colors[y * width + x], Color::Dark) {
                rects.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\"/>",
                    x + quiet,
                    y + quiet
                ));
            }
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" \
         shape-rendering=\"crispEdges\"><rect width=\"{dim}\" height=\"{dim}\" fill=\"#fff\"/>\
         <g fill=\"#000\">{rects}</g></svg>"
    ))
}

/// Dial the relay and keep the connection up, reconnecting with capped backoff
/// until `stop` flips. `connected`/`error` on the hub's remote runtime track the
/// live socket for the Settings read-back.
pub(crate) async fn serve(hub: Arc<ControlHub>, cfg: RemoteConfig, mut stop: watch::Receiver<bool>) {
    let mut backoff = Duration::from_secs(1);
    while !*stop.borrow() {
        match connect_once(&hub, &cfg, &mut stop, &mut backoff).await {
            Ok(()) => return, // graceful stop
            Err(e) => hub.set_remote_error(Some(e)),
        }
        if *stop.borrow() {
            return;
        }
        tokio::select! {
            _ = stop.changed() => {}
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// The frames sent immediately after connecting, before any phone RPC / event
/// pumping begins — in order: authorize the current phone token, publish this
/// Mac's node label (C11), then flush every phone token still awaiting revocation
/// on this connection (C10's critical fix). Pure so the exact shape/order is
/// unit-tested without a live socket; [`connect_once`] sends each of these in
/// turn and, for a `revoke_phone` frame specifically, only reports it to
/// [`ControlHub::notify_relay_revocation_sent`] once THAT frame's own
/// `write.send().await` actually succeeded on this live, connected socket —
/// never merely because a reconnect task was spawned (see that method's doc
/// for the bug this closes). `authorize_phone`/`set_label` stay pure
/// fire-and-forget either way — neither has a delivery ack on the wire
/// (PROTOCOL.md §4), and re-sending them on the next reconnect is harmless
/// (idempotent).
pub(crate) fn post_connect_frames(cfg: &RemoteConfig, device_tokens: &[(String, String)]) -> Vec<Value> {
    let mut frames = Vec::new();
    // The legacy shared token, until the user retires it (an empty token = retired).
    if !cfg.phone_token.is_empty() {
        frames.push(json!({ "type": "authorize_phone", "phoneToken": cfg.phone_token }));
    }
    // Every sealed-channel device's own relay token.
    frames.extend(
        device_tokens
            .iter()
            .map(|(token, label)| json!({ "type": "authorize_phone", "phoneToken": token, "label": label })),
    );
    frames.push(json!({ "type": "set_label", "label": cfg.mac_label }));
    frames.extend(
        cfg.revoke_phone_tokens
            .iter()
            .map(|token| json!({ "type": "revoke_phone", "phoneToken": token })),
    );
    frames
}

/// `Some(token)` when `frame` is a `{type:"revoke_phone", phoneToken}` frame —
/// what [`connect_once`] checks after each successful send to know whether to
/// call [`ControlHub::notify_relay_revocation_sent`]. Pulled out as its own
/// pure function (rather than inlined in the send loop) purely so the
/// "which frames trigger the durable clear" logic is unit-tested without a
/// live socket, same spirit as [`post_connect_frames`] itself.
fn revoke_token_from_frame(frame: &Value) -> Option<&str> {
    if frame.get("type").and_then(Value::as_str) != Some("revoke_phone") {
        return None;
    }
    frame.get("phoneToken").and_then(Value::as_str)
}

/// One connection lifetime: connect, authorize our phone token, then pump phone
/// RPCs (dispatched concurrently through the hub), fleet events, and a heartbeat
/// until the socket drops or `stop` flips. Returns `Ok(())` only on a requested
/// stop; any socket failure is `Err` so [`serve`] reconnects.
async fn connect_once(
    hub: &Arc<ControlHub>,
    cfg: &RemoteConfig,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<(), String> {
    ensure_crypto_provider();
    let request = mac_upgrade_request(&cfg.relay_url, &cfg.mac_id, &cfg.mac_token)?;
    let (ws, _resp) = tokio_tungstenite::connect_async_with_config(request, Some(relay_ws_config()), false)
        .await
        .map_err(|e| e.to_string())?;
    // Connected: reset backoff so the NEXT unexpected drop reconnects promptly.
    *backoff = Duration::from_secs(1);
    hub.set_remote_connected(true);
    // Sealed sessions belong to a link: phones handshake again on `welcome`.
    *hub.channel.lock().expect("channel lock") = NodeChannel::new(cfg.mac_id.clone());

    let (mut write, mut read) = ws.split();
    // Authorize the current phone pairing token, publish this Mac's node label, and
    // flush any revocation still owed — see `post_connect_frames`'s doc. A
    // `revoke_phone` frame is reported to the hub — which durably clears it
    // from `pending_relay_phone_revocations` — ONLY once its own send actually
    // succeeded on THIS connected socket, never merely because this function
    // was reached (that was the bug: `ipc::commands::set_remote` used to clear
    // the queue the instant `apply_remote` had merely SPAWNED a reconnect
    // attempt, before it had even dialed, let alone sent anything).
    for frame in post_connect_frames(cfg, &hub.device_relay_tokens()) {
        let sent = write.send(Message::Text(frame.to_string())).await.is_ok();
        if sent {
            if let Some(token) = revoke_token_from_frame(&frame) {
                hub.notify_relay_revocation_sent(token);
            }
        }
    }

    // A single writer drains this channel, so RPC replies, event pushes and the
    // heartbeat can all write to the socket without sharing the sink.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if write.send(m).await.is_err() {
                break;
            }
        }
    });
    // Published for authorizations/revocations made mid-connection (pairing or
    // revoking a device in Settings); unpublished when this link ends.
    *hub.remote_out.lock().expect("remote_out lock") = Some(out_tx.clone());
    // Cleartext only while the legacy shared token is in use (see `legacy_open`).
    let legacy = legacy_open(cfg);

    // Push fleet events (turn finished / needs attention) to the phone(s): in clear
    // only while the legacy token is in use, sealed for every proven sealed
    // session, and as node-sealed Web Pushes for the devices that registered one.
    let events_task = {
        let hub = hub.clone();
        let out = out_tx.clone();
        let mut stop = stop.clone();
        let mac_id = cfg.mac_id.clone();
        tokio::spawn(async move {
            let rng = SystemRandom::new();
            let mut cursor = hub.events.latest_cursor();
            loop {
                if *stop.borrow() {
                    break;
                }
                let (next, evs) = tokio::select! {
                    _ = stop.changed() => { if *stop.borrow() { break; } else { continue; } }
                    r = hub.events.wait(cursor, Duration::from_secs(25)) => r,
                };
                cursor = next;
                for e in evs {
                    // Shape per PROTOCOL.md §5 ({conversationId, kind, text, at}) — the
                    // relay constructs this frame, so it owns matching the contract the
                    // PWA reads. `text` is a best-effort preview from the journal detail.
                    let text = e
                        .detail
                        .get("last_assistant_text")
                        .or_else(|| e.detail.get("prompt"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| e.title.clone());
                    let frame = json!({
                        "type": "event",
                        "event": {
                            "conversationId": e.conversation_id,
                            "kind": e.kind,
                            "title": e.title,
                            "text": text,
                            "at": e.at_ms,
                            "detail": e.detail,
                        }
                    });
                    if legacy && out.send(Message::Text(frame.to_string())).is_err() {
                        return;
                    }
                    {
                        let mut channel = hub.channel.lock().expect("channel lock");
                        for f in channel.seal_broadcast(&frame) {
                            let _ = out.send(Message::Text(f.to_string()));
                        }
                    }
                    send_pushes(&hub, &out, &mac_id, &frame["event"], &rng);
                    if out.is_closed() {
                        return;
                    }
                }
            }
        })
    };

    // Keepalive: a dead relay makes the write/read error out and we reconnect.
    let heartbeat = {
        let out = out_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if out.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
        })
    };

    // Phone RPCs running at once on this connection (L11) — see `MAX_INFLIGHT_RPCS`.
    let rpc_slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
    let result = loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break Ok(()); }
            }
            msg = read.next() => match msg {
                Some(Ok(Message::Text(txt))) => on_phone_frame(hub, &out_tx, &rpc_slots, legacy, txt),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => break Err("relay connection closed".to_string()),
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e.to_string()),
            },
        }
    };

    hub.set_remote_connected(false);
    {
        let mut slot = hub.remote_out.lock().expect("remote_out lock");
        if slot.as_ref().is_some_and(|t| t.same_channel(&out_tx)) {
            *slot = None;
        }
    }
    events_task.abort();
    heartbeat.abort();
    drop(out_tx);
    writer.abort();
    result
}

/// Route one inbound relay text frame. `rpc` frames are dispatched on their own
/// task (a tool call can await the front executor for up to 30 s — never block
/// the read loop), at most [`MAX_INFLIGHT_RPCS`] at a time: past that, the RPC is
/// answered `busy` right away instead of queueing work; `ping` is answered
/// immediately.
fn on_phone_frame(
    hub: &Arc<ControlHub>,
    out_tx: &mpsc::UnboundedSender<Message>,
    rpc_slots: &Arc<Semaphore>,
    legacy: bool,
    txt: String,
) {
    let Ok(msg) = serde_json::from_str::<Value>(&txt) else {
        return;
    };
    let cid = msg.get("_cid").and_then(Value::as_str).map(str::to_string);
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
        "e2e_hello" => match cid {
            Some(cid) => on_hello(hub, out_tx, &cid, &msg),
            None => eprintln!("[relay] e2e_hello without a connection id — dropped"),
        },
        "e2e" => match cid {
            Some(cid) => on_sealed(hub, out_tx, rpc_slots, &cid, &msg),
            None => eprintln!("[relay] sealed frame without a connection id — dropped"),
        },
        "phone_left" => {
            if let Some(cid) = cid {
                hub.channel.lock().expect("channel lock").on_phone_left(&cid);
            }
        }
        // The legacy token is retired: a cleartext rpc is either forged by the relay
        // or from a phone that must re-pair. Refused, said in clear.
        "rpc" if !legacy => {
            let frame = json!({
                "type": "rpc_error",
                "id": msg.get("id").cloned().unwrap_or(Value::Null),
                "_cid": msg.get("_cid").cloned().unwrap_or(Value::Null),
                "error": ENCRYPTION_REQUIRED,
            });
            eprintln!("[relay] refused a cleartext rpc: the legacy pairing is retired");
            let _ = out_tx.send(Message::Text(frame.to_string()));
        }
        "rpc" => {
            let Ok(slot) = rpc_slots.clone().try_acquire_owned() else {
                let frame = json!({
                    "type": "rpc_error",
                    "id": msg.get("id").cloned().unwrap_or(Value::Null),
                    "_cid": msg.get("_cid").cloned().unwrap_or(Value::Null),
                    "error": RPC_BUSY_ERROR,
                });
                let _ = out_tx.send(Message::Text(frame.to_string()));
                return;
            };
            let hub = hub.clone();
            let out = out_tx.clone();
            tokio::spawn(async move {
                dispatch_rpc(&hub, &out, msg).await;
                drop(slot);
            });
        }
        "ping" => {
            let cid = msg.get("_cid").cloned().unwrap_or(Value::Null);
            let _ = out_tx.send(Message::Text(
                json!({ "type": "pong", "_cid": cid }).to_string(),
            ));
        }
        // `subscribe`/`unsubscribe`: events are broadcast to all our phones in v1.
        _ => {}
    }
}

/// Execute one phone RPC through the hub and reply. Only tools on
/// [`Surface::Voice`] are reachable — an unknown/withheld method is refused,
/// which is how the mobile blacklist (no permission changes, deletes, rewind…)
/// is enforced.
async fn dispatch_rpc(hub: &Arc<ControlHub>, out: &mpsc::UnboundedSender<Message>, msg: Value) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let cid = msg.get("_cid").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let mut frame = rpc_reply(id, run_phone_tool(hub, method, &params).await);
    frame["_cid"] = cid;
    let _ = out.send(Message::Text(frame.to_string()));
}

/// A phone RPC on [`Surface::Voice`] — the same catalogue, cleartext or sealed.
async fn run_phone_tool(hub: &Arc<ControlHub>, method: &str, params: &Value) -> Result<Value, String> {
    let def = tools::for_surface(Surface::Voice).into_iter().find(|t| t.name == method);
    match def {
        Some(def) => hub.execute_tool(&def, &Caller::External, params).await,
        None => Err(format!("unknown or unavailable method: {method}")),
    }
}

fn rpc_reply(id: Value, result: Result<Value, String>) -> Value {
    match result {
        Ok(v) => json!({ "type": "rpc_result", "id": id, "result": v }),
        Err(e) => json!({ "type": "rpc_error", "id": id, "error": e }),
    }
}

// -- sealed channel (docs/tarmac-sealed-channel.md) -----------------------------

/// The answer to a cleartext `rpc` once the legacy pairing is retired.
pub(crate) const ENCRYPTION_REQUIRED: &str =
    "this machine only accepts encrypted connections — re-pair your phone";

/// What this Mac's sealed `ready` advertises. Only the issuer renews keys.
const SEALED_CAPS: &[&str] = &["sealed-push", "forget-device", "renew-device"];

/// How long a push service keeps an undelivered notification.
const PUSH_TTL_SECS: u64 = 600;

/// Whether this Mac still takes cleartext phone frames: only while the legacy
/// shared token is in use. Retiring it (an empty token) closes the cleartext path.
pub(crate) fn legacy_open(cfg: &RemoteConfig) -> bool {
    !cfg.phone_token.is_empty()
}

/// Seal `frame` for socket `cid` and queue it, both under the channel lock (a
/// session's counters must leave in order: the phone drops a counter below the
/// last it saw).
fn send_sealed(hub: &ControlHub, out: &mpsc::UnboundedSender<Message>, cid: &str, frame: &Value) {
    let mut channel = hub.channel.lock().expect("channel lock");
    match channel.seal_for(cid, frame) {
        Ok(f) => {
            let _ = out.send(Message::Text(f.to_string()));
        }
        Err(e) => {
            let kind = frame.get("type").and_then(Value::as_str).unwrap_or("frame");
            eprintln!("[relay] could not seal a {kind} for phone socket {cid}: {e}");
        }
    }
}

/// Tell socket `cid` it has no session here (never opened, or just dropped):
/// the phone handshakes again. Unauthenticated, like every reject.
fn ask_for_handshake(out: &mpsc::UnboundedSender<Message>, cid: &str) {
    let mut f = tarmac_e2e::handshake::RejectReason::NoSession.to_frame();
    f["_cid"] = json!(cid);
    let _ = out.send(Message::Text(f.to_string()));
}

fn on_hello(hub: &ControlHub, out: &mpsc::UnboundedSender<Message>, cid: &str, msg: &Value) {
    match hub.on_device_hello(cid, msg) {
        Ok((mut reply, accepted)) => {
            if let Some(device_id) = accepted {
                if let Ok(sink) = hub.device_sink() {
                    sink.device_seen(&device_id.to_b64(), now_ms());
                }
            } else {
                eprintln!("[relay] sealed session refused on phone socket {cid}: {}", reply["reason"]);
            }
            reply["_cid"] = json!(cid);
            let _ = out.send(Message::Text(reply.to_string()));
        }
        Err(e) => eprintln!("[relay] {e} on phone socket {cid} — dropped"),
    }
}

fn on_sealed(
    hub: &Arc<ControlHub>,
    out: &mpsc::UnboundedSender<Message>,
    rpc_slots: &Arc<Semaphore>,
    cid: &str,
    msg: &Value,
) {
    let inbound = hub.channel.lock().expect("channel lock").on_sealed(cid, msg);
    let (device_id, frame) = match inbound {
        Inbound::App { device_id, frame } => (device_id, frame),
        Inbound::NoSession => return ask_for_handshake(out, cid),
        Inbound::Dropped { error, closed } => {
            let tail = if closed { " — too many failures, session closed (the phone will handshake again)" } else { "" };
            eprintln!("[relay] dropped a sealed frame on phone socket {cid}: {error}{tail}");
            if closed {
                ask_for_handshake(out, cid);
            }
            return;
        }
    };
    match frame.get("type").and_then(Value::as_str) {
        // The phone's first sealed frame: it holds the key. Tell it who we are.
        Some("subscribe") => {
            let generation = hub.channel.lock().expect("channel lock").generation_of(cid);
            let key = generation.and_then(|g| hub.device_key(&device_id, g));
            let label = hub.remote.lock().expect("remote lock").cfg.mac_label.clone();
            let ready = json!({
                "type": "ready",
                "label": label,
                "device": {
                    "label": key.as_ref().map(|(l, _)| l.clone()),
                    "generation": generation,
                    "expires_at_ms": key.as_ref().map(|(_, k)| k.expires_at_ms),
                    "renew_after_ms": key.as_ref().map(|(_, k)| k.renew_after_ms()),
                },
                "caps": SEALED_CAPS,
            });
            send_sealed(hub, out, cid, &ready);
        }
        Some("ping") => send_sealed(hub, out, cid, &json!({ "type": "pong" })),
        Some("rpc") => {
            let Ok(slot) = rpc_slots.clone().try_acquire_owned() else {
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                send_sealed(hub, out, cid, &rpc_reply(id, Err(RPC_BUSY_ERROR.to_string())));
                return;
            };
            let (hub, out, cid) = (hub.clone(), out.clone(), cid.to_string());
            tokio::spawn(async move {
                sealed_rpc(&hub, &out, &cid, device_id, frame).await;
                drop(slot);
            });
        }
        _ => {}
    }
}

/// A sealed `rpc`: the device-only methods, else the phone catalogue. Answered sealed.
async fn sealed_rpc(hub: &Arc<ControlHub>, out: &mpsc::UnboundedSender<Message>, cid: &str, device_id: DeviceId, frame: Value) {
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let device = device_id.to_b64();
    let result = match method.as_str() {
        "forget_device" => match hub.device_sink().and_then(|s| s.forget_device(&device)) {
            Ok(()) => {
                // Answered BEFORE the revoke: the relay closes the socket on it.
                send_sealed(hub, out, cid, &rpc_reply(id, Ok(json!({ "forgotten": true }))));
                hub.remove_device_live(&device);
                return;
            }
            Err(e) => Err(e),
        },
        "renew_device" => renew_device(hub, &device),
        "push_register" | "push_prefs" | "push_unregister" => push_rpc(hub, &device, &method, &params),
        _ => run_phone_tool(hub, &method, &params).await,
    };
    send_sealed(hub, out, cid, &rpc_reply(id, result));
}

/// `renew_device {}`: the next key generation once the current one is due for
/// renewal (`renew_after_ms`), else the current one unchanged (`renewed:false`).
fn renew_device(hub: &ControlHub, device: &str) -> Result<Value, String> {
    let current = hub.newest_device_key(device).ok_or("this device is not paired with this Mac")?;
    if now_ms() < current.renew_after_ms() {
        return Ok(json!({
            "renewed": false,
            "generation": current.generation,
            "expires_at_ms": current.expires_at_ms,
            "renew_after_ms": current.renew_after_ms(),
        }));
    }
    let next = hub.device_sink()?.renew_device(device)?;
    hub.add_device_key_live(device, next.clone());
    Ok(json!({
        "renewed": true,
        "generation": next.generation,
        "secret": next.secret.to_b64(),
        "issued_at_ms": next.issued_at_ms,
        "expires_at_ms": next.expires_at_ms,
        "renew_after_ms": next.renew_after_ms(),
    }))
}

/// `push_register {subscription:{endpoint, keys:{p256dh, auth}}, prefs?}`,
/// `push_prefs {prefs}`, `push_unregister {endpoint?}` — persisted through the
/// sink first, then applied to the live book.
fn push_rpc(hub: &ControlHub, device: &str, method: &str, params: &Value) -> Result<Value, String> {
    let sink = hub.device_sink()?;
    match method {
        "push_register" => {
            let push = parse_push_subscription(params)?;
            sink.register_push(device, &push)?;
            let prefs = push.prefs;
            hub.edit_device_push(device, |subs| {
                subs.retain(|s| s.endpoint != push.endpoint);
                subs.push(push);
            });
            Ok(json!({ "registered": true, "prefs": prefs.to_json() }))
        }
        "push_prefs" => {
            let given = params.get("prefs").filter(|p| p.is_object()).ok_or("prefs is required")?;
            let base = hub
                .devices()
                .into_iter()
                .find(|d| d.device_id == device)
                .and_then(|d| d.push.first().map(|p| p.prefs))
                .unwrap_or_default();
            let prefs = base.merged(given);
            sink.set_push_prefs(device, prefs)?;
            hub.edit_device_push(device, |subs| subs.iter_mut().for_each(|s| s.prefs = prefs));
            Ok(json!({ "prefs": prefs.to_json() }))
        }
        _ => {
            let endpoint = params.get("endpoint").and_then(Value::as_str);
            let removed = sink.unregister_push(device, endpoint)?;
            hub.edit_device_push(device, |subs| subs.retain(|s| endpoint.is_some_and(|e| e != s.endpoint)));
            Ok(json!({ "removed": removed }))
        }
    }
}

/// Validate a phone's push subscription: an https endpoint, an uncompressed P-256
/// `p256dh` and a 16-byte `auth` (base64url, padding tolerated, stored unpadded).
pub(crate) fn parse_push_subscription(params: &Value) -> Result<LivePush, String> {
    let sub = params.get("subscription").ok_or("subscription is required")?;
    let text = |v: Option<&Value>, what: &str| -> Result<String, String> {
        v.and_then(Value::as_str).map(|s| s.trim_end_matches('=').to_string()).ok_or(format!("subscription.{what} is required"))
    };
    let endpoint = sub.get("endpoint").and_then(Value::as_str).ok_or("subscription.endpoint is required")?;
    if !endpoint.starts_with("https://") || endpoint.len() > 2048 || endpoint.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the push endpoint must be an https URL of at most 2048 characters".into());
    }
    let keys = sub.get("keys");
    let p256dh = text(keys.and_then(|k| k.get("p256dh")), "keys.p256dh")?;
    let auth = text(keys.and_then(|k| k.get("auth")), "keys.auth")?;
    let point = b64::decode(&p256dh, "p256dh").map_err(|e| e.to_string())?;
    if point.len() != 65 || point[0] != 0x04 {
        return Err("keys.p256dh must be an uncompressed P-256 point (65 bytes)".into());
    }
    if b64::decode(&auth, "auth").map_err(|e| e.to_string())?.len() != 16 {
        return Err("keys.auth must be 16 bytes".into());
    }
    let prefs = push::PushPrefs::default().merged(params.get("prefs").unwrap_or(&Value::Null));
    Ok(LivePush { endpoint: endpoint.to_string(), p256dh, auth, prefs })
}

/// Seal `event`'s notification for every subscription that wants its state and
/// hand each to the relay as a `push_send` (the relay adds VAPID and POSTs it; it
/// sees neither the content nor the subscription keys).
fn send_pushes(hub: &ControlHub, out: &mpsc::UnboundedSender<Message>, mac_id: &str, event: &Value, rng: &SystemRandom) {
    let Some(state) = push::push_state(event) else { return };
    let targets = hub.push_targets(state);
    if targets.is_empty() {
        return;
    }
    let payload = push::payload(mac_id, event, state).to_string();
    let urgency = if state == push::PushState::Review { "normal" } else { "high" };
    for (endpoint, p256dh, auth) in targets {
        let sealed = b64::decode(&p256dh, "p256dh")
            .and_then(|ua| Ok((ua, b64::decode(&auth, "auth")?)))
            .and_then(|(ua, au)| webpush::encrypt(&ua, &au, payload.as_bytes(), rng));
        match sealed {
            Ok(body) => {
                let f = json!({
                    "type": "push_send",
                    "endpoint": push::endpoint_hash(&endpoint),
                    "body": b64::encode(&body),
                    "ttl": PUSH_TTL_SECS,
                    "urgency": urgency,
                });
                let _ = out.send(Message::Text(f.to_string()));
            }
            // Never the endpoint (it identifies the device) nor a key.
            Err(e) => eprintln!("[relay] could not seal a {} push for a device: {e}", state.as_str()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_upgrades_scheme_and_appends_mac_path() {
        assert_eq!(
            to_ws_url("https://relay.example.app/", "mac1").unwrap(),
            "wss://relay.example.app/mac?macId=mac1"
        );
        assert_eq!(
            to_ws_url("http://127.0.0.1:8080", "m").unwrap(),
            "ws://127.0.0.1:8080/mac?macId=m"
        );
        assert_eq!(to_ws_url("wss://relay.example.app", "m").unwrap(), "wss://relay.example.app/mac?macId=m");
        assert!(to_ws_url("ftp://nope", "m").is_err());
    }

    /// L1: the mac token rides the `Authorization` header, never the URL.
    #[test]
    fn mac_upgrade_request_sends_the_token_as_a_bearer_header_not_in_the_url() {
        let request = mac_upgrade_request("https://relay.example.app", "mac1", "secret-tok").unwrap();
        assert_eq!(request.uri().to_string(), "wss://relay.example.app/mac?macId=mac1");
        assert!(!request.uri().to_string().contains("secret-tok"));
        assert_eq!(request.headers().get(AUTHORIZATION).unwrap(), "Bearer secret-tok");
    }

    /// I5: TLS everywhere except a relay on this machine.
    #[test]
    fn check_relay_url_requires_tls_except_on_loopback() {
        for ok in [
            "https://relay.example.app",
            "wss://relay.example.app/",
            "http://localhost:8080",
            "ws://LOCALHOST",
            "http://127.0.0.1:8080/",
            "ws://127.0.0.2",
            "http://[::1]:8080",
            "  https://relay.example.app  ",
        ] {
            assert!(check_relay_url(ok).is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "http://relay.example.app",
            "ws://relay.example.app:80",
            "http://192.168.1.10:8080",
            "ws://[2001:db8::1]:8080",
            // A loopback-looking USER part does not make the host loopback.
            "http://localhost@relay.example.app",
            "http://localhost.relay.example.app",
            "ftp://relay.example.app",
            "relay.example.app",
            "https://",
        ] {
            assert!(check_relay_url(bad).is_err(), "{bad} should be refused");
        }
        let err = check_relay_url("http://relay.example.app").unwrap_err();
        assert!(err.contains("not encrypted"), "the refusal explains itself: {err}");
    }

    /// I5: a stored URL that fails the check is never dialed.
    #[test]
    fn mac_upgrade_request_refuses_an_unencrypted_remote_relay() {
        assert!(mac_upgrade_request("http://relay.example.app", "m", "t").is_err());
    }

    /// L11: an RPC past the in-flight cap is answered `busy` at once (id and `_cid`
    /// echoed so the relay routes it back to the right phone), not spawned.
    #[tokio::test]
    async fn rpc_past_the_in_flight_cap_is_answered_busy() {
        let hub = Arc::new(ControlHub::new());
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        let _held = slots.clone().acquire_many_owned(MAX_INFLIGHT_RPCS as u32).await.unwrap();
        on_phone_frame(
            &hub,
            &out_tx,
            &slots,
            true,
            json!({ "type": "rpc", "id": "r7", "method": "list_conversations", "params": {}, "_cid": "c1" })
                .to_string(),
        );
        let Some(Message::Text(reply)) = out_rx.recv().await else {
            panic!("expected a text reply");
        };
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            reply,
            json!({ "type": "rpc_error", "id": "r7", "_cid": "c1", "error": RPC_BUSY_ERROR })
        );
    }

    /// L11: a dispatched RPC frees its slot when it finishes, so the cap never leaks.
    #[tokio::test]
    async fn a_finished_rpc_returns_its_slot() {
        let hub = Arc::new(ControlHub::new());
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(1));
        // No front is attached in a unit test, so the tool fails fast — still a full
        // dispatch that must hand its slot back.
        for id in ["a", "b"] {
            on_phone_frame(
                &hub,
                &out_tx,
                &slots,
                true,
                json!({ "type": "rpc", "id": id, "method": "list_conversations", "_cid": "c" }).to_string(),
            );
            let Some(Message::Text(reply)) = out_rx.recv().await else {
                panic!("expected a text reply");
            };
            let reply: Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(reply["id"], id);
            assert_ne!(reply["error"], RPC_BUSY_ERROR, "the slot was returned after the previous call");
            tokio::time::timeout(Duration::from_secs(1), async {
                while slots.available_permits() != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("slot released");
        }
    }

    /// L1 + L11 against a real WebSocket handshake on loopback: the relay sees the
    /// token only in `Authorization` (never in the request URI), and a message larger
    /// than [`MAX_RELAY_MESSAGE_BYTES`] ends the connection instead of being buffered.
    #[tokio::test]
    async fn connect_once_authenticates_by_header_and_refuses_an_oversized_message() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request as ServerRequest, Response};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<(String, Option<String>)>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut seen_tx = Some(seen_tx);
            let callback = |req: &ServerRequest, resp: Response| {
                let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string);
                if let Some(tx) = seen_tx.take() {
                    let _ = tx.send((req.uri().to_string(), auth));
                }
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
            ws.send(Message::Text("x".repeat(MAX_RELAY_MESSAGE_BYTES + 1))).await.ok();
            // Keep the socket open: the client must end it on its own.
            tokio::time::sleep(Duration::from_secs(10)).await;
        });

        let hub = Arc::new(ControlHub::new());
        let mut config = cfg(vec![]);
        config.relay_url = format!("http://127.0.0.1:{port}");
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let mut backoff = Duration::from_secs(1);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            connect_once(&hub, &config, &mut stop_rx, &mut backoff),
        )
        .await
        .expect("an oversized message must end the connection, not hang it");
        assert!(result.is_err(), "the oversized message is a connection error: {result:?}");

        let (uri, auth) = seen_rx.await.unwrap();
        assert_eq!(uri, "/mac?macId=mac1");
        assert_eq!(auth.as_deref(), Some("Bearer mactok"));
        server.abort();
    }

    #[test]
    fn pairing_url_puts_the_secret_in_the_fragment() {
        assert_eq!(
            pairing_url("https://relay.example.app", "mac1", "pt1"),
            "https://relay.example.app/#macId=mac1&pt=pt1"
        );
    }

    #[test]
    fn qr_svg_encodes_to_an_svg() {
        let svg = qr_svg("https://relay.example.app/#macId=a&pt=b").expect("qr");
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<rect"));
    }

    fn cfg(revoke: Vec<&str>) -> RemoteConfig {
        RemoteConfig {
            enabled: true,
            relay_url: "https://relay.example.app".into(),
            mac_id: "mac1".into(),
            mac_token: "mactok".into(),
            phone_token: "phonetok".into(),
            mac_label: "MacBook Pro".into(),
            revoke_phone_tokens: revoke.into_iter().map(str::to_string).collect(),
        }
    }

    /// C11 + C10: every (re)connect authorizes the current phone token, THEN
    /// publishes the node label, THEN flushes any still-pending revocation — in
    /// that exact order, so a revoked token is never mistaken for the one just
    /// authorized (a phone reconnecting concurrently must see the NEW token
    /// authorized before the OLD one is dropped).
    #[test]
    fn post_connect_frames_orders_authorize_then_label_then_revocations() {
        let frames = post_connect_frames(&cfg(vec!["old-a", "old-b"]), &[]);
        assert_eq!(
            frames,
            vec![
                json!({ "type": "authorize_phone", "phoneToken": "phonetok" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
                json!({ "type": "revoke_phone", "phoneToken": "old-a" }),
                json!({ "type": "revoke_phone", "phoneToken": "old-b" }),
            ]
        );
    }

    // ---- revoke_token_from_frame (pure) — the fix's own trigger logic --------

    /// Review-fix coverage: ONLY a `revoke_phone` frame reports back a token —
    /// `authorize_phone`/`set_label` (and anything unrecognized) must never be
    /// mistaken for a revocation, or `ControlHub::notify_relay_revocation_sent`
    /// would clear the wrong row (or clear on a non-token, which is a no-op that
    /// would still be a bug to have wired at all).
    #[test]
    fn revoke_token_from_frame_only_matches_revoke_phone_frames() {
        assert_eq!(
            revoke_token_from_frame(&json!({ "type": "revoke_phone", "phoneToken": "old-a" })),
            Some("old-a")
        );
        assert_eq!(
            revoke_token_from_frame(&json!({ "type": "authorize_phone", "phoneToken": "current" })),
            None,
            "authorize_phone must never be mistaken for a revocation"
        );
        assert_eq!(
            revoke_token_from_frame(&json!({ "type": "set_label", "label": "MacBook Pro" })),
            None
        );
        assert_eq!(revoke_token_from_frame(&json!({})), None);
    }

    /// The common case (no pending revocation) sends exactly the two frames every
    /// build before C10 already sent — no regression for a user who never
    /// regenerates their pairing.
    #[test]
    fn post_connect_frames_with_no_pending_revocation_sends_just_authorize_and_label() {
        let frames = post_connect_frames(&cfg(vec![]), &[]);
        assert_eq!(
            frames,
            vec![
                json!({ "type": "authorize_phone", "phoneToken": "phonetok" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
            ]
        );
    }

    // -- sealed channel ---------------------------------------------------------

    use crate::appmcp::devices::{DeviceSink, LiveDevice, LiveKey, KEY_LIFETIME_MS};
    use std::sync::Mutex as StdMutex;
    use tarmac_e2e::handshake::{Accept, PhoneHandshake};
    use tarmac_e2e::keys::DeviceSecret;
    use tarmac_e2e::session::{Sealed, Session};

    /// Records what the phone's sealed calls asked to persist.
    #[derive(Default)]
    struct RecordingDeviceSink {
        calls: StdMutex<Vec<String>>,
    }

    impl DeviceSink for RecordingDeviceSink {
        fn device_seen(&self, device_id: &str, _at_ms: i64) {
            self.calls.lock().unwrap().push(format!("seen {device_id}"));
        }
        fn forget_device(&self, device_id: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("forget {device_id}"));
            Ok(())
        }
        fn register_push(&self, device_id: &str, push: &LivePush) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("push {device_id} {}", push.endpoint));
            Ok(())
        }
        fn set_push_prefs(&self, _device_id: &str, _prefs: push::PushPrefs) -> Result<(), String> {
            Ok(())
        }
        fn unregister_push(&self, _device_id: &str, _endpoint: Option<&str>) -> Result<usize, String> {
            Ok(0)
        }
        fn renew_device(&self, _device_id: &str) -> Result<LiveKey, String> {
            Err("not in this test".into())
        }
    }

    const PHONE: [u8; 16] = [5; 16];

    /// A hub whose book holds one device, legacy retired, with a recording sink.
    fn sealed_hub() -> (Arc<ControlHub>, Arc<RecordingDeviceSink>) {
        let hub = Arc::new(ControlHub::new());
        let mut c = cfg(vec![]);
        c.phone_token = String::new();
        hub.remote.lock().unwrap().cfg = c;
        *hub.channel.lock().unwrap() = NodeChannel::new("mac1".to_string());
        let now = now_ms();
        hub.set_devices(vec![LiveDevice {
            device_id: DeviceId::from_bytes(PHONE).to_b64(),
            label: "iPhone".into(),
            relay_token: "rt-phone".into(),
            keys: vec![LiveKey {
                generation: 1,
                secret: DeviceSecret::from_bytes([6; 32]),
                issued_at_ms: now,
                expires_at_ms: now + KEY_LIFETIME_MS,
            }],
            push: vec![],
        }]);
        let sink = Arc::new(RecordingDeviceSink::default());
        hub.set_device_sink(sink.clone());
        (hub, sink)
    }

    async fn next_frame(rx: &mut mpsc::UnboundedReceiver<Message>) -> Value {
        let Some(Message::Text(t)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap() else {
            panic!("expected a text frame");
        };
        serde_json::from_str(&t).unwrap()
    }

    /// Handshake as the phone on socket "c1"; returns the phone's session.
    async fn connect_phone(hub: &Arc<ControlHub>, out: &mpsc::UnboundedSender<Message>, rx: &mut mpsc::UnboundedReceiver<Message>, slots: &Arc<Semaphore>) -> Session {
        let rng = SystemRandom::new();
        let (hs, hello) = PhoneHandshake::start(DeviceId::from_bytes(PHONE), 1, &rng).unwrap();
        let mut f = hello.to_frame();
        f["_cid"] = json!("c1");
        on_phone_frame(hub, out, slots, false, f.to_string());
        let accept = next_frame(rx).await;
        assert_eq!(accept["type"], "e2e_accept", "{accept}");
        assert_eq!(accept["_cid"], "c1");
        let key = DeviceSecret::from_bytes([6; 32]).node_key("mac1");
        hs.finish(&Accept::from_frame(&accept).unwrap(), "mac1", &key).unwrap()
    }

    fn send_sealed_as_phone(hub: &Arc<ControlHub>, out: &mpsc::UnboundedSender<Message>, slots: &Arc<Semaphore>, phone: &mut Session, frame: Value) {
        let mut f = phone.seal_json(&frame).unwrap().to_frame();
        f["_cid"] = json!("c1");
        on_phone_frame(hub, out, slots, false, f.to_string());
    }

    async fn open_reply(phone: &mut Session, rx: &mut mpsc::UnboundedReceiver<Message>) -> Value {
        let f = next_frame(rx).await;
        assert_eq!(f["type"], "e2e", "expected a sealed frame, got {f}");
        assert_eq!(f["_cid"], "c1");
        phone.open_json(&Sealed::from_frame(&f).unwrap()).unwrap()
    }

    #[test]
    fn a_retired_legacy_token_is_not_authorized_and_devices_are() {
        let mut c = cfg(vec!["old"]);
        c.phone_token = String::new();
        assert!(!legacy_open(&c));
        let frames = post_connect_frames(&c, &[("rt-1".into(), "iPhone".into())]);
        assert_eq!(
            frames,
            vec![
                json!({ "type": "authorize_phone", "phoneToken": "rt-1", "label": "iPhone" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
                json!({ "type": "revoke_phone", "phoneToken": "old" }),
            ]
        );
    }

    #[tokio::test]
    async fn with_the_legacy_token_retired_a_cleartext_rpc_is_refused() {
        let (hub, _) = sealed_hub();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        on_phone_frame(&hub, &out, &slots, false, json!({"type": "rpc", "id": "x", "method": "list_conversations", "_cid": "c1"}).to_string());
        assert_eq!(
            next_frame(&mut rx).await,
            json!({"type": "rpc_error", "id": "x", "_cid": "c1", "error": ENCRYPTION_REQUIRED})
        );
    }

    #[tokio::test]
    async fn a_sealed_phone_gets_ready_and_sealed_answers() {
        let (hub, sink) = sealed_hub();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        let mut phone = connect_phone(&hub, &out, &mut rx, &slots).await;
        assert_eq!(sink.calls.lock().unwrap().as_slice(), [format!("seen {}", DeviceId::from_bytes(PHONE).to_b64())]);

        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "subscribe"}));
        let ready = open_reply(&mut phone, &mut rx).await;
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["label"], "MacBook Pro");
        assert_eq!(ready["device"]["label"], "iPhone");
        assert_eq!(ready["device"]["generation"], 1);
        assert!(ready["device"]["renew_after_ms"].as_i64().unwrap() > now_ms());
        assert_eq!(ready["caps"], json!(["sealed-push", "forget-device", "renew-device"]));

        // The phone catalogue answers sealed (no front in a unit test: an error, sealed).
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r1", "method": "rewind", "params": {}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["type"], "rpc_error");
        assert_eq!(r["error"], "unknown or unavailable method: rewind");

        // Too early to renew: the current generation, unchanged.
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r2", "method": "renew_device", "params": {}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["result"]["renewed"], false);
        assert_eq!(r["result"]["generation"], 1);

        // A push subscription is validated, persisted, then live.
        let point = PhoneHandshake::start(DeviceId::from_bytes(PHONE), 1, &SystemRandom::new()).unwrap().1.ephemeral;
        let sub = json!({"endpoint": "https://web.push.apple.com/x", "keys": {"p256dh": b64::encode(&point), "auth": b64::encode(&[1u8; 16])}});
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r3", "method": "push_register", "params": {"subscription": sub}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["result"]["registered"], true);
        assert_eq!(hub.push_targets(push::PushState::Review).len(), 1);
        let bad = json!({"endpoint": "http://nope", "keys": {"p256dh": "AA", "auth": "AA"}});
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r4", "method": "push_register", "params": {"subscription": bad}}));
        assert_eq!(open_reply(&mut phone, &mut rx).await["type"], "rpc_error");

        // forget_device: persisted, answered sealed, then the device is gone.
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r5", "method": "forget_device", "params": {}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["result"], json!({"forgotten": true}));
        assert!(sink.calls.lock().unwrap().iter().any(|c| c.starts_with("forget ")));
        assert!(hub.devices().is_empty());
        assert!(!hub.channel.lock().unwrap().has_session("c1"));
    }

    #[tokio::test]
    async fn an_unknown_device_is_rejected_and_phone_left_ends_a_session() {
        let (hub, _) = sealed_hub();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        let (_, hello) = PhoneHandshake::start(DeviceId::from_bytes([9; 16]), 1, &SystemRandom::new()).unwrap();
        let mut f = hello.to_frame();
        f["_cid"] = json!("c2");
        on_phone_frame(&hub, &out, &slots, false, f.to_string());
        assert_eq!(next_frame(&mut rx).await["reason"], "unknown_device");

        let _phone = connect_phone(&hub, &out, &mut rx, &slots).await;
        assert!(hub.channel.lock().unwrap().has_session("c1"));
        on_phone_frame(&hub, &out, &slots, false, json!({"type": "phone_left", "_cid": "c1"}).to_string());
        assert!(!hub.channel.lock().unwrap().has_session("c1"));
    }
}
