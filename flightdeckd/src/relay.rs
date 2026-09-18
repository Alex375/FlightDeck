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

use crate::rpc;
use crate::session::{PhoneAccess, SessionManager};
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

    // Publish this link and snapshot the phone access in ONE critical
    // section: a concurrent add/remove then lands live on this link or in the
    // snapshot. The burst replays the snapshot PACED (the relay drops frames
    // past its 60-frame bucket), re-checking every frame against the live
    // state as it goes out — so a phone removed meanwhile is never
    // re-authorized after its live revoke. The guard unpublishes the link
    // however this returns.
    let (_published, keys) = {
        let phones = manager.phones.lock().expect("phones lock");
        *manager.relay_out.lock().expect("relay_out lock") = Some(out_tx.clone());
        (RelayOutGuard { manager, tx: out_tx.clone() }, burst_keys(&phones))
    };
    let burst = tokio::spawn(send_burst(manager.clone(), out_tx.clone(), keys, cfg.label.clone(), BURST_PAUSE));

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
    Label,
}

/// What every (re)connect sends: revocations of the tombstoned tokens (the
/// relay keeps authorizations across reconnects, so a revoke that never
/// landed must be retried), authorizations of the live ones, then the node's
/// label — last.
fn burst_keys(phones: &PhoneAccess) -> Vec<BurstKey> {
    let mut keys: Vec<BurstKey> = phones.revoked.iter().map(|t| BurstKey::Revoke(t.clone())).collect();
    keys.extend(phones.tokens.iter().map(|p| BurstKey::Authorize(p.token.clone())));
    keys.push(BurstKey::Label);
    keys
}

/// Send the burst in batches of at most BURST_BATCH frames, `pause` apart.
/// Each frame is re-checked against the live phone access under its lock
/// (the same lock live add/remove send under): a token revoked meanwhile is
/// not authorized, a tombstone cleared by a re-add is not revoked, and the
/// current label is used.
async fn send_burst(
    manager: Arc<SessionManager>,
    out: mpsc::UnboundedSender<Message>,
    keys: Vec<BurstKey>,
    label: String,
    pause: Duration,
) {
    for (i, batch) in keys.chunks(BURST_BATCH).enumerate() {
        if i > 0 {
            tokio::time::sleep(pause).await;
        }
        let phones = manager.phones.lock().expect("phones lock");
        for key in batch {
            let frame = match key {
                BurstKey::Revoke(t) if phones.revoked.contains(t) => {
                    json!({"type": "revoke_phone", "phoneToken": t})
                }
                BurstKey::Authorize(t) => match phones.tokens.iter().find(|p| &p.token == t) {
                    Some(p) => json!({"type": "authorize_phone", "phoneToken": p.token, "label": p.label}),
                    None => continue,
                },
                BurstKey::Label => json!({"type": "set_label", "label": label}),
                BurstKey::Revoke(_) => continue,
            };
            if out.send(Message::Text(frame.to_string())).is_err() {
                return; // the link is gone
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

    use crate::config::PhoneToken;
    use tokio::net::TcpListener;

    #[test]
    fn burst_revokes_then_authorizes_then_labels() {
        let phones = PhoneAccess {
            tokens: vec![PhoneToken { token: "a".into(), label: "iPhone".into() }],
            revoked: vec!["gone".into()],
        };
        assert_eq!(
            burst_keys(&phones),
            vec![BurstKey::Revoke("gone".into()), BurstKey::Authorize("a".into()), BurstKey::Label]
        );
    }

    fn crowded_manager(revoked: usize, tokens: usize) -> Arc<SessionManager> {
        let m = crate::testutil::test_manager(crate::testutil::test_cfg());
        {
            let mut p = m.phones.lock().unwrap();
            p.revoked = (0..revoked).map(|i| format!("r{i}")).collect();
            p.tokens = (0..tokens).map(|i| PhoneToken { token: format!("t{i}"), label: String::new() }).collect();
        }
        m
    }

    async fn collect_burst(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<(tokio::time::Instant, Value)> {
        let mut got = Vec::new();
        loop {
            let Some(Message::Text(t)) = rx.recv().await else { panic!("burst ended without set_label") };
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
        tokio::spawn(send_burst(m.clone(), tx, keys, "node".into(), BURST_PAUSE));
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
    }

    #[tokio::test(start_paused = true)]
    async fn a_phone_removed_mid_burst_is_not_reauthorized() {
        let m = crowded_manager(0, 30);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let keys = burst_keys(&m.phones.lock().unwrap());
        tokio::spawn(send_burst(m.clone(), tx, keys, "node".into(), BURST_PAUSE));
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
    async fn mock_relay() -> (String, mpsc::UnboundedReceiver<(usize, Value)>, mpsc::UnboundedSender<()>) {
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
                                let _ = frames_tx.send((conn, serde_json::from_str(&t).unwrap()));
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
        cfg.phone_tokens = vec![PhoneToken { token: "seed".into(), label: "old".into() }];
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

        // Mid-connection changes reach the relay on the SAME connection.
        let m2 = m.clone();
        assert!(tokio::task::spawn_blocking(move || m2.add_phone_token("pt-live", "Pixel")).await.unwrap().unwrap());
        assert_eq!(next(&mut frames).await, (c1, json!({"type": "authorize_phone", "phoneToken": "pt-live", "label": "Pixel"})));
        let m2 = m.clone();
        assert!(tokio::task::spawn_blocking(move || m2.remove_phone_token("seed")).await.unwrap().unwrap());
        assert_eq!(next(&mut frames).await, (c1, json!({"type": "revoke_phone", "phoneToken": "seed"})));

        // A new connection replays the CURRENT state, set_label exactly once.
        drop_conn.send(()).unwrap();
        let (c2, b2) = burst(&mut frames).await;
        assert_eq!(c2, c1 + 1);
        assert_eq!(
            b2,
            vec![
                json!({"type": "revoke_phone", "phoneToken": "gone"}),
                json!({"type": "revoke_phone", "phoneToken": "seed"}),
                json!({"type": "authorize_phone", "phoneToken": "pt-live", "label": "Pixel"}),
                json!({"type": "set_label", "label": "node-x"}),
            ]
        );
        assert!(m.relay_out.lock().unwrap().is_some());

        relay.abort();
        let _ = relay.await;
        assert!(m.relay_out.lock().unwrap().is_none(), "a dead link stayed published");
    }

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
