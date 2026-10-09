//! Provisioning/revoking the phone-access token on every paired daemon (C10) —
//! the daemon-side counterpart of `appmcp::relay`'s Mac-side revocation.
//!
//! Model (decided): ONE phone pairing on the Mac grants the phone access to ALL
//! of the Mac's paired servers — the Mac authorizes the SAME `phoneToken` on each
//! daemon, and the relay answers a phone's `POST /nodes` with every node that
//! token is authorized on (flightdeck-remote `PROTOCOL.md` §3.1/§4.1).
//!
//! Wire to a daemon (deployed `flightdeckd` 0.2.0), driven the SAME keyed-SSH way
//! `bootstrap::server_setup` drives `flightdeckd init`/`whoami` (see that
//! module's doc: ONE ssh invoker in this crate — [`crate::ipc::commands`]):
//! - `flightdeckd whoami` → `{mac_id, relay_url, label}`, no daemon process
//!   needed — reused here to keep a machine's C8 identity fields fresh.
//! - `flightdeckd add-phone --token - --label <L>`, the token on STDIN (never
//!   argv, never logged) → `{type:"fd_phone_added", ok:true, added:bool}` |
//!   `{ok:false, error}` (e.g. the 33rd token: `"too many authorized phones (max
//!   32) — remove one first"`, surfaced verbatim).
//! - `flightdeckd remove-phone --token -`, same stdin convention →
//!   `{type:"fd_phone_removed", ok:true, removed:bool}` | `{ok:false, error}`.
//! - An OLD daemon (predates phone support) answers NEITHER shape on either
//!   subcommand — it answers `fd_detach{reason:"error", message:"missing attach,
//!   status or stop"}` (a generic "I don't understand this control message"
//!   bounce). Surfaced as [`ProvisionState::DaemonTooOld`] /
//!   [`RevokeOutcome::DaemonTooOld`] rather than a generic failure, so Settings
//!   can say "update flightdeckd" instead of an opaque error.
//! - `flightdeckd remove-phone --init-minted --keep -` (flightdeckd >= 0.3.0), this
//!   Mac's CURRENT token on stdin → `{type:"fd_init_phone_removed", ok:true,
//!   removed:0|1}`: revokes the phone token a plain `init` minted (the one `init`
//!   flagged, from 0.3.0; on a config an older binary wrote, the first authorized one
//!   still labelled "phone" — once, the daemon then records provenance), never the
//!   `--keep` one nor any token a Mac added with `add-phone`. A refusal exits non-zero
//!   with the reason on stderr;
//!   an older binary rejects the flag with clap's usage error (exit 2, `error:
//!   unexpected argument '--init-minted' found`). Run until it succeeds once per
//!   server: after a successful provisioning, once per launch
//!   ([`clean_init_phone_tokens_at_launch`]) and after a repair that restarted the
//!   daemon ([`clean_init_phone_token_if_due`]) — see [`clean_init_phone_token`].
//!
//! Every public function here takes a plain `&Store` (+ `known_hosts`), never a
//! `tauri::AppHandle` — the same "testable core, thin IPC-layer wrapper" split
//! [`crate::ipc::commands::delete_machine_and_key`] already uses, so the whole
//! provision/revoke pipeline is unit-testable against a fake `ssh` on `PATH` and
//! an in-memory [`Store`], with no live Tauri app or network required. The
//! IPC-layer wrappers (`ipc::commands::{add_machine, delete_machine, set_remote,
//! retry_phone_provisioning}`) own turning an outcome into a [`ProvisionRegistry`]
//! entry the Settings UI reads back.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ipc::commands::{resolve_daemon_bin_expr, run_ssh_on_machine, run_ssh_on_machine_stdin, shq};
use crate::store::{MachineRecord, Store};

/// Bound for this module's stdin-bearing ssh calls (`add-phone`/`remove-phone`) —
/// unchanged from what this module used before B11's ssh-helper unification.
const PHONE_ROUND_TRIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `flightdeckd whoami`'s shape — a LOCAL copy of
/// [`crate::bootstrap::server_setup::ServerIdentity`] rather than a shared
/// import: that struct belongs to the `bootstrap::server_setup` module (its own
/// `init`/`whoami` round trip), and reaching into it from `appmcp::provision`
/// would tie two otherwise-independent features together for a 3-field struct.
/// Kept in sync by the same wire fixture (`{mac_id, relay_url, label}`), not by
/// sharing code.
#[derive(Debug, Deserialize)]
struct WhoamiIdentity {
    mac_id: String,
    relay_url: String,
    label: String,
}

/// One paired daemon's outcome, as Settings reads it back
/// (`ipc::commands::phone_provisioning_status`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProvisionState {
    /// `add-phone` answered `ok:true` — the daemon now authorizes this Mac's
    /// current phone token.
    Provisioned { at_ms: i64 },
    /// An attempt is currently in flight (set by
    /// `ipc::commands::retry_phone_provisioning` the moment it starts, so a
    /// Settings click gets immediate feedback rather than a frozen row).
    Pending,
    /// The round trip completed but did not succeed — an ssh/connectivity error,
    /// or the daemon's own business-logic refusal (`ok:false`), verbatim.
    Failed { reason: String },
    /// The daemon answered `fd_detach` — too old to understand `add-phone`/
    /// `remove-phone` at all.
    DaemonTooOld,
}

/// [`ProvisionState`] plus which machine and when — the row shape Settings lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct MachineProvisionStatus {
    pub machine_id: String,
    pub state: ProvisionState,
    pub checked_at_ms: i64,
}

/// In-memory, per-app-run registry of the last provisioning outcome per machine —
/// the SAME "runtime status the settings UI reads back" shape as `ControlHub`'s
/// voice/remote runtimes, kept in its own module-owned type (not folded into
/// `ControlHub`) per this crate's one-module-per-resource discipline. Never
/// persisted: a fresh launch shows every machine with no status until the next
/// provisioning attempt (the background hooks — `add_machine`, enabling remote
/// access, regenerating pairing — populate it again soon after boot in the
/// common case).
#[derive(Default)]
pub struct ProvisionRegistry {
    status: Mutex<HashMap<String, MachineProvisionStatus>>,
}

impl ProvisionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every machine this run has attempted at least once, most-recently-checked
    /// order is NOT guaranteed (the front sorts/joins this against its own machine
    /// list by `machine_id`).
    pub fn all(&self) -> Vec<MachineProvisionStatus> {
        self.status
            .lock()
            .expect("provision registry lock")
            .values()
            .cloned()
            .collect()
    }

    /// Record `state` for `machine_id`, stamped with the current time, and return
    /// the row that was just recorded (so a caller like
    /// `retry_phone_provisioning` can hand it straight back to its own return
    /// value without a second lookup).
    pub fn record(&self, machine_id: &str, state: ProvisionState) -> MachineProvisionStatus {
        let row = MachineProvisionStatus {
            machine_id: machine_id.to_string(),
            state,
            checked_at_ms: now_ms(),
        };
        self.status
            .lock()
            .expect("provision registry lock")
            .insert(machine_id.to_string(), row.clone());
        row
    }
}

/// [`RevokeOutcome`] plus which machine and when — the revoke-side counterpart
/// of [`MachineProvisionStatus`], Settings' per-server row for "did the old
/// token actually get forgotten here". A machine absent from
/// [`RevokeRegistry::all`] has simply never had a revocation attempted this
/// run (most machines, most of the time — a revoke only runs when
/// `regenerate_pairing` fires) — not evidence it still holds a stale token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct MachineRevokeStatus {
    pub machine_id: String,
    pub outcome: RevokeOutcome,
    pub checked_at_ms: i64,
}

/// In-memory, per-app-run registry of the last revoke outcome per machine —
/// see [`ProvisionRegistry`]'s doc for why this is its own module-owned type
/// rather than folded into `ControlHub`. Exists so `ipc::commands::set_remote`'s
/// regenerate-pairing revoke sweep (C10's critical fix) has somewhere durable
/// (for this run) to put each daemon's outcome instead of discarding the
/// `Vec<(String, RevokeOutcome)>` it used to throw away — the review finding
/// this closes: "regenerate-pairing must report which nodes still hold the OLD
/// token when a revoke failed".
#[derive(Default)]
pub struct RevokeRegistry {
    status: Mutex<HashMap<String, MachineRevokeStatus>>,
}

impl RevokeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every machine a revoke was attempted against this run — see
    /// [`ProvisionRegistry::all`]'s doc for the same ordering caveat.
    pub fn all(&self) -> Vec<MachineRevokeStatus> {
        self.status
            .lock()
            .expect("revoke registry lock")
            .values()
            .cloned()
            .collect()
    }

    /// Record `outcome` for `machine_id`, stamped with the current time.
    pub fn record(&self, machine_id: &str, outcome: RevokeOutcome) -> MachineRevokeStatus {
        let row = MachineRevokeStatus {
            machine_id: machine_id.to_string(),
            outcome,
            checked_at_ms: now_ms(),
        };
        self.status
            .lock()
            .expect("revoke registry lock")
            .insert(machine_id.to_string(), row.clone());
        row
    }
}

/// One daemon's parsed answer to `add-phone`/`remove-phone` — see the module doc
/// for the three wire shapes this covers.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonReply {
    /// `ok:true`. `changed` is `added`/`removed` when the daemon reports one
    /// (`true` when absent, e.g. an older 0.2.0 patch that predates the flag but
    /// still answers `ok:true` — an unknown "did it actually change" defaults to
    /// "treat it as done" rather than an error over a field this call doesn't
    /// strictly need).
    Ok { changed: bool },
    /// `ok:false` — the daemon's own `error` string, verbatim (e.g. "too many
    /// authorized phones (max 32) — remove one first").
    Refused(String),
    /// `fd_detach` — an old daemon that doesn't understand this subcommand.
    TooOld,
}

