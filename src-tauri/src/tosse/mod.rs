//! TOSSE (the internal CRM) account connection — **the single module that talks to
//! TOSSE**, same encapsulation rule as `git::mod` / `store::db` / `usage::mod`: swapping
//! the transport or the auth scheme means rewriting only this file.
//!
//! ## Why an OAuth flow here, when the other two accounts delegate to a CLI
//! `accounts::mod` (Claude) and `supervisor::codex::accounts` both hand the OAuth dance to
//! a binary we drive. TOSSE has no CLI — so this is the app's FIRST hand-written OAuth
//! client. It is a textbook RFC 8252 native-app flow: **authorization code + PKCE (S256) +
//! a loopback redirect**, against the OAuth 2.1 server TOSSE already runs for the
//! claude.ai MCP connector (`apps/backend/src/routes/mcp-oauth.ts`). Nothing had to be
//! added server-side for the flow itself: dynamic client registration accepts a loopback
//! `redirect_uri`, and the consent page already redirects back to it.
//!
//! ## Why NOT the MCP server
//! TOSSE's MCP endpoint is a claude.ai-side connector: the app holds neither its URL nor a
//! token for it, and the MCP tools themselves just call `/api/v1/*` under the hood. We call
//! that REST API directly — one hop, typed, deterministic. MCP stays Claude's channel.
//!
//! ## The one server-side dependency
//! `/api/v1/*` today accepts only a Better Auth session cookie (browser-shaped) or the
//! internal MCP secret; a Bearer access token is refused. Accepting Bearer tokens carrying
//! the [`SCOPE`] below is tracked as its own TOSSE task. Until it lands, the whole OAuth
//! flow works and [`status`] reports `connected` from the token we hold, but the identity
//! probe degrades to "connected, identity unavailable" rather than failing the sign-in.
//!
//! ## Credential policy — we OWN this one
//! Unlike the Claude/Codex credential stores (strictly read-only, owned by their CLIs),
//! these tokens are ours: we write them to the macOS Keychain via `/usr/bin/security`.
//! Because the item is CREATED by `security`, later reads by `security` are inside its ACL
//! and raise no access prompt (contrast `usage::mod`, which reads an item the `claude` CLI
//! created and can therefore prompt).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

/// The TOSSE backend, hard-coded on purpose (decision: no configurable field — we always
/// test against production, and a moved deployment is a one-line change here). It is the
/// ONLY hard-coded URL: every OAuth endpoint is discovered from its metadata document, so
/// a relocated consent page (which lives on the *frontend*) follows for free.
const BASE_URL: &str = "https://backend-production-668c.up.railway.app";

/// The scope Flight Deck asks for — deliberately NOT the connector's `mcp:tools`, so a
/// token minted for claude.ai can never be replayed against the REST API (and vice versa).
const SCOPE: &str = "tosse:app";

/// How the app names itself on the consent screen (dynamic client registration).
const CLIENT_NAME: &str = "Flight Deck";

/// Loopback ports offered as redirect targets, in order of preference.
///
/// ⚠️ Why a FIXED list rather than "bind port 0 and use whatever we get": the server
/// validates `redirect_uri` by EXACT string match against the registered list
/// (`mcp-oauth.ts`, `/oauth/authorize`), so the port has to be known at REGISTRATION time.
/// Registering several candidates keeps ONE stable `client_id` (no re-registration per
/// sign-in, which would litter the server's client table) while surviving a busy port.
const CALLBACK_PORTS: &[u16] = &[47890, 47891, 47892, 47893, 47894];

/// Keychain item holding our own OAuth material (see the module doc's credential policy).
const KEYCHAIN_SERVICE: &str = "Flight Deck TOSSE";

/// Give the user time to sign in to TOSSE in the browser and grant consent, without
/// leaking a listener forever if they simply walk away.
const LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Refresh an access token this long before it actually expires, so one that would lapse
/// mid-request is renewed first (mirrors `usage::EXPIRY_SKEW_MS`).
const EXPIRY_SKEW_MS: i64 = 60_000;

// ── Public shapes ────────────────────────────────────────────────────────────────────

/// The TOSSE connection as the Settings tab shows it. `connected` false with a
/// `signed_out_reason` means we HELD a session and it stopped working (revoked/expired
/// refresh token) — a different story from "never signed in", and the UI says so.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseAccountStatus {
    pub connected: bool,
    pub name: Option<String>,
    pub email: Option<String>,
    /// Why a stored session is no longer usable. `None` when simply never connected.
    pub signed_out_reason: Option<String>,
    /// Set when we ARE connected but the identity probe could not run (offline, or the
    /// server does not accept Bearer on `/api/v1/*` yet). Never silently swallowed: the
    /// card stays "connected" and shows this as the reason the name/email are missing.
    pub identity_error: Option<String>,
}

// ── Errors ───────────────────────────────────────────────────────────────────────────

