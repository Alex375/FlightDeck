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
//!
//! ⚠️ **Known limit of that convenience**: an ACL naming `/usr/bin/security` means ANY
//! process running as the same user can read the item back, silently, just by invoking
//! `security` itself. Narrowing it would mean dropping the CLI for the native Security
//! framework and binding the ACL to this (self-signed) app — which would also reintroduce
//! the access prompt on every rebuild, since the ACL follows the code signature. The
//! trade-off is accepted here: the threat model is a single-user developer Mac, and the
//! whole app already runs with that user's privileges. The same reasoning covers passing
//! the secret on argv in [`keychain_write`] — see the note there for why the safer stdin
//! form is unusable (a hard 128-character truncation) and why every write is read back
//! instead.

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
///
/// This is the PRODUCTION item name; test builds get their own (see [`keychain_service`]).
const KEYCHAIN_SERVICE: &str = "Flight Deck TOSSE";

/// The account leg of the Keychain key. Both the read AND the write must use it: searching
/// by service alone returns whichever matching item `security` finds first, so any process
/// running as this user could plant `-s "Flight Deck TOSSE" -a whatever` and have us read
/// ITS token — sending the user's briefing, and every write they make, to someone else's
/// CRM account. Pinning the pair means we address exactly the item we wrote.
const KEYCHAIN_ACCOUNT: &str = "oauth";

/// The bundle identifier this process runs under, published once at startup by `lib.rs`.
/// `None` in unit tests and in any caller that never set it.
static BUNDLE_IDENTIFIER: StdMutex<Option<String>> = StdMutex::new(None);

/// The identifier of the app Alexandre actually uses. Builds carrying it keep the historic
/// item name, so shipping this change does not sign anyone out.
const PRODUCTION_IDENTIFIER: &str = "com.tosse.desktop";

/// Tell the credential store which bundle it belongs to. Call once, early, before any
/// Keychain access (see [`keychain_service`]).
pub fn set_bundle_identifier(identifier: String) {
    if let Ok(mut guard) = BUNDLE_IDENTIFIER.lock() {
        *guard = Some(identifier);
    }
}

/// The Keychain item name for THIS build.
///
/// ⚠️ The data directory is already isolated per bundle identifier (`app_data_dir()`), but
/// this item was not — so a `/build-app` test build and the production app read, refreshed
/// and cleared the SAME credentials. TOSSE rotates the refresh token on every exchange and
/// revokes the previous one, so whichever process refreshed second got `invalid_grant`,
/// wiped the item, and signed BOTH out; a sign-out or a `reset_stored` in a throwaway build
/// disconnected the real one just as effectively.
///
/// Production keeps the historic name on purpose: renaming it there would orphan the item
/// every existing install already holds and demand a fresh browser sign-in for no benefit.
fn keychain_service() -> String {
    service_name_for(BUNDLE_IDENTIFIER.lock().ok().and_then(|g| g.clone()).as_deref())
}

/// The naming rule itself, split out so it is testable without touching global state.
/// `None` (identifier never published, e.g. a unit test) keeps the production name.
fn service_name_for(identifier: Option<&str>) -> String {
    match identifier {
        Some(id) if id != PRODUCTION_IDENTIFIER => format!("{KEYCHAIN_SERVICE} ({id})"),
        _ => KEYCHAIN_SERVICE.to_string(),
    }
}

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

/// The wording the FRONT matches on to tell "this session is gone" from a failure that is
/// merely transient — `src/ipc/tosseErrors.ts::SESSION_GONE_MARKERS`, kept identical.
///
/// ⚠️ These strings are a CONTRACT, not prose. Errors cross the IPC boundary as plain
/// `String` (every command is `Result<T, String>`), so the front has nothing but the text
/// to go on. Reword one of them here and the tasks view silently stops noticing a dead
/// session: it keeps retrying a board it can never load, and never points at the one thing
/// that would fix it — signing in again, in a Settings tab the view does not link to.
///
/// [`session_gone_errors_keep_the_wording_the_front_matches_on`] is what makes that break
/// LOUD: it fails here, in CI, naming the TypeScript file to change alongside.
pub const SESSION_GONE_MARKERS: [&str; 2] = ["not connected to TOSSE", "connect again"];

/// Why a stored session stopped working, recorded when the server REJECTS the grant.
///
/// A constant because it is one half of [`SESSION_GONE_MARKERS`]: it is both persisted (so
/// a later `status()` can explain the sign-out) and returned to whoever triggered the
/// refresh, which is where the front reads it.
const SESSION_REVOKED_REASON: &str = "your TOSSE session expired or was revoked — connect again";

/// Every failure mode carries its cause, so the Settings card can say what to do instead
/// of a dead-end "unavailable". Rendered to a string at the IPC boundary (the front only
/// ever displays it).
///
/// ⚠️ [`Self::NotConnected`] and [`Self::Denied`] are the two the front reads as "the
/// session is gone" — see [`SESSION_GONE_MARKERS`] before touching their wording.
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
    /// Why the tokens were cleared, when they were cleared because the SERVER refused the
    /// grant (revoked or expired refresh token).
    ///
    /// Kept on disk because the error goes to whoever happened to trigger the refresh —
    /// usually a background caller (`tosse_repo_links`, `tosse_briefing`) whose failure no
    /// surface renders. Without it, the next `status()` sees no tokens and reports the
    /// blank-slate "never signed in" state, so Settings shows a first-time invitation and
    /// the user is never told their session died. Cleared by [`store_tokens`] the moment a
    /// new session is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signed_out_reason: Option<String>,
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

