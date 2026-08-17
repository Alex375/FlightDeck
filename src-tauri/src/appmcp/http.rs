//! The voice bridge's loopback HTTP transport — MCP "streamable HTTP", the
//! subset a stateless tools-only server needs.
//!
//! Hand-rolled on `tokio::net::TcpListener` (the same approach as the TOSSE
//! OAuth callback listener in `tosse/mod.rs`) rather than pulling a web
//! framework: the surface is one endpoint, one client, on 127.0.0.1. Contract
//! served:
//! - `POST /mcp` (Bearer-token gated): body is one JSON-RPC message or a batch
//!   array → answered with the JSON response (or `202 Accepted` when the body
//!   was notifications only, per the streamable-HTTP spec).
//! - `GET /mcp` → `405` (we open no server-initiated SSE stream; compliant
//!   clients treat that as "no push channel" and move on).
//! - `DELETE /mcp` → `200` (stateless server: nothing to terminate).
//! - `GET /health` → liveness probe, `{"ok":true}`.
//!
//! One request per connection (`Connection: close`) keeps the loop trivial; a
//! voice agent's call cadence makes connection reuse worthless here. Requests
//! with an `Origin` header that is not localhost are rejected (DNS-rebinding
//! guard, per the MCP transport security notes) — a native client sends none.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::{router, Caller, ControlHub, Surface};

/// Caps: header block and body sizes. A voice client sends tiny payloads; the
/// caps only bound a misbehaving peer.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;

/// Hard lifetime of one connection, request to response. Must comfortably cover
/// the longest legitimate request — a `wait_for_events` long-poll (≤ 55 s) —
/// while guaranteeing that a stalled peer (connects and goes silent, or sends a
/// partial request) can never pin a task, an fd and its buffers forever.
const CONN_DEADLINE: Duration = Duration::from_secs(90);

/// Accept loop. Exits when `stop` flips (the Settings toggle turning the bridge
/// off, or a config change restarting it on another port). Every accepted
/// connection is ALSO raced against the same stop signal and a hard deadline:
/// "off" (and a token rotation, which restarts the listener) must sever
/// in-flight connections too — an already-open socket keeping the OLD token
/// serviceable after the switch says off would make the toggle a lie.
pub async fn serve(
    listener: TcpListener,
    hub: Arc<ControlHub>,
    token: String,
    mut stop: watch::Receiver<bool>,
) {
    let token = Arc::new(token);
    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { return; }
            }
            accepted = listener.accept() => {
                let Ok((stream, _addr)) = accepted else { continue };
                let hub = hub.clone();
                let token = token.clone();
                let mut stop = stop.clone();
                tokio::spawn(async move {
                    let stopped = async {
                        while !*stop.borrow() {
                            if stop.changed().await.is_err() {
                                break;
                            }
                        }
                    };
                    tokio::select! {
                        // Per-connection failures are the peer's problem; never the app's.
                        r = tokio::time::timeout(CONN_DEADLINE, handle_connection(stream, hub, &token)) => {
                            let _ = r;
                        }
                        _ = stopped => {}
                    }
                });
            }
        }
    }
}

/// Read one HTTP/1.1 request, route it, write one response, close.
async fn handle_connection(
    stream: TcpStream,
    hub: Arc<ControlHub>,
    token: &str,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let Some(req) = read_request(&mut reader).await? else {
        return Ok(());
    };
    let response = route(&req, &hub, token).await;
    let mut stream = reader.into_inner();
    stream.write_all(&response).await?;
    stream.shutdown().await
}

/// A parsed request: method, path, selected headers, body.
struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    origin: Option<String>,
    /// A `Transfer-Encoding` header was present: we only speak Content-Length
    /// framing, so the request's body cannot be read — answered `411`.
    transfer_encoded: bool,
    body: Vec<u8>,
}