/// Every failure mode carries its cause, so the Settings card can say what to do instead
/// of a dead-end "unavailable". Rendered to a string at the IPC boundary (the front only
/// ever displays it).
#[derive(Debug)]
pub enum TosseError {
    /// Network-level failure (DNS, TLS, timeout, offline).
    Network(String),
    /// Non-success HTTP status from TOSSE. `body` is the server's own message when it wrote
    /// one (see [`readable_error`]), else a bounded snippet of the raw body.
    Http { status: u16, body: String },
    /// A response arrived but did not have the shape the OAuth spec requires.
    Protocol(String),
    /// The Keychain refused to store/read our item.
    Keychain(String),
    /// No stored session (the caller needs a sign-in first).
    NotConnected,
    /// The user (or the server) refused the authorization request.
    Denied(String),
    /// Local setup problem: every loopback port busy, etc.
    Local(String),
}

impl std::fmt::Display for TosseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(d) => write!(f, "TOSSE is unreachable: {d}"),
            Self::Http { status, body } => write!(f, "TOSSE answered HTTP {status}: {body}"),
            Self::Protocol(d) => write!(f, "unexpected response from TOSSE: {d}"),
            Self::Keychain(d) => write!(f, "could not access the Keychain: {d}"),
            Self::NotConnected => write!(f, "not connected to TOSSE"),
            Self::Denied(d) => write!(f, "authorization refused: {d}"),
            Self::Local(d) => write!(f, "{d}"),
        }
    }
}

impl std::error::Error for TosseError {}

type R<T> = Result<T, TosseError>;

// ── Stored credentials ───────────────────────────────────────────────────────────────

/// What we keep in the Keychain between launches.
///
/// `client_id` OUTLIVES a sign-out on purpose: dynamic client registration is per-install,
/// not per-session, so re-registering on every sign-in would add a row to the server's
/// client table each time. Signing out therefore rewrites the item with the tokens
/// stripped rather than deleting it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    /// The loopback ports this `client_id` was registered with.
    ///
    /// Kept so a future change to [`CALLBACK_PORTS`] can be DETECTED: the server matches
    /// `redirect_uri` by exact string, so a stale registration would fail the sign-in in the
    /// browser ("redirect_uri not registered") — a dead end the app cannot see or explain.
    /// Comparing here lets us re-register instead. Absent on items written before this field
    /// existed, which reads as "unknown" and re-registers once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redirect_ports: Option<Vec<u16>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// Access-token expiry, ms since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<i64>,
}