/// Parses one `add-phone`/`remove-phone` JSON-line reply. `None` for anything
/// that isn't one of the three recognized shapes (garbage stdout, a truncated
/// line, …) — the caller then falls back to the ssh-level exit/stderr, exactly
/// like `bootstrap::server_setup::parse_whoami`'s degrade-to-"no answer" doc
/// describes for its own case. Pure — unit-tested against the literal fixture
/// strings from the C10 brief, no live remote needed.
fn parse_daemon_reply(stdout: &str) -> Option<DaemonReply> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    if v.get("type").and_then(Value::as_str) == Some("fd_detach") {
        return Some(DaemonReply::TooOld);
    }
    match v.get("ok").and_then(Value::as_bool)? {
        true => {
            let changed = v
                .get("added")
                .or_else(|| v.get("removed"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            Some(DaemonReply::Ok { changed })
        }
        false => {
            let err = v
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown daemon error")
                .to_string();
            Some(DaemonReply::Refused(err))
        }
    }
}

/// Runs one `add-phone`/`remove-phone` round trip (the token piped to stdin, per
/// the module doc) and classifies the answer. Tries [`parse_daemon_reply`]
/// against stdout REGARDLESS of the ssh command's own exit status — mirroring why
/// `bootstrap::server_setup::probe_auth_status` reads `claude auth status
/// --json`'s stdout the same way (see that function's doc): a daemon's own
/// business-logic refusal is a complete, well-formed answer, not a process
/// failure. Only falls back to the ssh-level stderr/"unexpected response" when
/// stdout genuinely didn't carry a recognized shape.
async fn run_phone_reply(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    stdin_payload: &[u8],
) -> Result<DaemonReply, String> {
    let out =
        run_ssh_on_machine_stdin(machine, known_hosts, remote_cmd, stdin_payload, None, PHONE_ROUND_TRIP_TIMEOUT)
            .await?;
    if let Some(reply) = parse_daemon_reply(&out.stdout) {
        return Ok(reply);
    }
    if !out.success {
        return Err(failed_round_trip_reason(out.exit_code, &out.stderr));
    }
    Err(format!("unexpected daemon response: {}", out.stdout.trim()))
}

/// Why a remote command that exited non-zero failed, as one line. ssh's own exit-255
/// failures (key refused / host key changed / unreachable) become a plain sentence
/// first — the real incident that motivated this had ssh's raw stderr line
/// (`josty@100.97.14.57: Permission denied (publickey,password).`) leaking straight
/// into the phone-provisioning status row; anything else is the daemon's own reason:
/// the first `Error: ` line when there is one — `flightdeckd`'s CLI errors print what
/// failed there, then the root cause after `Caused by:` (`No such file or directory`
/// alone says nothing) — else the last non-empty stderr line.
fn failed_round_trip_reason(exit_code: Option<i32>, stderr: &str) -> String {
    let stderr_lines: Vec<String> = stderr.lines().map(str::to_string).collect();
    crate::ssh_link::classify_transport_close(exit_code, &stderr_lines)
        .map(crate::ssh_link::describe)
        .unwrap_or_else(|| {
            stderr_lines
                .iter()
                .find(|l| l.starts_with("Error: "))
                .or_else(|| stderr_lines.iter().rev().find(|l| !l.trim().is_empty()))
                .cloned()
                .unwrap_or_else(|| "ssh command failed".to_string())
        })
}

/// Provision (authorize) this Mac's current phone pairing token on one paired
/// server: best-effort `flightdeckd whoami` (keeps the C8 identity fields —
/// `daemon_mac_id`/`daemon_relay_url`/`daemon_label` — fresh; a failure here does
/// NOT by itself fail provisioning), then `flightdeckd add-phone --token -
/// --label <this Mac's node label>`. On success, stamps
/// `Store::set_machine_phone_provisioned_at`. Also drains any phone token still
/// queued for THIS machine's revocation (see [`revoke_phone_on_machine`]'s doc):
/// a successful round trip IS "the next successful contact" a queued revocation
/// was waiting for. Once `add-phone` succeeded, it also revokes the phone token an
/// older plain `init` minted, until that has succeeded once on this server
/// ([`clean_init_phone_token`]) — without any effect on the returned state. A
/// `whoami` naming another daemon than the one recorded re-arms that cleanup.
///
/// `Err` only for a reason unrelated to the daemon round trip itself (unknown
/// `machine_id`, a `Store` error) — every daemon-side outcome (refused,
/// unreachable, too old) comes back as `Ok(ProvisionState::Failed { .. })` /
/// `Ok(ProvisionState::DaemonTooOld)`, never an `Err`, so a caller iterating every
/// machine (see [`provision_phone_on_all_machines`]) never has to treat "this one
/// server is down" as exceptional.
pub async fn provision_phone_on_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine_id: &str,
) -> Result<ProvisionState, String> {
    let machine = store
        .machine_by_id(machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown server: {machine_id}"))?;
    let cfg = crate::ipc::commands::load_remote_config(store);
    if cfg.phone_token.is_empty() {
        // Should not happen in practice (the token is minted on first use), but a
        // clear refusal here is better than an ssh round trip for an empty secret.
        return Ok(ProvisionState::Failed { reason: "no phone pairing token minted yet".into() });
    }

    // Resolved via the crate's ONE shared resolver (`ipc::commands::
    // resolve_daemon_bin_expr`, B11) rather than a bare `flightdeckd` — a
    // non-interactive ssh shell never has `~/.local/bin` on `PATH`, so a user-level
    // install made every call below fail with "command not found" until this
    // resolved it the same way `bootstrap::install`/`bootstrap::server_setup` do.
    let daemon_bin = resolve_daemon_bin_expr("flightdeckd");

    // Best-effort: attach this daemon's own identity if whoami answers. Neither a
    // connectivity failure nor an unparsable answer stops provisioning below —
    // `add-phone` is the round trip that actually determines the outcome.
    if let Ok(stdout) = run_ssh_on_machine(&machine, known_hosts, &format!("{daemon_bin} whoami")).await {
        if let Ok(identity) = serde_json::from_str::<WhoamiIdentity>(stdout.trim()) {
            if another_daemon_answers(machine.daemon_mac_id.as_deref(), &identity.mac_id) {
                // Reinstalled, or this row now points at another server: the init token
                // of the daemon answering now was never cleaned.
                if let Err(e) = store.set_machine_init_phone_cleaned_at(&machine.id, None) {
                    eprintln!("[provision] {}: could not re-arm the init-token cleanup ({e})", machine.label);
                }
            }
            let _ = store.set_machine_daemon_identity(
                &machine.id,
                &identity.mac_id,
                &identity.relay_url,
                &identity.label,
            );
        }
    }

    let cmd = format!("{daemon_bin} add-phone --token - --label {}", shq(&cfg.mac_label));
    let state = match run_phone_reply(&machine, known_hosts, &cmd, cfg.phone_token.as_bytes()).await {
        Ok(DaemonReply::Ok { .. }) => {
            store
                .set_machine_phone_provisioned_at(&machine.id, now_ms())
                .map_err(|e| e.to_string())?;
            ProvisionState::Provisioned { at_ms: now_ms() }
        }
        Ok(DaemonReply::Refused(reason)) => ProvisionState::Failed { reason },
        Ok(DaemonReply::TooOld) => ProvisionState::DaemonTooOld,
        Err(reason) => ProvisionState::Failed { reason },
    };

    // A successful round trip proves this daemon is reachable right now — retry
    // any revocation still queued for it (see `revoke_phone_on_machine`'s doc).
    if !matches!(state, ProvisionState::Failed { .. }) {
        drain_pending_daemon_revocations(store, known_hosts, &machine).await;
    }

    // The daemon now authorizes this Mac's token — the one the cleanup must keep —
    // so this is when the phone token an older `init` minted can go (once per server).
    match store.machine_init_phone_cleaned_at(&machine.id) {
        Ok(cleaned_at) if init_token_cleanup_due(&state, cleaned_at) => {
            clean_init_phone_token(store, known_hosts, &machine, &cfg.phone_token).await;
        }
        Ok(_) => {}
        Err(e) => eprintln!(
            "[provision] {}: could not read whether the init-token cleanup ran ({e}) — skipped this time",
            machine.label
        ),
    }

    Ok(state)
}

/// The `flightdeckd remove-phone` flag of the orphan-token cleanup — an older daemon's
/// clap usage error names it (see [`parse_init_cleanup_reply`]).
const INIT_CLEANUP_FLAG: &str = "--init-minted";

/// One daemon's answer to `flightdeckd remove-phone --init-minted --keep -` (see the
/// module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InitTokenCleanup {
    /// Done: the server no longer authorizes a token `init` minted. `removed` is how
    /// many this call revoked — 0 when there was none left (a server installed with
    /// `init --no-phone-token`, or one a manual `remove-phone` already cleaned).
    Done { removed: u64 },
    /// The daemon's binary predates the request (clap's usage error on the flag):
    /// nothing changed, and it runs again once the daemon is updated (the restart
    /// that ends an update, or the next launch). Not an error the user sees.
    Unsupported,
    /// Anything else — unreachable, refused, a daemon still RUNNING an older binary
    /// than the one on disk, an answer of an unexpected shape. Runs again at the next
    /// launch, daemon restart or provisioning.
    Failed(String),
}

/// Classifies one cleanup round trip from its stdout, stderr and exit code. Pure —
/// unit-tested against the daemon's literal answers, including the usage error an
/// older daemon really prints. Only the exact success line counts as done (an
/// `fd_phone_removed` reply, say, is not this request's answer).
fn parse_init_cleanup_reply(stdout: &str, stderr: &str, exit_code: Option<i32>) -> InitTokenCleanup {
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        let is_answer = v.get("type").and_then(Value::as_str) == Some("fd_init_phone_removed")
            && v.get("ok").and_then(Value::as_bool) == Some(true);
        if let (true, Some(removed)) = (is_answer, v.get("removed").and_then(Value::as_u64)) {
            return InitTokenCleanup::Done { removed };
        }
    }
    // clap's usage errors exit 2 (every flightdeckd ever shipped is clap 4.6).
    if exit_code == Some(2) && stderr.contains(&format!("unexpected argument '{INIT_CLEANUP_FLAG}'")) {
        return InitTokenCleanup::Unsupported;
    }
    if exit_code != Some(0) {
        return InitTokenCleanup::Failed(failed_round_trip_reason(exit_code, stderr));
    }
    InitTokenCleanup::Failed(format!("unexpected daemon response: {}", stdout.trim()))
}

/// Whether this provisioning also runs the orphan-token cleanup: only when the daemon
/// has just authorized this Mac's token (the `--keep` token, which the daemon requires
/// to be authorized), and only until the cleanup has succeeded once on this server.
fn init_token_cleanup_due(state: &ProvisionState, cleaned_at: Option<i64>) -> bool {
    matches!(state, ProvisionState::Provisioned { .. }) && cleaned_at.is_none()
}

/// Whether the orphan-token cleanup is still to run on a paired server OUTSIDE a
/// provisioning (at launch, after a daemon restart): remote access is on with a token
/// minted — the gate every provisioning hook uses — this Mac's token was provisioned
/// there (the daemon refuses a `--keep` token it does not authorize, so a server never
/// provisioned would only refuse), and the cleanup has not succeeded there yet.
fn init_cleanup_due_on_paired_server(
    remote_enabled: bool,
    phone_token: &str,
    phone_provisioned_at: Option<i64>,
    cleaned_at: Option<i64>,
) -> bool {
    remote_enabled && !phone_token.is_empty() && phone_provisioned_at.is_some() && cleaned_at.is_none()
}

/// Whether `whoami` names another daemon than the one this server row recorded — a
/// server reinstalled from scratch (`init --force`), or a row whose address now
/// reaches another server. Nothing recorded yet (first provisioning) is not "another".
fn another_daemon_answers(recorded_mac_id: Option<&str>, answered_mac_id: &str) -> bool {
    recorded_mac_id.is_some_and(|recorded| recorded != answered_mac_id)
}