/// Read our Keychain item.
///
/// `Ok(None)` means the item does not exist — the normal "never signed in" state.
/// EVERY other outcome is an `Err`, and that distinction is load-bearing: a failed read
/// collapsed into "absent" would let [`with_stored`] seed its closure with an EMPTY record
/// and write that back over the real item, destroying the `client_id` and the refresh token
/// with no error anywhere. A store we cannot read is a fault to report, never a blank slate
/// to overwrite. ([`reset_stored`] is the one explicit, user-initiated way past this.)
#[cfg(target_os = "macos")]
fn keychain_read() -> R<Option<StoredAuth>> {
    // Searched by the SAME (service, account) pair we write with — see [`KEYCHAIN_ACCOUNT`]
    // for why service alone is not enough.
    let service = keychain_service();
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            &service,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .map_err(|e| TosseError::Keychain(format!("failed to run /usr/bin/security: {e}")))?;

    if !out.status.success() {
        // 44 = errSecItemNotFound truncated to 8 bits: the expected "no item yet" case.
        if out.status.code() == Some(44) {
            return Ok(None);
        }
        return Err(TosseError::Keychain(format!(
            "security exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    let blob = String::from_utf8_lossy(&out.stdout).trim().to_string();
    serde_json::from_str::<StoredAuth>(&blob)
        .map(Some)
        .map_err(|e| {
            TosseError::Keychain(format!(
                "the stored credentials are unreadable ({e}) — sign in again to replace them"
            ))
        })
}

/// Write (upsert) our Keychain item. `-U` updates in place when it already exists.
///
/// ## Why the secret goes in on argv, despite `security`'s own warning
/// Handing it on **stdin** (a `-w` with no value, which prompts) is the safer shape — argv
/// is readable by other processes of the same user — and that is what this function did
/// first. It had to be reverted: `security`'s prompt reads through `getpass`, which
/// **truncates at 128 characters**, and our JSON blob is roughly twice that. The result was
/// a silently half-written item and a sign-in that could never be repaired, because every
/// rewrite truncated again. VERIFIED empirically: 128 bytes in → 128 out, 130 in → 128 out.
///
/// Accepting argv here costs little in this threat model: the item's ACL names
/// `/usr/bin/security`, so any process of the same user can already read the token back on
/// demand (see the module doc). argv widens *passive* visibility, not *access*.
///
/// ⚠️ Whatever the input channel, the write is VERIFIED by reading it back: a truncated or
/// mangled item must never be left behind reporting success. That is exactly how the
/// stdin attempt failed, and the read-back is what makes the failure loud instead of a
/// corrupted store discovered at the next launch.
#[cfg(target_os = "macos")]
fn keychain_write(auth: &StoredAuth) -> R<()> {
    let blob = serde_json::to_string(auth)
        .map_err(|e| TosseError::Keychain(format!("could not serialize credentials: {e}")))?;

    let service = keychain_service();
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            &service,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-D",
            "Flight Deck TOSSE credentials",
            "-w",
            &blob,
        ])
        .output()
        .map_err(|e| TosseError::Keychain(format!("failed to run /usr/bin/security: {e}")))?;

    if !out.status.success() {
        return Err(TosseError::Keychain(format!(
            "security exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    // Read-back check — "written" must mean "stored intact".
    let stored = keychain_read()?.ok_or_else(|| {
        TosseError::Keychain("the credentials vanished right after being saved".into())
    })?;
    let round_tripped = serde_json::to_string(&stored)
        .map_err(|e| TosseError::Keychain(format!("could not re-serialize credentials: {e}")))?;
    if round_tripped != blob {
        return Err(TosseError::Keychain(
            "the credentials came back altered after saving — refusing to trust the stored copy"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn keychain_read() -> R<Option<StoredAuth>> {
    Ok(None)
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

/// Read-modify-write of the Keychain item, off the async runtime and behind
/// [`KEYCHAIN_LOCK`].
///
/// ⚠️ The read is propagated, never defaulted: see [`keychain_read`] for why turning an
/// unreadable store into a blank one would silently destroy credentials.
///
/// The whole read-modify-write runs inside ONE `spawn_blocking`, which is what makes it
/// abort-safe: cancelling the caller (a sign-in the user cancels mid-write) drops the await
/// but the blocking closure still runs to completion, so the item can never be left
/// half-written. The lock guard is held across that await for the same reason.
async fn with_stored<T, F>(f: F) -> R<T>
where
    F: FnOnce(StoredAuth) -> R<(StoredAuth, T)> + Send + 'static,
    T: Send + 'static,
{
    let _guard = KEYCHAIN_LOCK.lock().await;
    tokio::task::spawn_blocking(move || {
        let current = keychain_read()?.unwrap_or_default();
        let (next, out) = f(current)?;
        keychain_write(&next)?;
        Ok(out)
    })
    .await
    .map_err(|e| TosseError::Local(format!("keychain task failed: {e}")))?
}

/// Read the stored credentials off-thread. Takes [`KEYCHAIN_LOCK`] so a read can't observe
/// an item mid-rewrite, and propagates a read failure rather than reporting "signed out".
async fn read_stored() -> R<StoredAuth> {
    let _guard = KEYCHAIN_LOCK.lock().await;
    tokio::task::spawn_blocking(|| keychain_read().map(Option::unwrap_or_default))
        .await
        .map_err(|e| TosseError::Local(format!("keychain task failed: {e}")))?
}

/// Overwrite the item with a blank record, discarding whatever is there.
///
/// The ONLY sanctioned way past [`keychain_read`]'s refusal to overwrite an unreadable
/// store: a corrupted item would otherwise wedge the user out of signing in at all, since
/// every path that could repair it reads first. Called only from [`login_start`], i.e.
/// behind an explicit user action whose whole point is to replace the credentials.
async fn reset_stored() -> R<()> {
    let _guard = KEYCHAIN_LOCK.lock().await;
    tokio::task::spawn_blocking(|| keychain_write(&StoredAuth::default()))
        .await
        .map_err(|e| TosseError::Local(format!("keychain task failed: {e}")))?
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

/// Validate one endpoint from the discovery document before we trust it.
///
/// The metadata is fetched over TLS from [`BASE_URL`], so it is not attacker-controlled in
/// normal operation; this guards against a MISCONFIGURED document turning into credential
/// exfiltration. Two levels, because the endpoints do not all carry secrets:
///
/// - `secret_bearing` = true (token, registration, revocation): must be HTTPS **and** on
///   exactly [`BASE_URL`]'s host. These are the ones we POST the authorization code, the
///   refresh token and the client identity to.
/// - `secret_bearing` = false (authorization): HTTPS only. We merely OPEN it in the browser
///   with public parameters (client_id, PKCE challenge, state); the code comes back to our
///   own loopback listener, never to that host. Pinning it would be wrong anyway — TOSSE's
///   authorization endpoint legitimately lives on the FRONTEND host, not the backend.
///
/// Host pinning is deliberately an exact match rather than a "same registrable domain"
/// test: getting the latter right needs a public-suffix list, and an approximation here
/// (`*.up.railway.app`) would accept every other Railway deployment — security theatre.
fn checked_endpoint(url: Option<String>, field: &str, secret_bearing: bool) -> R<String> {
    let raw = url.ok_or_else(|| TosseError::Protocol(format!("metadata has no {field}")))?;
    let parsed = url::Url::parse(&raw)
        .map_err(|e| TosseError::Protocol(format!("{field} is not a valid URL ({e})")))?;
    if parsed.scheme() != "https" {
        return Err(TosseError::Protocol(format!(
            "{field} is not https ({raw}) — refusing to use it"
        )));
    }
    if secret_bearing {
        let base_host = url::Url::parse(BASE_URL).ok().and_then(|u| u.host_str().map(str::to_string));
        let host = parsed.host_str().unwrap_or_default();
        if Some(host) != base_host.as_deref() {
            return Err(TosseError::Protocol(format!(
                "{field} points at {host}, not the TOSSE backend — refusing to send credentials there"
            )));
        }
    }
    Ok(raw)
}

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
        // Opened in the browser with public parameters only — HTTPS is the whole check.
        authorization: checked_endpoint(field("authorization_endpoint"), "authorization_endpoint", false)?,
        // These three receive the code / refresh token / client identity: host-pinned.
        token: checked_endpoint(field("token_endpoint"), "token_endpoint", true)?,
        registration: checked_endpoint(field("registration_endpoint"), "registration_endpoint", true)?,
        revocation: match field("revocation_endpoint") {
            Some(u) => Some(checked_endpoint(Some(u), "revocation_endpoint", true)?),
            None => None,
        },
    };
    if let Ok(mut guard) = ENDPOINTS.lock() {
        *guard = Some(endpoints.clone());
    }
    Ok(endpoints)
}

/// Where TOSSE lives in a browser — the origin the tasks view links out to for everything
/// it deliberately cannot edit (a task's title, priority, assignee, due date; deletions).
///
/// DERIVED from the discovered `authorization_endpoint` rather than hard-coded, for the
/// reason spelled out on [`checked_endpoint`]: the consent page lives on the FRONTEND, so
/// that field already tells us where the web app is, and a redeployed frontend is followed
/// for free — exactly like the sign-in. Discovery is cached process-wide, so this costs at
/// most one metadata request per run.
pub async fn web_url() -> R<String> {
    origin_of(&discover().await?.authorization)
}

/// `https://host[:port]` from a URL, dropping path and query — an endpoint is not a home
/// page, so `/oauth/authorize` must not survive into the links we build.
fn origin_of(raw: &str) -> R<String> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| TosseError::Protocol(format!("authorization_endpoint is not a valid URL ({e})")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| TosseError::Protocol(format!("authorization_endpoint has no host ({raw})")))?;
    Ok(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
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
/// The registered client we may reuse, if any.
///
/// A client is reusable only while it still covers the exact ports we can bind (see
/// [`StoredAuth::redirect_ports`]) — the server matches `redirect_uri` by exact string, so a
/// stale registration dead-ends the sign-in in the BROWSER, where the app can neither see
/// nor explain the failure. Pure, so the rule is exercised by tests rather than restated
/// by them.
fn reusable_client(stored: &StoredAuth) -> Option<&str> {
    let id = stored.client_id.as_deref().filter(|s| !s.is_empty())?;
    (stored.redirect_ports.as_deref() == Some(CALLBACK_PORTS)).then_some(id)
}

async fn ensure_client(endpoints: &Endpoints) -> R<String> {
    let stored = read_stored().await?;
    if let Some(id) = reusable_client(&stored) {
        return Ok(id.to_string());
    }
    if stored.client_id.is_some() {
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
    let mut failures = Vec::new();
    for port in CALLBACK_PORTS {
        match tokio::net::TcpListener::bind(("127.0.0.1", *port)).await {
            Ok(l) => return Ok((l, *port)),
            // Keep the REAL reason for each port: "address in use" and "permission denied"
            // call for very different actions, and reporting every failure as "port busy"
            // would send the user hunting for a process that isn't the problem.
            Err(e) => failures.push(format!("{port}: {e}")),
        }
    }
    Err(TosseError::Local(format!(
        "no local port available for the sign-in callback — {}",
        failures.join(", ")
    )))
}

/// How long a single accepted connection may take to send its request head. Anything on
/// loopback sends it immediately; this only bounds a peer that connects and then says
/// nothing. Without it, ONE silent socket would stall the accept loop for the whole
/// [`LOGIN_TIMEOUT`] — any local process could freeze a sign-in for five minutes.
const CALLBACK_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Serve the redirect: accept connections until one carries a callback that is actually
/// OURS, answer it with a human-readable page, and return what it carried.
///
/// ⚠️ The loop is not optional — a browser routinely opens extra connections to the same
/// origin (favicon, speculative preconnect). Answering only the FIRST accept would often
/// consume one of those and hang waiting for a redirect that already arrived.
///
/// ⚠️ `expected_state` is matched HERE, not by the caller: a request is only "final" if its
/// `state` is ours. Otherwise any local process could hit the port with `?code=x` and abort
/// a sign-in the user is in the middle of — the check has to gate the loop, not run after it.
async fn serve_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> R<CallbackResult> {
    // Each connection is handled in its OWN task, and the accept loop never waits on one.
    // Handling them in sequence meant a single peer that connected and stayed silent held
    // the loop for its entire read timeout — any local process could stall the sign-in just
    // by opening sockets. Now a stalled connection only delays itself.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<CallbackResult>(4);
    let state = expected_state.to_string();

    let accept_loop = async move {
        loop {
            let (sock, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => return TosseError::Local(format!("callback accept failed: {e}")),
            };
            let tx = tx.clone();
            let state = state.clone();
            tokio::spawn(async move { handle_callback_conn(sock, &state, tx).await });
        }
    };

    tokio::select! {
        // The first handler to recognise OUR callback wins.
        Some(cb) = rx.recv() => Ok(cb),
        err = accept_loop => Err(err),
    }
}

/// Answer one connection, and forward the result if it is the callback we are waiting for.
async fn handle_callback_conn(
    mut sock: tokio::net::TcpStream,
    expected_state: &str,
    tx: tokio::sync::mpsc::Sender<CallbackResult>,
) {
    // Bounded in BOTH size and time: a rogue or stalled client can neither stream into
    // memory nor hold this task open.
    let Ok(head) = tokio::time::timeout(CALLBACK_READ_TIMEOUT, read_request_head(&mut sock)).await
    else {
        let _ = sock.shutdown().await;
        return;
    };

    let parsed = parse_callback_request(&head);
    // Ours only if it carries an outcome AND the state we issued. A stray hit gets a 404
    // and is forgotten; the listener stays up for the genuine redirect.
    let is_ours = parsed.as_ref().is_some_and(|p| {
        (p.code.is_some() || p.error.is_some()) && p.state.as_deref() == Some(expected_state)
    });

    let page = match &parsed {
        Some(p) if is_ours && p.error.is_some() => {
            html_page("Sign-in refused", "You can close this tab and try again in Flight Deck.")
        }
        Some(p) if is_ours && p.code.is_some() => {
            html_page("Flight Deck is connected", "You can close this tab.")
        }
        _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
    };
    let _ = sock.write_all(page.as_bytes()).await;
    let _ = sock.flush().await;
    let _ = sock.shutdown().await;

    if is_ours {
        // A full channel (or a receiver already gone) means the flow is settled — dropping
        // this duplicate is correct, not a swallowed error.
        let _ = tx.try_send(parsed.expect("is_ours implies parsed"));
    }
}

/// Read one HTTP request head (up to the blank line), capped at 16 KiB. Returns whatever
/// arrived on EOF or read error — the caller decides whether it is a usable request.
async fn read_request_head(sock: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match sock.read(&mut chunk).await {
            Ok(0) => return String::from_utf8_lossy(&buf).into_owned(),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if text.contains("\r\n\r\n") || buf.len() > 16 * 1024 {
                    return text.into_owned();
                }
            }
            Err(_) => return String::from_utf8_lossy(&buf).into_owned(),
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
    // Collect `error` and `error_description` separately, then pick. Writing both into the
    // same field made the winner depend on the ORDER the server happened to emit them in
    // (last write wins), so `?error_description=…&error=…` silently showed the machine code
    // instead of the sentence — the opposite of what the comment promised.
    let mut error_code = None;
    let mut error_description = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => out.code = Some(v.into_owned()),
            "state" => out.state = Some(v.into_owned()),
            "error" => error_code = Some(v.into_owned()),
            "error_description" => error_description = Some(v.into_owned()),
            _ => {}
        }
    }
    // Prefer the human description whenever it is present, whatever the order.
    out.error = error_description.or(error_code);
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
    // Signing in is the one action whose whole point is to replace the credentials, so it
    // is also the only sanctioned way out of an unreadable store: everything else refuses
    // to overwrite what it cannot read, which would otherwise leave a corrupted item
    // permanently wedging the user out (every repair path reads first).
    if let Err(e) = read_stored().await {
        eprintln!("[tosse] stored credentials unusable ({e}); resetting them for a fresh sign-in");
        reset_stored().await?;
    }
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
    // The `state` nonce ties the redirect to the request WE started; `serve_callback` only
    // returns once it sees a callback carrying it, so anything else was already ignored
    // (and kept the listener alive) rather than aborting this sign-in.
    let cb = match tokio::time::timeout(LOGIN_TIMEOUT, serve_callback(listener, &expected_state)).await
    {
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
        // A working session supersedes whatever killed the previous one — otherwise the
        // card would keep explaining a death the user has already recovered from.
        a.signed_out_reason = None;
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
    let stored = read_stored().await?;
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
        // ⚠️ Only a grant the server actually REJECTED is terminal. Everything else — 429,
        // 5xx, a captive portal, a Railway redeploy returning 502 — is transient, and
        // clearing on it would destroy a perfectly valid refresh token and force the whole
        // browser sign-in again. RFC 6749 §5.2 says a dead grant is a 400 with
        // `invalid_grant` / `invalid_client`; anything else is reported WITH its status and
        // the server's own message, and the stored session is left untouched (`status()`
        // treats `Http` as non-terminal, so the card stays connected).
        if is_terminal_grant_failure(status, &text) {
            // Report a failed wipe instead of swallowing it: "signed out" must not be a lie.
            // The reason is PERSISTED, because this error is returned to whoever triggered
            // the refresh — often a background query nothing renders. Stored, it survives to
            // the next `status()` and the Settings card explains what happened.
            // The wording is a constant because the front keys off it — see
            // [`SESSION_GONE_MARKERS`].
            clear_tokens(Some(SESSION_REVOKED_REASON.to_string())).await?;
            return Err(TosseError::Denied(SESSION_REVOKED_REASON.to_string()));
        }
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&text),
        });
    }
    let tokens = parse_token_response(&text)?;
    let access = tokens.access_token.clone();
    // ⚠️ A write failure here is NOT cosmetic: the server has already rotated the pair and
    // revoked the token we just used, so a rotation we fail to persist means the stored
    // refresh token is dead. Say so as a terminal error rather than returning an access
    // token that works once and leaves the next call to fail mysteriously.
    if let Err(e) = store_tokens(tokens).await {
        return Err(TosseError::Denied(format!(
            "the refreshed TOSSE session could not be saved ({e}) — sign in again"
        )));
    }
    Ok(access)
}

/// Whether a refused token-endpoint response means the GRANT itself is dead (so the stored
/// session must be cleared), as opposed to a transient server or network condition.
///
/// Kept narrow on purpose: misclassifying a transient failure here costs the user their
/// session. A 400/401 alone is not enough — we require the OAuth error code that says the
/// grant is gone (RFC 6749 §5.2).
fn is_terminal_grant_failure(status: reqwest::StatusCode, body: &str) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST && status != reqwest::StatusCode::UNAUTHORIZED {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return false; // Unparseable body: assume transient, keep the session.
    };
    matches!(
        v.get("error").and_then(Value::as_str),
        Some("invalid_grant") | Some("invalid_client") | Some("unauthorized_client")
    )
}

/// Drop the tokens but KEEP the registered `client_id` (see [`StoredAuth`]).
///
/// `reason` records WHY, and is what a later `status()` shows instead of the first-time
/// invitation. `None` for a sign-out the user asked for — they know why that happened, and
/// a "your session expired" note under a button they just pressed would be nonsense.
async fn clear_tokens(reason: Option<String>) -> R<()> {
    with_stored(move |mut a| {
        a.access_token = None;
        a.refresh_token = None;
        a.expires_at_ms = None;
        a.signed_out_reason = reason;
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
    let stored = match read_stored().await {
        Ok(s) => s,
        // The credential store itself is unreadable (Keychain denied, corrupted item). That
        // is NOT "never signed in": say so, so the card explains it instead of quietly
        // inviting a sign-in that may hit the same wall.
        Err(e) => {
            return TosseAccountStatus {
                connected: false,
                name: None,
                email: None,
                signed_out_reason: Some(e.to_string()),
                identity_error: None,
            }
        }
    };
    if stored.refresh_token.is_none() && stored.access_token.is_none() {
        return TosseAccountStatus {
            connected: false,
            name: None,
            email: None,
            // A session that DIED says so, instead of showing the same blank invitation as a
            // machine that never connected. The cause was recorded when the tokens were
            // cleared, because the refresh that discovered it usually ran behind a
            // background query whose error nothing displays.
            signed_out_reason: stored.signed_out_reason.clone(),
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
    let (name, email) = (s("name"), s("email"));
    // A 200 whose shape we don't recognise must not pass as "connected, no identity": that
    // silently blanks the card with nothing to act on. Treat it as the protocol error it is.
    if name.is_none() && email.is_none() {
        return Err(TosseError::Protocol(format!(
            "the identity response carried neither a name nor an email: {}",
            snippet(&body)
        )));
    }
    Ok((name, email))
}

/// Sign out: best-effort token revocation server-side, then drop the local tokens.
///
/// The local clear runs even when revocation fails (offline, server down) — otherwise a
/// user could not sign out of a machine they no longer trust. The revocation error is
/// returned so the UI can say the server-side session may still be live.
pub async fn logout() -> R<()> {
    // ⚠️ A sign-IN in flight resurrects the session just as effectively as a refresh does,
    // and it was not covered: `complete_login` writes through `store_tokens`, which only
    // takes KEYCHAIN_LOCK, so a browser round-trip finishing after the clear left the app
    // connected to the account the user had just signed out of — reporting success both
    // times. Abort it FIRST, under LOGIN_FLOW like every other cancel path.
    // Lock order is LOGIN_FLOW → REFRESH_LOCK, and `login_start` never takes REFRESH_LOCK,
    // so no inversion is possible.
    {
        let _flow = LOGIN_FLOW.lock().await;
        cancel_current().await;
    }
    // ⚠️ Hold REFRESH_LOCK for the WHOLE sign-out. Without it a refresh already in flight
    // finishes after we clear and writes a fresh token pair back — silently resurrecting the
    // session the user just ended, with the UI reporting success. Signing out has to win.
    let _refresh_guard = REFRESH_LOCK.lock().await;
    let stored = read_stored().await?;
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
    // No reason recorded: the user asked for this one, and a "your session expired" note
    // under the button they just pressed would be nonsense.
    clear_tokens(None).await?;
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

// ── Repositories ─────────────────────────────────────────────────────────────────────

/// A project a repository is attached to, trimmed to what the app displays. The CRM models
/// repository↔project as N-N, so this is a list, and it can legitimately be empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseProjectRef {
    pub id: String,
    pub name: String,
    pub status: Option<String>,
}

/// A repository as TOSSE knows it.
///
/// ⚠️ `url` is nullable in the CRM's schema and genuinely absent on a fair share of the
/// rows — a repository with no url can never be matched automatically, which is the whole
/// reason a manual association exists alongside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseRepository {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
    pub host: Option<String>,
    /// `"Actif"` / `"Archivé"`. Shown, never used to filter: hiding an archived repository
    /// would silently break an association the user made deliberately.
    pub status: Option<String>,
    /// The repo-level context the CRM keeps for agents — Markdown, rendered as-is.
    pub context: Option<String>,
    pub projects: Vec<TosseProjectRef>,
}

/// GET a first-party `/api/v1/*` endpoint with our Bearer token, parsed as JSON.
///
/// The single entry point for TOSSE data reads (the Tasks view will reuse it), so the
/// token handling, the error shaping and the `{success, data}` envelope live in one place.
async fn api_get(path: &str) -> R<Value> {
    let token = access_token().await?;
    let url = format!("{BASE_URL}{path}");
    let (status, body) = send_text(http()?.get(&url).bearer_auth(token)).await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&body),
        });
    }
    serde_json::from_str(&body)
        .map_err(|e| TosseError::Protocol(format!("{path} did not return JSON ({e})")))
}

/// Every repository TOSSE holds (`GET /api/v1/repositories`).
///
/// Read-only, always: the CRM has no field for a local path, and a path on one machine
/// means nothing on another — the association is kept locally and NEVER written back.
pub async fn list_repositories() -> R<Vec<TosseRepository>> {
    let v = api_get("/api/v1/repositories").await?;
    let items = v
        .pointer("/data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TosseError::Protocol(format!(
                "the repository list carried no `data` array: {}",
                snippet(&v.to_string())
            ))
        })?;
    items.iter().map(parse_repository).collect()
}

/// Shape one repository. A row without an `id` is a protocol error rather than a skipped
/// entry: silently dropping rows would show a short list that looks complete.
fn parse_repository(v: &Value) -> R<TosseRepository> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let id = s("id").ok_or_else(|| {
        TosseError::Protocol(format!(
            "a repository came back without an id: {}",
            snippet(&v.to_string())
        ))
    })?;
    let projects = v
        .get("projects")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                // The join row nests the project; tolerate a flattened shape too.
                .map(|row| row.get("project").unwrap_or(row))
                .filter_map(|p| {
                    Some(TosseProjectRef {
                        id: p.get("id").and_then(Value::as_str)?.to_string(),
                        name: p
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Untitled project")
                            .to_string(),
                        status: p.get("status").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TosseRepository {
        name: s("name").unwrap_or_else(|| id.clone()),
        id,
        url: s("url"),
        host: s("host"),
        status: s("status"),
        context: s("context"),
        projects,
    })
}

// ── Matching a local folder to a repository ──────────────────────────────────────────

/// How a local folder came to be linked to a CRM repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TosseLinkSource {
    /// The user picked it — always wins over any automatic match.
    Manual,
    /// Derived from the folder's `origin` remote.
    Remote,
}

/// What the caller knows about one local folder, gathered before matching. Keeping this an
/// INPUT is what lets [`resolve_links`] stay pure: git and SQLite are read by the IPC layer.
#[derive(Debug, Clone)]
pub struct LocalRepo {
    /// Flight Deck's own repo id (the SQLite primary key).
    pub repo_id: String,
    /// `origin`'s URL, or `None` for a repository with no remote.
    pub remote_url: Option<String>,
    /// A repository id the user pinned by hand, if any.
    pub manual_repository_id: Option<String>,
}

/// One local folder's relationship to TOSSE, as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseRepoLink {
    pub repo_id: String,
    /// Whether matching actually RAN. False when the CRM's repository list could not be
    /// read: the fields below then say nothing about reality.
    ///
    /// ⚠️ The distinction that must never collapse: "we looked and found nothing" versus
    /// "we could not look". Resolving against an empty list makes the two identical, and
    /// the UI then tells the user their repository was deleted — during a 30-second outage,
    /// with a destructive button as the only way out.
    pub resolved: bool,
    pub remote_url: Option<String>,
    /// The linked repository. `None` covers three DIFFERENT situations the UI must not
    /// blur: nothing matched, the remote matched several (see `ambiguous`), or a manual
    /// link points at a repository the CRM no longer returns (see `manual_repository_id`).
    pub repository: Option<TosseRepository>,
    pub source: Option<TosseLinkSource>,
    /// The id the user pinned. Kept even when it resolves to nothing, so the UI can say
    /// "the repository you picked is gone" instead of quietly falling back to unlinked.
    pub manual_repository_id: Option<String>,
    /// Candidates when one remote matches SEVERAL CRM repositories. We never pick for the
    /// user; the UI offers the choice.
    pub ambiguous: Vec<TosseRepository>,
    /// The folder is not a git repository at all — an ORDINARY situation here (Flight Deck
    /// works in folders, not only in clones), so it is not an error: it just means no
    /// automatic match is possible, and only a manual pick can associate it.
    pub not_a_repository: bool,
    /// Why the folder's remote could not be read — a genuine FAULT only (the folder has
    /// vanished, permissions, git missing). `None` on the happy path, when the repository
    /// simply has no remote, AND when the folder is not a repository: those are answers.
    pub remote_error: Option<String>,
}

/// Pair local folders with CRM repositories. Pure — no IO, no globals — so the matching
/// rules are unit-testable and have exactly one definition.
///
/// Precedence is deliberate: a manual link ALWAYS wins, because it is the only signal that
/// records a human decision; the remote is a good guess, not an instruction.
///
/// `repositories` is `None` when the CRM list could not be READ (offline, 5xx). Every link
/// then comes back `resolved: false` and carries no verdict — the caller must not conclude
/// anything from it. Passing `Some(&[])` is a different statement: the CRM was reached and
/// genuinely holds no repository.
pub fn resolve_links(
    locals: &[LocalRepo],
    repositories: Option<&[TosseRepository]>,
) -> Vec<TosseRepoLink> {
    let Some(repositories) = repositories else {
        return locals
            .iter()
            .map(|local| TosseRepoLink {
                repo_id: local.repo_id.clone(),
                resolved: false,
                remote_url: local.remote_url.clone(),
                repository: None,
                source: None,
                manual_repository_id: local.manual_repository_id.clone(),
                ambiguous: Vec::new(),
                not_a_repository: false,
                remote_error: None,
            })
            .collect();
    };
    locals
        .iter()
        .map(|local| {
            let manual = local.manual_repository_id.as_deref().and_then(|id| {
                repositories
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| (r.clone(), TosseLinkSource::Manual))
            });
            let mut ambiguous = Vec::new();
            let resolved = manual.or_else(|| {
                // A pinned id that resolved to nothing must NOT silently fall back to the
                // remote guess: the user's choice would appear to have been overruled.
                if local.manual_repository_id.is_some() {
                    return None;
                }
                let key = local
                    .remote_url
                    .as_deref()
                    .and_then(crate::git::normalize_remote_url)?;
                let mut matches = repositories.iter().filter(|r| {
                    r.url
                        .as_deref()
                        .and_then(crate::git::normalize_remote_url)
                        .is_some_and(|k| k == key)
                });
                let first = matches.next()?;
                let rest: Vec<_> = matches.cloned().collect();
                if rest.is_empty() {
                    Some((first.clone(), TosseLinkSource::Remote))
                } else {
                    ambiguous.push(first.clone());
                    ambiguous.extend(rest);
                    None
                }
            });
            let (repository, source) = match resolved {
                Some((r, s)) => (Some(r), Some(s)),
                None => (None, None),
            };
            TosseRepoLink {
                repo_id: local.repo_id.clone(),
                resolved: true,
                remote_url: local.remote_url.clone(),
                repository,
                source,
                manual_repository_id: local.manual_repository_id.clone(),
                ambiguous,
                not_a_repository: false,
                remote_error: None,
            }
        })
        .collect()
}

// ── Briefing: everything the Tasks view reads, in one request ────────────────────────

/// The client a project hangs off. Nullable in the CRM (a project reaches its client
/// THROUGH a mission, and either link can be missing), which is why the view needs a
/// "no client" band rather than assuming every project has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseClientRef {
    pub id: String,
    pub name: String,
    pub logo_url: Option<String>,
    /// The client's website, when the CRM has one.
    ///
    /// Carried for its DOMAIN, not as a link: the CRM's own avatar falls back to that
    /// domain's favicon when no logo has been uploaded, which is how most of its clients
    /// end up with a mark at all.
    pub website: Option<String>,
}