impl StoredAuth {
    /// True when the access token is present and still good (minus [`EXPIRY_SKEW_MS`]).
    /// An unknown expiry counts as usable — we can't prove it stale, and a 401 will tell
    /// us for sure.
    fn access_is_fresh(&self, now_ms: i64) -> bool {
        self.access_token.is_some()
            && match self.expires_at_ms {
                Some(exp) => exp > now_ms.saturating_add(EXPIRY_SKEW_MS),
                None => true,
            }
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Keychain I/O (macOS `/usr/bin/security`) ─────────────────────────────────────────

/// Read our Keychain item. A MISSING item is the normal "never signed in" state → `None`.
/// Any other failure is logged and also yields `None` (the caller then behaves as signed
/// out, which is the safe direction), never a silent success.
#[cfg(target_os = "macos")]
fn keychain_read() -> Option<StoredAuth> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        // 44 = errSecItemNotFound truncated to 8 bits: the expected "no item yet" case.
        if out.status.code() != Some(44) {
            eprintln!(
                "[tosse] keychain read failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        return None;
    }
    let blob = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match serde_json::from_str::<StoredAuth>(&blob) {
        Ok(a) => Some(a),
        Err(e) => {
            eprintln!("[tosse] keychain item is not valid JSON ({e}); treating as signed out");
            None
        }
    }
}

/// Write (upsert) our Keychain item. `-U` updates in place when it already exists.
#[cfg(target_os = "macos")]
fn keychain_write(auth: &StoredAuth) -> R<()> {
    let blob = serde_json::to_string(auth)
        .map_err(|e| TosseError::Keychain(format!("could not serialize credentials: {e}")))?;
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "oauth",
            "-D",
            "Flight Deck TOSSE credentials",
            "-w",
            &blob,
        ])
        .output()
        .map_err(|e| TosseError::Keychain(format!("failed to run /usr/bin/security: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    Err(TosseError::Keychain(format!(
        "security exit {}: {}",
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

#[cfg(not(target_os = "macos"))]
fn keychain_read() -> Option<StoredAuth> {
    None
}

#[cfg(not(target_os = "macos"))]
fn keychain_write(_auth: &StoredAuth) -> R<()> {
    Err(TosseError::Keychain(
        "credential storage is only implemented on macOS".into(),
    ))
}

/// Serializes read-modify-write of the Keychain item, so two concurrent updates (a token
/// refresh racing a sign-out) can't each read the same bytes and clobber the other's
/// write — the same lost-update hazard the CLI-config writers guard against.
static KEYCHAIN_LOCK: Mutex<()> = Mutex::const_new(());

/// Blocking Keychain I/O, run off the async runtime and behind [`KEYCHAIN_LOCK`].
async fn with_stored<T, F>(f: F) -> R<T>
where
    F: FnOnce(StoredAuth) -> R<(StoredAuth, T)> + Send + 'static,
    T: Send + 'static,
{
    let _guard = KEYCHAIN_LOCK.lock().await;
    tokio::task::spawn_blocking(move || {
        let (next, out) = f(keychain_read().unwrap_or_default())?;
        keychain_write(&next)?;
        Ok(out)
    })
    .await
    .map_err(|e| TosseError::Local(format!("keychain task failed: {e}")))?
}

/// Read the stored credentials off-thread (no write, so no lock needed).
async fn read_stored() -> StoredAuth {
    tokio::task::spawn_blocking(|| keychain_read().unwrap_or_default())
        .await
        .unwrap_or_default()
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────────────

/// reqwest is built with `rustls-no-provider`, so a process-wide crypto provider must be
/// installed before the first client builds (else it panics, and release is
/// `panic = "abort"`). Idempotent — a no-op when the updater or `usage` got there first.
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Build the shared HTTP client. Timeouts are mandatory: the async client has none by
/// default, so a stalled connection would hang the command future forever.
fn http() -> R<reqwest::Client> {
    ensure_crypto_provider();
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| TosseError::Network(format!("HTTP client build failed: {e}")))
}

/// First ~300 chars of a body, for error text — never dump a whole payload into the UI.
fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}

/// Turn an error body into something a human can read.
///
/// Both of TOSSE's error shapes are structured, so dumping the raw JSON into a Settings
/// card (`… HTTP 401: {"success":false,"error":{"code":"UNAUTHORIZED", …}}`) shows the user
/// punctuation instead of a reason. We unwrap the message the server already wrote:
/// - the REST envelope `{success:false, error:{code, message}}`, and
/// - the OAuth error object `{error, error_description}` (RFC 6749 §5.2).
///
/// Anything else falls back to the bounded snippet — an unrecognised body is still shown,
/// never swallowed.
fn readable_error(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return snippet(body);
    };
    let pick = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    pick("/error/message")
        .or_else(|| pick("/error_description"))
        .or_else(|| pick("/error"))
        .or_else(|| pick("/message"))
        .map(|m| snippet(&m))
        .unwrap_or_else(|| snippet(body))
}

/// Send a request and split the outcome into (status, body), mapping transport failures to
/// [`TosseError::Network`].
async fn send_text(req: reqwest::RequestBuilder) -> R<(reqwest::StatusCode, String)> {
    let resp = req
        .send()
        .await
        .map_err(|e| TosseError::Network(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| TosseError::Network(format!("reading body failed: {e}")))?;
    Ok((status, body))
}

/// POST a JSON body. reqwest is compiled without its `json` feature (see `Cargo.toml`), so
/// the body is serialized by hand — same as `usage::mod` parses responses by hand.
async fn post_json(url: &str, body: &Value) -> R<(reqwest::StatusCode, String)> {
    let client = http()?;
    send_text(
        client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string()),
    )
    .await
}

// ── OAuth server metadata ────────────────────────────────────────────────────────────

/// The endpoints we need, read from the server's metadata document rather than hard-coded.
/// ⚠️ `authorization_endpoint` points at the TOSSE **frontend** (the consent page lives
/// where the session cookie lives), which is exactly why discovering it beats assuming it.
#[derive(Debug, Clone)]
struct Endpoints {
    authorization: String,
    token: String,
    registration: String,
    revocation: Option<String>,
}

/// Discovery is stable for a process lifetime; cache it so a sign-in doesn't pay for it
/// twice. A failure is NOT cached — the next attempt retries (the user may have been
/// offline).
static ENDPOINTS: StdMutex<Option<Endpoints>> = StdMutex::new(None);

async fn discover() -> R<Endpoints> {
    if let Ok(guard) = ENDPOINTS.lock() {
        if let Some(e) = guard.as_ref() {
            return Ok(e.clone());
        }
    }
    let url = format!("{BASE_URL}/.well-known/oauth-authorization-server");
    let (status, body) = send_text(http()?.get(&url)).await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&body),
        });
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| TosseError::Protocol(format!("metadata is not JSON ({e}): {}", snippet(&body))))?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let endpoints = Endpoints {
        authorization: field("authorization_endpoint")
            .ok_or_else(|| TosseError::Protocol("metadata has no authorization_endpoint".into()))?,
        token: field("token_endpoint")
            .ok_or_else(|| TosseError::Protocol("metadata has no token_endpoint".into()))?,
        registration: field("registration_endpoint")
            .ok_or_else(|| TosseError::Protocol("metadata has no registration_endpoint".into()))?,
        revocation: field("revocation_endpoint"),
    };
    if let Ok(mut guard) = ENDPOINTS.lock() {
        *guard = Some(endpoints.clone());
    }
    Ok(endpoints)
}