/// Parse the head + body off the socket. `None` on a malformed/empty request
/// (connection is simply dropped — nothing sensible to answer).
async fn read_request(
    reader: &mut BufReader<TcpStream>,
) -> std::io::Result<Option<Request>> {
    // Read the head byte-by-byte up to the blank line (bounded).
    let mut head = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD {
            return Ok(None);
        }
        if reader.read(&mut byte).await? == 0 {
            return Ok(None);
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let mut content_length = 0usize;
    let mut authorization = None;
    let mut origin = None;
    let mut transfer_encoded = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().unwrap_or(0),
            "authorization" => authorization = Some(value.to_string()),
            "origin" => origin = Some(value.to_string()),
            "transfer-encoding" => transfer_encoded = true,
            _ => {}
        }
    }
    if content_length > MAX_BODY {
        return Ok(None);
    }
    // A chunked body can't be read with Content-Length framing — don't try
    // (misreading it as empty would answer a misleading -32700). The route
    // layer answers 411 Length Required.
    let mut body = Vec::new();
    if !transfer_encoded {
        body = vec![0u8; content_length];
        reader.read_exact(&mut body).await?;
    }
    Ok(Some(Request {
        method: method.to_string(),
        path: path.to_string(),
        authorization,
        origin,
        transfer_encoded,
        body,
    }))
}