/// The one log line a cleanup attempt leaves: a count or a reason, never a token — no
/// token is even an input here.
fn init_cleanup_log_line(server: &str, outcome: &InitTokenCleanup) -> String {
    match outcome {
        InitTokenCleanup::Done { removed } => {
            format!("[provision] {server}: removed {removed} phone token(s) minted by an older `flightdeckd init`")
        }
        InitTokenCleanup::Unsupported => {
            format!("[provision] {server}: flightdeckd predates the init-token cleanup — it runs once flightdeckd is updated")
        }
        InitTokenCleanup::Failed(reason) => format!(
            "[provision] {server}: init-token cleanup not done ({reason}) — it runs again at the next launch, \
             daemon restart or provisioning"
        ),
    }
}

/// Revokes, on `machine`, the phone token an older plain `flightdeckd init` minted:
/// the Mac never used it (it authorizes its own with `add-phone`), yet it stayed
/// authorized on the relay, invisible here and untouched by Regenerate pairing. The
/// decision is the owner's: it is revoked automatically, once per server, accepting
/// that a phone paired by hand with that init link loses access.
///
/// Goes through the RUNNING daemon (`flightdeckd remove-phone --init-minted --keep -`:
/// config lock, tombstone, live relay revocation with its confirmation), never by
/// editing the daemon's config. `current_token` — this Mac's token the daemon just
/// authorized — travels on stdin only, as the token the daemon must keep; the daemon
/// never removes it, nor any token a Mac added with `add-phone` (another Mac sharing
/// the server keeps its own). Success is recorded
/// ([`Store::set_machine_init_phone_cleaned_at`]); any other outcome is left for the
/// next launch, daemon restart or provisioning. It never changes the provisioning
/// outcome and shows nothing in the UI: one log line ([`init_cleanup_log_line`]).
async fn clean_init_phone_token(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    current_token: &str,
) -> InitTokenCleanup {
    let cmd = format!("{} remove-phone {INIT_CLEANUP_FLAG} --keep -", resolve_daemon_bin_expr("flightdeckd"));
    let round_trip = run_ssh_on_machine_stdin(
        machine,
        known_hosts,
        &cmd,
        current_token.as_bytes(),
        None,
        PHONE_ROUND_TRIP_TIMEOUT,
    )
    .await;
    let outcome = match round_trip {
        Ok(out) => parse_init_cleanup_reply(&out.stdout, &out.stderr, out.exit_code),
        Err(reason) => InitTokenCleanup::Failed(reason),
    };
    if matches!(outcome, InitTokenCleanup::Done { .. }) {
        if let Err(e) = store.set_machine_init_phone_cleaned_at(&machine.id, Some(now_ms())) {
            eprintln!(
                "[provision] {}: could not record the init-token cleanup ({e}) — it runs again next time",
                machine.label
            );
        }
    }
    eprintln!("{}", init_cleanup_log_line(&machine.label, &outcome));
    outcome
}

/// [`clean_init_phone_token`] on `machine` when it is still due there outside a
/// provisioning ([`init_cleanup_due_on_paired_server`]) — `None` when it is not.
async fn clean_init_phone_token_on_paired_server(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    cfg: &crate::appmcp::RemoteConfig,
) -> Option<InitTokenCleanup> {
    let cleaned_at = match store.machine_init_phone_cleaned_at(&machine.id) {
        Ok(cleaned_at) => cleaned_at,
        Err(e) => {
            eprintln!(
                "[provision] {}: could not read whether the init-token cleanup ran ({e}) — skipped this time",
                machine.label
            );
            return None;
        }
    };
    if !init_cleanup_due_on_paired_server(cfg.enabled, &cfg.phone_token, machine.phone_provisioned_at, cleaned_at) {
        return None;
    }
    Some(clean_init_phone_token(store, known_hosts, machine, &cfg.phone_token).await)
}

/// The orphan-token cleanup on ONE paired server, if it is still due there — the
/// trigger after a repair that restarted its daemon
/// (`bootstrap::orchestrator::repair`): updating flightdeckd ends with that restart,
/// which is the first moment a server that answered [`InitTokenCleanup::Unsupported`]
/// can do it. Needs no `add-phone` first: this Mac's token was provisioned there, and
/// the daemon refuses a `--keep` token it does not authorize anyway. `None` when it
/// was not due (or the server is unknown).
pub(crate) async fn clean_init_phone_token_if_due(
    store: &Store,
    known_hosts: Option<&str>,
    machine_id: &str,
) -> Option<InitTokenCleanup> {
    let machine = match store.machine_by_id(machine_id) {
        Ok(Some(machine)) => machine,
        Ok(None) => return None,
        Err(e) => {
            eprintln!("[provision] {machine_id}: could not read the server for the init-token cleanup ({e})");
            return None;
        }
    };
    let cfg = crate::ipc::commands::load_remote_config(store);
    clean_init_phone_token_on_paired_server(store, known_hosts, &machine, &cfg).await
}

/// The launch pass of the orphan-token cleanup: every paired server where it is still
/// due ([`init_cleanup_due_on_paired_server`]), one after another, at most once per
/// server per launch — already-paired servers are cleaned without waiting for a
/// provisioning, which nothing triggers on its own once remote access is on. Bounded:
/// a server stops costing anything the first time it succeeds there, and one whose
/// daemon is too old or which is unreachable costs one ssh round trip per launch until
/// then. Returns how many servers it ran on.
pub async fn clean_init_phone_tokens_at_launch(store: &Store, known_hosts: Option<&str>) -> usize {
    let cfg = crate::ipc::commands::load_remote_config(store);
    if !cfg.enabled {
        return 0;
    }
    let machines = match store.all_machines() {
        Ok(machines) => machines,
        Err(e) => {
            eprintln!("[provision] init-token cleanup skipped this launch: could not read the servers ({e})");
            return 0;
        }
    };
    let mut ran = 0;
    for machine in &machines {
        if clean_init_phone_token_on_paired_server(store, known_hosts, machine, &cfg).await.is_some() {
            ran += 1;
        }
    }
    ran
}

/// [`provision_phone_on_machine`] for every paired server, in `added_at` order.
/// Sequential (not concurrent): provisioning is triggered by rare events
/// (enabling remote access, a fresh pairing, adding a server) and never on a hot
/// path, so a modest handful of servers finishing one after another beats N
/// simultaneous ssh connections racing the same host-key/known_hosts file.
pub async fn provision_phone_on_all_machines(
    store: &Store,
    known_hosts: Option<&str>,
) -> Vec<MachineProvisionStatus> {
    let machines = store.all_machines().unwrap_or_default();
    let mut results = Vec::with_capacity(machines.len());
    for m in machines {
        let state = match provision_phone_on_machine(store, known_hosts, &m.id).await {
            Ok(state) => state,
            Err(reason) => ProvisionState::Failed { reason },
        };
        results.push(MachineProvisionStatus { machine_id: m.id, state, checked_at_ms: now_ms() });
    }
    results
}

/// One `revoke_phone_on_machine` outcome, as Settings reads it back
/// (`ipc::commands::phone_revocation_status`) — the revoke-side counterpart of
/// [`ProvisionState`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RevokeOutcome {
    /// The daemon confirmed the token is gone (or was never authorized — `ok:true`
    /// either way).
    Removed,
    /// The daemon was unreachable right now, refused the removal, or is too old
    /// to understand `remove-phone` (see below) — in every one of these cases
    /// the token was ALSO queued for a retry: on a paired machine
    /// (`Store::queue_daemon_phone_revocation`), the next time it is successfully
    /// contacted (see [`drain_pending_daemon_revocations`]); on a server being
    /// REMOVED, as a tombstone retried at each launch
    /// ([`retry_removed_server_revocations`]). `Queued` is reported only for the
    /// "genuinely could not reach it at all" case, so Settings can tell that
    /// apart from a business-logic refusal or an old daemon that answered but
    /// declined.
    Queued,
    /// The daemon answered `fd_detach` — too old to understand `remove-phone` at
    /// all. Still queued for retry (see `Queued`'s doc): a later `flightdeckd`
    /// update on that box makes the retry succeed for free.
    DaemonTooOld,
    /// The daemon answered `ok:false` — its own refusal, verbatim. Still queued
    /// for retry (see `Queued`'s doc): re-attempting a removal is idempotent, so
    /// queuing it even for a refusal that might be permanent costs nothing but
    /// an occasional extra ssh round trip.
    Failed { reason: String },
}

/// Revoke ONE phone token on ONE paired server: `flightdeckd remove-phone
/// --token -`, the token piped to stdin (never argv, never logged — the only
/// place it is ever written to disk is [`Store::queue_daemon_phone_revocation`],
/// cleared the moment the removal is confirmed). An unreachable machine is not a
/// failure of this call — it is recorded as [`RevokeOutcome::Queued`] and retried
/// automatically the next time [`provision_phone_on_machine`] successfully
/// contacts that same machine (C10's "revoke_pending, retried on the next
/// successful contact").
pub async fn revoke_phone_on_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    token: &str,
) -> RevokeOutcome {
    let outcome = remove_phone_from_daemon(known_hosts, machine, token).await;
    // A REACHABLE daemon can still refuse (`ok:false`) or be too old to understand
    // `remove-phone` at all — both are queued for automatic retry, same as the
    // unreachable case (see `RevokeOutcome`'s doc): a reachable-but-refused daemon is
    // exactly as real a case as `add-phone`'s own 33rd-token refusal, and leaving it
    // un-queued would strand the old token with no automatic path back to actually gone.
    if outcome == RevokeOutcome::Removed {
        let _ = store.clear_daemon_phone_revocation(&machine.id, token);
    } else {
        let _ = store.queue_daemon_phone_revocation(&machine.id, token, now_ms());
    }
    outcome
}

/// One `flightdeckd remove-phone --token -` round trip for `token` on `machine`, the
/// token on stdin, classified — and NOTHING written to the store: the caller decides
/// where an unconfirmed token waits for its retry ([`revoke_phone_on_machine`] queues
/// it on the paired machine; removing a server keeps a tombstone that outlives the
/// machine row, see `ipc::commands::delete_machine_core`). `Queued` here means "could
/// not reach it".
pub async fn remove_phone_from_daemon(
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    token: &str,
) -> RevokeOutcome {
    let cmd = format!("{} remove-phone --token -", resolve_daemon_bin_expr("flightdeckd"));
    match run_phone_reply(machine, known_hosts, &cmd, token.as_bytes()).await {
        Ok(DaemonReply::Ok { .. }) => RevokeOutcome::Removed,
        Ok(DaemonReply::Refused(reason)) => RevokeOutcome::Failed { reason },
        Ok(DaemonReply::TooOld) => RevokeOutcome::DaemonTooOld,
        Err(_unreachable) => RevokeOutcome::Queued,
    }
}