// ── PKCE ─────────────────────────────────────────────────────────────────────────────

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// 32 random bytes, base64url-encoded — used for both the PKCE verifier and the `state`
/// nonce. `ring`'s system RNG is the OS CSPRNG (the same crate rustls already compiles).
fn random_token() -> R<String> {
    use ring::rand::SecureRandom as _;
    let mut buf = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| TosseError::Local("system RNG unavailable".into()))?;
    Ok(B64.encode(buf))
}

/// The S256 challenge for a verifier: base64url(SHA-256(verifier)). The server rejects any
/// other method, which is what we want — plain PKCE offers no protection.
fn code_challenge(verifier: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
    B64.encode(digest.as_ref())
}

// ── Dynamic client registration ──────────────────────────────────────────────────────

/// Our `client_id`, registering once per install and reusing it forever after.
/// Every candidate loopback port is registered up front, so a sign-in that has to fall
/// back to another port still presents a `redirect_uri` the server recognises.
async fn ensure_client(endpoints: &Endpoints) -> R<String> {
    let stored = read_stored().await;
    if let Some(id) = stored.client_id.filter(|s| !s.is_empty()) {
        // Reuse it only if it still covers the ports we can actually bind (see
        // `StoredAuth::redirect_ports`); otherwise fall through and register afresh.
        if stored.redirect_ports.as_deref() == Some(CALLBACK_PORTS) {
            return Ok(id);
        }
        eprintln!("[tosse] registered redirect ports changed; re-registering the OAuth client");
    }
    let redirect_uris: Vec<Value> = CALLBACK_PORTS
        .iter()
        .map(|p| Value::String(redirect_uri(*p)))
        .collect();
    let body = serde_json::json!({
        "client_name": CLIENT_NAME,
        "redirect_uris": redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // Public client: a desktop app cannot keep a secret, so it authenticates with
        // PKCE alone (the server advertises `token_endpoint_auth_methods: ["none"]`).
        "token_endpoint_auth_method": "none",
        "scope": SCOPE,
    });
    let (status, text) = post_json(&endpoints.registration, &body).await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&text),
        });
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| TosseError::Protocol(format!("registration is not JSON ({e})")))?;
    let client_id = v
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or_else(|| TosseError::Protocol("registration returned no client_id".into()))?
        .to_string();

    let to_store = client_id.clone();
    with_stored(move |mut a| {
        a.client_id = Some(to_store);
        a.redirect_ports = Some(CALLBACK_PORTS.to_vec());
        // A new client identity invalidates tokens minted for the previous one.
        a.access_token = None;
        a.refresh_token = None;
        a.expires_at_ms = None;
        Ok((a, ()))
    })
    .await?;
    Ok(client_id)
}

fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

// ── The loopback callback server ─────────────────────────────────────────────────────

/// What the browser handed back on the redirect.
struct CallbackResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Bind the first free candidate port. All busy → a [`TosseError::Local`] naming the ports,
/// which is actionable ("something else is on 47890…"), unlike a bare bind failure.
async fn bind_callback() -> R<(tokio::net::TcpListener, u16)> {
    for port in CALLBACK_PORTS {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", *port)).await {
            return Ok((l, *port));
        }
    }
    Err(TosseError::Local(format!(
        "no free local port for the sign-in callback (tried {CALLBACK_PORTS:?})"
    )))
}

/// Serve the redirect: accept connections until one carries `code` or `error`, answer it
/// with a human-readable page, and return what it carried.
///
/// ⚠️ The loop is not optional — a browser routinely opens extra connections to the same
/// origin (favicon, speculative preconnect). Answering only the FIRST accept would often
/// consume one of those and hang waiting for a redirect that already arrived.
async fn serve_callback(listener: tokio::net::TcpListener) -> R<CallbackResult> {
    loop {
        let (mut sock, _) = listener
            .accept()
            .await
            .map_err(|e| TosseError::Local(format!("callback accept failed: {e}")))?;

        // Read just the request line + headers; the redirect carries everything in the
        // query string, so we never need a body. Bounded so a rogue client can't stream
        // into memory.
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let head = loop {
            match sock.read(&mut chunk).await {
                Ok(0) => break String::from_utf8_lossy(&buf).into_owned(),
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf);
                    if text.contains("\r\n\r\n") || buf.len() > 16 * 1024 {
                        break text.into_owned();
                    }
                }
                Err(_) => break String::from_utf8_lossy(&buf).into_owned(),
            }
        };

        let parsed = parse_callback_request(&head);
        let is_final = parsed
            .as_ref()
            .is_some_and(|p| p.code.is_some() || p.error.is_some());

        let page = match &parsed {
            Some(p) if p.error.is_some() => {
                html_page("Sign-in refused", "You can close this tab and try again in Flight Deck.")
            }
            Some(p) if p.code.is_some() => {
                html_page("Flight Deck is connected", "You can close this tab.")
            }
            // Anything else (favicon, a stray probe): a terse 404, and keep listening.
            _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        };
        let _ = sock.write_all(page.as_bytes()).await;
        let _ = sock.flush().await;
        let _ = sock.shutdown().await;

        if is_final {
            return Ok(parsed.expect("is_final implies parsed"));
        }
    }
}