/// A task as the briefing lists it — enough to render a row, and no more.
///
/// ⚠️ Deliberately WITHOUT `context`/`content`: the briefing omits them, and pulling every
/// task's Markdown into a list of dozens would cost far more than it shows. The detail
/// panel fetches the full task by id when one is actually opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseTask {
    pub id: String,
    pub title: String,
    /// Raw CRM value (`"En cours"`, `"À faire"`, `"Review"`…), shown as-is: it is data, like
    /// a project name, and translating it would drift from the CRM read in a browser.
    pub status: String,
    pub priority: Option<String>,
    /// The CRM's `type` field (`"Code"`, `"Admin"`…). Renamed because `type` is a Rust
    /// keyword; the wire name is handled by the parser, not by serde.
    pub kind: Option<String>,
    pub assigned_to: Option<String>,
    pub due_date: Option<String>,
    pub notes: Option<String>,
    pub subtask_count: u32,
    pub subtask_done: u32,
}

/// A project with the tasks the briefing kept for it.
///
/// `tasks` is empty for a paused project: the endpoint reports those by name only, and the
/// view says so instead of pretending the project has nothing left to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseProject {
    pub id: String,
    pub name: String,
    /// `"En cours"` / `"En pause"` / `"À démarrer"` — drives the card's state control.
    pub status: Option<String>,
    pub client: Option<TosseClientRef>,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub tasks: Vec<TosseTask>,
    /// Progress across ALL of the project's tasks, done included — the briefing counts them
    /// server-side, so the ring means the same thing here as on the CRM's own page.
    pub task_count: u32,
    pub task_done: u32,
}

