//! The live channel to the CRM: TOSSE's `GET /api/v1/sse` stream, consumed here so the
//! Tasks view stops waiting out a `staleTime` to notice a task someone changed in the
//! browser.
//!
//! ## Why the stream is read in Rust and not by `EventSource`
//! Two independent reasons, either one sufficient: the browser `EventSource` API cannot set
//! an `Authorization` header (it only ever sends cookies), and the TOSSE token lives in the
//! Keychain — `tosse::mod` is the single module allowed to hold it. So the socket is opened
//! here, and the webview only ever hears "something changed".
//!
//! ## What crosses to the front, and what does not
//! A CRM event is forwarded as a bare KIND (`"task:updated"`), never its payload. The board
//! is aggregated and sorted server-side; patching the cache from an event would duplicate
//! that logic here, and the broadcast is GLOBAL (see below) so its payloads are not even
//! scoped to what this user is looking at. The front treats a kind as an invalidation
//! signal, refetches through the normal commands, and stays the single reader of the shape.
//!
//! ## The broadcast is global — filter twice, on purpose
//! Server-side there is ONE client map and no per-user routing (`apps/backend/src/lib/sse.ts`),
//! so this socket also carries `finance:*`, `qonto:*`, `cron:executed`, `settings:updated`…
//! [`is_interesting`] drops those here so a financial cron tick never wakes the webview at
//! all; the front then maps the surviving kinds to query keys. The two filters answer
//! different questions ("is this our business?" vs "which queries go stale?") and both are
//! tested.
//!
//! ## No replay
//! The server implements no `Last-Event-ID` replay: whatever it emitted while we were
//! disconnected is GONE. Every (re)connection therefore has to be treated as "we may have
//! missed anything" — hence [`TosseLiveStatus::connections`], which the front watches to
//! refetch wholesale rather than inferring it from a state transition.
//!
//! ## ⚠️ MEASURED: the stream is recycled every ~12 s of silence
//! Against production (2026-08-11), an idle stream ends CLEANLY — a finished body, not an
//! error — after **12.0 s**, reproducibly, over HTTP/1.1. It is an INACTIVITY timeout: a
//! probe that received a `task:updated` at ~12 s stayed connected until 24 s, i.e. the clock
//! restarts on every byte. The server's own `: keepalive` is documented at 15 s, so it never
//! gets the chance to fire and the connection it exists to hold open is dropped first.
//!
//! Two consequences the loop is built around:
//! - A clean end after a connection that RAN ([`ESTABLISHED_AFTER`]) is not a failure. It is
//!   recycled silently: no backoff, no state change, no indicator flicker every 12 s.
//! - The refetch owed per connection is throttled ON THE FRONT, or a recycle every 12 s
//!   would become the very polling this feature exists to remove.
//!
//! The real fix belongs to the CRM: a keepalive shorter than that timeout (~10 s) would hold
//! one connection open indefinitely and make all of this moot. Worth doing — it would also
//! close the ~200 ms gap each recycle leaves, which is the only window where a change can be
//! missed until the next refetch.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

use super::{
    access_token, ensure_crypto_provider, invalidate_access_token, now_unix_ms, readable_error,
    TosseError, BASE_URL,
};

/// Path of the stream on the TOSSE backend.
const SSE_PATH: &str = "/api/v1/sse";

/// How long a silent socket is allowed to stay silent before we treat it as dead.
///
/// The server sends a `: keepalive` comment every 15 s, so three missed ones is a stream
/// that is no longer being served — a TCP connection can otherwise sit "open" for many
/// minutes after the peer is gone, and a frozen view that claims to be live is the worst
/// outcome this feature can produce.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(50);

/// First reconnection delay; doubles per consecutive failure up to [`MAX_BACKOFF`].
const BASE_BACKOFF: std::time::Duration = std::time::Duration::from_secs(1);

