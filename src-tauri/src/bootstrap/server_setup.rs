//! Driving an ALREADY-PAIRED server (a key is installed — see `add_machine`) through
//! `flightdeckd init` and the server-side `claude` sign-in.
//!
//! Both halves go through the crate's existing KEYED ssh path — the same
//! `keyed_ssh_options` base [`crate::ipc::commands::probe_remote`] and
//! [`crate::ipc::commands::run_ssh_on_machine`] already use (batch, the machine's own
//! identity file, Flight Deck's dedicated `known_hosts`) — never `bootstrap::askpass`'s
//! first-contact, password-only relay (this machine already has a key). [`run_init`]
//! literally reuses [`crate::ipc::commands::run_ssh_on_machine`] for its two round
//! trips (a plain "run this, get stdout-or-last-stderr-line back" call is exactly what
//! it needs); [`claude_login`]'s state machine needs to keep a channel open (stream
//! stdout while later writing a pasted code to stdin), which
//! `run_ssh_on_machine`'s single `.output()` call cannot do, so it builds directly on
//! [`crate::ipc::commands::keyed_ssh_options`] instead — the same option base, just
//! without that one round-trip's "wait for the whole output" shape. Either way: ONE ssh
//! invoker in this crate, never a second one.
//!
//! ## `claude auth login` needs NO pty (deviation from the brief)
//! The brief that started this module speculated the remote CLI might need a real
//! terminal for its "paste code" prompt (`ssh -tt` / `script -qfc`) and asked for a
//! spike against a live, not-logged-in `claude` before committing to an approach. That
//! spike (a throwaway Ubuntu 20.04 Docker fixture, `claude` 2.1.276, driven exactly the
//! way this module drives a real server) found the OPPOSITE: a plain batch ssh call —
//! `Stdio::piped()` on stdin/stdout/stderr, no `-tt`, no `script` — reproduces the
//! exact same prompt/failure text as a `-tt` run, just WITHOUT the OSC-8
//! terminal-hyperlink wrapping a real tty gets (`claude` only emits that wrapping when
//! it detects a tty on its stdout). This is the SAME shape the crate's own LOCAL Claude
//! sign-in already uses (`accounts::login_start`/`login_submit_code`, driving the CLI
//! directly with no pty) — so this module mirrors that proven design instead of
//! introducing a pty dependency the CLI turns out not to need. [`strip_ansi`] is kept
//! anyway (cheap, and explicitly asked for) as defense-in-depth for whatever a REAL
//! non-headless server shell might still inject (a wrapper's own banner colors, etc.)
//! — not because the pty path is expected to be hit in practice.
//!
//! ⚠️ **The URL/prompt and the failure text are on DIFFERENT streams**: `claude auth
//! login` writes "Opening browser…"/the OAuth URL/the "Paste code here if prompted"
//! prompt to STDOUT, but its own "Login failed: …" verdict to STDERR — VERIFIED live
//! against the same fixture/version above with the two streams captured on separate
//! file descriptors. `drive_claude_login` therefore pipes and reads BOTH (never
//! `Stdio::null()`s stderr away) and feeds both into the same [`ClaudeLoginDriver`] —
//! see that function's doc for why interleaving them into one accumulated buffer is
//! safe.
//!
//! ## Fixtures
//! `fixtures/claude_auth_status_logged_out.json` and
//! `fixtures/claude_auth_login_wrong_code.raw` are captured, byte-for-byte, from that
//! same live spike (a deliberately-wrong OAuth code, so the flow fails the way any
//! stale/mistyped paste would — no real credential was ever involved). The parser tests
//! below run against these bytes, not hand-typed approximations.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

use crate::bootstrap::askpass::BootstrapError;
use crate::ipc::commands::{keyed_ssh_options, run_ssh_on_machine};
use crate::ipc::events::{ServerLoginPromptEvent, ServerLoginResultEvent};
use crate::store::{MachineRecord, Store};

// ============================================================================
// run_init
// ============================================================================

/// This node's relay identity, straight off `flightdeckd whoami` (`{mac_id, relay_url,
/// label}` — see that subcommand's own doc in `flightdeckd/src/main.rs`). Field names
/// match the daemon's JSON verbatim (snake_case both sides), so no `#[serde(rename)]`
/// is needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ServerIdentity {
    pub mac_id: String,
    pub relay_url: String,
    pub label: String,
}

/// Outcome of [`run_init`]. Both variants carry `identity` — `flightdeckd init` and
/// `flightdeckd whoami` are two separate round trips (see that function's doc), so
/// either one can independently succeed or come back empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum InitOutcome {
    /// `flightdeckd init` ran for the first time on this machine.
    Initialized { identity: Option<ServerIdentity> },
    /// `~/.flightdeckd/config.json` already existed — `flightdeckd init` refused (as
    /// designed: this module NEVER passes `--force`, which would overwrite a working
    /// identity/relay pairing). Treated as SUCCESS, not an error: the node is already
    /// bootstrapped, which is exactly what a re-run of this flow (a retried wizard
    /// step, a re-added machine) should find.
    AlreadyInitialized { identity: Option<ServerIdentity> },
}

impl InitOutcome {
    pub fn identity(&self) -> Option<&ServerIdentity> {
        match self {
            Self::Initialized { identity } | Self::AlreadyInitialized { identity } => identity.as_ref(),
        }
    }
}

/// Classifies `flightdeckd init`'s result purely from exit-success + stderr — pure, so
/// it's unit-tested against the REAL wording (`Error: {path} already exists (use
/// --force to overwrite)`, captured live against fixture C in
/// `bootstrap-fixtures/`, flightdeckd's `anyhow::bail!` in `Cmd::Init`) without a live
/// remote. `Ok(true)` = already initialized, `Ok(false)` = freshly initialized.
fn classify_init(success: bool, stderr: &str) -> Result<bool, BootstrapError> {
    if success {
        return Ok(false);
    }
    if stderr.to_lowercase().contains("already exists") {
        return Ok(true);
    }
    Err(BootstrapError::Other(
        stderr.trim().lines().last().unwrap_or("flightdeckd init failed").to_string(),
    ))
}

/// Parses `flightdeckd whoami`'s one-line JSON. `None` on anything that isn't that
/// exact shape — including the real, VERIFIED-live case of an older daemon build that
/// doesn't have the subcommand at all yet (`error: unrecognized subcommand 'whoami'`,
/// captured against fixture C's pre-installed flightdeckd): [`run_init`] treats a
/// `None` here as "no identity available", never as a reason to fail the whole outcome
/// (see that function's doc and the brief's own "if the subcommand is missing, return
/// the outcome without identity, don't fail").
fn parse_whoami(stdout: &str) -> Option<ServerIdentity> {
    serde_json::from_str(stdout.trim()).ok()
}

/// Idempotent `flightdeckd init --label <label>` on an already-paired `machine`, over
/// the crate's keyed ssh path (see the module doc). NEVER passes `--force` — a second
/// call against an already-initialized node is expected and must be a harmless no-op,
/// not a destructive overwrite of a working relay identity.
///
/// Two independent round trips: `init` itself (classified by [`classify_init`]), then a
/// BEST-EFFORT `flightdeckd whoami` to attach the node's identity — best-effort because
/// `whoami` can fail for reasons that have NOTHING to do with whether init succeeded
/// (an older daemon build without the subcommand yet, a transient hiccup on the second
/// round trip): any `whoami` failure degrades to `identity: None` rather than failing
/// the whole call, so a working `flightdeckd init` is never reported as an error just
/// because a follow-up nicety came back empty.
pub async fn run_init(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    label: &str,
) -> Result<InitOutcome, BootstrapError> {
    // Resolved via the crate's ONE shared resolver (`ipc::commands::
    // resolve_daemon_bin_expr`, B11) rather than a bare `flightdeckd` — a
    // non-interactive ssh shell never has `~/.local/bin` on `PATH`, so a user-level
    // install (see `bootstrap::install`'s own identical trap) made every call in this
    // function fail with "command not found" until this resolved it the same way.
    let daemon_bin = crate::ipc::commands::resolve_daemon_bin_expr("flightdeckd");
    let init_cmd = format!("{daemon_bin} init --label {}", crate::ipc::commands::shq(label));
    let already_initialized = match run_ssh_on_machine(machine, known_hosts, &init_cmd).await {
        Ok(_stdout) => false,
        Err(stderr) => classify_init(false, &stderr)?,
    };

    let identity = run_ssh_on_machine(machine, known_hosts, &format!("{daemon_bin} whoami"))
        .await
        .ok()
        .and_then(|stdout| parse_whoami(&stdout));

    Ok(if already_initialized {
        InitOutcome::AlreadyInitialized { identity }
    } else {
        InitOutcome::Initialized { identity }
    })
}

// ============================================================================
// claude_login — pure text recognition
// ============================================================================

/// Strips ANSI CSI (`ESC[...final`) and OSC (`ESC]...BEL` or `ESC]...ESC\`) escape
/// sequences from `s`. This is what would let URL/prompt detection survive a REAL
/// terminal's colored, hyperlinked output (`claude`'s sign-in prompt wraps its URL in
/// an OSC-8 terminal hyperlink when it detects a tty — see the module doc for why this
/// module's own ssh calls never trigger that path in practice, and why the stripping is
/// kept anyway). Any escape sequence this doesn't recognize has its lone ESC byte
/// dropped rather than left dangling in the output.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next(); // consume '['
                // CSI: consume up to and including the final byte ('@'..='~').
                for c2 in chars.by_ref() {
                    if ('@'..='~').contains(&c2) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next(); // consume ']'
                // OSC: consume up to a BEL terminator, or an ST (ESC \).
                loop {
                    match chars.next() {
                        None => break,
                        Some('\u{07}') => break,
                        Some('\u{1b}') => {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                        Some(_) => {}
                    }
                }
            }
            _ => {
                // A bare/unknown escape — drop just the ESC itself.
            }
        }
    }
    out
}

/// The exact prompt text `claude auth login` waits on — the anchor both
/// [`is_prompt_seen`] and the captured fixture agree on.
const LOGIN_PROMPT_MARKER: &str = "Paste code here if prompted";

/// Whether the "paste code" prompt has shown up anywhere in `stripped` (ANSI already
/// removed). Once true, the remote CLI is blocked on stdin and ready for the code.
fn is_prompt_seen(stripped: &str) -> bool {
    stripped.contains(LOGIN_PROMPT_MARKER)
}

/// Tolerant OAuth URL extraction: the FIRST `https://…` token that also mentions
/// "oauth", after stripping ANSI — tolerant because a terminal hyperlink wraps the
/// SAME url twice (target + visible text; see [`strip_ansi`]'s doc), and a future CLI
/// version could reflow/relabel the surrounding sentence without changing the URL
/// itself. Splits on ANY whitespace/control byte, so a trailing `\r`/`\n` or an
/// adjacent OSC terminator never leaks into the returned string.
///
/// Only searches text up to the LAST whitespace/control byte in `text` — i.e. it
/// never returns a token that is still the very tail of the buffer with nothing after
/// it yet. `feed` re-scans the whole accumulated buffer on every read (see its doc),
/// so a long URL can legitimately still be mid-flight, one chunk in; without this
/// boundary, a partial prefix of the real URL (itself starting with `https://` and
/// already containing "oauth" well before the query string finishes) would be reported
/// as "found" — and a truncated link emitted to the user — before the rest even
/// arrives.
fn extract_login_url(text: &str) -> Option<String> {
    let stripped = strip_ansi(text);
    let boundary = stripped.rfind(|c: char| c.is_whitespace() || c.is_control())?;
    stripped[..=boundary]
        .split(|c: char| c.is_whitespace() || c.is_control())
        .find(|tok| tok.starts_with("https://") && tok.to_ascii_lowercase().contains("oauth"))
        .map(str::to_string)
}