/// `GET /api/v1/briefing/morning`, normalised.
///
/// ⚠️ What this endpoint deliberately LEAVES OUT: tasks in `Backlog`, `En attente` or
/// `Fait`, and projects that are `Terminé`/`Archivé`. That is the right cut for a "what am
/// I working on" screen — anything else is a targeted `/tasks?project_id=…` away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseBriefing {
    pub projects: Vec<TosseProject>,
    /// Paused projects, metadata only (no tasks) — shown recessed rather than hidden, so a
    /// project you deliberately parked doesn't vanish from the app that manages it.
    pub paused_projects: Vec<TosseProject>,
    /// Tasks attached to no project at all. They have no card to live in, so the view gives
    /// them their own band instead of dropping them.
    pub general_tasks: Vec<TosseTask>,
}

/// Everything the Tasks view shows, in ONE request (`GET /api/v1/briefing/morning`).
///
/// The CRM already assembles exactly this shape for its own Briefing page — projects with
/// their client, their tasks and their counts — so we read that instead of stitching
/// `/clients` + `/projects` + `/tasks` together and re-deriving what the server computed.
pub async fn briefing() -> R<TosseBriefing> {
    let v = api_get("/api/v1/briefing/morning").await?;
    let data = v.pointer("/data").ok_or_else(|| {
        TosseError::Protocol(format!(
            "the briefing carried no `data` object: {}",
            snippet(&v.to_string())
        ))
    })?;
    parse_briefing(data)
}

/// A backlog task, plus the project it belongs to so the view can file it under the right
/// card. `project_id` is `None` for a task that has no project at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseBacklogTask {
    pub project_id: Option<String>,
    pub task: TosseTask,
}