/// Ceiling on the reconnection delay. `/api/v1/*` is rate-limited server-side, so a tight
/// reconnect loop would earn a 429 on top of whatever broke in the first place.
const MAX_BACKOFF: std::time::Duration = std::time::Duration::from_secs(60);

/// How long a connection must survive to count as ESTABLISHED — which decides both that the
/// backoff resets and that a clean end is a recycle rather than a failure.
///
/// Sits below the measured ~12 s recycle (so the ordinary case is recognised as working) and
/// well above an instant refusal: a server that accepts and drops us at once stays a
/// failure, and keeps its backoff, instead of being hammered forever at the base delay.
const ESTABLISHED_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

/// Pause before reopening a stream the server recycled. Short — this is the normal case, and
/// the gap is the only window where a change can be missed — but not zero: it bounds the
/// loop if a server ever ends the body immediately AND slowly enough to look established.
const RECYCLE_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

/// Consecutive failures before the UI is told the stream is DOWN rather than reconnecting.
///
/// A single blip (a laptop lid, a Railway redeploy) is normal and would be noise; by the
/// third failure in a row something is actually wrong and the view must stop implying it is
/// up to date.
const FAILURES_BEFORE_ERROR: u32 = 3;

/// Event kinds this app cares about, by prefix. Everything else on the global broadcast is
/// dropped before it reaches the webview — see the module doc.
const INTERESTING_PREFIXES: [&str; 5] = ["task:", "project:", "mission:", "repository:", "client:"];

// ── What the front is told ───────────────────────────────────────────────────────────

/// The live channel's health, as the Tasks view shows it.
///
/// `Off` is a real state, not the absence of one: with no TOSSE session there is nothing to
/// connect with, and the view must read as "nothing to show" rather than claim a broken
/// connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LiveState {
    /// Not running (never started, or stopped).
    Off,
    /// Opening, or retrying after a failure we still consider transient.
    Connecting,
    /// Connected and receiving.
    Live,
    /// Repeated failures, or a dead session: the view is NOT live and says so.
    Error,
}

/// The live channel's state as published to the UI. `detail` carries the reason whenever
/// there is one — a state that degrades without saying why is a silent error.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseLiveStatus {
    pub state: LiveState,
    pub detail: Option<String>,
    /// Consecutive failed attempts. Lets the UI distinguish "reconnecting" from "wedged"
    /// without parsing prose.
    pub attempts: u32,
    /// Connections established since the channel started.
    ///
    /// The front's cue to refetch wholesale — and the reason it is a COUNTER rather than a
    /// state transition: the server recycles an idle stream every ~12 s, and those recycles
    /// deliberately leave the state on `Live` (no flicker), so `live → live` with a bumped
    /// counter is exactly the case a transition-based signal would miss.
    pub connections: u32,
}

impl TosseLiveStatus {
    fn off() -> Self {
        Self { state: LiveState::Off, detail: None, attempts: 0, connections: 0 }
    }
}

/// Where this module's two outputs go. A trait rather than an `AppHandle` so `tosse::*`
/// keeps knowing nothing about Tauri (same reason [`super::login_start`] takes a closure),
/// and so the loop is exercisable without an app.
pub trait LiveSink: Send + Sync + 'static {
    /// A CRM change worth refetching for, as a bare kind (`"task:updated"`).
    fn crm_event(&self, kind: &str);
    /// The channel's health changed.
    fn state(&self, status: &TosseLiveStatus);
}

// ── SSE framing ──────────────────────────────────────────────────────────────────────

/// One dispatched server-sent event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
    /// The `event:` field, or `"message"` when the server omitted it (per the spec).
    pub event: String,
    /// The `data:` field(s), joined with newlines.
    pub data: String,
}