/// Whether `live` (a paired server) is the same server as `removed` (a tombstone's
/// record): the same daemon identity when both know it, or the same login coordinates.
fn same_server(live: &MachineRecord, removed: &MachineRecord) -> bool {
    (live.daemon_mac_id.is_some() && live.daemon_mac_id == removed.daemon_mac_id)
        || (live.host == removed.host && live.port == removed.port && live.user == removed.user)
}

/// Retries every phone token a REMOVED server may still accept (security review M10 —
/// the tombstones `Store::retire_machine_with_revocations` keeps), run at each launch.
/// A token confirmed gone is forgotten; one still unconfirmed waits for the next
/// launch; a server that can't be reached this time is not dialed again for its other
/// tokens. A tombstone holding the CURRENT token of a server that was paired again
/// since is dropped WITHOUT a revoke — its live row owns that token now, and revoking
/// it would cut the phone off a server the user wants. Returns the removed records with
/// no tombstone left, so the caller can delete the key it kept to reach them.
pub async fn retry_removed_server_revocations(store: &Store, known_hosts: Option<&str>) -> Vec<MachineRecord> {
    let tombstones = match store.removed_server_revocations() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[provision] could not read removed-server revocations: {e}");
            return Vec::new();
        }
    };
    if tombstones.is_empty() {
        return Vec::new();
    }
    let current = crate::ipc::commands::load_remote_config(store).phone_token;
    let live = store.all_machines().unwrap_or_default();
    let mut unreachable: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut removed = 0usize;
    for t in &tombstones {
        if t.token == current && live.iter().any(|m| same_server(m, &t.machine)) {
            let _ = store.clear_removed_server_revocation(&t.machine.id, &t.token);
            continue;
        }
        if unreachable.contains(&t.machine.id) {
            continue;
        }
        match remove_phone_from_daemon(known_hosts, &t.machine, &t.token).await {
            RevokeOutcome::Removed => {
                removed += 1;
                let _ = store.clear_removed_server_revocation(&t.machine.id, &t.token);
            }
            RevokeOutcome::Queued => {
                unreachable.insert(t.machine.id.clone());
            }
            RevokeOutcome::DaemonTooOld | RevokeOutcome::Failed { .. } => {}
        }
    }
    let remaining = store.removed_server_revocations().unwrap_or_else(|_| tombstones.clone());
    let mut done: Vec<MachineRecord> = Vec::new();
    for t in tombstones {
        if !remaining.iter().any(|r| r.machine.id == t.machine.id) && !done.iter().any(|m| m.id == t.machine.id) {
            done.push(t.machine);
        }
    }
    eprintln!(
        "[provision] removed servers: {removed} phone token(s) withdrawn, {} server(s) settled, {} still pending",
        done.len(),
        remaining.len()
    );
    done
}

/// [`revoke_phone_on_machine`] on every server this token was ever provisioned to
/// (`phone_provisioned_at.is_some()` — a machine never provisioned never had this
/// token authorized, so there is nothing to revoke and no reason to pay an ssh
/// round trip against it on every pairing regeneration). Used by the
/// `set_remote`/regenerate-pairing critical fix (C10) to make sure a lost phone's
/// old token is forgotten by every daemon it could still reach, not just the
/// Mac's own relay connection.
pub async fn revoke_phone_on_all_machines(
    store: &Store,
    known_hosts: Option<&str>,
    token: &str,
) -> Vec<(String, RevokeOutcome)> {
    let machines = store.all_machines().unwrap_or_default();
    let mut results = Vec::with_capacity(machines.len());
    for m in machines {
        if m.phone_provisioned_at.is_none() {
            continue;
        }
        let outcome = revoke_phone_on_machine(store, known_hosts, &m, token).await;
        results.push((m.id.clone(), outcome));
    }
    results
}

/// Retries every phone token still queued for `machine`'s revocation (see
/// [`revoke_phone_on_machine`]'s `Queued` case). Called from
/// [`provision_phone_on_machine`] right after a successful `add-phone` round
/// trip — that success IS the "next successful contact" the queue is waiting
/// for. A token that fails again (refused / too old / still unreachable) is
/// left queued (or re-queued, idempotently) rather than dropped.
async fn drain_pending_daemon_revocations(store: &Store, known_hosts: Option<&str>, machine: &MachineRecord) {
    let pending = store.pending_daemon_phone_revocations(&machine.id).unwrap_or_default();
    for token in pending {
        let _ = revoke_phone_on_machine(store, known_hosts, machine, &token).await;
    }
}

/// Shared fake-`ssh` test harness (C10) — `pub(crate)` so BOTH this module's own
/// tests AND `ipc::commands`'s `delete_machine` test (the other C10 code path
/// that talks to a daemon over ssh) use the SAME lock and env vars, never two
/// independent ones that could race each other over the same process-global
/// state. `#[cfg(test)]` compiles it in for every test binary of this crate,
/// which is what makes it reachable from a sibling module's own test code.
#[cfg(test)]
pub(crate) mod test_support {
    use crate::store::MachineRecord;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    // ---- fake `ssh` test harness ----------------------------------------------
    //
    // Points `keyed_ssh_options` at a fake `ssh` script via `TOSSE_TEST_SSH_BIN`
    // (an ABSOLUTE path — see that function's doc), NEVER by prepending to the
    // process-wide `PATH`. An earlier version of this harness mutated `PATH`
    // instead, and under a full-suite `cargo test --lib` (many modules' tests
    // running concurrently in one binary) that redirected every OTHER test's own
    // `ssh`/`ssh-keygen` spawn too — caught by
    // `bootstrap::askpass::run_with_password_reports_host_unreachable_against_a_real_closed_port`
    // starting to fail although this module's own tests all passed in isolation.
    // `TOSSE_TEST_SSH_BIN` is read ONLY inside `keyed_ssh_options`, so it is a
    // no-op for every code path that isn't this harness's own.

    /// Serializes every test (in THIS module or `ipc::commands`) that sets
    /// `TOSSE_TEST_SSH_BIN` / `FAKE_SSH_*` — still process-global env vars, so
    /// two such tests running at once would race on which fake script (and
    /// canned answers) wins. No OTHER test in this crate reads either of those
    /// var names, so this lock only needs to guard against races among the tests
    /// that use THIS harness.
    static PATH_LOCK: Mutex<()> = Mutex::new(());

    /// A POSIX-shell `ssh` stand-in, installed at `<dir>/ssh` and torn down (dir
    /// removed) on drop. It answers every real ssh call C10's code makes —
    /// every one of them ends in exactly one remote subcommand
    /// (`whoami` / `add-phone` / `remove-phone`) — by matching that word in the
    /// LAST argv element (the remote command string `keyed_ssh_options`'s callers
    /// append) — `remove-phone --init-minted` (the init-token cleanup) is told apart
    /// from a plain `remove-phone` by its flag, matched first — so it stands in for
    /// the whole "keyed ssh" path without needing to
    /// understand any of ssh's own flags (`-p`, `-o BatchMode=yes`, …). It ALWAYS
    /// logs its full argv (so a test can assert a secret token is NOWHERE in it)
    /// and drains + logs stdin (so a test can assert the token WAS delivered
    /// there instead) via env vars the test sets before spawning — and, when
    /// `FAKE_SSH_CALL_LOG` is set, appends one line per call (its whole argv), so a
    /// test can count the calls a pass over several servers made.
    struct FakeSsh {
        dir: std::path::PathBuf,
    }

    impl FakeSsh {
        fn install(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tosse-fakessh-{tag}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let script = "#!/bin/sh
cmd=\"$*\"
if [ -n \"$FAKE_SSH_ARGV_LOG\" ]; then
  printf '%s\\n' \"$@\" > \"$FAKE_SSH_ARGV_LOG\"
fi
if [ -n \"$FAKE_SSH_CALL_LOG\" ]; then
  printf '%s\\n' \"$cmd\" >> \"$FAKE_SSH_CALL_LOG\"
fi
if [ -n \"$FAKE_SSH_STDIN_LOG\" ]; then
  cat > \"$FAKE_SSH_STDIN_LOG\"
else
  cat > /dev/null
fi
case \"$cmd\" in
  *whoami*)
    out=\"$FAKE_SSH_WHOAMI_OUT\"; ec=\"$FAKE_SSH_WHOAMI_EXIT\"; err=\"$FAKE_SSH_WHOAMI_ERR\" ;;
  *add-phone*)
    out=\"$FAKE_SSH_ADDPHONE_OUT\"; ec=\"$FAKE_SSH_ADDPHONE_EXIT\"; err=\"$FAKE_SSH_ADDPHONE_ERR\" ;;
  *--init-minted*)
    out=\"$FAKE_SSH_INITCLEAN_OUT\"; ec=\"$FAKE_SSH_INITCLEAN_EXIT\"; err=\"$FAKE_SSH_INITCLEAN_ERR\" ;;
  *remove-phone*)
    out=\"$FAKE_SSH_REMOVEPHONE_OUT\"; ec=\"$FAKE_SSH_REMOVEPHONE_EXIT\"; err=\"$FAKE_SSH_REMOVEPHONE_ERR\" ;;
  *)
    exit 7 ;;
esac
[ -z \"$out\" ] && out='{}'
[ -z \"$ec\" ] && ec=0
[ -n \"$err\" ] && printf '%s' \"$err\" >&2
printf '%s' \"$out\"
exit \"$ec\"
";
            let path = dir.join("ssh");
            std::fs::write(&path, script).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
            Self { dir }
        }
    }

    impl Drop for FakeSsh {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// Every `FAKE_SSH_*` env var a test can set — reset around each test (see
    /// [`PathGuard`]) so ONE test's answer/exit-code for, say, `whoami` can never
    /// leak into the NEXT test that never mentions `whoami` at all. Env vars are
    /// process-global and `cargo test` does not reset them between tests, so
    /// without this a test that forgets to override every var it doesn't care
    /// about would silently inherit a previous test's leftovers instead of this
    /// script's own documented "unset → `{}` / exit 0" default.
    const FAKE_SSH_VARS: &[&str] = &[
        "FAKE_SSH_ARGV_LOG",
        "FAKE_SSH_CALL_LOG",
        "FAKE_SSH_STDIN_LOG",
        "FAKE_SSH_WHOAMI_OUT",
        "FAKE_SSH_WHOAMI_EXIT",
        "FAKE_SSH_WHOAMI_ERR",
        "FAKE_SSH_ADDPHONE_OUT",
        "FAKE_SSH_ADDPHONE_EXIT",
        "FAKE_SSH_ADDPHONE_ERR",
        "FAKE_SSH_REMOVEPHONE_OUT",
        "FAKE_SSH_REMOVEPHONE_EXIT",
        "FAKE_SSH_REMOVEPHONE_ERR",
        "FAKE_SSH_INITCLEAN_OUT",
        "FAKE_SSH_INITCLEAN_EXIT",
        "FAKE_SSH_INITCLEAN_ERR",
    ];

    /// Holds [`PATH_LOCK`] and a live `TOSSE_TEST_SSH_BIN` override (pointed at a
    /// fresh [`FakeSsh`]) for its whole lifetime, clearing both — and releasing
    /// the lock — on drop, panic included. Also clears every [`FAKE_SSH_VARS`]
    /// entry on both install and drop, so each test starts from (and leaves
    /// behind) a clean slate regardless of what ran before or after it. `PATH`
    /// itself is never touched (see the harness's module doc above).
    pub(crate) struct PathGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        _fake: FakeSsh,
    }

    impl PathGuard {
        pub(crate) fn install(tag: &str) -> Self {
            let lock = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            for var in FAKE_SSH_VARS {
                std::env::remove_var(var);
            }
            let fake = FakeSsh::install(tag);
            crate::ipc::commands::TEST_SSH_BIN
                .with(|b| *b.borrow_mut() = Some(fake.dir.join("ssh").to_string_lossy().into_owned()));
            Self { _lock: lock, _fake: fake }
        }
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
            for var in FAKE_SSH_VARS {
                std::env::remove_var(var);
            }
        }
    }