/// Extracts the CLI's own failure message, if the accumulated (ANSI-stripped) output
/// contains one FULLY TERMINATED one. VERIFIED against the live fixture: the failure
/// text lands on the SAME visual line as the prompt, with no separating newline
/// (`"...prompted > Login failed: ..."`), so this scans forward from "Login failed" to
/// the next line break rather than requiring a line match — but it requires that
/// terminator to already be there (`find`, not `unwrap_or(rest.len())`): without it, a
/// chunk boundary landing mid-message (e.g. `"...Login failed: Req"`, the READ just
/// hasn't delivered the rest yet) would be reported as the complete reason, truncated.
/// `feed` re-scans the whole buffer on every read, so this just returns `None` until a
/// later call sees the real terminator.
fn extract_login_failure(stripped: &str) -> Option<String> {
    let idx = stripped.find("Login failed")?;
    let rest = &stripped[idx..];
    let line_end = rest.find(['\r', '\n'])?;
    Some(rest[..line_end].trim().to_string())
}

/// `claude auth status --json`'s shape, whitelisted to what this module needs (mirrors
/// `accounts::ClaudeAccountStatus`'s own whitelist, scoped down — this module only
/// needs to know whether the flow finished and, if so, which email).
#[derive(Debug, Clone, Deserialize)]
struct RawAuthStatus {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    email: Option<String>,
}

/// One remote account's sign-in status, as read back after a login attempt (or as a
/// pre-check before starting one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
}

/// Parses `claude auth status --json`'s stdout. `None` on anything that isn't that
/// exact shape (a crashed/updating CLI, a truncated read, …) — callers treat that the
/// same as "could not confirm", never as "definitely logged out".
fn parse_auth_status(stdout: &str) -> Option<AuthStatus> {
    let raw: RawAuthStatus = serde_json::from_str(stdout.trim()).ok()?;
    Some(AuthStatus { logged_in: raw.logged_in, email: raw.email })
}

/// Runs `claude auth status --json` on `machine` and parses its stdout REGARDLESS of
/// the ssh command's exit status — deliberately NOT `run_ssh_on_machine`, which treats
/// any non-zero exit as failure and discards stdout entirely. VERIFIED live: the real
/// CLI exits non-zero when the answer is "not logged in" (the JSON on stdout is
/// correct either way), so routing this through `run_ssh_on_machine` silently turned
/// every "not logged in" answer into "could not confirm" — the exact trap the crate's
/// own LOCAL analog, `accounts::status()`, already avoids for this same command by
/// never gating on `output.status.success()`. This mirrors that: read stdout, parse
/// it, done. `None` on an ssh-level failure (couldn't connect, etc.) or an unparseable
/// answer — both already mean "could not confirm" to every caller here.
pub(crate) async fn probe_auth_status(machine: &MachineRecord, known_hosts: Option<&str>) -> Option<AuthStatus> {
    let mut cmd = keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts);
    cmd.arg("-T")
        .arg(format!("{}@{}", machine.user, machine.host))
        .arg("claude auth status --json");
    let output = cmd.output().await.ok()?;
    parse_auth_status(&String::from_utf8_lossy(&output.stdout))
}

// ============================================================================
// claude_login — state machine
// ============================================================================

/// The specific, actionable error [`ClaudeLoginDriver::timed_out`] fails with when
/// nothing recognizable showed up in the remote CLI's output within the recognition
/// deadline — a SPECIFIC reason (never a silent hang, never a generic "timed out") so a
/// future `claude` release that changes its sign-in wording surfaces as an explicit,
/// fixable message instead of a wizard step that just never advances.
pub const LOGIN_PROMPT_NOT_RECOGNIZED_MSG: &str =
    "the claude CLI changed its sign-in output; update Flight Deck";

/// The `claude auth login` state machine's states, exactly as specced: `Start` →
/// (already logged in, checked BEFORE the driver is even created — see
/// [`run_login_actor`]) → `UrlReady` → `AwaitingCode` → `Submitting` → `Done` |
/// `Failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginState {
    Start,
    UrlReady { url: String },
    AwaitingCode,
    Submitting,
    Done { email: Option<String> },
    Failed { reason: String },
}

impl LoginState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done { .. } | Self::Failed { .. })
    }
}

/// Pure driver for the `claude auth login` state machine: it never touches a process or
/// the network itself — [`run_login_actor`] is the (untestable) I/O shell around it.
/// This split is what makes the whole flow testable against a FAKE, arbitrarily-chunked
/// stream (the brief's "fake PTY stream") instead of a live ssh round-trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeLoginDriver {
    pub state: LoginState,
    /// Everything read from the remote stdout so far, RAW (not yet ANSI-stripped —
    /// stripped fresh on every [`Self::feed`] call): the URL or the prompt marker can
    /// straddle two separate reads, so re-scanning the whole buffer each time is the
    /// only way a split marker is never missed.
    accumulated: String,
}

impl ClaudeLoginDriver {
    pub fn new() -> Self {
        Self { state: LoginState::Start, accumulated: String::new() }
    }

    /// Feed a newly-read chunk of the remote `claude auth login`'s stdout. Advances
    /// `state` in place per the diagram: `Start` recognizes the URL, `UrlReady`
    /// recognizes the prompt, `Submitting` recognizes a failure line. `AwaitingCode` /
    /// `Done` / `Failed` ignore further output (a `Done`/`Failed` fixture doesn't un-
    /// terminate; `AwaitingCode` only advances via [`Self::submit_code`]).
    pub fn feed(&mut self, chunk: &str) {
        self.accumulated.push_str(chunk);
        let stripped = strip_ansi(&self.accumulated);
        self.state = match &self.state {
            LoginState::Start => match extract_login_url(&stripped) {
                Some(url) => LoginState::UrlReady { url },
                None => LoginState::Start,
            },
            LoginState::UrlReady { url } => {
                if is_prompt_seen(&stripped) {
                    LoginState::AwaitingCode
                } else {
                    LoginState::UrlReady { url: url.clone() }
                }
            }
            LoginState::Submitting => match extract_login_failure(&stripped) {
                Some(reason) => LoginState::Failed { reason },
                None => LoginState::Submitting,
            },
            other => other.clone(),
        };
    }

    /// The human submitted a pasted code: only a valid transition from `AwaitingCode`.
    /// Returns whether it actually fired — the caller (the actual write to the remote
    /// stdin) only happens when this returns `true`, so a stray/duplicate submission
    /// before the prompt is even recognized is a harmless no-op instead of writing a
    /// code into a CLI that isn't listening yet.
    pub fn submit_code(&mut self) -> bool {
        if matches!(self.state, LoginState::AwaitingCode) {
            self.state = LoginState::Submitting;
            true
        } else {
            false
        }
    }

    /// The overall recognition deadline elapsed before a prompt showed up. A no-op once
    /// a code has actually been submitted (`Submitting`/terminal) — the timeout only
    /// guards the "waiting to even recognize the CLI's output" phase; the human is then
    /// free to take as long as they like pasting a code (see [`run_login_actor`]'s
    /// doc), and a SEPARATE submit deadline covers the post-submission wait.
    pub fn timed_out(&mut self) {
        if matches!(self.state, LoginState::Start | LoginState::UrlReady { .. }) {
            self.state = LoginState::Failed { reason: LOGIN_PROMPT_NOT_RECOGNIZED_MSG.to_string() };
        }
    }

    /// The remote process exited (or the post-submission deadline elapsed) while still
    /// `Submitting` with no failure line recognized in the stream — resolve the final
    /// verdict from the confirmatory `claude auth status` [`run_login_actor`] runs
    /// afterward. A no-op from any other state (a failure already recognized via
    /// [`Self::feed`] — or, defensively, an out-of-order call — is left untouched: the
    /// state that got there first wins).
    pub fn resolve(&mut self, process_succeeded: bool, confirm_status: Option<AuthStatus>) {
        if !matches!(self.state, LoginState::Submitting) {
            return;
        }
        self.state = resolve_login_outcome(process_succeeded, confirm_status);
    }
}

impl Default for ClaudeLoginDriver {
    fn default() -> Self {
        Self::new()
    }
}

/// The pure half of [`ClaudeLoginDriver::resolve`] — split out so it's directly
/// unit-tested against every `(succeeded, confirm_status)` combination without
/// constructing a whole driver first. Authoritative signal per the brief: "success =
/// `claude auth status` flips to `loggedIn:true`" — never the login process's own exit
/// code alone (a `claude` update could change what it exits with; the status
/// round-trip is the one contract this module treats as load-bearing).
fn resolve_login_outcome(process_succeeded: bool, confirm_status: Option<AuthStatus>) -> LoginState {
    match confirm_status {
        Some(AuthStatus { logged_in: true, email }) => LoginState::Done { email },
        Some(AuthStatus { logged_in: false, .. }) => LoginState::Failed {
            reason: "the sign-in did not complete — the server is still signed out".to_string(),
        },
        None if !process_succeeded => LoginState::Failed {
            reason: "`claude auth login` exited without confirming the sign-in".to_string(),
        },
        None => LoginState::Failed {
            reason: "could not confirm the sign-in afterwards (the status check failed)".to_string(),
        },
    }
}

// ============================================================================
// claude_login — the I/O actor + session registry
// ============================================================================

/// How long the driver waits, from spawn, to recognize the remote CLI's output (the
/// URL, then the prompt) before failing with [`LOGIN_PROMPT_NOT_RECOGNIZED_MSG`]. Not a
/// bound on how long the HUMAN takes to paste a code — see
/// [`ClaudeLoginDriver::timed_out`]'s doc — only on how long the CLI itself takes to
/// print its first few lines, which the captured fixture shows happens in low single
/// digits of seconds.
const RECOGNITION_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the driver waits for `claude auth login` to exit AFTER a code was
/// submitted (the OAuth code exchange itself) before giving up and killing it.
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(60);

/// The deadline used in place of `RECOGNITION_TIMEOUT`/`SUBMIT_TIMEOUT` while the
/// driver is at `AwaitingCode` — i.e. no real deadline at all. [`ClaudeLoginDriver::
/// timed_out`]'s own doc promises the human is "free to take as long as they like
/// pasting a code" once the prompt is recognized; `submit_deadline` is `None` for the
/// WHOLE `AwaitingCode` phase (it only starts once a code is actually submitted), so
/// falling back to `recognize_deadline` there — as this module used to — silently
/// re-armed the 30s recognition timeout for the human's entire wait, contradicting
/// that promise. Ten years is simply "never, in practice" without needing an `Option`-
/// shaped select branch.
const AWAITING_CODE_NO_DEADLINE: Duration = Duration::from_secs(60 * 60 * 24 * 365 * 10);

/// The deadline `drive_claude_login`'s read loop races on this iteration, given the
/// driver's current state — pure so the fix for the bug `AWAITING_CODE_NO_DEADLINE`'s
/// doc describes (AwaitingCode silently inheriting the stale 30s recognition deadline)
/// is directly unit-tested without spawning a process. `AwaitingCode` alone gets the
/// effectively-unbounded deadline; every other state races the real one —
/// `recognize_deadline` before a code is submitted, `submit_deadline` (armed the
/// instant it is) after.
fn next_deadline(
    state: &LoginState,
    recognize_deadline: tokio::time::Instant,
    submit_deadline: Option<tokio::time::Instant>,
) -> tokio::time::Instant {
    if matches!(state, LoginState::AwaitingCode) {
        tokio::time::Instant::now() + AWAITING_CODE_NO_DEADLINE
    } else {
        submit_deadline.unwrap_or(recognize_deadline)
    }
}

/// A command sent from the Tauri layer into a running [`run_login_actor`] task.
enum DriverCommand {
    SubmitCode(String),
    Cancel,
    /// An explicit "Restart sign-in" ([`restart_claude_login`]) superseded this
    /// session — distinct from `Cancel` so [`run_login_actor`] can tell the two apart:
    /// a same-caller `Cancel` stays silent (see its own doc), but a supersession must
    /// tell the REPLACED surface (`ServerLoginResultEvent{ok:false, error:"superseded
    /// …"}`), since that surface did not itself initiate the cancellation and would
    /// otherwise be left waiting forever with no signal anything happened (B-finding
    /// #4: this is exactly what "starting a second sign-in silently kills the first"
    /// used to do for EVERY new start, not just an explicit restart).
    Supersede,
}