/// Incremental parser for the `text/event-stream` framing.
///
/// Byte-oriented on purpose: chunks arrive from the socket with no regard for character or
/// line boundaries, so a multi-byte character can be SPLIT across two of them. Buffering
/// bytes and decoding only COMPLETE lines makes that unrepresentable — a partial character
/// is always inside the tail we have not decoded yet.
#[derive(Debug, Default)]
pub struct SseParser {
    /// Bytes received but not yet terminated by a newline.
    buf: Vec<u8>,
    /// Fields accumulated for the event currently being built.
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk, returning every event it completed (possibly none, possibly several).
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        // Take complete lines only; whatever follows the last newline stays buffered.
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // the '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // CRLF servers
            }
            if let Some(msg) = self.line(&String::from_utf8_lossy(&line)) {
                out.push(msg);
            }
        }
        out
    }

    /// Handle one complete line, returning an event when the line dispatches one.
    fn line(&mut self, line: &str) -> Option<SseMessage> {
        // Blank line = dispatch.
        if line.is_empty() {
            let event = self.event.take();
            let data = std::mem::take(&mut self.data);
            // Per the spec a dispatch with no data buffer is a no-op — that is exactly the
            // shape of a lone `event:` line, and turning it into an empty event would have
            // the front refetch for nothing.
            if data.is_empty() {
                return None;
            }
            return Some(SseMessage {
                event: event.unwrap_or_else(|| "message".to_string()),
                data: data.join("\n"),
            });
        }
        // Comment (the `: keepalive` heartbeat). Ignored — but reaching this line at all is
        // the proof of life that resets the idle timeout in the read loop.
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            // A single leading space after the colon is part of the framing, not the value.
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            // A field with no colon has an empty value.
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            // `id` / `retry` / anything unknown: ignored. We do not resume by id (the server
            // implements no replay), and the reconnection delay is ours to decide.
            _ => {}
        }
        None
    }
}

/// Whether a CRM event kind is one this app has anything to refetch for.
///
/// Coarse by design — it answers "is this our business?", not "which queries go stale?"
/// (that is `src/ipc/tosseLiveEvents.ts`, on the front). An unknown `task:*` subtype we have
/// never seen still passes: forwarding one extra kind costs a refetch, dropping a real one
/// costs a stale board.
pub fn is_interesting(kind: &str) -> bool {
    INTERESTING_PREFIXES.iter().any(|p| kind.starts_with(p))
}

/// The reconnection delay after `attempts` consecutive failures (1-based), with jitter.
///
/// Jitter matters even for a single client: without it, a server that comes back after an
/// outage gets every reconnecting app in the fleet at the same instant.
fn backoff_for(attempts: u32, jitter_permille: u64) -> std::time::Duration {
    let shift = attempts.saturating_sub(1).min(6); // 2^6 * 1s = 64s, already past the cap
    let base = BASE_BACKOFF.saturating_mul(1u32 << shift).min(MAX_BACKOFF);
    // ±25 %, derived from the caller's cheap entropy source.
    let factor = 750 + (jitter_permille % 501); // 750..=1250 permille
    std::time::Duration::from_millis(base.as_millis() as u64 * factor / 1000)
}

// ── The single live connection ───────────────────────────────────────────────────────

/// The running task, if any. ONE connection for the whole app: this is an app-global
/// channel, not a per-view subscription, and N sockets would multiply the server's client
/// map for identical data.
static TASK: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::const_new(None);

/// Bumped on every start/stop. A task whose generation is stale has been superseded and
/// must not publish state any more — `abort()` is not instantaneous, and a dying task
/// overwriting the new one's status would leave the UI describing a connection that no
/// longer exists.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The last published status, so a caller that arrives late (a reopened view, a `start` on
/// an already-running channel) can be told where things stand instead of guessing.
static STATUS: std::sync::Mutex<Option<TosseLiveStatus>> = std::sync::Mutex::new(None);

/// The current published status (`Off` before the first start).
pub fn status() -> TosseLiveStatus {
    STATUS
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(TosseLiveStatus::off)
}

fn publish(sink: &dyn LiveSink, generation: u64, status: TosseLiveStatus) {
    if GENERATION.load(Ordering::SeqCst) != generation {
        return; // superseded task: stay silent rather than contradict the live one
    }
    if let Ok(mut g) = STATUS.lock() {
        *g = Some(status.clone());
    }
    sink.state(&status);
}

