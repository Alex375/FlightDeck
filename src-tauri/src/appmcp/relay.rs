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
    // Authorize the current phone pairing token with the relay.
    let _ = write
        .send(Message::Text(
            json!({ "type": "authorize_phone", "phoneToken": cfg.phone_token }).to_string(),
        ))
        .await;

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
}