/// Pull `code` / `state` / `error` out of a raw HTTP request head. Returns `None` when the
/// head isn't a parseable GET request line. Pure → unit-tested.
fn parse_callback_request(head: &str) -> Option<CallbackResult> {
    let line = head.lines().next()?;
    let target = line.split_whitespace().nth(1)?;
    // A request target is origin-form ("/callback?..."); join it to a dummy base to reuse
    // the URL parser rather than hand-rolling query splitting.
    let url = url::Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    let mut out = CallbackResult {
        code: None,
        state: None,
        error: None,
    };
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => out.code = Some(v.into_owned()),
            "state" => out.state = Some(v.into_owned()),
            "error" => out.error = Some(v.into_owned()),
            "error_description" => {
                // Prefer the human description when both are present.
                out.error = Some(v.into_owned());
            }
            _ => {}
        }
    }
    Some(out)
}

fn html_page(title: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:16px -apple-system,system-ui,sans-serif;display:grid;\
         place-items:center;height:100vh;margin:0;background:#0f1115;color:#e7e9ee}}\
         div{{text-align:center}}h1{{font-size:19px;margin:0 0 6px}}\
         p{{margin:0;color:#9aa3b2}}</style>\
         <div><h1>{title}</h1><p>{body}</p></div>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{html}",
        html.len()
    )
}

// ── Login flow ───────────────────────────────────────────────────────────────────────

/// The sign-in currently in flight: aborting its task drops the listener (freeing the
/// port) and cancels the wait.
struct ActiveLogin {
    /// Which attempt this is. A finishing task deregisters ONLY its own generation:
    /// without it, a sign-in that fails fast could clear the entry a NEWER attempt had
    /// just registered, and the user's "Cancel" would then find nothing to stop — leaving
    /// that newer listener bound until its 5-minute timeout.
    generation: u64,
    task: tokio::task::JoinHandle<()>,
}

static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::const_new(None);
static LOGIN_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Serializes the WHOLE start sequence (cancel → bind → register → spawn), so two
/// near-simultaneous starts cannot both pass the cancel and then race on the callback
/// port — leaving a listener bound to a flow nobody is waiting on. Same guard, and same
/// reason, as `accounts::LOGIN_FLOW` / the Codex sibling.
static LOGIN_FLOW: Mutex<()> = Mutex::const_new(());

/// Start a sign-in: bind the loopback listener, build the PKCE challenge, and return the
/// authorization URL for the front to open. Completion is ASYNCHRONOUS — the spawned task
/// serves the redirect, exchanges the code, stores the tokens and reports through
/// `on_done(success, error)`, exactly like the Codex login's completion event.
pub async fn login_start<F>(on_done: F) -> R<String>
where
    F: FnOnce(bool, Option<String>) + Send + 'static,
{
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;

    let endpoints = discover().await?;
    let client_id = ensure_client(&endpoints).await?;
    let (listener, port) = bind_callback().await?;

    let verifier = random_token()?;
    let state = random_token()?;
    let challenge = code_challenge(&verifier);
    let redirect = redirect_uri(port);

    let mut auth_url = url::Url::parse(&endpoints.authorization)
        .map_err(|e| TosseError::Protocol(format!("invalid authorization_endpoint: {e}")))?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("scope", SCOPE);
    let auth_url = auth_url.to_string();

    let generation = LOGIN_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let task = tokio::spawn(async move {
        let outcome = complete_login(listener, endpoints, client_id, verifier, state, redirect).await;
        // Deregister BEFORE reporting, so a UI that restarts a sign-in from the callback
        // isn't cancelled by its own predecessor's teardown — but only if the entry is
        // still OURS (see `ActiveLogin::generation`).
        {
            let mut slot = ACTIVE_LOGIN.lock().await;
            if slot.as_ref().is_some_and(|a| a.generation == generation) {
                *slot = None;
            }
        }
        match outcome {
            Ok(()) => on_done(true, None),
            Err(e) => on_done(false, Some(e.to_string())),
        }
    });
    *ACTIVE_LOGIN.lock().await = Some(ActiveLogin { generation, task });
    Ok(auth_url)
}

/// Wait for the redirect, validate it, exchange the code, and persist the tokens.
async fn complete_login(
    listener: tokio::net::TcpListener,
    endpoints: Endpoints,
    client_id: String,
    verifier: String,
    expected_state: String,
    redirect: String,
) -> R<()> {
    let cb = match tokio::time::timeout(LOGIN_TIMEOUT, serve_callback(listener)).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(TosseError::Local(
                "sign-in timed out — the browser never came back".into(),
            ))
        }
    };

    if let Some(err) = cb.error {
        return Err(TosseError::Denied(err));
    }
    // The `state` nonce ties this redirect to the request WE started. A mismatch means the
    // callback came from somewhere else — refuse it rather than exchange an unknown code.
    if cb.state.as_deref() != Some(expected_state.as_str()) {
        return Err(TosseError::Denied(
            "the browser came back with an unexpected state — sign-in aborted".into(),
        ));
    }
    let code = cb
        .code
        .ok_or_else(|| TosseError::Protocol("the redirect carried no authorization code".into()))?;

    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect,
        "client_id": client_id,
    });
    let (status, text) = post_json(&endpoints.token, &body).await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&text),
        });
    }
    let tokens = parse_token_response(&text)?;
    store_tokens(tokens).await
}