/// Open the live channel (idempotent).
///
/// Re-publishes the current status even when already running, so the caller always learns
/// where the channel stands — a `start` that answered nothing would leave a freshly mounted
/// view with no state at all.
pub async fn start<S: LiveSink>(sink: std::sync::Arc<S>) {
    let mut guard = TASK.lock().await;
    if guard.as_ref().is_some_and(|t| !t.is_finished()) {
        sink.state(&status());
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    *guard = Some(tokio::spawn(async move { run(sink, generation).await }));
}

/// Close the live channel (idempotent). Called on sign-out — the only "off" there is.
///
/// `abort()` is safe here in a way it would not be for a file writer: the task owns nothing
/// but a socket, and dropping it closes the connection — the server's zombie sweep collects
/// the entry.
pub async fn stop(sink: &dyn LiveSink) {
    let mut guard = TASK.lock().await;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(task) = guard.take() {
        task.abort();
    }
    publish(sink, generation, TosseLiveStatus::off());
}

/// What the loop carries between attempts.
#[derive(Default)]
struct RunState {
    /// Consecutive failures. Drives the backoff AND the switch to a visible `Error`.
    attempts: u32,
    /// Connections established so far — published so the front knows to refetch.
    connections: u32,
    /// Set once per failure streak: a 401 gets ONE forced token refresh, not one per retry —
    /// otherwise a server that refuses our Bearer for an unrelated reason would have us
    /// hammer the token endpoint (which rotates the refresh token on every exchange).
    forced_refresh: bool,
    /// The last failure's reason, CARRIED across the retry. Without it every new attempt
    /// republished a reason-less state, so a channel that stays down alternates between
    /// "here is why" and a bare colour — and the user reads whichever half they looked at.
    detail: Option<String>,
}

impl RunState {
    /// The status to publish while not connected, given the failures so far.
    fn pending(&self) -> TosseLiveStatus {
        TosseLiveStatus {
            state: if self.attempts >= FAILURES_BEFORE_ERROR {
                LiveState::Error
            } else {
                LiveState::Connecting
            },
            detail: self.detail.clone(),
            attempts: self.attempts,
            connections: self.connections,
        }
    }
}

/// The connection loop: connect, read until the stream ends or goes quiet, back off, repeat.
async fn run<S: LiveSink>(sink: std::sync::Arc<S>, generation: u64) {
    let mut state = RunState::default();
    // A recycled stream must NOT republish "connecting": the server ends an idle stream every
    // ~12 s, and announcing each one would strobe the indicator between green and amber
    // forever while nothing is actually wrong.
    let mut recycling = false;
    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if !recycling {
            publish(&*sink, generation, state.pending());
        }

        match connect_and_read(&*sink, generation, &mut state).await {
            // The session itself is gone (a refused grant, or no session at all). Retrying
            // cannot fix that and would only pointlessly poke a dead credential — stop, and
            // leave the reason on screen. The front reconnects on the next sign-in.
            Err(LoopExit::SessionGone(reason)) => {
                publish(
                    &*sink,
                    generation,
                    TosseLiveStatus {
                        state: LiveState::Error,
                        detail: Some(reason),
                        attempts: state.attempts,
                        connections: state.connections,
                    },
                );
                return;
            }
            // The server closed a stream that had been running: its normal recycle, not a
            // fault. Reopen at once, keeping the published state on `Live`.
            Err(LoopExit::Recycle) => {
                recycling = true;
                state.detail = None;
                tokio::time::sleep(RECYCLE_DELAY).await;
                continue;
            }
            Err(LoopExit::Transient(detail)) => {
                recycling = false;
                state.attempts = state.attempts.saturating_add(1);
                state.detail = Some(detail);
                publish(&*sink, generation, state.pending());
            }
            // The generation moved on (a stop, or a restart): this task is superseded.
            Ok(()) => return,
        }

        let delay = backoff_for(state.attempts.max(1), now_unix_ms().unsigned_abs());
        tokio::time::sleep(delay).await;
    }
}