/// Every task sitting in `Backlog`.
///
/// ⚠️ A SEPARATE request on purpose: the briefing deliberately excludes Backlog (along with
/// `Fait`, `En attente` and `Archivé`) because it answers "what am I working on", and the
/// server is the one who decides that. Rather than fight it, we ask the tasks endpoint for
/// exactly the status the briefing left out.
///
/// `active_projects_only` mirrors the briefing's own view of the world, so a backlog task
/// belonging to a paused or finished project does not reappear under a card the briefing
/// itself would not show.
pub async fn backlog() -> R<Vec<TosseBacklogTask>> {
    let v = api_get("/api/v1/tasks?status=Backlog&active_projects_only=true").await?;
    let rows = v
        .pointer("/data")
        .or_else(|| v.get("data"))
        .unwrap_or(&v);
    let Value::Array(rows) = rows else {
        return Err(TosseError::Protocol(format!(
            "the task list was not an array: {}",
            snippet(&rows.to_string())
        )));
    };
    rows.iter()
        .map(|row| {
            Ok(TosseBacklogTask {
                project_id: row
                    .pointer("/project/id")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("projectId").and_then(Value::as_str))
                    .map(str::to_string),
                task: parse_task(row)?,
            })
        })
        .collect()
}

/// Shape the briefing payload. Split from the request so the mapping is testable without a
/// network round-trip — the shape is the part that breaks when the CRM changes.
fn parse_briefing(data: &Value) -> R<TosseBriefing> {
    // ⚠️ `projects` must be PRESENT. A wrong type is already loud (`parse_list`), but a
    // missing key was silent: it produced an empty board, which the view renders as
    // "Nothing open in TOSSE" — a confident statement about the user's workload, made from
    // a payload we failed to understand. An endpoint that stops sending its main list is a
    // protocol change, and it has to say so.
    if data.get("projects").is_none() {
        return Err(TosseError::Protocol(format!(
            "the briefing carried no `projects` list: {}",
            snippet(&data.to_string())
        )));
    }
    Ok(TosseBriefing {
        projects: parse_list(data.get("projects"), parse_project)?,
        // `pausedProjects` and `general` are omitted when empty — absence IS the answer.
        paused_projects: parse_list(data.get("pausedProjects"), parse_project)?,
        general_tasks: parse_list(data.pointer("/general/tasks"), parse_task)?,
    })
}

/// Map a (possibly absent) JSON array. A missing key is an empty list; a key holding
/// something that is NOT an array is a protocol error, because that means the shape changed
/// under us and silently rendering nothing would look like "you have no work".
fn parse_list<T>(v: Option<&Value>, f: impl Fn(&Value) -> R<T>) -> R<Vec<T>> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(rows)) => rows.iter().map(f).collect(),
        Some(other) => Err(TosseError::Protocol(format!(
            "expected a list, got {}",
            snippet(&other.to_string())
        ))),
    }
}

fn parse_task(v: &Value) -> R<TosseTask> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
    let id = s("id").ok_or_else(|| {
        TosseError::Protocol(format!(
            "a task came back without an id: {}",
            snippet(&v.to_string())
        ))
    })?;
    Ok(TosseTask {
        id,
        title: s("title").unwrap_or_else(|| "Untitled task".to_string()),
        // A row with no status would be unplaceable in a status-grouped view; the CRM always
        // sends one, and "À faire" is the harmless landing spot if it ever doesn't.
        status: s("status").unwrap_or_else(|| "À faire".to_string()),
        priority: s("priority"),
        kind: s("type"),
        assigned_to: s("assignedTo"),
        due_date: s("dueDate"),
        notes: s("notes"),
        subtask_count: n("subtaskCount"),
        subtask_done: n("subtaskDone"),
    })
}

fn parse_project(v: &Value) -> R<TosseProject> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let id = s("id").ok_or_else(|| {
        TosseError::Protocol(format!(
            "a project came back without an id: {}",
            snippet(&v.to_string())
        ))
    })?;
    let client = v.get("client").filter(|c| !c.is_null()).and_then(|c| {
        Some(TosseClientRef {
            id: c.get("id").and_then(Value::as_str)?.to_string(),
            name: c
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled client")
                .to_string(),
            logo_url: c.get("logoUrl").and_then(Value::as_str).map(str::to_string),
            website: c.get("website").and_then(Value::as_str).map(str::to_string),
        })
    });
    Ok(TosseProject {
        id,
        name: s("name").unwrap_or_else(|| "Untitled project".to_string()),
        status: s("status"),
        client,
        start_date: s("startDate"),
        due_date: s("dueDate"),
        tasks: parse_list(v.get("tasks"), parse_task)?,
        task_count: v.get("taskCount").and_then(Value::as_u64).unwrap_or(0) as u32,
        task_done: v.get("taskDone").and_then(Value::as_u64).unwrap_or(0) as u32,
    })
}

// ── Writes ───────────────────────────────────────────────────────────────────────────

/// Send a JSON body to a first-party endpoint with our Bearer token, and return the
/// response's `data`.
///
/// Same shape as [`api_get`] on purpose: one place holds the token, the envelope and the
/// error text, so a failed write reports the sentence the server wrote rather than a status
/// code. ⚠️ The CRM's REST payloads are **camelCase** (`projectId`), unlike the MCP tools'
/// snake_case — the difference is real and silently drops fields if mixed up.
async fn api_write(method: reqwest::Method, path: &str, body: &Value) -> R<Value> {
    let token = access_token().await?;
    let url = format!("{BASE_URL}{path}");
    let (status, text) = send_text(
        http()?
            .request(method, &url)
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string()),
    )
    .await?;
    if !status.is_success() {
        return Err(TosseError::Http {
            status: status.as_u16(),
            body: readable_error(&text),
        });
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| TosseError::Protocol(format!("{path} did not return JSON ({e})")))?;
    Ok(v.pointer("/data").cloned().unwrap_or(Value::Null))
}

/// Move a task to another status (`PATCH /api/v1/tasks/:id`).
///
/// The status string is passed through untouched rather than validated against a list we
/// keep here: the server owns that enum, and a local copy would drift the day it gains a
/// value. An invalid one comes back as a readable 400.
pub async fn set_task_status(task_id: &str, status: &str) -> R<()> {
    api_write(
        reqwest::Method::PATCH,
        &format!("/api/v1/tasks/{task_id}"),
        &serde_json::json!({ "status": status }),
    )
    .await
    .map(|_| ())
}

/// Move a project to another status (`PATCH /api/v1/projects/:id`) — the Start / Pause /
/// Finish control on a project card.
pub async fn set_project_status(project_id: &str, status: &str) -> R<()> {
    api_write(
        reqwest::Method::PATCH,
        &format!("/api/v1/projects/{project_id}"),
        &serde_json::json!({ "status": status }),
    )
    .await
    .map(|_| ())
}

/// Create a task in a project (`POST /api/v1/tasks`), returning it as the list renders it.
///
/// `source` is `"Manuel"`, not `"Claude Code"`: a human typed this title into a form. The
/// distinction is what lets the CRM tell apart what an agent filed from what we did.
pub async fn create_task(
    project_id: &str,
    title: &str,
    status: &str,
    kind: Option<&str>,
    priority: Option<&str>,
    assigned_to: Option<&str>,
) -> R<TosseTask> {
    let mut body = serde_json::json!({
        "title": title,
        "projectId": project_id,
        "status": status,
        "source": "Manuel",
    });
    // Omitted rather than sent as null: the create schema treats an absent field as "use the
    // default", while an explicit null is a value the validator would reject.
    let map = body.as_object_mut().expect("json! built an object");
    for (k, v) in [
        ("type", kind),
        ("priority", priority),
        ("assignedTo", assigned_to),
    ] {
        if let Some(v) = v {
            map.insert(k.to_string(), Value::String(v.to_string()));
        }
    }
    let created = api_write(reqwest::Method::POST, "/api/v1/tasks", &body).await?;
    parse_task(&created)
}

// ── One task, in full (the detail panel) ─────────────────────────────────────────────

/// A task referenced by another — a blocker, or something this task blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseTaskLink {
    pub id: String,
    pub title: String,
    pub status: Option<String>,
    /// A resolved relation is history, not a live blocker: the panel keeps showing it, but
    /// dimmed, so "why was this stuck" stays answerable after the fact.
    pub resolved: bool,
}

/// Everything the detail panel shows for one task (`GET /api/v1/tasks/:id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseTaskDetail {
    /// The same row shape the list uses, so the panel and the row can't disagree.
    pub task: TosseTask,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    /// The long-form fields the briefing omits — Markdown, rendered as-is.
    pub context: Option<String>,
    pub content: Option<String>,
    pub subtasks: Vec<TosseTask>,
    pub blocked_by: Vec<TosseTaskLink>,
    pub blocks: Vec<TosseTaskLink>,
}

/// Fetch one task in full. Called when a row is opened, never for a list — this is the
/// request that carries the Markdown the briefing deliberately leaves out.
pub async fn task_detail(task_id: &str) -> R<TosseTaskDetail> {
    let v = api_get(&format!("/api/v1/tasks/{task_id}")).await?;
    let data = v.pointer("/data").ok_or_else(|| {
        TosseError::Protocol(format!(
            "the task carried no `data` object: {}",
            snippet(&v.to_string())
        ))
    })?;
    let s = |k: &str| data.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(TosseTaskDetail {
        task: parse_task(data)?,
        project_id: data
            .pointer("/project/id")
            .and_then(Value::as_str)
            .map(str::to_string),
        project_name: data
            .pointer("/project/name")
            .and_then(Value::as_str)
            .map(str::to_string),
        context: s("context"),
        content: s("content"),
        subtasks: parse_list(data.get("subtasks"), parse_task)?,
        blocked_by: parse_list(data.get("blockedBy"), parse_task_link)?,
        blocks: parse_list(data.get("blocks"), parse_task_link)?,
    })
}