/// Abort the in-flight sign-in, if any. Safe when none is running.
pub async fn login_cancel() {
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;
}

/// Abort WITHOUT taking `LOGIN_FLOW` — for callers that already hold it.
async fn cancel_current() {
    if let Some(active) = ACTIVE_LOGIN.lock().await.take() {
        active.task.abort();
    }
}

// ── Tokens ───────────────────────────────────────────────────────────────────────────

/// A token endpoint response, reduced to what we keep.
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

fn parse_token_response(text: &str) -> R<Tokens> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| TosseError::Protocol(format!("token response is not JSON ({e})")))?;
    let access_token = v
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| TosseError::Protocol("token response carried no access_token".into()))?
        .to_string();
    Ok(Tokens {
        access_token,
        refresh_token: v
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_in: v.get("expires_in").and_then(Value::as_i64),
    })
}

/// Persist a fresh token pair, keeping the previous refresh token when the server rotates
/// silently (i.e. answers without one) — dropping it there would strand the session at the
/// next expiry.
async fn store_tokens(t: Tokens) -> R<()> {
    let now = now_unix_ms();
    with_stored(move |mut a| {
        a.expires_at_ms = t.expires_in.map(|s| now + s * 1000);
        a.access_token = Some(t.access_token);
        if t.refresh_token.is_some() {
            a.refresh_token = t.refresh_token;
        }
        Ok((a, ()))
    })
    .await
}

/// Serializes the whole "is it stale? → refresh → store" sequence.
///
/// ⚠️ Load-bearing, not defensive: TOSSE **rotates** refresh tokens and REVOKES the old one
/// on every exchange (`exchangeRefreshToken`). Two concurrent refreshes would therefore
/// present the same token, the second would be rejected as revoked — and this module reads
/// a rejected refresh as "session over" and signs the user out. One caller can't race
/// itself, but the Tasks view (lot 2) will have several; the lock keeps that from ever
/// becoming a mystery logout.
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

/// A usable access token: the stored one while it is fresh, otherwise refreshed.
///
/// Public because the TOSSE data calls (the Tasks view, lot 2) go through it — it is the
/// single place that knows how to present a valid credential.
pub async fn access_token() -> R<String> {
    let _refresh_guard = REFRESH_LOCK.lock().await;
    // Read AFTER taking the lock: a caller that queued behind an in-flight refresh must see
    // its result, not the stale snapshot it would have read on the way in — otherwise it
    // would refresh again with a token the winner just had revoked.
    let stored = read_stored().await;
    let now = now_unix_ms();
    if stored.access_is_fresh(now) {
        return Ok(stored.access_token.expect("fresh implies present"));
    }
    let (Some(client_id), Some(refresh)) = (stored.client_id.clone(), stored.refresh_token.clone())
    else {
        return Err(TosseError::NotConnected);
    };

    let endpoints = discover().await?;
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": client_id,
    });
    let (status, text) = post_json(&endpoints.token, &body).await?;
    if !status.is_success() {
        // A refused refresh is terminal for this session (revoked or 30-day expiry): clear
        // the tokens so the UI stops claiming "connected" and asks for a fresh sign-in.
        // The `client_id` survives — see `StoredAuth`.
        let _ = clear_tokens().await;
        return Err(TosseError::Denied(
            "the TOSSE session expired — sign in again".into(),
        ));
    }
    let tokens = parse_token_response(&text)?;
    let access = tokens.access_token.clone();
    store_tokens(tokens).await?;
    Ok(access)
}

/// Drop the tokens but KEEP the registered `client_id` (see [`StoredAuth`]).
async fn clear_tokens() -> R<()> {
    with_stored(|mut a| {
        a.access_token = None;
        a.refresh_token = None;
        a.expires_at_ms = None;
        Ok((a, ()))
    })
    .await
}

// ── Status / logout ──────────────────────────────────────────────────────────────────

