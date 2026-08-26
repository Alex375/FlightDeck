//! The relay client: the daemon presents itself to the Railway relay as a
//! "mac" node so phones reach it DIRECTLY (no Mac in the data path). Ported
//! from tosse-code appmcp/relay.rs: outbound WS, `authorize_phone` on every
//! (re)connect, single-writer channel, 30 s heartbeat, `_cid` echo on replies,
//! events broadcast without `_cid`, reconnect with 1 s → ×2 → 30 s backoff.

use crate::rpc;
use crate::session::SessionManager;
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

pub fn ws_url(cfg_relay: &str, mac_id: &str, mac_token: &str) -> String {
    let base = cfg_relay.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/mac?macId={mac_id}&token={mac_token}")
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
    let url = ws_url(&cfg.relay_url, &cfg.mac_id, &cfg.mac_token);
    info!("connecting to relay {}", cfg.relay_url);
    let (ws, _) = tokio_tungstenite::connect_async(&url).await?;
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

    // (Re-)authorize every configured phone.
    for p in &cfg.phone_tokens {
        let frame = json!({"type": "authorize_phone", "phoneToken": p.token, "label": p.label});
        let _ = out_tx.send(Message::Text(frame.to_string()));
    }

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

    // Push events (turn_completed / needs_attention / …) to all phones.
    let events = {
        let out_tx = out_tx.clone();
        let mut rx = manager.events_tx.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if out_tx.send(Message::Text(ev.to_frame())).is_err() {
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
    hb.abort();
    events.abort();
    drop(out_tx);
    writer.abort();
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_upgrades_scheme() {
        assert_eq!(
            ws_url("https://relay.example.app/", "m1", "t1"),
            "wss://relay.example.app/mac?macId=m1&token=t1"
        );
        assert_eq!(
            ws_url("http://localhost:8080", "m", "t"),
            "ws://localhost:8080/mac?macId=m&token=t"
        );
    }
}