/// A handle to an in-flight `claude auth login` drive, held in [`LoginSessions`].
struct ActiveLoginSession {
    machine_id: String,
    cmd_tx: mpsc::UnboundedSender<DriverCommand>,
    /// The last sign-in URL [`run_login_actor`] recognized (`None` until then, or for
    /// a session that resolved instantly via "already signed in"). A plain
    /// `std::sync::Mutex`, not the crate's usual `tokio::sync::Mutex`: `drive_claude_
    /// login`'s `on_url` callback is a SYNC `FnMut` (called from inside a `tokio::
    /// select!` arm, never itself `.await`ed), so it needs a lock it can take without
    /// an async context. Read back by [`LoginSessions::attach_or_reserve`] so a
    /// late-joining second surface can be told the URL immediately instead of having
    /// missed the one-shot event that already fired before it started listening.
    last_url: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

/// Opaque handle [`start_claude_login`]/[`restart_claude_login`] return, threaded back
/// through [`submit_claude_login_code`] / [`cancel_claude_login`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LoginSession {
    pub session_id: String,
    pub machine_id: String,
    /// ⚠️ Added by a follow-up review of the B-finding #4 single-flight fix: `true`
    /// only when THIS call actually reserved (originated) the session —
    /// `start_claude_login` finding nothing live and spawning a fresh
    /// [`run_login_actor`], or `restart_claude_login` (which always supersedes and
    /// registers itself as the replacement). `false` when this call merely ATTACHED to
    /// a session another surface already started ([`AttachOutcome::Attached`]).
    ///
    /// The front MUST gate `cancel_claude_login` on this: only the owner may actually
    /// kill the underlying session on Cancel/unmount. An attached surface's
    /// Cancel/unmount is a local-only detach that leaves the session running for
    /// whoever still owns it — see `ClaudeSignInInline`'s own doc. Before this field
    /// existed, EVERY holder's Cancel/unmount killed the shared session unconditionally,
    /// reproducing the exact "second sign-in silently kills the first, zero UI
    /// feedback" bug class the single-flight fix was written to close in the first
    /// place, just via an attached surface's teardown instead of a competing Start.
    pub owned: bool,
}

/// What [`LoginSessions::attach_or_reserve`] found for a given machine.
enum AttachOutcome {
    /// A live session for this machine already existed — its handle (always
    /// `owned: false`, see [`LoginSession::owned`]'s own doc), plus whatever URL it has
    /// recognized so far (`None` if it hasn't gotten that far yet). The
    /// freshly-minted `session_id`/`cmd_tx` the caller offered were never registered —
    /// there is nothing for the caller to spawn or clean up.
    Attached { session: LoginSession, last_url: Option<String> },
    /// Nothing existed for this machine — the offered `session_id`/`cmd_tx` are now the
    /// registered entry; the caller must spawn [`run_login_actor`] for it, and its
    /// returned [`LoginSession`] must be `owned: true`.
    Reserved,
}

/// Tauri-managed registry of in-flight server logins, keyed by `session_id`. At most
/// ONE entry per `machine_id` at a time.
///
/// ⚠️ Single-flight semantics (B-finding #4 fix): an ordinary [`start_claude_login`]
/// call for a machine that already has a live session ATTACHES to it
/// ([`Self::attach_or_reserve`]) rather than killing it — two surfaces starting a
/// sign-in for the SAME freshly-bootstrapped machine at once (the wizard's inline step
/// and the status panel's own action) must never silently orphan whichever one got
/// there first. Only an explicit "Restart sign-in" ([`restart_claude_login`])
/// supersedes — via [`Self::supersede_and_insert`] — and the replaced session is told
/// (`ServerLoginResultEvent{ok:false, error:"superseded…"}`, via `DriverCommand::
/// Supersede` rather than `Cancel`), unlike a same-caller `Cancel`, which stays silent
/// (the caller who cancelled already knows).
#[derive(Default)]
pub struct LoginSessions {
    inner: Mutex<HashMap<String, ActiveLoginSession>>,
}

impl LoginSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach to an existing session for `machine_id` if one is already live,
    /// otherwise register the offered `session_id`/`cmd_tx`/`last_url` as the new one
    /// — a SINGLE atomic check-then-insert under one lock acquisition (never two
    /// separate ones, which would race two concurrent callers both seeing "nothing
    /// yet" and both inserting their own session for the same machine).
    async fn attach_or_reserve(
        &self,
        session_id: String,
        machine_id: String,
        cmd_tx: mpsc::UnboundedSender<DriverCommand>,
        last_url: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    ) -> AttachOutcome {
        let mut guard = self.inner.lock().await;
        if let Some((id, existing)) = guard.iter().find(|(_, s)| s.machine_id == machine_id) {
            return AttachOutcome::Attached {
                session: LoginSession { session_id: id.clone(), machine_id: existing.machine_id.clone(), owned: false },
                last_url: existing.last_url.lock().unwrap().clone(),
            };
        }
        guard.insert(session_id, ActiveLoginSession { machine_id, cmd_tx, last_url });
        AttachOutcome::Reserved
    }

    /// Cancel (kill) any existing session for `machine_id`, then register `session_id`
    /// as the new one — UNCONDITIONALLY, unlike [`Self::attach_or_reserve`] above.
    /// Called ONLY by the explicit "Restart sign-in" path ([`restart_claude_login`]),
    /// never by the ordinary [`start_claude_login`] attach path. Returns the
    /// just-superseded session's command sender, if any, so the caller can send it a
    /// `Supersede` AFTER releasing this lock (never inside it — the superseded actor's
    /// own teardown must not be able to deadlock on a lock this call still holds).
    async fn supersede_and_insert(
        &self,
        session_id: String,
        machine_id: String,
        cmd_tx: mpsc::UnboundedSender<DriverCommand>,
        last_url: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    ) -> Option<mpsc::UnboundedSender<DriverCommand>> {
        let mut guard = self.inner.lock().await;
        let superseded = guard
            .iter()
            .find(|(_, s)| s.machine_id == machine_id)
            .map(|(id, _)| id.clone())
            .and_then(|id| guard.remove(&id))
            .map(|s| s.cmd_tx);
        guard.insert(session_id, ActiveLoginSession { machine_id, cmd_tx, last_url });
        superseded
    }

    async fn send(&self, session_id: &str, cmd: DriverCommand) -> Result<(), String> {
        let guard = self.inner.lock().await;
        match guard.get(session_id) {
            Some(active) => active
                .cmd_tx
                .send(cmd)
                .map_err(|_| "this sign-in already finished".to_string()),
            None => Err("no sign-in in progress for this session".to_string()),
        }
    }

    /// Remove `session_id` — called by the actor task itself right before it ends, on
    /// every exit path (done, failed, cancelled), so a finished session is never left
    /// addressable.
    async fn finish(&self, session_id: &str) {
        self.inner.lock().await.remove(session_id);
    }

    /// Cancel every in-flight session — called at app quit so a server-side sign-in
    /// never survives past it, mirroring `terminal::Terminals::kill_all()`'s treatment
    /// of the integrated-terminal shells (and every other long-lived remote/child-
    /// process registry torn down on `RunEvent::Exit`). Only QUEUES the cancellations
    /// (each session's own actor task does the actual `child.start_kill()` once it
    /// processes its `Cancel`) — callers that need the sessions to actually be gone
    /// poll [`Self::is_empty`] with a bound afterwards, the same way the app-quit
    /// handler already drains `Sessions`.
    pub async fn cancel_all(&self) {
        let guard = self.inner.lock().await;
        for session in guard.values() {
            let _ = session.cmd_tx.send(DriverCommand::Cancel);
        }
    }

    /// Whether any session is still registered — used to poll for drain after
    /// [`Self::cancel_all`] at app quit.
    pub async fn is_empty(&self) -> bool {
        self.inner.lock().await.is_empty()
    }
}

/// Emit [`ServerLoginResultEvent`], logging (never swallowing) a failed emit — mirrors
/// `ipc::events::emit_logged`'s discipline for every OTHER terminal event in the crate.
fn emit_result(app: &tauri::AppHandle, session_id: &str, machine_id: &str, ok: bool, email: Option<String>, error: Option<String>) {
    use tauri_specta::Event;
    let ev = ServerLoginResultEvent { session_id: session_id.to_string(), machine_id: machine_id.to_string(), ok, email, error };
    if let Err(e) = ev.emit(app) {
        eprintln!("[bootstrap] failed to emit server_login_result event: {e}");
    }
}

/// Emit [`ServerLoginPromptEvent`], logging a failed emit the same way.
fn emit_prompt(app: &tauri::AppHandle, session_id: &str, machine_id: &str, url: &str) {
    use tauri_specta::Event;
    let ev = ServerLoginPromptEvent { session_id: session_id.to_string(), machine_id: machine_id.to_string(), url: url.to_string() };
    if let Err(e) = ev.emit(app) {
        eprintln!("[bootstrap] failed to emit server_login_prompt event: {e}");
    }
}

/// [`drive_claude_login`]'s terminal result.
#[derive(Debug)]
enum LoginOutcome {
    Done { email: Option<String> },
    Failed { reason: String },
    /// A `DriverCommand::Cancel` arrived (or the command channel was dropped) before a
    /// terminal state was reached.
    Cancelled,
    /// A `DriverCommand::Supersede` arrived — an explicit "Restart sign-in" replaced
    /// this session before it reached a terminal state.
    Superseded,
}