/// The connection state for the Settings tab.
///
/// "Connected" is decided by what we HOLD, not by a successful round-trip: an offline
/// machine must not read as signed out. When we do hold a session, we still probe
/// `/api/v1/auth/me` for the identity, and a failure there degrades to
/// `identity_error` — never silently, and never by demoting the card to "not connected".
pub async fn status() -> TosseAccountStatus {
    let stored = read_stored().await;
    if stored.refresh_token.is_none() && stored.access_token.is_none() {
        return TosseAccountStatus {
            connected: false,
            name: None,
            email: None,
            signed_out_reason: None,
            identity_error: None,
        };
    }

    let token = match access_token().await {
        Ok(t) => t,
        Err(e) => {
            // A REFUSED refresh (or unusable stored pair) is terminal: the session is gone
            // and we say WHY, so the card doesn't just read a bare "Not connected". A mere
            // network failure is NOT terminal — we still hold a session, so we stay
            // connected and report the outage as an identity problem.
            let terminal = matches!(e, TosseError::Denied(_) | TosseError::NotConnected);
            return TosseAccountStatus {
                connected: !terminal,
                name: None,
                email: None,
                signed_out_reason: terminal.then(|| e.to_string()),
                identity_error: (!terminal).then(|| e.to_string()),
            };
        }
    };

    match fetch_identity(&token).await {
        Ok((name, email)) => TosseAccountStatus {
            connected: true,
            name,
            email,
            signed_out_reason: None,
            identity_error: None,
        },
        Err(e) => TosseAccountStatus {
            connected: true,
            name: None,
            email: None,
            signed_out_reason: None,
            identity_error: Some(e.to_string()),
        },
    }
}

/// Who we are signed in as (`GET /api/v1/auth/me`, which already exists server-side).
/// ⚠️ Until TOSSE accepts Bearer tokens on `/api/v1/*` this returns 401 — the caller turns
/// that into `identity_error`, so the connection itself still reads as established.
async fn fetch_identity(token: &str) -> R<(Option<String>, Option<String>)> {
    let url = format!("{BASE_URL}/api/v1/auth/me");
    let (status, body) = send_text(http()?.get(&url).bearer_auth(token)).await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&body),
        });
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| TosseError::Protocol(format!("identity is not JSON ({e})")))?;
    // The API wraps payloads as `{success, data}`; tolerate a bare object too.
    let user = v.pointer("/data/user").or_else(|| v.get("data")).unwrap_or(&v);
    let s = |k: &str| user.get(k).and_then(Value::as_str).map(str::to_string);
    Ok((s("name"), s("email")))
}

/// Sign out: best-effort token revocation server-side, then drop the local tokens.
///
/// The local clear runs even when revocation fails (offline, server down) — otherwise a
/// user could not sign out of a machine they no longer trust. The revocation error is
/// returned so the UI can say the server-side session may still be live.
pub async fn logout() -> R<()> {
    let stored = read_stored().await;
    let mut revoke_err = None;
    if let (Some(client_id), Some(token)) = (
        stored.client_id.clone(),
        stored.refresh_token.clone().or(stored.access_token.clone()),
    ) {
        match revoke(&client_id, &token, stored.refresh_token.is_some()).await {
            Ok(()) => {}
            Err(e) => revoke_err = Some(e),
        }
    }
    clear_tokens().await?;
    match revoke_err {
        None => Ok(()),
        Some(e) => Err(TosseError::Local(format!(
            "signed out on this Mac, but TOSSE could not be told to revoke the session ({e})"
        ))),
    }
}

