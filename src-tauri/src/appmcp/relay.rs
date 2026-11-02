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

use crate::platform::MACHINE;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use tarmac_e2e::handshake::RejectReason;
use tarmac_e2e::keys::{renew_decision, DeviceId, RenewDecision};
use tarmac_e2e::node::{Inbound, NodeChannel, ReadyDevice, SessionRef};
use tarmac_e2e::{b64, push};
use tarmac_e2e::rand::SystemRandom;

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
const RPC_BUSY_ERROR: &str = if cfg!(target_os = "macos") {
    "busy: too many requests in progress on this Mac, try again"
} else {
    "busy: too many requests in progress on this computer, try again"
};

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

/// Longest wait for the relay to take a connection (TCP, TLS, upgrade). Past it the attempt
/// is a transient failure — without it a relay that accepts TCP and never answers would
/// hold the link, and every phone, forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// We ping the relay this often, and it pings us as often (PROTOCOL.md §7).
const HEARTBEAT: Duration = Duration::from_secs(30);

/// Silence past which the link is dead: a half-open TCP connection (the Mac slept, a NAT
/// forgot it) never errors on its own, while a live one carries a ping or a pong at least
/// every [`HEARTBEAT`]. Two and a half heartbeats.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(75);

/// How long after the relay REFUSED this Mac's credentials it is tried again. Sooner can't
/// help (same token, same refusal) and each try counts against this address's auth
/// throttle on the relay — which the phones on the same network share. Not never: a relay
/// whose state was reset (an admin reset, a redeploy without storage) takes it again.
const REFUSED_RETRY: Duration = Duration::from_secs(10 * 60);

/// The link's clocks — [`LINK_TIMINGS`] in the app; tests shrink them.
#[derive(Debug, Clone, Copy)]
struct LinkTimings {
    connect: Duration,
    heartbeat: Duration,
    read_idle: Duration,
}

const LINK_TIMINGS: LinkTimings =
    LinkTimings { connect: CONNECT_TIMEOUT, heartbeat: HEARTBEAT, read_idle: READ_IDLE_TIMEOUT };

/// Events older than this are not replayed after a drop: a push about a turn that ended
/// long ago is noise, and a phone reads the current state when it reconnects.
const REPLAY_MAX_AGE_MS: u64 = 15 * 60 * 1000;

/// Why one connection ended, other than a requested stop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LinkError {
    /// Worth retrying soon: the network, a relay restart, admission (`1013`), a timeout.
    Dropped(String),
    /// The relay refused this Mac's credentials (`1008 "auth"`): the same token will be
    /// refused again. Carries the relay's reason.
    Refused(String),
}