/// Why one connection attempt ended.
enum LoopExit {
    /// Worth retrying (network, 5xx, an idle socket).
    Transient(String),
    /// The server ended a stream that had been established — its ~12 s idle recycle. Not a
    /// failure: no backoff, no state change, no visible flicker.
    Recycle,
    /// The stored session is dead — stop the loop.
    SessionGone(String),
}

/// One attempt: authenticate, open the stream, and pump it until it ends.
async fn connect_and_read(
    sink: &dyn LiveSink,
    generation: u64,
    state: &mut RunState,
) -> Result<(), LoopExit> {
    let token = match access_token().await {
        Ok(t) => t,
        // `Denied` = the server refused the grant, `NotConnected` = there is nothing to
        // present. Both are terminal for this loop. Everything else (offline, 502, 429) is
        // the transient case and keeps its retry.
        Err(e @ (TosseError::Denied(_) | TosseError::NotConnected)) => {
            return Err(LoopExit::SessionGone(e.to_string()))
        }
        Err(e) => return Err(LoopExit::Transient(e.to_string())),
    };

    ensure_crypto_provider();
    // A DEDICATED client: the shared one in `mod.rs` carries a 15 s request timeout, which
    // would guillotine a healthy stream every 15 seconds. Liveness is enforced by the idle
    // timeout on reads instead — bounded per chunk, not per request.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| LoopExit::Transient(format!("HTTP client build failed: {e}")))?;

    let url = format!("{BASE_URL}{SSE_PATH}");
    let mut resp = client
        .get(&url)
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        // Some proxies buffer or compress a stream into uselessness; ask them not to.
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|e| LoopExit::Transient(format!("TOSSE is unreachable: {e}")))?;

    let http_status = resp.status();
    if !http_status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = format!("the live channel answered HTTP {http_status}: {}", readable_error(&body));
        // 401/403 on a token we believed fresh: the access token is stale in a way its
        // recorded expiry did not show (a server-side revocation, a clock skew). Drop the
        // ACCESS token only — never the refresh token, and never the session: this is not a
        // refused grant, and clearing here would sign the user out over a transient 403.
        if matches!(
            http_status,
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) && !state.forced_refresh
        {
            state.forced_refresh = true;
            if let Err(e) = invalidate_access_token().await {
                eprintln!("[tosse] could not invalidate the stale access token: {e}");
            }
        }
        return Err(LoopExit::Transient(detail));
    }

    // Connected. `connections` is what tells the front to refetch wholesale — the server
    // offers no replay, so anything that changed while we were away is only knowable by
    // re-reading. Published on EVERY connection, recycles included, because a recycle leaves
    // the same gap a reconnection does.
    state.forced_refresh = false;
    state.attempts = 0;
    state.detail = None;
    state.connections = state.connections.saturating_add(1);
    publish(
        sink,
        generation,
        TosseLiveStatus {
            state: LiveState::Live,
            detail: None,
            attempts: 0,
            connections: state.connections,
        },
    );
    let connected_at = std::time::Instant::now();

    let mut parser = SseParser::new();
    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        match tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                for msg in parser.feed(&bytes) {
                    if is_interesting(&msg.event) {
                        sink.crm_event(&msg.event);
                    }
                }
            }
            // Clean end of stream. On production this is the ORDINARY case (~12 s of
            // silence, measured) — see the module doc — so an established connection ending
            // this way is recycled rather than counted as a failure.
            Ok(Ok(None)) => return Err(ended(connected_at, "the live channel closed")),
            Ok(Err(e)) => {
                return Err(ended(connected_at, &format!("the live channel dropped: {e}")))
            }
            Err(_) => {
                return Err(ended(
                    connected_at,
                    &format!(
                        "no keepalive from TOSSE for {}s — reconnecting",
                        IDLE_TIMEOUT.as_secs()
                    ),
                ))
            }
        }
    }
}