    /// A minimal, uniform [`MachineRecord`] for tests — `127.0.0.1`/`tester`
    /// (never dialed for real; [`PathGuard`] redirects `ssh` to [`FakeSsh`]).
    pub(crate) fn machine(id: &str) -> MachineRecord {
        MachineRecord {
            id: id.to_string(),
            label: id.to_string(),
            host: "127.0.0.1".into(),
            port: 22,
            user: "tester".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_support::{machine, PathGuard};

    fn read_lines(path: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    // ---- parse_daemon_reply (pure) ---------------------------------------------

    #[test]
    fn parses_the_three_daemon_reply_shapes_from_the_brief() {
        assert_eq!(
            parse_daemon_reply(r#"{"type":"fd_phone_added","ok":true,"added":true}"#),
            Some(DaemonReply::Ok { changed: true })
        );
        assert_eq!(
            parse_daemon_reply(r#"{"type":"fd_phone_removed","ok":true,"removed":false}"#),
            Some(DaemonReply::Ok { changed: false }),
            "removed:false (token wasn't there) is still a successful round trip"
        );
        assert_eq!(
            parse_daemon_reply(r#"{"ok":false,"error":"too many authorized phones (max 32) — remove one first"}"#),
            Some(DaemonReply::Refused(
                "too many authorized phones (max 32) — remove one first".to_string()
            )),
            "the daemon's own wording must survive verbatim"
        );
        assert_eq!(
            parse_daemon_reply(r#"{"type":"fd_detach","reason":"error","message":"missing attach, status or stop"}"#),
            Some(DaemonReply::TooOld)
        );
        assert_eq!(parse_daemon_reply("not json"), None);
        assert_eq!(parse_daemon_reply(""), None);
    }

    // ---- RevokeRegistry (pure) --------------------------------------------------

    /// Review fix coverage: `RevokeRegistry` is the observable place a
    /// per-machine revoke outcome lands instead of being discarded by
    /// `set_remote`'s background sweep — a later `record` for the same machine
    /// replaces the row (the latest outcome always wins), and a machine never
    /// recorded is simply absent, not a fabricated "ok" entry.
    #[test]
    fn revoke_registry_records_the_latest_outcome_per_machine() {
        let registry = RevokeRegistry::new();
        assert_eq!(registry.all(), Vec::<MachineRevokeStatus>::new());

        registry.record("m1", RevokeOutcome::Queued);
        registry.record("m2", RevokeOutcome::Removed);
        let mut all = registry.all();
        all.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].machine_id, "m1");
        assert_eq!(all[0].outcome, RevokeOutcome::Queued);
        assert_eq!(all[1].machine_id, "m2");
        assert_eq!(all[1].outcome, RevokeOutcome::Removed);

        // A later outcome for the SAME machine replaces the row, not accumulates.
        registry.record("m1", RevokeOutcome::Removed);
        let row = registry.all().into_iter().find(|r| r.machine_id == "m1").unwrap();
        assert_eq!(row.outcome, RevokeOutcome::Removed);
    }

    // ---- provision_phone_on_machine --------------------------------------------

    /// The full happy-path provision flow against a fake daemon: `whoami`
    /// attaches the C8 identity fields, then `add-phone` succeeds and stamps
    /// `phone_provisioned_at` — the "4 C8 fields + timestamp stored" case from
    /// the brief. Also the STDIN-not-argv assertion: the phone token must appear
    /// on stdin and NOWHERE in the recorded argv.
    #[tokio::test]
    async fn provision_success_stores_identity_and_timestamp_token_never_in_argv() {
        let _guard = PathGuard::install("provision-ok");
        let argv_log = std::env::temp_dir().join(format!("fakessh-argv-{}", uuid::Uuid::new_v4()));
        let stdin_log = std::env::temp_dir().join(format!("fakessh-stdin-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FAKE_SSH_ARGV_LOG", &argv_log);
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var(
            "FAKE_SSH_WHOAMI_OUT",
            r#"{"mac_id":"mac-abc","relay_url":"https://relay.example/","label":"josty-cc"}"#,
        );
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "super-secret-phone-token").unwrap();
        store.set_config("remote_mac_label", "MacBook Pro").unwrap();
        // Already cleaned of `init`'s token, so add-phone stays the last call (the
        // cleanup round trip has its own tests below).
        store.set_machine_init_phone_cleaned_at("m1", Some(1)).unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }));

        let got = store.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(got.daemon_mac_id.as_deref(), Some("mac-abc"));
        assert_eq!(got.daemon_relay_url.as_deref(), Some("https://relay.example/"));
        assert_eq!(got.daemon_label.as_deref(), Some("josty-cc"));
        assert!(got.phone_provisioned_at.is_some(), "phone_provisioned_at must be stamped");

        // The LAST ssh call made is add-phone (whoami runs first) — its argv is
        // what's left on disk once both calls have overwritten the same log path
        // in sequence, so assert against the stdin/argv of THAT call.
        let stdin = std::fs::read_to_string(&stdin_log).unwrap();
        assert_eq!(stdin, "super-secret-phone-token", "the token must be delivered on stdin");
        let argv = read_lines(&argv_log);
        assert!(
            argv.iter().all(|a| !a.contains("super-secret-phone-token")),
            "the token must NEVER appear in argv: {argv:?}"
        );
        assert!(
            argv.iter().any(|a| a.contains("add-phone --token -")),
            "the remote command must request the token on stdin: {argv:?}"
        );

        std::fs::remove_file(&argv_log).ok();
        std::fs::remove_file(&stdin_log).ok();
    }

    /// The 33rd-token refusal (or any `ok:false`) is surfaced verbatim, not
    /// paraphrased, and does NOT stamp `phone_provisioned_at`.
    #[tokio::test]
    async fn provision_surfaces_the_daemons_refusal_reason_verbatim() {
        let _guard = PathGuard::install("provision-refused");
        std::env::set_var("FAKE_SSH_WHOAMI_OUT", "");
        std::env::set_var(
            "FAKE_SSH_ADDPHONE_OUT",
            r#"{"ok":false,"error":"too many authorized phones (max 32) — remove one first"}"#,
        );

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert_eq!(
            state,
            ProvisionState::Failed {
                reason: "too many authorized phones (max 32) — remove one first".to_string()
            }
        );
        assert!(store.machine_by_id("m1").unwrap().unwrap().phone_provisioned_at.is_none());
    }

    /// An OLD daemon (predates phone support) answers `fd_detach` on `add-phone`
    /// — surfaced as `DaemonTooOld`, distinct from a generic failure.
    #[tokio::test]
    async fn provision_recognizes_an_old_daemons_fd_detach_as_daemon_too_old() {
        let _guard = PathGuard::install("provision-too-old");
        std::env::set_var("FAKE_SSH_WHOAMI_OUT", "");
        std::env::set_var(
            "FAKE_SSH_ADDPHONE_OUT",
            r#"{"type":"fd_detach","reason":"error","message":"missing attach, status or stop"}"#,
        );

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert_eq!(state, ProvisionState::DaemonTooOld);
    }

    /// `whoami` failing outright (unreachable / pre-C8 daemon) must not by itself
    /// stop provisioning — `add-phone` still runs and its own outcome wins.
    #[tokio::test]
    async fn provision_proceeds_to_add_phone_even_when_whoami_fails() {
        let _guard = PathGuard::install("provision-whoami-fails");
        std::env::set_var("FAKE_SSH_WHOAMI_EXIT", "1");
        std::env::set_var("FAKE_SSH_WHOAMI_OUT", "");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }));
        let got = store.machine_by_id("m1").unwrap().unwrap();
        assert!(got.daemon_mac_id.is_none(), "whoami never answered, so no identity to attach");
    }

    /// The real incident (CRM `c9bf1482`): this Mac's key removed from a real
    /// server's `authorized_keys`, and ssh's raw stderr line
    /// (`josty@100.97.14.57: Permission denied (publickey,password).`) used to leak
    /// straight into this phone-provisioning status row. Must now come back as
    /// `ssh_link::describe`'s classified sentence instead.
    #[tokio::test]
    async fn provision_classifies_a_key_refused_ssh_failure_instead_of_leaking_the_raw_line() {
        let _guard = PathGuard::install("provision-key-refused");
        std::env::set_var("FAKE_SSH_WHOAMI_EXIT", "255");
        std::env::set_var("FAKE_SSH_WHOAMI_ERR", "josty@100.97.14.57: Permission denied (publickey,password).");
        std::env::set_var("FAKE_SSH_ADDPHONE_EXIT", "255");
        std::env::set_var("FAKE_SSH_ADDPHONE_ERR", "josty@100.97.14.57: Permission denied (publickey,password).");

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert_eq!(
            state,
            ProvisionState::Failed { reason: "this Mac's saved key was refused by this server".to_string() },
        );
    }

    #[tokio::test]
    async fn provision_on_unknown_machine_id_errors() {
        let _guard = PathGuard::install("provision-unknown");
        let store = Store::open_in_memory().unwrap();
        let err = provision_phone_on_machine(&store, None, "does-not-exist").await.unwrap_err();
        assert!(err.contains("unknown server"));
    }

    #[tokio::test]
    async fn provision_all_machines_visits_every_paired_server() {
        let _guard = PathGuard::install("provision-all");
        std::env::set_var("FAKE_SSH_WHOAMI_OUT", "");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.upsert_machine(&machine("m2")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();

        let results = provision_phone_on_all_machines(&store, None).await;
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| matches!(r.state, ProvisionState::Provisioned { .. })));
        assert_eq!(
            results.iter().map(|r| r.machine_id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"]
        );
    }

    // ---- the init-token cleanup ------------------------------------------------

    /// Exactly what flightdeckd 0.2.0 (clap 4.6.6) prints for the flag it does not
    /// know — captured from a real build of the daemon before the flag existed.
    const OLD_DAEMON_USAGE_ERROR: &str = "error: unexpected argument '--init-minted' found\n\n\
        Usage: flightdeckd remove-phone [OPTIONS] --token <-|TOKEN>\n\n\
        For more information, try '--help'.\n";

    #[test]
    fn parses_every_answer_to_the_init_token_cleanup() {
        use InitTokenCleanup::*;
        let ok = |removed: u64| format!(r#"{{"type":"fd_init_phone_removed","ok":true,"removed":{removed}}}"#);
        assert_eq!(parse_init_cleanup_reply(&ok(1), "", Some(0)), Done { removed: 1 });
        assert_eq!(parse_init_cleanup_reply(&format!("{}\n", ok(0)), "", Some(0)), Done { removed: 0 });

        // An older daemon: the usage error, exit 2 — and only that combination.
        assert_eq!(parse_init_cleanup_reply("", OLD_DAEMON_USAGE_ERROR, Some(2)), Unsupported);
        assert!(matches!(parse_init_cleanup_reply("", OLD_DAEMON_USAGE_ERROR, Some(1)), Failed(_)));
        assert!(matches!(
            parse_init_cleanup_reply("", "error: unexpected argument '--keep' found", Some(2)),
            Failed(_)
        ));

        // The daemon's own refusals, verbatim from its stderr.
        let still_old = "Error: the running flightdeckd predates `remove-phone --init-minted` — restart it on \
                         this binary (missing attach, status, stop, add_phone or remove_phone)";
        assert_eq!(parse_init_cleanup_reply("", still_old, Some(1)), Failed(still_old.to_string()));
        let refused = "Error: the phone token to keep is not authorized on this node";
        assert_eq!(parse_init_cleanup_reply("", &format!("{refused}\n"), Some(1)), Failed(refused.to_string()));
        // A CLI error with its cause (verbatim from the 0.3.0 binary, no daemon
        // running): what failed, not the bare root cause.
        let not_running = "Error: flightdeckd is not running (no socket at /home/u/.flightdeckd/flightdeckd.sock)\n\n\
                           Caused by:\n    No such file or directory (os error 2)\n";
        assert_eq!(
            parse_init_cleanup_reply("", not_running, Some(1)),
            Failed("Error: flightdeckd is not running (no socket at /home/u/.flightdeckd/flightdeckd.sock)".to_string())
        );
        assert_eq!(
            parse_init_cleanup_reply(
                "",
                "josty@100.97.14.57: Permission denied (publickey,password).",
                Some(255)
            ),
            Failed("this Mac's saved key was refused by this server".to_string()),
            "ssh's own failures are classified, as for add-phone"
        );

        // Only this request's exact success line counts as done.
        for not_ours in [
            r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#,
            r#"{"type":"fd_init_phone_removed","ok":true}"#,
            r#"{"type":"fd_init_phone_removed","ok":false,"removed":1}"#,
            "{}",
            "",
        ] {
            assert!(matches!(parse_init_cleanup_reply(not_ours, "", Some(0)), Failed(_)), "{not_ours}");
        }
    }

    #[test]
    fn the_cleanup_runs_only_after_this_macs_token_is_authorized_and_until_it_succeeds() {
        let provisioned = ProvisionState::Provisioned { at_ms: 1 };
        assert!(init_token_cleanup_due(&provisioned, None));
        assert!(!init_token_cleanup_due(&provisioned, Some(5)), "once per server");
        for not_provisioned in [
            ProvisionState::Pending,
            ProvisionState::DaemonTooOld,
            ProvisionState::Failed { reason: "x".into() },
        ] {
            assert!(!init_token_cleanup_due(&not_provisioned, None), "{not_provisioned:?}");
        }
    }

    #[test]
    fn the_cleanup_log_line_carries_a_count_or_a_reason() {
        assert_eq!(
            init_cleanup_log_line("vps", &InitTokenCleanup::Done { removed: 1 }),
            "[provision] vps: removed 1 phone token(s) minted by an older `flightdeckd init`"
        );
        assert!(init_cleanup_log_line("vps", &InitTokenCleanup::Unsupported).contains("once flightdeckd is updated"));
        assert!(init_cleanup_log_line("vps", &InitTokenCleanup::Failed("offline".into()))
            .contains("not done (offline) — it runs again at the next launch, daemon restart or provisioning"));
    }

    #[test]
    fn outside_a_provisioning_the_cleanup_runs_only_where_this_macs_token_was_provisioned() {
        // (remote access on, token minted, provisioned at, cleaned at) → due
        assert!(init_cleanup_due_on_paired_server(true, "tok", Some(1), None));
        assert!(!init_cleanup_due_on_paired_server(true, "tok", Some(1), Some(2)), "once per server");
        assert!(!init_cleanup_due_on_paired_server(true, "tok", None, None), "never provisioned: --keep is refused");
        assert!(!init_cleanup_due_on_paired_server(false, "tok", Some(1), None), "remote access off");
        assert!(!init_cleanup_due_on_paired_server(true, "", Some(1), None), "no token to keep");
    }

    #[test]
    fn only_another_daemon_re_arms_the_cleanup() {
        assert!(another_daemon_answers(Some("old-node"), "new-node"));
        assert!(!another_daemon_answers(Some("node"), "node"));
        assert!(!another_daemon_answers(None, "node"), "first provisioning: nothing recorded yet");
    }

    fn provisioning_store(token: &str) -> Store {
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", token).unwrap();
        store
    }

    /// After add-phone succeeds, the cleanup runs with THIS Mac's current token on
    /// stdin (never argv), is recorded, and is not run again on that server.
    #[tokio::test]
    async fn provisioning_cleans_the_init_token_once_with_the_current_token_on_stdin() {
        let _guard = PathGuard::install("init-clean-ok");
        let argv_log = std::env::temp_dir().join(format!("fakessh-argv-{}", uuid::Uuid::new_v4()));
        let stdin_log = std::env::temp_dir().join(format!("fakessh-stdin-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FAKE_SSH_ARGV_LOG", &argv_log);
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":false}"#);
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", r#"{"type":"fd_init_phone_removed","ok":true,"removed":1}"#);
        let store = provisioning_store("current-phone-token");

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }));
        // The cleanup was the last call.
        let argv = read_lines(&argv_log);
        assert!(argv.iter().any(|a| a.contains("remove-phone --init-minted --keep -")), "{argv:?}");
        assert!(argv.iter().all(|a| !a.contains("current-phone-token")), "the token must never be in argv: {argv:?}");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap(), "current-phone-token", "--keep is this Mac's token");
        assert!(store.machine_init_phone_cleaned_at("m1").unwrap().is_some(), "recorded");

        // Next provisioning: add-phone only.
        std::fs::remove_file(&argv_log).ok();
        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }));
        let argv = read_lines(&argv_log);
        assert!(argv.iter().any(|a| a.contains("add-phone --token -")), "{argv:?}");
        assert!(argv.iter().all(|a| !a.contains("--init-minted")), "ran again: {argv:?}");

        std::fs::remove_file(&argv_log).ok();
        std::fs::remove_file(&stdin_log).ok();
    }

    /// An older daemon rejects the flag: provisioning still succeeds, nothing is
    /// recorded, and the cleanup succeeds at a provisioning after the update.
    #[tokio::test]
    async fn an_old_daemon_leaves_the_cleanup_for_after_its_update() {
        let _guard = PathGuard::install("init-clean-old");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);
        std::env::set_var("FAKE_SSH_INITCLEAN_EXIT", "2");
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", " ");
        std::env::set_var("FAKE_SSH_INITCLEAN_ERR", OLD_DAEMON_USAGE_ERROR);
        let store = provisioning_store("tok");

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }), "no user-facing error: {state:?}");
        assert_eq!(store.machine_init_phone_cleaned_at("m1").unwrap(), None);

        // flightdeckd updated.
        std::env::set_var("FAKE_SSH_INITCLEAN_EXIT", "0");
        std::env::set_var("FAKE_SSH_INITCLEAN_ERR", "");
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", r#"{"type":"fd_init_phone_removed","ok":true,"removed":1}"#);
        provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(store.machine_init_phone_cleaned_at("m1").unwrap().is_some());
    }

    /// Unreachable at cleanup time, or refused: the provisioning outcome is unchanged
    /// and the cleanup is left for a later provisioning.
    #[tokio::test]
    async fn a_failed_cleanup_never_changes_the_provisioning_outcome() {
        let _guard = PathGuard::install("init-clean-failed");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);
        let store = provisioning_store("tok");
        for (exit, err) in [
            ("255", "ssh: connect to host 127.0.0.1 port 22: Connection refused"),
            ("1", "Error: the phone token to keep is not authorized on this node"),
        ] {
            std::env::set_var("FAKE_SSH_INITCLEAN_EXIT", exit);
            std::env::set_var("FAKE_SSH_INITCLEAN_OUT", " ");
            std::env::set_var("FAKE_SSH_INITCLEAN_ERR", err);
            let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
            assert!(matches!(state, ProvisionState::Provisioned { .. }), "{err}: {state:?}");
            assert_eq!(store.machine_init_phone_cleaned_at("m1").unwrap(), None, "{err}");
        }
    }

    /// No cleanup unless add-phone succeeded: the daemon would refuse a `--keep` token
    /// it does not authorize, and a refused or old daemon has nothing to clean anyway.
    #[tokio::test]
    async fn no_cleanup_unless_add_phone_succeeded() {
        let _guard = PathGuard::install("init-clean-skipped");
        let argv_log = std::env::temp_dir().join(format!("fakessh-argv-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FAKE_SSH_ARGV_LOG", &argv_log);
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", r#"{"type":"fd_init_phone_removed","ok":true,"removed":1}"#);
        let store = provisioning_store("tok");
        for add_phone in [
            r#"{"ok":false,"error":"too many authorized phones (max 32) — remove one first"}"#,
            r#"{"type":"fd_detach","reason":"error","message":"missing attach, status or stop"}"#,
        ] {
            std::env::set_var("FAKE_SSH_ADDPHONE_OUT", add_phone);
            provision_phone_on_machine(&store, None, "m1").await.unwrap();
            let argv = read_lines(&argv_log);
            assert!(argv.iter().all(|a| !a.contains("--init-minted")), "{add_phone}: {argv:?}");
            assert_eq!(store.machine_init_phone_cleaned_at("m1").unwrap(), None);
        }
        std::fs::remove_file(&argv_log).ok();
    }

    const CLEANED: &str = r#"{"type":"fd_init_phone_removed","ok":true,"removed":1}"#;

    /// A paired server on its own port, so a call log tells servers apart.
    fn paired(store: &Store, id: &str, port: u16, provisioned: bool, cleaned: bool) {
        let mut m = machine(id);
        m.port = port;
        store.upsert_machine(&m).unwrap();
        if provisioned {
            store.set_machine_phone_provisioned_at(id, 1).unwrap();
        }
        if cleaned {
            store.set_machine_init_phone_cleaned_at(id, Some(1)).unwrap();
        }
    }

    fn remote_on_store(token: &str) -> Store {
        let store = Store::open_in_memory().unwrap();
        store.set_config("remote_enabled", "1").unwrap();
        store.set_config("remote_phone_token", token).unwrap();
        store
    }

    fn temp_log(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("fakessh-{tag}-{}", uuid::Uuid::new_v4()))
    }

    /// Already-paired servers are cleaned at launch, without a provisioning: only
    /// where this Mac's token was provisioned and the cleanup has not succeeded yet,
    /// one cleanup call per server (no whoami/add-phone), the token on stdin only —
    /// and once it succeeded, a later launch leaves the server alone.
    #[tokio::test]
    async fn the_launch_pass_cleans_already_paired_servers_once() {
        let _guard = PathGuard::install("init-clean-launch");
        let calls = temp_log("calls");
        let stdin_log = temp_log("stdin");
        std::env::set_var("FAKE_SSH_CALL_LOG", &calls);
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", CLEANED);
        let store = remote_on_store("current-phone-token");
        paired(&store, "due", 2201, true, false);
        paired(&store, "cleaned", 2202, true, true);
        paired(&store, "never-provisioned", 2203, false, false);

        assert_eq!(clean_init_phone_tokens_at_launch(&store, None).await, 1);
        let lines = read_lines(&calls);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("-p 2201") && lines[0].contains("remove-phone --init-minted --keep -"), "{lines:?}");
        assert!(!lines[0].contains("current-phone-token"), "the token must never be in argv: {lines:?}");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap(), "current-phone-token");
        assert!(store.machine_init_phone_cleaned_at("due").unwrap().is_some(), "recorded");
        assert_eq!(store.machine_init_phone_cleaned_at("never-provisioned").unwrap(), None);

        // The next launch: nothing left to do, no ssh at all.
        assert_eq!(clean_init_phone_tokens_at_launch(&store, None).await, 0);
        assert_eq!(read_lines(&calls).len(), 1);

        // Remote access off: no pass, even where it would be due.
        paired(&store, "due-later", 2204, true, false);
        store.set_config("remote_enabled", "0").unwrap();
        assert_eq!(clean_init_phone_tokens_at_launch(&store, None).await, 0);
        assert_eq!(read_lines(&calls).len(), 1);

        std::fs::remove_file(&calls).ok();
        std::fs::remove_file(&stdin_log).ok();
    }

    /// A server whose daemon is too old (or unreachable) is not recorded: the next
    /// launch tries again — once — and the one after its update succeeds.
    #[tokio::test]
    async fn the_launch_pass_retries_an_old_daemon_once_per_launch_until_it_is_updated() {
        let _guard = PathGuard::install("init-clean-launch-old");
        let calls = temp_log("calls");
        std::env::set_var("FAKE_SSH_CALL_LOG", &calls);
        std::env::set_var("FAKE_SSH_INITCLEAN_EXIT", "2");
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", " ");
        std::env::set_var("FAKE_SSH_INITCLEAN_ERR", OLD_DAEMON_USAGE_ERROR);
        let store = remote_on_store("tok");
        paired(&store, "m1", 2201, true, false);

        for launch in 1..=2 {
            assert_eq!(clean_init_phone_tokens_at_launch(&store, None).await, 1);
            assert_eq!(read_lines(&calls).len(), launch, "one attempt per launch");
            assert_eq!(store.machine_init_phone_cleaned_at("m1").unwrap(), None);
        }
        std::env::set_var("FAKE_SSH_INITCLEAN_EXIT", "0");
        std::env::set_var("FAKE_SSH_INITCLEAN_ERR", "");
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", CLEANED);
        assert_eq!(clean_init_phone_tokens_at_launch(&store, None).await, 1);
        assert!(store.machine_init_phone_cleaned_at("m1").unwrap().is_some());
        std::fs::remove_file(&calls).ok();
    }

    /// The trigger after a daemon restart: the cleanup alone, on that one server,
    /// only while it is due there.
    #[tokio::test]
    async fn after_a_daemon_restart_the_cleanup_runs_on_that_server_only_while_due() {
        let _guard = PathGuard::install("init-clean-restart");
        let calls = temp_log("calls");
        std::env::set_var("FAKE_SSH_CALL_LOG", &calls);
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", CLEANED);
        let store = remote_on_store("tok");
        paired(&store, "restarted", 2201, true, false);
        paired(&store, "other", 2202, true, false);
        paired(&store, "never-provisioned", 2203, false, false);

        assert_eq!(
            clean_init_phone_token_if_due(&store, None, "restarted").await,
            Some(InitTokenCleanup::Done { removed: 1 })
        );
        let lines = read_lines(&calls);
        assert_eq!(lines.len(), 1, "that server only: {lines:?}");
        assert!(lines[0].contains("-p 2201") && lines[0].contains("--init-minted"), "{lines:?}");
        assert!(store.machine_init_phone_cleaned_at("restarted").unwrap().is_some());
        assert_eq!(store.machine_init_phone_cleaned_at("other").unwrap(), None);

        // Not due any more / never provisioned / unknown: nothing runs.
        for id in ["restarted", "never-provisioned", "no-such-server"] {
            assert_eq!(clean_init_phone_token_if_due(&store, None, id).await, None, "{id}");
        }
        assert_eq!(read_lines(&calls).len(), 1);
        std::fs::remove_file(&calls).ok();
    }

    /// A server row whose daemon was replaced (reinstalled from scratch) gets the
    /// cleanup again; the same daemon answering does not.
    #[tokio::test]
    async fn a_replaced_daemon_re_arms_the_cleanup() {
        let _guard = PathGuard::install("init-clean-rearm");
        let calls = temp_log("calls");
        std::env::set_var("FAKE_SSH_CALL_LOG", &calls);
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":false}"#);
        std::env::set_var("FAKE_SSH_INITCLEAN_OUT", CLEANED);
        let store = provisioning_store("tok");
        store.set_machine_daemon_identity("m1", "node-1", "https://relay.example", "vps").unwrap();
        store.set_machine_init_phone_cleaned_at("m1", Some(1)).unwrap();
        let whoami = |node: &str| format!(r#"{{"mac_id":"{node}","relay_url":"https://relay.example","label":"vps"}}"#);
        let cleanups = || read_lines(&calls).iter().filter(|l| l.contains("--init-minted")).count();

        std::env::set_var("FAKE_SSH_WHOAMI_OUT", whoami("node-1"));
        provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert_eq!(cleanups(), 0, "same daemon: already cleaned");
        assert_eq!(store.machine_init_phone_cleaned_at("m1").unwrap(), Some(1));

        std::env::set_var("FAKE_SSH_WHOAMI_OUT", whoami("node-2"));
        provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert_eq!(cleanups(), 1, "another daemon: its init token was never cleaned");
        assert!(store.machine_init_phone_cleaned_at("m1").unwrap().is_some_and(|at| at > 1));
        assert_eq!(store.machine_by_id("m1").unwrap().unwrap().daemon_mac_id.as_deref(), Some("node-2"));
        std::fs::remove_file(&calls).ok();
    }

    // ---- revoke_phone_on_machine / revoke_phone_on_all_machines ----------------

    #[tokio::test]
    async fn revoke_removes_and_clears_any_queued_entry_for_the_same_token() {
        let _guard = PathGuard::install("revoke-ok");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        let m = machine("m1");
        store.upsert_machine(&m).unwrap();
        store.queue_daemon_phone_revocation("m1", "old-tok", 1).unwrap();

        let outcome = revoke_phone_on_machine(&store, None, &m, "old-tok").await;
        assert_eq!(outcome, RevokeOutcome::Removed);
        assert_eq!(store.pending_daemon_phone_revocations("m1").unwrap(), Vec::<String>::new());
    }

    /// An unreachable daemon at revoke time is queued, not treated as a hard
    /// failure — "retried on the next successful contact" (verified below via
    /// `provision_phone_on_machine` draining it).
    #[tokio::test]
    async fn revoke_queues_the_token_when_the_daemon_is_unreachable() {
        let _guard = PathGuard::install("revoke-unreachable");
        // Force ssh itself to fail (nonzero exit, no parseable JSON) — simulates
        // "could not connect" rather than a daemon-level refusal.
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "255");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", "");

        let store = Store::open_in_memory().unwrap();
        let m = machine("m1");
        store.upsert_machine(&m).unwrap();

        let outcome = revoke_phone_on_machine(&store, None, &m, "old-tok").await;
        assert_eq!(outcome, RevokeOutcome::Queued);
        assert_eq!(store.pending_daemon_phone_revocations("m1").unwrap(), vec!["old-tok".to_string()]);
    }

    /// Review fix: a REACHABLE daemon that explicitly refuses `remove-phone`
    /// (`ok:false`) must be queued for automatic retry too, not just the
    /// network-unreachable case — a reachable-but-refused daemon is exactly as
    /// real a case as `add-phone`'s own 33rd-token refusal, and leaving it
    /// un-queued would strand the old token with no automatic path back.
    #[tokio::test]
    async fn revoke_queues_the_token_when_the_daemon_reachably_refuses() {
        let _guard = PathGuard::install("revoke-refused");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"ok":false,"error":"disk full"}"#);

        let store = Store::open_in_memory().unwrap();
        let m = machine("m1");
        store.upsert_machine(&m).unwrap();

        let outcome = revoke_phone_on_machine(&store, None, &m, "old-tok").await;
        assert_eq!(outcome, RevokeOutcome::Failed { reason: "disk full".to_string() });
        assert_eq!(
            store.pending_daemon_phone_revocations("m1").unwrap(),
            vec!["old-tok".to_string()],
            "a reachable-but-refused revoke must still be queued for automatic retry"
        );
    }

    /// Same fix, for the `DaemonTooOld` case: a later `flightdeckd` update on
    /// that box should make the queued retry succeed for free.
    #[tokio::test]
    async fn revoke_queues_the_token_when_the_daemon_is_too_old() {
        let _guard = PathGuard::install("revoke-too-old");
        std::env::set_var(
            "FAKE_SSH_REMOVEPHONE_OUT",
            r#"{"type":"fd_detach","reason":"error","message":"missing attach, status or stop"}"#,
        );

        let store = Store::open_in_memory().unwrap();
        let m = machine("m1");
        store.upsert_machine(&m).unwrap();

        let outcome = revoke_phone_on_machine(&store, None, &m, "old-tok").await;
        assert_eq!(outcome, RevokeOutcome::DaemonTooOld);
        assert_eq!(
            store.pending_daemon_phone_revocations("m1").unwrap(),
            vec!["old-tok".to_string()],
            "a too-old daemon's revoke must still be queued for automatic retry"
        );
    }

    /// The core of C10's regression coverage: a queued (unreachable-at-the-time)
    /// daemon revocation is retried and cleared automatically the next time that
    /// machine is successfully provisioned — never a separate manual step.
    #[tokio::test]
    async fn a_queued_daemon_revocation_is_retried_on_the_next_successful_provision() {
        let _guard = PathGuard::install("revoke-retry");
        std::env::set_var("FAKE_SSH_WHOAMI_OUT", "");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", r#"{"type":"fd_phone_added","ok":true,"added":true}"#);
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine("m1")).unwrap();
        store.set_config("remote_phone_token", "current-tok").unwrap();
        store.queue_daemon_phone_revocation("m1", "stale-tok", 1).unwrap();

        let state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }));
        assert_eq!(
            store.pending_daemon_phone_revocations("m1").unwrap(),
            Vec::<String>::new(),
            "the queued revocation must have been drained by the successful contact"
        );
    }

    // ---- retry_removed_server_revocations (M10) -------------------------------

    fn retire(store: &Store, m: &MachineRecord, tokens: &[&str]) {
        store.upsert_machine(m).unwrap();
        let tokens: Vec<String> = tokens.iter().map(|t| t.to_string()).collect();
        store.retire_machine_with_revocations(m, &tokens, 1).unwrap();
    }

    #[tokio::test]
    async fn a_removed_servers_tombstones_are_retried_and_settled_once_confirmed() {
        let _guard = PathGuard::install("tombstone-ok");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);
        let store = Store::open_in_memory().unwrap();
        store.set_config("remote_phone_token", "current").unwrap();
        let mut gone = machine("gone");
        gone.identity_file = Some("/keys/gone".into());
        retire(&store, &gone, &["current", "older"]);

        let settled = retry_removed_server_revocations(&store, None).await;
        assert_eq!(settled.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gone"]);
        assert_eq!(settled[0].identity_file.as_deref(), Some("/keys/gone"), "the key it kept to reach it");
        assert!(store.removed_server_revocations().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_removed_server_keeps_every_tombstone_for_the_next_launch() {
        let _guard = PathGuard::install("tombstone-unreachable");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "255");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", "");
        let store = Store::open_in_memory().unwrap();
        store.set_config("remote_phone_token", "current").unwrap();
        retire(&store, &machine("gone"), &["current", "older"]);

        assert!(retry_removed_server_revocations(&store, None).await.is_empty());
        assert_eq!(store.removed_server_revocations().unwrap().len(), 2, "nothing dropped silently");
    }

    /// The server came back as a paired machine with the same pairing: its live row
    /// owns the current token now — revoking it would cut the phone off a server the
    /// user wants. An OLDER token is still withdrawn.
    #[tokio::test]
    async fn a_re_paired_server_keeps_the_current_token_and_loses_only_the_old_one() {
        let _guard = PathGuard::install("tombstone-repaired");
        let argv_log = std::env::temp_dir().join(format!("fakessh-argv-{}", uuid::Uuid::new_v4()));
        let stdin_log = std::env::temp_dir().join(format!("fakessh-stdin-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FAKE_SSH_ARGV_LOG", &argv_log);
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);
        let store = Store::open_in_memory().unwrap();
        store.set_config("remote_phone_token", "current").unwrap();
        retire(&store, &machine("old-row"), &["current"]);
        retire(&store, &machine("old-row-2"), &["older"]);
        // Paired again: a new row for the same login coordinates.
        store.upsert_machine(&machine("new-row")).unwrap();

        let settled = retry_removed_server_revocations(&store, None).await;
        assert_eq!(settled.len(), 2);
        assert!(store.removed_server_revocations().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap(), "older", "only the old token was sent to remove");
        std::fs::remove_file(&argv_log).ok();
        std::fs::remove_file(&stdin_log).ok();
    }

    #[tokio::test]
    async fn revoke_all_machines_skips_servers_never_provisioned() {
        let _guard = PathGuard::install("revoke-all-skip");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        let mut provisioned = machine("m1");
        provisioned.phone_provisioned_at = Some(1);
        store.upsert_machine(&provisioned).unwrap();
        store.upsert_machine(&machine("m2")).unwrap(); // never provisioned

        let results = revoke_phone_on_all_machines(&store, None, "old-tok").await;
        assert_eq!(
            results,
            vec![("m1".to_string(), RevokeOutcome::Removed)],
            "m2 was never provisioned, so it must not be contacted"
        );
    }

    /// C10's critical fix, end to end at the `Store`/ssh layer: regenerating a
    /// pairing must reach EVERY provisioned daemon, not just one — the
    /// daemon-side half of "revoked everywhere it was ever authorized".
    #[tokio::test]
    async fn revoke_all_machines_contacts_every_provisioned_server() {
        let _guard = PathGuard::install("revoke-all-multi");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        for id in ["m1", "m2", "m3"] {
            let mut m = machine(id);
            m.phone_provisioned_at = Some(1);
            store.upsert_machine(&m).unwrap();
        }

        let results = revoke_phone_on_all_machines(&store, None, "old-tok").await;
        assert_eq!(
            results,
            vec![
                ("m1".to_string(), RevokeOutcome::Removed),
                ("m2".to_string(), RevokeOutcome::Removed),
                ("m3".to_string(), RevokeOutcome::Removed),
            ]
        );
    }

    /// The old phone token must never surface in any error/log string this
    /// module produces — the only place it is ever written is the daemon's own
    /// stdin (asserted directly in `provision_success_…`/`delete_machine_core_…`
    /// above) and the pending-revocation queue rows. This exercises every
    /// FAILURE path (unparsable ssh output, a hard ssh error) and asserts the
    /// token is absent from every `ProvisionState`/`RevokeOutcome` produced —
    /// the "grep for the token" regression the C10 brief asks for, run against
    /// this module's actual error surfaces rather than the source text.
    #[tokio::test]
    async fn the_phone_token_never_appears_in_any_produced_error_state() {
        let _guard = PathGuard::install("token-secrecy");
        let token = "super-secret-phone-token-should-never-leak";
        std::env::set_var("FAKE_SSH_WHOAMI_EXIT", "1");
        std::env::set_var("FAKE_SSH_ADDPHONE_EXIT", "1");
        std::env::set_var("FAKE_SSH_ADDPHONE_OUT", "garbled, not json");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "1");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", "garbled, not json");

        let store = Store::open_in_memory().unwrap();
        let m = machine("m1");
        store.upsert_machine(&m).unwrap();
        store.set_config("remote_phone_token", token).unwrap();

        let provision_state = provision_phone_on_machine(&store, None, "m1").await.unwrap();
        assert!(
            !format!("{provision_state:?}").contains(token),
            "provision outcome leaked the token: {provision_state:?}"
        );

        let revoke_outcome = revoke_phone_on_machine(&store, None, &m, token).await;
        assert!(
            !format!("{revoke_outcome:?}").contains(token),
            "revoke outcome leaked the token: {revoke_outcome:?}"
        );

        // The pending-revocation queue is the one place the token IS persisted in
        // clear (documented, deliberate — see `Store::queue_daemon_phone_revocation`'s
        // doc) so an unreachable daemon can still be retried later; confirm it
        // landed ONLY there, not duplicated into some other column/log-shaped field.
        assert_eq!(
            store.pending_daemon_phone_revocations("m1").unwrap(),
            vec![token.to_string()]
        );
    }

    // ---- LIVE (real network, real daemon) --------------------------------------

    /// The flightdeck-m1 container's connection details — the SAME ones
    /// `supervisor::session`'s own `#[ignore]`d live tests use (127.0.0.1:2224,
    /// `agent`, `~/.ssh/flightdeck_m0_ed25519`), so this doesn't invent a second
    /// convention for "the live dev daemon".
    fn live_m1() -> MachineRecord {
        MachineRecord {
            id: "live-m1".into(),
            label: "flightdeck-m1".into(),
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(format!(
                "{}/.ssh/flightdeck_m0_ed25519",
                std::env::var("HOME").unwrap_or_default()
            )),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    /// Counts `phone_tokens` entries in the m1 container's live
    /// `~/.flightdeckd/config.json` via a direct ssh call — deliberately NOT
    /// through this module's own helpers, so the count is an INDEPENDENT check
    /// of the daemon's real on-disk state, not a re-check of whatever this
    /// module itself just wrote. `grep -o … | wc -l` (not `grep -c`, which exits
    /// non-zero on a zero count and would make `run_ssh_on_machine` treat "no
    /// tokens at all" as a connection failure).
    async fn live_token_count(m: &MachineRecord, known_hosts: Option<&str>) -> usize {
        let out = run_ssh_on_machine(
            m,
            known_hosts,
            "grep -o '\"token\":' ~/.flightdeckd/config.json | wc -l",
        )
        .await
        .expect("could not read the m1 container's config.json over ssh");
        out.trim().parse().expect("wc -l must print a plain count")
    }

    /// LIVE, real-network test against the flightdeck-m1 container (flightdeckd
    /// 0.2.0) — the ONE test in this module that does NOT go through the
    /// fake-ssh harness. Provisions a THROWAWAY token, confirms the daemon's own
    /// on-disk token count went up by exactly one (an INDEPENDENT check, not a
    /// re-check of our own `Ok` result) and that `whoami`'s identity was really
    /// attached, then revokes it and confirms the count is back to where it
    /// started — proving the whole C10 pipeline (this module's
    /// `provision_phone_on_machine`/`revoke_phone_on_machine`, byte-for-byte the
    /// same code the fake-ssh tests above exercise) against a REAL daemon.
    /// Ignored by default — needs the container up
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored live_provision_and_revoke_round_trip_against_the_m1_container --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd (needs the flightdeck-m1 container)"]
    async fn live_provision_and_revoke_round_trip_against_the_m1_container() {
        let m1 = live_m1();
        let known_hosts = Some("/dev/null");
        let token = format!("tosse-live-test-{}", uuid::Uuid::new_v4());

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&m1).unwrap();
        store.set_config("remote_phone_token", &token).unwrap();
        store.set_config("remote_mac_label", "tosse-code live test").unwrap();
        // Never the init-token cleanup here: on a container running flightdeckd
        // >= 0.3.0 it would revoke the container's own pairing token for good.
        store.set_machine_init_phone_cleaned_at("live-m1", Some(1)).unwrap();

        let before = live_token_count(&m1, known_hosts).await;

        let state = provision_phone_on_machine(&store, known_hosts, "live-m1").await.unwrap();
        assert!(matches!(state, ProvisionState::Provisioned { .. }), "provision failed: {state:?}");
        let after_add = live_token_count(&m1, known_hosts).await;
        assert_eq!(after_add, before + 1, "the daemon's own token count must go up by exactly one");

        let got = store.machine_by_id("live-m1").unwrap().unwrap();
        assert!(got.daemon_mac_id.is_some(), "whoami must have attached the real identity");
        assert!(got.phone_provisioned_at.is_some());

        let outcome = revoke_phone_on_machine(&store, known_hosts, &m1, &token).await;
        assert_eq!(outcome, RevokeOutcome::Removed, "revoke outcome: {outcome:?}");
        let after_remove = live_token_count(&m1, known_hosts).await;
        assert_eq!(after_remove, before, "the token count must be back to where it started");
    }
}