/// Dial the relay and keep the connection up until `stop` flips: a dropped link is
/// redialed with capped backoff, a refused one only every [`REFUSED_RETRY`]. The hub's
/// remote runtime tracks the live link (`connected`, `error`, `refused`) for Settings.
pub(crate) async fn serve(hub: Arc<ControlHub>, cfg: RemoteConfig, mut stop: watch::Receiver<bool>) {
    let mut backoff = Duration::from_secs(1);
    while !*stop.borrow() {
        let wait = match dial(&hub, &cfg, &LINK_TIMINGS, &mut stop, &mut backoff).await {
            Ok(()) => return, // graceful stop
            Err(LinkError::Dropped(e)) => {
                hub.set_remote_error(Some(e), false);
                let wait = backoff;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                wait
            }
            Err(LinkError::Refused(e)) => {
                eprintln!("[relay] the relay refused this Mac's credentials: {e}");
                hub.set_remote_error(Some(refused_message(&e)), true);
                REFUSED_RETRY
            }
        };
        if *stop.borrow() {
            return;
        }
        tokio::select! {
            _ = stop.changed() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// What Settings says when the relay refuses this Mac's credentials.
fn refused_message(reason: &str) -> String {
    format!(
        "The relay refused this {MACHINE}'s credentials ({reason}): another {MACHINE} — or an older copy of this \
         one — holds this {MACHINE}'s identity there. Flight Deck tries again every {} minutes; the relay \
         lets it back in once its record of this {MACHINE} is reset.",
        REFUSED_RETRY.as_secs() / 60
    )
}

/// One connection, with the current token — then, when the relay refuses it and a rotation
/// is under way, with the next one: the relay may hold it already (its answer was lost).
async fn dial(
    hub: &Arc<ControlHub>,
    cfg: &RemoteConfig,
    timings: &LinkTimings,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<(), LinkError> {
    let (current, next) = hub.mac_tokens();
    match connect_once(hub, cfg, timings, &current, false, stop, backoff).await {
        Err(LinkError::Refused(e)) => match next {
            Some(next) => {
                eprintln!("[relay] the relay refused this Mac's token ({e}); trying the one a rotation was moving to");
                connect_once(hub, cfg, timings, &next, true, stop, backoff).await
            }
            None => Err(LinkError::Refused(e)),
        },
        other => other,
    }
}

/// The relay frame that rotates this Mac's token to `next` (PROTOCOL.md §4).
pub(crate) fn rotate_frame(next: &str) -> Message {
    Message::Text(json!({ "type": "rotate_mac_token", "macToken": next }).to_string())
}

/// Whether a relay that welcomed us with `caps` rotates mac tokens. Never sent otherwise:
/// an older relay forwards unknown frames to the phones, token included.
pub(crate) fn rotates_mac_token(caps: Option<&[String]>) -> bool {
    caps.is_some_and(|caps| caps.iter().any(|c| c == "rotate_mac_token"))
}

/// A connect that failed before the WebSocket opened, in words for Settings.
fn upgrade_error(e: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match e {
        Error::Http(response) if response.status().as_u16() == 429 => {
            "the relay is turning this address away for a few minutes (too many attempts, HTTP 429)".into()
        }
        Error::Http(response) => format!("the relay refused the connection (HTTP {})", response.status().as_u16()),
        other => other.to_string(),
    }
}

/// How a link the relay closed ended: `1008 "auth"` is a refusal of this Mac's
/// credentials; anything else — `1008 "reset"` (an admin reset: the same token claims the
/// id again), `1013` (admission), a restart — is a drop. `relay_error`: the `{type:"error"}`
/// the relay sent before closing, its words.
fn close_error(frame: Option<&CloseFrame<'_>>, relay_error: Option<String>) -> LinkError {
    match frame {
        Some(f) if u16::from(f.code) == 1008 && f.reason == "auth" => {
            LinkError::Refused(relay_error.unwrap_or_else(|| "credentials refused".into()))
        }
        Some(f) => LinkError::Dropped(
            relay_error.unwrap_or_else(|| format!("the relay closed the connection ({} {})", u16::from(f.code), f.reason)),
        ),
        None => LinkError::Dropped(relay_error.unwrap_or_else(|| "relay connection closed".into())),
    }
}

/// The ping sent behind a batch of fleet events: its pong confirms the relay got them all
/// (one socket, in order), up to `cursor`.
fn event_ack_payload(cursor: u64) -> Vec<u8> {
    format!("fd-events-{cursor}").into_bytes()
}

fn event_ack_cursor(payload: &[u8]) -> Option<u64> {
    std::str::from_utf8(payload).ok()?.strip_prefix("fd-events-")?.parse().ok()
}

/// The frames sent right after connecting, in order: every phone token still
/// awaiting revocation FIRST (C10's critical fix — they must never be the tail a
/// rate limit cuts), then the legacy token and each live device's relay token, then
/// this Mac's node label (C11). Pure so the exact shape/order is unit-tested without
/// a live socket. [`send_burst`] paces them (the relay allows a node a 60-frame burst
/// refilled at 30/s and SILENTLY drops the rest) and reports a revocation to
/// [`ControlHub::notify_relay_revocation_sent`] only once the relay answered a ping
/// sent behind it — never merely because it was written. `authorize_phone` /
/// `set_label` have no delivery ack on the wire (PROTOCOL.md §4), and re-sending
/// them on the next reconnect is harmless (idempotent).
pub(crate) fn post_connect_frames(cfg: &RemoteConfig, device_tokens: &[(String, String)]) -> Vec<Value> {
    let mut frames: Vec<Value> = cfg
        .revoke_phone_tokens
        .iter()
        .map(|token| json!({ "type": "revoke_phone", "phoneToken": token }))
        .collect();
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
    frames
}

/// Most frames of the connect burst sent at once, and the pause between batches —
/// under the relay's refill rate, like `flightdeckd`'s burst.
const BURST_BATCH: usize = 20;
const BURST_PAUSE: Duration = Duration::from_secs(1);

/// Revocations written on this link, awaiting the pong of the ping sent behind
/// them (keyed by that ping's payload).
type RevokeAcks = Arc<std::sync::Mutex<std::collections::HashMap<Vec<u8>, Vec<String>>>>;

/// Send the connect burst on `out`, [`BURST_BATCH`] frames at a time, [`BURST_PAUSE`]
/// apart. Each frame is re-checked against the hub as it goes: a token no longer
/// authorized (revoked meanwhile) is not re-authorized, and the label is the current
/// one. A batch carrying revocations is followed by a ping whose pong confirms them
/// (`acks`, read by the connection's read loop).
async fn send_burst(
    hub: Arc<ControlHub>,
    out: mpsc::UnboundedSender<Message>,
    frames: Vec<Value>,
    acks: RevokeAcks,
    pause: Duration,
) {
    for (i, batch) in frames.chunks(BURST_BATCH).enumerate() {
        if i > 0 {
            tokio::time::sleep(pause).await;
        }
        let (legacy, label) = {
            let remote = hub.remote.lock().expect("remote lock");
            (remote.cfg.phone_token.clone(), remote.cfg.mac_label.clone())
        };
        let devices: Vec<String> = hub.device_relay_tokens().into_iter().map(|(t, _)| t).collect();
        let mut revoked = Vec::new();
        for frame in batch {
            let mut frame = frame.clone();
            match frame.get("type").and_then(Value::as_str) {
                Some("authorize_phone") => {
                    let token = frame["phoneToken"].as_str().unwrap_or("");
                    if token.is_empty() || (token != legacy && !devices.iter().any(|d| d == token)) {
                        continue;
                    }
                }
                Some("set_label") => frame["label"] = json!(label),
                _ => {}
            }
            if let Some(token) = revoke_token_from_frame(&frame) {
                revoked.push(token.to_string());
            }
            if out.send(Message::Text(frame.to_string())).is_err() {
                return;
            }
        }
        if !revoked.is_empty() {
            let payload = format!("fd-revoke-{i}").into_bytes();
            acks.lock().expect("acks lock").insert(payload.clone(), revoked);
            if out.send(Message::Ping(payload)).is_err() {
                return;
            }
        }
    }
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

/// One connection lifetime with `token`: connect, authorize the phones, then pump phone
/// RPCs (dispatched concurrently through the hub), fleet events, and a heartbeat until the
/// socket drops, falls silent, or `stop` flips. `proves_next`: `token` is the one a
/// rotation is moving to — the relay's `welcome` settles it. Returns `Ok(())` only on a
/// requested stop; any failure is an `Err` [`serve`] waits on before dialing again.
async fn connect_once(
    hub: &Arc<ControlHub>,
    cfg: &RemoteConfig,
    timings: &LinkTimings,
    token: &str,
    proves_next: bool,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<(), LinkError> {
    ensure_crypto_provider();
    let request = mac_upgrade_request(&cfg.relay_url, &cfg.mac_id, token).map_err(LinkError::Dropped)?;
    let connecting = tokio_tungstenite::connect_async_with_config(request, Some(relay_ws_config()), false);
    let (ws, _resp) = match tokio::time::timeout(timings.connect, connecting).await {
        Ok(Ok(connected)) => connected,
        Ok(Err(e)) => return Err(LinkError::Dropped(upgrade_error(&e))),
        Err(_) => {
            return Err(LinkError::Dropped(format!("the relay did not answer within {} s", timings.connect.as_secs())))
        }
    };
    // Sealed sessions belong to a link: phones handshake again on `welcome`.
    *hub.channel.lock().expect("channel lock") = NodeChannel::new(cfg.mac_id.clone());

    let (mut write, mut read) = ws.split();
    // Revoke what is still owed, authorize the phones, publish this Mac's node label
    // — see `post_connect_frames`'s doc. A `revoke_phone` is reported to the hub —
    // which durably clears it from `pending_relay_phone_revocations` — ONLY once the
    // relay answered the ping sent behind it on THIS socket, never merely because this
    // function was reached (that was the bug: `ipc::commands::set_remote` used to
    // clear the queue the instant `apply_remote` had merely SPAWNED a reconnect).
    //
    // The outlet is published BEFORE the book is read: a device paired (or revoked)
    // meanwhile is either in the snapshot below or queued on the outlet — never in
    // neither. Its revocations are the hub's CURRENT ones (a device revoked while the
    // link was down was added there), not the snapshot `cfg` this loop started with.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    *hub.remote_out.lock().expect("remote_out lock") = Some(out_tx.clone());
    let current = {
        let mut current = cfg.clone();
        current.revoke_phone_tokens = hub.remote.lock().expect("remote lock").cfg.revoke_phone_tokens.clone();
        current
    };
    let revoke_acks: RevokeAcks = Arc::default();
    let burst = tokio::spawn(send_burst(
        hub.clone(),
        out_tx.clone(),
        post_connect_frames(&current, &hub.device_relay_tokens()),
        revoke_acks.clone(),
        BURST_PAUSE,
    ));

    // A single writer drains this channel, so the burst, RPC replies, event pushes
    // and the heartbeat can all write to the socket without sharing the sink.
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if write.send(m).await.is_err() {
                break;
            }
        }
    });
    // Cleartext only while the legacy shared token is in use (see `legacy_open`).
    let legacy = legacy_open(cfg);

    // Push fleet events (turn finished / needs attention) to the phone(s): in clear
    // only while the legacy token is in use, sealed for every proven sealed
    // session, and as node-sealed Web Pushes for the devices that registered one.
    //
    // From the last event the relay CONFIRMED, not from the journal's present: what was
    // published while the link was down (or written to a link that was dying) goes out
    // now. Each batch is followed by a ping whose pong confirms it (the read loop).
    let events_task = {
        let hub = hub.clone();
        let out = out_tx.clone();
        let mut stop = stop.clone();
        let mac_id = cfg.mac_id.clone();
        tokio::spawn(async move {
            let rng = SystemRandom::new();
            let mut cursor = hub.relay_event_cursor();
            loop {
                if *stop.borrow() {
                    break;
                }
                let (next, evs) = tokio::select! {
                    _ = stop.changed() => { if *stop.borrow() { break; } else { continue; } }
                    r = hub.events.wait(cursor, Duration::from_secs(25)) => r,
                };
                if evs.is_empty() {
                    continue;
                }
                let now = now_ms().max(0) as u64;
                for e in evs {
                    if now.saturating_sub(e.at_ms) > REPLAY_MAX_AGE_MS {
                        continue;
                    }
                    send_event(&hub, &out, &mac_id, &e, legacy, &rng);
                    if out.is_closed() {
                        return;
                    }
                }
                cursor = next;
                if out.send(Message::Ping(event_ack_payload(cursor))).is_err() {
                    return;
                }
            }
        })
    };

    // Keepalive: the relay answers each ping, so a live link is never silent for long
    // (see `READ_IDLE_TIMEOUT`).
    let heartbeat = {
        let out = out_tx.clone();
        let every = timings.heartbeat;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if out.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
        })
    };

    // Phone RPCs running at once on this connection (L11) — see `MAX_INFLIGHT_RPCS`.
    let rpc_slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
    // What the relay said before closing a refused connection (`{type:"error"}`).
    let mut relay_error: Option<String> = None;
    let idle = tokio::time::sleep(timings.read_idle);
    tokio::pin!(idle);
    let result = loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break Ok(()); }
            }
            _ = &mut idle => {
                break Err(LinkError::Dropped(format!(
                    "no word from the relay for {} s — the connection was dead, reconnecting",
                    timings.read_idle.as_secs()
                )));
            }
            msg = read.next() => {
                idle.as_mut().reset(tokio::time::Instant::now() + timings.read_idle);
                match msg {
                    Some(Ok(Message::Text(txt))) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&txt) else { continue };
                        match msg.get("type").and_then(Value::as_str) {
                            // The relay took our credentials: only now is the link up.
                            Some("welcome") => {
                                *backoff = Duration::from_secs(1);
                                hub.set_remote_welcomed(welcome_caps(&msg));
                                if proves_next {
                                    hub.settle_mac_token(token);
                                }
                                hub.resume_mac_token_rotation();
                            }
                            Some("error") => {
                                relay_error = msg.get("error").and_then(Value::as_str).map(str::to_string);
                            }
                            _ => on_relay_message(hub, &out_tx, &rpc_slots, legacy, msg),
                        }
                    }
                    Some(Ok(Message::Pong(payload))) => {
                        let confirmed = revoke_acks.lock().expect("acks lock").remove(&payload);
                        for token in confirmed.unwrap_or_default() {
                            hub.notify_relay_revocation_sent(&token);
                        }
                        if let Some(cursor) = event_ack_cursor(&payload) {
                            hub.confirm_relay_event_cursor(cursor);
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Close(frame))) => break Err(close_error(frame.as_ref(), relay_error.take())),
                    None => break Err(close_error(None, relay_error.take())),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(LinkError::Dropped(e.to_string())),
                }
            }
        }
    };

    hub.set_remote_disconnected();
    {
        let mut slot = hub.remote_out.lock().expect("remote_out lock");
        if slot.as_ref().is_some_and(|t| t.same_channel(&out_tx)) {
            *slot = None;
        }
    }
    burst.abort();
    events_task.abort();
    heartbeat.abort();
    drop(out_tx);
    writer.abort();
    result
}