/// The actual I/O drive, Tauri-FREE: pre-check `claude auth status`, then (if not
/// already signed in) spawn `claude auth login`, feed its stdout into a
/// [`ClaudeLoginDriver`], write the pasted code to its stdin the instant
/// [`ClaudeLoginDriver::submit_code`] fires, and resolve the final verdict once the
/// process exits. `on_url` fires exactly once, the instant the driver recognizes the
/// sign-in URL (before this function returns) — the ONLY thing here that reports
/// intermediate progress; everything else is only knowable once this function's
/// `.await` resolves.
///
/// Kept free of `tauri::AppHandle`/[`LoginSessions`] on purpose: this is the part with
/// actual behavior worth testing against a live server (see the `#[ignore]`d
/// `live_claude_login_reaches_url_ready_against_the_docker_fixture` test below, which
/// calls this directly) — [`run_login_actor`] is a thin Tauri-aware shell around it
/// that only wires `on_url` to an emitted event and turns the returned [`LoginOutcome`]
/// into the terminal one.
async fn drive_claude_login(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    mut cmd_rx: mpsc::UnboundedReceiver<DriverCommand>,
    mut on_url: impl FnMut(&str),
) -> LoginOutcome {
    // Start → (already logged in → Done): a pre-check that costs one extra round trip
    // but means the human is never shown a URL/prompt for a server that doesn't need
    // one. Any failure here (couldn't reach it, unparseable output) is treated as "not
    // confirmed logged in" and falls through to the real attempt below, which will
    // surface the SAME underlying connectivity problem with a much more specific error
    // if it's real.
    if let Some(AuthStatus { logged_in: true, email }) = probe_auth_status(machine, known_hosts).await {
        return LoginOutcome::Done { email };
    }

    let mut cmd = keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts);
    cmd.arg("-T")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.arg(format!("{}@{}", machine.user, machine.host)).arg("claude auth login");

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return LoginOutcome::Failed { reason: format!("could not start ssh: {e}") },
    };
    let Some(mut stdin) = child.stdin.take() else {
        return LoginOutcome::Failed { reason: "login stdin unavailable".to_string() };
    };
    let Some(mut stdout_reader) = child.stdout.take() else {
        return LoginOutcome::Failed { reason: "login stdout unavailable".to_string() };
    };
    // The CLI's own failure text ("Login failed: ...") lands on STDERR, not stdout —
    // VERIFIED live, contradicting what this module's doc used to claim about a plain
    // batch ssh call reproducing the "exact same" text: that's true of stdout alone
    // only for the URL/prompt, not the failure line. Captured here (not `Stdio::
    // null()`'d away) and fed into the SAME driver as stdout: `ClaudeLoginDriver::
    // feed` only looks for URL/prompt text while `Start`/`UrlReady` (stdout-only in
    // practice at that point) and failure text while `Submitting` (stderr-only in
    // practice by then), so interleaving the two streams into one accumulated buffer
    // is safe — `extract_login_failure`'s substring search doesn't care what else
    // surrounds the message.
    let Some(mut stderr_reader) = child.stderr.take() else {
        return LoginOutcome::Failed { reason: "login stderr unavailable".to_string() };
    };

    let mut driver = ClaudeLoginDriver::new();
    let mut stdout_buf = [0u8; 4096];
    let mut stderr_buf = [0u8; 4096];
    // Each stream gets its own "done" latch instead of the loop `break`ing the instant
    // ONE of them hits EOF — otherwise, with `biased` polling stdout before stderr, a
    // stdout EOF arriving in the same tick as a still-unread "Login failed: ..." on
    // stderr could win the race and the failure text would never be read at all.
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut url_reported = false;
    let recognize_deadline = tokio::time::Instant::now() + RECOGNITION_TIMEOUT;
    let mut submit_deadline: Option<tokio::time::Instant> = None;
    let mut cancelled = false;
    let mut superseded = false;

    'read: loop {
        if stdout_done && stderr_done {
            // Both streams closed — the process is done producing output.
            break 'read;
        }
        let sleep_until = next_deadline(&driver.state, recognize_deadline, submit_deadline);
        tokio::select! {
            biased;
            cmd = cmd_rx.recv() => {
                match cmd {
                    None | Some(DriverCommand::Cancel) => {
                        cancelled = true;
                        break 'read;
                    }
                    Some(DriverCommand::Supersede) => {
                        superseded = true;
                        break 'read;
                    }
                    Some(DriverCommand::SubmitCode(code)) => {
                        if driver.submit_code() {
                            if let Err(e) = stdin.write_all(format!("{code}\n").as_bytes()).await {
                                let _ = child.start_kill();
                                return LoginOutcome::Failed { reason: format!("could not send the code: {e}") };
                            }
                            let _ = stdin.flush().await;
                            submit_deadline = Some(tokio::time::Instant::now() + SUBMIT_TIMEOUT);
                        }
                    }
                }
            }
            n = stdout_reader.read(&mut stdout_buf), if !stdout_done => {
                match n {
                    Ok(0) => stdout_done = true, // EOF — stdout is done producing output
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&stdout_buf[..n]).into_owned();
                        driver.feed(&chunk);
                        if let LoginState::UrlReady { url } = &driver.state {
                            if !url_reported {
                                url_reported = true;
                                on_url(url);
                            }
                        }
                        if matches!(driver.state, LoginState::Failed { .. }) {
                            break 'read;
                        }
                    }
                    Err(e) => {
                        driver.state = LoginState::Failed {
                            reason: format!("lost the ssh connection: {e}"),
                        };
                        break 'read;
                    }
                }
            }
            n = stderr_reader.read(&mut stderr_buf), if !stderr_done => {
                match n {
                    Ok(0) => stderr_done = true, // EOF — stderr is done producing output
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&stderr_buf[..n]).into_owned();
                        driver.feed(&chunk);
                        if matches!(driver.state, LoginState::Failed { .. }) {
                            break 'read;
                        }
                    }
                    // Best-effort: losing the stderr stream alone doesn't kill the
                    // whole drive — stdout (and the authoritative status confirm
                    // afterwards) still resolve the outcome. Just stop polling it.
                    Err(_e) => stderr_done = true,
                }
            }
            _ = tokio::time::sleep_until(sleep_until) => {
                if submit_deadline.is_some() {
                    driver.state = LoginState::Failed {
                        reason: "`claude auth login` did not confirm in time after the code was submitted".to_string(),
                    };
                } else {
                    driver.timed_out();
                }
                break 'read;
            }
        }
    }

    let _ = child.start_kill();
    let wait_result = child.wait().await;

    if cancelled {
        return LoginOutcome::Cancelled;
    }
    if superseded {
        return LoginOutcome::Superseded;
    }

    if let LoginState::Failed { reason } = &driver.state {
        return LoginOutcome::Failed { reason: reason.clone() };
    }

    // Reached EOF while still `Submitting` (or, defensively, any other non-terminal
    // state) with no failure text recognized: resolve authoritatively via a fresh
    // `claude auth status`, per the brief's contract (see `resolve_login_outcome`'s
    // doc) — never trust the login process's bare exit code alone.
    let confirm = probe_auth_status(machine, known_hosts).await;
    let process_succeeded = wait_result.map(|s| s.success()).unwrap_or(false);
    driver.resolve(process_succeeded, confirm);

    match driver.state {
        LoginState::Done { email } => LoginOutcome::Done { email },
        LoginState::Failed { reason } => LoginOutcome::Failed { reason },
        _ => LoginOutcome::Failed { reason: "the sign-in ended in an unexpected state".to_string() },
    }
}

/// The Tauri-aware shell around [`drive_claude_login`]: wires its `on_url` callback to
/// an emitted [`ServerLoginPromptEvent`] (and records it into `last_url`, so a
/// late-joining second surface can be told immediately — see [`LoginSessions::
/// attach_or_reserve`]), turns its [`LoginOutcome`] into at most one
/// [`ServerLoginResultEvent`], and removes this session from `sessions` on every exit
/// path.
///
/// A same-caller `Cancel` is SILENT by design: the caller who cancelled already knows,
/// and this is not a failure the user needs surfaced as one (mirrors `accounts::
/// login_cancel`, which likewise reports nothing back beyond the command's own
/// `Ok(())`). A `Supersede` (an explicit "Restart sign-in" elsewhere) is NOT silent —
/// the replaced surface did not initiate it and would otherwise be left waiting forever
/// with no signal anything happened (B-finding #4).
async fn run_login_actor(
    app: tauri::AppHandle,
    sessions: std::sync::Arc<LoginSessions>,
    session_id: String,
    machine: MachineRecord,
    known_hosts: Option<String>,
    cmd_rx: mpsc::UnboundedReceiver<DriverCommand>,
    last_url: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) {
    let outcome = drive_claude_login(&machine, known_hosts.as_deref(), cmd_rx, |url| {
        emit_prompt(&app, &session_id, &machine.id, url);
        *last_url.lock().unwrap() = Some(url.to_string());
    })
    .await;

    sessions.finish(&session_id).await;
    match outcome {
        LoginOutcome::Done { email } => emit_result(&app, &session_id, &machine.id, true, email, None),
        LoginOutcome::Failed { reason } => emit_result(&app, &session_id, &machine.id, false, None, Some(reason)),
        LoginOutcome::Cancelled => {}
        LoginOutcome::Superseded => emit_result(
            &app,
            &session_id,
            &machine.id,
            false,
            None,
            Some("superseded by another sign-in for this server".to_string()),
        ),
    }
}

/// Resolve a machine's dedicated `known_hosts` path, mirroring `add_machine`'s own
/// resolution — `None` (never used) only when the app data dir itself can't be
/// resolved.
fn known_hosts_path(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned())
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Start driving the server-side `claude` sign-in for `machine_id` — or, if another
/// surface already has one live for the SAME machine, ATTACH to it instead of starting
/// a competing one (B-finding #4: a second start used to silently kill the first, with
/// zero UI feedback). Returns immediately with an opaque [`LoginSession`] handle — the
/// actual URL (or an immediate "already signed in" completion) arrives asynchronously
/// as [`ServerLoginPromptEvent`] / [`ServerLoginResultEvent`], exactly like every other
/// async login flow in this crate (`account_claude_login_start` is a synchronous
/// exception only because ITS wait for the URL is bounded to a couple of seconds
/// against a LOCAL process; this one crosses the network twice before it can even
/// begin, so it does not block the caller on that).
///
/// On attach, the already-recognized URL (if any) is re-emitted as a fresh
/// [`ServerLoginPromptEvent`] — a late-joining caller's own listener is registered by
/// the time this returns (both `ClaudeSignInInline` call sites subscribe before
/// calling this), but the ORIGINAL prompt may have already fired before that listener
/// existed, so without this re-emit a second surface attaching to an in-progress
/// session could be stuck showing "waiting for the sign-in link" even though one
/// already exists. To replace, rather than attach to, an existing session, use
/// [`restart_claude_login`] instead.
#[tauri::command]
#[specta::specta]
pub async fn start_claude_login(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, std::sync::Arc<LoginSessions>>,
    machine_id: String,
) -> Result<LoginSession, String> {
    use tauri::Manager;
    let machine = app
        .state::<Store>()
        .machine_by_id(&machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())?;
    let known_hosts = known_hosts_path(&app);

    let session_id = uuid::Uuid::new_v4().to_string();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let last_url = std::sync::Arc::new(std::sync::Mutex::new(None));
    match sessions.attach_or_reserve(session_id.clone(), machine_id.clone(), cmd_tx, last_url.clone()).await {
        AttachOutcome::Attached { session, last_url } => {
            if let Some(url) = last_url {
                emit_prompt(&app, &session.session_id, &session.machine_id, &url);
            }
            Ok(session)
        }
        AttachOutcome::Reserved => {
            let sessions_arc = sessions.inner().clone();
            tokio::spawn(run_login_actor(app, sessions_arc, session_id.clone(), machine, known_hosts, cmd_rx, last_url));
            Ok(LoginSession { session_id, machine_id, owned: true })
        }
    }
}

/// Explicitly REPLACE any live sign-in session for `machine_id` with a fresh one — the
/// only thing in this module that supersedes rather than attaches (see
/// [`LoginSessions`]'s own doc). The replaced session, if any, is told via a
/// [`ServerLoginResultEvent`] (`ok:false`, a "superseded" reason) — unlike
/// [`cancel_claude_login`] on a session the SAME caller started, which stays silent on
/// purpose. Used by the "Restart sign-in" action once a sign-in is already in flight.
#[tauri::command]
#[specta::specta]
pub async fn restart_claude_login(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, std::sync::Arc<LoginSessions>>,
    machine_id: String,
) -> Result<LoginSession, String> {
    use tauri::Manager;
    let machine = app
        .state::<Store>()
        .machine_by_id(&machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())?;
    let known_hosts = known_hosts_path(&app);

    let session_id = uuid::Uuid::new_v4().to_string();
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let last_url = std::sync::Arc::new(std::sync::Mutex::new(None));
    let superseded = sessions
        .supersede_and_insert(session_id.clone(), machine_id.clone(), cmd_tx, last_url.clone())
        .await;
    // Tell the superseded session AFTER releasing the registry lock (see
    // `supersede_and_insert`'s doc) — a `send` failing here just means it had already
    // finished on its own, which is fine.
    if let Some(old_tx) = superseded {
        let _ = old_tx.send(DriverCommand::Supersede);
    }

    let sessions_arc = sessions.inner().clone();
    tokio::spawn(run_login_actor(app, sessions_arc, session_id.clone(), machine, known_hosts, cmd_rx, last_url));

    // Always `owned: true` — an explicit restart never merely attaches, it always
    // supersedes and registers itself as the fresh owner (see `LoginSession::owned`'s
    // own doc).
    Ok(LoginSession { session_id, machine_id, owned: true })
}

/// Submit the code the user pasted for an in-flight [`start_claude_login`] session.
/// The code is written to the remote CLI's stdin the instant the driver confirms it's
/// actually at the `AwaitingCode` prompt (never blindly) — see
/// [`ClaudeLoginDriver::submit_code`].
#[tauri::command]
#[specta::specta]
pub async fn submit_claude_login_code(
    sessions: tauri::State<'_, std::sync::Arc<LoginSessions>>,
    session: LoginSession,
    code: String,
) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("the sign-in code is empty".to_string());
    }
    sessions
        .send(&session.session_id, DriverCommand::SubmitCode(code.to_string()))
        .await
}

