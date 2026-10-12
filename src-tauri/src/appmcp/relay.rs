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
pub(crate) fn post_connect_frames(cfg: &RemoteConfig) -> Vec<Value> {
    let mut frames = vec![
        json!({ "type": "authorize_phone", "phoneToken": cfg.phone_token }),
        json!({ "type": "set_label", "label": cfg.mac_label }),
    ];
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

    let (mut write, mut read) = ws.split();
    // Authorize the current phone pairing token, publish this Mac's node label, and
    // flush any revocation still owed — see `post_connect_frames`'s doc. A
    // `revoke_phone` frame is reported to the hub — which durably clears it
    // from `pending_relay_phone_revocations` — ONLY once its own send actually
    // succeeded on THIS connected socket, never merely because this function
    // was reached (that was the bug: `ipc::commands::set_remote` used to clear
    // the queue the instant `apply_remote` had merely SPAWNED a reconnect
    // attempt, before it had even dialed, let alone sent anything).
    for frame in post_connect_frames(cfg) {
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

    // Push fleet events (turn finished / needs attention) to the phone(s).
    let events_task = {
        let hub = hub.clone();
        let out = out_tx.clone();
        let mut stop = stop.clone();
        tokio::spawn(async move {
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
                    if out.send(Message::Text(frame.to_string())).is_err() {
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
                Some(Ok(Message::Text(txt))) => on_phone_frame(hub, &out_tx, &rpc_slots, txt),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => break Err("relay connection closed".to_string()),
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e.to_string()),
            },
        }
    };

    hub.set_remote_connected(false);
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
    txt: String,
) {
    let Ok(msg) = serde_json::from_str::<Value>(&txt) else {
        return;
    };
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
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

    let def = tools::for_surface(Surface::Voice)
        .into_iter()
        .find(|t| t.name == method);
    let frame = match def {
        Some(def) => match hub.execute_tool(&def, &Caller::External, &params).await {
            Ok(v) => json!({ "type": "rpc_result", "id": id, "_cid": cid, "result": v }),
            Err(e) => json!({ "type": "rpc_error", "id": id, "_cid": cid, "error": e }),
        },
        None => json!({
            "type": "rpc_error", "id": id, "_cid": cid,
            "error": format!("unknown or unavailable method: {method}")
        }),
    };
    let _ = out.send(Message::Text(frame.to_string()));
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
        let frames = post_connect_frames(&cfg(vec!["old-a", "old-b"]));
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
        let frames = post_connect_frames(&cfg(vec![]));
        assert_eq!(
            frames,
            vec![
                json!({ "type": "authorize_phone", "phoneToken": "phonetok" }),
                json!({ "type": "set_label", "label": "MacBook Pro" }),
            ]
        );
    }
}