/// The `caps` of the relay's `welcome` (none from a relay that predates them).
fn welcome_caps(welcome: &Value) -> Vec<String> {
    welcome
        .get("caps")
        .and_then(Value::as_array)
        .map(|caps| caps.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Send one fleet event to the phones (PROTOCOL.md §5 shape `{conversationId, kind, text,
/// at}` — the relay constructs this frame, so it owns matching the contract the PWA reads;
/// `text` is a best-effort preview from the journal detail): in clear while the legacy
/// token is in use, sealed for every proven session, and as Web Pushes.
fn send_event(
    hub: &ControlHub,
    out: &mpsc::UnboundedSender<Message>,
    mac_id: &str,
    e: &super::events::ControlEvent,
    legacy: bool,
    rng: &SystemRandom,
) {
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
    if legacy {
        let _ = out.send(Message::Text(frame.to_string()));
    }
    {
        let mut channel = hub.channel.lock().expect("channel lock");
        for f in channel.seal_broadcast(&frame, now_ms().max(0) as u64) {
            let _ = out.send(Message::Text(f.to_string()));
        }
    }
    send_pushes(hub, out, mac_id, &frame["event"], rng);
}

/// Route one inbound relay text frame. `rpc` frames are dispatched on their own
/// task (a tool call can await the front executor for up to 30 s — never block
/// the read loop), at most [`MAX_INFLIGHT_RPCS`] at a time: past that, the RPC is
/// answered `busy` right away instead of queueing work; `ping` is answered
/// immediately. Tests feed frames through here; the link's read loop parses once and
/// calls [`on_relay_message`].
#[cfg(test)]
fn on_phone_frame(
    hub: &Arc<ControlHub>,
    out_tx: &mpsc::UnboundedSender<Message>,
    rpc_slots: &Arc<Semaphore>,
    legacy: bool,
    txt: String,
) {
    if let Ok(msg) = serde_json::from_str::<Value>(&txt) {
        on_relay_message(hub, out_tx, rpc_slots, legacy, msg);
    }
}

/// [`on_phone_frame`], parsed. The connection-level frames (`welcome`, `error`) are the
/// read loop's own, never routed here.
fn on_relay_message(
    hub: &Arc<ControlHub>,
    out_tx: &mpsc::UnboundedSender<Message>,
    rpc_slots: &Arc<Semaphore>,
    legacy: bool,
    msg: Value,
) {
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
        "push_gone" => on_push_gone(hub, &msg),
        // The relay's answer to `rotate_mac_token` (a relay frame: no phone can send one,
        // the relay forwards only the phone allowlist).
        "mac_token_rotated" => hub.on_mac_token_rotated(
            msg.get("ok").and_then(Value::as_bool).unwrap_or(false),
            msg.get("error").and_then(Value::as_str).map(str::to_string),
        ),
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

/// What this Mac's sealed `ready` advertises. Only the issuer renews keys; only it
/// lists the nodes of its fleet (`nodes`: the phone drops a node — and its pushes —
/// the issuer no longer lists, e.g. a server removed from this Mac).
const SEALED_CAPS: &[&str] = &["sealed-push", "signed-push", "forget-device", "renew-device", "node-list"];

/// Whether this Mac still takes cleartext phone frames: only while the legacy
/// shared token is in use. Retiring it (an empty token) closes the cleartext path.
pub(crate) fn legacy_open(cfg: &RemoteConfig) -> bool {
    !cfg.phone_token.is_empty()
}

/// Seal `frame` for socket `cid` and queue it, both under the channel lock (a
/// session's counters must leave in order: the phone drops a counter below the
/// last it saw).
///
/// Sealed for `session` — the one the request came in on — or not at all: the relay
/// picks every `_cid`, and a socket whose session changed meanwhile must never get
/// the answer (a renewed secret above all) sealed for another session.
fn send_sealed(hub: &ControlHub, out: &mpsc::UnboundedSender<Message>, cid: &str, session: SessionRef, frame: &Value) {
    let mut channel = hub.channel.lock().expect("channel lock");
    match channel.seal_for(cid, session, frame) {
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
        // "Seen" is recorded once the session PROVES itself (its first sealed frame),
        // never here: anyone who saw a hello can replay it and get an accept.
        Ok((mut reply, accepted)) => {
            if accepted.is_none() {
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
    let inbound = hub.channel.lock().expect("channel lock").on_sealed(cid, msg, now_ms().max(0) as u64);
    let (device_id, frame, session) = match inbound {
        Inbound::App { device_id, frame, session, first_proof } => {
            if first_proof {
                on_first_proof(hub, &device_id, session.generation);
            }
            (device_id, frame, session)
        }
        Inbound::NoSession => return ask_for_handshake(out, cid),
        Inbound::Expired => {
            eprintln!("[relay] sealed session on phone socket {cid} ended: its key expired");
            let f = tarmac_e2e::node::to_socket(RejectReason::Expired.to_frame(), cid);
            let _ = out.send(Message::Text(f.to_string()));
            return;
        }
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
            let key = hub.device_key(&device_id, session.generation);
            let label = hub.remote.lock().expect("remote lock").cfg.mac_label.clone();
            let device = key.map(|(label, k)| ReadyDevice {
                label,
                generation: k.generation,
                expires_at_ms: k.expires_at_ms,
                renew_after_ms: k.renew_after_ms(),
            });
            let mut ready = tarmac_e2e::node::ready_frame(&label, device.as_ref(), SEALED_CAPS);
            ready["nodes"] = json!(hub.device_sink().map(|s| s.trusted_nodes()).unwrap_or_default());
            send_sealed(hub, out, cid, session, &ready);
        }
        Some("ping") => send_sealed(hub, out, cid, session, &json!({ "type": "pong" })),
        Some("rpc") => {
            let Ok(slot) = rpc_slots.clone().try_acquire_owned() else {
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                send_sealed(hub, out, cid, session, &rpc_reply(id, Err(RPC_BUSY_ERROR.to_string())));
                return;
            };
            let (hub, out, cid) = (hub.clone(), out.clone(), cid.to_string());
            tokio::spawn(async move {
                sealed_rpc(&hub, &out, &cid, session, device_id, frame).await;
                drop(slot);
            });
        }
        _ => {}
    }
}

/// A session just proved itself: record the device as seen, and when it used the
/// device's newest generation, prune the older ones everywhere.
fn on_first_proof(hub: &ControlHub, device_id: &DeviceId, generation: u32) {
    let device = device_id.to_b64();
    match hub.device_sink() {
        Ok(sink) => sink.device_seen(&device, now_ms()),
        Err(e) => eprintln!("[relay] could not record that {device} connected: {e}"),
    }
    if let Err(e) = hub.confirm_device_generation(&device, generation) {
        eprintln!("[relay] {device} moved to key generation {generation}, but pruning the older one failed: {e} — retried at its next session");
    }
}

/// A sealed `rpc`: the device-only methods, else the phone catalogue. Answered sealed,
/// for the session it came in on.
async fn sealed_rpc(
    hub: &Arc<ControlHub>,
    out: &mpsc::UnboundedSender<Message>,
    cid: &str,
    session: SessionRef,
    device_id: DeviceId,
    frame: Value,
) {
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let method = frame.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let device = device_id.to_b64();
    let result = match method.as_str() {
        "forget_device" => match hub.device_sink().and_then(|s| s.forget_device(&device)) {
            Ok(()) => {
                // Answered BEFORE the revoke: the relay closes the socket on it.
                send_sealed(hub, out, cid, session, &rpc_reply(id, Ok(json!({ "forgotten": true }))));
                hub.remove_device_live(&device, None);
                return;
            }
            Err(e) => Err(e),
        },
        "renew_device" => renew_device(hub, &device, session.generation),
        "push_register" | "push_prefs" | "push_unregister" => push_rpc(hub, &device, &method, &params),
        _ => run_phone_tool(hub, &method, &params).await,
    };
    send_sealed(hub, out, cid, session, &rpc_reply(id, result));
}

/// `renew_device {}` from a session on generation `session_generation`, by the
/// issuer's rule ([`renew_decision`]): the next generation once the newest is due —
/// only for a session on that newest; the same still-unused newest again for a
/// session on the generation it replaces (its first answer may have been lost);
/// nothing for a session on any other generation (an old secret — a photographed QR,
/// an old backup — never buys a fresh one).
fn renew_device(hub: &ControlHub, device: &str, session_generation: u32) -> Result<Value, String> {
    let book = hub.renewal_book(device);
    if book.is_empty() {
        return Err(format!("this device is not paired with this {MACHINE}"));
    }
    let issued = |k: &super::devices::LiveKey| {
        json!({
            "renewed": true,
            "generation": k.generation,
            "secret": k.secret.to_b64(),
            "issued_at_ms": k.issued_at_ms,
            "expires_at_ms": k.expires_at_ms,
            "renew_after_ms": k.renew_after_ms(),
        })
    };
    match renew_decision(&book, session_generation, now_ms()) {
        RenewDecision::Mint => {
            let next = hub.device_sink()?.renew_device(device, session_generation)?;
            hub.add_device_key_live(device, next.clone());
            Ok(issued(&next))
        }
        RenewDecision::Redeliver(generation) => {
            let key = hub.device_generation(device, generation).ok_or("this device's newest key is gone")?;
            Ok(issued(&key))
        }
        RenewDecision::NotDue => {
            let current = hub.device_generation(device, session_generation).ok_or("this device's key is gone")?;
            Ok(json!({
                "renewed": false,
                "generation": current.generation,
                "expires_at_ms": current.expires_at_ms,
                "renew_after_ms": current.renew_after_ms(),
            }))
        }
        RenewDecision::Refuse => {
            eprintln!("[relay] refused to renew {device} from key generation {session_generation}: not its current one");
            Err("this key is no longer this phone's current one — pair the phone again".into())
        }
    }
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
    let now = now_ms();
    for (target, generation, key) in hub.push_targets(state, mac_id, now) {
        let signer = push::PushSigner { generation, key: &key };
        match push::push_send_frame(mac_id, event, state, &target, signer, now.max(0) as u64, rng) {
            Ok(f) => {
                let _ = out.send(Message::Text(f.to_string()));
            }
            // Never the endpoint (it identifies the device) nor a key.
            Err(e) => eprintln!("[relay] could not seal a {} push for a device: {e}", state.as_str()),
        }
    }
}

/// The relay's `push_gone {endpoint, reason}`: it refused a `push_send` for that
/// subscription (unknown to it, or dropped after the push service refused it), so it
/// is pruned here and this Mac stops pushing into the void. Unauthenticated — the
/// relay could already drop every push — and never answered: the phone registers it
/// again at its next session. Logged by reason and count only, never the endpoint
/// nor its hash.
fn on_push_gone(hub: &ControlHub, msg: &Value) {
    let Some(gone) = push::parse_push_gone(msg) else {
        eprintln!("[relay] malformed push_gone from the relay — ignored");
        return;
    };
    match hub.prune_gone_push(&gone) {
        // Not one of ours, or already gone.
        Ok(0) => {}
        Ok(n) => eprintln!("[relay] the relay reports a push subscription gone ({}): {n} removed", gone.reason),
        Err(e) => eprintln!(
            "[relay] the relay reports a push subscription gone ({}), but removing it failed: {e} — retried at its next report",
            gone.reason
        ),
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
            connect_once(&hub, &config, &LINK_TIMINGS, "mactok", false, &mut stop_rx, &mut backoff),
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
            mac_token_next: None,
            phone_token: "phonetok".into(),
            secrets_error: None,
            secrets_lost: false,
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
    fn post_connect_frames_put_revocations_first_then_authorize_then_label() {
        let frames = post_connect_frames(&cfg(vec!["old-a", "old-b"]), &[]);
        assert_eq!(
            frames,
            vec![
                json!({ "type": "revoke_phone", "phoneToken": "old-a" }),
                json!({ "type": "revoke_phone", "phoneToken": "old-b" }),
                json!({ "type": "authorize_phone", "phoneToken": "phonetok" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
            ]
        );
    }

    /// The burst is paced in batches, skips a token revoked meanwhile, and confirms
    /// revocations only through the ping sent behind them.
    #[tokio::test]
    async fn the_burst_is_paced_rechecked_and_revocations_await_their_pong() {
        let hub = Arc::new(ControlHub::new());
        hub.remote.lock().unwrap().cfg = cfg(vec![]);
        let mut frames: Vec<Value> = (0..BURST_BATCH + 1)
            .map(|i| json!({ "type": "revoke_phone", "phoneToken": format!("old-{i}") }))
            .collect();
        frames.push(json!({ "type": "authorize_phone", "phoneToken": "phonetok" }));
        frames.push(json!({ "type": "authorize_phone", "phoneToken": "gone-device", "label": "x" }));
        frames.push(json!({ "type": "set_label", "label": "stale" }));
        hub.remote.lock().unwrap().cfg.mac_label = "Current".into();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let acks: RevokeAcks = Arc::default();
        send_burst(hub.clone(), out, frames, acks.clone(), Duration::ZERO).await;
        let mut sent = Vec::new();
        while let Ok(m) = rx.try_recv() {
            sent.push(m);
        }
        let pings: Vec<&Message> = sent.iter().filter(|m| matches!(m, Message::Ping(_))).collect();
        assert_eq!(pings.len(), 2, "one confirmation ping per batch that revoked");
        let texts: Vec<Value> =
            sent.iter().filter_map(|m| if let Message::Text(t) = m { serde_json::from_str(t).ok() } else { None }).collect();
        assert!(!texts.iter().any(|f| f["phoneToken"] == "gone-device"), "a token no longer authorized is skipped");
        assert_eq!(texts.last().unwrap(), &json!({ "type": "set_label", "label": "Current" }));
        assert_eq!(acks.lock().unwrap().values().map(Vec::len).sum::<usize>(), BURST_BATCH + 1);
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
        fn renew_device(&self, device_id: &str, current: u32) -> Result<LiveKey, String> {
            self.calls.lock().unwrap().push(format!("renew {device_id} from {current}"));
            let now = now_ms();
            Ok(LiveKey {
                generation: current + 1,
                secret: DeviceSecret::from_bytes([(current + 1) as u8 + 10; 32]),
                issued_at_ms: now,
                expires_at_ms: now + KEY_LIFETIME_MS,
            })
        }
        fn confirm_generation(&self, device_id: &str, generation: u32) -> Result<bool, String> {
            self.calls.lock().unwrap().push(format!("confirm {device_id} {generation}"));
            Ok(true)
        }
        fn trusted_nodes(&self) -> Vec<String> {
            vec!["mac1".into(), "server-1".into()]
        }
    }

    const PHONE: [u8; 16] = [5; 16];

    /// A hub whose book holds one device with `keys` (generation, secret byte, issued
    /// at), legacy retired, with a recording sink.
    fn sealed_hub_with(keys: &[(u32, u8, i64)]) -> (Arc<ControlHub>, Arc<RecordingDeviceSink>) {
        let hub = Arc::new(ControlHub::new());
        let mut c = cfg(vec![]);
        c.phone_token = String::new();
        hub.remote.lock().unwrap().cfg = c;
        *hub.channel.lock().unwrap() = NodeChannel::new("mac1".to_string());
        hub.set_devices(vec![LiveDevice {
            device_id: DeviceId::from_bytes(PHONE).to_b64(),
            label: "iPhone".into(),
            relay_token: "rt-phone".into(),
            keys: keys
                .iter()
                .map(|&(generation, byte, issued)| LiveKey {
                    generation,
                    secret: DeviceSecret::from_bytes([byte; 32]),
                    issued_at_ms: issued,
                    expires_at_ms: issued + KEY_LIFETIME_MS,
                })
                .collect(),
            push: vec![],
        }]);
        let sink = Arc::new(RecordingDeviceSink::default());
        hub.set_device_sink(sink.clone());
        (hub, sink)
    }

    /// Handshake as the phone on `cid` with generation `g` (secret byte `byte`) and
    /// prove the session (`subscribe` → `ready`); returns the session and `ready`.
    async fn paired_session(
        hub: &Arc<ControlHub>,
        out: &mpsc::UnboundedSender<Message>,
        rx: &mut mpsc::UnboundedReceiver<Message>,
        slots: &Arc<Semaphore>,
        cid: &str,
        g: u32,
        byte: u8,
    ) -> (Session, Value) {
        let rng = SystemRandom::new();
        let (hs, hello) = PhoneHandshake::start(DeviceId::from_bytes(PHONE), g, &rng).unwrap();
        let mut f = hello.to_frame();
        f["_cid"] = json!(cid);
        on_phone_frame(hub, out, slots, false, f.to_string());
        let accept = next_frame(rx).await;
        assert_eq!(accept["type"], "e2e_accept", "{accept}");
        let key = DeviceSecret::from_bytes([byte; 32]).node_key("mac1");
        let mut s = hs.finish(&Accept::from_frame(&accept).unwrap(), "mac1", &key).unwrap();
        let mut f = s.seal_json(&json!({"type": "subscribe"})).unwrap().to_frame();
        f["_cid"] = json!(cid);
        on_phone_frame(hub, out, slots, false, f.to_string());
        let reply = next_frame(rx).await;
        let ready = s.open_json(&Sealed::from_frame(&reply).unwrap()).unwrap();
        (s, ready)
    }

    async fn rpc_on(
        hub: &Arc<ControlHub>,
        out: &mpsc::UnboundedSender<Message>,
        rx: &mut mpsc::UnboundedReceiver<Message>,
        slots: &Arc<Semaphore>,
        s: &mut Session,
        cid: &str,
        method: &str,
    ) -> Value {
        let mut f = s.seal_json(&json!({"type": "rpc", "id": "r", "method": method, "params": {}})).unwrap().to_frame();
        f["_cid"] = json!(cid);
        on_phone_frame(hub, out, slots, false, f.to_string());
        let reply = next_frame(rx).await;
        s.open_json(&Sealed::from_frame(&reply).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn the_bootstrap_key_is_renewed_at_once_and_retired_once_the_new_one_is_used() {
        let (hub, sink) = sealed_hub_with(&[(1, 6, now_ms())]);
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        let (mut s1, ready) = paired_session(&hub, &out, &mut rx, &slots, "c1", 1, 6).await;
        assert!(ready["device"]["renew_after_ms"].as_i64().unwrap() <= now_ms(), "due at once");
        let r = rpc_on(&hub, &out, &mut rx, &slots, &mut s1, "c1", "renew_device").await;
        assert_eq!((r["result"]["renewed"].clone(), r["result"]["generation"].clone()), (json!(true), json!(2)));
        let secret = r["result"]["secret"].as_str().unwrap().to_string();
        // Asked again from generation 1 (the answer was lost): the SAME key, no new mint.
        let again = rpc_on(&hub, &out, &mut rx, &slots, &mut s1, "c1", "renew_device").await;
        assert_eq!(again["result"]["secret"], json!(secret));
        assert_eq!(sink.calls.lock().unwrap().iter().filter(|c| c.starts_with("renew ")).count(), 1);
        // The phone uses generation 2: generation 1 is pruned and its sessions end.
        let byte = DeviceSecret::from_b64(&secret).unwrap();
        assert_eq!(byte, DeviceSecret::from_bytes([12; 32]));
        let (_s2, _) = paired_session(&hub, &out, &mut rx, &slots, "c2", 2, 12).await;
        let id = DeviceId::from_bytes(PHONE).to_b64();
        assert!(sink.calls.lock().unwrap().contains(&format!("confirm {id} 2")));
        assert_eq!(hub.devices()[0].keys.iter().map(|k| k.generation).collect::<Vec<_>>(), vec![2]);
        assert!(!hub.channel.lock().unwrap().has_session("c1"), "the old secret's session is gone");
    }

    #[tokio::test]
    async fn an_older_generation_never_mints_a_new_key() {
        // The phone already uses generation 3 (2 kept for it); a copy of generation 2
        // asks once 3 is due: refused, nothing minted.
        let long_ago = now_ms() - 40 * 24 * 3600 * 1000;
        let (hub, sink) = sealed_hub_with(&[(2, 7, long_ago), (3, 8, long_ago)]);
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        // Note: generation 2 is the one an UNUSED generation 3 replaces — re-delivery,
        // not a mint. Once 3 is used (pruned to [3]), a 2 session can't even connect.
        let (mut s2, _) = paired_session(&hub, &out, &mut rx, &slots, "c1", 2, 7).await;
        let r = rpc_on(&hub, &out, &mut rx, &slots, &mut s2, "c1", "renew_device").await;
        assert_eq!(r["result"]["generation"], 3, "re-delivered, not minted");
        assert!(!sink.calls.lock().unwrap().iter().any(|c| c.starts_with("renew ")));
        let (mut s3, _) = paired_session(&hub, &out, &mut rx, &slots, "c2", 3, 8).await;
        assert!(!hub.channel.lock().unwrap().has_session("c1"));
        let r = rpc_on(&hub, &out, &mut rx, &slots, &mut s3, "c2", "renew_device").await;
        assert_eq!(r["result"]["generation"], 4, "the current holder renews");
    }

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
            // Generation 2: past the bootstrap key, not due for renewal.
            keys: vec![LiveKey {
                generation: 2,
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
        let (hs, hello) = PhoneHandshake::start(DeviceId::from_bytes(PHONE), 2, &rng).unwrap();
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
                json!({ "type": "revoke_phone", "phoneToken": "old" }),
                json!({ "type": "authorize_phone", "phoneToken": "rt-1", "label": "iPhone" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
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
        assert!(sink.calls.lock().unwrap().is_empty(), "an accepted hello proves nothing: not 'seen' yet");

        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "subscribe"}));
        let ready = open_reply(&mut phone, &mut rx).await;
        assert_eq!(sink.calls.lock().unwrap().as_slice(), [format!("seen {}", DeviceId::from_bytes(PHONE).to_b64())]);
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["label"], "MacBook Pro");
        assert_eq!(ready["device"]["label"], "iPhone");
        assert_eq!(ready["device"]["generation"], 2);
        assert!(ready["device"]["renew_after_ms"].as_i64().unwrap() > now_ms());
        assert_eq!(ready["caps"], json!(SEALED_CAPS));
        assert_eq!(ready["nodes"], json!(["mac1", "server-1"]));

        // The phone catalogue answers sealed (no front in a unit test: an error, sealed).
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r1", "method": "rewind", "params": {}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["type"], "rpc_error");
        assert_eq!(r["error"], "unknown or unavailable method: rewind");

        // Too early to renew: the current generation, unchanged.
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r2", "method": "renew_device", "params": {}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["result"]["renewed"], false);
        assert_eq!(r["result"]["generation"], 2);

        // A push subscription is validated, persisted, then live.
        let point = PhoneHandshake::start(DeviceId::from_bytes(PHONE), 1, &SystemRandom::new()).unwrap().1.ephemeral;
        let sub = json!({"endpoint": "https://web.push.apple.com/x", "keys": {"p256dh": b64::encode(&point), "auth": b64::encode(&[1u8; 16])}});
        send_sealed_as_phone(&hub, &out, &slots, &mut phone, json!({"type": "rpc", "id": "r3", "method": "push_register", "params": {"subscription": sub}}));
        let r = open_reply(&mut phone, &mut rx).await;
        assert_eq!(r["result"]["registered"], true);
        assert_eq!(hub.push_targets(push::PushState::Review, "mac1", now_ms()).len(), 1);
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

    /// Persists push removals in a real store, as `DeviceStoreSink` does (which needs
    /// a running app).
    struct StoreSink(crate::store::Store);

    impl DeviceSink for StoreSink {
        fn device_seen(&self, _device_id: &str, _at_ms: i64) {}
        fn forget_device(&self, _device_id: &str) -> Result<(), String> {
            Err("unused".into())
        }
        fn register_push(&self, _device_id: &str, _push: &LivePush) -> Result<(), String> {
            Err("unused".into())
        }
        fn set_push_prefs(&self, _device_id: &str, _prefs: push::PushPrefs) -> Result<(), String> {
            Err("unused".into())
        }
        fn unregister_push(&self, device_id: &str, endpoint: Option<&str>) -> Result<usize, String> {
            self.0.delete_remote_device_push(device_id, endpoint).map_err(|e| e.to_string())
        }
        fn renew_device(&self, _device_id: &str, _current: u32) -> Result<LiveKey, String> {
            Err("unused".into())
        }
        fn confirm_generation(&self, _device_id: &str, _generation: u32) -> Result<bool, String> {
            Ok(false)
        }
        fn trusted_nodes(&self) -> Vec<String> {
            vec![]
        }
    }

    #[tokio::test]
    async fn push_gone_prunes_that_subscription_on_every_device_and_nothing_else() {
        use crate::ipc::remote_devices::load_live_devices;
        use crate::store::{RemoteDevice, RemoteDeviceKey, RemoteDevicePush, Store};
        const GONE: &str = "https://web.push.apple.com/gone";
        const KEPT: &str = "https://web.push.apple.com/kept";
        const OTHER: &str = "https://fcm.googleapis.com/fcm/send/other";

        // Two devices in the store: the phone, and the same browser paired a second
        // time — both hold its subscription, each also holds another one.
        let store = Store::open_in_memory().unwrap();
        let now = now_ms();
        let (phone, twin) = (DeviceId::from_bytes(PHONE).to_b64(), DeviceId::from_bytes([8; 16]).to_b64());
        for (id, byte) in [(&phone, 6u8), (&twin, 8)] {
            let key = RemoteDeviceKey {
                generation: 2,
                secret: DeviceSecret::from_bytes([byte; 32]).to_b64(),
                issued_at: now,
                expires_at: now + KEY_LIFETIME_MS,
            };
            store
                .insert_remote_device(&RemoteDevice {
                    device_id: id.clone(),
                    label: "iPhone".into(),
                    relay_token: format!("rt-{byte}"),
                    added_at: now,
                    last_seen_at: None,
                    keys: vec![key],
                    push: vec![],
                })
                .unwrap();
        }
        let point = PhoneHandshake::start(DeviceId::from_bytes(PHONE), 1, &SystemRandom::new()).unwrap().1.ephemeral;
        let sub = |endpoint: &str| RemoteDevicePush {
            endpoint: endpoint.into(),
            p256dh: b64::encode(&point),
            auth: b64::encode(&[1u8; 16]),
            prefs: "{}".into(),
        };
        for (n, (id, endpoint)) in [(&phone, GONE), (&phone, KEPT), (&twin, GONE), (&twin, OTHER)].into_iter().enumerate() {
            store.upsert_remote_device_push(id, &sub(endpoint), n as i64).unwrap();
        }

        let hub = Arc::new(ControlHub::new());
        let mut c = cfg(vec![]);
        c.phone_token = String::new();
        hub.remote.lock().unwrap().cfg = c;
        *hub.channel.lock().unwrap() = NodeChannel::new("mac1".to_string());
        hub.set_devices(load_live_devices(&store));
        let sink = Arc::new(StoreSink(store));
        hub.set_device_sink(sink.clone());
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let slots = Arc::new(Semaphore::new(MAX_INFLIGHT_RPCS));
        let _phone_session = connect_phone(&hub, &out, &mut rx, &slots).await;
        let endpoints = |book: Vec<LiveDevice>| -> Vec<Vec<String>> {
            book.iter().map(|d| d.push.iter().map(|p| p.endpoint.clone()).collect()).collect()
        };
        let all = vec![vec![GONE.to_string(), KEPT.to_string()], vec![GONE.to_string(), OTHER.to_string()]];
        assert_eq!(endpoints(hub.devices()), all);

        // Malformed, or naming no subscription here: nothing changes.
        let gone = push::endpoint_hash(GONE);
        for f in [
            json!({"type": "push_gone", "reason": "expired"}),
            json!({"type": "push_gone", "endpoint": GONE, "reason": "expired"}),
            json!({"type": "push_gone", "endpoint": gone.to_uppercase(), "reason": "expired"}),
            json!({"type": "push_gone", "endpoint": push::endpoint_hash("https://web.push.apple.com/never"), "reason": "unknown"}),
        ] {
            on_phone_frame(&hub, &out, &slots, false, f.to_string());
        }
        assert_eq!(endpoints(hub.devices()), all);
        assert_eq!(endpoints(load_live_devices(&sink.0)), all);

        // Any reason prunes, a future one too.
        on_phone_frame(&hub, &out, &slots, false, json!({"type": "push_gone", "endpoint": gone, "reason": "a_new_reason"}).to_string());
        let left = vec![vec![KEPT.to_string()], vec![OTHER.to_string()]];
        assert_eq!(endpoints(hub.devices()), left);
        assert_eq!(endpoints(load_live_devices(&sink.0)), left, "persisted: a relaunch loads the book without it");
        // Only the subscription went: the devices, their keys and the session stay.
        assert_eq!(hub.devices().iter().map(|d| d.keys.len()).collect::<Vec<_>>(), vec![1, 1]);
        assert!(hub.channel.lock().unwrap().has_session("c1"));
        assert!(rx.try_recv().is_err(), "nothing is answered to the relay");

        // The next event pushes to the two subscriptions left, and only to them.
        send_pushes(&hub, &out, "mac1", &json!({"kind": "needs_attention", "conversationId": "c"}), &SystemRandom::new());
        let mut sent = Vec::new();
        while let Ok(Message::Text(t)) = rx.try_recv() {
            let f: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(f["type"], "push_send");
            sent.push(f["endpoint"].as_str().unwrap().to_string());
        }
        assert_eq!(sent, vec![push::endpoint_hash(KEPT), push::endpoint_hash(OTHER)]);
    }

    // -- the link against a scripted relay (loopback) --------------------------------

    use crate::appmcp::MacTokenSink;
    use futures_util::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio_tungstenite::tungstenite::handshake::server::Request as ServerRequest;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    type RelaySide = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// Short clocks, so a silent relay is noticed in a test's time.
    const FAST: LinkTimings = LinkTimings {
        connect: Duration::from_secs(2),
        heartbeat: Duration::from_millis(100),
        read_idle: Duration::from_millis(400),
    };

    /// A relay on loopback: each connection it takes goes to `on_connect` with its index
    /// and the bearer token it was dialed with.
    async fn scripted_relay<F>(on_connect: F) -> u16
    where
        F: Fn(usize, RelaySide, String) -> BoxFuture<'static, ()> + Send + Sync + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for n in 0.. {
                let Ok((stream, _)) = listener.accept().await else { return };
                let mut token = String::new();
                let callback = |req: &ServerRequest, resp| {
                    token = req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.strip_prefix("Bearer "))
                        .unwrap_or_default()
                        .to_string();
                    Ok(resp)
                };
                let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { continue };
                tokio::spawn(on_connect(n, ws, token));
            }
        });
        port
    }

    async fn refuse(mut ws: RelaySide) {
        let _ = ws.send(Message::Text(json!({"type": "error", "error": "macId already claimed"}).to_string())).await;
        let _ = ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: "auth".into() })).await;
    }

    async fn welcome(ws: &mut RelaySide, caps: &[&str]) {
        let frame = json!({"type": "welcome", "role": "mac", "macId": "mac1", "caps": caps});
        ws.send(Message::Text(frame.to_string())).await.unwrap();
    }

    /// Read (which also answers pings) until the Mac goes away, handing each JSON frame to `seen`.
    async fn read_all(mut ws: RelaySide, seen: mpsc::UnboundedSender<Value>) {
        while let Some(Ok(m)) = ws.next().await {
            if let Message::Text(t) = m {
                if let Ok(v) = serde_json::from_str::<Value>(&t) {
                    let _ = seen.send(v);
                }
            }
        }
    }

    #[derive(Default)]
    struct RecordingTokenSink(StdMutex<Vec<(String, Option<String>)>>);

    impl MacTokenSink for RecordingTokenSink {
        fn persist_mac_tokens(&self, current: &str, next: Option<&str>) -> Result<(), String> {
            self.0.lock().unwrap().push((current.to_string(), next.map(str::to_string)));
            Ok(())
        }
    }

    /// A hub on the relay at `port`, its config `cfg` (as `apply_remote` would install it).
    fn hub_on(port: u16, next: Option<&str>) -> (Arc<ControlHub>, RemoteConfig, Arc<RecordingTokenSink>) {
        let hub = Arc::new(ControlHub::new());
        let mut c = cfg(vec![]);
        c.relay_url = format!("http://127.0.0.1:{port}");
        c.mac_token_next = next.map(str::to_string);
        {
            let mut r = hub.remote.lock().unwrap();
            r.cfg = c.clone();
            r.event_cursor = Some(hub.events.latest_cursor());
        }
        let sink = Arc::new(RecordingTokenSink::default());
        hub.set_mac_token_sink(sink.clone());
        (hub, c, sink)
    }

    async fn until(what: &str, mut cond: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !cond() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    /// Item 3: `1008 "auth"` is a REFUSAL (the relay's own words kept), never a drop to
    /// redial at once; the link never counted as up.
    #[tokio::test]
    async fn a_refused_token_is_a_refusal_and_the_link_never_counts_as_up() {
        let port = scripted_relay(|_, ws, _| Box::pin(refuse(ws))).await;
        let (hub, c, _) = hub_on(port, None);
        let (_stop_tx, mut stop) = watch::channel(false);
        let mut backoff = Duration::from_secs(1);
        let end = tokio::time::timeout(Duration::from_secs(5), dial(&hub, &c, &FAST, &mut stop, &mut backoff)).await.unwrap();
        assert_eq!(end, Err(LinkError::Refused("macId already claimed".into())));
        assert!(!hub.remote_status().connected);
    }

    /// Item 3: after a refusal `serve` says so (refused, the relay's reason) and waits
    /// minutes, not a backoff, before trying again.
    #[tokio::test]
    async fn serve_says_it_was_refused_and_does_not_hammer_the_relay() {
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = tries.clone();
        let port = scripted_relay(move |_, ws, _| {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(refuse(ws))
        })
        .await;
        let (hub, c, _) = hub_on(port, None);
        let (stop_tx, stop) = watch::channel(false);
        let task = tokio::spawn(serve(hub.clone(), c, stop));
        until("the refusal", || hub.remote_status().refused).await;
        let st = hub.remote_status();
        assert!(!st.connected);
        let error = st.error.unwrap_or_default();
        assert!(
            error.contains(&format!("refused this {MACHINE}'s credentials")) && error.contains("macId already claimed"),
            "{error}"
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(tries.load(Ordering::SeqCst), 1, "no retry within seconds of a refusal");
        stop_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    }

    /// Item 6: a rotation whose answer was lost — the relay refuses the old token and takes
    /// the next one, which the welcome then settles (saved, and the token the hub uses).
    #[tokio::test]
    async fn a_refused_token_falls_back_to_the_next_one_and_settles_it() {
        let (seen_tx, _seen) = mpsc::unbounded_channel();
        let port = scripted_relay(move |_, mut ws, token| {
            let seen = seen_tx.clone();
            Box::pin(async move {
                if token != "next-token-0123456789" {
                    return refuse(ws).await;
                }
                welcome(&mut ws, &["rotate_mac_token"]).await;
                read_all(ws, seen).await;
            })
        })
        .await;
        let (hub, c, sink) = hub_on(port, Some("next-token-0123456789"));
        let (stop_tx, mut stop) = watch::channel(false);
        let link = {
            let hub = hub.clone();
            tokio::spawn(async move { dial(&hub, &c, &FAST, &mut stop, &mut Duration::from_secs(1)).await })
        };
        until("the link", || hub.remote_status().connected).await;
        assert_eq!(hub.mac_tokens(), ("next-token-0123456789".to_string(), None));
        assert_eq!(sink.0.lock().unwrap().as_slice(), [("next-token-0123456789".to_string(), None)]);
        assert!(!hub.remote_status().rotation_pending);
        stop_tx.send(true).unwrap();
        assert_eq!(link.await.unwrap(), Ok(()));
    }

    /// Item 6: Settings' rotation sends the next token, waits for the relay's answer, then
    /// settles it — the link stays up, phones untouched.
    #[tokio::test]
    async fn a_rotation_is_settled_once_the_relay_confirms_it() {
        let (seen_tx, mut seen) = mpsc::unbounded_channel::<Value>();
        let port = scripted_relay(move |_, mut ws, _| {
            let seen = seen_tx.clone();
            Box::pin(async move {
                welcome(&mut ws, &["rotate_mac_token"]).await;
                while let Some(Ok(m)) = ws.next().await {
                    let Message::Text(t) = m else { continue };
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["type"] == "rotate_mac_token" {
                        let _ = seen.send(v);
                        let ok = json!({"type": "mac_token_rotated", "ok": true});
                        ws.send(Message::Text(ok.to_string())).await.unwrap();
                    }
                }
            })
        })
        .await;
        let (hub, c, sink) = hub_on(port, None);
        let (stop_tx, mut stop) = watch::channel(false);
        let link = {
            let hub = hub.clone();
            tokio::spawn(async move { dial(&hub, &c, &FAST, &mut stop, &mut Duration::from_secs(1)).await })
        };
        until("the link", || hub.remote_status().can_rotate).await;
        hub.rotate_mac_token("rotated-token-0123456789".into()).await.unwrap();
        assert_eq!(seen.recv().await.unwrap()["macToken"], "rotated-token-0123456789");
        assert_eq!(hub.mac_tokens(), ("rotated-token-0123456789".to_string(), None));
        assert_eq!(sink.0.lock().unwrap().as_slice(), [("rotated-token-0123456789".to_string(), None)]);
        assert!(hub.remote_status().connected, "the link stays up");
        stop_tx.send(true).unwrap();
        assert_eq!(link.await.unwrap(), Ok(()));
    }

    /// Item 6: a rotation left pending (Settings timed out, the app restarted) is resent at
    /// the next welcome — the relay still holding the current token — and settled.
    #[tokio::test]
    async fn a_pending_rotation_is_resumed_at_the_next_welcome() {
        let port = scripted_relay(move |_, mut ws, token| {
            Box::pin(async move {
                assert_eq!(token, "mactok", "dialed with the current token first");
                welcome(&mut ws, &["rotate_mac_token"]).await;
                while let Some(Ok(m)) = ws.next().await {
                    let Message::Text(t) = m else { continue };
                    if serde_json::from_str::<Value>(&t).unwrap()["type"] == "rotate_mac_token" {
                        ws.send(Message::Text(json!({"type": "mac_token_rotated", "ok": true}).to_string())).await.unwrap();
                    }
                }
            })
        })
        .await;
        let (hub, c, sink) = hub_on(port, Some("pending-token-0123456789"));
        let (stop_tx, mut stop) = watch::channel(false);
        let link = {
            let hub = hub.clone();
            tokio::spawn(async move { dial(&hub, &c, &FAST, &mut stop, &mut Duration::from_secs(1)).await })
        };
        until("the settled rotation", || !sink.0.lock().unwrap().is_empty()).await;
        assert_eq!(hub.mac_tokens(), ("pending-token-0123456789".to_string(), None));
        stop_tx.send(true).unwrap();
        assert_eq!(link.await.unwrap(), Ok(()));
    }

    /// Item 6: a relay that does not list `rotate_mac_token` is never sent the token (it
    /// would forward it to the phones).
    #[tokio::test]
    async fn a_relay_without_the_cap_is_never_sent_a_token() {
        let hub = Arc::new(ControlHub::new());
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        *hub.remote_out.lock().unwrap() = Some(out);
        hub.set_remote_welcomed(vec![]);
        hub.remote.lock().unwrap().cfg.mac_token_next = Some("next".into());
        let err = hub.rotate_mac_token("next".into()).await.unwrap_err();
        assert!(err.contains("can't rotate"), "{err}");
        hub.resume_mac_token_rotation();
        assert!(rx.try_recv().is_err(), "nothing was sent");
        assert!(!hub.remote_status().can_rotate);
    }

    /// Item 6: a rotation the relay refuses is dropped — saved without a next token — and
    /// Settings hears why.
    #[tokio::test]
    async fn a_refused_rotation_is_dropped_and_said() {
        let (hub, _, sink) = hub_on(1, Some("bad"));
        let (tx, rx) = tokio::sync::oneshot::channel();
        *hub.rotation_waiter.lock().unwrap() = Some(tx);
        hub.on_mac_token_rotated(false, Some("the new token must be 16 to 512 visible ASCII characters".into()));
        let err = rx.await.unwrap().unwrap_err();
        assert!(err.contains("16 to 512"), "{err}");
        assert_eq!(hub.mac_tokens(), ("mactok".to_string(), None));
        assert_eq!(sink.0.lock().unwrap().as_slice(), [("mactok".to_string(), None)]);
    }

    /// Item 5: a relay that goes silent (a half-open connection: no frame, no pong) ends
    /// the link after the read-idle timeout instead of holding it forever.
    #[tokio::test]
    async fn a_silent_relay_is_dropped_after_the_read_idle_timeout() {
        let port = scripted_relay(|_, mut ws, _| {
            Box::pin(async move {
                welcome(&mut ws, &[]).await;
                // Never read again: the Mac's pings go unanswered.
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(ws);
            })
        })
        .await;
        let (hub, c, _) = hub_on(port, None);
        let (_stop_tx, mut stop) = watch::channel(false);
        let end = tokio::time::timeout(Duration::from_secs(5), dial(&hub, &c, &FAST, &mut stop, &mut Duration::from_secs(1)))
            .await
            .expect("the silence is noticed");
        match end {
            Err(LinkError::Dropped(e)) => assert!(e.contains("no word from the relay"), "{e}"),
            other => panic!("expected a drop, got {other:?}"),
        }
        assert!(!hub.remote_status().connected);
    }

    /// Item 5: a relay that takes the TCP connection and never answers the upgrade is given
    /// up on after the connect timeout.
    #[tokio::test]
    async fn a_relay_that_never_answers_the_upgrade_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _hold = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let (hub, c, _) = hub_on(port, None);
        let (_stop_tx, mut stop) = watch::channel(false);
        let timings = LinkTimings { connect: Duration::from_millis(300), ..FAST };
        let end = tokio::time::timeout(Duration::from_secs(5), dial(&hub, &c, &timings, &mut stop, &mut Duration::from_secs(1)))
            .await
            .expect("the connect gives up");
        assert!(matches!(end, Err(LinkError::Dropped(ref e)) if e.contains("did not answer")), "{end:?}");
    }

    /// Item 2: an event published while the link was down is sent once it is back, and the
    /// relay's pong behind it moves the confirmed cursor (the next link starts after it).
    #[tokio::test]
    async fn an_event_published_while_the_link_was_down_is_sent_and_confirmed() {
        let (seen_tx, mut seen) = mpsc::unbounded_channel::<Value>();
        let port = scripted_relay(move |_, mut ws, _| {
            let seen = seen_tx.clone();
            Box::pin(async move {
                welcome(&mut ws, &[]).await;
                read_all(ws, seen).await;
            })
        })
        .await;
        let (hub, c, _) = hub_on(port, None);
        // The link is down: the event waits in the journal.
        hub.events.publish("needs_attention", "c1", "Conv 1", json!({"tool": "Bash"}));
        let (stop_tx, mut stop) = watch::channel(false);
        let link = {
            let hub = hub.clone();
            tokio::spawn(async move { dial(&hub, &c, &FAST, &mut stop, &mut Duration::from_secs(1)).await })
        };
        let event = loop {
            let f = tokio::time::timeout(Duration::from_secs(5), seen.recv()).await.unwrap().unwrap();
            if f["type"] == "event" {
                break f;
            }
        };
        assert_eq!(event["event"]["conversationId"], "c1");
        assert_eq!(event["event"]["kind"], "needs_attention");
        until("the relay's confirmation", || hub.remote.lock().unwrap().event_cursor == Some(1)).await;
        stop_tx.send(true).unwrap();
        assert_eq!(link.await.unwrap(), Ok(()));
    }

    #[test]
    fn close_codes_tell_a_refusal_from_a_drop() {
        let frame = |code: u16, reason: &'static str| CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        assert_eq!(close_error(Some(&frame(1008, "auth")), Some("macId already claimed".into())), LinkError::Refused("macId already claimed".into()));
        // An admin reset frees the claim: the same token takes it again — a drop.
        assert!(matches!(close_error(Some(&frame(1008, "reset")), None), LinkError::Dropped(_)));
        assert_eq!(
            close_error(Some(&frame(1013, "try again later")), Some("relay is full — try again later".into())),
            LinkError::Dropped("relay is full — try again later".into())
        );
        assert!(matches!(close_error(None, None), LinkError::Dropped(_)));
    }

    #[test]
    fn a_rate_limited_upgrade_is_said_plainly() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder().status(429).body(None).unwrap();
        let msg = upgrade_error(&tokio_tungstenite::tungstenite::Error::Http(response));
        assert!(msg.contains("429") && msg.contains("too many attempts"), "{msg}");
    }

    #[test]
    fn event_acks_round_trip_and_other_pings_are_not_acks() {
        assert_eq!(event_ack_cursor(&event_ack_payload(42)), Some(42));
        assert_eq!(event_ack_cursor(b"fd-revoke-0"), None);
        assert_eq!(event_ack_cursor(b""), None);
    }

    #[test]
    fn only_a_relay_listing_the_cap_rotates() {
        assert!(rotates_mac_token(Some(&["rotate_mac_token".to_string()])));
        assert!(!rotates_mac_token(Some(&[])));
        assert!(!rotates_mac_token(None));
    }
}