/// Cancel an in-flight [`start_claude_login`] session — kills the remote process. Safe
/// (a harmless no-op, not an error surfaced to the user) when the session already
/// finished on its own.
#[tauri::command]
#[specta::specta]
pub async fn cancel_claude_login(
    sessions: tauri::State<'_, std::sync::Arc<LoginSessions>>,
    session: LoginSession,
) -> Result<(), String> {
    let _ = sessions.send(&session.session_id, DriverCommand::Cancel).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- fixtures ----

    const STATUS_LOGGED_OUT: &str = include_str!("fixtures/claude_auth_status_logged_out.json");
    const LOGIN_WRONG_CODE: &str = include_str!("fixtures/claude_auth_login_wrong_code.raw");

    // ---- classify_init ----

    #[test]
    fn classify_init_success_means_freshly_initialized() {
        assert_eq!(classify_init(true, ""), Ok(false));
    }

    /// Byte-for-byte against the real wording captured live from fixture C
    /// (`flightdeckd init --label re-init-test` against an already-initialized
    /// node): `Error: /home/josty/.flightdeckd/config.json already exists (use
    /// --force to overwrite)`.
    #[test]
    fn classify_init_recognizes_the_real_already_exists_wording() {
        let stderr = "Error: /home/josty/.flightdeckd/config.json already exists (use --force to overwrite)\n";
        assert_eq!(classify_init(false, stderr), Ok(true));
    }

    #[test]
    fn classify_init_is_case_insensitive_on_already_exists() {
        assert_eq!(classify_init(false, "ALREADY EXISTS, use --force"), Ok(true));
    }

    #[test]
    fn classify_init_surfaces_any_other_failure() {
        let err = classify_init(false, "connection reset by peer\n").unwrap_err();
        assert_eq!(err, BootstrapError::Other("connection reset by peer".to_string()));
    }

    #[test]
    fn classify_init_falls_back_on_an_empty_stderr() {
        let err = classify_init(false, "").unwrap_err();
        assert_eq!(err, BootstrapError::Other("flightdeckd init failed".to_string()));
    }

    // ---- parse_whoami ----

    #[test]
    fn parse_whoami_reads_the_real_json_shape() {
        let stdout = r#"{"mac_id":"abc-123","relay_url":"https://relay.example/","label":"josty-cc"}"#;
        assert_eq!(
            parse_whoami(stdout),
            Some(ServerIdentity {
                mac_id: "abc-123".to_string(),
                relay_url: "https://relay.example/".to_string(),
                label: "josty-cc".to_string(),
            })
        );
    }

    /// The exact real-world case that motivates `run_init` never failing on a `whoami`
    /// miss: captured live against fixture C's pre-installed (older) flightdeckd —
    /// `error: unrecognized subcommand 'whoami'` (clap's own error text, not JSON at
    /// all).
    #[test]
    fn parse_whoami_returns_none_on_an_unrecognized_subcommand() {
        let stdout = "error: unrecognized subcommand 'whoami'\n\nUsage: flightdeckd <COMMAND>\n";
        assert_eq!(parse_whoami(stdout), None);
    }

    #[test]
    fn parse_whoami_returns_none_on_garbage() {
        assert_eq!(parse_whoami("not json"), None);
        assert_eq!(parse_whoami(""), None);
    }

    // ---- strip_ansi ----

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[?25hhello\u{1b}[0m"), "hello");
    }

    /// The real OSC-8 hyperlink wrapper `claude` emits on a real tty (captured live,
    /// see the module doc): `ESC]8;;URL BEL` VISIBLE_TEXT `ESC]8;; BEL`. Stripping must
    /// remove BOTH the opening tag (URL and all — it's the OSC PAYLOAD, not visible
    /// text) and the closing tag, leaving exactly one plain-text copy of the URL.
    #[test]
    fn strip_ansi_removes_osc8_hyperlinks_leaving_the_visible_url_once() {
        let wrapped = "visit: \u{1b}]8;;https://example.com/a\u{07}https://example.com/a\u{1b}]8;;\u{07}\r\n";
        assert_eq!(strip_ansi(wrapped), "visit: https://example.com/a\r\n");
    }

    #[test]
    fn strip_ansi_handles_st_terminated_osc_too() {
        // ST = ESC \ instead of BEL.
        let wrapped = "\u{1b}]0;window title\u{1b}\\rest";
        assert_eq!(strip_ansi(wrapped), "rest");
    }

    /// Only the ESC byte itself is dropped — the character after it (here `Z`, not one
    /// of the two recognized introducers `[`/`]`) is ordinary text and stays.
    #[test]
    fn strip_ansi_drops_a_lone_unknown_escape() {
        assert_eq!(strip_ansi("a\u{1b}Zb"), "aZb");
    }

    #[test]
    fn strip_ansi_is_a_no_op_on_plain_text() {
        assert_eq!(strip_ansi("Paste code here if prompted > "), "Paste code here if prompted > ");
    }

    // ---- extract_login_url ----

    #[test]
    fn extract_login_url_finds_the_plain_no_pty_url() {
        // The captured no-pty transcript: no ANSI at all, single \n.
        let url = extract_login_url(LOGIN_WRONG_CODE).expect("must find the URL");
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?"));
        assert!(url.contains("state="));
        // Nothing from the prompt line leaked onto the end of the URL.
        assert!(!url.contains("Paste"));
    }

    #[test]
    fn extract_login_url_survives_the_osc8_wrapped_form() {
        let wrapped = "If the browser didn't open, visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&state=xyz\u{07}https://claude.com/cai/oauth/authorize?code=true&state=xyz\u{1b}]8;;\u{07}\r\nPaste code here if prompted > ";
        let url = extract_login_url(wrapped).expect("must find the URL through OSC-8 wrapping");
        assert_eq!(url, "https://claude.com/cai/oauth/authorize?code=true&state=xyz");
    }

    #[test]
    fn extract_login_url_ignores_a_non_oauth_https_link() {
        assert_eq!(extract_login_url("see https://example.com/docs for help"), None);
    }

    #[test]
    fn extract_login_url_returns_none_on_unrecognized_output() {
        assert_eq!(extract_login_url("claude: command not found\n"), None);
    }

    /// The URL is long enough to plausibly straddle two separate PTY/pipe reads — the
    /// driver re-scans the WHOLE accumulated buffer each time (see `feed`'s doc), so
    /// this proves extraction still finds it split across two chunks concatenated.
    #[test]
    fn extract_login_url_finds_a_url_split_across_two_chunks() {
        let whole = "visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\r\n";
        let (a, b) = whole.split_at(40);
        let mut acc = String::new();
        acc.push_str(a);
        assert_eq!(extract_login_url(&acc), None, "must not find a url from a PARTIAL token");
        acc.push_str(b);
        assert_eq!(
            extract_login_url(&acc),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=abc".to_string())
        );
    }

    // ---- is_prompt_seen / extract_login_failure ----

    #[test]
    fn is_prompt_seen_finds_the_real_marker() {
        assert!(is_prompt_seen(&strip_ansi(LOGIN_WRONG_CODE)));
        assert!(!is_prompt_seen("Opening browser to sign in...\n"));
    }

    #[test]
    fn extract_login_failure_reads_the_real_captured_wrong_code_transcript() {
        let stripped = strip_ansi(LOGIN_WRONG_CODE);
        let reason = extract_login_failure(&stripped).expect("must recognize the real failure line");
        assert_eq!(reason, "Login failed: Request failed with status code 400");
    }

    #[test]
    fn extract_login_failure_none_when_absent() {
        assert_eq!(extract_login_failure("Paste code here if prompted > "), None);
    }

    /// The real transcript has NO newline between the prompt and the failure text
    /// (`"...prompted > Login failed: ..."`) — this is the specific shape
    /// `extract_login_failure` must handle (see its own doc).
    #[test]
    fn extract_login_failure_handles_no_separating_newline() {
        let text = "Paste code here if prompted > Login failed: bad code\r\nmore-noise-after";
        assert_eq!(extract_login_failure(text), Some("Login failed: bad code".to_string()));
    }

    // ---- parse_auth_status ----

    #[test]
    fn parse_auth_status_reads_the_real_logged_out_fixture() {
        let status = parse_auth_status(STATUS_LOGGED_OUT).expect("must parse the captured fixture");
        assert_eq!(status, AuthStatus { logged_in: false, email: None });
    }

    #[test]
    fn parse_auth_status_reads_a_logged_in_shape() {
        let stdout = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"dev@example.com","subscriptionType":"max"}"#;
        assert_eq!(
            parse_auth_status(stdout),
            Some(AuthStatus { logged_in: true, email: Some("dev@example.com".to_string()) })
        );
    }

    #[test]
    fn parse_auth_status_none_on_garbage() {
        assert_eq!(parse_auth_status("not json"), None);
    }

    // ---- resolve_login_outcome ----

    #[test]
    fn resolve_login_outcome_done_when_status_confirms_logged_in() {
        let status = Some(AuthStatus { logged_in: true, email: Some("a@b.com".to_string()) });
        assert_eq!(
            resolve_login_outcome(true, status),
            LoginState::Done { email: Some("a@b.com".to_string()) }
        );
    }

    #[test]
    fn resolve_login_outcome_failed_when_status_confirms_still_logged_out() {
        let status = Some(AuthStatus { logged_in: false, email: None });
        // Even a SUCCESSFUL process exit doesn't override an authoritative status
        // check that says the sign-in never actually completed.
        assert!(matches!(resolve_login_outcome(true, status), LoginState::Failed { .. }));
    }

    #[test]
    fn resolve_login_outcome_failed_when_status_check_itself_fails_and_process_failed() {
        assert!(matches!(resolve_login_outcome(false, None), LoginState::Failed { .. }));
    }

    #[test]
    fn resolve_login_outcome_failed_when_status_check_fails_even_if_process_exited_ok() {
        // Exit 0 alone is NEVER trusted — see the module's own doc.
        assert!(matches!(resolve_login_outcome(true, None), LoginState::Failed { .. }));
    }

    // ---- ClaudeLoginDriver — state machine over a fake, chunked stream ----

    /// Feeds the REAL captured transcript in small, arbitrary chunks — a "fake PTY
    /// stream" standing in for however the real reads happen to split — submitting a
    /// code the instant `AwaitingCode` is reached (exactly what `run_login_actor` does
    /// on the real i/o side), then keeps feeding the REST of the same transcript. The
    /// fixture's own fake code was rejected server-side ("Login failed: ..."), so once
    /// submitted, the remaining bytes must drive the driver all the way to `Failed`
    /// with that same message — proving the whole `UrlReady` → `AwaitingCode` →
    /// `Submitting` → `Failed` path against real bytes, not just hand-typed ones.
    #[test]
    fn driver_reaches_url_ready_then_awaiting_code_then_failed_from_the_real_fixture_chunked_arbitrarily() {
        let mut driver = ClaudeLoginDriver::new();
        assert_eq!(driver.state, LoginState::Start);
        let mut submitted = false;

        for chunk in LOGIN_WRONG_CODE.as_bytes().chunks(17) {
            driver.feed(&String::from_utf8_lossy(chunk));
            if !submitted && matches!(driver.state, LoginState::AwaitingCode) {
                assert!(driver.submit_code(), "must transition out of AwaitingCode");
                submitted = true;
            }
            if driver.state.is_terminal() {
                break;
            }
        }

        assert!(submitted, "the fixture must contain the prompt marker");
        assert_eq!(
            driver.state,
            LoginState::Failed { reason: "Login failed: Request failed with status code 400".to_string() }
        );
    }

    #[test]
    fn driver_url_ready_then_prompt_then_submit_then_resolve() {
        let mut driver = ClaudeLoginDriver::new();
        driver.feed("Opening browser to sign in\u{2026}\r\n");
        assert_eq!(driver.state, LoginState::Start);

        driver.feed("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\r\n");
        assert_eq!(driver.state, LoginState::UrlReady {
            url: "https://claude.com/cai/oauth/authorize?code=true&state=xyz".to_string()
        });

        // Submitting before the prompt is seen must be a no-op.
        assert!(!driver.submit_code());
        assert!(matches!(driver.state, LoginState::UrlReady { .. }));

        driver.feed("Paste code here if prompted > ");
        assert_eq!(driver.state, LoginState::AwaitingCode);

        assert!(driver.submit_code());
        assert_eq!(driver.state, LoginState::Submitting);
        // A second submit while already submitting is a no-op.
        assert!(!driver.submit_code());

        // No failure text arrives; the process later exits 0 and a confirmatory status
        // check comes back logged in.
        driver.resolve(true, Some(AuthStatus { logged_in: true, email: Some("me@example.com".to_string()) }));
        assert_eq!(driver.state, LoginState::Done { email: Some("me@example.com".to_string()) });
    }

    #[test]
    fn driver_recognizes_a_failure_line_while_submitting() {
        let mut driver = ClaudeLoginDriver::new();
        driver.feed("visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\r\n");
        driver.feed("Paste code here if prompted > ");
        assert!(driver.submit_code());
        driver.feed("Login failed: Request failed with status code 400\r\n");
        assert_eq!(
            driver.state,
            LoginState::Failed { reason: "Login failed: Request failed with status code 400".to_string() }
        );
    }

    #[test]
    fn driver_timed_out_from_start_produces_the_specific_message() {
        let mut driver = ClaudeLoginDriver::new();
        driver.timed_out();
        assert_eq!(driver.state, LoginState::Failed { reason: LOGIN_PROMPT_NOT_RECOGNIZED_MSG.to_string() });
    }

    #[test]
    fn driver_timed_out_from_url_ready_produces_the_specific_message() {
        let mut driver = ClaudeLoginDriver::new();
        driver.feed("visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\r\n");
        driver.timed_out();
        assert_eq!(driver.state, LoginState::Failed { reason: LOGIN_PROMPT_NOT_RECOGNIZED_MSG.to_string() });
    }

    /// A timeout firing AFTER the code was already submitted must NOT be reinterpreted
    /// as "prompt not recognized" — `run_login_actor` never calls `timed_out()` once
    /// `submit_deadline` is armed (it uses a different message), but the pure method
    /// itself is defense-in-depth: it must still refuse to overwrite a state past
    /// `AwaitingCode`.
    #[test]
    fn driver_timed_out_is_a_no_op_once_submitting() {
        let mut driver = ClaudeLoginDriver::new();
        driver.feed("visit: https://claude.com/cai/oauth/authorize?code=true&state=xyz\r\n");
        driver.feed("Paste code here if prompted > ");
        assert!(driver.submit_code());
        driver.timed_out();
        assert_eq!(driver.state, LoginState::Submitting);
    }

    #[test]
    fn driver_resolve_is_a_no_op_outside_submitting() {
        let mut driver = ClaudeLoginDriver::new();
        driver.resolve(true, Some(AuthStatus { logged_in: true, email: None }));
        assert_eq!(driver.state, LoginState::Start, "resolve() must only apply from Submitting");
    }

    #[test]
    fn driver_default_is_start() {
        assert_eq!(ClaudeLoginDriver::default().state, LoginState::Start);
    }

    // ---- next_deadline — regression coverage for the AwaitingCode timeout bug ----
    //
    // Before the fix, `AwaitingCode` fell back to `recognize_deadline` (the SAME fixed
    // 30s-from-spawn deadline `Start`/`UrlReady` race) for as long as `submit_deadline`
    // stayed `None` — which is the ENTIRE `AwaitingCode` phase, since it's only armed
    // once a code is actually submitted. So a human who hadn't pasted a code within
    // 30s of the ssh connection opening (not 30s after the prompt even appeared) had
    // the login killed out from under them, contradicting `ClaudeLoginDriver::
    // timed_out`'s own documented "free to take as long as they like" contract.

    #[test]
    fn next_deadline_is_effectively_unbounded_while_awaiting_code() {
        let recognize_deadline = tokio::time::Instant::now() + RECOGNITION_TIMEOUT;
        let sleep_until = next_deadline(&LoginState::AwaitingCode, recognize_deadline, None);
        // Proves `AwaitingCode` no longer inherits the stale `recognize_deadline` — it
        // now lands centuries past even a hugely generous bound on how long a human
        // could plausibly take to paste a code.
        assert!(
            sleep_until > recognize_deadline + Duration::from_secs(3600),
            "AwaitingCode must not race a deadline anywhere near recognize_deadline"
        );
    }

    #[test]
    fn next_deadline_still_races_recognize_deadline_before_a_code_is_submitted() {
        let recognize_deadline = tokio::time::Instant::now() + RECOGNITION_TIMEOUT;
        assert_eq!(next_deadline(&LoginState::Start, recognize_deadline, None), recognize_deadline);
        assert_eq!(
            next_deadline(
                &LoginState::UrlReady { url: "https://example.com".to_string() },
                recognize_deadline,
                None
            ),
            recognize_deadline,
            "UrlReady must still be bounded by recognize_deadline — only AwaitingCode is unbounded"
        );
    }

    #[test]
    fn next_deadline_uses_submit_deadline_once_a_code_is_submitted() {
        let recognize_deadline = tokio::time::Instant::now() + RECOGNITION_TIMEOUT;
        let submit_deadline = tokio::time::Instant::now() + SUBMIT_TIMEOUT;
        assert_eq!(
            next_deadline(&LoginState::Submitting, recognize_deadline, Some(submit_deadline)),
            submit_deadline,
            "Submitting must race the SEPARATE post-submission deadline, not recognize_deadline"
        );
    }

    // ---- LoginSessions registry ----

    /// A fresh, empty `last_url` handle — every registry call below needs one; nothing
    /// in these tests cares about its contents unless explicitly noted.
    fn no_url() -> std::sync::Arc<std::sync::Mutex<Option<String>>> {
        std::sync::Arc::new(std::sync::Mutex::new(None))
    }

    #[tokio::test]
    async fn sessions_supersede_returns_the_old_sender_for_the_same_machine() {
        let sessions = LoginSessions::new();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let old = sessions.supersede_and_insert("s1".to_string(), "m1".to_string(), tx1, no_url()).await;
        assert!(old.is_none(), "nothing to supersede on the first insert");

        let (tx2, mut rx2) = mpsc::unbounded_channel();
        let old = sessions.supersede_and_insert("s2".to_string(), "m1".to_string(), tx2, no_url()).await;
        assert!(old.is_some(), "the second session for the SAME machine must supersede the first");
        // s1 must be gone from the registry now.
        assert!(sessions.send("s1", DriverCommand::Cancel).await.is_err());
        // s2 is the live one.
        sessions.send("s2", DriverCommand::Cancel).await.expect("s2 must be reachable");
        assert!(matches!(rx2.recv().await, Some(DriverCommand::Cancel)));
    }

    #[tokio::test]
    async fn sessions_do_not_supersede_across_different_machines() {
        let sessions = LoginSessions::new();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        sessions.supersede_and_insert("s1".to_string(), "m1".to_string(), tx1, no_url()).await;
        let old = sessions.supersede_and_insert("s2".to_string(), "m2".to_string(), tx2, no_url()).await;
        assert!(old.is_none(), "a different machine must not supersede anything");
        assert!(sessions.send("s1", DriverCommand::Cancel).await.is_ok());
        assert!(sessions.send("s2", DriverCommand::Cancel).await.is_ok());
    }

    #[tokio::test]
    async fn sessions_finish_removes_the_entry() {
        let sessions = LoginSessions::new();
        let (tx, _rx) = mpsc::unbounded_channel();
        sessions.supersede_and_insert("s1".to_string(), "m1".to_string(), tx, no_url()).await;
        sessions.finish("s1").await;
        assert!(sessions.send("s1", DriverCommand::Cancel).await.is_err());
    }

    #[tokio::test]
    async fn sessions_send_to_unknown_session_errs() {
        let sessions = LoginSessions::new();
        let err = sessions.send("nope", DriverCommand::Cancel).await.unwrap_err();
        assert!(err.contains("no sign-in in progress"));
    }

    /// [`LoginSessions::cancel_all`] — the app-quit teardown this module was missing
    /// (a login session used to be the one long-lived remote/child-process registry in
    /// the crate `RunEvent::Exit` never touched) — queues a `Cancel` for EVERY
    /// registered session, regardless of which machine it belongs to.
    #[tokio::test]
    async fn cancel_all_sends_cancel_to_every_registered_session() {
        let sessions = LoginSessions::new();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        sessions.supersede_and_insert("s1".to_string(), "m1".to_string(), tx1, no_url()).await;
        sessions.supersede_and_insert("s2".to_string(), "m2".to_string(), tx2, no_url()).await;

        assert!(!sessions.is_empty().await);
        sessions.cancel_all().await;

        assert!(matches!(rx1.recv().await, Some(DriverCommand::Cancel)));
        assert!(matches!(rx2.recv().await, Some(DriverCommand::Cancel)));
    }

    #[tokio::test]
    async fn is_empty_reflects_finish() {
        let sessions = LoginSessions::new();
        assert!(sessions.is_empty().await);
        let (tx, _rx) = mpsc::unbounded_channel();
        sessions.supersede_and_insert("s1".to_string(), "m1".to_string(), tx, no_url()).await;
        assert!(!sessions.is_empty().await);
        sessions.finish("s1").await;
        assert!(sessions.is_empty().await);
    }

    // ---- LoginSessions::attach_or_reserve — single-flight semantics (B-finding #4) ----

    /// The FIRST `start_claude_login` for a machine reserves — nothing to attach to
    /// yet, so the caller must spawn the actor for the session it offered.
    #[tokio::test]
    async fn attach_or_reserve_reserves_when_nothing_exists_for_the_machine() {
        let sessions = LoginSessions::new();
        let (tx, _rx) = mpsc::unbounded_channel();
        let outcome = sessions.attach_or_reserve("s1".to_string(), "m1".to_string(), tx, no_url()).await;
        assert!(matches!(outcome, AttachOutcome::Reserved));
        // The offered session really was registered.
        sessions.send("s1", DriverCommand::Cancel).await.expect("s1 must now be reachable");
    }

    /// A SECOND `start_claude_login` for the SAME machine attaches to the live session
    /// instead of superseding it — the core of the fix: two surfaces starting a
    /// sign-in for the same freshly-bootstrapped machine must never race each other.
    #[tokio::test]
    async fn attach_or_reserve_attaches_to_an_existing_session_for_the_same_machine() {
        let sessions = LoginSessions::new();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        sessions.attach_or_reserve("s1".to_string(), "m1".to_string(), tx1, no_url()).await;

        let (tx2, _rx2) = mpsc::unbounded_channel();
        let outcome = sessions.attach_or_reserve("s2".to_string(), "m1".to_string(), tx2, no_url()).await;
        match outcome {
            AttachOutcome::Attached { session, .. } => {
                assert_eq!(session.session_id, "s1", "must hand back the EXISTING session's id, not a new one");
                assert_eq!(session.machine_id, "m1");
                assert!(
                    !session.owned,
                    "an attached caller must never be told it owns the session — only the \
                     originator may cancel it (see `LoginSession::owned`'s own doc)"
                );
            }
            AttachOutcome::Reserved => panic!("must attach, not reserve, for a machine that already has a session"),
        }
        // s1 (the original) must still be the one and only live session — untouched,
        // never cancelled: attaching must not kill it.
        sessions.send("s1", DriverCommand::Cancel).await.expect("s1 must remain live and reachable");
        assert!(matches!(rx1.recv().await, Some(DriverCommand::Cancel)));
        // s2 was never registered — nothing to find under that id.
        assert!(sessions.send("s2", DriverCommand::Cancel).await.is_err());
    }

    /// The attach path hands back whatever URL the live session has already
    /// recognized, so a late-joining second surface can render it immediately.
    #[tokio::test]
    async fn attach_or_reserve_returns_the_existing_sessions_last_url() {
        let sessions = LoginSessions::new();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        let url_slot = no_url();
        sessions.attach_or_reserve("s1".to_string(), "m1".to_string(), tx1, url_slot.clone()).await;
        *url_slot.lock().unwrap() = Some("https://claude.ai/example".to_string());

        let (tx2, _rx2) = mpsc::unbounded_channel();
        let outcome = sessions.attach_or_reserve("s2".to_string(), "m1".to_string(), tx2, no_url()).await;
        match outcome {
            AttachOutcome::Attached { last_url, .. } => {
                assert_eq!(last_url.as_deref(), Some("https://claude.ai/example"));
            }
            AttachOutcome::Reserved => panic!("must attach"),
        }
    }

    /// Per-machine isolation: attaching for machine `m2` must never find/return
    /// machine `m1`'s session.
    #[tokio::test]
    async fn attach_or_reserve_does_not_attach_across_different_machines() {
        let sessions = LoginSessions::new();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        sessions.attach_or_reserve("s1".to_string(), "m1".to_string(), tx1, no_url()).await;

        let (tx2, _rx2) = mpsc::unbounded_channel();
        let outcome = sessions.attach_or_reserve("s2".to_string(), "m2".to_string(), tx2, no_url()).await;
        assert!(matches!(outcome, AttachOutcome::Reserved), "a different machine must reserve its own session");
        sessions.send("s1", DriverCommand::Cancel).await.expect("m1's session must be untouched");
        sessions.send("s2", DriverCommand::Cancel).await.expect("m2's own session must be reachable");
    }

    /// Once a session finishes (`finish`), the NEXT `start_claude_login` for that
    /// machine reserves again rather than attaching to a dead entry.
    #[tokio::test]
    async fn attach_or_reserve_reserves_again_after_the_live_session_finished() {
        let sessions = LoginSessions::new();
        let (tx1, _rx1) = mpsc::unbounded_channel();
        sessions.attach_or_reserve("s1".to_string(), "m1".to_string(), tx1, no_url()).await;
        sessions.finish("s1").await;

        let (tx2, _rx2) = mpsc::unbounded_channel();
        let outcome = sessions.attach_or_reserve("s2".to_string(), "m1".to_string(), tx2, no_url()).await;
        assert!(matches!(outcome, AttachOutcome::Reserved));
    }

    // ========================================================================
    // Live tests against the Docker bootstrap fixtures (flightdeckd/live/bootstrap-fixtures)
    // ========================================================================
    //
    // Prerequisites (documented once here, not per-test): `colima start` (or Docker
    // Desktop running) — `flightdeckd/live/bootstrap-fixtures/fixture.sh`, in this
    // same repo, brings up throwaway, password-auth Ubuntu 20.04 containers (see
    // `flightdeckd/docs/B6-FIXTURES.md`): fixture A (`deploy`/`deploy-pw`, sudo, port
    // 2231, no `flightdeckd` — a FRESH node) and fixture C (`josty`/`josty-pw`, port
    // 2233, `flightdeckd` pre-installed AND pre-initialized — an ALREADY-BOOTSTRAPPED
    // node).
    // `--ignore`d like every other live-spawn test in this crate; run with
    // `cargo test --lib -- --ignored --nocapture live_`.
    //
    // Each test brings its fixture up itself (idempotent — `fixture.sh up` is a
    // build-and-restart), installs a THROWAWAY keypair generated for the run (never the
    // developer's real SSH key) via THIS crate's own `bootstrap::askpass` — the exact
    // password-only, first-contact relay a real "Add a server" flow would use for that
    // one-time step — then switches to the crate's normal KEYED path for everything
    // else, exactly mirroring a real pairing's progression. `fixture.sh up` recreates
    // the CONTAINER from its image every time (confirmed while building these tests:
    // anything installed by hand inside a previous run's container — `claude`, a key,
    // `flightdeckd` — is gone on the next `up`), so fixture A's tests also (re)install
    // whatever they need themselves: `flightdeckd` (fixture C already bakes it into
    // its image; A doesn't) over the now-keyed connection — no `scp` dependency, piping
    // base64 through stdin and finishing with a `sudo -S` install fed the fixture's own
    // published password — and `claude` via its own official installer, symlinked onto
    // `/usr/local/bin` (a non-interactive ssh command doesn't source `.profile`, so
    // `~/.local/bin` alone would leave it invisible to the very `command -v claude`
    // `probe_remote` uses — see `install_claude_on_fixture_a`'s own doc). The fixture's
    // password is SAFE to embed here only because it's a fixed, throwaway,
    // Docker-local, non-secret credential documented in this crate's own README of the
    // fixtures (`docs/B6-FIXTURES.md`), never a real one.

    use std::path::PathBuf;

    /// `cargo test` runs tests concurrently by default, but these live tests share
    /// Docker resources keyed by a FIXED name per fixture letter (`fixture.sh up`'s
    /// own `docker rm -f` + `docker run --name fd-fixture-<letter>`) — two of them
    /// racing (e.g. the run_init and claude_login tests, both against fixture A) hits
    /// a genuine `docker run` "name already in use" conflict, reproduced while
    /// building these tests. Every live test below takes this lock FIRST and holds it
    /// for its whole body, serializing them against each other without needing
    /// `--test-threads=1` for the rest of the (parallel-safe) suite.
    static LIVE_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Locates the `flightdeckd` crate as an ancestor descendant of this crate's own
    /// checkout — walking up from `CARGO_MANIFEST_DIR` (rather than a fixed relative
    /// path) so this resolves correctly BOTH from the main `tosse-code` checkout
    /// (`…/repositories/tosse-code/src-tauri`) AND from a feature worktree nested
    /// several levels deeper (`…/repositories/tosse-code/.claude/worktrees/<slug>/
    /// src-tauri`) — a live test must work the same way regardless of which worktree
    /// it runs from. `flightdeckd` moved into this repo (imported from
    /// `flightdeck-server`, see `flightdeckd/docs/MONOREPO-MOVE.md`).
    /// `FLIGHTDECKD_CRATE_DIR` overrides the search entirely, for a checkout laid out
    /// differently.
    fn flightdeckd_crate_dir() -> PathBuf {
        if let Ok(p) = std::env::var("FLIGHTDECKD_CRATE_DIR") {
            return PathBuf::from(p);
        }
        let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let candidate = dir.join("flightdeckd");
            if candidate.join("live/bootstrap-fixtures").is_dir() {
                return candidate;
            }
            if !dir.pop() {
                panic!(
                    "could not locate the flightdeckd crate as an ancestor of {} \
                     — it should live at <repo root>/flightdeckd, or set FLIGHTDECKD_CRATE_DIR",
                    env!("CARGO_MANIFEST_DIR")
                );
            }
        }
    }

    const FIXTURE_A_PORT: u16 = 2231;
    const FIXTURE_A_USER: &str = "deploy";
    const FIXTURE_A_PASSWORD: &str = "deploy-pw";
    const FIXTURE_C_PORT: u16 = 2233;
    const FIXTURE_C_USER: &str = "josty";
    const FIXTURE_C_PASSWORD: &str = "josty-pw";

    /// Brings a fixture up (or leaves it running — `fixture.sh up` is idempotent).
    /// Panics with the script's own output on failure — a live test failing to even
    /// set up its fixture should say so loudly, not masquerade as a login/init
    /// assertion failure.
    fn fixture_up(letter: &str) {
        let script = flightdeckd_crate_dir().join("live/bootstrap-fixtures/fixture.sh");
        let out = std::process::Command::new("bash")
            .arg(&script)
            .args(["up", letter])
            .output()
            .unwrap_or_else(|e| panic!("could not run {}: {e}", script.display()));
        assert!(
            out.status.success(),
            "fixture.sh up {letter} failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A throwaway keypair for one test run, removed on drop. Never the developer's
    /// real SSH key (mirrors `run_with_password_distinguishes_wrong_from_right_over_a_live_sshd`'s
    /// own `KnownHostsGuard` discipline in `askpass.rs`).
    struct ThrowawayKey {
        dir: PathBuf,
        private: PathBuf,
        public: String,
    }

    impl ThrowawayKey {
        fn generate(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("flightdeck-b10-live-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).expect("scratch dir for the throwaway key");
            let private = dir.join("id_ed25519");
            let out = std::process::Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-f"])
                .arg(&private)
                .args(["-N", "", "-C", "flightdeck-b10-live-test"])
                .output()
                .expect("ssh-keygen must be available");
            assert!(out.status.success(), "ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr));
            let public = std::fs::read_to_string(dir.join("id_ed25519.pub")).expect("read the generated pubkey");
            Self { dir, private, public: public.trim().to_string() }
        }
    }

    impl Drop for ThrowawayKey {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Installs `key.public` into `user`'s `authorized_keys` on `127.0.0.1:port`, over
    /// the ONE password-authenticated connection this whole live-test setup needs —
    /// via this crate's own first-contact relay (`bootstrap::askpass`), not a
    /// hand-rolled second one.
    async fn install_key_via_password(port: u16, user: &str, password: &str, key: &ThrowawayKey) {
        use crate::bootstrap::askpass::{bootstrap_ssh_command, run_with_password};
        let remote = format!(
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo {} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
            crate::ipc::commands::shq(&key.public)
        );
        let cmd = bootstrap_ssh_command(&format!("ssh://{user}@127.0.0.1:{port}"), None, None, &remote);
        let out = run_with_password(cmd, password, None, Duration::from_secs(15))
            .await
            .expect("installing the throwaway key over the fixture's documented password must succeed");
        assert!(
            out.status.success(),
            "key install failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A [`MachineRecord`] pointed at a live fixture, once its key is installed.
    fn fixture_machine(port: u16, user: &str, key: &ThrowawayKey) -> MachineRecord {
        MachineRecord {
            id: format!("live-test-{port}"),
            label: format!("live-test-fixture-{port}"),
            host: "127.0.0.1".to_string(),
            port,
            user: user.to_string(),
            identity_file: Some(key.private.to_string_lossy().into_owned()),
            added_at: 0,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    /// A scratch `known_hosts`, so `StrictHostKeyChecking=accept-new` (the crate's
    /// normal keyed path) pins this run's OWN fixture host key rather than touching —
    /// or colliding with a stale entry in — the developer's real `~/.ssh/known_hosts`.
    /// A fresh Docker container mints a fresh host key on every `docker run`, so a
    /// shared file would eventually collide (the exact trap documented and fixed in
    /// `askpass.rs`'s own live test).
    struct ScratchKnownHosts(PathBuf);
    impl ScratchKnownHosts {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("flightdeck-b10-known-hosts-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, "").expect("scratch known_hosts");
            Self(path)
        }
        fn path(&self) -> Option<&str> {
            self.0.to_str()
        }
    }
    impl Drop for ScratchKnownHosts {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Installs `flightdeckd` onto fixture A over the now-keyed connection: pipes the
    /// repo's already-built static musl binary through `base64 -d` (no `scp`
    /// dependency), then `install`s it with root ownership via `sudo -S`, fed the
    /// fixture's own documented (non-secret, throwaway) password. Fixture C ships with
    /// `flightdeckd` already baked into its image, so only fixture A needs this.
    /// Installs the `claude` CLI onto fixture A via its own official installer, then
    /// symlinks it onto `/usr/local/bin` (root-owned, needs the fixture's `sudo`) —
    /// `~/.local/bin` alone is NOT enough: a non-interactive ssh command doesn't source
    /// `.profile`/`.bashrc` (VERIFIED live while building this test), so `claude`
    /// would be invisible to the very `command -v claude` this crate's own
    /// `probe_remote` uses to decide a server is pairable in the first place — a real
    /// paired machine's `claude` is ALREADY resolvable this way by construction; this
    /// mirrors that for the fixture, which (unlike fixture C's baked-in `flightdeckd`)
    /// starts every `fixture.sh up a` with nothing installed at all.
    async fn install_claude_on_fixture_a(machine: &MachineRecord, known_hosts: Option<&str>) {
        let install = run_ssh_on_machine(
            machine,
            known_hosts,
            "curl -fsSL https://claude.ai/install.sh | bash",
        )
        .await;
        assert!(install.is_ok(), "claude install failed: {install:?}");

        let link_cmd = format!(
            "printf '%s\\n' {} | sudo -S ln -sf \"$HOME/.local/bin/claude\" /usr/local/bin/claude",
            crate::ipc::commands::shq(FIXTURE_A_PASSWORD)
        );
        run_ssh_on_machine(machine, known_hosts, &link_cmd)
            .await
            .expect("linking claude onto /usr/local/bin must succeed");
    }

    async fn install_flightdeckd_on_fixture_a(machine: &MachineRecord, known_hosts: Option<&str>) {
        let dist = flightdeckd_crate_dir().join("target/musl/dist");
        let aarch64 = dist.join("flightdeckd-aarch64-unknown-linux-musl");
        let bin_path = if aarch64.exists() { aarch64 } else { dist.join("flightdeckd-x86_64-unknown-linux-musl") };
        let bytes = std::fs::read(&bin_path).unwrap_or_else(|e| {
            panic!(
                "could not read the fixture's flightdeckd musl binary at {}: {e} — build it first \
                 (flightdeckd/scripts/build-musl.sh)",
                bin_path.display()
            )
        });
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

        // Write the binary, base64-decoded, to a home-writable path — no sudo needed
        // yet.
        let write_cmd = "base64 -d > /tmp/flightdeckd-live-test-bin";
        let mut cmd = keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts);
        cmd.arg("-T")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.arg(format!("{}@{}", machine.user, machine.host)).arg(write_cmd);
        let mut child = cmd.spawn().expect("spawn the base64 upload");
        {
            use tokio::io::AsyncWriteExt as _;
            let mut stdin = child.stdin.take().expect("stdin");
            stdin.write_all(encoded.as_bytes()).await.expect("write the encoded binary");
            drop(stdin); // EOF
        }
        let out = child.wait_with_output().await.expect("wait for the upload");
        assert!(out.status.success(), "binary upload failed: {}", String::from_utf8_lossy(&out.stderr));

        // Move it into place with root ownership — the ONE step needing `sudo` (fed
        // the fixture's own documented password over `sudo -S`, mirroring
        // `bootstrap::templates::render_persistence_escalation`'s doc for exactly this
        // later-task pattern).
        let install_cmd = format!(
            "printf '%s\\n' {} | sudo -S install -m 755 -o root -g root /tmp/flightdeckd-live-test-bin /usr/local/bin/flightdeckd",
            crate::ipc::commands::shq(FIXTURE_A_PASSWORD)
        );
        let out = run_ssh_on_machine(machine, known_hosts, &install_cmd)
            .await
            .expect("installing flightdeckd with sudo must succeed");
        let _ = out;
    }

    /// Reads a remote file's bytes over the keyed connection (`cat`), for the
    /// idempotency proof below ("config untouched" — compared byte for byte, not just
    /// "still exists"). `path` is interpolated UNQUOTED (never `shq()`-wrapped): every
    /// call site passes a fixed `~/...` literal this test itself controls, and it
    /// needs the remote shell's own tilde expansion, which single-quoting would
    /// suppress.
    async fn read_remote_file(machine: &MachineRecord, known_hosts: Option<&str>, path: &str) -> String {
        run_ssh_on_machine(machine, known_hosts, &format!("cat {path}"))
            .await
            .unwrap_or_else(|e| panic!("could not read {path} on the fixture: {e}"))
    }

    /// PROVES the brief's exact idempotency claim against a REAL, freshly-provisioned
    /// node (fixture A): first `run_init` call → `Initialized`; a second call →
    /// `AlreadyInitialized`; and the config file's bytes are IDENTICAL across both —
    /// never overwritten, because [`run_init`] never passes `--force`.
    #[tokio::test]
    #[ignore = "needs Docker (colima start)"]
    async fn live_run_init_against_a_fresh_node_is_idempotent_and_leaves_config_untouched() {
        let _guard = LIVE_FIXTURE_LOCK.lock().await;
        fixture_up("a");
        let key = ThrowawayKey::generate("run-init-fresh");
        install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
        let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
        let kh = ScratchKnownHosts::new("run-init-fresh");
        install_flightdeckd_on_fixture_a(&machine, kh.path()).await;

        let first = run_init(&machine, kh.path(), "b10-live-test")
            .await
            .expect("first run_init must succeed on a fresh node");
        assert!(
            matches!(first, InitOutcome::Initialized { .. }),
            "the FIRST call on a fresh node must be Initialized, got {first:?}"
        );

        let config_after_first = read_remote_file(&machine, kh.path(), "~/.flightdeckd/config.json").await;

        let second = run_init(&machine, kh.path(), "b10-live-test-relabel-attempt")
            .await
            .expect("second run_init must succeed too (never --force, never an error)");
        assert!(
            matches!(second, InitOutcome::AlreadyInitialized { .. }),
            "the SECOND call must be AlreadyInitialized, got {second:?}"
        );

        let config_after_second = read_remote_file(&machine, kh.path(), "~/.flightdeckd/config.json").await;
        assert_eq!(
            config_after_first, config_after_second,
            "the config must be byte-for-byte UNCHANGED by the second (AlreadyInitialized) call — \
             a relabel attempt must never silently take effect via --force"
        );
    }

    /// PROVES the same idempotency claim against fixture C, whose `flightdeckd` was
    /// pre-initialized at IMAGE BUILD time (not by this test) — a from-cold-start
    /// re-run of the whole bootstrap flow against an already-bootstrapped node must
    /// still land on `AlreadyInitialized` with the config untouched.
    #[tokio::test]
    #[ignore = "needs Docker (colima start)"]
    async fn live_run_init_against_a_pre_initialized_node_is_already_initialized() {
        let _guard = LIVE_FIXTURE_LOCK.lock().await;
        fixture_up("c");
        let key = ThrowawayKey::generate("run-init-preinit");
        install_key_via_password(FIXTURE_C_PORT, FIXTURE_C_USER, FIXTURE_C_PASSWORD, &key).await;
        let machine = fixture_machine(FIXTURE_C_PORT, FIXTURE_C_USER, &key);
        let kh = ScratchKnownHosts::new("run-init-preinit");

        let config_before = read_remote_file(&machine, kh.path(), "~/.flightdeckd/config.json").await;
        let outcome = run_init(&machine, kh.path(), "should-not-matter")
            .await
            .expect("run_init against an already-initialized node must succeed, not error");
        assert!(
            matches!(outcome, InitOutcome::AlreadyInitialized { .. }),
            "got {outcome:?}"
        );
        let config_after = read_remote_file(&machine, kh.path(), "~/.flightdeckd/config.json").await;
        assert_eq!(config_before, config_after, "config must be untouched");
    }

    /// PROVES the live end-to-end claim this whole module's design rests on: driving a
    /// REAL, not-logged-in `claude` over ssh reaches `UrlReady` with a real OAuth URL —
    /// exactly the spike this module's doc describes, now pinned as a regression test.
    /// Cannot complete the OAuth exchange itself (needs a human in a browser) — cancels
    /// once the URL is recognized. ⚠️ MANUAL CHECKLIST ITEM: re-run this (and, by hand,
    /// walk a real code through to `Done`) whenever the `claude` CLI is bumped — a
    /// wording change in its sign-in prompt is exactly what `LOGIN_PROMPT_NOT_RECOGNIZED_MSG`
    /// exists to catch, but only a live run against the new binary proves it either way.
    #[tokio::test]
    #[ignore = "needs Docker (colima start)"]
    async fn live_claude_login_reaches_url_ready_against_the_docker_fixture() {
        let _guard = LIVE_FIXTURE_LOCK.lock().await;
        fixture_up("a");
        let key = ThrowawayKey::generate("claude-login");
        install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
        let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
        let kh = ScratchKnownHosts::new("claude-login");
        install_claude_on_fixture_a(&machine, kh.path()).await;

        // Fixture A's claude must be signed OUT for this to reach UrlReady rather than
        // short-circuiting straight to Done — true on a freshly built fixture image
        // (nothing in this repo's setup ever signs it in), asserted up front so a
        // stale/reused fixture fails LOUDLY here instead of masquerading as a bug in
        // this module.
        // `probe_auth_status`, not `run_ssh_on_machine` — the real CLI exits non-zero
        // for "not logged in" too, which `run_ssh_on_machine` would treat as a failed
        // call and silently discard the (perfectly valid) JSON on stdout, turning this
        // precondition check into a no-op `assert_ne!(None, Some(true))`.
        let status = probe_auth_status(&machine, kh.path()).await;
        assert_ne!(
            status.map(|s| s.logged_in),
            Some(true),
            "fixture A's claude must be signed out for this test to be meaningful — \
             reset the fixture (fixture.sh down a && fixture.sh up a) if it somehow got signed in"
        );

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<DriverCommand>();
        let captured_url = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let captured_url_cb = captured_url.clone();
        let cmd_tx_cb = cmd_tx.clone();

        // `on_url` runs SYNCHRONOUSLY inside `drive_claude_login`'s own read loop the
        // instant it recognizes the URL — recording it and queuing a `Cancel` right
        // there (an unbounded send never blocks) is what lets this test stop the drive
        // itself the moment it reaches `UrlReady`, rather than racing an external
        // timeout against the driver's own (much longer) internal one.
        let outcome = tokio::time::timeout(
            Duration::from_secs(20),
            drive_claude_login(&machine, kh.path(), cmd_rx, move |url| {
                *captured_url_cb.lock().unwrap() = Some(url.to_string());
                let _ = cmd_tx_cb.send(DriverCommand::Cancel);
            }),
        )
        .await;
        drop(cmd_tx);

        match outcome {
            Ok(LoginOutcome::Cancelled) => {}
            Ok(other) => panic!("expected Cancelled (self-cancelled once the URL was seen), got {other:?}"),
            Err(_) => panic!("drive_claude_login did not reach UrlReady within the test's own 20s bound"),
        }

        let url = captured_url.lock().unwrap().clone();
        let url = url.expect("must have recognized the sign-in URL before cancelling");
        assert!(url.starts_with("https://"), "got {url:?}");
        assert!(url.to_ascii_lowercase().contains("oauth"), "got {url:?}");
    }

    /// B-finding #4's `Supersede` sibling of the test above: an explicit "Restart
    /// sign-in" arriving mid-drive must resolve as `LoginOutcome::Superseded`, NOT
    /// `Cancelled` — the two must stay distinguishable end to end (`run_login_actor`
    /// only emits a `ServerLoginResultEvent` for the former), never just at the
    /// `DriverCommand` enum level.
    #[tokio::test]
    #[ignore = "needs Docker (colima start)"]
    async fn live_claude_login_supersede_resolves_as_superseded_not_cancelled() {
        let _guard = LIVE_FIXTURE_LOCK.lock().await;
        fixture_up("a");
        let key = ThrowawayKey::generate("claude-login-supersede");
        install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
        let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
        let kh = ScratchKnownHosts::new("claude-login-supersede");
        install_claude_on_fixture_a(&machine, kh.path()).await;

        let status = probe_auth_status(&machine, kh.path()).await;
        assert_ne!(
            status.map(|s| s.logged_in),
            Some(true),
            "fixture A's claude must be signed out for this test to be meaningful"
        );

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<DriverCommand>();
        let cmd_tx_cb = cmd_tx.clone();

        let outcome = tokio::time::timeout(
            Duration::from_secs(20),
            drive_claude_login(&machine, kh.path(), cmd_rx, move |_url| {
                // Mirrors `restart_claude_login`'s own `Supersede` send — a session
                // being explicitly replaced, never a same-caller `Cancel`.
                let _ = cmd_tx_cb.send(DriverCommand::Supersede);
            }),
        )
        .await;
        drop(cmd_tx);

        match outcome {
            Ok(LoginOutcome::Superseded) => {}
            Ok(other) => panic!("expected Superseded once the URL was seen, got {other:?}"),
            Err(_) => panic!("drive_claude_login did not reach UrlReady within the test's own 20s bound"),
        }
    }
}