fn parse_task_link(v: &Value) -> R<TosseTaskLink> {
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TosseError::Protocol(format!(
                "a task relation came back without an id: {}",
                snippet(&v.to_string())
            ))
        })?
        .to_string();
    Ok(TosseTaskLink {
        id,
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled task")
            .to_string(),
        status: v.get("status").and_then(Value::as_str).map(str::to_string),
        resolved: v.get("resolvedAt").is_some_and(|r| !r.is_null()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str, name: &str, url: Option<&str>) -> TosseRepository {
        TosseRepository {
            id: id.to_string(),
            name: name.to_string(),
            url: url.map(str::to_string),
            host: Some("github".into()),
            status: Some("Actif".into()),
            context: None,
            projects: Vec::new(),
        }
    }

    fn local(repo_id: &str, remote: Option<&str>, manual: Option<&str>) -> LocalRepo {
        LocalRepo {
            repo_id: repo_id.to_string(),
            remote_url: remote.map(str::to_string),
            manual_repository_id: manual.map(str::to_string),
        }
    }

    /// The real production pair the whole feature hangs on: the local folder is called
    /// `CRM_max` and speaks SSH, the CRM calls the same repository "TOSSE" over HTTPS.
    /// Matching by NAME would miss it — matching by normalized remote finds it.
    #[test]
    fn matches_a_folder_to_its_repository_by_remote_despite_different_names() {
        let repositories = vec![
            repo("r-tosse", "TOSSE", Some("https://github.com/Alex375/CRM_max")),
            repo(
                "r-code",
                "tosse-code",
                Some("https://github.com/Alex375/tosse-code"),
            ),
        ];
        let links = resolve_links(
            &[local("local-crm", Some("git@github.com:Alex375/CRM_max.git"), None)],
            Some(&repositories),
        );
        assert_eq!(links[0].repository.as_ref().map(|r| r.name.as_str()), Some("TOSSE"));
        assert_eq!(links[0].source, Some(TosseLinkSource::Remote));
        assert!(links[0].ambiguous.is_empty());
    }

    /// The cases that never resolve on their own, and must read as "unlinked" rather than
    /// as an error: a folder with no remote, and a CRM repository with no url.
    #[test]
    fn a_folder_with_no_remote_and_a_repository_with_no_url_stay_unlinked() {
        let repositories = vec![repo("r-none", "landing_page", None)];
        let links = resolve_links(
            &[local("local-a", None, None), local("local-b", Some(""), None)],
            Some(&repositories),
        );
        assert!(links.iter().all(|l| l.repository.is_none() && l.source.is_none()));
        // Two url-less sides must not match EACH OTHER through an empty key.
        assert!(links.iter().all(|l| l.ambiguous.is_empty()));
    }

    /// A human decision outranks the automatic guess, and is not overruled by it.
    #[test]
    fn a_manual_link_wins_over_the_remote_match() {
        let repositories = vec![
            repo("r-guess", "guessed", Some("https://github.com/Alex375/app")),
            repo("r-picked", "picked-by-hand", Some("https://github.com/other/thing")),
        ];
        let links = resolve_links(
            &[local(
                "local-a",
                Some("https://github.com/Alex375/app.git"),
                Some("r-picked"),
            )],
            Some(&repositories),
        );
        assert_eq!(
            links[0].repository.as_ref().map(|r| r.id.as_str()),
            Some("r-picked")
        );
        assert_eq!(links[0].source, Some(TosseLinkSource::Manual));
    }

    /// A pinned repository the CRM no longer returns (deleted server-side) must surface as
    /// a broken choice — never as a quiet fallback to the remote guess, which would look
    /// like the app silently overrode the user.
    #[test]
    fn a_stale_manual_link_does_not_fall_back_to_the_remote_guess() {
        let repositories = vec![repo("r-guess", "guessed", Some("https://github.com/Alex375/app"))];
        let links = resolve_links(
            &[local(
                "local-a",
                Some("https://github.com/Alex375/app"),
                Some("r-deleted"),
            )],
            Some(&repositories),
        );
        assert_eq!(links[0].repository, None);
        assert_eq!(links[0].source, None);
        assert_eq!(links[0].manual_repository_id.as_deref(), Some("r-deleted"));
    }

    /// Two CRM rows pointing at one remote: we refuse to pick, and hand both to the UI.
    #[test]
    fn an_ambiguous_remote_offers_the_candidates_instead_of_guessing() {
        let repositories = vec![
            repo("r-1", "first", Some("https://github.com/Alex375/dup")),
            repo("r-2", "second", Some("git@github.com:Alex375/dup.git")),
        ];
        let links = resolve_links(
            &[local("local-a", Some("https://github.com/Alex375/dup"), None)],
            Some(&repositories),
        );
        assert_eq!(links[0].repository, None);
        assert_eq!(links[0].ambiguous.len(), 2);
    }

    /// The regression that matters most: a list we could NOT read must never produce a
    /// verdict. Resolving against an empty list would make "we could not look" identical to
    /// "we looked and found nothing" — and the UI then announces that the user's chosen
    /// repository was deleted, during what is often a 30-second outage.
    #[test]
    fn an_unreadable_repository_list_yields_no_verdict_at_all() {
        let locals = [
            local("local-pinned", Some("https://github.com/Alex375/app"), Some("r-picked")),
            local("local-plain", Some("https://github.com/Alex375/other"), None),
        ];

        let blind = resolve_links(&locals, None);
        assert!(blind.iter().all(|l| !l.resolved), "nothing was resolved");
        assert!(blind.iter().all(|l| l.repository.is_none() && l.source.is_none()));
        // The user's own choice is carried through untouched, so it can be restored — and
        // never mistaken for "the repository is gone".
        assert_eq!(blind[0].manual_repository_id.as_deref(), Some("r-picked"));

        // Reaching a CRM that genuinely holds nothing is a DIFFERENT statement, and it does
        // count as a verdict.
        let empty = resolve_links(&locals, Some(&[]));
        assert!(empty.iter().all(|l| l.resolved), "an empty CRM is still an answer");
    }

    /// The `{success, data}` envelope, the nested N-N project join, and a null url — the
    /// exact shape `GET /api/v1/repositories` returns in production.
    #[test]
    fn parses_a_repository_row_with_its_nested_projects() {
        let row = serde_json::json!({
            "id": "518262ab",
            "name": "fiabila-ia-formulation",
            "url": null,
            "host": "github",
            "status": "Actif",
            "context": "# Repo\n\nSome markdown.",
            "projects": [
                { "projectId": "3dd2c6c2",
                  "project": { "id": "3dd2c6c2", "name": "IA de formulation", "status": "En cours" } }
            ]
        });
        let parsed = parse_repository(&row).expect("a well-formed row must parse");
        assert_eq!(parsed.url, None);
        assert_eq!(parsed.context.as_deref(), Some("# Repo\n\nSome markdown."));
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].name, "IA de formulation");
        assert_eq!(parsed.projects[0].status.as_deref(), Some("En cours"));
    }

    /// A row missing its id fails loudly: dropping it would render a short list that looks
    /// complete, and the user would hunt for a repository that is simply not displayed.
    #[test]
    fn a_repository_row_without_an_id_is_a_protocol_error() {
        let row = serde_json::json!({ "name": "nameless" });
        assert!(matches!(
            parse_repository(&row),
            Err(TosseError::Protocol(_))
        ));
    }

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

    /// The human description must win over the machine code REGARDLESS of the order the
    /// server emits them in. An earlier version wrote both into the same field, so the
    /// winner was whichever came last — `?error_description=…&error=…` showed the bare code,
    /// the opposite of what the comment promised.
    #[test]
    fn parses_a_denied_redirect_and_prefers_the_description() {
        for head in [
            "GET /callback?error=access_denied&error_description=User%20said%20no HTTP/1.1\r\n\r\n",
            "GET /callback?error_description=User%20said%20no&error=access_denied HTTP/1.1\r\n\r\n",
        ] {
            let cb = parse_callback_request(head).expect("parses");
            assert_eq!(cb.error.as_deref(), Some("User said no"), "order must not matter");
            assert!(cb.code.is_none());
        }
        // With only the machine code, that code IS the message — nothing is dropped.
        let only_code = parse_callback_request("GET /callback?error=access_denied HTTP/1.1\r\n\r\n")
            .expect("parses");
        assert_eq!(only_code.error.as_deref(), Some("access_denied"));
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

    /// The reuse rule `ensure_client` applies, exercised through the REAL predicate — an
    /// earlier version of this test re-implemented the comparison inline, so it asserted
    /// against itself and could never have caught a change in the rule.
    #[test]
    fn a_client_is_reused_only_while_its_ports_still_match() {
        let with = |client_id: Option<&str>, ports: Option<Vec<u16>>| StoredAuth {
            client_id: client_id.map(str::to_string),
            redirect_ports: ports,
            ..Default::default()
        };

        assert_eq!(
            reusable_client(&with(Some("cid"), Some(CALLBACK_PORTS.to_vec()))),
            Some("cid")
        );
        // Written before the field existed → unknown → re-register once.
        assert_eq!(reusable_client(&with(Some("cid"), None)), None);
        // A shortened / reordered list is NOT interchangeable: registration stores the exact
        // strings, so only an identical list is safe to reuse.
        assert_eq!(
            reusable_client(&with(Some("cid"), Some(CALLBACK_PORTS[..2].to_vec()))),
            None
        );
        let mut reversed = CALLBACK_PORTS.to_vec();
        reversed.reverse();
        assert_eq!(reusable_client(&with(Some("cid"), Some(reversed))), None);
        // No client (or a blank one) is never reusable, whatever the ports say.
        assert_eq!(reusable_client(&with(None, Some(CALLBACK_PORTS.to_vec()))), None);
        assert_eq!(reusable_client(&with(Some(""), Some(CALLBACK_PORTS.to_vec()))), None);
    }

    /// Only a genuinely rejected grant may clear the session. Everything else — a Railway
    /// redeploy answering 502, a rate limit, a captive portal — must leave the refresh token
    /// alone, or a server hiccup silently costs the user their session.
    #[test]
    fn only_a_rejected_grant_is_terminal() {
        use reqwest::StatusCode;
        let invalid_grant = r#"{"error":"invalid_grant","error_description":"expired"}"#;

        assert!(is_terminal_grant_failure(StatusCode::BAD_REQUEST, invalid_grant));
        assert!(is_terminal_grant_failure(
            StatusCode::UNAUTHORIZED,
            r#"{"error":"invalid_client"}"#
        ));

        // Transient: the session must survive all of these.
        assert!(!is_terminal_grant_failure(StatusCode::BAD_GATEWAY, "<html>502</html>"));
        assert!(!is_terminal_grant_failure(StatusCode::INTERNAL_SERVER_ERROR, invalid_grant));
        assert!(!is_terminal_grant_failure(StatusCode::TOO_MANY_REQUESTS, invalid_grant));
        assert!(!is_terminal_grant_failure(StatusCode::SERVICE_UNAVAILABLE, ""));
        // A 400 whose body we cannot read is assumed transient — losing a session on a
        // guess is worse than one extra failed call.
        assert!(!is_terminal_grant_failure(StatusCode::BAD_REQUEST, "not json"));
        assert!(!is_terminal_grant_failure(
            StatusCode::BAD_REQUEST,
            r#"{"error":"temporarily_unavailable"}"#
        ));
    }

    /// Discovered endpoints are where we send an authorization code and a refresh token, so
    /// a downgraded or off-host URL must be refused rather than trusted.
    #[test]
    fn discovered_endpoints_must_be_https_and_on_the_deployment() {
        // The real production values must both pass. The authorization endpoint genuinely
        // lives on the FRONTEND host, which is exactly why it is not host-pinned.
        assert!(checked_endpoint(
            Some("https://backend-production-668c.up.railway.app/oauth/token".into()),
            "token_endpoint",
            true
        )
        .is_ok());
        assert!(checked_endpoint(
            Some("https://frontend-production-7e11.up.railway.app/oauth/authorize".into()),
            "authorization_endpoint",
            false
        )
        .is_ok());

        // Secret-bearing: downgraded, off-host, malformed or missing → refused.
        for bad in [
            "http://backend-production-668c.up.railway.app/oauth/token",
            "https://evil.example.com/oauth/token",
            "https://frontend-production-7e11.up.railway.app/oauth/token",
            "not a url",
        ] {
            assert!(
                checked_endpoint(Some(bad.into()), "token_endpoint", true).is_err(),
                "{bad} must not receive credentials"
            );
        }
        assert!(checked_endpoint(None, "token_endpoint", true).is_err());

        // Non-secret-bearing still refuses plain http — we will not open a downgraded
        // authorization URL — but tolerates another host.
        assert!(checked_endpoint(
            Some("http://frontend-production-7e11.up.railway.app/oauth/authorize".into()),
            "authorization_endpoint",
            false
        )
        .is_err());
    }

    /// `serve_callback` is the only path a sign-in can succeed through, and it had no test.
    /// These drive a REAL listener over loopback.
    mod callback_server {
        use super::*;

        /// Bind an ephemeral port and serve one sign-in against it.
        async fn serve_with(
            requests: Vec<String>,
            expected_state: &str,
        ) -> R<CallbackResult> {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            let state = expected_state.to_string();
            let server = tokio::spawn(async move { serve_callback(listener, &state).await });

            for req in requests {
                let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
                sock.write_all(req.as_bytes()).await.unwrap();
                let _ = sock.flush().await;
                // Give the server a moment to answer before the next connection.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            server.await.unwrap()
        }

        fn get(target: &str) -> String {
            format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        }

        #[tokio::test]
        async fn returns_the_matching_redirect() {
            let cb = serve_with(vec![get("/callback?code=abc&state=s1")], "s1")
                .await
                .expect("should accept our redirect");
            assert_eq!(cb.code.as_deref(), Some("abc"));
        }

        #[tokio::test]
        async fn ignores_a_favicon_and_keeps_waiting_for_the_real_redirect() {
            // The browser's extra connections must not consume the sign-in.
            let cb = serve_with(
                vec![get("/favicon.ico"), get("/callback?code=abc&state=s1")],
                "s1",
            )
            .await
            .expect("the favicon must not end the wait");
            assert_eq!(cb.code.as_deref(), Some("abc"));
        }

        #[tokio::test]
        async fn a_stray_callback_with_a_foreign_state_cannot_abort_the_sign_in() {
            // Any local process can reach the port; one hitting it with `?code=` must NOT
            // kill a sign-in in progress. The genuine redirect still wins.
            let cb = serve_with(
                vec![
                    get("/callback?code=attacker&state=wrong"),
                    get("/callback?error=nope&state=wrong"),
                    get("/callback?code=mine&state=s1"),
                ],
                "s1",
            )
            .await
            .expect("only our own state may complete the flow");
            assert_eq!(cb.code.as_deref(), Some("mine"));
        }

        #[tokio::test]
        async fn a_silent_socket_does_not_wedge_the_loop() {
            // A peer that connects and says nothing used to hold the accept loop for the
            // whole 5-minute login window. It must be dropped on the read timeout while the
            // real redirect still completes. (Bounded by the test's own timeout: if the
            // wedge regressed, this fails instead of hanging the suite.)
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { serve_callback(listener, "s1").await });

            let _silent = tokio::net::TcpStream::connect(addr).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
            sock.write_all(get("/callback?code=abc&state=s1").as_bytes())
                .await
                .unwrap();

            let cb = tokio::time::timeout(std::time::Duration::from_secs(5), server)
                .await
                .expect("the silent socket must not block the accept loop")
                .unwrap()
                .expect("the real redirect should be served");
            assert_eq!(cb.code.as_deref(), Some("abc"));
        }
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

    /// CONTRACT with the front (`src/ipc/tosseErrors.ts`).
    ///
    /// Errors reach the UI as bare strings — every TOSSE command is `Result<T, String>` —
    /// so "is this session dead or is the network merely down?" is decided by matching the
    /// TEXT. That coupling is invisible from either side alone: reword a message here and
    /// nothing fails to compile, nothing fails to run; the tasks view simply keeps hammering
    /// a board it can never load and never suggests signing in again.
    ///
    /// This test is the tripwire. If it fails, change
    /// `SESSION_GONE_MARKERS` in BOTH files (and `tosseErrors.test.ts` carries these exact
    /// strings, so the other half stays honest too).
    #[test]
    fn session_gone_errors_keep_the_wording_the_front_matches_on() {
        let contains = |haystack: &str, needle: &str| {
            haystack.to_lowercase().contains(&needle.to_lowercase())
        };

        // The two states that mean "there is no usable session any more".
        let no_session = TosseError::NotConnected.to_string();
        let revoked = TosseError::Denied(SESSION_REVOKED_REASON.to_string()).to_string();
        assert!(
            contains(&no_session, SESSION_GONE_MARKERS[0]),
            "`{no_session}` must carry the marker the front matches on"
        );
        assert!(
            contains(&revoked, SESSION_GONE_MARKERS[1]),
            "`{revoked}` must carry the marker the front matches on"
        );

        // ⚠️ And the other direction, which matters just as much: a TRANSIENT failure must
        // NOT look like a dead session. A false positive here signs the user out of the UI
        // (the view withdraws, the card invites a fresh sign-in) over a 502 or a lost
        // Wi-Fi — while the stored session is still perfectly valid.
        for transient in [
            TosseError::Network("dns error".into()),
            TosseError::Http { status: 502, body: "Bad Gateway".into() },
            TosseError::Http { status: 429, body: "Too many requests".into() },
            TosseError::Protocol("the briefing carried no `projects` list".into()),
            TosseError::Keychain("security exit 51".into()),
            TosseError::Local("no local port available for the sign-in callback".into()),
        ] {
            let text = transient.to_string();
            for marker in SESSION_GONE_MARKERS {
                assert!(
                    !contains(&text, marker),
                    "`{text}` must not read as a dead session (marker `{marker}`)"
                );
            }
        }
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

    /// A REAL Keychain round-trip with a full-size record.
    ///
    /// Regression test for a shipped bug: the secret was briefly handed to `security` on
    /// stdin, whose prompt truncates at 128 characters. A real record is about twice that,
    /// so it was stored cut in half — and since every rewrite truncated again, sign-in could
    /// not repair itself. The first probe used a SHORT secret and saw nothing, which is the
    /// whole lesson: this one uses a record the size the app actually writes.
    ///
    /// Ignored by default because it touches the login Keychain (it uses its own service
    /// name and deletes it afterwards, so it never touches the app's real item).
    /// Run: `cargo test --lib -- --ignored --nocapture keychain_round_trips`.
    #[test]
    #[ignore = "writes to the real macOS Keychain"]
    #[cfg(target_os = "macos")]
    fn keychain_round_trips_a_full_size_record() {
        const PROBE_SERVICE: &str = "Flight Deck TOSSE (test probe)";
        let write = |blob: &str| {
            std::process::Command::new("/usr/bin/security")
                .args([
                    "add-generic-password", "-U", "-s", PROBE_SERVICE, "-a", "oauth", "-w", blob,
                ])
                .output()
                .expect("security should run")
        };
        let read = || {
            let out = std::process::Command::new("/usr/bin/security")
                .args(["find-generic-password", "-s", PROBE_SERVICE, "-w"])
                .output()
                .expect("security should run");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        // A record with the shape and size the app really stores: two UUID-ish tokens, the
        // client id, the port list and an expiry — comfortably past the 128-char cliff.
        let record = StoredAuth {
            client_id: Some("3f2504e0-4f89-11d3-9a0c-0305e82c3301".into()),
            redirect_ports: Some(CALLBACK_PORTS.to_vec()),
            access_token: Some("b7e23ec2-9f4a-4c1d-8f2b-1a2b3c4d5e6f".into()),
            refresh_token: Some("c8f34fd3-a05b-4d2e-9a3c-2b3c4d5e6f70".into()),
            expires_at_ms: Some(1_785_600_000_000),
            signed_out_reason: None,
        };
        let blob = serde_json::to_string(&record).expect("serialize");
        assert!(blob.len() > 128, "the probe must exceed the truncation cliff ({})", blob.len());

        assert!(write(&blob).status.success(), "the write should succeed");
        let back = read();
        let _ = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", PROBE_SERVICE])
            .output();

        assert_eq!(back.len(), blob.len(), "the stored secret was truncated");
        let parsed: StoredAuth = serde_json::from_str(&back).expect("must parse back");
        assert_eq!(parsed.refresh_token, record.refresh_token);
        assert_eq!(parsed.client_id, record.client_id);
    }

    /// PROBE (read-only, USES the stored session): the one link this feature cannot verify
    /// offline — that a `tosse:app` Bearer is actually accepted on `/api/v1/repositories`,
    /// and that the payload has the shape [`parse_repository`] expects.
    ///
    /// Reads only; writes nothing, to TOSSE or to disk. Fails with `NotConnected` when this
    /// Mac holds no session — sign in from Settings → TOSSE first.
    /// Run: `cargo test --lib -- --ignored --nocapture live_tosse_repositories`.
    #[tokio::test]
    #[ignore = "hits the live TOSSE backend with the stored session"]
    async fn live_tosse_repositories() {
        let repos = list_repositories().await.expect("the list should be readable");
        eprintln!("{} repositories", repos.len());
        for r in repos.iter().take(5) {
            eprintln!(
                "  {:32} url={:?} projects={} context={}",
                r.name,
                r.url,
                r.projects.len(),
                r.context.as_ref().map_or(0, |c| c.len())
            );
        }
        assert!(!repos.is_empty(), "production holds repositories");
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

    // ── Briefing parsing ─────────────────────────────────────────────────────────────

    /// The payload as `briefing.service.ts` builds it, trimmed to the fields we read.
    fn briefing_fixture() -> Value {
        serde_json::json!({
            "projects": [{
                "id": "p1",
                "name": "Tosse Code",
                "status": "En cours",
                "startDate": "2026-03-12T00:00:00.000Z",
                "dueDate": null,
                "client": { "id": "c1", "name": "Interne", "website": null, "logoUrl": "https://x/logo.png" },
                "tasks": [
                    { "id": "t1", "title": "Lot 2", "priority": "Haute", "assignedTo": "Alexandre",
                      "dueDate": null, "notes": null, "type": "Code", "status": "En cours",
                      "subtaskCount": 4, "subtaskDone": 1 },
                    { "id": "t2", "title": "Lot 1", "priority": "Haute", "assignedTo": "Alexandre",
                      "dueDate": null, "notes": null, "type": "Code", "status": "Review",
                      "subtaskCount": 0, "subtaskDone": 0 }
                ],
                "taskCount": 58,
                "taskDone": 41
            }],
            "pausedProjects": [{
                "id": "p2", "name": "Serveur MCP", "status": "En pause",
                "client": { "id": "c2", "name": "Webdentiste", "website": null, "logoUrl": null }
            }],
            "general": { "tasks": [
                { "id": "t3", "title": "Sans projet", "priority": "Basse", "status": "À faire",
                  "subtaskCount": 0, "subtaskDone": 0 }
            ] }
        })
    }

    #[test]
    fn briefing_keeps_projects_their_client_and_their_tasks() {
        let b = parse_briefing(&briefing_fixture()).expect("fixture parses");
        assert_eq!(b.projects.len(), 1);
        let p = &b.projects[0];
        assert_eq!(p.name, "Tosse Code");
        assert_eq!(p.client.as_ref().map(|c| c.name.as_str()), Some("Interne"));
        assert_eq!((p.task_done, p.task_count), (41, 58));
        // Status is carried through verbatim: it is the CRM's value, not a local enum.
        assert_eq!(p.tasks[0].status, "En cours");
        assert_eq!(p.tasks[1].status, "Review");
        // `type` is a Rust keyword; the wire name must still be picked up.
        assert_eq!(p.tasks[0].kind.as_deref(), Some("Code"));
        assert_eq!((p.tasks[0].subtask_done, p.tasks[0].subtask_count), (1, 4));
        // A paused project is reported by name with NO tasks — the view says so rather than
        // showing it as having nothing left to do.
        assert_eq!(b.paused_projects.len(), 1);
        assert!(b.paused_projects[0].tasks.is_empty());
        assert_eq!(b.general_tasks.len(), 1);
    }

    #[test]
    fn briefing_without_a_general_block_is_not_an_error() {
        // The endpoint omits `general` entirely when no task is project-less.
        let v = serde_json::json!({ "projects": [], "pausedProjects": [] });
        let b = parse_briefing(&v).expect("an omitted section is normal");
        assert!(b.general_tasks.is_empty());
    }

    #[test]
    fn a_briefing_with_no_projects_key_at_all_fails_loudly() {
        // An EMPTY list means "nothing open" and is fine; a MISSING list means we did not
        // understand the payload. Rendering the second as the first tells the user their
        // board is clear on the strength of a shape we failed to read.
        let missing = serde_json::json!({ "pausedProjects": [] });
        let err = parse_briefing(&missing).expect_err("a missing `projects` is a protocol error");
        assert!(matches!(err, TosseError::Protocol(_)), "got {err:?}");

        let empty = serde_json::json!({ "projects": [] });
        assert!(parse_briefing(&empty).expect("an empty list is an answer").projects.is_empty());
    }

    #[test]
    fn a_task_without_an_id_fails_loudly() {
        // Dropping the row instead would render a SHORT list that looks complete.
        let v = serde_json::json!({ "projects": [{ "id": "p1", "name": "P",
            "tasks": [{ "title": "no id" }] }] });
        let err = parse_briefing(&v).expect_err("a row with no id is a protocol error");
        assert!(matches!(err, TosseError::Protocol(_)), "got {err:?}");
    }

    #[test]
    fn a_projects_field_that_is_not_a_list_fails_loudly() {
        // A changed shape must not read as "you have no work today".
        let v = serde_json::json!({ "projects": { "oops": true } });
        let err = parse_briefing(&v).expect_err("a non-array list is a protocol error");
        assert!(matches!(err, TosseError::Protocol(_)), "got {err:?}");
    }

    #[test]
    fn task_relations_record_whether_they_are_still_blocking() {
        let live = parse_task_link(&serde_json::json!({
            "id": "t9", "title": "Lot 1", "status": "Review", "resolvedAt": null
        }))
        .expect("parses");
        let past = parse_task_link(&serde_json::json!({
            "id": "t8", "title": "Ancien", "status": "Fait",
            "resolvedAt": "2026-07-30T10:00:00.000Z"
        }))
        .expect("parses");
        assert!(!live.resolved && past.resolved);
    }

    #[test]
    fn production_keeps_the_historic_keychain_item_name() {
        // ⚠️ Renaming it for production would orphan the item every existing install already
        // holds — silently signing everyone out on upgrade for no benefit.
        assert_eq!(service_name_for(Some(PRODUCTION_IDENTIFIER)), KEYCHAIN_SERVICE);
        assert_eq!(service_name_for(None), KEYCHAIN_SERVICE);
    }

    #[test]
    fn a_test_build_gets_its_own_keychain_item() {
        // Prod and a `/build-app` build run side by side by design. Sharing one item meant
        // whichever refreshed second was told `invalid_grant` (TOSSE rotates and revokes on
        // every exchange), cleared the item, and signed BOTH out.
        assert_eq!(
            service_name_for(Some("com.tosse.desktop.tosse-connection")),
            "Flight Deck TOSSE (com.tosse.desktop.tosse-connection)"
        );
        assert_ne!(
            service_name_for(Some("com.tosse.desktop.dev")),
            service_name_for(Some(PRODUCTION_IDENTIFIER))
        );
    }

    #[test]
    fn credentials_written_before_the_reason_field_existed_still_parse() {
        // Backward compatibility of the stored format: an item written by an earlier
        // version carries no `signed_out_reason`. If it stopped parsing, `read_stored`
        // would return a Keychain error and EVERY existing install would be signed out on
        // upgrade — the most expensive failure this field could have caused.
        let old = r#"{"client_id":"cid","access_token":"at","refresh_token":"rt"}"#;
        let parsed: StoredAuth = serde_json::from_str(old).expect("an older item must parse");
        assert_eq!(parsed.refresh_token.as_deref(), Some("rt"));
        assert_eq!(parsed.signed_out_reason, None);
    }

    #[test]
    fn a_recorded_sign_out_reason_survives_a_round_trip() {
        // The reason is stored precisely BECAUSE the error goes to a background caller that
        // renders nothing; it has to still be there at the next `status()`.
        let record = StoredAuth {
            signed_out_reason: Some("your TOSSE session expired or was revoked".into()),
            ..StoredAuth::default()
        };
        let blob = serde_json::to_string(&record).expect("serialize");
        let back: StoredAuth = serde_json::from_str(&blob).expect("parse");
        assert_eq!(back.signed_out_reason, record.signed_out_reason);
        // …and a record with no reason must not carry an empty key around.
        let clean = serde_json::to_string(&StoredAuth::default()).expect("serialize");
        assert!(!clean.contains("signed_out_reason"), "got {clean}");
    }

    #[test]
    fn the_web_origin_drops_the_authorize_path() {
        // The links we build are `<origin>/tasks/<id>`: keeping the endpoint's own path
        // would send the browser to `/oauth/authorize/tasks/<id>`.
        assert_eq!(
            origin_of("https://frontend-production-7e11.up.railway.app/oauth/authorize?x=1")
                .expect("an https endpoint has an origin"),
            "https://frontend-production-7e11.up.railway.app"
        );
    }

    #[test]
    fn the_web_origin_keeps_a_non_default_port() {
        // A frontend served on a port (a local or staging deployment) is still reachable —
        // dropping the port would link to a host that answers something else entirely.
        assert_eq!(
            origin_of("https://tosse.example:8443/oauth/authorize").expect("parses"),
            "https://tosse.example:8443"
        );
    }

    #[test]
    fn a_web_origin_without_a_host_fails_rather_than_linking_nowhere() {
        assert!(origin_of("data:text/html,nope").is_err());
    }
}