async fn revoke(client_id: &str, token: &str, is_refresh: bool) -> R<()> {
    let endpoints = discover().await?;
    let Some(url) = endpoints.revocation else {
        return Ok(()); // Server advertises no revocation endpoint — nothing to do.
    };
    let body = serde_json::json!({
        "token": token,
        "token_type_hint": if is_refresh { "refresh_token" } else { "access_token" },
        "client_id": client_id,
    });
    let (status, text) = post_json(&url, &body).await?;
    if status.is_success() {
        Ok(())
    } else {
        Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&text),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_test_vector() {
        // RFC 7636 Appendix B: this verifier must produce this challenge under S256.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_unique_and_url_safe() {
        let a = random_token().expect("rng");
        let b = random_token().expect("rng");
        assert_ne!(a, b);
        assert!(!a.contains('+') && !a.contains('/') && !a.contains('='));
        assert_eq!(a.len(), 43); // 32 bytes, base64url unpadded
    }

    #[test]
    fn parses_the_authorization_redirect() {
        let head = "GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let cb = parse_callback_request(head).expect("parses");
        assert_eq!(cb.code.as_deref(), Some("abc123"));
        assert_eq!(cb.state.as_deref(), Some("xyz"));
        assert!(cb.error.is_none());
    }

    #[test]
    fn parses_a_denied_redirect_and_prefers_the_description() {
        let head = "GET /callback?error=access_denied&error_description=User%20said%20no HTTP/1.1\r\n\r\n";
        let cb = parse_callback_request(head).expect("parses");
        assert_eq!(cb.error.as_deref(), Some("User said no"));
        assert!(cb.code.is_none());
    }

    #[test]
    fn a_stray_request_carries_neither_code_nor_error() {
        // The favicon hit a browser fires alongside the redirect: parsed, but not final —
        // this is what keeps `serve_callback` listening instead of returning early.
        let cb = parse_callback_request("GET /favicon.ico HTTP/1.1\r\n\r\n").expect("parses");
        assert!(cb.code.is_none() && cb.error.is_none());
        assert!(parse_callback_request("garbage").is_none());
    }

    #[test]
    fn access_freshness_honors_expiry_and_skew() {
        let now = 1_000_000_000_000;
        let with = |access: Option<&str>, exp: Option<i64>| StoredAuth {
            client_id: Some("c".into()),
            access_token: access.map(str::to_string),
            refresh_token: Some("r".into()),
            expires_at_ms: exp,
            ..Default::default()
        };
        assert!(with(Some("t"), Some(now + 3_600_000)).access_is_fresh(now));
        assert!(!with(Some("t"), Some(now - 1)).access_is_fresh(now));
        // Inside the skew margin → treated as stale, so it is refreshed before use.
        assert!(!with(Some("t"), Some(now + 30_000)).access_is_fresh(now));
        // Unknown expiry → usable (a 401 is the authority); no token → never fresh.
        assert!(with(Some("t"), None).access_is_fresh(now));
        assert!(!with(None, Some(now + 3_600_000)).access_is_fresh(now));
    }

    #[test]
    fn stored_auth_round_trips_and_omits_empty_fields() {
        let a = StoredAuth {
            client_id: Some("cid".into()),
            ..Default::default()
        };
        let blob = serde_json::to_string(&a).expect("serialize");
        assert_eq!(blob, r#"{"client_id":"cid"}"#); // signed-out shape: id kept, tokens gone
        let back: StoredAuth = serde_json::from_str(&blob).expect("deserialize");
        assert_eq!(back.client_id.as_deref(), Some("cid"));
        assert!(back.refresh_token.is_none());
    }

    /// The reuse rule `ensure_client` applies: a stored client is only good while it still
    /// covers the ports we can bind. Anything else must re-register, because the server
    /// matches `redirect_uri` by exact string and would otherwise dead-end the sign-in in
    /// the browser, where the app can neither see nor explain the failure.
    #[test]
    fn a_client_is_reused_only_while_its_ports_still_match() {
        let reusable = |ports: Option<Vec<u16>>| ports.as_deref() == Some(CALLBACK_PORTS);
        assert!(reusable(Some(CALLBACK_PORTS.to_vec())));
        // Written before the field existed → unknown → re-register once.
        assert!(!reusable(None));
        // A shortened / shifted / reordered list is NOT interchangeable: the registration
        // stores the exact strings, so only an identical list is safe to reuse.
        assert!(!reusable(Some(CALLBACK_PORTS[..2].to_vec())));
        let mut reversed = CALLBACK_PORTS.to_vec();
        reversed.reverse();
        assert!(!reusable(Some(reversed)));
    }

    /// Error bodies must reach the user as sentences, not as JSON punctuation. The first
    /// case is the exact 401 body observed in production before TOSSE accepted Bearer
    /// tokens on `/api/v1/*`.
    #[test]
    fn error_bodies_render_as_the_servers_own_message() {
        assert_eq!(
            readable_error(r#"{"success":false,"error":{"code":"UNAUTHORIZED","message":"Not authenticated"}}"#),
            "Not authenticated"
        );
        // OAuth error object (RFC 6749 §5.2): prefer the description over the code.
        assert_eq!(
            readable_error(r#"{"error":"invalid_grant","error_description":"Code expired"}"#),
            "Code expired"
        );
        assert_eq!(readable_error(r#"{"error":"invalid_client"}"#), "invalid_client");
        // Unrecognised shapes are still SHOWN (bounded), never swallowed into silence.
        assert_eq!(readable_error("<html>502 Bad Gateway</html>"), "<html>502 Bad Gateway</html>");
        assert_eq!(readable_error(r#"{"unexpected":1}"#), r#"{"unexpected":1}"#);
        // A pathological message stays bounded, like the raw-body path.
        let long = format!(r#"{{"error":{{"message":"{}"}}}}"#, "x".repeat(500));
        assert_eq!(readable_error(&long).chars().count(), 300);
    }

    #[test]
    fn token_response_parsing_requires_an_access_token() {
        let t = parse_token_response(
            r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#,
        )
        .expect("parses");
        assert_eq!(t.access_token, "at");
        assert_eq!(t.refresh_token.as_deref(), Some("rt"));
        assert_eq!(t.expires_in, Some(3600));
        assert!(parse_token_response(r#"{"error":"invalid_grant"}"#).is_err());
    }

    /// PROBE (read-only, no credentials): the live metadata document must advertise the
    /// endpoints and the PKCE method this client depends on.
    /// Run: `cargo test --lib -- --ignored --nocapture live_tosse_oauth_metadata`.
    #[tokio::test]
    #[ignore = "hits the live TOSSE backend"]
    async fn live_tosse_oauth_metadata() {
        let e = discover().await.expect("metadata should be reachable");
        eprintln!(
            "authorize={} token={} register={} revoke={:?}",
            e.authorization, e.token, e.registration, e.revocation
        );
        assert!(e.authorization.starts_with("http"));
    }
}
