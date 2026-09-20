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
//! - We connect to `wss://<relay>/mac?macId=<id>&token=<macToken>`.
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

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use super::{tools, Caller, ControlHub, RemoteConfig, Surface};

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

/// Build the `wss://…/mac?…` control URL from the stored relay base (an http(s)
/// or ws(s) origin). `mac_id` and `mac_token` are uuids, so they need no escaping.
fn to_ws_url(base: &str, mac_id: &str, mac_token: &str) -> Result<String, String> {
    let b = base.trim().trim_end_matches('/');
    let ws = if let Some(rest) = b.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = b.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if b.starts_with("wss://") || b.starts_with("ws://") {
        b.to_string()
    } else {
        return Err(format!("relay URL must start with http(s):// or ws(s)://: {base}"));
    };
    Ok(format!("{ws}/mac?macId={mac_id}&token={mac_token}"))
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
    let url = to_ws_url(&cfg.relay_url, &cfg.mac_id, &cfg.mac_token)?;
    let (ws, _resp) = tokio_tungstenite::connect_async(url.as_str())
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

    let result = loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break Ok(()); }
            }
            msg = read.next() => match msg {
                Some(Ok(Message::Text(txt))) => on_phone_frame(hub, &out_tx, txt),
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
/// the read loop); `ping` is answered immediately.
fn on_phone_frame(hub: &Arc<ControlHub>, out_tx: &mpsc::UnboundedSender<Message>, txt: String) {
    let Ok(msg) = serde_json::from_str::<Value>(&txt) else {
        return;
    };
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
        "rpc" => {
            let hub = hub.clone();
            let out = out_tx.clone();
            tokio::spawn(async move { dispatch_rpc(&hub, &out, msg).await });
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
            to_ws_url("https://relay.example.app/", "mac1", "tok1").unwrap(),
            "wss://relay.example.app/mac?macId=mac1&token=tok1"
        );
        assert_eq!(
            to_ws_url("http://127.0.0.1:8080", "m", "t").unwrap(),
            "ws://127.0.0.1:8080/mac?macId=m&token=t"
        );
        assert!(to_ws_url("ftp://nope", "m", "t").is_err());
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