/// Bearer check with a constant-time compare (XOR-fold over both buffers — no
/// early exit on the first differing byte). A timing oracle on loopback is a
/// stretch, but the correct compare costs three lines.
fn authorized(req: &Request, token: &str) -> bool {
    let Some(auth) = &req.authorization else { return false };
    let Some(presented) = auth.strip_prefix("Bearer ") else { return false };
    let (a, b) = (presented.trim().as_bytes(), token.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Origin guard: a request carrying a non-localhost Origin comes from a browser
/// page on another host (DNS rebinding) — reject it. Absent Origin (native
/// clients) and localhost origins pass.
fn origin_ok(req: &Request) -> bool {
    match &req.origin {
        None => true,
        Some(o) => {
            let rest = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")).unwrap_or(o);
            // A bracketed IPv6 authority contains colons INSIDE the brackets, so
            // the port split must peel the bracket group first — a naive
            // `split(':')` would reduce "[::1]:7068" to "[" and reject it.
            let host = if let Some(after) = rest.strip_prefix('[') {
                match after.split_once(']') {
                    Some((h, _port)) => h,
                    None => return false, // malformed bracket authority
                }
            } else {
                rest.split(':').next().unwrap_or(rest)
            };
            matches!(host, "localhost" | "127.0.0.1" | "::1")
        }
    }
}

fn http_response(status: &str, content_type: Option<&str>, body: &[u8], extra: &str) -> Vec<u8> {
    let mut head = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{extra}");
    if let Some(ct) = content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    out
}

fn json_response(status: &str, body: &Value) -> Vec<u8> {
    http_response(status, Some("application/json"), body.to_string().as_bytes(), "")
}

/// Route one request to its response bytes.
async fn route(req: &Request, hub: &Arc<ControlHub>, token: &str) -> Vec<u8> {
    if !origin_ok(req) {
        return http_response("403 Forbidden", None, b"", "");
    }
    // Unsupported body framing: the body was never read, so no handler may run.
    if req.transfer_encoded {
        return http_response("411 Length Required", None, b"", "");
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => json_response("200 OK", &serde_json::json!({ "ok": true })),
        ("POST", "/mcp") => {
            if !authorized(req, token) {
                return http_response(
                    "401 Unauthorized",
                    None,
                    b"",
                    "WWW-Authenticate: Bearer\r\n",
                );
            }
            let Ok(parsed) = serde_json::from_slice::<Value>(&req.body) else {
                return json_response(
                    "400 Bad Request",
                    &serde_json::json!({ "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": "Parse error" } }),
                );
            };
            let caller = Caller::External;
            match parsed {
                Value::Array(messages) => {
                    let mut responses = Vec::new();
                    for msg in &messages {
                        if let Some(resp) = router::handle(hub, Surface::Voice, &caller, msg).await {
                            responses.push(resp);
                        }
                    }
                    if responses.is_empty() {
                        http_response("202 Accepted", None, b"", "")
                    } else {
                        json_response("200 OK", &Value::Array(responses))
                    }
                }
                msg => match router::handle(hub, Surface::Voice, &caller, &msg).await {
                    Some(resp) => json_response("200 OK", &resp),
                    None => http_response("202 Accepted", None, b"", ""),
                },
            }
        }
        // No server-initiated stream: a compliant streamable-HTTP client takes
        // the 405 as "no push channel" and keeps POSTing.
        ("GET", "/mcp") => http_response("405 Method Not Allowed", None, b"", "Allow: POST, DELETE\r\n"),
        // Stateless: a session-termination request has nothing to terminate.
        ("DELETE", "/mcp") => http_response("200 OK", None, b"", ""),
        _ => http_response("404 Not Found", None, b"", ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `AsyncReadExt`/`AsyncWriteExt` come in scope through `use super::*`.

    /// Boot a server on an ephemeral port with a fresh hub; returns (port, hub).
    async fn boot(token: &str) -> (u16, Arc<ControlHub>) {
        let hub = Arc::new(ControlHub::new());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (_tx, rx) = watch::channel(false);
        // Leak the stop sender via the tuple so the loop lives for the test.
        tokio::spawn(serve(listener, hub.clone(), token.to_string(), rx));
        std::mem::forget(_tx);
        (port, hub)
    }

    async fn call(port: u16, raw: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    fn post(body: &str, auth: Option<&str>) -> String {
        let auth_line = auth.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth_line}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len(),
        )
    }

    /// ACCEPTANCE: an authorized initialize round-trips over real TCP.
    #[tokio::test]
    async fn initialize_over_http_round_trips() {
        let (port, _hub) = boot("sekret").await;
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
        let resp = call(port, &post(body, Some("sekret"))).await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "{resp}");
        assert!(resp.contains("flightdeck-voice"), "{resp}");
    }

    /// Missing/wrong token → 401; the tool surface is never reachable without it.
    #[tokio::test]
    async fn unauthorized_posts_are_rejected() {
        let (port, _hub) = boot("sekret").await;
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let resp = call(port, &post(body, None)).await;
        assert!(resp.starts_with("HTTP/1.1 401"), "{resp}");
        let resp = call(port, &post(body, Some("wrong"))).await;
        assert!(resp.starts_with("HTTP/1.1 401"), "{resp}");
    }

    /// A notification-only POST is 202 with no body; GET /mcp is 405; /health is open.
    #[tokio::test]
    async fn notification_get_and_health_contracts() {
        let (port, _hub) = boot("sekret").await;
        let resp = call(port, &post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, Some("sekret"))).await;
        assert!(resp.starts_with("HTTP/1.1 202"), "{resp}");
        let resp = call(port, "GET /mcp HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(resp.starts_with("HTTP/1.1 405"), "{resp}");
        let resp = call(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(resp.contains(r#"{"ok":true}"#), "{resp}");
    }

    /// REGRESSION: a chunked body cannot be read with Content-Length framing —
    /// it must be REFUSED (411), never misread as an empty body (-32700).
    #[tokio::test]
    async fn chunked_bodies_get_411() {
        let (port, _hub) = boot("sekret").await;
        let raw = "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer sekret\r\nTransfer-Encoding: chunked\r\n\r\n";
        let resp = call(port, raw).await;
        assert!(resp.starts_with("HTTP/1.1 411"), "{resp}");
    }

    /// REGRESSION: a bracketed IPv6 localhost Origin must pass the guard (a
    /// naive colon split reduced "[::1]:5173" to "[" and rejected it).
    #[tokio::test]
    async fn ipv6_localhost_origin_passes() {
        let (port, _hub) = boot("sekret").await;
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://[::1]:5173\r\nAuthorization: Bearer sekret\r\nContent-Length: {}\r\n\r\n{body}",
            body.len(),
        );
        let resp = call(port, &raw).await;
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    }

    /// A foreign Origin header (DNS rebinding) is refused even with the token.
    #[tokio::test]
    async fn foreign_origin_is_refused() {
        let (port, _hub) = boot("sekret").await;
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let raw = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nAuthorization: Bearer sekret\r\nContent-Length: {}\r\n\r\n{body}",
            body.len(),
        );
        let resp = call(port, &raw).await;
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
    }
}