/// Classify the end of a connection by how long it lasted.
///
/// One that RAN is the server's recycle: reopen at once, silently. One that died young is a
/// failure and keeps its place in the backoff — which is what stops an accept-then-drop
/// server (or a proxy refusing us in a loop) from being hammered.
fn ended(connected_at: std::time::Instant, detail: &str) -> LoopExit {
    if connected_at.elapsed() >= ESTABLISHED_AFTER {
        LoopExit::Recycle
    } else {
        LoopExit::Transient(detail.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(chunks: &[&str]) -> Vec<SseMessage> {
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(p.feed(c.as_bytes()));
        }
        out
    }

    #[test]
    fn parses_a_plain_event() {
        let out = parse_all(&["event: task:updated\ndata: {\"id\":\"1\"}\n\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "task:updated");
        assert_eq!(out[0].data, "{\"id\":\"1\"}");
    }

    /// The whole reason the parser is incremental: chunk boundaries are the socket's
    /// business, not the protocol's.
    #[test]
    fn an_event_split_across_chunks_is_still_delivered() {
        let out = parse_all(&["event: task:cre", "ated\ndata: {\"id\"", ":\"1\"}\n", "\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "task:created");
        assert_eq!(out[0].data, "{\"id\":\"1\"}");
    }

    /// A multi-byte character split across chunks must not be mangled — the reason the
    /// buffer holds BYTES and decodes only complete lines.
    #[test]
    fn a_utf8_character_split_across_chunks_survives() {
        let payload = "data: {\"title\":\"créé\"}\n\n";
        let bytes = payload.as_bytes();
        // Cut inside the two-byte 'é' of "créé".
        let cut = payload.find('é').expect("the fixture holds an accent") + 1;
        let mut p = SseParser::new();
        assert!(p.feed(&bytes[..cut]).is_empty());
        let out = p.feed(&bytes[cut..]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "{\"title\":\"créé\"}");
    }

    #[test]
    fn keepalive_comments_dispatch_nothing() {
        let out = parse_all(&[": keepalive\n\n", ": keepalive\n\n"]);
        assert!(out.is_empty(), "a comment is not an event: {out:?}");
    }

    #[test]
    fn multi_line_data_is_joined_with_newlines() {
        let out = parse_all(&["event: task:updated\ndata: one\ndata: two\n\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "one\ntwo");
    }

    #[test]
    fn an_event_without_a_name_falls_back_to_message() {
        let out = parse_all(&["data: hello\n\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "message");
    }

    /// A lone `event:` with no data is a no-op per the spec — forwarding it would have the
    /// front refetch the whole board for nothing.
    #[test]
    fn a_dispatch_without_data_is_dropped() {
        let out = parse_all(&["event: task:updated\n\n"]);
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn crlf_framing_is_accepted() {
        let out = parse_all(&["event: task:updated\r\ndata: x\r\n\r\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "task:updated");
        assert_eq!(out[0].data, "x");
    }

    #[test]
    fn several_events_in_one_chunk_all_come_out() {
        let out = parse_all(&["event: task:created\ndata: a\n\nevent: task:archived\ndata: b\n\n"]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].event, "task:created");
        assert_eq!(out[1].event, "task:archived");
    }

    /// Unknown fields (`id:`, `retry:`) are ignored, not treated as data.
    #[test]
    fn unknown_fields_are_ignored() {
        let out = parse_all(&["id: 42\nretry: 3000\nevent: task:updated\ndata: x\n\n"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "x");
    }

    /// The global broadcast carries other people's domains; they must not even reach the
    /// webview.
    #[test]
    fn only_our_domains_are_forwarded() {
        for kind in [
            "task:created",
            "task:updated",
            "task:relations_resolved",
            "project:archived",
            "mission:updated",
            "repository:created",
            "client:updated",
        ] {
            assert!(is_interesting(kind), "{kind} should be forwarded");
        }
        for kind in [
            "finance:created",
            "qonto:synced",
            "cron:executed",
            "settings:updated",
            "appointment:created",
            "connected",
            "message",
        ] {
            assert!(!is_interesting(kind), "{kind} should be dropped");
        }
    }

    /// The production case: an idle stream is ended by the proxy every ~12 s. Treating that
    /// as a failure would climb the backoff to a minute and paint the view red while
    /// everything works.
    #[test]
    fn a_stream_that_ran_is_recycled_not_failed() {
        let ran = std::time::Instant::now() - (ESTABLISHED_AFTER + std::time::Duration::from_secs(1));
        assert!(matches!(ended(ran, "closed"), LoopExit::Recycle));
    }

    /// The opposite guard: a server that accepts and drops us at once must NOT be reopened
    /// every 250 ms forever.
    #[test]
    fn a_stream_that_dies_young_is_a_failure() {
        let young = std::time::Instant::now() - std::time::Duration::from_millis(200);
        assert!(matches!(ended(young, "closed"), LoopExit::Transient(_)));
    }

    /// A blip stays quiet; a streak becomes visible. The reason is carried either way, so a
    /// degraded channel never shows a colour with nothing to explain it.
    #[test]
    fn only_a_streak_of_failures_is_shown_as_an_error() {
        let mut s = RunState { detail: Some("boom".into()), ..RunState::default() };
        s.attempts = FAILURES_BEFORE_ERROR - 1;
        assert_eq!(s.pending().state, LiveState::Connecting);
        s.attempts = FAILURES_BEFORE_ERROR;
        assert_eq!(s.pending().state, LiveState::Error);
        assert_eq!(s.pending().detail.as_deref(), Some("boom"));
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        // Jitter fixed at its midpoint (1000 permille) so the growth itself is asserted.
        let at = |n| backoff_for(n, 250).as_millis();
        assert_eq!(at(1), BASE_BACKOFF.as_millis());
        assert_eq!(at(2), BASE_BACKOFF.as_millis() * 2);
        assert_eq!(at(3), BASE_BACKOFF.as_millis() * 4);
        assert_eq!(at(10), MAX_BACKOFF.as_millis(), "capped");
    }

    /// The one thing unit tests cannot establish: that the server actually serves this
    /// stream to OUR credential, in the framing the parser expects.
    ///
    /// Connects with the stored session, reads until the opening `connected` event (or a
    /// keepalive), then leaves. Prints what it saw, so a wire change shows up as prose
    /// rather than as a feature that quietly never fires.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_sse_stream`.
    #[tokio::test]
    #[ignore = "opens a real connection to TOSSE (network + a stored session)"]
    async fn live_probe_sse_stream() {
        let token = access_token()
            .await
            .expect("no usable TOSSE session — sign in from the app first");
        ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("client");
        let mut resp = client
            .get(format!("{BASE_URL}{SSE_PATH}"))
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .expect("the stream endpoint should be reachable");
        println!("status: {}", resp.status());
        println!(
            "content-type: {:?}",
            resp.headers().get(reqwest::header::CONTENT_TYPE)
        );
        assert!(
            resp.status().is_success(),
            "the server refused the stream: {}",
            resp.status()
        );

        let mut parser = SseParser::new();
        let mut saw_bytes = false;
        // Bounded: the server sends `connected` at once, then a keepalive every 15 s.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_secs(20), resp.chunk()).await {
                Ok(Ok(Some(bytes))) => {
                    saw_bytes = true;
                    println!("raw: {:?}", String::from_utf8_lossy(&bytes));
                    for msg in parser.feed(&bytes) {
                        println!("event: {} | data: {}", msg.event, msg.data);
                    }
                    break;
                }
                Ok(Ok(None)) => panic!("the server closed the stream immediately"),
                Ok(Err(e)) => panic!("read failed: {e}"),
                Err(_) => panic!("nothing arrived within 20 s (expected `connected` at once)"),
            }
        }
        assert!(saw_bytes, "the stream produced no bytes at all");
    }

    /// The other half of the wire: that a change made ELSEWHERE (the CRM web app, an agent
    /// through the MCP) really does arrive here, under a kind [`is_interesting`] accepts.
    ///
    /// Passive — it writes nothing. Open it, then edit any task from the CRM within the
    /// window and watch the kind print. Everything received is printed, dropped kinds
    /// included, so the global broadcast's real traffic is visible rather than assumed.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_sse_task_event`.
    #[tokio::test]
    #[ignore = "opens a real connection and waits for someone to change a task"]
    async fn live_probe_sse_task_event() {
        let token = access_token().await.expect("no usable TOSSE session");
        ensure_crypto_provider();
        let client = reqwest::Client::builder().build().expect("client");
        let mut resp = client
            .get(format!("{BASE_URL}{SSE_PATH}"))
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .expect("reachable");
        assert!(resp.status().is_success());
        println!("listening for a CRM change (60 s)…");

        let mut parser = SseParser::new();
        let mut forwarded = Vec::new();
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_secs(60);
        while std::time::Instant::now() < deadline {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match tokio::time::timeout(left, resp.chunk()).await {
                Ok(Ok(Some(bytes))) => {
                    for msg in parser.feed(&bytes) {
                        let kept = is_interesting(&msg.event);
                        println!("{} {} | {}", if kept { "KEEP" } else { "drop" }, msg.event, msg.data);
                        if kept {
                            forwarded.push(msg.event);
                        }
                    }
                }
                Ok(Ok(None)) => {
                    println!("stream ENDED after {:?}", started.elapsed());
                    break;
                }
                Ok(Err(e)) => panic!("read failed after {:?}: {e}", started.elapsed()),
                Err(_) => {
                    println!("window elapsed after {:?}", started.elapsed());
                    break;
                }
            }
        }
        println!("forwarded kinds: {forwarded:?}");
        assert!(
            !forwarded.is_empty(),
            "no CRM change arrived — either nothing was edited during the window, or the \
             broadcast no longer carries the kinds this app filters on"
        );
    }

    /// How long the server actually keeps a stream open, per protocol. Diagnostic only.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_sse_lifetime`.
    #[tokio::test]
    #[ignore = "diagnostic: holds two real connections for up to 40 s each"]
    async fn live_probe_sse_lifetime() {
        let token = access_token().await.expect("no usable TOSSE session");
        ensure_crypto_provider();
        for http1 in [false, true] {
            let mut b = reqwest::Client::builder();
            if http1 {
                b = b.http1_only();
            }
            let client = b.build().expect("client");
            let mut resp = client
                .get(format!("{BASE_URL}{SSE_PATH}"))
                .bearer_auth(&token)
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .send()
                .await
                .expect("reachable");
            println!("--- http1_only={http1} version={:?} status={}", resp.version(), resp.status());
            let started = std::time::Instant::now();
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(40), resp.chunk()).await {
                    Ok(Ok(Some(b))) => println!(
                        "  +{:>6.2}s {:?}",
                        started.elapsed().as_secs_f32(),
                        String::from_utf8_lossy(&b)
                    ),
                    Ok(Ok(None)) => {
                        println!("  ENDED after {:.2}s", started.elapsed().as_secs_f32());
                        break;
                    }
                    Ok(Err(e)) => {
                        println!("  ERR after {:.2}s: {e}", started.elapsed().as_secs_f32());
                        break;
                    }
                    Err(_) => {
                        println!("  still open at {:.2}s (stopped watching)", started.elapsed().as_secs_f32());
                        break;
                    }
                }
            }
        }
    }

    #[test]
    fn backoff_jitter_stays_within_a_quarter() {
        let base = backoff_for(4, 250);
        for permille in [0u64, 1, 250, 499, 500, 999, 12_345] {
            let d = backoff_for(4, permille);
            assert!(
                d >= base.mul_f32(0.7) && d <= base.mul_f32(1.3),
                "{permille} → {d:?} strayed from {base:?}"
            );
        }
    }
}
