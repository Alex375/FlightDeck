//! B11 — one resumable bootstrap PIPELINE chaining every building block B4–C10 already
//! shipped as separate commands (`connect::install_key`, `connect::probe`,
//! `install::upload_daemon`, `install::install_service`, `install::
//! escalate_persistence`, `server_setup::run_init` + `claude auth status`,
//! `ipc::commands::add_machine`), plus a standalone health model (`diagnose`/`repair`)
//! a later wizard UI will read. No front UI lives here — this is the Rust orchestration
//! layer only.
//!
//! ## The pipeline (`bootstrap_server` / `bootstrap_resume` / `bootstrap_cancel`)
//!
//! Ten steps, always in this order: [`StepId::InstallKey`], [`StepId::Probe`],
//! [`StepId::InstallClaude`] (B14 — right after the probe: a server that cannot reach
//! `claude.ai` cannot run Claude Code at all, so this fails the whole pipeline EARLY
//! rather than limping through daemon install first only to fail later at
//! [`StepId::ClaudeAuth`]; skipped when the shared resolver already finds a working
//! `claude`), [`StepId::UploadDaemon`], [`StepId::RunInit`] (BEFORE the service:
//! `flightdeckd run` refuses to start without the `~/.flightdeckd/config.json` that
//! `init` writes, so a service started first crash-loops until its verification gives
//! up — found on the first real novice run), [`StepId::InstallService`],
//! [`StepId::EscalatePersistence`], [`StepId::ClaudeAuth`], [`StepId::AddMachine`],
//! [`StepId::Diagnose`] — see [`PIPELINE_ORDER`]. Every step is IDEMPOTENT — re-running
//! the whole pipeline against a half- or fully-installed server converges (every
//! already-satisfied step reports `Skipped`/`AlreadyCurrent`/`Adopted`, nothing already
//! correct is rewritten) — this is what makes "resume" as simple as "run the same
//! request again": there is no cursor to persist, only the request itself plus
//! whatever secret the paused step still needs.
//!
//! Two, DIFFERENT kinds of "this step needs more input" ([`StepOutcome`]):
//! - [`StepOutcome::NeedsInputBlocking`] — the step (today, only
//!   [`StepId::EscalatePersistence`] on [`BootstrapError::NeedsSudoPassword`]) cannot
//!   proceed at all without it. The WHOLE pipeline stops here, [`BootstrapReport::
//!   needs_input`] names the step, and the run stays registered in
//!   [`BootstrapSessions`] — resumable via `bootstrap_resume(session_id,
//!   sudo_password)`, which re-runs the SAME (idempotent) pipeline with the password
//!   now available. `bootstrap_cancel(session_id)` abandons it instead, dropping the
//!   session — and the password held inside it — entirely (see the module's own test).
//! - [`StepOutcome::NeedsInputContinue`] — the step itself didn't finish (today:
//!   [`StepId::ClaudeAuth`] answering "not logged in", or [`StepId::UploadDaemon`]'s
//!   own RESTART RULE below), but the REST of the pipeline still has useful work to do
//!   regardless, so it keeps going. The step's own [`StepStatus`] still reads
//!   `NeedsInput` in the report; the pipeline's overall `needs_input` stays `None`.
//!
//! ## RESTART RULE ([`StepId::UploadDaemon`])
//! When [`install::upload_daemon`] reports `Uploaded { restart_required: true }` (bytes
//! were written over a pre-existing binary), the daemon is restarted automatically
//! ONLY if a fresh `flightdeckd status` shows zero busy conversations right now
//! ([`fetch_busy_conversations`]) — never blind, never guessed from an "upload
//! succeeded" exit code. When it can't confirm that (busy > 0, or the count itself is
//! unknown, or the restart attempt itself fails — e.g. it would need a sudo password
//! this early in the pipeline, before [`StepId::EscalatePersistence`] has even asked
//! for one), the step becomes `NeedsInputContinue` and the pipeline moves on: the final
//! [`ServerDiagnosis::restart_pending`] flag and the explicit
//! [`RepairAction::RestartDaemon`] are what a caller uses to actually clear it, later,
//! outside the bootstrap flow.
//!
//! ## `diagnose` / `repair`
//! [`diagnose`] is ONE ssh round trip running an accumulating marker script (same
//! discipline as [`super::connect::probe_script`] / B8's `RESOLVE_DAEMON_TARGET_SCRIPT`
//! — every check runs regardless of any earlier one's outcome, so a broken server
//! reports every fact it CAN at once) whose pure parser ([`parse_diagnosis_fields`])
//! makes every sub-probe tri-state (`Option<bool>`/`Option<String>` — "unknown" on a
//! missing/garbled marker, never silently folded into "no"). [`collapse_state`] is the
//! one place that turns those independent facts into the single headline
//! [`DiagnosisState`] a caller actually acts on.
//!
//! [`repair`] is an EXHAUSTIVE match over [`RepairAction`] (no wildcard arm — a variant
//! added later without a matching arm fails to COMPILE, not just a test; see
//! [`repair_action_label`]) — each arm runs the one existing building block that fixes
//! it, then re-[`diagnose`]s so the caller always gets a fresh verdict, not a stale one
//! from before the fix. Deliberately takes an OPTIONAL sudo password beyond the brief's
//! own shorthand `repair(machine, RepairAction)` signature — [`RepairAction::
//! EnableLinger`]/[`RepairAction::MaskSleep`] reuse [`install::escalate_persistence`]
//! (which already needs one when passwordless `sudo` is unavailable), and
//! [`RepairAction::RestartDaemon`] can equally need one for a NON-root login that only
//! ADOPTED a pre-existing system unit (fixture C's shape) — recorded under
//! `deviations_from_brief`.
//!
//! ## No Keychain item (deliberate, per the brief)
//! Nothing here mints or reads a `mac_token` from Keychain — the daemon mints and
//! keeps its OWN relay identity server-side (`flightdeckd init`, see
//! [`super::server_setup::run_init`]) and `flightdeckd whoami` returns no secret. This
//! Mac's OWN command-line ssh key (the ONLY per-server secret this app manages) already
//! lives on disk under `ssh_keys/`, never in Keychain, unchanged by B11 — the plan's
//! "Keychain item for mac_token" idea is deliberately NOT implemented here. (This Mac's
//! OWN relay secrets are a different matter: sealed under a Keychain key by
//! `crate::secret_vault`.)
//!
//! ## Reused, not reinvented
//! Every ssh call ultimately goes through [`crate::ipc::commands::keyed_ssh_options`] /
//! [`crate::ipc::commands::run_ssh_on_machine`] / [`crate::ipc::commands::
//! run_ssh_on_machine_stdin`] — the crate's ONE ssh invoker (see `bootstrap::
//! server_setup`'s own module doc) — and the daemon-binary path resolution goes through
//! [`crate::ipc::commands::resolve_daemon_bin_expr`] (B11's OWN unification of what
//! used to be four independent copies of that same search — see that function's doc).
//! This module adds no second ssh path and no second binary-path search.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tokio::sync::Mutex;

use crate::platform::MACHINE;
use crate::bootstrap::askpass::{BootstrapError, SecretString};
use crate::bootstrap::{connect, install, server_setup, templates};
use crate::ipc::commands::{
    invalidate_daemon_version_cache, persist_paired_machine, probe_candidates, resolve_daemon_bin_expr,
    run_ssh_on_machine, run_ssh_on_machine_stdin, shq, RemoteProbeResult,
};
use crate::ssh_link::{self, SshLinkIssue};
use crate::store::{MachineRecord, Store};
use crate::tailscale;

/// Bounded timeout for a single ssh round trip this module makes OUTSIDE the
/// password/sudo flows (which already have their own, e.g. [`run_sudo`]'s 15s/30s) —
/// [`diagnose`], [`verify_key_works`], and the plain [`run_ssh_on_machine`] calls in
/// [`fetch_busy_conversations`]/[`run_plain`]. `ConnectTimeout=10` (baked into
/// [`crate::ipc::commands::keyed_ssh_options`]) only bounds the TCP/SSH HANDSHAKE, not
/// a remote shell that hangs after connecting (a stuck lock, a wedged `flightdeckd`) —
/// without this, `machine_diagnose`/the pipeline's own `Diagnose` step/the RESTART
/// RULE's busy check could hang the caller forever (B11 review finding).
///
/// `pub(crate)` (B14 fix round 3): [`crate::bootstrap::connect::probe`] and
/// [`crate::ipc::commands::probe_remote`] reuse this SAME bound for their own
/// `cmd.output()` round trips — a plain `claude --version`/`flightdeckd --version`
/// probe script is the same shape of remote command this already guards, and a wedged
/// shell there (e.g. the B14 broken-install check's own `claude --version`) must not
/// hang `step_probe`/`repair`/the "Add a server" pairing flow any more than a wedged
/// `diagnose` shell may hang this module's own callers.
pub(crate) const SSH_ROUND_TRIP_TIMEOUT: Duration = Duration::from_secs(20);

// ============================================================================
// Steps — ids, status, the generic (fake-step-testable) pipeline runner
// ============================================================================

/// One pipeline step, in the FIXED order [`build_pipeline`] always builds them —
/// see the module doc's overview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StepId {
    InstallKey,
    Probe,
    InstallClaude,
    UploadDaemon,
    RunInit,
    InstallService,
    EscalatePersistence,
    ClaudeAuth,
    AddMachine,
    Diagnose,
}

impl StepId {
    /// The exact wire spelling [`crate::ipc::events::BootstrapProgressStep::id`] uses —
    /// the ONE place that owns this text, so the event and a future front never drift.
    fn wire_str(self) -> &'static str {
        match self {
            Self::InstallKey => "install_key",
            Self::Probe => "probe",
            Self::InstallClaude => "install_claude",
            Self::UploadDaemon => "upload_daemon",
            Self::InstallService => "install_service",
            Self::EscalatePersistence => "escalate_persistence",
            Self::RunInit => "run_init",
            Self::ClaudeAuth => "claude_auth",
            Self::AddMachine => "add_machine",
            Self::Diagnose => "diagnose",
        }
    }
}

/// One step's status, as the brief specs it: `pending|running|ok|skipped|failed|
/// needs_input`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Ok,
    Skipped,
    Failed,
    NeedsInput,
}

impl StepStatus {
    /// See [`StepId::wire_str`] — same discipline, same reason.
    fn wire_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::NeedsInput => "needs_input",
        }
    }
}

/// One step's current/final state, as carried on [`BootstrapReport`] and (via
/// [`StepState::to_wire`]) on every [`crate::ipc::events::BootstrapProgressEvent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StepState {
    pub id: StepId,
    pub status: StepStatus,
    pub detail: Option<String>,
}

impl StepState {
    fn to_wire(&self) -> crate::ipc::events::BootstrapProgressStep {
        crate::ipc::events::BootstrapProgressStep {
            id: self.id.wire_str().to_string(),
            status: self.status.wire_str().to_string(),
            detail: self.detail.clone(),
        }
    }
}

/// What ONE step's own async body reports back to [`run_steps`] — see the module doc's
/// "two different kinds of needs-input" section for why there are two of them.
#[derive(Debug)]
enum StepOutcome {
    Ok(Option<String>),
    Skipped(Option<String>),
    Failed(String),
    /// The pipeline keeps going past this step — see the module doc.
    NeedsInputContinue(String),
    /// The pipeline STOPS here and becomes resumable — see the module doc.
    NeedsInputBlocking(String),
}

type StepFuture = std::pin::Pin<Box<dyn std::future::Future<Output = StepOutcome> + Send>>;

/// One step's identity plus its (not-yet-run) async body, boxed so [`build_pipeline`]
/// can hand [`run_steps`] a plain, uniform `Vec` regardless of what each step's own
/// closure actually captures.
struct PipelineStep {
    id: StepId,
    run: Box<dyn FnOnce() -> StepFuture + Send>,
}

impl PipelineStep {
    fn new<F, Fut>(id: StepId, f: F) -> Self
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = StepOutcome> + Send + 'static,
    {
        Self { id, run: Box::new(move || Box::pin(f())) }
    }
}

/// The generic pipeline driver — decoupled from ssh/Tauri on purpose, so the unit
/// tests below drive it with FAKE steps (plain closures returning a canned
/// [`StepOutcome`]) and prove the state machine itself: `on_progress` fires after
/// every transition (so a caller can emit a live event each time), a `Failed` step
/// stops the run with `needs_input: None`, and a `NeedsInputBlocking` step stops it
/// with `needs_input: Some(that step's id)` — [`StepOutcome::NeedsInputContinue`]
/// does NOT stop the run at all, it just records the step's own status and moves on.
async fn run_steps(steps: Vec<PipelineStep>, on_progress: &mut impl FnMut(&[StepState])) -> (Vec<StepState>, Option<StepId>) {
    let mut states: Vec<StepState> =
        steps.iter().map(|s| StepState { id: s.id, status: StepStatus::Pending, detail: None }).collect();
    on_progress(&states);
    for (i, step) in steps.into_iter().enumerate() {
        let id = step.id;
        states[i].status = StepStatus::Running;
        on_progress(&states);
        match (step.run)().await {
            StepOutcome::Ok(detail) => {
                states[i].status = StepStatus::Ok;
                states[i].detail = detail;
            }
            StepOutcome::Skipped(detail) => {
                states[i].status = StepStatus::Skipped;
                states[i].detail = detail;
            }
            StepOutcome::NeedsInputContinue(detail) => {
                states[i].status = StepStatus::NeedsInput;
                states[i].detail = Some(detail);
            }
            StepOutcome::Failed(msg) => {
                states[i].status = StepStatus::Failed;
                states[i].detail = Some(msg);
                on_progress(&states);
                return (states, None);
            }
            StepOutcome::NeedsInputBlocking(msg) => {
                states[i].status = StepStatus::NeedsInput;
                states[i].detail = Some(msg);
                on_progress(&states);
                return (states, Some(id));
            }
        }
        on_progress(&states);
    }
    (states, None)
}

// ============================================================================
// Session bookkeeping (resume / cancel)
// ============================================================================

/// The request fields [`BootstrapSessions`] needs to remember to re-drive the SAME
/// pipeline on `bootstrap_resume` — deliberately WITHOUT the server's login password:
/// once [`StepId::InstallKey`] has succeeded once, every later run authenticates with
/// the now-installed key ([`step_install_key`]'s own `verify_key_works` pre-check), so
/// the password is never needed again and is never carried in here.
#[derive(Debug, Clone)]
struct StoredBootstrapRequest {
    label: String,
    host: String,
    port: u16,
    user: String,
    mask_sleep: bool,
    /// The host-key fingerprint the user confirmed for this run (M12), when there was
    /// one — not a secret. A resumed run checks the server's key against it again
    /// (`step_install_key`): the key its first call pinned is still nobody's paired
    /// server's until [`StepId::AddMachine`] has run.
    confirmed_host_key: Option<String>,
}

/// One paused (or in-flight) run, addressable by `session_id`.
#[derive(Debug)]
struct StoredSession {
    request: StoredBootstrapRequest,
    /// The SUDO password last supplied for this session, if any — `Debug`-safe (see
    /// this module's `stored_session_debug_never_contains_the_sudo_password` test):
    /// [`SecretString`]'s own `Debug` impl redacts it.
    sudo_password: Option<SecretString>,
    /// The [`ServerLocks`] key this run claimed when it started (B_lifecycle-#7 review
    /// finding) — carried here so a PAUSED run's claim can outlive the async call that
    /// paused it: `bootstrap_resume`'s own eventual completion, or `bootstrap_cancel`,
    /// is what releases it, neither of which has any other way to recover the exact
    /// key an earlier call claimed (re-deriving it from `request` could drift if the
    /// machine's preferred host rotates while this session sits paused — see
    /// B_lifecycle-#8).
    lock_key: String,
    /// The already-paired [`MachineRecord`]'s id, when the ORIGINAL `bootstrap_server`
    /// call converged on one at the very start (B_lifecycle-#8 review finding) — `None`
    /// for a genuinely first-contact host that paused before `StepId::AddMachine` had
    /// ever run once. `bootstrap_resume` looks the machine up BY THIS ID
    /// (`resolve_resume_machine`), never by re-deriving `(host, port, user)` from
    /// `request`, which A6's live address-rotation (`Store::set_machine_preferred_host`)
    /// can rewrite out from under a session sitting paused — losing this id-based
    /// lookup would make a resume proceed as if pairing a brand-new host.
    machine_id: Option<String>,
}

/// Tauri-managed registry of paused/in-flight bootstrap runs, keyed by `session_id`.
/// Mirrors `bootstrap::server_setup::LoginSessions`'s own shape (a `Mutex<HashMap<...>>`
/// behind an `Arc`), simplified: there is no "kill an in-flight actor" case here (every
/// step is a bounded, fast ssh round trip — see the module doc), only "was this run
/// left paused at a blocking step, and if so, with what to resume it".
pub struct BootstrapSessions {
    inner: Mutex<HashMap<String, StoredSession>>,
}

impl Default for BootstrapSessions {
    fn default() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }
}

impl BootstrapSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or re-register — a resumed run calls this again) `session_id`,
    /// carrying the [`ServerLocks`] key it claimed (see [`StoredSession::lock_key`])
    /// and the machine id it already converged on, if any (see
    /// [`StoredSession::machine_id`]).
    async fn start(
        &self,
        session_id: String,
        request: StoredBootstrapRequest,
        sudo_password: Option<SecretString>,
        lock_key: String,
        machine_id: Option<String>,
    ) {
        self.inner
            .lock()
            .await
            .insert(session_id, StoredSession { request, sudo_password, lock_key, machine_id });
    }

    /// Look up a paused session, merging in a freshly supplied `sudo_password` (or, when
    /// `None`, keeping whatever was captured before — a caller retrying without
    /// re-typing a password that was already accepted should not have to). `Err` when
    /// nothing is paused under this id (already finished, cancelled, or never existed).
    /// Also returns the session's own `lock_key` — `bootstrap_resume` REUSES this
    /// (never re-derives, never re-claims) since it is already held by this very
    /// session — and `machine_id`, for `resolve_resume_machine` (B_lifecycle-#8).
    async fn resume(
        &self,
        session_id: &str,
        sudo_password: Option<SecretString>,
    ) -> Result<(StoredBootstrapRequest, Option<SecretString>, String, Option<String>), String> {
        let mut guard = self.inner.lock().await;
        let session =
            guard.get_mut(session_id).ok_or_else(|| "no bootstrap run is paused under this session id".to_string())?;
        if sudo_password.is_some() {
            session.sudo_password = sudo_password;
        }
        Ok((
            session.request.clone(),
            session.sudo_password.clone(),
            session.lock_key.clone(),
            session.machine_id.clone(),
        ))
    }

    /// Abandon a paused session — removes it (and, with it, the sudo password it was
    /// holding: see this module's own `cancel_drops_the_sudo_password` test) entirely.
    /// A no-op if the session already finished or never existed. Returns the removed
    /// session's `lock_key`, when there was one to remove, so the caller
    /// (`bootstrap_cancel`) can release the [`ServerLocks`] claim a paused run left
    /// behind (see [`StoredSession::lock_key`]) — nothing else can recover that key.
    async fn cancel(&self, session_id: &str) -> Option<String> {
        self.inner.lock().await.remove(session_id).map(|s| s.lock_key)
    }

    /// Remove a session that reached a TERMINAL outcome (`Ok` or `Failed` — never
    /// `NeedsInputBlocking`, which is what keeps a session addressable at all).
    async fn finish(&self, session_id: &str) {
        self.inner.lock().await.remove(session_id);
    }
}

// ============================================================================
// Per-server lock (B_lifecycle-#7 review finding)
// ============================================================================

/// Per-server serialization for `bootstrap_server`/`bootstrap_resume`/`machine_repair`.
/// Before this, nothing stopped two of these running concurrently against the SAME
/// host — each one runs several real ssh round trips (key install, probe, daemon
/// upload, unit install, persistence, restarts), so two interleaved runs could race
/// each other's writes; the loser typically failed opaquely at its very last step
/// (`AddMachine`'s pending-key rename already claimed by the winner) with no
/// explanation that another run had raced it.
///
/// Keyed by [`server_lock_key`] — the machine id when one is already known (repair
/// always has one; a bootstrap attempt has one when it converges on an existing
/// pairing), else the raw `(host, port, user)` triple. A claim is TRY-ONLY (see
/// [`ServerLocks::claim`]): it never blocks or waits, because a silent wait would
/// leave a caller's spinner running with no way to tell the user anything is
/// contended — see [`server_busy_error`].
pub struct ServerLocks {
    inner: std::sync::Mutex<HashMap<String, String>>,
}

impl Default for ServerLocks {
    fn default() -> Self {
        Self { inner: std::sync::Mutex::new(HashMap::new()) }
    }
}

impl ServerLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `key` for `op` (a short label of what is about to run — `"Add a server"`
    /// or a [`repair_action_label`]). `Err` — the label of whatever ALREADY holds this
    /// key — when it's already claimed; never blocks. Prefer [`ServerLockGuard::acquire`]
    /// over calling this directly: the guard is what actually guarantees the release.
    fn claim(&self, key: &str, op: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(running) = guard.get(key) {
            return Err(running.clone());
        }
        guard.insert(key.to_string(), op.to_string());
        Ok(())
    }

    fn release(&self, key: &str) {
        self.inner.lock().unwrap().remove(key);
    }
}

/// The [`ServerLocks`] key for one bootstrap/repair attempt against `(host, port,
/// user)`: the machine id when one is ALREADY known, else the triple folded into one
/// string. Literal string matching, same discipline as [`crate::store::Store::
/// machine_by_address`] (no DNS/case normalization) — a host typed two different but
/// equivalent ways is treated as a different key, same as everywhere else addresses
/// are compared in this crate.
///
/// `pub(crate)`: also the key [`crate::ipc::commands::add_machine`] claims with
/// (B_lifecycle-#addmachinelock review finding — the legacy/manual pairing command
/// used to never claim this lock at all, so it could interleave ssh writes with a
/// `bootstrap_server`/`bootstrap_resume`/`machine_repair` run already in flight
/// against the exact same host).
pub(crate) fn server_lock_key(existing_machine_id: Option<&str>, host: &str, port: u16, user: &str) -> String {
    match existing_machine_id {
        Some(id) => id.to_string(),
        None => format!("{host}:{port}:{user}"),
    }
}

/// Wording contract with the front's `isServerBusyError` (`serverBootstrapModel.ts`) —
/// keep the two in sync, same discipline as this crate's other Rust/TS wording
/// contracts (e.g. TOSSE's `SESSION_GONE_MARKERS`): reformulating this silently breaks
/// the front's "this is a ServerBusy, not just any failure" detection.
///
/// `pub(crate)`: also used by [`crate::ipc::commands::add_machine`] — see
/// [`server_lock_key`]'s own doc.
pub(crate) fn server_busy_error(running_op: String) -> String {
    format!(
        "Another operation (\"{running_op}\") is already running on this server. \
         Wait for it to finish, then try again."
    )
}

/// One [`ServerLocks`] claim, RELEASED ON DROP — covers every exit path a hand-
/// maintained "call `.release()` before each `return`" discipline would miss (an
/// early `?`, or the async task holding this being dropped/cancelled by its own
/// caller), EXCEPT the one case that must outlive this async call entirely: a
/// bootstrap run that PAUSES ([`StepOutcome::NeedsInputBlocking`]) keeps its claim
/// alive across the whole pause, via [`Self::into_forgotten_key`] — the raw key is
/// then handed to [`BootstrapSessions`] ([`StoredSession::lock_key`]) to release
/// later, from `bootstrap_resume`'s own eventual completion or `bootstrap_cancel`.
///
/// `pub(crate)`: [`crate::ipc::commands::add_machine`] also acquires one directly —
/// see [`server_lock_key`]'s own doc. It never pauses, so it only ever uses
/// [`Self::acquire`] and lets the guard drop normally at the end of the call, the same
/// way [`machine_repair`] does.
pub(crate) struct ServerLockGuard {
    locks: Arc<ServerLocks>,
    key: String,
    /// Set by [`Self::into_forgotten_key`] — `Drop` checks this flag rather than
    /// consuming `self` via `std::mem::forget`, so a field added to this struct later
    /// is never silently leaked along with the lock.
    released: bool,
}

impl ServerLockGuard {
    /// Claim `key` for `op` and wrap it in a guard. `Err` — [`server_busy_error`]'s
    /// input — when another operation already holds this key.
    pub(crate) fn acquire(locks: &Arc<ServerLocks>, key: String, op: &str) -> Result<Self, String> {
        locks.claim(&key, op)?;
        Ok(Self { locks: locks.clone(), key, released: false })
    }

    /// Wrap an ALREADY-claimed key without claiming it again — `bootstrap_resume`
    /// picking a paused run back up (its own earlier `bootstrap_server`/
    /// `bootstrap_resume` call is what claimed it, and left it claimed via
    /// [`Self::into_forgotten_key`] when it paused). Same drop/forget bookkeeping as
    /// [`Self::acquire`]'s result from here on.
    fn adopt(locks: &Arc<ServerLocks>, key: String) -> Self {
        Self { locks: locks.clone(), key, released: false }
    }

    fn key(&self) -> &str {
        &self.key
    }

    /// Skip the release-on-drop — the claim must OUTLIVE this async call (the run
    /// PAUSED mid-pipeline). Returns the raw key for [`StoredSession::lock_key`] to
    /// carry until `bootstrap_resume`/`bootstrap_cancel` releases it.
    fn into_forgotten_key(mut self) -> String {
        self.released = true;
        self.key.clone()
    }
}

impl Drop for ServerLockGuard {
    fn drop(&mut self) {
        if !self.released {
            self.locks.release(&self.key);
        }
    }
}

/// Registers `session_id` (carrying `lock_key` — see [`StoredSession::lock_key`] —
/// and `machine_id` — see [`StoredSession::machine_id`]), runs `steps` to completion
/// (or a blocking pause), and clears the registration again UNLESS the run paused at a
/// blocking step — the one place that ties [`run_steps`]'s generic state machine to
/// [`BootstrapSessions`]'s own bookkeeping, exercised directly by this module's
/// fake-step tests. Does NOT itself touch [`ServerLocks`] — releasing the claim
/// `lock_key` names is [`run_pipeline_and_register`]'s job (its caller), which alone
/// holds the [`ServerLockGuard`] that can actually do so.
async fn drive_and_register(
    sessions: &BootstrapSessions,
    session_id: String,
    request: StoredBootstrapRequest,
    sudo_password: Option<SecretString>,
    lock_key: String,
    machine_id: Option<String>,
    steps: Vec<PipelineStep>,
    mut on_progress: impl FnMut(&[StepState]),
) -> (Vec<StepState>, Option<StepId>) {
    sessions.start(session_id.clone(), request, sudo_password, lock_key, machine_id).await;
    let (states, needs_input) = run_steps(steps, &mut on_progress).await;
    if needs_input.is_none() {
        sessions.finish(&session_id).await;
    }
    (states, needs_input)
}

// ============================================================================
// Pipeline context (what one step hands the next)
// ============================================================================

/// Everything an EARLIER step learns that a LATER one needs — shared across every step
/// closure in one run via `Arc<Mutex<_>>` (each step is a boxed, independently-owned
/// future; this is the one piece of state they all close over).
#[derive(Default)]
struct PipelineCtx {
    identity_file: Option<String>,
    probe: Option<RemoteProbeResult>,
    machine_id: Option<String>,
    diagnosis: Option<ServerDiagnosis>,
}

/// Build the (not-yet-persisted) [`MachineRecord`] every step before
/// [`StepId::AddMachine`] runs its ssh calls against — see the module doc's "reused,
/// not reinvented" note: [`install::upload_daemon`]/[`install::install_service`]/
/// [`install::escalate_persistence`]/[`server_setup::run_init`] only ever read
/// `host`/`port`/`user`/`identity_file` off it, never `id` — so a placeholder id here
/// is harmless; the REAL, persisted record (with its real id) is what
/// [`step_add_machine`] produces.
fn synthetic_machine(req: &StoredBootstrapRequest, identity_file: &str) -> MachineRecord {
    MachineRecord {
        id: String::new(),
        label: req.label.clone(),
        host: req.host.clone(),
        port: req.port,
        user: req.user.clone(),
        identity_file: Some(identity_file.to_string()),
        added_at: 0,
        addresses: Vec::new(),
        daemon_mac_id: None,
        daemon_relay_url: None,
        daemon_label: None,
        phone_provisioned_at: None,
    }
}

/// Resolve the app's dedicated `known_hosts` path — mirrors every other bootstrap
/// module's own tiny, App-Handle-only copy of this same resolution (established
/// convention in this directory — see e.g. `bootstrap::install::known_hosts_path`).
fn known_hosts_path(app: &tauri::AppHandle) -> Option<String> {
    app.path().app_data_dir().ok().map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned())
}

/// Resolve the `(machine, known_hosts)` pair every step from [`StepId::Probe`] onward
/// needs, off the identity [`step_install_key`] already stashed in `ctx`.
async fn step_context(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> Result<(MachineRecord, String), String> {
    let identity_file =
        ctx.lock().await.identity_file.clone().ok_or_else(|| "no key available yet".to_string())?;
    let known_hosts = known_hosts_path(app).ok_or_else(|| "could not resolve the app's data directory".to_string())?;
    Ok((synthetic_machine(req, &identity_file), known_hosts))
}

// ============================================================================
// Step bodies
// ============================================================================

/// Whether `target` is ALREADY reachable over the crate's normal KEYED path with
/// `identity_file` — a plain `true` round trip, mirroring [`connect::
/// verify_key_accepted`]'s own shape. Used by [`step_install_key`] to skip the
/// password path entirely on a resume/re-run once the key already works.
async fn verify_key_works(target: &connect::BootstrapTarget, identity_file: &str, known_hosts: &str) -> bool {
    // A known-hosts path ssh cannot be given reads as "the key does not work yet": the
    // password connection that follows refuses it with the reason.
    let Ok(mut cmd) = crate::ipc::commands::keyed_ssh_options(target.port, Some(identity_file), Some(known_hosts))
    else {
        return false;
    };
    cmd.arg("-T");
    // Never spawns anything for an ssh-option-shaped user/host — see
    // `push_ssh_destination`'s own doc.
    if crate::ipc::commands::push_ssh_destination(&mut cmd, &target.user, &target.host).is_err() {
        return false;
    }
    cmd.arg("true");
    matches!(
        crate::ipc::commands::output_within(&mut cmd, SSH_ROUND_TRIP_TIMEOUT).await,
        Ok(Some(out)) if out.status.success()
    )
}

/// [`StepId::InstallKey`] — connect + install the app's dedicated key (B4/B7), with the
/// host-key fingerprint event folded in. Password path ONLY when a keyed connection
/// doesn't already work.
///
/// ⚠️ M12 (security review 2026-10-09): the server's host key is checked FIRST — before
/// any connection of this step, keyed or not, could pin it on its own
/// ([`connect::ensure_confirmed_host_key`]): the saved key of an address a paired server
/// uses passes, and any other key — a first contact, or one an earlier keyed attempt
/// saved on its own (`verify_key_works` pins whatever answers, even when the login
/// fails) — goes on only when it is exactly `confirmed_host_key` (the fingerprint the
/// wizard showed and the user confirmed), pinned as the only key saved for it; anything
/// else stops the step before anything is sent. The password connection itself then
/// checks strictly against that pin. With NO password too (audit sec-hostkey#4: the
/// legacy ticket flow, a re-run, a resume): the key pinned here is the one every later
/// step sends a sudo password, a Claude sign-in code and the phone keys to.
async fn step_install_key(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    password: Option<&SecretString>,
    confirmed_host_key: Option<&str>,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> StepOutcome {
    let Some(known_hosts) = known_hosts_path(app) else {
        return StepOutcome::Failed("could not resolve the app's data directory".to_string());
    };
    let ssh_keys_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("ssh_keys"),
        Err(e) => return StepOutcome::Failed(format!("could not resolve the app's data directory: {e}")),
    };
    let target = connect::BootstrapTarget { host: req.host.clone(), port: req.port, user: req.user.clone() };
    let paired = connect::paired_in_store(app, &target.host, target.port);
    let (outcome, installed_with) = install_key_core(
        &target,
        &known_hosts,
        &ssh_keys_dir,
        &req.label,
        password,
        confirmed_host_key,
        paired,
        ctx,
    )
    .await;
    if let Some(host_key) = installed_with {
        connect::emit_host_key_fingerprint(app, &req.host, req.port, &host_key.fingerprint, host_key.known_before);
    }
    outcome
}

/// The body of [`step_install_key`], on plain paths (testable without an app). Returns
/// the step's outcome, plus the host key the password went to when it installed the key
/// that way (for the fingerprint event).
#[allow(clippy::too_many_arguments)]
async fn install_key_core(
    target: &connect::BootstrapTarget,
    known_hosts: &str,
    ssh_keys_dir: &std::path::Path,
    label: &str,
    password: Option<&SecretString>,
    confirmed_host_key: Option<&str>,
    paired: bool,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> (StepOutcome, Option<connect::ConfirmedHostKey>) {
    // Before ANY connection of this step, with or without a password: a keyed one pins
    // whatever answers (`accept-new`), and every later step sends that pin secrets.
    let host_key = match connect::ensure_confirmed_host_key(target, known_hosts, confirmed_host_key, paired).await {
        Ok(confirmed) => confirmed,
        Err(e) => return (StepOutcome::Failed(e.to_string()), None),
    };

    // Re-run convergence (B11 review finding): when `ctx.identity_file` is ALREADY
    // seeded — `bootstrap_server`/`bootstrap_resume` found a previously-paired
    // `MachineRecord` for this exact (host, port, user) and pre-filled it — that key
    // was already claimed (renamed off the shared "pending" path, see
    // `claim_pending_key`) and will never be handed out by
    // `generate_or_reuse_pending_key` again. Check THAT key first; only fall through
    // to minting/reusing the shared pending key (and, if needed, the password path)
    // when it no longer works (rotated away, file removed, server reimaged). Without
    // this, a bare re-run of `bootstrap_server` against an already-fully-paired
    // server would silently generate and try to install a second, unrelated key
    // every time instead of converging.
    if let Some(known_identity) = ctx.lock().await.identity_file.clone() {
        if verify_key_works(target, &known_identity, known_hosts).await {
            return (StepOutcome::Skipped(Some("the previously paired key already works".to_string())), None);
        }
    }

    let key = match crate::ipc::commands::generate_or_reuse_pending_key(ssh_keys_dir, label).await {
        Ok(k) => k,
        Err(e) => return (StepOutcome::Failed(e), None),
    };

    if verify_key_works(target, &key.identity_file, known_hosts).await {
        ctx.lock().await.identity_file = Some(key.identity_file.clone());
        return (StepOutcome::Skipped(Some("the key is already installed".to_string())), None);
    }

    let Some(password) = password else {
        return (
            StepOutcome::Failed(
                "this server needs its login password to install Flight Deck's key (first contact only)".to_string(),
            ),
            None,
        );
    };

    match connect::install_key(target, password.expose(), &key.identity_file, &key.public_key, known_hosts).await {
        Ok(outcome) => {
            ctx.lock().await.identity_file = Some(key.identity_file.clone());
            (StepOutcome::Ok(Some(format!("{outcome:?}"))), Some(host_key))
        }
        Err(e) => (StepOutcome::Failed(e.to_string()), None),
    }
}

/// [`StepId::Probe`] — B7's extended install-mode probe.
async fn step_probe(app: &tauri::AppHandle, req: &StoredBootstrapRequest, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let identity_file = match ctx.lock().await.identity_file.clone() {
        Some(i) => i,
        None => return StepOutcome::Failed("no key available to probe with".to_string()),
    };
    let Some(known_hosts) = known_hosts_path(app) else {
        return StepOutcome::Failed("could not resolve the app's data directory".to_string());
    };
    let target = connect::BootstrapTarget { host: req.host.clone(), port: req.port, user: req.user.clone() };
    match connect::probe(&target, &identity_file, &known_hosts).await {
        Ok(probe) => {
            // Stop BEFORE anything is installed: every later step assumes Linux +
            // systemd, and a Mac (Intel) would otherwise pass the arch check and receive
            // the Linux daemon binary.
            if let Some(reason) = linux_only_installer_refusal(probe.os.as_deref()) {
                return StepOutcome::Failed(reason);
            }
            let detail = format!("{probe:?}");
            ctx.lock().await.probe = Some(probe);
            StepOutcome::Ok(Some(detail))
        }
        Err(e) => StepOutcome::Failed(e.to_string()),
    }
}

/// Pure: does [`StepId::Probe`]'s own fact about `claude` already mean
/// [`StepId::InstallClaude`] has nothing to do? `probe.claude_missing` is itself
/// produced by the SAME shared resolver ([`crate::ipc::commands::resolve_claude_bin_expr`])
/// every remote `claude` lookup in this crate now uses, so this is never fooled by a
/// user-level install a bare `command -v claude` would have missed.
pub(crate) fn claude_already_resolvable(probe: &RemoteProbeResult) -> bool {
    !probe.claude_missing
}

/// [`StepId::InstallClaude`] (B14) — runs the official native installer as the ssh
/// LOGIN user (never sudo/root — see [`server_setup::install_claude`]'s own doc for the
/// citation and the exact command), skipped when [`StepId::Probe`] already found a
/// working `claude`. Placed right after [`StepId::Probe`] and, on failure, stops the
/// WHOLE pipeline ([`StepOutcome::Failed`], never [`StepOutcome::NeedsInputContinue`]):
/// a server that cannot install/run Claude Code cannot usefully run the rest of this
/// pipeline either (see the module doc).
async fn step_install_claude(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> StepOutcome {
    let probe = match ctx.lock().await.probe.clone() {
        Some(p) => p,
        None => return StepOutcome::Failed("no probe result available yet".to_string()),
    };
    if claude_already_resolvable(&probe) {
        return StepOutcome::Skipped(Some("claude is already installed".to_string()));
    }
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    match server_setup::install_claude(&machine, Some(&known_hosts)).await {
        Ok(version) => StepOutcome::Ok(Some(version)),
        Err(e) => StepOutcome::Failed(e.to_string()),
    }
}

/// Count of currently-busy conversations from a FRESH `flightdeckd status` — `None`
/// when the round trip itself failed or the answer didn't parse as `fd_status`
/// (unknown, never assumed zero). Feeds the RESTART RULE ([`step_upload_daemon`]) and
/// [`ServerDiagnosis::busy_conversations`] (via [`parse_diagnosis_fields`], which reads
/// it off the SAME accumulating [`diagnose`] round trip instead of a second one).
async fn fetch_busy_conversations(machine: &MachineRecord, known_hosts: Option<&str>) -> Option<u32> {
    let cmd = format!("{} status 2>/dev/null", resolve_daemon_bin_expr("flightdeckd"));
    let out = tokio::time::timeout(SSH_ROUND_TRIP_TIMEOUT, run_ssh_on_machine(machine, known_hosts, &cmd))
        .await
        .ok()? // outer timeout elapsed -> unknown, never assumed zero
        .ok()?; // the ssh round trip itself failed -> unknown
    count_busy_conversations(&out)
}

/// Pure: parses `flightdeckd status`'s `{type:"fd_status", conversations:[{busy,...}]}`
/// shape (see `flightdeckd/src/frames.rs::fd_status`) into the count of conversations at
/// work ([`status_row_at_work`]). `None` on anything that doesn't parse — never assumed zero.
fn count_busy_conversations(status_stdout: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(status_stdout.trim()).ok()?;
    rows_at_work(v.get("conversations")?.as_array()?)
}

/// How many `fd_status` rows are at work ([`status_row_at_work`]) — `None` (unknown, never
/// 0) when a row with a live process lacks `background_tasks`: flightdeckd < 0.4.0 cannot
/// report background work, and a conversation whose turn ended may still run a background
/// agent or workflow there, which a restart would kill unseen. A row with no process has
/// nothing to cut short. The one count both the RESTART RULE and the diagnosis read.
fn rows_at_work(rows: &[serde_json::Value]) -> Option<u32> {
    let live = |r: &serde_json::Value| r.get("running").and_then(serde_json::Value::as_bool) == Some(true);
    if rows.iter().any(|r| live(r) && r.get("background_tasks").is_none()) {
        return None;
    }
    Some(rows.iter().filter(|r| status_row_at_work(r)).count() as u32)
}

/// The first flightdeckd whose status rows report background work (`background_tasks`).
const DAEMON_REPORTS_BACKGROUND_WORK: &str = "0.4.0";

/// Whether an `fd_status` row is a conversation a daemon restart would cut short: a turn
/// running (`busy`), background work still running after its turn ended (agents, workflows,
/// `run_in_background` shells — `busy` is false then), or a request waiting on a human (a
/// background agent's permission prompt). `background_tasks` comes from flightdeckd 0.4.0
/// (`pending` counted only `can_use_tool` prompts before it); a row without a field reads
/// it as 0 HERE — a restart guard counts through [`rows_at_work`], which reads a live row
/// without `background_tasks` as unknown. A row flagged `unanswered` (flightdeckd 0.6.0: its live session did not answer
/// the daemon's status query in time) is at work: what it is doing is unknown, and its
/// process is up. So is one holding `scheduled` work (flightdeckd 0.6.0: a session-only
/// cron or wakeup — a `/loop` between two firings): idle right now, but it lives only in
/// that claude, which a restart stops.
pub(crate) fn status_row_at_work(row: &serde_json::Value) -> bool {
    let count = |k: &str| row.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    status_row_working(row) || count("scheduled") > 0
}

/// [`status_row_at_work`] without the scheduled work: what the conversation is doing NOW — a
/// turn, background work, a request waiting, or a live session whose state is unknown
/// (`unanswered`). The remote resume pass reads this one: a `/loop` waiting for its next
/// firing does not make it re-attach a conversation on every launch and wake.
pub(crate) fn status_row_working(row: &serde_json::Value) -> bool {
    let count = |k: &str| row.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    let flag = |k: &str| row.get(k).and_then(serde_json::Value::as_bool) == Some(true);
    flag("busy") || flag("unanswered") || count("background_tasks") > 0 || count("pending") > 0
}

/// Restarts `flightdeckd`, dispatching on HOW it's installed (a fresh [`diagnose`] —
/// this is never called on a hot path). See the module doc's `repair` section for why
/// a non-root system-unit ADOPTION (fixture C's shape) is the one case that can still
/// need a sudo password here.
///
/// Refuses — never silently proceeds — when this SAME fresh diagnosis can't confirm
/// zero busy conversations (B11 review finding): [`step_upload_daemon`]'s own RESTART
/// RULE already runs its own preflight busy check before ever calling this, but
/// [`repair`]'s `RestartDaemon` arm did not, and is reachable directly (a future
/// wizard UI clearing a `restart_pending` flag) with no such preflight — this makes
/// the guard unconditional for EVERY caller instead of relying on each one to
/// remember it, at no extra ssh round trip (the busy count rides the SAME
/// [`diagnose`] call this function already makes for `installed_as`). See
/// [`restart_plan`] for the one exception, a daemon confirmed stopped.
///
/// `pub(crate)` (B14 fix round 2): [`crate::bootstrap::install::repair_user_unit_path`]
/// reuses this verbatim for its own restart, rather than hand-rolling a second
/// busy-conversation guard — see that function's own doc for why a plain
/// `enable --now` never actually restarts an already-active unit.
pub(crate) async fn restart_daemon(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    sudo_password: Option<&SecretString>,
) -> Result<(), BootstrapError> {
    let diagnosis = diagnose(machine, known_hosts).await;
    match restart_plan(&diagnosis, &machine.user)? {
        RestartPlan::Plain(script) => run_plain(machine, known_hosts, &script).await,
        RestartPlan::Sudo(script) => run_sudo(machine, known_hosts, sudo_password, &script).await,
    }
}

/// The remote command [`restart_daemon`] runs, and how — see [`restart_plan`].
#[derive(Debug, Clone, PartialEq, Eq)]
enum RestartPlan {
    /// Run as the SSH user.
    Plain(String),
    /// Run through `sudo` ([`run_sudo`]: passwordless first, then the captured password).
    Sudo(String),
}

/// Why a daemon seen running ([`ServerDiagnosis::daemon_process_seen`]) has no readable
/// status — the headline [`collapse_state`] gives it, and the reason [`restart_plan`]
/// refuses to restart it.
const DAEMON_STATUS_UNREADABLE: &str = "flightdeckd is running, but its status can't be read from this SSH login \
     — it may run as another user, or its socket or binary is gone";

/// Why nothing says whether flightdeckd runs: its status can't be read AND the process
/// check couldn't run (`why` — [`ServerDiagnosis::daemon_process_check_error`]). The
/// headline [`collapse_state`] gives it, and [`restart_plan`]'s refusal. A Mac always
/// has `pgrep`; a Linux server without it gets it from procps.
fn daemon_state_unknown_reason(why: &str, host_os: Option<&str>) -> String {
    let advice = if host_os == Some(MACOS_UNAME) { "" } else { " — install procps on the server, which provides pgrep" };
    format!("its status can't be read from this SSH login, and the server can't list its processes to check ({why}){advice}")
}

/// POSIX ERE (`pgrep`/`pkill -f`, `grep -E`) for the command line of a RUNNING daemon:
/// its first words are `flightdeckd run`, whatever the path. Anchored on purpose — a
/// shell whose arguments hold a script naming `flightdeckd run` (the diagnose script's,
/// the restart's own `$SHELL -c '…'`) starts with the shell's name, so it never
/// matches, while procps' pgrep/pkill would otherwise count (or kill) it: they skip only
/// themselves, never their parent.
const DAEMON_PROCESS_ERE: &str = "^([^ ]*/)?flightdeckd run( |$)";

/// POSIX ERE for text that STARTS the daemon — a plist's command, or the wrapper script
/// it launches: `flightdeckd`, as a word (any path, closing quote allowed), then `run`.
/// `flightdeckd status`, `~/.flightdeckd/…`, `/Users/flightdeckd/…` or a
/// `flightdeckd.log` never match.
const DAEMON_INVOCATION_ERE: &str =
    "(^|[^[:alnum:]_.-])flightdeckd[^[:alnum:][:space:]_.-]?[[:space:]]+run([^[:alnum:]_-]|$)";

/// [`MAC_AGENT_PLIST_FN`] with the two patterns it reads ([`DAEMON_PROCESS_ERE`] as
/// `$FD_DAEMON_RE`, [`DAEMON_INVOCATION_ERE`] as `$FD_INVOKE_RE`) set first — the
/// preamble of both [`diagnose_script`] (whose process check reads `$FD_DAEMON_RE`
/// too) and the LaunchAgent restart.
fn mac_agent_fns() -> String {
    format!(
        "FD_DAEMON_RE={}\nFD_INVOKE_RE={}\n{MAC_AGENT_PLIST_FN}",
        shq(DAEMON_PROCESS_ERE),
        shq(DAEMON_INVOCATION_ERE)
    )
}

/// Pure core of [`restart_daemon`]: which restart fits how `d` says flightdeckd is
/// installed, or why there is none.
///
/// The busy guard only applies to a daemon that is running or whose state is unknown:
/// a daemon CONFIRMED stopped has nothing busy, and its busy count is unknown by
/// construction (there was no `flightdeckd status` to count from) — refusing on it
/// made "Restart the daemon" fail on exactly the server it is offered for ("the daemon
/// isn't running"). Confirmed stopped is `daemon_running == Some(false)`, which
/// [`parse_diagnosis_fields`] only sets when no daemon process or active unit was seen
/// either — checked again here (`daemon_process_seen == Some(false)`), since a status
/// that reaches nothing from this login is NOT proof: another user's daemon, or one
/// whose socket or binary is gone, would otherwise be killed with its conversations.
/// An install that can't be restarted is refused first, so a busy server isn't told
/// to wait for a restart that could never run anyway.
fn restart_plan(d: &ServerDiagnosis, user: &str) -> Result<RestartPlan, BootstrapError> {
    let plan = match d.installed_as {
        InstalledAs::System if user == "root" => RestartPlan::Plain("systemctl restart flightdeckd".to_string()),
        InstalledAs::System => RestartPlan::Sudo("systemctl restart flightdeckd".to_string()),
        InstalledAs::User => RestartPlan::Plain(
            "export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart flightdeckd".to_string(),
        ),
        InstalledAs::LaunchAgent => RestartPlan::Plain(format!("{}\n{MAC_AGENT_RESTART_SCRIPT}", mac_agent_fns())),
        // A daemon restarted from SSH on a Mac would run outside the logged-in session,
        // where claude can't read its Keychain login — every conversation would then
        // fail as signed out. Refuse rather than hand back a daemon that looks fine.
        InstalledAs::Detached if d.host_os.as_deref() == Some(MACOS_UNAME) => {
            return Err(BootstrapError::Other(
                "on a Mac, flightdeckd has to run as a LaunchAgent of the logged-in user — a daemon started \
                 over SSH can't read Claude's login from the Keychain. Set the LaunchAgent up on the Mac."
                    .to_string(),
            ))
        }
        // pkill on [`DAEMON_PROCESS_ERE`], never a bare `flightdeckd run`: this line runs
        // as `$SHELL -c '<it>'`, whose own arguments hold the pattern's text, and Linux
        // pkill (procps) skips only itself, not its parent — the unanchored pattern
        // killed the very shell about to start the daemon.
        InstalledAs::Detached => {
            let bin = resolve_daemon_bin_expr("flightdeckd");
            RestartPlan::Plain(format!(
                "pkill -u \"$(id -u)\" -f {} 2>/dev/null; sleep 1; \
                 setsid nohup {bin} run >/dev/null 2>&1 </dev/null &",
                shq(DAEMON_PROCESS_ERE)
            ))
        }
        InstalledAs::None | InstalledAs::Unknown => {
            return Err(BootstrapError::Other(
                "could not determine how flightdeckd is installed on this server, so it cannot be restarted \
                 automatically"
                    .to_string(),
            ))
        }
    };
    let confirmed_stopped = d.daemon_running == Some(false) && d.daemon_process_seen == Some(false);
    if !confirmed_stopped && d.busy_conversations != Some(0) {
        if d.daemon_running.is_none() && d.daemon_process_seen == Some(true) {
            return Err(BootstrapError::Other(format!(
                "won't restart flightdeckd — {DAEMON_STATUS_UNREADABLE}, so whether its conversations are at work is unknown"
            )));
        }
        if let (None, None, Some(why)) = (d.daemon_running, d.daemon_process_seen, &d.daemon_process_check_error) {
            return Err(BootstrapError::Other(format!(
                "won't restart flightdeckd — {}",
                daemon_state_unknown_reason(why, d.host_os.as_deref())
            )));
        }
        // Its status was read, yet its work is unknown: a daemon too old to report the
        // background work of a live conversation (see `rows_at_work`).
        if let (Some(true), None, Some(v)) =
            (d.daemon_running, d.busy_conversations, d.daemon_version_running.as_deref())
        {
            if !crate::ipc::commands::version_at_least(v, DAEMON_REPORTS_BACKGROUND_WORK) {
                return Err(BootstrapError::Other(format!(
                    "won't restart flightdeckd — the one running ({v}) is too old to report its conversations' \
                     background work (agents, workflows, background shells), so a restart could cut one short \
                     unseen. Restart it on the server yourself once nothing runs in the background."
                )));
            }
        }
        return Err(BootstrapError::DaemonBusy(d.busy_conversations));
    }
    Ok(plan)
}

/// Restarts a Mac's flightdeckd LaunchAgent (found by [`MAC_AGENT_PLIST_FN`], whatever
/// its label) inside the user's `gui/<uid>` domain — `kickstart -k` when launchd has
/// it loaded, `bootstrap` when it doesn't. Fails, saying why, when nobody is logged
/// into the Mac (there is no gui domain to start it in), when the only plists naming
/// flightdeckd can't be parsed (launchd can't load them either), and when several
/// plists run flightdeckd: it names them all on one line (only ssh's last stderr line
/// reaches the user) instead of restarting whichever came first.
const MAC_AGENT_RESTART_SCRIPT: &str = r#"LA_PLISTS=$(fd_mac_agent_plists)
if [ -z "$LA_PLISTS" ]; then
    LA_INVALID=$(fd_mac_invalid_agent_plists | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')
    if [ -n "$LA_INVALID" ]; then
        printf 'no flightdeckd LaunchAgent launchd can load: %s can'"'"'t be parsed — check it with plutil -lint\n' "$LA_INVALID" >&2
    else
        echo "no flightdeckd LaunchAgent found in ~/Library/LaunchAgents" >&2
    fi
    exit 1
fi
if [ "$(printf '%s\n' "$LA_PLISTS" | grep -c .)" != 1 ]; then
    LA_LIST=$(printf '%s\n' "$LA_PLISTS" | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')
    printf 'several LaunchAgents run flightdeckd (%s) — keep only one in ~/Library/LaunchAgents, then restart\n' "$LA_LIST" >&2
    exit 1
fi
LA_PLIST=$LA_PLISTS
LA_LABEL=$(fd_plist_get "$LA_PLIST" Label)
if [ -z "$LA_LABEL" ]; then
    echo "could not read the Label of $LA_PLIST" >&2
    exit 1
fi
DOMAIN="gui/$(id -u)"
if ! launchctl print "$DOMAIN" >/dev/null 2>&1; then
    echo "nobody is logged into this Mac — its LaunchAgent only runs inside a logged-in session" >&2
    exit 1
fi
if launchctl print "$DOMAIN/$LA_LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LA_LABEL"
else
    launchctl bootstrap "$DOMAIN" "$LA_PLIST"
fi"#;

async fn run_plain(machine: &MachineRecord, known_hosts: Option<&str>, script: &str) -> Result<(), BootstrapError> {
    tokio::time::timeout(SSH_ROUND_TRIP_TIMEOUT, run_ssh_on_machine(machine, known_hosts, script))
        .await
        .map_err(|_| BootstrapError::Other("ssh command timed out".to_string()))?
        .map(|_| ())
        .map_err(BootstrapError::Other)
}

/// Scrubs every literal occurrence of `password` out of `text` — the escape hatch a
/// caller that must surface a remote command's own stderr (e.g. [`run_sudo`]'s
/// wrong-password branch, which cannot know in advance whether `sudo`'s own prompt
/// wording echoes it back) uses before that text can ever become a [`BootstrapError`].
/// Guarded on non-empty so an empty password (never a real one, but worth being
/// defensive about) can't turn this into a replace-everything-with-redacted mess.
/// Mirrors `askpass::classify_output`'s own scrub for the SAME reason, in this
/// module's own sudo path — see `bootstrap_report_json_never_contains_the_test_sudo_password`
/// below.
fn scrub_password(text: &str, password: &SecretString) -> String {
    if password.expose().is_empty() {
        text.to_string()
    } else {
        text.replace(password.expose(), "[redacted]")
    }
}

/// `sudo`-wrapped remote command — passwordless first (never prompts when it isn't
/// needed, mirroring [`install::escalate_persistence`]'s own ordering), falling back to
/// a captured password piped to `sudo -S -p ''`'s stdin (never argv/env/disk — same
/// discipline as [`install`]'s own sudo helpers).
async fn run_sudo(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    sudo_password: Option<&SecretString>,
    script: &str,
) -> Result<(), BootstrapError> {
    const TIMEOUT: Duration = Duration::from_secs(30);
    let probe = run_ssh_on_machine_stdin(machine, known_hosts, "sudo -n true", &[], None, Duration::from_secs(15))
        .await
        .map_err(BootstrapError::Other)?;
    if probe.success {
        let remote = format!("sudo -n sh -c {}", shq(script));
        let out = run_ssh_on_machine_stdin(machine, known_hosts, &remote, &[], None, TIMEOUT)
            .await
            .map_err(BootstrapError::Other)?;
        return if out.success {
            Ok(())
        } else {
            Err(BootstrapError::Other(out.stderr.trim().lines().last().unwrap_or("sudo restart failed").to_string()))
        };
    }
    let Some(password) = sudo_password else {
        return Err(BootstrapError::NeedsSudoPassword);
    };
    let remote = format!("sudo -S -p '' sh -c {}", shq(script));
    let payload = format!("{}\n", password.expose());
    let out = run_ssh_on_machine_stdin(machine, known_hosts, &remote, payload.as_bytes(), None, TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if out.success {
        return Ok(());
    }
    if install::is_wrong_sudo_password(&out.stderr) {
        return Err(BootstrapError::NeedsSudoPassword);
    }
    let last = out.stderr.trim().lines().last().unwrap_or("sudo restart failed").to_string();
    Err(BootstrapError::Other(scrub_password(&last, password)))
}

/// [`StepId::UploadDaemon`] — see the module doc's RESTART RULE. `sudo_password`: the
/// SAME optional password [`bootstrap_server`]'s caller may have supplied UP FRONT —
/// threaded through so a restart that needs sudo (a non-root login that only ADOPTED
/// a pre-existing system unit, e.g. fixture C's shape) can use it on the very first
/// run instead of always degrading to `NeedsInputContinue` even when the caller
/// already gave everything it needed (B11 review finding).
async fn step_upload_daemon(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    sudo_password: Option<&SecretString>,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> StepOutcome {
    let probe = match ctx.lock().await.probe.clone() {
        Some(p) => p,
        None => return StepOutcome::Failed("no probe result available yet".to_string()),
    };
    let Some(arch) = probe.arch.clone() else {
        return StepOutcome::Failed("the server did not report its CPU architecture".to_string());
    };
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    // `probe.os` is Linux (or unreported) here: `step_probe` already refused any other OS.
    let outcome = match install::upload_daemon(app, &machine, probe.os.as_deref(), &arch, None, Some(&known_hosts)).await {
        Ok(o) => o,
        // Never a downgrade (audit sec-daemon-install#2): the newer daemon stays, and
        // keeps running — the rest of the install goes on with it.
        Err(e @ BootstrapError::DaemonNewerOnServer { .. }) => return StepOutcome::Skipped(Some(e.to_string())),
        Err(e) => return StepOutcome::Failed(e.to_string()),
    };
    let restart_required = matches!(outcome, install::UploadOutcome::Uploaded { restart_required: true });
    if !restart_required {
        return StepOutcome::Ok(Some(format!("{outcome:?}")));
    }
    let busy = fetch_busy_conversations(&machine, Some(&known_hosts)).await;
    if busy != Some(0) {
        let n = busy.map(|b| b.to_string()).unwrap_or_else(|| "an unknown number of".to_string());
        return StepOutcome::NeedsInputContinue(format!("restart pending — {n} conversation(s) running"));
    }
    match restart_daemon(&machine, Some(&known_hosts), sudo_password).await {
        Ok(()) => StepOutcome::Ok(Some(format!("{outcome:?}; restarted"))),
        Err(e) => StepOutcome::NeedsInputContinue(format!("restart pending — could not restart automatically: {e}")),
    }
}

/// [`StepId::InstallService`] — B9.
async fn step_install_service(app: &tauri::AppHandle, req: &StoredBootstrapRequest, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let probe = match ctx.lock().await.probe.clone() {
        Some(p) => p,
        None => return StepOutcome::Failed("no probe result available yet".to_string()),
    };
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    match install::install_service(&machine, &probe, Some(&known_hosts)).await {
        Ok(outcome) => StepOutcome::Ok(Some(format!("{outcome:?}"))),
        Err(e) => StepOutcome::Failed(e.to_string()),
    }
}

/// [`StepId::EscalatePersistence`] — B9. The ONE step that can return
/// [`StepOutcome::NeedsInputBlocking`] (see the module doc).
async fn step_escalate_persistence(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    sudo_password: Option<&SecretString>,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> StepOutcome {
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    match install::escalate_persistence(&machine, Some(&known_hosts), sudo_password, req.mask_sleep).await {
        Ok(()) => StepOutcome::Ok(None),
        Err(BootstrapError::NeedsSudoPassword) => {
            StepOutcome::NeedsInputBlocking("this server needs a sudo password to finish persistence setup".to_string())
        }
        Err(e) => StepOutcome::Failed(e.to_string()),
    }
}

/// [`StepId::RunInit`] — idempotent `flightdeckd init`, never `--force`.
async fn step_run_init(app: &tauri::AppHandle, req: &StoredBootstrapRequest, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    match server_setup::run_init(&machine, Some(&known_hosts), &req.label).await {
        Ok(outcome) => StepOutcome::Ok(Some(format!("{outcome:?}"))),
        Err(e) => StepOutcome::Failed(e.to_string()),
    }
}

/// [`StepId::ClaudeAuth`] — logged in → `Ok`; else `NeedsInputContinue` (see the module
/// doc: the pipeline still proceeds to `add_machine`/`diagnose` regardless — the
/// existing [`crate::ipc::events::ServerLoginPromptEvent`] flow, started separately by
/// the caller, is what actually gets a human signed in).
async fn step_claude_auth(app: &tauri::AppHandle, req: &StoredBootstrapRequest, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let (machine, known_hosts) = match step_context(app, req, ctx).await {
        Ok(v) => v,
        Err(e) => return StepOutcome::Failed(e),
    };
    match server_setup::probe_auth_status(&machine, Some(&known_hosts)).await {
        Some(status) if status.logged_in => StepOutcome::Ok(status.email),
        // Both "confirmed not logged in" AND "could not confirm either way" land here —
        // never `Failed`: the fixtures (no claude login at all) must reach
        // `NeedsClaudeSignIn`, never fail the whole pipeline over it (per the brief).
        _ => StepOutcome::NeedsInputContinue("Needs Claude sign-in".to_string()),
    }
}

/// [`StepId::AddMachine`] — persists the [`crate::store::MachineRecord`] via
/// [`persist_paired_machine`] (its own success hook already provisions the phone
/// token, C10), reusing `ctx.machine_id` when a previous step already seeded it (see
/// [`bootstrap_server`]'s own idempotency lookup) so a converging re-run updates the
/// SAME row instead of minting a duplicate.
///
/// Deliberately does NOT call [`crate::ipc::commands::add_machine`] (B11 review
/// finding): that function's own pairing probe hard-requires `claude` to already be
/// installed on the target, so routing through it verbatim FAILED the whole pipeline
/// — never reaching `NeedsClaudeSignIn` — on every server that doesn't have `claude`
/// yet, which is every one of the brief's own fixtures and the primary "bootstrap a
/// fresh box" use case. By this point in the pipeline, reachability is ALREADY proven
/// ([`StepId::Probe`] succeeded) and "claude missing" is handled by [`StepId::
/// InstallClaude`] (B14), which runs right after `Probe` and — unlike `ClaudeAuth` —
/// FAILS the whole pipeline early when it cannot install/find a working `claude` (a
/// server that cannot run Claude Code cannot usefully run the rest of this pipeline
/// either). `ClaudeAuth` therefore only ever sees a `claude` `InstallClaude` already
/// confirmed or installed — gating pairing on presence again here would just
/// duplicate a check `InstallClaude` already made authoritative.
async fn step_add_machine(app: &tauri::AppHandle, req: &StoredBootstrapRequest, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let identity_file = match ctx.lock().await.identity_file.clone() {
        Some(i) => i,
        None => return StepOutcome::Failed("no key available".to_string()),
    };
    let existing_machine_id = ctx.lock().await.machine_id.clone();
    let candidates = probe_candidates(&req.host, None);
    // Same ssh-option-injection guard `add_machine` runs before ever persisting —
    // `Store::upsert_machine` re-checks this too (belt and suspenders), but failing
    // here gives the SAME friendly message `add_machine` would rather than a raw SQL
    // conversion error surfacing from the store layer instead.
    if let Err(e) = candidates.iter().try_for_each(|c| crate::store::validate_address_value(&c.value)) {
        return StepOutcome::Failed(e);
    }
    match persist_paired_machine(
        app,
        existing_machine_id,
        req.label.clone(),
        req.host.clone(),
        req.port,
        req.user.clone(),
        Some(identity_file),
        candidates,
    )
    .await
    {
        Ok(machine) => {
            ctx.lock().await.machine_id = Some(machine.id.clone());
            StepOutcome::Ok(Some(machine.id))
        }
        Err(e) => StepOutcome::Failed(e),
    }
}

/// [`StepId::Diagnose`] — the final health check, against the now-PERSISTED
/// [`MachineRecord`] (not the synthetic one earlier steps used).
async fn step_diagnose(app: &tauri::AppHandle, ctx: &Arc<Mutex<PipelineCtx>>) -> StepOutcome {
    let machine_id = match ctx.lock().await.machine_id.clone() {
        Some(id) => id,
        None => return StepOutcome::Failed("no paired server to diagnose".to_string()),
    };
    let machine = match app.state::<Store>().machine_by_id(&machine_id) {
        Ok(Some(m)) => m,
        Ok(None) => return StepOutcome::Failed("the server vanished mid-bootstrap".to_string()),
        Err(e) => return StepOutcome::Failed(e.to_string()),
    };
    let known_hosts = known_hosts_path(app);
    let diagnosis = with_bundled_version(app, diagnose(&machine, known_hosts.as_deref()).await);
    let detail = format!("{:?}", diagnosis.state);
    ctx.lock().await.diagnosis = Some(diagnosis);
    StepOutcome::Ok(Some(detail))
}

// ============================================================================
// Pipeline assembly + public report + tauri commands
// ============================================================================

/// See the module doc's overview. Order is FIXED — the whole point of the pipeline.
/// The pipeline's step order — the ONE source of truth [`build_pipeline`] is checked
/// against (debug builds) and the front's `STEP_ORDER` mirrors. Load-bearing
/// constraints, each pinned by a test: [`StepId::RunInit`] runs AFTER
/// [`StepId::UploadDaemon`] (it executes the uploaded binary) and BEFORE
/// [`StepId::InstallService`] (the service's own "did it come up" check needs the
/// config `init` writes); [`StepId::Probe`] runs BEFORE `RunInit` (probing after it
/// would see our own fresh `config.json` as a pre-existing conflict and adopt).
pub(crate) const PIPELINE_ORDER: [StepId; 10] = [
    StepId::InstallKey,
    StepId::Probe,
    StepId::InstallClaude,
    StepId::UploadDaemon,
    StepId::RunInit,
    StepId::InstallService,
    StepId::EscalatePersistence,
    StepId::ClaudeAuth,
    StepId::AddMachine,
    StepId::Diagnose,
];

fn build_pipeline(
    app: tauri::AppHandle,
    req: StoredBootstrapRequest,
    password: Option<SecretString>,
    confirmed_host_key: Option<String>,
    sudo_password: Option<SecretString>,
    ctx: Arc<Mutex<PipelineCtx>>,
) -> Vec<PipelineStep> {
    let steps = vec![
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::InstallKey, move || async move {
                step_install_key(&app, &req, password.as_ref(), confirmed_host_key.as_deref(), &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::Probe, move || async move { step_probe(&app, &req, &ctx).await })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::InstallClaude, move || async move {
                step_install_claude(&app, &req, &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            // Cloned (not moved) — `EscalatePersistence`'s own closure below is the
            // LAST user of `sudo_password` and takes ownership of it.
            let upload_sudo_password = sudo_password.clone();
            PipelineStep::new(StepId::UploadDaemon, move || async move {
                step_upload_daemon(&app, &req, upload_sudo_password.as_ref(), &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::RunInit, move || async move { step_run_init(&app, &req, &ctx).await })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::InstallService, move || async move {
                step_install_service(&app, &req, &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::EscalatePersistence, move || async move {
                step_escalate_persistence(&app, &req, sudo_password.as_ref(), &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::ClaudeAuth, move || async move { step_claude_auth(&app, &req, &ctx).await })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::AddMachine, move || async move { step_add_machine(&app, &req, &ctx).await })
        },
        {
            let (app, ctx) = (app, ctx);
            PipelineStep::new(StepId::Diagnose, move || async move { step_diagnose(&app, &ctx).await })
        },
    ];
    debug_assert_eq!(
        steps.iter().map(|s| s.id).collect::<Vec<_>>(),
        PIPELINE_ORDER.to_vec(),
        "build_pipeline drifted from PIPELINE_ORDER"
    );
    steps
}

/// The full outcome of one `bootstrap_server`/`bootstrap_resume` call.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BootstrapReport {
    pub session_id: String,
    pub host: String,
    pub steps: Vec<StepState>,
    /// `Some(step)` only when the run is PAUSED and resumable at `step` — see the
    /// module doc's "two different kinds of needs-input".
    pub needs_input: Option<StepId>,
    pub machine_id: Option<String>,
    pub diagnosis: Option<ServerDiagnosis>,
}

fn emit_progress(app: &tauri::AppHandle, session_id: &str, host: &str, states: &[StepState]) {
    use tauri_specta::Event;
    let ev = crate::ipc::events::BootstrapProgressEvent {
        session_id: session_id.to_string(),
        host: host.to_string(),
        steps: states.iter().map(StepState::to_wire).collect(),
    };
    if let Err(e) = ev.emit(app) {
        eprintln!("[bootstrap::orchestrator] failed to emit bootstrap_progress event: {e}");
    }
}

/// `existing_machine`: a [`MachineRecord`] ALREADY paired against this exact
/// (host, port, user) — see [`bootstrap_server`]'s own lookup — pre-seeds the
/// pipeline's [`PipelineCtx`] with its id/identity file so a converging re-run
/// ([`step_install_key`] reuses the already-working key, [`step_add_machine`] updates
/// the SAME row) never mints a second, duplicate [`MachineRecord`] for a server this
/// Mac already bootstrapped (B11 review finding). `None` for a genuinely first-contact
/// host, or when the caller (`bootstrap_resume`) has no fresher match than what its
/// own paused session already carries forward through the (unaffected) resume path.
///
/// `lock_guard`: this run's [`ServerLockGuard`] (B_lifecycle-#7 review finding) —
/// `bootstrap_server` freshly [`ServerLockGuard::acquire`]d it, `bootstrap_resume`
/// [`ServerLockGuard::adopt`]ed the SAME key an earlier paused call already claimed.
/// Released normally (drop) once the run actually FINISHES; kept claimed (see
/// [`ServerLockGuard::into_forgotten_key`]) when it pauses again instead.
#[allow(clippy::too_many_arguments)]
async fn run_pipeline_and_register(
    app: &tauri::AppHandle,
    sessions: &BootstrapSessions,
    session_id: String,
    req: StoredBootstrapRequest,
    password: Option<SecretString>,
    confirmed_host_key: Option<String>,
    sudo_password: Option<SecretString>,
    existing_machine: Option<MachineRecord>,
    lock_guard: ServerLockGuard,
) -> BootstrapReport {
    let ctx = Arc::new(Mutex::new(PipelineCtx {
        identity_file: existing_machine.as_ref().and_then(|m| m.identity_file.clone()),
        machine_id: existing_machine.as_ref().map(|m| m.id.clone()),
        ..Default::default()
    }));
    let steps =
        build_pipeline(app.clone(), req.clone(), password, confirmed_host_key, sudo_password.clone(), ctx.clone());
    let app_for_progress = app.clone();
    let host = req.host.clone();
    let session_id_for_progress = session_id.clone();
    let lock_key = lock_guard.key().to_string();
    // B_lifecycle-#8: the id [`StoredSession::machine_id`] carries forward for a
    // resume, if this run pauses — the INITIAL `existing_machine` (the SAME value
    // `PipelineCtx.machine_id` above was just seeded with), not `final_ctx.machine_id`
    // below: a pause always happens BEFORE `StepId::AddMachine` runs (see the module
    // doc's step order), so the two only ever differ for a run that DIDN'T pause,
    // where this field goes unused anyway (the session is deregistered instead).
    let machine_id_for_session = existing_machine.as_ref().map(|m| m.id.clone());
    let (states, needs_input) = drive_and_register(
        sessions,
        session_id.clone(),
        req.clone(),
        sudo_password,
        lock_key,
        machine_id_for_session,
        steps,
        |states| {
            emit_progress(&app_for_progress, &session_id_for_progress, &host, states);
        },
    )
    .await;
    let final_ctx = ctx.lock().await;
    // B_lifecycle-#6 review finding: a completed run (`needs_input: None` — paused
    // sessions haven't finished anything yet) may have uploaded/upgraded this
    // machine's `flightdeckd` (`step_upload_daemon`'s own RESTART RULE), so drop
    // whatever `crate::ipc::commands::DAEMON_VERSION_CACHE` still holds for it from an
    // earlier spawn THIS SAME APP RUN — same reasoning as `repair`'s own invalidation,
    // for the guided-install path instead of the Repair buttons. Harmless (a plain
    // cache miss) when nothing was ever cached, or nothing changed.
    //
    // Review fix (lock-order): this MUST run before the [`ServerLocks`] release just
    // below, not after — `ctx.lock().await` above is a genuine yield point, so
    // releasing the per-server lock first and invalidating the cache after it would
    // let a second run claim the freshly-freed lock and re-probe a FRESH daemon
    // version in that window, only for this call's now-late invalidation to wipe that
    // fresh entry right back out.
    if needs_input.is_none() {
        if let Some(id) = &final_ctx.machine_id {
            invalidate_daemon_version_cache(id);
        }
    }
    // B_lifecycle-#7 review finding: release the per-server lock now the run has
    // actually FINISHED (`needs_input.is_none()` — the same condition
    // `drive_and_register` itself uses to decide the session is done, Ok or Failed
    // alike); a PAUSED run keeps its claim alive across the whole pause instead —
    // `bootstrap_resume`'s own eventual completion, or `bootstrap_cancel`, releases it
    // later (`StoredSession::lock_key`, already stored above via `sessions.start`).
    if needs_input.is_none() {
        drop(lock_guard);
    } else {
        lock_guard.into_forgotten_key();
    }
    BootstrapReport {
        session_id,
        host: req.host,
        steps: states,
        needs_input,
        machine_id: final_ctx.machine_id.clone(),
        diagnosis: final_ctx.diagnosis.clone(),
    }
}

fn machine_by_id(app: &tauri::AppHandle, machine_id: &str) -> Result<MachineRecord, String> {
    app.state::<Store>().machine_by_id(machine_id).map_err(|e| e.to_string())?.ok_or_else(|| "unknown server".to_string())
}

/// Start (or, on retry, re-run from scratch — every step is idempotent) the full
/// bootstrap pipeline. See the module doc.
///
/// Looks up a [`MachineRecord`] ALREADY paired at this exact (`host`, `port`, `user`)
/// BEFORE running anything (see [`run_pipeline_and_register`]'s own doc) — the
/// convergence a bare re-run needs (B11 review finding): without it, a second call
/// against an already-fully-paired server would generate and try to install a brand
/// new key (the shared "pending" one was already claimed/renamed by the first run's
/// `AddMachine` step) and persist a SECOND, duplicate `MachineRecord` for the same
/// host under a fresh uuid, rather than converging on the one that already exists.
///
/// Claims this host's [`ServerLocks`] slot (B_lifecycle-#7 review finding) BEFORE
/// running a single ssh round trip — `Err` with [`server_busy_error`] when
/// `bootstrap_server`/`bootstrap_resume`/`machine_repair` already has one in flight
/// against the same server, rather than racing it (the previous behaviour: two
/// concurrent runs could interleave key installs/daemon uploads/unit writes/restarts
/// against the same host, the loser typically failing opaquely at its very last
/// step). Never blocks/waits.
///
/// `confirmed_host_key` (M12): the `SHA256:` fingerprint the wizard showed
/// (`bootstrap_check_host_key`) and the user confirmed — the ONLY key this run may then
/// send anything to (a `password`, and with or without one, every later step's sudo
/// password, Claude sign-in code and phone keys). Not needed for the saved key of an
/// address a paired server uses (and refused there too if it names another key);
/// required (or the install-key step stops before sending anything) for any other key,
/// saved or not.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn bootstrap_server(
    app: tauri::AppHandle,
    label: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    mask_sleep: bool,
    sudo_password: Option<String>,
    confirmed_host_key: Option<String>,
) -> Result<BootstrapReport, String> {
    // Validated BEFORE anything else — this is the very first place `host`/`user`
    // arrive from untrusted input (the wizard form, or a hostile pairing ticket's
    // pre-fill — see `ControlSection.tsx::parseTicket`'s doc) and BEFORE any ssh
    // process the pipeline's own steps spawn (CRM holistic-review blocker #3,
    // chantier A `bd7ca709`: `user` was validated NOWHERE before this fix). `port`
    // is a `u16` at this boundary already, but `0` is never a real listener.
    crate::store::validate_ssh_user(&user)?;
    crate::store::validate_address_value(&host)?;
    crate::store::validate_ssh_port(port)?;
    // Read off `app` rather than taken as `tauri::State` parameters: specta types
    // commands of at most 10 arguments.
    let sessions = app.state::<Arc<BootstrapSessions>>();
    let locks = app.state::<Arc<ServerLocks>>();
    let session_id = uuid::Uuid::new_v4().to_string();
    let req =
        StoredBootstrapRequest { label, host, port, user, mask_sleep, confirmed_host_key: confirmed_host_key.clone() };
    let password = password.map(SecretString::new);
    let sudo_password = sudo_password.map(SecretString::new);
    let existing_machine =
        app.state::<Store>().machine_by_address(&req.host, req.port, &req.user).map_err(|e| e.to_string())?;
    let lock_key = server_lock_key(existing_machine.as_ref().map(|m| m.id.as_str()), &req.host, req.port, &req.user);
    let guard = ServerLockGuard::acquire(&locks, lock_key, "Add a server").map_err(server_busy_error)?;
    Ok(run_pipeline_and_register(
        &app,
        &sessions,
        session_id,
        req,
        password,
        confirmed_host_key,
        sudo_password,
        existing_machine,
        guard,
    )
    .await)
}

/// The [`MachineRecord`] `bootstrap_resume` continues against (B_lifecycle-#8 review
/// finding) — BY ID when `machine_id` is `Some` (the paused session's own
/// [`StoredSession::machine_id`]), which survives a live address rotation the frozen
/// `(host, port, user)` tuple would not. Falls back to the address lookup ONLY when no
/// id was ever recorded (a genuinely first-contact host). A recorded id that no longer
/// resolves (the machine was removed while this session sat paused) is `Ok(None)` —
/// NOT a fallback to the address lookup, which could otherwise silently latch onto an
/// unrelated machine that happens to occupy that address now. Takes `&Store` rather
/// than an `AppHandle` so this policy is unit-tested directly (`Store::open_in_memory`)
/// without a full Tauri app.
fn resolve_resume_machine(
    store: &Store,
    machine_id: Option<&str>,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Option<MachineRecord>, String> {
    match machine_id {
        Some(id) => store.machine_by_id(id).map_err(|e| e.to_string()),
        None => store.machine_by_address(host, port, user).map_err(|e| e.to_string()),
    }
}

/// Rebuild `req`'s connection coordinates from `machine`'s CURRENT row before the
/// resumed pipeline dials anything — residual defect A8/R2 (CRM `1abfc028`,
/// counter-verification of the B_lifecycle-#8 fix). [`resolve_resume_machine`] above
/// correctly re-finds the right [`MachineRecord`] BY ID, surviving a live address
/// rotation (`Store::set_machine_preferred_host`) that happened while this run sat
/// paused — but until this existed, the resumed pipeline still dialed whatever
/// `(host, port, user)` the FROZEN `req` carried from `bootstrap_server`'s ORIGINAL
/// call, since [`run_pipeline_and_register`] only ever read `identity_file`/`machine_id`
/// off `existing_machine`, never its connection coordinates (every step closes over
/// `req`, not `existing_machine` — see [`build_pipeline`]). A resume after a genuine
/// rotation (the old address stopped answering, which is exactly why it rotated) would
/// then still fail `verify_key_works` against the stale host and — `bootstrap_resume`
/// always passing `password: None` — surface the same misleading "needs its login
/// password" [`step_install_key`] error this fix's own doc claims to eliminate.
///
/// A `None` machine (a genuinely first-contact host, or one removed while this session
/// sat paused) leaves `req` untouched — there is no fresher row to prefer over what the
/// paused session already carries forward, exactly as before this fix. The row's
/// `host`/`port`/`user` were already validated when they were written (`add_machine`/
/// `set_machine_preferred_host`), so no re-validation happens here — this only ever
/// copies values already known-safe. Private (not `pub(crate)`): `StoredBootstrapRequest`
/// itself is private to this module, so this is unit-tested directly from the same
/// module's own `tests` submodule, mirroring [`resolve_resume_machine`]'s own split
/// from the Tauri-aware command.
fn sync_resume_request_to_machine(req: &mut StoredBootstrapRequest, machine: Option<&MachineRecord>) {
    if let Some(machine) = machine {
        req.host = machine.host.clone();
        req.port = machine.port;
        req.user = machine.user.clone();
    }
}

/// [`resolve_resume_machine`] + [`sync_resume_request_to_machine`], collapsed into the
/// ONE call [`bootstrap_resume`] makes (test-honesty residual defect, CRM `1abfc028`,
/// counter-verification of the A8/R2 fix above): with those as two independent call
/// sites, a future refactor could drop the sync half alone and the existing tests —
/// which only exercised the two pure helpers in isolation, never anything resembling
/// what `bootstrap_resume` itself does — would stay green right through the exact
/// stale-host regression reappearing (verified: deleting just the sync call left the
/// full `cargo test --lib bootstrap::orchestrator::` suite passing). There is now
/// exactly one call site left for `bootstrap_resume` to make, and this function's own
/// unit test below exercises the pair together the same way it actually invokes them —
/// a `#[tauri::command]`-level test remains out of reach (this crate's `tauri`
/// dependency has no `test` feature/dev-dependency override to build a `mock_builder`
/// app from, and faking every ssh round trip the full pipeline's steps make would be a
/// separate, much larger undertaking), so this is the closest unit test can get to the
/// real wiring without that harness.
fn resolve_and_sync_resume_machine(
    store: &Store,
    machine_id: Option<&str>,
    req: &mut StoredBootstrapRequest,
) -> Result<Option<MachineRecord>, String> {
    let machine = resolve_resume_machine(store, machine_id, &req.host, req.port, &req.user)?;
    sync_resume_request_to_machine(req, machine.as_ref());
    Ok(machine)
}

/// Resume a run paused at a BLOCKING step (today: [`StepId::EscalatePersistence`]
/// needing a sudo password) — re-runs the same, idempotent pipeline with
/// `sudo_password` now available.
///
/// Re-finds the [`MachineRecord`] the paused session already converged on via
/// [`resolve_resume_machine`] — BY ID when the ORIGINAL `bootstrap_server` call found
/// one (`StoredSession::machine_id`), never by re-deriving `(host, port, user)` from
/// the FROZEN request the session was paused under (B_lifecycle-#8 review finding: A6's
/// live address-rotation, `Store::set_machine_preferred_host`, can rewrite that same
/// row's `host` column WHILE this session sits paused — an address lookup would then
/// find nothing and this resume would proceed as if pairing a brand-new host, which,
/// with B_lifecycle-#1 unfixed, minted a duplicate). Falls back to the address lookup
/// [`bootstrap_server`] itself uses ONLY when no id was ever recorded — a genuinely
/// first-contact host, paused before [`StepId::AddMachine`] had ever run once — which
/// also covers a completely separate, already-finished pairing for that host existing
/// by the time this resume happens (e.g. the same host paired again through a
/// different session while this one sat paused).
///
/// [`ServerLocks`]: REUSES (never re-claims) the [`ServerLockGuard`] the original
/// `bootstrap_server` call claimed and left held across the pause (B_lifecycle-#7) —
/// see [`BootstrapSessions::resume`]'s own `lock_key`. A fresh `claim` here would
/// simply collide with this very session's own still-held lock. That key is the
/// MACHINE id whenever one was already known at the ORIGINAL `bootstrap_server` call
/// (see [`server_lock_key`]) — carried forward verbatim from `StoredSession::lock_key`,
/// never re-derived here, so [`resolve_and_sync_resume_machine`]'s own coordinate
/// rewrite below can never disturb which lock this run holds.
///
/// [`resolve_and_sync_resume_machine`]: residual defect A8/R2 (CRM `1abfc028`) — once
/// [`resolve_resume_machine`] re-finds the right, possibly-rotated [`MachineRecord`],
/// its CURRENT `host`/`port`/`user` are copied onto the resumed `req` BEFORE the
/// pipeline is built, so every step dials where the machine is reachable TODAY, not
/// wherever it was when this session originally paused — see that function's own doc.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_resume(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, Arc<BootstrapSessions>>,
    locks: tauri::State<'_, Arc<ServerLocks>>,
    session_id: String,
    sudo_password: Option<String>,
) -> Result<BootstrapReport, String> {
    let sudo_password = sudo_password.map(SecretString::new);
    let (mut req, resolved_password, lock_key, machine_id) = sessions.resume(&session_id, sudo_password).await?;
    let existing_machine = resolve_and_sync_resume_machine(&app.state::<Store>(), machine_id.as_deref(), &mut req)?;
    let guard = ServerLockGuard::adopt(&locks, lock_key);
    // No login password on a resume (see `StoredBootstrapRequest`'s doc). The host key is
    // still checked: against the fingerprint the first call confirmed, the key that run
    // pinned being nobody's paired server's until `AddMachine` ran.
    let confirmed_host_key = req.confirmed_host_key.clone();
    Ok(run_pipeline_and_register(
        &app,
        &sessions,
        session_id,
        req,
        None,
        confirmed_host_key,
        resolved_password,
        existing_machine,
        guard,
    )
    .await)
}

/// Abandon a run paused at a blocking step — see [`BootstrapSessions::cancel`]. Also
/// releases the [`ServerLocks`] claim that paused run left held (B_lifecycle-#7 review
/// finding) — no-op when nothing was paused under this id.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_cancel(
    sessions: tauri::State<'_, Arc<BootstrapSessions>>,
    locks: tauri::State<'_, Arc<ServerLocks>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(lock_key) = sessions.cancel(&session_id).await {
        locks.release(&lock_key);
    }
    Ok(())
}

// ============================================================================
// diagnose
// ============================================================================

/// See [`StepId::AddMachine`]'s doc — probes BOTH unit locations, never assumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum InstalledAs {
    System,
    User,
    /// macOS only: a `~/Library/LaunchAgents/*.plist` that runs `flightdeckd` inside the
    /// logged-in user's `gui/<uid>` session — the ONLY shape that works on a Mac, since
    /// `claude` keeps its login in the Keychain and a daemon started from SSH can't
    /// read it. Never INSTALLED by this app (the installer is Linux-only): a Mac server
    /// is set up by hand, then added through "Connect an existing server". Once there,
    /// this app can UPDATE it — [`RepairAction::ReuploadDaemon`] replaces the binary the
    /// agent runs, when [`ServerDiagnosis::mac_daemon_update`] says it can
    /// ([`judge_mac_update`]), and [`RepairAction::RestartDaemon`] restarts the agent.
    LaunchAgent,
    Detached,
    None,
    Unknown,
}

/// `uname -s` of a Mac — the one non-Linux host the diagnosis knows how to read.
pub(crate) const MACOS_UNAME: &str = "Darwin";

/// Why the bundled installer can't touch a host whose `uname -s` is `os` — `None` for
/// Linux AND for an unknown OS (an old probe that never reported it keeps today's
/// behaviour rather than being refused on a guess). Shared by the wizard's
/// [`StepId::Probe`] — a FRESH install, which a Mac never gets (its daemon has to be a
/// LaunchAgent of the logged-in user, set up by hand) — and
/// [`RepairAction::ReuploadDaemon`] on any host that is neither Linux nor a Mac. A
/// Mac's re-upload is the one exception, and only as an UPDATE of an existing
/// LaunchAgent install ([`reupload_route`]): the diagnosis's own verdict
/// ([`ServerDiagnosis::mac_daemon_update`]) gates it instead. Before this, a Mac (Intel)
/// passed the arch check and was sent the LINUX binary.
pub(crate) fn linux_only_installer_refusal(os: Option<&str>) -> Option<String> {
    match os.map(str::trim) {
        None | Some("") | Some("Linux") => None,
        Some(MACOS_UNAME) => Some(
            "this server runs macOS — Flight Deck's installer only sets up Linux servers. Install \
             flightdeckd on the Mac by hand (as a LaunchAgent), then use \"Connect an existing server\"."
                .to_string(),
        ),
        Some(other) => Some(format!(
            "this server runs {other} — Flight Deck's installer only sets up Linux servers. Install \
             flightdeckd by hand, then use \"Connect an existing server\"."
        )),
    }
}

/// The single headline verdict [`collapse_state`] reduces every independent fact to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiagnosisState {
    Ready,
    /// (B14) `claude` itself is missing — distinct from [`Self::NeedsClaudeSignIn`]
    /// (installed but signed out): [`RepairAction::InstallClaude`] is the fix here,
    /// [`RepairAction::SignInClaude`] there. See [`collapse_state`]'s doc.
    NeedsClaudeInstall,
    NeedsClaudeSignIn,
    RunningNotRebootSafe,
    Failed { reason: String },
}

/// What "Update the daemon" ([`RepairAction::ReuploadDaemon`]) can do on a Mac — see
/// [`ServerDiagnosis::mac_daemon_update`], and [`judge_mac_update`] for the rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MacDaemonUpdate {
    /// It can: an upload replaces `target`, the very binary the Mac's one flightdeckd
    /// LaunchAgent runs — and the one Flight Deck's own commands run there.
    Ready { target: String },
    /// It can't — `reason`, in the user's words, says why and what to do by hand.
    Blocked { reason: String },
}

/// One `machine_diagnose` result — every field besides [`Self::state`]/
/// [`Self::reachable`]/[`Self::restart_pending`] is TRI-STATE (`Option<...>`): a
/// missing/garbled marker in [`diagnose`]'s own accumulating script degrades to `None`
/// ("unknown"), never a false `Some(false)` — see [`parse_diagnosis_fields`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ServerDiagnosis {
    pub state: DiagnosisState,
    /// Did the ssh round trip reach the server AT ALL — the one fact that tells "this
    /// machine is off/unplugged/unroutable" apart from "it answered, and what it said
    /// is bad news".
    ///
    /// ⚠️ It exists as its own field because [`Self::state`] CANNOT carry it:
    /// [`collapse_state`] returns [`DiagnosisState::Failed`] for a perfectly reachable
    /// server whose `flightdeckd` is merely stopped or missing, so `Failed` means
    /// "broken", not "out of reach". The only other way to tell the two apart would be
    /// to match on `Failed`'s `reason` STRING, which would silently turn a reworded
    /// message into a wrong verdict — the same trap the `tosse` module's
    /// `SESSION_GONE_MARKERS` contract exists to document.
    ///
    /// `false` whenever [`diagnose`]'s ssh invocation failed, timed out, or was never
    /// attempted (unusable saved connection details) — see [`ServerDiagnosis::
    /// unreachable`], the ONE constructor of that case. Read by the front's ambient
    /// machine-health poll (`store/machineHealth.ts`), which paints the remote mark on
    /// every repository that lives on this machine.
    pub reachable: bool,
    /// WHY the ssh round trip itself failed — `None` only when [`Self::reachable`] is
    /// `true` (a reachable server has nothing to classify here; see
    /// [`ServerDiagnosis::unreachable_with`], the one constructor of every
    /// `reachable: false` diagnosis). Read by the front's `repairSuggestionsFor`
    /// (`key_refused` is the only one that offers a repair, [`RepairAction::
    /// ReconnectMac`]) and by its `headlineLabel` for the bucket-specific sentence —
    /// see [`SshLinkIssue`]'s own doc for why there are only three buckets.
    pub link_issue: Option<SshLinkIssue>,
    /// This Mac's OWN local Tailscale state — `Some(true)` ONLY on positive local
    /// evidence (`tailscale::local_status()` confirmed `NotRunning`), never inferred
    /// or guessed; `None` otherwise, including every `reachable: true` diagnosis. See
    /// [`crate::tailscale`]'s own module doc.
    pub tailscale_off_locally: Option<bool>,
    /// The server's `uname -s` (`"Linux"`, `"Darwin"`…) — `None` when unreachable or
    /// not reported. Decides which half of [`DIAGNOSE_SCRIPT_BODY`]'s markers apply:
    /// on [`MACOS_UNAME`] every systemd fact stays `None` and the macOS ones below are
    /// read instead, and [`repair`] refuses the systemd-only fixes
    /// ([`repair_unsupported_on_host`]).
    pub host_os: Option<String>,
    /// The server's `uname -m` (`"x86_64"`, `"aarch64"`, a Mac's `"arm64"`…) — `None`
    /// when unreachable or not reported. With [`Self::host_os`], picks the bundled
    /// daemon build that fits it ([`Self::bundled_daemon_for_host`]).
    pub host_arch: Option<String>,
    pub installed_as: InstalledAs,
    /// `Some(true)` when `flightdeckd status` answered from the SSH login. `Some(false)`
    /// ONLY when it reached no daemon AND nothing else runs one either
    /// ([`Self::daemon_process_seen`] is `Some(false)`) — the one state in which a
    /// restart can't cut a live conversation off ([`restart_plan`]). `None` otherwise:
    /// a daemon is seen running but its status can't be read from this login, the
    /// server couldn't list its processes, or the status answer was garbled.
    pub daemon_running: Option<bool>,
    /// A `flightdeckd run` process of the SSH user runs on the server
    /// ([`DAEMON_PROCESS_ERE`], through `pgrep`), or systemd reports a flightdeckd unit
    /// active — read independently of `flightdeckd status`, which answers nothing for
    /// a daemon whose socket or binary is gone. Only this user's processes count: no
    /// restart can touch another user's daemon (`systemctl --user`, the user's own
    /// `gui/<uid>` domain, `pkill -u`), and a system unit run as someone else is the
    /// active-unit check. `Some(false)` when the check ran and found none; `None` when
    /// it couldn't run ([`Self::daemon_process_check_error`] says why).
    pub daemon_process_seen: Option<bool>,
    /// Why [`Self::daemon_process_seen`] is `None`: the process check itself failed —
    /// no `pgrep` on the server (a minimal image without procps), or one that rejects
    /// its options (BusyBox), with `pgrep`'s own words or exit status. `None` whenever
    /// the check answered, or a unit systemd reports active answered for it.
    pub daemon_process_check_error: Option<String>,
    pub daemon_version_disk: Option<String>,
    pub daemon_version_running: Option<String>,
    /// `true` only when BOTH versions are known and differ — an upload landed new
    /// bytes that the currently-running process hasn't picked up yet.
    pub restart_pending: bool,
    /// On a Mac ([`InstalledAs::LaunchAgent`]): the agent is set to start at login
    /// ([`Self::agent_starts_at_login`]) AND the Mac logs this user in by itself
    /// ([`Self::auto_login`]) — without automatic login, nothing runs after a reboot
    /// until someone logs in at the Mac.
    pub reboot_safe: Option<bool>,
    /// macOS only: `autoLoginUser` is this SSH user, so the `gui/<uid>` session (and
    /// with it the LaunchAgent) comes back on its own after a reboot. `None` on Linux.
    pub auto_login: Option<bool>,
    /// macOS only: launchd starts the LaunchAgent when the user logs in — its plist sets
    /// `RunAtLoad` or `KeepAlive` to `true`, or `KeepAlive` is a dictionary holding
    /// `SuccessfulExit` (which implies `RunAtLoad`, launchd.plist(5)). A `KeepAlive`
    /// dictionary of other conditions (`NetworkState`, `PathState`…) is `None`: whether
    /// they hold at login is unknown. `None` on Linux, without an agent, or when several
    /// agents run flightdeckd ([`Self::launch_agent_plists`]).
    pub agent_starts_at_login: Option<bool>,
    /// macOS only: every `~/Library/LaunchAgents` plist that runs flightdeckd — the job
    /// launchd runs as the daemon right now, else a command or wrapper script that
    /// starts `flightdeckd run`, else a `Label` or log file named after it (see
    /// [`MAC_AGENT_PLIST_FN`]). More than one is ambiguous — which one
    /// launchd keeps running is not Flight Deck's to guess — so [`Self::installed_as`]
    /// stays [`InstalledAs::LaunchAgent`] while [`Self::agent_starts_at_login`] and
    /// [`Self::reboot_safe`] stay `None`, and [`RepairAction::RestartDaemon`] refuses,
    /// naming the files. Empty on Linux and when no agent was found.
    pub launch_agent_plists: Vec<String>,
    /// macOS only: `~/Library/LaunchAgents` plists that mention flightdeckd but can't be
    /// parsed (`plutil -lint` fails) — launchd can't load them, and whether they would
    /// run flightdeckd is unknown, so they are never counted in
    /// [`Self::launch_agent_plists`]. Reported so the card can say so: such a plist is
    /// usually the agent the user meant to set up. Empty on Linux.
    pub invalid_launch_agent_plists: Vec<String>,
    /// macOS only: whether "Update the daemon" ([`RepairAction::ReuploadDaemon`]) can
    /// replace the binary this Mac's flightdeckd LaunchAgent runs — [`judge_mac_update`]'s
    /// verdict on what the diagnosis read there: the agent, what it runs, where an upload
    /// would land, what Flight Deck's own commands run, whether this login can write
    /// there. `None` on Linux and when unreachable. The panel offers the button only on
    /// [`MacDaemonUpdate::Ready`], and shows [`MacDaemonUpdate::Blocked`]'s reason instead
    /// — a control that can't work is never offered. [`repair`] goes by a FRESH
    /// diagnosis's verdict, and the upload writes nothing but the path it approved.
    pub mac_daemon_update: Option<MacDaemonUpdate>,
    /// The RAW `loginctl show-user -p Linger` marker — a sub-fact
    /// [`reboot_safe`](Self::reboot_safe) already folds in for a User-level install
    /// (which also needs its unit `enabled`), exposed on its own so [`repair`]'s
    /// `EnableLinger` summary can report "already enabled" precisely instead of a
    /// fixed claim (B11 review finding). Read unconditionally by [`diagnose_script`]
    /// regardless of [`installed_as`](Self::installed_as) — like
    /// [`sleep_masked`](Self::sleep_masked), it is meaningful only for a User-level
    /// install, but is never itself gated on that (never a false `Some(false)`
    /// manufactured for an install kind it doesn't apply to).
    pub linger: Option<bool>,
    /// The server won't suspend on its own: `sleep.target` masked (Linux), or on a Mac
    /// `pmset` `SleepDisabled 1` — or `sleep 0` on a Mac with no battery (a laptop
    /// still sleeps on a closed lid without `SleepDisabled`).
    pub sleep_masked: Option<bool>,
    /// (B14) `true` when a `~/.config/systemd/user/flightdeckd.service` unit EXISTS but
    /// lacks its `Environment=PATH=` line (the pre-B14 template never wrote one) — a
    /// daemon started this way cannot resolve `claude` at all if it only lives in
    /// `~/.local/bin` (never on the unit's own minimal PATH). `None` when no user unit
    /// exists at all ([`InstalledAs`] isn't [`InstalledAs::User`]) — meaningless there,
    /// never a manufactured `Some(false)`, same discipline as
    /// [`sleep_masked`](Self::sleep_masked)/[`linger`](Self::linger). Read unconditionally
    /// by [`diagnose_script`] regardless of [`installed_as`](Self::installed_as).
    /// [`RepairAction::InstallService`] fixes it — re-running [`install::install_service`]
    /// against an already-User install re-renders (and overwrites) the unit file with
    /// [`crate::bootstrap::templates::render_user_unit`]'s current (PATH-including)
    /// template.
    pub user_unit_missing_path: Option<bool>,
    pub claude_installed: Option<bool>,
    /// Linux: `claude auth status --json`. ⚠️ macOS: that command ALWAYS answers
    /// `loggedIn:false` over SSH (the session can't read the login Keychain, while the
    /// daemon's `gui/<uid>` claude can) — so a Mac reports whether Claude's credential
    /// item EXISTS in the Keychain (or `~/.claude/.credentials.json` does) instead,
    /// without ever reading the secret. No `claude_email` on a Mac.
    pub claude_logged_in: Option<bool>,
    pub claude_email: Option<String>,
    /// Why [`Self::claude_logged_in`] is `None` when the check itself FAILED rather than
    /// answered — macOS: the Keychain lookup exited with something other than found (0)
    /// or not found (44), e.g. `"the Keychain lookup failed (security exit 36)"`.
    /// `None` whenever the check completed, and always on Linux.
    pub claude_login_check_error: Option<String>,
    pub tailscale_name: Option<String>,
    pub last_boot: Option<String>,
    /// Conversations a daemon restart would cut short — a turn, background work or a
    /// pending request (see `status_row_at_work`); `None` when unknown, never assumed 0.
    pub busy_conversations: Option<u32>,
    /// (B2/B3) This Mac's OWN bundled `flightdeckd` version (from [`install::
    /// bundled_daemon_manifest`]) — NEVER read off the remote server, so it is folded in
    /// by [`with_bundled_version`] AFTER [`diagnose`]'s ssh round trip, not inside
    /// [`parse_diagnosis_fields`] (which has no [`tauri::AppHandle`] to read it from —
    /// see the module doc's "`diagnose` / `repair`" section). `None` when this build has
    /// no daemon bundled at all (a fresh clone, no `pnpm daemon:build` ever run).
    pub bundled_daemon_version: Option<String>,
    /// `true` only when BOTH [`Self::daemon_version_running`] and
    /// [`Self::bundled_daemon_version`] are known, the bundled one is strictly newer, AND
    /// the disk doesn't hold it yet — the server needs [`RepairAction::ReuploadDaemon`] to
    /// catch up. Once an upload has landed ([`Self::daemon_version_disk`] at least the
    /// bundled one) it is `false`, and [`Self::restart_pending`] carries the one step
    /// left, [`RepairAction::RestartDaemon`]. See [`daemon_is_outdated`].
    pub daemon_outdated: bool,
    /// Whether this Mac's app BUNDLES a `flightdeckd` build it can upload to this server
    /// — one for [`Self::host_os`]/[`Self::host_arch`], with a manifest entry to verify it
    /// against ([`install::bundled_daemon_for_host`]). Folded in by
    /// [`with_bundled_version`] like [`Self::bundled_daemon_version`] (a fact about THIS
    /// Mac's bundle, never the server's). `None` when the server's OS/arch aren't known
    /// (unreachable). It is what lets the panel offer "Update the daemon" on a Mac only
    /// when the app carries a macOS build for that Mac — a build made where the macOS
    /// daemons can't be built carries none — and say why not otherwise.
    pub bundled_daemon_for_host: Option<bool>,
}

impl ServerDiagnosis {
    /// The whole-fields-unknown shape [`diagnose`] returns when the ssh round trip
    /// itself never even reached the server, with no more specific classification
    /// available (used only where [`Self::unreachable_with`] cannot apply — the
    /// destination-validation-failure early return in [`diagnose`], which never even
    /// spawns ssh). Every OTHER unreachable path goes through
    /// [`Self::unreachable_with`] instead, which this now delegates to.
    fn unreachable() -> Self {
        Self::unreachable_with(SshLinkIssue::Unreachable, None)
    }

    /// The whole-fields-unknown shape for an unreachable diagnosis, classified by
    /// `issue` (see [`SshLinkIssue`]) with `tailscale_off_locally` folded into the
    /// reason when it applies. The ONE constructor of every `reachable: false`
    /// [`ServerDiagnosis`] — see [`Self::link_issue`]'s own doc for why every such
    /// diagnosis carries `Some(issue)`, never `None`.
    fn unreachable_with(issue: SshLinkIssue, tailscale_off_locally: Option<bool>) -> Self {
        let reason = match issue {
            SshLinkIssue::KeyRefused => format!("this {MACHINE}'s saved key was refused"),
            SshLinkIssue::HostKeyChanged => {
                format!("this server's identity has changed since this {MACHINE} last connected to it")
            }
            SshLinkIssue::Unreachable if tailscale_off_locally == Some(true) => {
                format!("Tailscale looks off on this {MACHINE}")
            }
            SshLinkIssue::Unreachable => "could not reach the server".to_string(),
        };
        Self {
            state: DiagnosisState::Failed { reason },
            reachable: false,
            link_issue: Some(issue),
            tailscale_off_locally,
            host_os: None,
            host_arch: None,
            installed_as: InstalledAs::Unknown,
            daemon_running: None,
            daemon_process_seen: None,
            daemon_process_check_error: None,
            daemon_version_disk: None,
            daemon_version_running: None,
            restart_pending: false,
            reboot_safe: None,
            auto_login: None,
            agent_starts_at_login: None,
            launch_agent_plists: Vec::new(),
            invalid_launch_agent_plists: Vec::new(),
            mac_daemon_update: None,
            linger: None,
            sleep_masked: None,
            user_unit_missing_path: None,
            claude_installed: None,
            claude_logged_in: None,
            claude_email: None,
            claude_login_check_error: None,
            tailscale_name: None,
            last_boot: None,
            busy_conversations: None,
            bundled_daemon_version: None,
            daemon_outdated: false,
            bundled_daemon_for_host: None,
        }
    }
}

/// The static (non-interpolated) body of [`diagnose_script`] — everything after the two
/// lines that resolve `$FLIGHTDECKD_BIN`/`$CLAUDE_BIN` (kept as separate `format!`
/// arguments rather than inlined, so this constant's own literal `{`/`}` — e.g. `awk
/// '{print $2}'` — never has to be escaped for `format!`). Never `exit`s early — same
/// accumulating discipline as [`super::connect::PROBE_SCRIPT_BODY`]: every check below
/// runs regardless of any earlier one's outcome.
///
/// `claude` presence is checked via `$CLAUDE_BIN` (B14's shared
/// [`crate::ipc::commands::resolve_claude_bin_expr`]), never a bare `command -v claude`
/// — see that function's doc for why a bare check falsely reported a genuinely
/// installed, official-installer `claude` as missing. (Review fix) `FLIGHTDECK_CLAUDE_
/// INSTALLED` additionally requires `$CLAUDE_BIN --version` to actually SUCCEED, not
/// just be present/executable — a broken/corrupted install (wrong arch/libc, a
/// truncated download, a dangling `versions/` dir) must collapse to
/// [`DiagnosisState::NeedsClaudeInstall`] (so [`RepairAction::InstallClaude`]
/// re-installs over it) rather than [`DiagnosisState::NeedsClaudeSignIn`], which would
/// send a novice into a sign-in flow that can never succeed against a binary that
/// doesn't run.
const DIAGNOSE_SCRIPT_BODY: &str = r#"
# Runs "$@" for at most $FD_STEP_SECS seconds, then kills it: one command stuck on the
# server (a frozen daemon's socket that accepts and never answers, Tailscale.app asked
# from an ssh session) must not eat the whole diagnosis's deadline. The guard writes
# nowhere, so a `$(...)` around this never waits on it.
FD_STEP_SECS=${FD_STEP_SECS:-8}
fd_within() {
    "$@" &
    fd_within_pid=$!
    ( sleep "$FD_STEP_SECS"; kill -9 "$fd_within_pid" ) </dev/null >/dev/null 2>&1 &
    fd_within_guard=$!
    wait "$fd_within_pid"
    fd_within_rc=$?
    kill "$fd_within_guard" 2>/dev/null
    return "$fd_within_rc"
}
FD_OS=$(uname -s 2>/dev/null)
echo "FLIGHTDECK_OS:$FD_OS"
echo "FLIGHTDECK_ARCH:$(uname -m 2>/dev/null)"
if [ -n "$FLIGHTDECKD_BIN" ] && (command -v "$FLIGHTDECKD_BIN" >/dev/null 2>&1 || [ -x "$FLIGHTDECKD_BIN" ]); then
    echo FLIGHTDECK_BIN_PRESENT:yes
    echo "FLIGHTDECK_VERSION_DISK:$("$FLIGHTDECKD_BIN" --version 2>/dev/null)"
else
    echo FLIGHTDECK_BIN_PRESENT:no
    echo "FLIGHTDECK_VERSION_DISK:"
fi
STATUS_JSON=$(fd_within "$FLIGHTDECKD_BIN" status 2>/dev/null)
# printf, never echo, for JSON: the login shell runs this, and zsh's echo (a Mac's
# default) turns `\\` and `\n` inside JSON strings into real characters.
printf 'FLIGHTDECK_STATUS_JSON:%s\n' "$STATUS_JSON"
# Is this login's flightdeckd alive? `status` only reaches its socket: a daemon whose
# socket or binary is gone answers nothing there yet runs — and restarting it would cut
# its conversations off. This user's processes only (another user's daemon is out of
# any restart's reach), matched on the command line's FIRST words ($FD_DAEMON_RE): the
# shell running this script holds the whole script in its arguments, and an `attach`
# or `status` client is not the daemon. pgrep exits 1, saying nothing, when nothing
# matched; anything else — no pgrep, an option it lacks, an error — is unknown, and
# said why, never read as "no daemon".
FD_PGREP_ERR=$(pgrep -u "$(id -u)" -f "$FD_DAEMON_RE" 2>&1 >/dev/null)
FD_PGREP_EXIT=$?
if [ "$FD_PGREP_EXIT" = 0 ]; then
    echo FLIGHTDECK_DAEMON_PROCESS:yes
elif [ "$FD_PGREP_EXIT" = 1 ] && [ -z "$FD_PGREP_ERR" ]; then
    echo FLIGHTDECK_DAEMON_PROCESS:no
else
    echo "FLIGHTDECK_DAEMON_PROCESS:"
    FD_PGREP_ERR=$(printf '%s\n' "$FD_PGREP_ERR" | sed -n '/[^[:space:]]/{p;q;}')
    printf 'FLIGHTDECK_DAEMON_PROCESS_ERROR:%s\n' "${FD_PGREP_ERR:-pgrep exited with status $FD_PGREP_EXIT}"
fi
CLAUDE_WORKS=no
if [ -n "$CLAUDE_BIN" ] && (command -v "$CLAUDE_BIN" >/dev/null 2>&1 || [ -x "$CLAUDE_BIN" ]); then
    # (review fix) Presence/executable-bit alone is not enough — a broken/corrupted
    # install (wrong arch/libc, a truncated download, a dangling `versions/` dir)
    # would otherwise report FLIGHTDECK_CLAUDE_INSTALLED:yes, `collapse_state` would
    # fall through to the sign-in branch, and a novice with a broken install would be
    # told to sign in instead of reinstall. Require the SAME "actually runs" bar
    # `PROBE_SCRIPT_BODY` (`ipc::commands`/`connect`) now holds `claude --version` to.
    if "$CLAUDE_BIN" --version >/dev/null 2>&1; then
        CLAUDE_WORKS=yes
    fi
fi
if [ "$CLAUDE_WORKS" = yes ]; then
    echo FLIGHTDECK_CLAUDE_INSTALLED:yes
else
    echo FLIGHTDECK_CLAUDE_INSTALLED:no
fi
if [ "$FD_OS" = Darwin ]; then
    # A Mac has no systemd: the daemon runs as a LaunchAgent of the logged-in user.
    LA_PLISTS=$(fd_mac_agent_plists)
    LA_COUNT=0
    if [ -n "$LA_PLISTS" ]; then
        LA_COUNT=$(printf '%s\n' "$LA_PLISTS" | grep -c .)
        printf '%s\n' "$LA_PLISTS" | sed 's/^/FLIGHTDECK_MAC_AGENT_PLIST:/'
    fi
    fd_mac_invalid_agent_plists | sed 's/^/FLIGHTDECK_MAC_AGENT_INVALID:/'
    if [ "$LA_COUNT" = 0 ]; then
        echo FLIGHTDECK_MAC_AGENT:no
        echo "FLIGHTDECK_MAC_AGENT_AT_LOGIN:"
    elif [ "$LA_COUNT" != 1 ]; then
        # Several agents run flightdeckd: which one launchd keeps is not ours to guess,
        # so whether "it" starts at login is unknown.
        echo FLIGHTDECK_MAC_AGENT:yes
        echo "FLIGHTDECK_MAC_AGENT_AT_LOGIN:"
    else
        echo FLIGHTDECK_MAC_AGENT:yes
        LA_PLIST=$LA_PLISTS
        LA_RUN_AT_LOAD=$(fd_plist_get "$LA_PLIST" RunAtLoad)
        LA_KEEP_ALIVE=$(fd_plist_get "$LA_PLIST" KeepAlive)
        # launchd.plist(5): KeepAlive true starts the job at load, and a KeepAlive
        # dictionary holding SuccessfulExit (either value) implies RunAtLoad. Any other
        # KeepAlive dictionary (NetworkState, PathState...) starts it only when its
        # conditions hold: whether that covers a login is unknown, never "no".
        if [ "$LA_RUN_AT_LOAD" = true ] || [ "$LA_KEEP_ALIVE" = true ] \
            || fd_plist_get "$LA_PLIST" KeepAlive:SuccessfulExit >/dev/null; then
            echo FLIGHTDECK_MAC_AGENT_AT_LOGIN:yes
        else
            case "$LA_KEEP_ALIVE" in
                Dict*) echo "FLIGHTDECK_MAC_AGENT_AT_LOGIN:" ;;
                *) echo FLIGHTDECK_MAC_AGENT_AT_LOGIN:no ;;
            esac
        fi
    fi
    # What "Update the daemon" would replace, and whether that is what THE agent runs
    # (none is read with several: which one launchd keeps is not ours to guess).
    if [ "$LA_COUNT" = 1 ]; then
        fd_mac_update_facts "$LA_PLISTS"
    else
        fd_mac_update_facts ""
    fi
    # The LaunchAgent only exists inside a gui session: after a reboot nothing runs
    # until someone logs in, unless the Mac logs this user in by itself. No plist at
    # all means automatic login was never configured; an unreadable one is unknown.
    LOGINWINDOW=/Library/Preferences/com.apple.loginwindow.plist
    if [ ! -e "$LOGINWINDOW" ]; then
        echo FLIGHTDECK_MAC_AUTOLOGIN:no
    elif [ -r "$LOGINWINDOW" ]; then
        if [ "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "$(id -un)" ]; then
            echo FLIGHTDECK_MAC_AUTOLOGIN:yes
        else
            echo FLIGHTDECK_MAC_AUTOLOGIN:no
        fi
    else
        echo "FLIGHTDECK_MAC_AUTOLOGIN:"
    fi
    PMSET=$(pmset -g 2>/dev/null)
    if [ -z "$PMSET" ]; then
        echo "FLIGHTDECK_MAC_SLEEP_OFF:"
    elif printf '%s\n' "$PMSET" | grep -Eq '^[[:space:]]*SleepDisabled[[:space:]]+1'; then
        echo FLIGHTDECK_MAC_SLEEP_OFF:yes
    elif printf '%s\n' "$PMSET" | grep -Eq '^[[:space:]]*sleep[[:space:]]+0([[:space:]]|$)' \
        && ! pmset -g batt 2>/dev/null | grep -q InternalBattery; then
        echo FLIGHTDECK_MAC_SLEEP_OFF:yes
    else
        echo FLIGHTDECK_MAC_SLEEP_OFF:no
    fi
    # `claude auth status` ALWAYS says loggedIn:false over SSH on a Mac — this session
    # can't read the login Keychain the daemon's own claude reads (VERIFIED on a real
    # Mac, 08/10). Whether the credential item EXISTS is readable without its secret
    # (no -w / -g: attributes only). 44 = errSecItemNotFound; any other failure is
    # unknown, never "signed out" — and its exit code is reported, so the failure is
    # shown instead of silently becoming "unknown".
    if [ "$CLAUDE_WORKS" = yes ]; then
        security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1
        KEYCHAIN_STATUS=$?
        if [ "$KEYCHAIN_STATUS" = 0 ] || [ -s "$HOME/.claude/.credentials.json" ]; then
            echo FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:yes
        elif [ "$KEYCHAIN_STATUS" = 44 ]; then
            echo FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:no
        else
            echo "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:"
            echo "FLIGHTDECK_MAC_KEYCHAIN_EXIT:$KEYCHAIN_STATUS"
        fi
    else
        echo "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:"
    fi
    BOOT_SECS=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p')
    if [ -n "$BOOT_SECS" ]; then
        LAST_BOOT=$(date -r "$BOOT_SECS" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
    else
        LAST_BOOT=
    fi
else
    if [ -f /etc/systemd/system/flightdeckd.service ]; then
        echo FLIGHTDECK_UNIT_SYSTEM:yes
    else
        echo FLIGHTDECK_UNIT_SYSTEM:no
    fi
    if [ -f "$HOME/.config/systemd/user/flightdeckd.service" ]; then
        echo FLIGHTDECK_UNIT_USER:yes
        if grep -q '^Environment=PATH=' "$HOME/.config/systemd/user/flightdeckd.service" 2>/dev/null; then
            echo FLIGHTDECK_UNIT_USER_HAS_PATH:yes
        else
            echo FLIGHTDECK_UNIT_USER_HAS_PATH:no
        fi
    else
        echo FLIGHTDECK_UNIT_USER:no
        echo "FLIGHTDECK_UNIT_USER_HAS_PATH:"
    fi
    LINGER=$(loginctl show-user "$USER" -p Linger 2>/dev/null | sed -n 's/^Linger=//p')
    echo "FLIGHTDECK_LINGER:$LINGER"
    ENABLED_SYSTEM=$(systemctl is-enabled flightdeckd 2>/dev/null)
    echo "FLIGHTDECK_ENABLED_SYSTEM:$ENABLED_SYSTEM"
    ENABLED_USER=$(export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-enabled flightdeckd 2>/dev/null)
    echo "FLIGHTDECK_ENABLED_USER:$ENABLED_USER"
    # A unit systemd reports active runs a daemon even when this login can neither
    # reach its socket nor see its process (another user's, under /proc's hidepid).
    ACTIVE_SYSTEM=$(systemctl is-active flightdeckd 2>/dev/null)
    echo "FLIGHTDECK_ACTIVE_SYSTEM:$ACTIVE_SYSTEM"
    ACTIVE_USER=$(export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active flightdeckd 2>/dev/null)
    echo "FLIGHTDECK_ACTIVE_USER:$ACTIVE_USER"
    SLEEP_MASKED=$(systemctl is-enabled sleep.target 2>/dev/null)
    echo "FLIGHTDECK_SLEEP_MASKED:$SLEEP_MASKED"
    if [ "$CLAUDE_WORKS" = yes ]; then
        # One line: the CLI PRETTY-PRINTS this JSON (12 lines, VERIFIED on a real server,
        # 19/09) while every marker is read as a single line — unflattened, only "{" was
        # parsed, so a signed-in server showed "Claude signed in: Unknown" and stayed on
        # "Needs Claude sign-in" forever. JSON strings never hold a raw newline, so
        # dropping them is lossless.
        printf 'FLIGHTDECK_CLAUDE_AUTH_JSON:%s\n' "$("$CLAUDE_BIN" auth status --json 2>/dev/null | tr -d '\r\n')"
    else
        echo "FLIGHTDECK_CLAUDE_AUTH_JSON:"
    fi
    LAST_BOOT=$(uptime -s 2>/dev/null)
fi
# The Mac app keeps its CLI inside the bundle, off PATH.
TAILSCALE_BIN=$(command -v tailscale 2>/dev/null)
if [ -z "$TAILSCALE_BIN" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -n "$TAILSCALE_BIN" ]; then
    echo "FLIGHTDECK_TAILSCALE:$(fd_within "$TAILSCALE_BIN" status --self --peers=false 2>/dev/null | awk '{print $2}' | head -1)"
else
    echo "FLIGHTDECK_TAILSCALE:"
fi
echo "FLIGHTDECK_LAST_BOOT:$LAST_BOOT"
"#;

/// Shell functions — after [`mac_agent_fns`] has set `$FD_DAEMON_RE`/`$FD_INVOKE_RE` —
/// that find a hand-made flightdeckd LaunchAgent, whatever its label: the one way both
/// [`diagnose_script`] and the LaunchAgent arm of [`restart_daemon`] find it.
///
/// `fd_mac_agent_plists` prints, one per line and sorted, every
/// `~/Library/LaunchAgents` plist that runs `flightdeckd` (nothing when none). Only a
/// plist whose text names flightdeckd at all is looked at, and only one `plutil -lint`
/// accepts — launchd can't load any other, and PlistBuddy reads such a file as
/// "Error Reading File: <path>" on STDOUT, which used to pass for its values
/// (`fd_mac_invalid_agent_plists` lists those instead,
/// [`ServerDiagnosis::invalid_launch_agent_plists`]). Each one is ranked by how surely
/// it runs the daemon, and only the surest rank found is printed:
/// 1. launchd runs it right now and what it runs is the daemon — the job's `pid`
///    (`launchctl print`) is a `flightdeckd run` process, or the parent of one (a
///    wrapper that doesn't `exec`);
/// 2. its `Program`/`ProgramArguments` start `flightdeckd run` ([`DAEMON_INVOCATION_ERE`])
///    — directly, in an `sh -c` string, or through a small wrapper script one of its
///    words names (symlinks followed, `~/` and `$HOME/` expanded): a hand-made agent
///    often sets PATH in a wrapper, then execs `flightdeckd run`;
/// 3. its `Label`, or the name of its own log file (`StandardOutPath`/
///    `StandardErrorPath`), says flightdeckd — the weakest sign, for an agent whose
///    wrapper can't be read and whose daemon isn't running: never counted while this
///    user's daemon runs (rank 1 would have found the job running it, so it was started
///    some other way).
///
/// So a helper job that only USES flightdeckd's files (a `newsyslog` of its log, a
/// `flightdeckd status` health check, a backup of `~/.flightdeckd`, a
/// `com.tosse.flightdeckd.logrotate`) never stands next to the real agent as a second
/// one. Every plist of the surest rank is printed, so that several are reported as
/// ambiguous ([`ServerDiagnosis::launch_agent_plists`]) rather than one picked at
/// random. `find`, not a `*.plist` glob: the script runs in the login shell, zsh on a
/// Mac, whose glob with no match is an error rather than the literal pattern.
const MAC_AGENT_PLIST_FN: &str = r##"fd_plist_get() {
    fd_pv=$(/usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null) && printf '%s\n' "$fd_pv"
}
fd_mac_agent_plists() {
    # A daemon that runs while no agent's job is it was started some other way: a job
    # merely named after flightdeckd (rank 3) is then not its agent.
    fd_weak_ok=1
    if pgrep -u "$(id -u)" -f "$FD_DAEMON_RE" >/dev/null 2>&1; then
        fd_weak_ok=0
    fi
    fd_mac_agent_candidates | awk -v weak_ok="$fd_weak_ok" '
        { tier[NR] = substr($0, 1, 1); path[NR] = substr($0, 3) }
        tier[NR] == 3 && !weak_ok { next }
        best == "" || tier[NR] < best { best = tier[NR] }
        END { for (i = 1; i <= NR; i++) if (tier[i] == best) print path[i] }'
}
fd_mac_agent_candidates() {
    find "$HOME/Library/LaunchAgents" -maxdepth 1 -name '*.plist' 2>/dev/null | sort | while IFS= read -r fd_plist; do
        grep -q flightdeckd "$fd_plist" 2>/dev/null || continue
        plutil -lint -s "$fd_plist" >/dev/null 2>&1 || continue
        fd_tier=$(fd_plist_agent_tier "$fd_plist")
        if [ -n "$fd_tier" ]; then
            printf '%s %s\n' "$fd_tier" "$fd_plist"
        fi
    done
}
fd_mac_invalid_agent_plists() {
    find "$HOME/Library/LaunchAgents" -maxdepth 1 -name '*.plist' 2>/dev/null | sort | while IFS= read -r fd_plist; do
        grep -q flightdeckd "$fd_plist" 2>/dev/null || continue
        plutil -lint -s "$fd_plist" >/dev/null 2>&1 || printf '%s\n' "$fd_plist"
    done
}
fd_plist_agent_tier() {
    fd_label=$(fd_plist_get "$1" Label)
    if [ -n "$fd_label" ] && fd_job_runs_daemon "$fd_label"; then
        echo 1
    elif fd_plist_starts_daemon "$1"; then
        echo 2
    elif printf '%s\n' "$fd_label" | grep -q flightdeckd \
        || { fd_plist_get "$1" StandardOutPath; fd_plist_get "$1" StandardErrorPath; } | sed 's|.*/||' | grep -q flightdeckd; then
        echo 3
    fi
}
fd_job_runs_daemon() {
    fd_pid=$(launchctl print "gui/$(id -u)/$1" 2>/dev/null | sed -n 's/^[[:space:]]pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)
    [ -n "$fd_pid" ] || return 1
    ps -o args= -p "$fd_pid" 2>/dev/null | grep -Eq "$FD_DAEMON_RE" \
        || pgrep -P "$fd_pid" -f "$FD_DAEMON_RE" >/dev/null 2>&1
}
fd_plist_starts_daemon() {
    fd_cmd=$( fd_plist_get "$1" Program
        fd_i=0
        while [ "$fd_i" -lt 32 ] && fd_arg=$(fd_plist_get "$1" "ProgramArguments:$fd_i"); do
            printf '%s\n' "$fd_arg"
            fd_i=$((fd_i + 1))
        done )
    if printf '%s\n' "$fd_cmd" | tr '\n' ' ' | grep -Eq "$FD_INVOKE_RE"; then
        return 0
    fi
    # A wrapper is a small file (a script, with or without #!); a large one is an
    # interpreter or an app binary, not worth reading. Every word is a candidate — an
    # `sh -c` string names its wrapper among others — once stripped of quotes.
    printf '%s\n' "$fd_cmd" | tr -s ' \t' '\n\n' | sed -e "s/^[\"']*//" -e "s/[\"';]*\$//" | while IFS= read -r fd_file; do
        case "$fd_file" in
            "~/"*) fd_file="$HOME/${fd_file#??}" ;;
            '$HOME/'*) fd_file="$HOME/${fd_file#??????}" ;;
            '${HOME}/'*) fd_file="$HOME/${fd_file#????????}" ;;
        esac
        case "$fd_file" in
            /*) ;;
            *) continue ;;
        esac
        if [ -f "$fd_file" ] && [ -n "$(find -H "$fd_file" -prune -type f -size -64k 2>/dev/null)" ] \
            && grep -Eq "$FD_INVOKE_RE" "$fd_file" 2>/dev/null; then
            echo yes
        fi
    done | grep -q yes
}"##;

fn diagnose_script() -> String {
    format!(
        "FLIGHTDECKD_BIN={}\nCLAUDE_BIN={}\n{}\n{}\n{}",
        resolve_daemon_bin_expr("flightdeckd"),
        crate::ipc::commands::resolve_claude_bin_expr(),
        mac_agent_fns(),
        mac_update_fns(),
        DIAGNOSE_SCRIPT_BODY
    )
}

/// `systemctl is-enabled`-style output → tri-state: `Some(true)` only for the literal
/// `"enabled"` (systemd's own wording for "will start at boot"), `Some(false)` for any
/// OTHER non-empty answer (`"disabled"`/`"masked"`/`"static"`/…), `None` when the
/// marker's value is empty (the command itself produced nothing — `systemctl` missing,
/// no such unit).
fn is_enabled_yes(v: Option<&str>) -> Option<bool> {
    match v {
        Some("") | None => None,
        Some("enabled") => Some(true),
        Some(_) => Some(false),
    }
}

/// The facts whose markers differ between a Linux (systemd) server and a Mac
/// (LaunchAgent) — see [`DIAGNOSE_SCRIPT_BODY`]'s two branches. Every field keeps the
/// tri-state discipline of [`ServerDiagnosis`]: a fact that doesn't exist on that
/// platform is `None`, never a manufactured `Some(false)`.
struct PlatformFacts {
    installed_as: InstalledAs,
    reboot_safe: Option<bool>,
    auto_login: Option<bool>,
    agent_starts_at_login: Option<bool>,
    launch_agent_plists: Vec<String>,
    invalid_launch_agent_plists: Vec<String>,
    mac_daemon_update: Option<MacDaemonUpdate>,
    linger: Option<bool>,
    sleep_masked: Option<bool>,
    user_unit_missing_path: Option<bool>,
    claude_logged_in: Option<bool>,
    claude_email: Option<String>,
    claude_login_check_error: Option<String>,
}

/// How flightdeckd is installed when no service manages it: running (`daemon_alive`,
/// see [`parse_diagnosis_fields`]) or present on disk is a detached process, both
/// confirmed absent is "not installed", anything less certain is unknown.
fn installed_without_service(daemon_alive: Option<bool>, bin_present: Option<bool>) -> InstalledAs {
    if daemon_alive == Some(true) || bin_present == Some(true) {
        InstalledAs::Detached
    } else if daemon_alive == Some(false) && bin_present == Some(false) {
        InstalledAs::None
    } else {
        InstalledAs::Unknown
    }
}

fn linux_platform_facts(stdout: &str, daemon_alive: Option<bool>, bin_present: Option<bool>) -> PlatformFacts {
    use crate::ipc::commands::{extract_marker, parse_yes_no_marker};

    let unit_system = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_UNIT_SYSTEM:"));
    let unit_user = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_UNIT_USER:"));
    let installed_as = match (unit_system, unit_user) {
        (Some(true), _) => InstalledAs::System,
        (Some(false), Some(true)) => InstalledAs::User,
        (Some(false), Some(false)) => installed_without_service(daemon_alive, bin_present),
        _ => InstalledAs::Unknown,
    };

    let linger = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_LINGER:"));
    let enabled_system = is_enabled_yes(extract_marker(stdout, "FLIGHTDECK_ENABLED_SYSTEM:").as_deref());
    let enabled_user = is_enabled_yes(extract_marker(stdout, "FLIGHTDECK_ENABLED_USER:").as_deref());
    let reboot_safe = match installed_as {
        InstalledAs::System => enabled_system,
        InstalledAs::User => match (enabled_user, linger) {
            (Some(true), Some(true)) => Some(true),
            (Some(false), _) | (_, Some(false)) => Some(false),
            _ => None,
        },
        InstalledAs::Detached => Some(false),
        // Never produced on Linux (no LaunchAgent marker is read here).
        InstalledAs::LaunchAgent | InstalledAs::None | InstalledAs::Unknown => None,
    };

    let sleep_masked = extract_marker(stdout, "FLIGHTDECK_SLEEP_MASKED:").map(|v| v == "masked");

    // (B14) Only meaningful when a user unit is CONFIRMED to exist AND the PATH check
    // itself resolved either way — an unconfirmed unit (`unit_user` unknown) or a
    // garbled/missing PATH marker both degrade to `None`, never a guessed `Some(false)`.
    let unit_user_has_path = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_UNIT_USER_HAS_PATH:"));
    let user_unit_missing_path = match (unit_user, unit_user_has_path) {
        (Some(true), Some(has_path)) => Some(!has_path),
        _ => None,
    };

    let claude_auth_json = extract_marker(stdout, "FLIGHTDECK_CLAUDE_AUTH_JSON:");
    let (claude_logged_in, claude_email) = match claude_auth_json.as_deref() {
        Some(s) if !s.is_empty() => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(v) => (
                v.get("loggedIn").and_then(serde_json::Value::as_bool),
                v.get("email").and_then(serde_json::Value::as_str).map(str::to_string),
            ),
            Err(_) => (None, None),
        },
        _ => (None, None),
    };

    PlatformFacts {
        installed_as,
        reboot_safe,
        auto_login: None,
        agent_starts_at_login: None,
        launch_agent_plists: Vec::new(),
        invalid_launch_agent_plists: Vec::new(),
        mac_daemon_update: None,
        linger,
        sleep_masked,
        user_unit_missing_path,
        claude_logged_in,
        claude_email,
        claude_login_check_error: None,
    }
}

/// Every non-empty value of a marker the diagnose script prints once per item
/// (`FLIGHTDECK_MAC_AGENT_PLIST:<path>`…), in order.
fn marker_lines(stdout: &str, marker: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix(marker))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}

/// Why the Mac's Keychain check could not answer, from the `security` exit code the
/// diagnose script reports when it is neither found (0) nor not found (44) — `None`
/// whenever the check answered (`claude_logged_in` is known) or reported no code.
fn mac_login_check_error(claude_logged_in: Option<bool>, keychain_exit: Option<&str>) -> Option<String> {
    match (claude_logged_in, keychain_exit) {
        (None, Some(code)) if !code.is_empty() => Some(format!("the Keychain lookup failed (security exit {code})")),
        _ => None,
    }
}

fn mac_platform_facts(stdout: &str, daemon_alive: Option<bool>, bin_present: Option<bool>) -> PlatformFacts {
    use crate::ipc::commands::{extract_marker, parse_yes_no_marker};

    let installed_as = match parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_MAC_AGENT:")) {
        Some(true) => InstalledAs::LaunchAgent,
        Some(false) => installed_without_service(daemon_alive, bin_present),
        None => InstalledAs::Unknown,
    };
    let launch_agent_plists = marker_lines(stdout, "FLIGHTDECK_MAC_AGENT_PLIST:");
    // Several agents run flightdeckd: none of them is "the" agent, so whether it starts
    // at login — and with it reboot safety — stays unknown whatever the markers say.
    let ambiguous = launch_agent_plists.len() > 1;
    let agent_starts_at_login = if installed_as == InstalledAs::LaunchAgent && !ambiguous {
        parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_MAC_AGENT_AT_LOGIN:"))
    } else {
        None
    };
    let auto_login = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_MAC_AUTOLOGIN:"));
    let reboot_safe = match installed_as {
        InstalledAs::LaunchAgent if ambiguous => None,
        InstalledAs::LaunchAgent => match (agent_starts_at_login, auto_login) {
            (Some(true), Some(true)) => Some(true),
            (Some(false), _) | (_, Some(false)) => Some(false),
            _ => None,
        },
        // A process started by hand dies with the session that started it.
        InstalledAs::Detached => Some(false),
        InstalledAs::System | InstalledAs::User | InstalledAs::None | InstalledAs::Unknown => None,
    };
    let claude_logged_in = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:"));
    let claude_login_check_error =
        mac_login_check_error(claude_logged_in, extract_marker(stdout, "FLIGHTDECK_MAC_KEYCHAIN_EXIT:").as_deref());

    PlatformFacts {
        installed_as,
        reboot_safe,
        auto_login,
        agent_starts_at_login,
        launch_agent_plists,
        invalid_launch_agent_plists: marker_lines(stdout, "FLIGHTDECK_MAC_AGENT_INVALID:"),
        mac_daemon_update: Some(judge_mac_update(stdout)),
        linger: None,
        sleep_masked: parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_MAC_SLEEP_OFF:")),
        user_unit_missing_path: None,
        claude_logged_in,
        claude_email: None,
        claude_login_check_error,
    }
}

/// [`ServerDiagnosis::daemon_process_seen`] off the diagnose script's markers: a
/// `flightdeckd run` process of this user, or a flightdeckd unit systemd reports
/// active (Linux only — a Mac's script prints no unit marker), is `Some(true)`;
/// otherwise the process check's own answer, `None` when it couldn't run.
fn daemon_process_seen(stdout: &str) -> Option<bool> {
    use crate::ipc::commands::{extract_marker, parse_yes_no_marker};

    let unit_active = ["FLIGHTDECK_ACTIVE_SYSTEM:", "FLIGHTDECK_ACTIVE_USER:"]
        .iter()
        .any(|m| matches!(extract_marker(stdout, m).as_deref(), Some("active" | "reloading")));
    if unit_active {
        Some(true)
    } else {
        parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_DAEMON_PROCESS:"))
    }
}

/// Pure core of [`diagnose`] — every sub-probe read independently off `stdout`, never
/// gated on any other one succeeding. See the module doc.
fn parse_diagnosis_fields(stdout: &str) -> ServerDiagnosis {
    use crate::ipc::commands::{extract_marker, parse_yes_no_marker};

    let host_os = extract_marker(stdout, "FLIGHTDECK_OS:").filter(|s| !s.is_empty());
    let host_arch = extract_marker(stdout, "FLIGHTDECK_ARCH:").filter(|s| !s.is_empty());
    let bin_present = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_BIN_PRESENT:"));

    let status_json = extract_marker(stdout, "FLIGHTDECK_STATUS_JSON:");
    let daemon_process_seen = daemon_process_seen(stdout);
    // Only when it is why nothing is known: a unit seen active answered for it.
    let daemon_process_check_error = extract_marker(stdout, "FLIGHTDECK_DAEMON_PROCESS_ERROR:")
        .filter(|e| daemon_process_seen.is_none() && !e.is_empty());
    let (daemon_running, daemon_version_running, busy_conversations) = match status_json.as_deref() {
        None => (None, None, None),
        // `status` reached no daemon from this login. That is "stopped" only when no
        // daemon is seen running either: one whose socket or binary is gone, or a
        // system unit run as another user, answers nothing here — and a restart offered
        // for a "stopped" daemon would kill it, conversations and all.
        Some("") => (if daemon_process_seen == Some(false) { Some(false) } else { None }, None, None),
        Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(v) if v.get("type").and_then(serde_json::Value::as_str) == Some("fd_status") => {
                let version = v.get("version").and_then(serde_json::Value::as_str).map(str::to_string);
                let busy = v.get("conversations").and_then(serde_json::Value::as_array).and_then(|rows| rows_at_work(rows));
                (Some(true), version, busy)
            }
            _ => (None, None, None),
        },
    };

    // For HOW flightdeckd is installed, a status that reached nothing still reads as
    // "not running here" unless a daemon was seen — a server that can't list its
    // processes is no reason to stop calling a binary-less box "not installed".
    let daemon_alive = if daemon_running == Some(true) || daemon_process_seen == Some(true) {
        Some(true)
    } else if status_json.as_deref() == Some("") {
        Some(false)
    } else {
        None
    };
    let platform = if host_os.as_deref() == Some(MACOS_UNAME) {
        mac_platform_facts(stdout, daemon_alive, bin_present)
    } else {
        linux_platform_facts(stdout, daemon_alive, bin_present)
    };

    let daemon_version_disk = extract_marker(stdout, "FLIGHTDECK_VERSION_DISK:").filter(|s| !s.is_empty());
    // `--version` prints `"flightdeckd 0.2.0"` (the clap `<name> <version>` shape —
    // mirrors `ipc::commands::version_at_least`'s own "only the LAST whitespace token
    // is the version" reading) while `fd_status`'s own `version` field is the bare
    // dotted string — comparing the two RAW would report `restart_pending` on every
    // healthy, matching pair.
    let restart_pending = matches!(
        (&daemon_version_disk, &daemon_version_running),
        (Some(d), Some(r)) if d.split_whitespace().last().unwrap_or(d) != r
    );

    let claude_installed = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_CLAUDE_INSTALLED:"));

    let tailscale_name = extract_marker(stdout, "FLIGHTDECK_TAILSCALE:").filter(|s| !s.is_empty());
    let last_boot = extract_marker(stdout, "FLIGHTDECK_LAST_BOOT:").filter(|s| !s.is_empty());

    ServerDiagnosis {
        // Overwritten by `collapse_state` right after this returns — see `parse_diagnosis`.
        state: DiagnosisState::Ready,
        // This function only ever runs on stdout ssh actually brought back: the
        // unreachable case returns `ServerDiagnosis::unreachable()` without ever
        // reaching here (see `parse_diagnosis`).
        reachable: true,
        // Nothing to classify — the ssh round trip itself succeeded. Both fields
        // stay `None` for every reachable diagnosis by construction (see their own
        // docs on `ServerDiagnosis`).
        link_issue: None,
        tailscale_off_locally: None,
        host_os,
        host_arch,
        installed_as: platform.installed_as,
        daemon_running,
        daemon_process_seen,
        daemon_process_check_error,
        daemon_version_disk,
        daemon_version_running,
        restart_pending,
        reboot_safe: platform.reboot_safe,
        auto_login: platform.auto_login,
        agent_starts_at_login: platform.agent_starts_at_login,
        launch_agent_plists: platform.launch_agent_plists,
        invalid_launch_agent_plists: platform.invalid_launch_agent_plists,
        mac_daemon_update: platform.mac_daemon_update,
        linger: platform.linger,
        sleep_masked: platform.sleep_masked,
        user_unit_missing_path: platform.user_unit_missing_path,
        claude_installed,
        claude_logged_in: platform.claude_logged_in,
        claude_email: platform.claude_email,
        claude_login_check_error: platform.claude_login_check_error,
        tailscale_name,
        last_boot,
        busy_conversations,
        // Folded in by `with_bundled_version` at the module's public boundaries
        // (`machine_diagnose`, `step_diagnose`, `repair`) — never a remote fact this
        // script's markers could carry, see `ServerDiagnosis::bundled_daemon_version`'s
        // own doc.
        bundled_daemon_version: None,
        daemon_outdated: false,
        bundled_daemon_for_host: None,
    }
}

/// Collapses [`ServerDiagnosis`]'s independent facts into the ONE headline
/// [`DiagnosisState`] — see the module doc. Ordering matters: a fact earlier in this
/// waterfall shadows everything after it (e.g. "not installed at all" is reported
/// before "and also not logged into claude", never both at once).
fn collapse_state(d: &ServerDiagnosis) -> DiagnosisState {
    match d.installed_as {
        InstalledAs::None => return DiagnosisState::Failed { reason: "flightdeckd is not installed".to_string() },
        InstalledAs::Unknown => {
            return DiagnosisState::Failed {
                reason: "could not determine whether flightdeckd is installed".to_string(),
            }
        }
        InstalledAs::System | InstalledAs::User | InstalledAs::LaunchAgent | InstalledAs::Detached => {}
    }
    match d.daemon_running {
        Some(false) => return DiagnosisState::Failed { reason: "flightdeckd is not running".to_string() },
        None if d.daemon_process_seen == Some(true) => {
            return DiagnosisState::Failed { reason: DAEMON_STATUS_UNREADABLE.to_string() }
        }
        None if d.daemon_process_seen.is_none() && d.daemon_process_check_error.is_some() => {
            let why = d.daemon_process_check_error.as_deref().unwrap_or_default();
            return DiagnosisState::Failed {
                reason: format!(
                    "could not determine whether flightdeckd is running — {}",
                    daemon_state_unknown_reason(why, d.host_os.as_deref())
                ),
            };
        }
        None => {
            return DiagnosisState::Failed {
                reason: "could not determine whether flightdeckd is running".to_string(),
            }
        }
        Some(true) => {}
    }
    // (B14) `claude` missing, confirmed absent, OR "could not confirm either way" all
    // land in `NeedsClaudeInstall` — never `Failed`: a server that only needs Claude
    // Code installed is not a broken server, it's the pipeline's normal
    // `RepairAction::InstallClaude` next step (which itself safely no-ops if `claude`
    // turns out to already be there — see that action's own doc). This used to be
    // folded together with "installed but signed out" into one `NeedsClaudeSignIn`
    // bucket (the brief's own `RepairAction` list had no separate install action back
    // then) — B14 adds [`RepairAction::InstallClaude`], so the two are now told apart:
    // offering a sign-in flow for a server that has no `claude` to sign in with was
    // never actionable, it just failed as soon as the human tried it.
    if d.claude_installed != Some(true) {
        return DiagnosisState::NeedsClaudeInstall;
    }
    // `claude` is installed but confirmed logged out, or we could not confirm the
    // sign-in status either way — same "never `Failed`" tolerance as above.
    if d.claude_logged_in != Some(true) {
        return DiagnosisState::NeedsClaudeSignIn;
    }
    match d.reboot_safe {
        Some(true) => DiagnosisState::Ready,
        _ => DiagnosisState::RunningNotRebootSafe,
    }
}

fn parse_diagnosis(stdout: &str, ssh_succeeded: bool) -> ServerDiagnosis {
    if !ssh_succeeded {
        return ServerDiagnosis::unreachable();
    }
    let mut d = parse_diagnosis_fields(stdout);
    d.state = collapse_state(&d);
    d
}

/// ONE ssh round trip, accumulating every fact [`ServerDiagnosis`] carries. See the
/// module doc. `pub(crate)` so live tests elsewhere in `bootstrap::` (e.g.
/// `bootstrap::install`'s own Docker-fixture suite) can diagnose a fixture directly,
/// without needing a full [`tauri::AppHandle`]/[`Store`]-backed [`machine_diagnose`]
/// call for a machine that was never actually persisted.
pub(crate) async fn diagnose(machine: &MachineRecord, known_hosts: Option<&str>) -> ServerDiagnosis {
    diagnose_within(machine, known_hosts, SSH_ROUND_TRIP_TIMEOUT).await
}

/// [`diagnose`] with an explicit `deadline` for the whole round trip — the testable core.
async fn diagnose_within(machine: &MachineRecord, known_hosts: Option<&str>, deadline: Duration) -> ServerDiagnosis {
    let mut cmd =
        match crate::ipc::commands::keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts) {
            Ok(cmd) => cmd,
            Err(reason) => return failed_before_ssh(reason),
        };
    cmd.arg("-T");
    // A `MachineRecord` on disk could predate `validate_ssh_user` (an older app
    // version, or a manual DB edit) — degrade to a clear, typed failure instead of
    // spawning ssh with it (or, worse, panicking): the machine stays listed, this
    // is just what any attempt to actually reach it now reports.
    if crate::ipc::commands::push_ssh_destination(&mut cmd, &machine.user, &machine.host).is_err() {
        // The `Err` is deliberately discarded — it embeds the raw offending value (see
        // `validate_ssh_user`/`validate_address_value`'s own docs) and this reason
        // string is user-facing. Same discipline as `TransportError::InvalidRemoteTarget`.
        return invalid_connection_details();
    }
    cmd.arg(diagnose_script());
    // A wedged remote shell (stuck lock, hung `flightdeckd`) must not hang this
    // forever — `ConnectTimeout=10` only bounds the handshake (B11 review finding).
    // Read as it arrives, so what the server said before the deadline is kept — and
    // bounded while it is read: a hostile login script cannot make this buffer gigabytes.
    let max = crate::ipc::commands::SSH_ONE_SHOT_STDOUT_MAX;
    let collected = match crate::ipc::commands::run_collecting(&mut cmd, None, deadline, max).await {
        Ok(collected) => collected,
        Err(e @ crate::ipc::commands::CollectError::TooMuchOutput(_)) => {
            return ServerDiagnosis {
                state: DiagnosisState::Failed { reason: e.message("the server") },
                ..parse_diagnosis_fields("")
            }
        }
        Err(crate::ipc::commands::CollectError::Io(_)) => return unreachable_after(&machine.host, None).await,
    };
    match collected.status {
        // The accumulating script (see its own doc) never `exit`s early, so a
        // SUCCESSFUL exit status here means ssh itself connected and ran it —
        // `parse_diagnosis`'s stdout-parsing path is untouched by anything below.
        Some(status) if status.success() => parse_diagnosis(&String::from_utf8_lossy(&collected.stdout), true),
        Some(status) => unreachable_after(&machine.host, Some((status.code(), &collected.stderr))).await,
        // The deadline, after the server had started answering: it IS reachable, one of
        // its checks is stuck. Reported as "could not reach the server" this sent the
        // user looking at the network (and refused every repair) for a server that
        // answered.
        None if collected.stdout.windows(DIAGNOSIS_ANSWER_MARKER.len()).any(|w| w == DIAGNOSIS_ANSWER_MARKER) => {
            checks_cut_short(&String::from_utf8_lossy(&collected.stdout), deadline)
        }
        None => unreachable_after(&machine.host, None).await,
    }
}

/// The first line [`DIAGNOSE_SCRIPT_BODY`] prints: once it arrived, the server answered.
const DIAGNOSIS_ANSWER_MARKER: &[u8] = b"FLIGHTDECK_OS:";

/// A diagnosis cut by its `deadline` after the server answered: the facts that arrived,
/// reachable, and a reason that says the checks — not the link — did not finish. Pure.
fn checks_cut_short(partial: &str, deadline: Duration) -> ServerDiagnosis {
    ServerDiagnosis {
        state: DiagnosisState::Failed {
            reason: format!(
                "the server answered, but its checks did not finish within {} s — flightdeckd or Claude Code \
                 may be stuck on it",
                deadline.as_secs().max(1)
            ),
        },
        ..parse_diagnosis_fields(partial)
    }
}

/// The diagnosis of a machine whose saved `user`/`host` no longer pass validation —
/// shared by [`diagnose`] and [`probe_reachability`], so both name it in the same words.
fn invalid_connection_details() -> ServerDiagnosis {
    failed_before_ssh("this server's saved connection details are not valid — remove and re-add it".to_string())
}

/// The diagnosis when ssh could not even be started for this machine (`reason` says
/// why) — nothing was asked of the server.
fn failed_before_ssh(reason: String) -> ServerDiagnosis {
    ServerDiagnosis {
        state: DiagnosisState::Failed { reason },
        ..ServerDiagnosis::unreachable()
    }
}

/// Classify an ssh round trip that did NOT succeed — shared by [`diagnose`] and
/// [`probe_reachability`], so the ambient probe says WHY in exactly the words the full
/// diagnosis in the server panel uses. `exited` is ssh's exit code and stderr when it
/// exited; `None` when there is nothing to read (it could not be spawned, or the
/// deadline fired before the server said anything).
async fn unreachable_after(host: &str, exited: Option<(Option<i32>, &[u8])>) -> ServerDiagnosis {
    match exited {
        // ssh itself failed (a non-zero exit — OpenSSH's own convention for exit 255,
        // though anything non-zero here means the same thing for THIS script, which
        // never returns non-zero on its own). Thread the stderr this used to discard
        // entirely through the shared classifier, so the diagnosis names WHY instead
        // of the single fixed "could not reach the server".
        Some((code, stderr)) => {
            let stderr_lines: Vec<String> = String::from_utf8_lossy(stderr).lines().map(str::to_string).collect();
            let issue = ssh_link::classify_transport_close(code, &stderr_lines).unwrap_or(SshLinkIssue::Unreachable);
            let tailscale_off = tailscale_off_locally_if_relevant(host).await;
            let mut d = ServerDiagnosis::unreachable_with(issue, tailscale_off);
            // A cause the catch-all has no name for (a `RemoteCommand` in this Mac's ssh
            // config, a cipher nobody shares…) keeps ssh's own words: the fixed sentence
            // alone sent the user looking at the network.
            if issue == SshLinkIssue::Unreachable && tailscale_off != Some(true) {
                d.state = DiagnosisState::Failed { reason: ssh_link::describe_with_detail(issue, &stderr_lines) };
            }
            d
        }
        // No output at all: the round trip either couldn't even be spawned, or the
        // `SSH_ROUND_TRIP_TIMEOUT` deadline elapsed before the server answered — nothing
        // to classify from stderr, but the host can still be checked against the local
        // Tailscale state (a wedged/hung remote shell on a tailnet host is exactly the
        // shape this clause exists for).
        None => {
            let tailscale_off = tailscale_off_locally_if_relevant(host).await;
            ServerDiagnosis::unreachable_with(SshLinkIssue::Unreachable, tailscale_off)
        }
    }
}

/// The one fact the AMBIENT machine-health probe needs: can this Mac reach the server
/// right now, and if not, why. See [`probe_reachability`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MachineReachability {
    pub reachable: bool,
    /// The diagnosis's own wording for why, when unreachable — the SAME string a full
    /// [`diagnose`] would put in [`DiagnosisState::Failed`]. `None` when reachable.
    pub reason: Option<String>,
}

impl MachineReachability {
    fn reached() -> Self {
        Self { reachable: true, reason: None }
    }
}

impl From<&ServerDiagnosis> for MachineReachability {
    fn from(d: &ServerDiagnosis) -> Self {
        let reason = match &d.state {
            DiagnosisState::Failed { reason } if !d.reachable => Some(reason.clone()),
            _ => None,
        };
        Self { reachable: d.reachable, reason }
    }
}

/// "Can I talk to this machine?" — the question the sidebar mark, the Flight Deck lane
/// header and the composer band answer, and NOTHING more.
///
/// ⚠️ Why not [`diagnose`]: the ambient loop used to run the full diagnosis every 90 s
/// per server, i.e. a fresh ssh handshake PLUS a dozen server-side commands — `systemctl`,
/// `loginctl`, `flightdeckd --version`/`status`, and `claude --version` + `claude auth
/// status`, two Node.js start-ups on the server — to paint a glyph that reads
/// `reachable` and nothing else (see `store/machineHealth.ts`). The server panel still
/// runs [`diagnose`]: it is the one surface that shows the rest.
///
/// Same ssh options, same timeout, same failure classification as [`diagnose`] (shared
/// through [`unreachable_after`]), so a verdict never depends on which probe produced it.
pub(crate) async fn probe_reachability(machine: &MachineRecord, known_hosts: Option<&str>) -> MachineReachability {
    let mut cmd =
        match crate::ipc::commands::keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts) {
            Ok(cmd) => cmd,
            Err(reason) => return MachineReachability::from(&failed_before_ssh(reason)),
        };
    cmd.arg("-T");
    if crate::ipc::commands::push_ssh_destination(&mut cmd, &machine.user, &machine.host).is_err() {
        return MachineReachability::from(&invalid_connection_details());
    }
    // `true`, not an empty command: ssh with no command opens an interactive login
    // shell and waits on it. Exit 0 means ssh connected, authenticated and ran it.
    cmd.arg("true");
    let exited = match crate::ipc::commands::output_within(&mut cmd, SSH_ROUND_TRIP_TIMEOUT).await {
        Ok(Some(out)) if out.status.success() => return MachineReachability::reached(),
        Ok(Some(out)) => Some(out),
        // A login script that floods stdout: not a server this Mac can work with.
        Err(e @ crate::ipc::commands::CollectError::TooMuchOutput(_)) => {
            return MachineReachability { reachable: false, reason: Some(e.message("the server")) }
        }
        Ok(None) | Err(crate::ipc::commands::CollectError::Io(_)) => None,
    };
    let exited = exited.as_ref().map(|out| (out.status.code(), out.stderr.as_slice()));
    MachineReachability::from(&unreachable_after(&machine.host, exited).await)
}

/// [`tailscale::local_status`], gated on [`tailscale::host_looks_like_tailnet`] first
/// so a LAN/public server's diagnosis never pays for the subprocess at all — folds
/// into the one signal [`ServerDiagnosis::tailscale_off_locally`] ever carries:
/// `Some(true)` on POSITIVE local evidence, `None` otherwise (never a guessed "on").
async fn tailscale_off_locally_if_relevant(host: &str) -> Option<bool> {
    if !tailscale::host_looks_like_tailnet(host) {
        return None;
    }
    match tailscale::local_status().await {
        tailscale::LocalTailscaleState::NotRunning => Some(true),
        _ => None,
    }
}

/// Pure: does this server need the bundled `flightdeckd` UPLOADED — its RUNNING daemon
/// trails this Mac's BUNDLED version, and the disk doesn't already hold that version (or
/// a newer one)? A disk version at least the bundled one is an upload that already
/// landed, waiting only for the restart [`ServerDiagnosis::restart_pending`] reports:
/// reading the running version alone kept "Update the daemon" offered next to "Restart
/// the daemon" right after a successful update, and a second click only answered
/// `AlreadyCurrent` — the user couldn't tell whether the update had worked. `false`
/// whenever the running or bundled version is unknown — never a false positive nagging
/// to re-upload over a probe that simply couldn't confirm a version.
fn daemon_is_outdated(running: Option<&str>, disk: Option<&str>, bundled: Option<&str>) -> bool {
    use crate::ipc::commands::version_at_least;
    match (running, bundled) {
        (Some(r), Some(b)) => !version_at_least(r, b) && !disk.is_some_and(|d| version_at_least(d, b)),
        _ => false,
    }
}

/// Folds this Mac's BUNDLED `flightdeckd` version into an already-computed
/// [`ServerDiagnosis`] — see [`ServerDiagnosis::bundled_daemon_version`]'s own doc for
/// why this happens here and not inside [`diagnose`] itself. Applied at every point a
/// diagnosis crosses out of this module ([`machine_diagnose`], [`step_diagnose`],
/// [`repair`]'s own final diagnosis) — never at [`restart_daemon`]'s internal
/// busy-conversations check, which has no [`tauri::AppHandle`] and no need for this
/// fact either. Also folds in [`ServerDiagnosis::bundled_daemon_for_host`] — whether the
/// bundle carries a build for this server's OS/arch — from the SAME manifest read.
fn with_bundled_version(app: &tauri::AppHandle, mut d: ServerDiagnosis) -> ServerDiagnosis {
    let manifest = install::bundled_daemon_manifest(app).ok();
    d.bundled_daemon_for_host = d
        .host_arch
        .as_deref()
        .map(|arch| install::bundled_daemon_for_host(app, manifest.as_ref(), d.host_os.as_deref(), arch));
    let bundled = manifest.map(|m| m.version);
    d.daemon_outdated =
        daemon_is_outdated(d.daemon_version_running.as_deref(), d.daemon_version_disk.as_deref(), bundled.as_deref());
    d.bundled_daemon_version = bundled;
    d
}

#[tauri::command]
#[specta::specta]
pub async fn machine_diagnose(app: tauri::AppHandle, machine_id: String) -> Result<ServerDiagnosis, String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let known_hosts = known_hosts_path(&app);
    Ok(with_bundled_version(&app, diagnose(&machine, known_hosts.as_deref()).await))
}

/// The ambient health probe — see [`probe_reachability`] for why it is not
/// [`machine_diagnose`].
#[tauri::command]
#[specta::specta]
pub async fn machine_reachability(app: tauri::AppHandle, machine_id: String) -> Result<MachineReachability, String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let known_hosts = known_hosts_path(&app);
    Ok(probe_reachability(&machine, known_hosts.as_deref()).await)
}

// ============================================================================
// repair
// ============================================================================

/// Every fix `machine_repair` can apply — see the module doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RepairAction {
    ReuploadDaemon,
    RestartDaemon,
    InstallService,
    EnableLinger,
    MaskSleep,
    RunInit,
    /// (B14) Runs the official native installer — see
    /// [`server_setup::install_claude`]'s own doc. Distinct from [`Self::SignInClaude`]:
    /// this fixes [`DiagnosisState::NeedsClaudeInstall`], that one fixes
    /// [`DiagnosisState::NeedsClaudeSignIn`].
    InstallClaude,
    SignInClaude,
    ProvisionPhone,
    /// (CRM `c9bf1482`) Reinstalls this Mac's SAVED key on a server that refused it
    /// (`ServerDiagnosis::link_issue == Some(SshLinkIssue::KeyRefused)`) — a normal,
    /// exhaustively-dispatched `RepairAction`, unlike [`Self::SignInClaude`]: see the
    /// module doc's own note on why the two are NOT the same shape (this is a
    /// single, non-interactive, password-in/summary-out round trip; sign-in needs an
    /// interactive [`server_setup::LoginSession`] handle this dispatch can't carry).
    ReconnectMac,
}

/// Exhaustive, COMPILE-TIME-checked label for each [`RepairAction`] — no wildcard arm,
/// so a variant added later without a matching arm here fails to compile, satisfying
/// the brief's own "EXHAUSTIVE match (no wildcard arm)" requirement directly (this
/// module's `repair` dispatch below is exhaustive the same way, for the same reason).
/// Doubles as the "what this repair does" text a UI can surface.
pub(crate) fn repair_action_label(action: RepairAction) -> &'static str {
    match action {
        RepairAction::ReuploadDaemon => "Re-upload the flightdeckd binary",
        RepairAction::RestartDaemon => "Restart the flightdeckd daemon",
        RepairAction::InstallService => "Install the persistence service",
        RepairAction::EnableLinger => "Enable linger for this user",
        RepairAction::MaskSleep => "Mask sleep/suspend targets",
        RepairAction::RunInit => "Run flightdeckd init",
        RepairAction::InstallClaude => "Install Claude Code",
        RepairAction::SignInClaude => "Start the Claude sign-in flow",
        RepairAction::ProvisionPhone => {
            if cfg!(target_os = "macos") {
                "Provision this Mac's phone token"
            } else {
                "Provision this computer's phone token"
            }
        }
        RepairAction::ReconnectMac => {
            if cfg!(target_os = "macos") {
                "Reconnect this Mac"
            } else {
                "Reconnect this computer"
            }
        }
    }
}

/// One `machine_repair` outcome: what changed, plus a FRESH [`diagnose`] (never a stale
/// one from before the fix).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepairOutcome {
    pub action: RepairAction,
    /// See [`repair_action_label`] — the same "what this repair does" text a UI can
    /// show alongside `summary` without hardcoding its own copy of these 8 strings.
    pub label: &'static str,
    pub summary: String,
    pub diagnosis: ServerDiagnosis,
}

/// Whether `action` can have changed the remote `flightdeckd` binary/process the
/// cached probe behind `crate::ipc::commands::DAEMON_VERSION_CACHE` describes
/// (B_lifecycle-#6 review finding) — pulled into its own named, directly-testable gate
/// (rather than an inline `matches!` in [`repair`]'s body) so "the cache is invalidated
/// after each of the three daemon-changing repair kinds, and NOT after the other five"
/// is a regression test on its own.
fn repair_action_invalidates_daemon_version_cache(action: RepairAction) -> bool {
    matches!(action, RepairAction::ReuploadDaemon | RepairAction::RestartDaemon | RepairAction::InstallService)
}

/// Pure: is a successful `action` followed by the orphan init-token cleanup
/// ([`crate::appmcp::provision::clean_init_phone_token_if_due`], which decides whether
/// it is still due on that server)? Only after a repair that (re)starts the daemon —
/// updating flightdeckd ends with [`RepairAction::RestartDaemon`], the first moment a
/// server whose daemon was too old for the request can do it; [`RepairAction::
/// InstallService`] (re)starts it too — and only when the fresh diagnosis reads its
/// status (`daemon_running == Some(true)`): the request goes through the running
/// daemon's socket. A re-upload alone leaves the old daemon running, so it waits for
/// the restart; anything else leaves the daemon as it was.
fn init_cleanup_follows_repair(action: RepairAction, daemon_running: Option<bool>) -> bool {
    matches!(action, RepairAction::RestartDaemon | RepairAction::InstallService) && daemon_running == Some(true)
}

/// Pure: does the diagnosis that triggered [`RepairAction::InstallService`] mean
/// `repair`'s own arm for it must go through [`install::repair_user_unit_path`] (a
/// confirmed pre-B14 user unit missing its `Environment=PATH=` line) rather than the
/// generic, conflict-detecting [`install::install_service`] entry point? (B14 review
/// finding.) `true` only when BOTH facts are CONFIRMED — a User-level install AND
/// `user_unit_missing_path == Some(true)` — never on `None`/`Unknown`, which fall
/// through to the generic path exactly as every OTHER `InstallService` use (a
/// not-reboot-safe system/detached install) already did before this fix.
fn install_service_repair_needs_path_fix(d: &ServerDiagnosis) -> bool {
    d.installed_as == InstalledAs::User && d.user_unit_missing_path == Some(true)
}

/// What the "Install the persistence service" repair reports for
/// [`install::install_service`]'s outcome. An adopted install wrote NOTHING — it used to
/// come back as a success the panel took at its word, the button staying forever with
/// nothing done (audit sec-daemon-install#3) — so it is an error that says what is
/// there and what to do. Pure.
fn install_service_repair_summary(outcome: install::ServiceOutcome) -> Result<String, BootstrapError> {
    use install::{AdoptedKind, ServiceOutcome};
    let ServiceOutcome::Adopted { kind, unit_path } = outcome else {
        return Ok(format!("{outcome:?}"));
    };
    let found = match (kind, unit_path) {
        (AdoptedKind::SystemUnit, Some(path)) => format!("a system unit at {path}, which it leaves as it is"),
        (AdoptedKind::SystemUnit, None) => "a system unit, which it leaves as it is".to_string(),
        (AdoptedKind::ExistingBinary, Some(path)) => {
            format!("a flightdeckd at {path} that Flight Deck did not install, which it leaves as it is")
        }
        (AdoptedKind::ExistingBinary, None) | (AdoptedKind::ExistingConfig, _) => {
            "flightdeckd already set up there — with a service unit of its own, or running without one. No \
             service is installed next to a running daemon (that would start a second one): if it runs without \
             one, restart the server (or stop flightdeckd on it), then install the service again"
                .to_string()
        }
    };
    Err(BootstrapError::Other(format!("Nothing was changed: Flight Deck found {found}.")))
}

/// [`RepairAction::ReconnectMac`]'s own wording for [`connect::install_key`]'s one
/// password outcome it cannot recover from: a WRONG password and a server with
/// password auth disabled both surface identically from ssh
/// (`askpass::classify_output`'s `WrongPassword` — see that function's own doc for
/// why there is no way to tell the two apart at that layer), so this is the ONE,
/// honest message for both — never a bare "wrong password" that would send someone
/// re-typing a password that can never work if the server's sshd itself refuses the
/// auth method (supervisor decision, CRM `c9bf1482`: "degrade honestly … points to
/// removing and re-adding the server with the 'use a command instead' method").
/// Every OTHER `install_key` failure (unreachable, timed out, host key changed, key
/// installed but not accepted) is forwarded UNCHANGED — those already explain
/// themselves.
fn reconnect_mac_password_error(e: BootstrapError) -> BootstrapError {
    match e {
        BootstrapError::WrongPassword => BootstrapError::Other(format!(
            "this server refused this {MACHINE}'s saved login password — remove and re-add this \
             server using the \"use a command instead\" method."
        )),
        other => other,
    }
}

/// [`RepairAction::ReconnectMac`]'s wording when its host-key gate refuses a key this Mac
/// never saved: a paired server's key is normally saved by its first connection, so a
/// missing one means the saved file was lost — the way back is the same verified first
/// contact any new server gets. Every other refusal (a CHANGED key included) is
/// forwarded unchanged.
fn reconnect_mac_host_key_error(e: BootstrapError) -> BootstrapError {
    match e {
        BootstrapError::HostKeyUnconfirmed(fingerprint) => BootstrapError::Other(format!(
            "Flight Deck has no saved host key for this server (it now presents {fingerprint}), so it won't send it a \
             password — remove this server and add it again to check its identity."
        )),
        other => other,
    }
}

/// [`RepairAction::ReconnectMac`]'s own precondition, pulled out of [`repair`]'s body
/// so it is directly unit-testable — `repair` itself needs a `tauri::AppHandle` this
/// crate has no unit-test harness for (see
/// `resume_after_a_host_rotation_targets_the_rotated_host_not_the_frozen_one`'s own
/// doc for the same constraint), but THIS precondition is a plain, synchronous
/// `Option` check with no I/O at all.
fn require_connection_password(
    sudo_password: Option<&SecretString>,
) -> Result<&SecretString, BootstrapError> {
    sudo_password.ok_or(BootstrapError::NeedsConnectionPassword)
}

/// The repairs that need Flight Deck's OWN key file — the installer's keyed probe
/// ([`RepairAction::ReuploadDaemon`], the generic [`RepairAction::InstallService`]) and
/// re-pushing its public half ([`RepairAction::ReconnectMac`]). Every other repair rides
/// [`run_ssh_on_machine`], which also works for a server connected with this Mac's
/// own SSH keys/agent (`identity_file: None`, "Connect an existing server").
///
/// ⚠️ Two of them have an arm that needs no key — see [`repair_needs_dedicated_key`]:
/// [`RepairAction::InstallService`]'s PATH fix of a confirmed user unit
/// ([`install_service_repair_needs_path_fix`]), and [`RepairAction::ReuploadDaemon`] on a
/// Mac ([`ReuploadRoute::MacUpdate`]: the diagnosis says what the upload needs, and the
/// upload itself rides plain ssh — a Mac is set up by hand and often added with this
/// Mac's own keys, where the key requirement left "Update the daemon" unreachable).
///
/// The single source of truth: [`repair`] fetches the key up front for exactly these
/// (through [`repair_needs_dedicated_key`]) and its arms only ever take it from there
/// ([`listed_dedicated_key`]); the front mirrors the list as `KEY_ONLY_REPAIRS`
/// (`src/features/settings/serverBootstrapModel.ts`) to hide these repairs on a server
/// without Flight Deck's key, and `key_only_repairs_match_the_front` keeps the two lists
/// identical, in order.
pub(crate) const KEY_ONLY_REPAIRS: [RepairAction; 3] =
    [RepairAction::ReuploadDaemon, RepairAction::InstallService, RepairAction::ReconnectMac];

/// Whether `action`, against a server diagnosed as `d` (when [`repair`] diagnosed one
/// first), needs Flight Deck's own key — [`KEY_ONLY_REPAIRS`] minus the PATH-fix arm
/// of [`RepairAction::InstallService`] and the Mac update of
/// [`RepairAction::ReuploadDaemon`]. Mirrored by `repairNeedsDedicatedKey`
/// (`serverBootstrapModel.ts`).
fn repair_needs_dedicated_key(action: RepairAction, d: Option<&ServerDiagnosis>) -> bool {
    if action == RepairAction::InstallService && d.is_some_and(install_service_repair_needs_path_fix) {
        return false;
    }
    if action == RepairAction::ReuploadDaemon
        && d.is_some_and(|d| reupload_route(d.host_os.as_deref()) == Ok(ReuploadRoute::MacUpdate))
    {
        return false;
    }
    KEY_ONLY_REPAIRS.contains(&action)
}

/// The key [`repair`] fetched up front for `action` because [`KEY_ONLY_REPAIRS`] lists it.
/// An arm that needs a key the list didn't give it is a bug in the list, reported as
/// such — never papered over by fetching one on its own, which would let the list and
/// what actually needs a key drift apart (the front hides exactly the listed repairs).
fn listed_dedicated_key(key: Option<&str>, action: RepairAction) -> Result<&str, BootstrapError> {
    key.ok_or_else(|| {
        BootstrapError::Other(format!(
            "internal error: \"{}\" needs Flight Deck's own key, but KEY_ONLY_REPAIRS doesn't list it",
            repair_action_label(action)
        ))
    })
}

/// Flight Deck's own key for `machine`, or the refusal [`KEY_ONLY_REPAIRS`] get on a
/// server connected with this Mac's own SSH keys — naming the way out.
fn require_dedicated_key(machine: &MachineRecord) -> Result<&str, BootstrapError> {
    machine.identity_file.as_deref().ok_or_else(|| {
        BootstrapError::Other(format!(
            "this server was connected with this {MACHINE}'s own SSH keys, not a key Flight Deck holds — \
             this repair needs one. Reconnect the server with \"Connect an existing server\", then choose \
             \"A key for Flight Deck\"."
        ))
    })
}

/// The refusal of a repair whose fresh diagnosis could not reach the server, or `None`
/// when it did.
fn diagnosis_unreachable_refusal(d: &ServerDiagnosis) -> Option<String> {
    if d.reachable {
        return None;
    }
    let why = match &d.state {
        DiagnosisState::Failed { reason } => reason.as_str(),
        _ => "could not reach the server",
    };
    Some(format!(
        "couldn't check this server before the repair ({why}) — make sure it is on, awake and reachable, then try again"
    ))
}

/// Why `action` can't run on a host whose `uname -s` is `host_os`, or `None` when it
/// can. Only a Mac is refused anything: its daemon is a hand-made LaunchAgent, so the
/// systemd fixes would run commands that don't exist there (or, for
/// [`RepairAction::SignInClaude`], sign in from SSH, where claude can't reach the
/// Keychain the daemon's claude reads). Exhaustive on purpose, like
/// [`repair_action_label`]. [`RepairAction::ReuploadDaemon`] is routed on its own
/// ([`reupload_route`]): on a Mac, an update of the binary its single LaunchAgent runs,
/// gated on the diagnosis's verdict ([`mac_update_plan`]) — never a fresh install — and
/// [`linux_only_installer_refusal`] on every other non-Linux host.
fn repair_unsupported_on_host(action: RepairAction, host_os: Option<&str>) -> Option<String> {
    if host_os != Some(MACOS_UNAME) {
        return None;
    }
    let reason = match action {
        RepairAction::InstallService => {
            "Flight Deck can't install a service on a Mac — set flightdeckd up as a LaunchAgent on the Mac itself"
        }
        RepairAction::EnableLinger => {
            "linger is a systemd setting — a Mac's LaunchAgent comes back after a reboot through automatic login instead"
        }
        RepairAction::MaskSleep => {
            "a Mac's sleep is set with pmset — run `sudo pmset -a sleep 0 disablesleep 1` on the Mac"
        }
        RepairAction::SignInClaude => {
            "on a Mac, sign in to Claude on the Mac itself (run `claude`, then `/login`) — an SSH session can't \
             reach the Keychain the daemon's claude reads"
        }
        RepairAction::ReuploadDaemon
        | RepairAction::RestartDaemon
        | RepairAction::RunInit
        | RepairAction::InstallClaude
        | RepairAction::ProvisionPhone
        | RepairAction::ReconnectMac => return None,
    };
    Some(reason.to_string())
}

/// Shell functions — after [`mac_agent_fns`], and the diagnose script's own
/// `$FLIGHTDECKD_BIN` — that read on a Mac what "Update the daemon" needs to know.
/// `fd_mac_update_facts <plist>` prints:
/// - where an upload would land (`fd_resolve_daemon_target`:
///   [`templates::DAEMON_TARGET_RESOLUTION`] VERBATIM — the lines the upload itself
///   resolves its target with — in a subshell function so its variables stay inside it),
///   that path with its directory resolved through symlinks (`pwd -P`, the form `lsof`
///   reports below), and whether this login can write that directory (an upload writes a
///   temp file there, then renames it over the binary);
/// - the binary Flight Deck's own commands run there — `$FLIGHTDECKD_BIN`, the attach
///   command's, `status`'s and the version probe's resolution;
/// - given THE flightdeckd LaunchAgent (empty with none or several): the program launchd
///   runs for it (the loaded job's `program`, else the plist's `Program`/first
///   `ProgramArguments` word), and the executable of the daemon that job runs right now —
///   the job's own pid when it is `flightdeckd run` (a direct agent, or a wrapper that
///   `exec`s), else its child that is — read with `lsof` (its first `txt` entry is the
///   process's executable, symlinks resolved). Never `ps -o comm`: on macOS that is the
///   process's `argv[0]`, a bare `flightdeckd` for a wrapper that runs it through PATH.
///
/// Never exits early; [`judge_mac_update`] reads the verdict off the markers.
const MAC_UPDATE_FACTS_FN: &str = r#"fd_mac_update_facts() {
    fd_target=$(fd_resolve_daemon_target 2>/dev/null | sed -n 's/^FLIGHTDECK_TARGET://p')
    printf 'FLIGHTDECK_UPDATE_TARGET:%s\n' "$fd_target"
    fd_target_dir=$(dirname "$fd_target" 2>/dev/null)
    if [ -n "$fd_target" ] && [ -d "$fd_target_dir" ]; then
        printf 'FLIGHTDECK_UPDATE_TARGET_CANONICAL:%s/%s\n' \
            "$(cd "$fd_target_dir" >/dev/null 2>&1 && pwd -P)" "$(basename "$fd_target")"
        if [ -w "$fd_target_dir" ]; then
            echo FLIGHTDECK_UPDATE_TARGET_DIR_WRITABLE:yes
        else
            echo FLIGHTDECK_UPDATE_TARGET_DIR_WRITABLE:no
        fi
    else
        echo "FLIGHTDECK_UPDATE_TARGET_CANONICAL:"
        echo "FLIGHTDECK_UPDATE_TARGET_DIR_WRITABLE:"
    fi
    printf 'FLIGHTDECK_DAEMON_BIN:%s\n' "$FLIGHTDECKD_BIN"
    [ -n "$1" ] || return 0
    fd_job=
    fd_label=$(fd_plist_get "$1" Label)
    if [ -n "$fd_label" ]; then
        fd_job=$(launchctl print "gui/$(id -u)/$fd_label" 2>/dev/null)
    fi
    fd_program=$(printf '%s\n' "$fd_job" | sed -n 's/^[[:space:]]program = //p' | head -n 1)
    if [ -z "$fd_program" ]; then
        fd_program=$(fd_plist_get "$1" Program || fd_plist_get "$1" ProgramArguments:0)
    fi
    printf 'FLIGHTDECK_MAC_AGENT_PROGRAM:%s\n' "$fd_program"
    fd_daemon_pid=
    fd_pid=$(printf '%s\n' "$fd_job" | sed -n 's/^[[:space:]]pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)
    if [ -n "$fd_pid" ]; then
        if ps -o args= -p "$fd_pid" 2>/dev/null | grep -Eq "$FD_DAEMON_RE"; then
            fd_daemon_pid=$fd_pid
        else
            fd_daemon_pid=$(pgrep -P "$fd_pid" -f "$FD_DAEMON_RE" 2>/dev/null | head -n 1)
        fi
    fi
    fd_exe=
    if [ -n "$fd_daemon_pid" ]; then
        fd_exe=$(lsof -w -a -p "$fd_daemon_pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
    fi
    printf 'FLIGHTDECK_MAC_AGENT_DAEMON_EXE:%s\n' "$fd_exe"
}"#;

/// [`MAC_UPDATE_FACTS_FN`] with the target resolution it calls defined first — part of
/// [`diagnose_script`]'s preamble (only its Darwin branch calls it; Linux defines it and
/// never runs it).
fn mac_update_fns() -> String {
    format!("fd_resolve_daemon_target() (\n{}\n)\n{MAC_UPDATE_FACTS_FN}", templates::DAEMON_TARGET_RESOLUTION)
}

/// Pure verdict on the markers [`MAC_UPDATE_FACTS_FN`] prints, with the diagnosis's own
/// `FLIGHTDECK_MAC_AGENT_PLIST:`/`_INVALID:` lists — see [`mac_update_target`] for the
/// rules. Read into [`ServerDiagnosis::mac_daemon_update`] by every Mac diagnosis.
fn judge_mac_update(stdout: &str) -> MacDaemonUpdate {
    match mac_update_target(stdout) {
        Ok(target) => MacDaemonUpdate::Ready { target },
        Err(reason) => MacDaemonUpdate::Blocked { reason },
    }
}

/// A program launchd runs that IS a flightdeckd binary — an absolute path named
/// `flightdeckd` — rather than something that starts one (`/bin/sh -c …`, a start
/// script, or a bare name launchd looks up itself).
fn runs_flightdeckd_directly(program: &str) -> bool {
    program.starts_with('/') && std::path::Path::new(program).file_name().is_some_and(|n| n == "flightdeckd")
}

/// `Ok(path)` — what an update may replace — only when ALL of these hold, else `Err`
/// saying, in the user's words, which one fails and what to do by hand:
/// - exactly ONE LaunchAgent runs flightdeckd: none is a Mac that was never set up (a
///   fresh install stays the owner's job — the agent has to be a LaunchAgent of the
///   logged-in user, see [`InstalledAs::LaunchAgent`]); several is the ambiguity
///   [`restart_plan`]'s LaunchAgent restart refuses too;
/// - the upload's target IS what that agent runs. An agent whose program is a flightdeckd
///   binary is checked on that path — the one launchd execs again after a restart. An
///   agent that starts it through a wrapper (`/bin/sh -c`, a start script setting PATH
///   first) is checked on the executable of the daemon its job runs right now, the only
///   sure sign of what the wrapper runs; with none to read, it is refused rather than
///   guessed. Otherwise the new binary would land where nothing runs it, and the panel
///   would offer "Restart" forever, each restart bringing the old daemon back. Only a
///   flightdeckd binary is ever named as the file to copy over by hand: telling the user
///   to copy the daemon over a wrapper (or over `/bin/sh`) would leave an agent that
///   starts nothing;
/// - Flight Deck's own commands there (attach, status, the version check —
///   `$FLIGHTDECKD_BIN`) run that same path: a stale copy earlier in their search would
///   keep attaching with the old client, and the version they read would never show the
///   restart the update calls for;
/// - this SSH login can write the target's directory — a root-owned `/usr/local/bin` on
///   Apple silicon would otherwise fail mid-upload.
fn mac_update_target(stdout: &str) -> Result<String, String> {
    use crate::ipc::commands::extract_marker;

    let marker = |name: &str| extract_marker(stdout, name).filter(|v| !v.is_empty());
    let plists = marker_lines(stdout, "FLIGHTDECK_MAC_AGENT_PLIST:");
    let plist = match plists.as_slice() {
        [one] => one,
        [] => {
            let invalid = marker_lines(stdout, "FLIGHTDECK_MAC_AGENT_INVALID:");
            return Err(if invalid.is_empty() {
                "no LaunchAgent runs flightdeckd on this Mac — Flight Deck only updates an existing one. \
                 Set flightdeckd up by hand as a LaunchAgent of this user first."
                    .to_string()
            } else {
                format!(
                    "no flightdeckd LaunchAgent launchd can load on this Mac: {} can't be parsed — fix it \
                     (plutil -lint says what's wrong), then update",
                    invalid.join(", ")
                )
            });
        }
        several => {
            return Err(format!(
                "several LaunchAgents run flightdeckd ({}) — keep only one in ~/Library/LaunchAgents, then update",
                several.join(", ")
            ))
        }
    };
    let target = marker("FLIGHTDECK_UPDATE_TARGET:").ok_or_else(|| {
        "could not tell where flightdeckd lives on this Mac, so there is nothing safe to replace".to_string()
    })?;
    let program = marker("FLIGHTDECK_MAC_AGENT_PROGRAM:").ok_or_else(|| {
        format!("could not read which program the LaunchAgent {plist} runs, so an update might not reach it")
    })?;
    if runs_flightdeckd_directly(&program) {
        if program != target {
            return Err(format!(
                "the LaunchAgent {plist} runs {program}, but an update would replace {target} — Flight Deck only \
                 updates the flightdeckd binary the LaunchAgent runs itself. Point the LaunchAgent at {target}, or copy \
                 a newer macOS build over {program} by hand."
            ));
        }
    } else {
        let canonical = marker("FLIGHTDECK_UPDATE_TARGET_CANONICAL:").unwrap_or_else(|| target.clone());
        match marker("FLIGHTDECK_MAC_AGENT_DAEMON_EXE:") {
            None => {
                return Err(format!(
                    "the LaunchAgent {plist} starts flightdeckd through {program}, and Flight Deck can't tell which \
                     flightdeckd binary that runs — only a daemon the agent is running right now says, and none could \
                     be read. Update the binary it runs by hand, or set the LaunchAgent's ProgramArguments to \
                     {target} run."
                ))
            }
            Some(exe) if exe != canonical && exe != target => {
                return Err(format!(
                    "the LaunchAgent {plist} starts flightdeckd through {program}, which runs {exe}, but an update \
                     would replace {target}. Copy a newer macOS build over {exe} by hand, or set the LaunchAgent's \
                     ProgramArguments to {target} run."
                ))
            }
            Some(_) => {}
        }
    }
    let client = marker("FLIGHTDECK_DAEMON_BIN:").unwrap_or_default();
    if client != target {
        return Err(if client.contains('/') {
            format!(
                "Flight Deck's own commands on this Mac (attach, status, the version check) run {client}, while the \
                 LaunchAgent runs {target}: after an update they would keep using the old copy. Remove {client} (or \
                 replace it with a link to {target}), then update."
            )
        } else {
            format!(
                "Flight Deck's own commands can't find flightdeckd on this Mac (they look on the SSH login's PATH, \
                 then in ~/.local/bin and /usr/local/bin), while the LaunchAgent runs {target} — put a link to it \
                 there, then update."
            )
        });
    }
    if marker("FLIGHTDECK_UPDATE_TARGET_DIR_WRITABLE:").as_deref() == Some("no") {
        let dir = std::path::Path::new(&target).parent().map_or_else(|| target.clone(), |d| d.display().to_string());
        return Err(format!(
            "this SSH login can't write {dir}, where the flightdeckd the LaunchAgent runs lives — an update replaces \
             the file there. Copy a newer macOS build over {target} by hand (with sudo), or move flightdeckd to \
             ~/.local/bin and point the LaunchAgent at it."
        ));
    }
    Ok(target)
}

/// How [`RepairAction::ReuploadDaemon`] goes on a server whose `uname -s` is `host_os` —
/// pure, so the routing [`repair`] does (it needs an `AppHandle`) is tested on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReuploadRoute {
    /// The installer's upload, as it always was: Linux, or an OS the diagnosis didn't
    /// report (the keyed probe decides then). Needs Flight Deck's own key — its probe is
    /// keyed ([`KEY_ONLY_REPAIRS`]).
    Installer,
    /// An UPDATE of a Mac's existing LaunchAgent install, gated on the fresh diagnosis's
    /// verdict ([`mac_update_plan`]) and run over plain ssh — no key of Flight Deck's
    /// needed ([`repair_needs_dedicated_key`]). A fresh Mac install stays refused: with no
    /// agent, the verdict is [`MacDaemonUpdate::Blocked`].
    MacUpdate,
}

/// [`ReuploadRoute`] for `host_os`, or the installer's refusal of any other non-Linux host
/// ([`linux_only_installer_refusal`]).
fn reupload_route(host_os: Option<&str>) -> Result<ReuploadRoute, String> {
    match host_os.map(str::trim) {
        Some(MACOS_UNAME) => Ok(ReuploadRoute::MacUpdate),
        os => linux_only_installer_refusal(os).map_or(Ok(ReuploadRoute::Installer), Err),
    }
}

/// [`ReuploadRoute::MacUpdate`]'s go-ahead from a fresh diagnosis `d`: the CPU that picks
/// the bundled build, and the one path the update may replace — exactly what
/// [`judge_mac_update`] approved (the upload refuses any other: `install::upload_daemon`'s
/// `expected_target`). `Err` says why not, in the words the panel shows. The restart
/// that makes launchd run the new binary stays the explicit, busy-guarded
/// [`RepairAction::RestartDaemon`] (`kickstart -k`, which ends every conversation: the
/// daemon is their parent).
fn mac_update_plan(d: &ServerDiagnosis) -> Result<(&str, &str), String> {
    let target = match &d.mac_daemon_update {
        Some(MacDaemonUpdate::Ready { target }) => target.as_str(),
        Some(MacDaemonUpdate::Blocked { reason }) => return Err(reason.clone()),
        None => {
            return Err("could not read this Mac's LaunchAgent just now, so an update might not reach it — refresh \
                        the server, then update"
                .to_string())
        }
    };
    let arch = d.host_arch.as_deref().ok_or_else(|| "the server did not report its CPU architecture".to_string())?;
    Ok((arch, target))
}

/// Dispatch + apply one [`RepairAction`] against an ALREADY-PAIRED `machine`, then
/// re-diagnose. `sudo_password` beyond the brief's own shorthand signature — see the
/// module doc. `sudo_password` carries either a Linux `sudo` password (every action
/// except one) OR — for [`RepairAction::ReconnectMac`] specifically — this server's
/// own SSH LOGIN password, depending on `action`: no signature/rename change, the
/// same parameter is just reused for the analogous "repair needs a password → show
/// inline prompt" UI loop `ServerStatusPanel.tsx` already has, generalized with a
/// second wording branch.
async fn repair(
    app: &tauri::AppHandle,
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    action: RepairAction,
    sudo_password: Option<&SecretString>,
) -> Result<RepairOutcome, BootstrapError> {
    // `install::escalate_persistence` reports no idempotency signal of its own (`()`
    // whether it changed anything or the server was already in that state) — captured
    // BEFORE dispatch so `EnableLinger`/`MaskSleep`'s summaries below can say "already
    // enabled/masked" instead of a fixed string that claims a change even on a no-op
    // re-run (B11 review finding). `InstallService` ALSO needs it, fresh, to decide
    // WHICH repair path it must take — see `install_service_repair_needs_path_fix`'s
    // doc and that arm below (B14 review finding: routing every `InstallService` call
    // through `install::install_service`'s generic conflict-detecting entry point made
    // the `user_unit_missing_path` repair a permanent no-op on every real server).
    //
    // The same fresh diagnosis also tells a Mac apart, for the fixes that only exist on
    // a systemd server (see `repair_unsupported_on_host`) — and for `ReuploadDaemon`,
    // which on a Mac is an UPDATE gated on that diagnosis's own verdict, over plain ssh
    // (`reupload_route`, `mac_update_plan`), while everywhere else it stays the
    // installer's keyed upload.
    let before = match action {
        RepairAction::EnableLinger
        | RepairAction::MaskSleep
        | RepairAction::InstallService
        | RepairAction::SignInClaude
        | RepairAction::ReuploadDaemon => Some(diagnose(machine, known_hosts).await),
        _ => None,
    };
    if let Some(reason) = before.as_ref().and_then(|d| repair_unsupported_on_host(action, d.host_os.as_deref())) {
        return Err(BootstrapError::Other(reason));
    }
    // The fresh diagnosis couldn't reach the server: every decision below (a Mac or not,
    // which route, which key) would be made blind — a Mac would be sent down the Linux
    // installer's keyed route and refused for a key it doesn't need. Say what happened.
    if let Some(reason) = before.as_ref().and_then(diagnosis_unreachable_refusal) {
        return Err(BootstrapError::Other(reason));
    }
    // Up front, before any password is asked for or anything runs: `KEY_ONLY_REPAIRS` is
    // what the front hides on such a server, and this is where it is enforced — the
    // ONLY place an arm below gets Flight Deck's key from (`listed_dedicated_key`).
    let dedicated_key =
        if repair_needs_dedicated_key(action, before.as_ref()) { Some(require_dedicated_key(machine)?) } else { None };
    let summary = match action {
        RepairAction::ReuploadDaemon => {
            let fresh = before.as_ref().expect("diagnosed above for ReuploadDaemon");
            // A Mac is the one non-Linux host that can be uploaded to, and only as an
            // UPDATE of the binary its single LaunchAgent runs — the fresh diagnosis's
            // verdict refuses everything else, a fresh install included. Every other
            // non-Linux host stays refused exactly as the wizard refuses it.
            match reupload_route(fresh.host_os.as_deref()).map_err(BootstrapError::Other)? {
                ReuploadRoute::MacUpdate => {
                    let (arch, approved) = mac_update_plan(fresh).map_err(BootstrapError::Other)?;
                    let os = fresh.host_os.as_deref();
                    let outcome = install::upload_daemon(app, machine, os, arch, Some(approved), known_hosts).await?;
                    format!("{outcome:?}")
                }
                ReuploadRoute::Installer => {
                    let identity_file = listed_dedicated_key(dedicated_key, action)?;
                    let bootstrap_target = connect::BootstrapTarget {
                        host: machine.host.clone(),
                        port: machine.port,
                        user: machine.user.clone(),
                    };
                    let probe = connect::probe(&bootstrap_target, identity_file, known_hosts.unwrap_or_default()).await?;
                    let os = probe.os.as_deref();
                    // The keyed probe decides on this route, as it always did. A Mac it
                    // finds here is one the diagnosis couldn't read a moment ago: never
                    // sent the installer's upload, and never told it only takes Linux.
                    if reupload_route(os).map_err(BootstrapError::Other)? == ReuploadRoute::MacUpdate {
                        return Err(BootstrapError::Other(
                            "this server is a Mac, but its diagnosis couldn't read it a moment ago — refresh the \
                             server, then update"
                                .to_string(),
                        ));
                    }
                    let arch = probe.arch.as_deref().ok_or_else(|| {
                        BootstrapError::Other("the server did not report its CPU architecture".to_string())
                    })?;
                    let outcome = install::upload_daemon(app, machine, os, arch, None, known_hosts).await?;
                    format!("{outcome:?}")
                }
            }
        }
        RepairAction::RestartDaemon => {
            restart_daemon(machine, known_hosts, sudo_password).await?;
            "restarted".to_string()
        }
        RepairAction::InstallService => {
            let fresh = before.as_ref().expect("diagnosed above for InstallService");
            if install_service_repair_needs_path_fix(fresh) {
                // Dedicated path — see `install::repair_user_unit_path`'s own doc for
                // why the generic entry point below would just adopt-and-do-nothing
                // here (B14 review finding).
                let outcome = install::repair_user_unit_path(machine, known_hosts).await?;
                format!("{outcome:?}")
            } else {
                let identity_file = listed_dedicated_key(dedicated_key, action)?;
                let target = connect::BootstrapTarget {
                    host: machine.host.clone(),
                    port: machine.port,
                    user: machine.user.clone(),
                };
                let probe = connect::probe(&target, identity_file, known_hosts.unwrap_or_default()).await?;
                install_service_repair_summary(install::install_service(machine, &probe, known_hosts).await?)?
            }
        }
        RepairAction::EnableLinger => {
            install::escalate_persistence(machine, known_hosts, sudo_password, false).await?;
            if before.as_ref().and_then(|d| d.linger) == Some(true) {
                "linger was already enabled".to_string()
            } else {
                "linger enabled".to_string()
            }
        }
        RepairAction::MaskSleep => {
            install::escalate_persistence(machine, known_hosts, sudo_password, true).await?;
            if before.as_ref().and_then(|d| d.sleep_masked) == Some(true) {
                "sleep targets were already masked".to_string()
            } else {
                "sleep targets masked".to_string()
            }
        }
        RepairAction::RunInit => {
            let outcome = server_setup::run_init(machine, known_hosts, &machine.label).await?;
            format!("{outcome:?}")
        }
        RepairAction::InstallClaude => {
            let version = server_setup::install_claude(machine, known_hosts).await?;
            format!("installed: {version}")
        }
        RepairAction::SignInClaude => {
            let sessions = app.state::<Arc<server_setup::LoginSessions>>();
            let session = server_setup::start_claude_login(app.clone(), sessions, machine.id.clone())
                .await
                .map_err(BootstrapError::Other)?;
            format!("sign-in session {} started", session.session_id)
        }
        RepairAction::ProvisionPhone => {
            let store = app.state::<Store>();
            let state = crate::appmcp::provision::provision_phone_on_machine(&store, known_hosts, &machine.id)
                .await
                .map_err(BootstrapError::Other)?;
            let registry = app.state::<Arc<crate::appmcp::provision::ProvisionRegistry>>();
            registry.record(&machine.id, state.clone());
            format!("{state:?}")
        }
        RepairAction::ReconnectMac => {
            // `sudo_password` doubles for this action's own login password — see
            // `repair`'s own doc comment on that parameter, and
            // `BootstrapError::NeedsConnectionPassword`'s doc for the wizard-loop
            // contract this leans on (the SAME "repair needs a password → show
            // inline prompt" flow `EnableLinger`/`MaskSleep` already use).
            let password = require_connection_password(sudo_password)?;
            let identity_file = listed_dedicated_key(dedicated_key, action)?;
            // Sibling-file convention this crate's own key-generation already uses
            // (see the `ThrowawayKey` test fixtures elsewhere in `bootstrap::`).
            let pub_key_path = format!("{identity_file}.pub");
            let public_key = tokio::fs::read_to_string(&pub_key_path).await.map_err(|e| {
                BootstrapError::Other(format!("could not read this {MACHINE}'s saved public key ({pub_key_path}): {e}"))
            })?;
            let target =
                connect::BootstrapTarget { host: machine.host.clone(), port: machine.port, user: machine.user.clone() };
            // M12: the password goes only to the key this Mac already saved for this
            // server — never to one pinned on the spot (there is no confirmation UI here).
            // `machine` is a paired server by definition: its saved key is the pairing's.
            connect::ensure_confirmed_host_key(&target, known_hosts.unwrap_or_default(), None, true)
                .await
                .map_err(reconnect_mac_host_key_error)?;
            // `install_key`'s own `verify_key_accepted` step already classifies a
            // mid-repair host-key mismatch as `BootstrapError::HostKeyMismatch`,
            // surfaced generically like any other repair error — no special-casing
            // needed here. Only its `WrongPassword` outcome gets reworded: a wrong
            // password and a server with password auth disabled are INDISTINGUISHABLE
            // from ssh's own wire (both are "Permission denied"), so this is the one,
            // honest message for both — see `reconnect_mac_password_error`'s doc.
            let outcome = connect::install_key(
                &target,
                password.expose(),
                identity_file,
                public_key.trim(),
                known_hosts.unwrap_or_default(),
            )
            .await
            .map_err(reconnect_mac_password_error)?;
            format!("{outcome:?}")
        }
    };

    // B_lifecycle-#6 review finding: `crate::ipc::commands::DAEMON_VERSION_CACHE` is
    // per-app-run and, before this, was invalidated ONLY on a clap-rejection downgrade
    // (`session.rs::run_actor`) — a same-run UPGRADE via one of these three repairs left
    // the stale OLD version cached, so `--supports-skip`/`--title` stayed silently off
    // for every later spawn until the app restarted. Drop the entry unconditionally for
    // any repair that changed (or could have changed) the remote `flightdeckd`
    // binary/process the cached probe describes (a `?` above already returned early on
    // failure — reaching here means the action succeeded), and let the very next call
    // to `daemon_version_for_machine` re-probe for real.
    settle_daemon_version_cache_after_repair(action, &machine.id);
    let diagnosis = with_bundled_version(app, diagnose(machine, known_hosts).await);
    if init_cleanup_follows_repair(action, diagnosis.daemon_running) {
        // In the background: the repair's own answer never waits on it, and it shows
        // nothing (one log line) — see `appmcp::provision::clean_init_phone_token`.
        let app = app.clone();
        let machine_id = machine.id.clone();
        let known_hosts = known_hosts.map(str::to_string);
        tauri::async_runtime::spawn(async move {
            let store = app.state::<Store>();
            crate::appmcp::provision::clean_init_phone_token_if_due(&store, known_hosts.as_deref(), &machine_id).await;
        });
    }
    Ok(RepairOutcome { action, label: repair_action_label(action), summary, diagnosis })
}

/// What a SUCCESSFUL [`repair`] does to `crate::ipc::commands::DAEMON_VERSION_CACHE`:
/// drops `machine_id`'s entry when `action` could have changed the server's
/// `flightdeckd` ([`repair_action_invalidates_daemon_version_cache`]) — a re-upload
/// above all, the Mac's update included: the cache holds the ON-DISK `flightdeckd
/// --version` (what a freshly exec'd `flightdeckd attach` will parse flags with), and an
/// upload changes it at once, restart or not. Without this, flags gated on the new
/// version stayed off until the app was relaunched. Split out of [`repair`] (which needs
/// an `AppHandle`) so the effect itself is tested, not just the gate.
fn settle_daemon_version_cache_after_repair(action: RepairAction, machine_id: &str) {
    if repair_action_invalidates_daemon_version_cache(action) {
        invalidate_daemon_version_cache(machine_id);
    }
}

/// Claims this machine's [`ServerLocks`] slot (B_lifecycle-#7 review finding) BEFORE
/// running anything — `Err` with [`server_busy_error`] when a `bootstrap_server`/
/// `bootstrap_resume`/another `machine_repair` is already in flight against it (the
/// previous behaviour: the Settings UI kept every paired machine's Repair buttons
/// clickable regardless of what else was running against that same host, including
/// the "+ Add a server" wizard). Always released before this returns — `repair` itself
/// never pauses across separate calls the way the bootstrap pipeline can.
#[tauri::command]
#[specta::specta]
pub async fn machine_repair(
    app: tauri::AppHandle,
    locks: tauri::State<'_, Arc<ServerLocks>>,
    machine_id: String,
    action: RepairAction,
    sudo_password: Option<String>,
) -> Result<RepairOutcome, String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let guard = ServerLockGuard::acquire(&locks, machine.id.clone(), repair_action_label(action))
        .map_err(server_busy_error)?;
    let known_hosts = known_hosts_path(&app);
    let sudo_password = sudo_password.map(SecretString::new);
    let result = repair(&app, &machine, known_hosts.as_deref(), action, sudo_password.as_ref()).await.map_err(|e| e.to_string());
    drop(guard);
    result
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- diagnose against the CLI's real, pretty-printed `auth status --json` ----

    /// Runs the REAL diagnose script (locally, `/bin/sh`) with a fake `claude` on PATH
    /// that prints `auth status --json` exactly as claude 2.1.278 does on a real server:
    /// pretty-printed over several lines. Everything else the script probes (systemd,
    /// loginctl, the daemon) is simply absent here and degrades to empty markers.
    #[cfg(unix)]
    #[test]
    fn diagnose_reads_a_pretty_printed_auth_status_as_signed_in() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fd-diagnose-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\n\
             case \"$*\" in\n\
             '--version') echo '2.1.278 (Claude Code)' ;;\n\
             'auth status --json') printf '{\\n  \"loggedIn\": true,\\n  \"authMethod\": \"claude.ai\",\\n  \"email\": \"a@b.com\"\\n}\\n' ;;\n\
             esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        // The script branches on `uname -s`: pin the Linux branch, which is the one
        // that reads `claude auth status` (CI and dev machines are Macs).
        let fake_uname = dir.join("uname");
        std::fs::write(&fake_uname, "#!/bin/sh\necho Linux\n").unwrap();
        std::fs::set_permissions(&fake_uname, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(diagnose_script())
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .env("HOME", &dir)
            .output()
            .expect("run the diagnose script");
        let _ = std::fs::remove_dir_all(&dir);
        let stdout = String::from_utf8_lossy(&out.stdout);

        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.host_os.as_deref(), Some("Linux"), "stdout: {stdout}");
        assert_eq!(d.claude_installed, Some(true), "stdout: {stdout}");
        assert_eq!(d.claude_logged_in, Some(true), "a pretty-printed signed-in status must parse: {stdout}");
        assert_eq!(d.claude_email.as_deref(), Some("a@b.com"));
    }

    // ---- PIPELINE_ORDER (first real novice run, 19/09: the service was started before
    // `flightdeckd init` had written its config → crash loop → pipeline failed) ----

    fn pos(id: StepId) -> usize {
        PIPELINE_ORDER.iter().position(|s| *s == id).expect("every StepId is in PIPELINE_ORDER")
    }

    #[test]
    fn run_init_runs_after_the_upload_and_before_the_service_is_started() {
        assert!(pos(StepId::UploadDaemon) < pos(StepId::RunInit), "init executes the uploaded binary");
        assert!(
            pos(StepId::RunInit) < pos(StepId::InstallService),
            "`flightdeckd run` refuses to start without the config `init` writes — a service \
             started first crash-loops"
        );
    }

    #[test]
    fn the_probe_runs_before_init_so_our_own_config_is_never_seen_as_a_conflict() {
        assert!(pos(StepId::Probe) < pos(StepId::RunInit));
    }

    #[test]
    fn pipeline_order_lists_every_step_exactly_once() {
        let mut ids = PIPELINE_ORDER.to_vec();
        ids.sort_by_key(|id| id.wire_str());
        ids.dedup();
        assert_eq!(ids.len(), PIPELINE_ORDER.len());
    }

    // ---- is_enabled_yes ----

    #[test]
    fn is_enabled_yes_recognizes_the_real_wording() {
        assert_eq!(is_enabled_yes(Some("enabled")), Some(true));
        assert_eq!(is_enabled_yes(Some("disabled")), Some(false));
        assert_eq!(is_enabled_yes(Some("masked")), Some(false));
        assert_eq!(is_enabled_yes(Some("static")), Some(false));
        assert_eq!(is_enabled_yes(Some("")), None);
        assert_eq!(is_enabled_yes(None), None);
    }

    // ---- claude_already_resolvable (B14) ----

    fn probe_with_claude(claude_missing: bool) -> RemoteProbeResult {
        RemoteProbeResult {
            claude_version: None,
            claude_missing,
            flightdeckd_version: None,
            flightdeckd_missing: false,
            flightdeckd_outdated: false,
            conflict: None,
            os: None,
            arch: None,
            systemd: None,
            passwordless_sudo: None,
            linger: None,
            kill_user_processes: None,
            user_unit: None,
        }
    }

    #[test]
    fn claude_already_resolvable_mirrors_the_probe_fact() {
        assert!(claude_already_resolvable(&probe_with_claude(false)), "the probe found a working claude");
        assert!(!claude_already_resolvable(&probe_with_claude(true)), "the probe found none — InstallClaude must run");
    }

    /// Audit sec-daemon-install#3: an adopted install wrote nothing, and the repair
    /// reported it as a success the panel took at its word.
    #[test]
    fn install_service_repair_reports_adopted_as_no_change() {
        use install::{AdoptedKind, ServiceOutcome};
        let adopted = |kind, unit_path: Option<&str>| ServiceOutcome::Adopted { kind, unit_path: unit_path.map(str::to_string) };
        for outcome in [
            adopted(AdoptedKind::ExistingConfig, None),
            adopted(AdoptedKind::SystemUnit, Some("/etc/systemd/system/flightdeckd.service")),
            adopted(AdoptedKind::ExistingBinary, Some("/opt/fd/flightdeckd")),
        ] {
            match install_service_repair_summary(outcome) {
                Err(BootstrapError::Other(msg)) => assert!(msg.starts_with("Nothing was changed"), "{msg}"),
                other => panic!("an adoption is no repair: {other:?}"),
            }
        }
        assert!(install_service_repair_summary(ServiceOutcome::UserUnit).is_ok());
    }

    // ---- install_service_repair_needs_path_fix (B14 review fix — blocker) ----

    #[test]
    fn install_service_repair_needs_path_fix_only_for_a_confirmed_user_unit_missing_it() {
        assert!(
            install_service_repair_needs_path_fix(&ServerDiagnosis {
                installed_as: InstalledAs::User,
                user_unit_missing_path: Some(true),
                ..base_diagnosis()
            }),
            "a confirmed pre-B14 user unit must take the dedicated path"
        );
        assert!(
            !install_service_repair_needs_path_fix(&ServerDiagnosis {
                installed_as: InstalledAs::User,
                user_unit_missing_path: Some(false),
                ..base_diagnosis()
            }),
            "a user unit that already carries PATH must go through the generic path (a no-op there)"
        );
        assert!(
            !install_service_repair_needs_path_fix(&ServerDiagnosis {
                installed_as: InstalledAs::User,
                user_unit_missing_path: None,
                ..base_diagnosis()
            }),
            "an unconfirmed PATH check must never be treated as a repair trigger"
        );
        assert!(
            !install_service_repair_needs_path_fix(&ServerDiagnosis {
                installed_as: InstalledAs::System,
                user_unit_missing_path: Some(true),
                ..base_diagnosis()
            }),
            "the field is meaningless outside a User-level install — never routed through the user-unit-only repair"
        );
        assert!(
            !install_service_repair_needs_path_fix(&ServerDiagnosis {
                installed_as: InstalledAs::Detached,
                user_unit_missing_path: Some(true),
                ..base_diagnosis()
            }),
            "a not-reboot-safe detached install must keep using the generic InstallService path"
        );
    }

    // ---- crate-wide regression: no remote script bare-checks `claude` (B14) ---------
    //
    // Every remote script/command that touches `claude` must resolve it through the ONE
    // shared resolver (`crate::ipc::commands::resolve_claude_bin_expr`) — never a bare
    // `command -v claude`, which silently mis-reports a genuinely-installed,
    // official-installer `claude` (landing in `~/.local/bin`, never on a
    // non-interactive ssh shell's `PATH`) as missing. This test is the ONE place that
    // scans every such script/command in the crate at once, so a future remote `claude`
    // call site that forgets the resolver fails HERE, not in a live server report.

    #[test]
    fn no_remote_script_bare_checks_command_dash_v_claude() {
        let scripts: Vec<(&str, String)> = vec![
            ("ipc::commands::probe_script", crate::ipc::commands::probe_script()),
            ("bootstrap::connect::probe_script", connect::probe_script()),
            ("bootstrap::orchestrator::diagnose_script", diagnose_script()),
            ("bootstrap::server_setup::claude_auth_status_cmd", server_setup::claude_auth_status_cmd()),
            ("bootstrap::server_setup::claude_auth_login_cmd", server_setup::claude_auth_login_cmd()),
        ];
        for (name, script) in &scripts {
            assert!(
                !script.contains("command -v claude"),
                "{name} still bare-checks `command -v claude` — every remote claude lookup \
                 must go through resolve_claude_bin_expr instead:\n{script}"
            );
            assert!(script.to_lowercase().contains("claude"), "{name} should still reference claude somehow: {script}");
        }
    }

    // ---- count_busy_conversations ----

    #[test]
    fn count_busy_conversations_counts_only_busy_rows() {
        let stdout = r#"{"type":"fd_status","version":"0.2.0","label":"n","conversations":[
            {"conversation":"a","busy":true},
            {"conversation":"b","busy":false},
            {"conversation":"c","busy":true}
        ]}"#;
        assert_eq!(count_busy_conversations(stdout), Some(2));
    }

    /// Background work outlives its turn (`busy` false, flightdeckd 0.4.0's
    /// `background_tasks`), and so does a background agent's permission prompt
    /// (`pending`): a restart would kill both, so both count.
    #[test]
    fn count_busy_conversations_counts_background_work_and_pending_requests() {
        let stdout = r#"{"type":"fd_status","version":"0.4.0","label":"n","conversations":[
            {"conversation":"a","busy":false,"pending":0,"background_tasks":1},
            {"conversation":"b","busy":false,"pending":1,"background_tasks":0},
            {"conversation":"c","busy":false,"pending":0,"background_tasks":0},
            {"conversation":"d","busy":false}
        ]}"#;
        assert_eq!(count_busy_conversations(stdout), Some(2));
    }

    /// An idle conversation holding a session-only schedule (`/loop`, a `CronCreate`, a
    /// `ScheduleWakeup` — flightdeckd 0.6.0's `scheduled`) loses it to a restart, which
    /// stops its claude: it counts, though nothing runs right now.
    #[test]
    fn status_row_at_work_counts_scheduled_jobs() {
        let row = serde_json::json!({"running": true, "busy": false, "pending": 0, "background_tasks": 0, "scheduled": 1});
        assert!(status_row_at_work(&row));
        let stdout = r#"{"type":"fd_status","version":"0.6.0","label":"n","conversations":[
            {"conversation":"a","running":true,"busy":false,"pending":0,"background_tasks":0,"scheduled":1},
            {"conversation":"b","running":true,"busy":false,"pending":0,"background_tasks":0,"scheduled":0}
        ]}"#;
        assert_eq!(count_busy_conversations(stdout), Some(1), "the RESTART RULE must hold for it");
    }

    /// A live session that did not answer flightdeckd's own status query in time
    /// (0.6.0 flags it `unanswered`) may be mid-turn: a restart must not pass it for idle,
    /// even from a daemon that would not also say `busy`.
    #[test]
    fn a_row_whose_session_did_not_answer_counts_at_work() {
        let row = serde_json::json!({"running": true, "busy": false, "pending": 0, "background_tasks": 0, "unanswered": true});
        assert!(status_row_at_work(&row));
        let stdout = r#"{"type":"fd_status","version":"0.6.0","label":"n","conversations":[
            {"conversation":"a","running":true,"busy":false,"pending":0,"background_tasks":0,"unanswered":true},
            {"conversation":"b","running":true,"busy":false,"pending":0,"background_tasks":0,"unanswered":false}
        ]}"#;
        assert_eq!(count_busy_conversations(stdout), Some(1));
    }

    /// flightdeckd < 0.4.0 has no `background_tasks`: a live conversation whose turn ended
    /// may still run a background agent or workflow there, which a restart would kill
    /// unseen — its work is UNKNOWN, never 0. A row with no process has nothing to kill.
    #[test]
    fn count_busy_conversations_is_unknown_for_a_live_row_from_a_pre_0_4_daemon() {
        let old = r#"{"type":"fd_status","version":"0.3.2","label":"n","conversations":[
            {"conversation":"a","running":true,"busy":false,"pending":0}
        ]}"#;
        assert_eq!(count_busy_conversations(old), None);
        let gone = r#"{"type":"fd_status","version":"0.3.2","label":"n","conversations":[
            {"conversation":"a","running":false,"busy":false,"pending":0}
        ]}"#;
        assert_eq!(count_busy_conversations(gone), Some(0));

        let stdout = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            &format!("FLIGHTDECK_STATUS_JSON:{}", old.replace('\n', "")),
        );
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.daemon_running, Some(true));
        assert_eq!(d.busy_conversations, None);
        let err = restart_plan(&ServerDiagnosis { daemon_version_running: Some("0.3.2".into()), ..d }, "admin")
            .expect_err("restarted a daemon whose background work is unknown");
        assert!(err.to_string().contains("too old to report"), "{err}");
    }

    #[test]
    fn count_busy_conversations_zero_on_an_empty_list() {
        let stdout = r#"{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#;
        assert_eq!(count_busy_conversations(stdout), Some(0));
    }

    #[test]
    fn count_busy_conversations_none_on_garbage() {
        assert_eq!(count_busy_conversations("not json"), None);
        assert_eq!(count_busy_conversations(""), None);
    }

    // ---- parse_diagnosis_fields: each sub-probe independently missing/garbled ----

    /// A full, healthy accumulating-script transcript (system unit, running, claude
    /// signed in) — the baseline every "one marker missing/garbled" test below mutates
    /// exactly ONE line of, to prove the others stay intact (see the brief's own
    /// requirement).
    fn healthy_stdout() -> String {
        [
            "FLIGHTDECK_UNIT_SYSTEM:yes",
            "FLIGHTDECK_UNIT_USER:no",
            "FLIGHTDECK_BIN_PRESENT:yes",
            "FLIGHTDECK_VERSION_DISK:flightdeckd 0.2.0",
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_LINGER:no",
            "FLIGHTDECK_ENABLED_SYSTEM:enabled",
            "FLIGHTDECK_ENABLED_USER:",
            "FLIGHTDECK_SLEEP_MASKED:masked",
            "FLIGHTDECK_CLAUDE_INSTALLED:yes",
            r#"FLIGHTDECK_CLAUDE_AUTH_JSON:{"loggedIn":true,"email":"a@b.com"}"#,
            "FLIGHTDECK_TAILSCALE:",
            "FLIGHTDECK_LAST_BOOT:2026-01-01 00:00:00",
        ]
        .join("\n")
    }

    #[test]
    fn parse_diagnosis_reads_a_healthy_system_install() {
        let d = parse_diagnosis_fields(&healthy_stdout());
        assert_eq!(d.installed_as, InstalledAs::System);
        assert_eq!(d.daemon_running, Some(true));
        assert_eq!(d.daemon_version_disk.as_deref(), Some("flightdeckd 0.2.0"));
        assert_eq!(d.daemon_version_running.as_deref(), Some("0.2.0"));
        assert!(!d.restart_pending);
        assert_eq!(d.reboot_safe, Some(true));
        assert_eq!(d.linger, Some(false), "healthy_stdout's FLIGHTDECK_LINGER:no must read as Some(false)");
        assert_eq!(d.sleep_masked, Some(true));
        assert_eq!(d.claude_installed, Some(true));
        assert_eq!(d.claude_logged_in, Some(true));
        assert_eq!(d.claude_email.as_deref(), Some("a@b.com"));
        assert_eq!(d.busy_conversations, Some(0));
    }

    #[test]
    fn parse_diagnosis_missing_unit_markers_leave_installed_as_unknown_others_intact() {
        let stdout = healthy_stdout().replace("FLIGHTDECK_UNIT_SYSTEM:yes\n", "");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.installed_as, InstalledAs::Unknown, "a missing unit marker must degrade to unknown");
        // Everything else, read off UNRELATED markers, must stay intact.
        assert_eq!(d.claude_logged_in, Some(true));
        assert_eq!(d.claude_email.as_deref(), Some("a@b.com"));
        assert_eq!(d.sleep_masked, Some(true));
    }

    #[test]
    fn parse_diagnosis_garbled_status_json_is_daemon_running_unknown_others_intact() {
        let stdout = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_STATUS_JSON:not-json-at-all",
        );
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.daemon_running, None, "garbled status JSON must be unknown, never assumed not-running");
        assert_eq!(d.daemon_version_running, None);
        assert_eq!(d.busy_conversations, None);
        // Unrelated facts untouched.
        assert_eq!(d.installed_as, InstalledAs::System);
        assert_eq!(d.claude_logged_in, Some(true));
    }

    #[test]
    fn parse_diagnosis_empty_status_json_is_daemon_not_running() {
        let stdout = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_STATUS_JSON:\nFLIGHTDECK_DAEMON_PROCESS:no",
        );
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.daemon_running, Some(false));
        assert_eq!(d.daemon_process_seen, Some(false));
    }

    /// Regression: an empty status only says THIS login reached no daemon. A
    /// `flightdeckd run` process of this user (one whose socket or binary is gone), or a
    /// unit systemd reports active (a system unit run as another user), is running —
    /// never "not running", the state "Restart the daemon" is offered on.
    #[test]
    fn parse_diagnosis_empty_status_with_a_daemon_seen_running_is_unknown_and_says_why() {
        let no_status = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_STATUS_JSON:",
        );
        for (case, markers) in [
            ("a flightdeckd run process", "FLIGHTDECK_DAEMON_PROCESS:yes"),
            ("the system unit active, its process hidden", "FLIGHTDECK_DAEMON_PROCESS:no\nFLIGHTDECK_ACTIVE_SYSTEM:active"),
            ("the user unit active", "FLIGHTDECK_DAEMON_PROCESS:no\nFLIGHTDECK_ACTIVE_USER:active"),
        ] {
            let d = parse_diagnosis(&format!("{no_status}\n{markers}"), true);
            assert_eq!(d.daemon_process_seen, Some(true), "{case}");
            assert_eq!(d.daemon_running, None, "{case}");
            assert_eq!(d.installed_as, InstalledAs::System, "{case}");
            assert_eq!(d.state, DiagnosisState::Failed { reason: DAEMON_STATUS_UNREADABLE.to_string() }, "{case}");
        }
    }

    /// A server that can't list its processes can't confirm a stop: unknown, never
    /// "not running" — but a box with no binary and no answer is still "not installed".
    #[test]
    fn parse_diagnosis_empty_status_without_a_process_listing_is_unknown() {
        let no_status = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_STATUS_JSON:\nFLIGHTDECK_DAEMON_PROCESS:\nFLIGHTDECK_ACTIVE_SYSTEM:inactive",
        );
        let d = parse_diagnosis(&no_status, true);
        assert_eq!(d.daemon_process_seen, None);
        assert_eq!(d.daemon_running, None);
        assert_eq!(
            d.state,
            DiagnosisState::Failed { reason: "could not determine whether flightdeckd is running".into() }
        );

        let nothing_installed = no_status
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_BIN_PRESENT:yes", "FLIGHTDECK_BIN_PRESENT:no");
        assert_eq!(parse_diagnosis_fields(&nothing_installed).installed_as, InstalledAs::None);
    }

    /// The process check couldn't run (no pgrep — a minimal image without procps): the
    /// headline and a restart refusal say so, with pgrep's own words and the way out,
    /// instead of an unexplained "could not determine".
    #[test]
    fn parse_diagnosis_says_why_the_process_check_could_not_run() {
        let no_pgrep = healthy_stdout().replace(
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
            "FLIGHTDECK_STATUS_JSON:\nFLIGHTDECK_DAEMON_PROCESS:\n\
             FLIGHTDECK_DAEMON_PROCESS_ERROR:bash: line 9: pgrep: command not found\nFLIGHTDECK_ACTIVE_SYSTEM:inactive",
        );
        let d = parse_diagnosis(&no_pgrep, true);
        assert_eq!(d.daemon_process_seen, None);
        assert_eq!(d.daemon_running, None);
        assert_eq!(d.daemon_process_check_error.as_deref(), Some("bash: line 9: pgrep: command not found"));
        let DiagnosisState::Failed { reason } = &d.state else { panic!("{:?}", d.state) };
        assert!(reason.starts_with("could not determine whether flightdeckd is running"), "{reason}");
        assert!(reason.contains("can't list its processes") && reason.contains("pgrep: command not found"), "{reason}");
        assert!(reason.contains("install procps"), "the way out on Linux: {reason}");
        let refusal = restart_error(d).to_string();
        assert!(refusal.starts_with("won't restart flightdeckd") && refusal.contains("pgrep: command not found"), "{refusal}");

        // A unit systemd reports active answered for it: nothing unknown to explain.
        let active = no_pgrep.replace("FLIGHTDECK_ACTIVE_SYSTEM:inactive", "FLIGHTDECK_ACTIVE_SYSTEM:active");
        assert_eq!(parse_diagnosis(&active, true).daemon_process_check_error, None);
        // A Mac always has pgrep: no procps advice there.
        let mac = ServerDiagnosis {
            host_os: Some(MACOS_UNAME.into()),
            installed_as: InstalledAs::LaunchAgent,
            daemon_running: None,
            daemon_process_seen: None,
            daemon_process_check_error: Some("pgrep exited with status 3".into()),
            ..base_diagnosis()
        };
        let DiagnosisState::Failed { reason } = collapse_state(&mac) else { panic!() };
        assert!(reason.contains("(pgrep exited with status 3)") && !reason.contains("procps"), "{reason}");
    }

    #[test]
    fn daemon_process_seen_reads_the_listing_and_both_unit_markers() {
        assert_eq!(daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:yes"), Some(true));
        assert_eq!(daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:no"), Some(false));
        assert_eq!(daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:"), None);
        assert_eq!(daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:\nFLIGHTDECK_ACTIVE_SYSTEM:active"), Some(true));
        assert_eq!(daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:no\nFLIGHTDECK_ACTIVE_USER:reloading"), Some(true));
        assert_eq!(
            daemon_process_seen("FLIGHTDECK_DAEMON_PROCESS:no\nFLIGHTDECK_ACTIVE_SYSTEM:inactive\nFLIGHTDECK_ACTIVE_USER:failed"),
            Some(false),
            "an inactive or failed unit runs nothing"
        );
    }

    #[test]
    fn parse_diagnosis_missing_claude_auth_marker_is_claude_logged_in_unknown_others_intact() {
        let stdout =
            healthy_stdout().replace(r#"FLIGHTDECK_CLAUDE_AUTH_JSON:{"loggedIn":true,"email":"a@b.com"}"#, "");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.claude_logged_in, None);
        assert_eq!(d.claude_email, None);
        assert_eq!(d.installed_as, InstalledAs::System);
        assert_eq!(d.daemon_running, Some(true));
    }

    #[test]
    fn parse_diagnosis_missing_linger_marker_is_reboot_safe_unaffected_for_a_system_unit() {
        // A system unit's reboot-safety depends on `enabled_system` alone — linger is a
        // user-level concept and must not blank it.
        let stdout = healthy_stdout().replace("FLIGHTDECK_LINGER:no\n", "");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.reboot_safe, Some(true));
    }

    #[test]
    fn parse_diagnosis_disk_version_differs_from_running_sets_restart_pending() {
        let stdout = healthy_stdout().replace("FLIGHTDECK_VERSION_DISK:flightdeckd 0.2.0", "FLIGHTDECK_VERSION_DISK:flightdeckd 0.3.0");
        let d = parse_diagnosis_fields(&stdout);
        assert!(d.restart_pending, "disk 0.3.0 != running 0.2.0 must flag restart_pending");
    }

    #[test]
    fn parse_diagnosis_matching_versions_never_set_restart_pending() {
        let d = parse_diagnosis_fields(&healthy_stdout());
        assert!(!d.restart_pending);
    }

    #[test]
    fn parse_diagnosis_user_unit_reboot_safe_requires_both_enabled_and_linger() {
        let base = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_UNIT_USER:no", "FLIGHTDECK_UNIT_USER:yes")
            .replace("FLIGHTDECK_ENABLED_SYSTEM:enabled", "FLIGHTDECK_ENABLED_SYSTEM:")
            .replace("FLIGHTDECK_ENABLED_USER:", "FLIGHTDECK_ENABLED_USER:enabled")
            .replace("FLIGHTDECK_LINGER:no", "FLIGHTDECK_LINGER:yes");
        let d = parse_diagnosis_fields(&base);
        assert_eq!(d.installed_as, InstalledAs::User);
        assert_eq!(d.reboot_safe, Some(true));

        let linger_refused = base.replace("FLIGHTDECK_LINGER:yes", "FLIGHTDECK_LINGER:no");
        assert_eq!(parse_diagnosis_fields(&linger_refused).reboot_safe, Some(false));
    }

    /// (B14) A user unit that exists but was rendered before the PATH fix must be
    /// flagged — this is what makes `InstallService`'s repair suggestion actually
    /// appear for it (see `serverBootstrapModel.ts::repairSuggestionsFor`).
    #[test]
    fn parse_diagnosis_flags_a_user_unit_missing_its_path_line() {
        let with_path = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_UNIT_USER:no", "FLIGHTDECK_UNIT_USER:yes\nFLIGHTDECK_UNIT_USER_HAS_PATH:yes");
        assert_eq!(parse_diagnosis_fields(&with_path).user_unit_missing_path, Some(false));

        let missing_path = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_UNIT_USER:no", "FLIGHTDECK_UNIT_USER:yes\nFLIGHTDECK_UNIT_USER_HAS_PATH:no");
        assert_eq!(parse_diagnosis_fields(&missing_path).user_unit_missing_path, Some(true));
    }

    /// No user unit at all (or its own PATH marker missing/garbled) must never
    /// manufacture a `Some(false)` — this fact is meaningless outside a User install.
    #[test]
    fn parse_diagnosis_user_unit_missing_path_is_unknown_without_a_confirmed_user_unit() {
        // `healthy_stdout()` is a SYSTEM install (`FLIGHTDECK_UNIT_USER:no`) and carries
        // no `FLIGHTDECK_UNIT_USER_HAS_PATH` marker at all.
        assert_eq!(parse_diagnosis_fields(&healthy_stdout()).user_unit_missing_path, None);

        let unit_confirmed_but_path_unknown = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_UNIT_USER:no", "FLIGHTDECK_UNIT_USER:yes\nFLIGHTDECK_UNIT_USER_HAS_PATH:");
        assert_eq!(
            parse_diagnosis_fields(&unit_confirmed_but_path_unknown).user_unit_missing_path,
            None,
            "a garbled/empty PATH marker must degrade to unknown, never a guessed Some(false)"
        );
    }

    #[test]
    fn parse_diagnosis_detached_is_never_reboot_safe() {
        let stdout = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_ENABLED_SYSTEM:enabled", "FLIGHTDECK_ENABLED_SYSTEM:");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.installed_as, InstalledAs::Detached, "bin present + running, no unit -> detached");
        assert_eq!(d.reboot_safe, Some(false));
    }

    #[test]
    fn parse_diagnosis_nothing_installed_is_none() {
        let stdout = healthy_stdout()
            .replace("FLIGHTDECK_UNIT_SYSTEM:yes", "FLIGHTDECK_UNIT_SYSTEM:no")
            .replace("FLIGHTDECK_BIN_PRESENT:yes", "FLIGHTDECK_BIN_PRESENT:no")
            .replace(
                r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"n","conversations":[]}"#,
                "FLIGHTDECK_STATUS_JSON:",
            )
            .replace("FLIGHTDECK_ENABLED_SYSTEM:enabled", "FLIGHTDECK_ENABLED_SYSTEM:");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.installed_as, InstalledAs::None);
    }

    // ---- headline-state table (collapse_state) ----

    fn base_diagnosis() -> ServerDiagnosis {
        ServerDiagnosis {
            state: DiagnosisState::Ready,
            reachable: true,
            link_issue: None,
            tailscale_off_locally: None,
            host_os: Some("Linux".into()),
            host_arch: Some("x86_64".into()),
            installed_as: InstalledAs::System,
            daemon_running: Some(true),
            daemon_process_seen: Some(true),
            daemon_process_check_error: None,
            daemon_version_disk: Some("0.2.0".into()),
            daemon_version_running: Some("0.2.0".into()),
            restart_pending: false,
            reboot_safe: Some(true),
            auto_login: None,
            agent_starts_at_login: None,
            launch_agent_plists: Vec::new(),
            invalid_launch_agent_plists: Vec::new(),
            mac_daemon_update: None,
            linger: Some(false),
            sleep_masked: Some(true),
            user_unit_missing_path: None,
            claude_installed: Some(true),
            claude_logged_in: Some(true),
            claude_email: Some("a@b.com".into()),
            claude_login_check_error: None,
            tailscale_name: None,
            last_boot: Some("2026-01-01 00:00:00".into()),
            busy_conversations: Some(0),
            bundled_daemon_version: None,
            daemon_outdated: false,
            bundled_daemon_for_host: None,
        }
    }

    #[test]
    fn headline_state_table() {
        let cases: Vec<(&str, ServerDiagnosis, DiagnosisState)> = vec![
            ("everything healthy", base_diagnosis(), DiagnosisState::Ready),
            (
                "not installed",
                ServerDiagnosis { installed_as: InstalledAs::None, ..base_diagnosis() },
                DiagnosisState::Failed { reason: "flightdeckd is not installed".into() },
            ),
            (
                "install state unknown",
                ServerDiagnosis { installed_as: InstalledAs::Unknown, ..base_diagnosis() },
                DiagnosisState::Failed { reason: "could not determine whether flightdeckd is installed".into() },
            ),
            (
                "not running",
                ServerDiagnosis { daemon_running: Some(false), ..base_diagnosis() },
                DiagnosisState::Failed { reason: "flightdeckd is not running".into() },
            ),
            (
                "running unknown",
                ServerDiagnosis { daemon_running: None, daemon_process_seen: None, ..base_diagnosis() },
                DiagnosisState::Failed { reason: "could not determine whether flightdeckd is running".into() },
            ),
            (
                "seen running, but its status can't be read from this login",
                ServerDiagnosis { daemon_running: None, daemon_process_seen: Some(true), ..base_diagnosis() },
                DiagnosisState::Failed { reason: DAEMON_STATUS_UNREADABLE.into() },
            ),
            (
                "claude not installed at all (the live fixtures' own case) — never Failed",
                ServerDiagnosis { claude_installed: Some(false), ..base_diagnosis() },
                DiagnosisState::NeedsClaudeInstall,
            ),
            (
                "claude install unknown — treated the same as not installed",
                ServerDiagnosis { claude_installed: None, ..base_diagnosis() },
                DiagnosisState::NeedsClaudeInstall,
            ),
            (
                "claude not logged in — never Failed",
                ServerDiagnosis { claude_logged_in: Some(false), ..base_diagnosis() },
                DiagnosisState::NeedsClaudeSignIn,
            ),
            (
                "claude sign-in unknown — treated the same as not logged in",
                ServerDiagnosis { claude_logged_in: None, ..base_diagnosis() },
                DiagnosisState::NeedsClaudeSignIn,
            ),
            (
                "signed in but reboot-unsafe",
                ServerDiagnosis { reboot_safe: Some(false), ..base_diagnosis() },
                DiagnosisState::RunningNotRebootSafe,
            ),
            (
                "signed in but reboot-safety unknown",
                ServerDiagnosis { reboot_safe: None, ..base_diagnosis() },
                DiagnosisState::RunningNotRebootSafe,
            ),
        ];
        for (label, input, expected) in cases {
            assert_eq!(collapse_state(&input), expected, "case: {label}");
        }
    }

    // ---- macOS servers (hand-made LaunchAgent, "Connect an existing server") ----

    /// A healthy Mac set up the way "Target" is: LaunchAgent with RunAtLoad, automatic
    /// login, sleep disabled, Claude's credential in the Keychain.
    fn healthy_mac_stdout() -> String {
        [
            "FLIGHTDECK_OS:Darwin",
            "FLIGHTDECK_ARCH:arm64",
            "FLIGHTDECK_BIN_PRESENT:yes",
            "FLIGHTDECK_VERSION_DISK:flightdeckd 0.2.0",
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","label":"Target","conversations":[]}"#,
            "FLIGHTDECK_CLAUDE_INSTALLED:yes",
            "FLIGHTDECK_MAC_AGENT_PLIST:/Users/admin/Library/LaunchAgents/com.example.flightdeckd.plist",
            "FLIGHTDECK_MAC_AGENT:yes",
            "FLIGHTDECK_MAC_AGENT_AT_LOGIN:yes",
            "FLIGHTDECK_MAC_AUTOLOGIN:yes",
            "FLIGHTDECK_MAC_SLEEP_OFF:yes",
            "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:yes",
            "FLIGHTDECK_TAILSCALE:admins-macbook-pro",
            "FLIGHTDECK_LAST_BOOT:2026-10-07 18:19:15",
        ]
        .join("\n")
    }

    #[test]
    fn parse_diagnosis_reads_a_healthy_mac_launch_agent_as_ready() {
        let d = parse_diagnosis(&healthy_mac_stdout(), true);
        assert_eq!(d.host_os.as_deref(), Some("Darwin"));
        assert_eq!(d.host_arch.as_deref(), Some("arm64"), "the arch picks the bundled build an update sends");
        assert_eq!(d.bundled_daemon_for_host, None, "a fact about this Mac's bundle, folded in later");
        assert_eq!(d.installed_as, InstalledAs::LaunchAgent);
        assert_eq!(d.daemon_running, Some(true));
        assert_eq!(d.reboot_safe, Some(true));
        assert_eq!(d.auto_login, Some(true));
        assert_eq!(d.agent_starts_at_login, Some(true));
        assert_eq!(d.sleep_masked, Some(true));
        assert_eq!(d.claude_logged_in, Some(true));
        assert_eq!(d.claude_email, None, "the Keychain check never reads who is signed in");
        assert_eq!(d.tailscale_name.as_deref(), Some("admins-macbook-pro"));
        assert_eq!(d.state, DiagnosisState::Ready);
    }

    /// No systemd fact exists on a Mac: each stays unknown, never a manufactured
    /// "no" that would make the front offer linger or a PATH fix.
    #[test]
    fn parse_diagnosis_never_invents_systemd_facts_for_a_mac() {
        let d = parse_diagnosis_fields(&healthy_mac_stdout());
        assert_eq!(d.linger, None);
        assert_eq!(d.user_unit_missing_path, None);
    }

    /// Target's actual state on 08/10: everything fine, but nobody is set to log in
    /// automatically — after a reboot the LaunchAgent would not run until someone
    /// logs in at the Mac.
    #[test]
    fn parse_diagnosis_mac_without_auto_login_is_not_reboot_safe() {
        let stdout = healthy_mac_stdout().replace("FLIGHTDECK_MAC_AUTOLOGIN:yes", "FLIGHTDECK_MAC_AUTOLOGIN:no");
        let d = parse_diagnosis(&stdout, true);
        assert_eq!(d.auto_login, Some(false));
        assert_eq!(d.reboot_safe, Some(false));
        assert_eq!(d.state, DiagnosisState::RunningNotRebootSafe);
    }

    #[test]
    fn parse_diagnosis_mac_agent_that_never_starts_at_login_is_not_reboot_safe() {
        let stdout =
            healthy_mac_stdout().replace("FLIGHTDECK_MAC_AGENT_AT_LOGIN:yes", "FLIGHTDECK_MAC_AGENT_AT_LOGIN:no");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.agent_starts_at_login, Some(false));
        assert_eq!(d.reboot_safe, Some(false));
    }

    #[test]
    fn parse_diagnosis_mac_unreadable_auto_login_leaves_reboot_safety_unknown() {
        let stdout = healthy_mac_stdout().replace("FLIGHTDECK_MAC_AUTOLOGIN:yes", "FLIGHTDECK_MAC_AUTOLOGIN:");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.auto_login, None);
        assert_eq!(d.reboot_safe, None);
    }

    #[test]
    fn parse_diagnosis_mac_without_a_launch_agent_is_detached_and_not_reboot_safe() {
        let stdout = healthy_mac_stdout()
            .replace("FLIGHTDECK_MAC_AGENT:yes", "FLIGHTDECK_MAC_AGENT:no")
            .replace("FLIGHTDECK_MAC_AGENT_AT_LOGIN:yes", "FLIGHTDECK_MAC_AGENT_AT_LOGIN:");
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.installed_as, InstalledAs::Detached);
        assert_eq!(d.reboot_safe, Some(false));
        assert_eq!(d.agent_starts_at_login, None);
    }

    #[test]
    fn parse_diagnosis_mac_without_claudes_credential_needs_sign_in() {
        let stdout = healthy_mac_stdout()
            .replace("FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:yes", "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:no");
        let d = parse_diagnosis(&stdout, true);
        assert_eq!(d.claude_logged_in, Some(false));
        assert_eq!(d.state, DiagnosisState::NeedsClaudeSignIn);
    }

    /// A Linux transcript must keep reading exactly as before the macOS branch existed
    /// — including one from a script too old to print `FLIGHTDECK_OS` at all.
    #[test]
    fn parse_diagnosis_without_an_os_marker_reads_the_linux_facts() {
        let d = parse_diagnosis_fields(&healthy_stdout());
        assert_eq!(d.host_os, None);
        assert_eq!(d.installed_as, InstalledAs::System);
        assert_eq!(d.auto_login, None);
        assert_eq!(d.agent_starts_at_login, None);
    }

    /// The Linux branch reads neither macOS-only fact: no agent plist list, no Keychain
    /// check to fail.
    #[test]
    fn parse_diagnosis_linux_never_reports_mac_only_facts() {
        let d = parse_diagnosis_fields(&healthy_stdout());
        assert!(d.launch_agent_plists.is_empty());
        assert_eq!(d.claude_login_check_error, None);
    }

    // ---- macOS: a Keychain lookup that FAILED is surfaced, never just "unknown" ----

    #[test]
    fn mac_login_check_error_only_when_the_check_could_not_answer() {
        assert_eq!(
            mac_login_check_error(None, Some("36")).as_deref(),
            Some("the Keychain lookup failed (security exit 36)")
        );
        assert_eq!(mac_login_check_error(Some(true), Some("36")), None, "the check answered");
        assert_eq!(mac_login_check_error(Some(false), None), None);
        assert_eq!(mac_login_check_error(None, None), None, "no code reported, nothing to name");
        assert_eq!(mac_login_check_error(None, Some("")), None);
    }

    #[test]
    fn parse_diagnosis_mac_keychain_failure_carries_its_exit_code() {
        let stdout = healthy_mac_stdout().replace(
            "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:yes",
            "FLIGHTDECK_MAC_CLAUDE_CREDENTIAL:\nFLIGHTDECK_MAC_KEYCHAIN_EXIT:36",
        );
        let d = parse_diagnosis(&stdout, true);
        assert_eq!(d.claude_logged_in, None);
        assert_eq!(d.claude_login_check_error.as_deref(), Some("the Keychain lookup failed (security exit 36)"));
        assert_eq!(parse_diagnosis(&healthy_mac_stdout(), true).claude_login_check_error, None);
    }

    // ---- macOS: several LaunchAgents run flightdeckd ----

    #[test]
    fn parse_diagnosis_mac_with_two_agents_is_ambiguous_not_reboot_safe_or_unsafe() {
        let stdout = healthy_mac_stdout().replace(
            "FLIGHTDECK_MAC_AGENT:yes",
            "FLIGHTDECK_MAC_AGENT_PLIST:/Users/admin/Library/LaunchAgents/old.flightdeckd.plist\nFLIGHTDECK_MAC_AGENT:yes",
        );
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.installed_as, InstalledAs::LaunchAgent);
        assert_eq!(
            d.launch_agent_plists,
            vec![
                "/Users/admin/Library/LaunchAgents/com.example.flightdeckd.plist".to_string(),
                "/Users/admin/Library/LaunchAgents/old.flightdeckd.plist".to_string(),
            ]
        );
        assert_eq!(d.agent_starts_at_login, None, "which agent starts at login is not ours to guess");
        assert_eq!(d.reboot_safe, None);
    }

    #[test]
    fn parse_diagnosis_mac_with_one_agent_lists_it() {
        let d = parse_diagnosis_fields(&healthy_mac_stdout());
        assert_eq!(d.launch_agent_plists, vec!["/Users/admin/Library/LaunchAgents/com.example.flightdeckd.plist".to_string()]);
        assert_eq!(d.agent_starts_at_login, Some(true));
    }

    // ---- the REAL macOS scripts, run on this Mac against a fake home ----

    /// A fake `$HOME` to run the REAL diagnose/restart scripts in on this Mac: `bin/`
    /// holds stand-ins for the remote's own commands (ahead of the real ones on PATH),
    /// `Library/LaunchAgents` the plists under test. Removed on drop.
    #[cfg(target_os = "macos")]
    struct FakeMacHome(std::path::PathBuf);

    #[cfg(target_os = "macos")]
    impl FakeMacHome {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fd-mac-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            std::fs::create_dir_all(dir.join("Library/LaunchAgents")).unwrap();
            Self(dir)
        }

        /// An executable stand-in for the remote command `name`.
        fn command(&self, name: &str, body: &str) {
            use std::os::unix::fs::PermissionsExt;
            let p = self.0.join("bin").join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        /// Writes `~/Library/LaunchAgents/<file_name>`, returning its path as the
        /// script's `find` prints it.
        fn launch_agent(&self, file_name: &str, plist: &str) -> String {
            let p = self.0.join("Library/LaunchAgents").join(file_name);
            std::fs::write(&p, plist).unwrap();
            p.to_string_lossy().into_owned()
        }

        fn write(&self, rel: &str, contents: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
        }

        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.0.join(rel)).ok()
        }

        fn run(&self, shell: &str, script: &str, env: &[(&str, &str)]) -> std::process::Output {
            let mut cmd = std::process::Command::new(shell);
            cmd.arg("-c")
                .arg(script)
                .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.0.join("bin").display()))
                .env("HOME", &self.0)
                .env_remove("ZDOTDIR")
                .stdin(std::process::Stdio::null());
            for (k, v) in env {
                cmd.env(k, v);
            }
            cmd.output().expect("run the script")
        }

        /// The stand-ins every diagnose run needs: a working `claude`, a running
        /// `flightdeckd` whose status JSON holds a title with JSON escapes (`\n` and
        /// `\\` — zsh's `echo` would turn them into real characters and break the JSON),
        /// and a `security` whose Keychain lookup exits `security_exit`.
        fn diagnose_commands(&self, security_exit: i32) {
            self.command("claude", "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.1.293 (Claude Code)'\nexit 0\n");
            self.command(
                "flightdeckd",
                r##"#!/bin/sh
case "$1" in
--version) echo 'flightdeckd 0.2.0' ;;
status) printf '%s\n' '{"type":"fd_status","version":"0.2.0","label":"T","conversations":[{"conversation":"c","title":"a\nb\\c","busy":false}]}' ;;
esac
"##,
            );
            self.command("security", &format!("#!/bin/sh\nexit {security_exit}\n"));
            // Hermetic process checks — the real ones would see this Mac's own: no
            // `flightdeckd run` process of this user, and launchd runs no such job.
            self.command("pgrep", "#!/bin/sh\nexit 1\n");
            self.command("launchctl", "#!/bin/sh\n[ \"$1\" = print ] && exit 113\nexit 0\n");
        }

        fn diagnose(&self, shell: &str) -> ServerDiagnosis {
            let out = self.run(shell, &diagnose_script(), &[]);
            assert!(out.status.success(), "the diagnose script must exit 0 under {shell}: {out:?}");
            parse_diagnosis(&String::from_utf8_lossy(&out.stdout), true)
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for FakeMacHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A LaunchAgent plist running `program_arguments`, plus `extra_keys` (raw plist XML).
    #[cfg(target_os = "macos")]
    fn agent_plist(label: &str, program_arguments: &[&str], extra_keys: &str) -> String {
        let args: String = program_arguments.iter().map(|a| format!("<string>{a}</string>")).collect();
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array>{args}</array>
{extra_keys}
</dict></plist>
"#
        )
    }

    /// The macOS branch end to end, under BOTH `/bin/sh` and `/bin/zsh` — a Mac's login
    /// shell, the one a remote command actually runs in. The fake status JSON carries
    /// JSON escapes, so an `echo` regression on that line breaks the JSON under zsh and
    /// `daemon_running` falls to `None`.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reads_a_mac_launch_agent_end_to_end_under_sh_and_zsh() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            let home = FakeMacHome::new("e2e");
            home.diagnose_commands(0);
            let plist = home.launch_agent(
                "com.example.flightdeckd.plist",
                &agent_plist("com.example.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
            );
            let d = home.diagnose(shell);
            assert_eq!(d.host_os.as_deref(), Some("Darwin"), "{shell}");
            assert_eq!(d.host_arch.as_deref(), Some(std::env::consts::ARCH).map(|a| if a == "aarch64" { "arm64" } else { a }), "{shell}");
            assert_eq!(d.installed_as, InstalledAs::LaunchAgent, "{shell}");
            assert_eq!(d.launch_agent_plists, vec![plist], "{shell}");
            assert_eq!(d.agent_starts_at_login, Some(true), "{shell}");
            assert_eq!(d.daemon_running, Some(true), "the status JSON must survive {shell}");
            assert_eq!(d.busy_conversations, Some(0), "{shell}");
            assert_eq!(d.claude_installed, Some(true), "{shell}");
            assert_eq!(d.claude_logged_in, Some(true), "the fake Keychain lookup succeeds under {shell}");
            assert_eq!(d.claude_login_check_error, None, "{shell}");
            assert!(d.auto_login.is_some(), "this Mac's own loginwindow prefs are readable under {shell}");
            assert!(d.sleep_masked.is_some(), "pmset answers on a Mac under {shell}");
            assert!(d.last_boot.is_some(), "kern.boottime is readable under {shell}");
            assert_eq!(d.linger, None, "{shell}");
        }
    }

    /// `security find-generic-password` exit code → what the diagnosis says about
    /// Claude's login: found, not found, and a lookup that FAILED — reported with its
    /// code instead of silently becoming "unknown". A credentials file on disk counts
    /// as signed in whatever the Keychain says.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reads_the_mac_keychain_lookup_outcome() {
        let cases: [(i32, Option<&str>, Option<bool>, Option<&str>); 4] = [
            (0, None, Some(true), None),
            (44, None, Some(false), None),
            (36, None, None, Some("the Keychain lookup failed (security exit 36)")),
            (44, Some(r#"{"claudeAiOauth":{}}"#), Some(true), None),
        ];
        for (exit, credentials_file, logged_in, check_error) in cases {
            let home = FakeMacHome::new("keychain");
            home.diagnose_commands(exit);
            home.launch_agent(
                "com.example.flightdeckd.plist",
                &agent_plist("com.example.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
            );
            if let Some(contents) = credentials_file {
                home.write(".claude/.credentials.json", contents);
            }
            let d = home.diagnose("/bin/zsh");
            assert_eq!(d.claude_logged_in, logged_in, "security exit {exit}, credentials file {credentials_file:?}");
            assert_eq!(d.claude_login_check_error.as_deref(), check_error, "security exit {exit}");
        }
    }

    /// launchd.plist(5): `KeepAlive` true starts the job at load, a `KeepAlive`
    /// dictionary holding `SuccessfulExit` implies `RunAtLoad`, any other `KeepAlive`
    /// dictionary only starts it when its conditions hold (unknown at login), and with
    /// neither key set to start it, it never starts at login.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reads_keep_alive_the_way_launchd_does() {
        let cases: [(&str, &str, Option<bool>); 5] = [
            ("KeepAlive true only", "<key>KeepAlive</key><true/>", Some(true)),
            (
                "KeepAlive dictionary with SuccessfulExit",
                "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
                Some(true),
            ),
            (
                "KeepAlive dictionary of another condition only",
                "<key>KeepAlive</key><dict><key>NetworkState</key><true/></dict>",
                None,
            ),
            ("neither key", "", Some(false)),
            ("both keys false", "<key>RunAtLoad</key><false/><key>KeepAlive</key><false/>", Some(false)),
        ];
        for (case, keys, starts_at_login) in cases {
            let home = FakeMacHome::new("keepalive");
            home.diagnose_commands(0);
            home.launch_agent(
                "com.example.flightdeckd.plist",
                &agent_plist("com.example.flightdeckd", &["/opt/flightdeckd", "run"], keys),
            );
            let d = home.diagnose("/bin/zsh");
            assert_eq!(d.installed_as, InstalledAs::LaunchAgent, "{case}");
            assert_eq!(d.agent_starts_at_login, starts_at_login, "{case}");
        }
    }

    /// Only a plist that runs flightdeckd is an agent — one that merely uses its files
    /// (watches them, works in its directory) is not — and two real ones are reported
    /// as ambiguous, never one picked arbitrarily.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reports_several_flightdeckd_agents_as_ambiguous() {
        let home = FakeMacHome::new("ambiguous");
        home.diagnose_commands(0);
        let watcher = agent_plist(
            "com.example.backup",
            &["/usr/bin/true"],
            "<key>WatchPaths</key><array><string>/Users/admin/.flightdeckd</string></array>\
             <key>WorkingDirectory</key><string>/Users/admin/.flightdeckd</string><key>RunAtLoad</key><true/>",
        );
        home.launch_agent("com.example.backup.plist", &watcher);
        let first = home.launch_agent(
            "a.flightdeckd.plist",
            &agent_plist("a.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
        );

        let d = home.diagnose("/bin/zsh");
        assert_eq!(d.launch_agent_plists, vec![first.clone()], "a job that only uses flightdeckd's files doesn't run it");
        assert_eq!(d.agent_starts_at_login, Some(true));

        let second = home.launch_agent(
            "b.flightdeckd.plist",
            &agent_plist("b.flightdeckd", &["/bin/sh", "-c", "exec /opt/flightdeckd run"], ""),
        );
        let d = home.diagnose("/bin/zsh");
        assert_eq!(d.installed_as, InstalledAs::LaunchAgent);
        assert_eq!(d.launch_agent_plists, vec![first, second]);
        assert_eq!(d.agent_starts_at_login, None);
        assert_eq!(d.reboot_safe, None);
    }

    /// Regression: a hand-made agent that starts the daemon through a wrapper script —
    /// its `ProgramArguments` never say flightdeckd — used to read as "started by hand",
    /// with a false "Run flightdeckd as a LaunchAgent" step and Restart refused. It is
    /// found by its label, its own log file, or the wrapper it launches.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_finds_an_agent_that_starts_flightdeckd_through_a_wrapper() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            let cases: [(&str, &str, Vec<&str>, &str); 3] = [
                (
                    "named by its label (the reported case)",
                    "com.tosse.flightdeckd",
                    vec!["WRAPPER"],
                    "<key>RunAtLoad</key><true/>",
                ),
                (
                    "named by its own log file",
                    "com.admin.daemon",
                    vec!["/bin/sh", "-c", "start-daemon"],
                    "<key>StandardErrorPath</key><string>/Users/admin/Library/Logs/flightdeckd.err</string>\
                     <key>RunAtLoad</key><true/>",
                ),
                (
                    "named only by the wrapper it launches (no #! line, run through sh)",
                    "com.admin.daemon",
                    vec!["/bin/sh", "WRAPPER"],
                    "<key>WorkingDirectory</key><string>/Users/admin/.flightdeckd</string>\
                     <key>RunAtLoad</key><true/>",
                ),
            ];
            for (case, label, args, keys) in cases {
                let home = FakeMacHome::new("wrapper");
                home.diagnose_commands(0);
                let wrapper = home.0.join("bin/start-daemon.sh").to_string_lossy().into_owned();
                let body = if args.len() == 2 { "" } else { "#!/bin/sh\n" };
                home.write("bin/start-daemon.sh", &format!("{body}export PATH=\"$HOME/.local/bin:$PATH\"\nexec flightdeckd run\n"));
                let args: Vec<&str> = args.iter().map(|a| if *a == "WRAPPER" { wrapper.as_str() } else { a }).collect();
                let plist = home.launch_agent(&format!("{label}.plist"), &agent_plist(label, &args, keys));

                let d = home.diagnose(shell);
                assert_eq!(d.launch_agent_plists, vec![plist], "{case} under {shell}");
                assert_eq!(d.installed_as, InstalledAs::LaunchAgent, "{case} under {shell}");
                assert_eq!(d.agent_starts_at_login, Some(true), "{case} under {shell}");
            }
        }
    }

    // ---- updating a Mac's existing LaunchAgent install (ReuploadDaemon on Darwin) ----

    /// The markers [`MAC_UPDATE_FACTS_FN`] prints (plus the diagnosis's plist lists),
    /// field by field — [`Self::user_server`] is the user's own server's shape.
    struct MacUpdateFacts<'a> {
        plists: &'a [&'a str],
        invalid: &'a [&'a str],
        target: &'a str,
        canonical: &'a str,
        writable: &'a str,
        daemon_bin: &'a str,
        program: Option<&'a str>,
        daemon_exe: &'a str,
    }

    const USER_BIN: &str = "/Users/admin/.local/bin/flightdeckd";
    const USER_PLIST: &str = "/Users/admin/Library/LaunchAgents/com.tosse.flightdeckd.plist";

    impl MacUpdateFacts<'static> {
        /// `com.tosse.flightdeckd` runs `~/.local/bin/flightdeckd run` directly, loaded and
        /// running, the binary Flight Deck's commands find too, in a folder the login owns.
        fn user_server() -> Self {
            MacUpdateFacts {
                plists: &[USER_PLIST],
                invalid: &[],
                target: USER_BIN,
                canonical: USER_BIN,
                writable: "yes",
                daemon_bin: USER_BIN,
                program: Some(USER_BIN),
                daemon_exe: USER_BIN,
            }
        }
    }

    impl MacUpdateFacts<'_> {
        fn stdout(&self) -> String {
            let mut lines: Vec<String> = self.plists.iter().map(|p| format!("FLIGHTDECK_MAC_AGENT_PLIST:{p}")).collect();
            lines.extend(self.invalid.iter().map(|p| format!("FLIGHTDECK_MAC_AGENT_INVALID:{p}")));
            lines.push(format!("FLIGHTDECK_UPDATE_TARGET:{}", self.target));
            lines.push(format!("FLIGHTDECK_UPDATE_TARGET_CANONICAL:{}", self.canonical));
            lines.push(format!("FLIGHTDECK_UPDATE_TARGET_DIR_WRITABLE:{}", self.writable));
            lines.push(format!("FLIGHTDECK_DAEMON_BIN:{}", self.daemon_bin));
            if let Some(program) = self.program {
                lines.push(format!("FLIGHTDECK_MAC_AGENT_PROGRAM:{program}"));
                lines.push(format!("FLIGHTDECK_MAC_AGENT_DAEMON_EXE:{}", self.daemon_exe));
            }
            lines.join("\n")
        }

        fn verdict(&self) -> MacDaemonUpdate {
            judge_mac_update(&self.stdout())
        }

        fn refusal(&self) -> String {
            match self.verdict() {
                MacDaemonUpdate::Blocked { reason } => reason,
                ready => panic!("expected a refusal, got {ready:?}"),
            }
        }
    }

    /// The update goes ahead when the Mac's ONE flightdeckd LaunchAgent runs the very
    /// binary the upload replaces — the user's own server's shape — loaded or not (launchd
    /// runs that path again on the restart either way).
    #[test]
    fn a_mac_update_is_ready_when_its_one_launch_agent_runs_the_replaced_binary() {
        assert_eq!(MacUpdateFacts::user_server().verdict(), MacDaemonUpdate::Ready { target: USER_BIN.into() });
        let unloaded = MacUpdateFacts { daemon_exe: "", ..MacUpdateFacts::user_server() };
        assert_eq!(unloaded.verdict(), MacDaemonUpdate::Ready { target: USER_BIN.into() });
    }

    /// A fresh Mac install stays refused — the installer only ever sets up Linux, and a
    /// Mac's daemon has to be a LaunchAgent of the logged-in user, set up by hand — and so
    /// does every LaunchAgent an update can't be sure to reach, each saying why.
    #[test]
    fn a_mac_update_is_refused_unless_it_reaches_the_one_launch_agent() {
        let base = MacUpdateFacts::user_server;
        let other = "/Users/admin/Library/LaunchAgents/old.flightdeckd.plist";

        let fresh = MacUpdateFacts { plists: &[], program: None, ..base() }.refusal();
        assert!(fresh.contains("no LaunchAgent runs flightdeckd") && fresh.contains("by hand"), "{fresh}");

        let broken = MacUpdateFacts { plists: &[], invalid: &[USER_PLIST], program: None, ..base() }.refusal();
        assert!(broken.contains(USER_PLIST) && broken.contains("plutil -lint"), "{broken}");

        let several = MacUpdateFacts { plists: &[USER_PLIST, other], program: None, ..base() }.refusal();
        assert!(several.contains(USER_PLIST) && several.contains(other) && several.contains("keep only one"), "{several}");

        let unread = MacUpdateFacts { program: Some(""), ..base() }.refusal();
        assert!(unread.contains("could not read which program"), "{unread}");

        let nowhere = MacUpdateFacts { target: "", ..base() }.refusal();
        assert!(nowhere.contains("nothing safe to replace"), "{nowhere}");

        // The agent runs ANOTHER flightdeckd binary: the only case where copying a build
        // over what it runs is the right advice — it is a flightdeckd binary.
        let elsewhere = "/opt/flightdeckd/flightdeckd";
        let moved = MacUpdateFacts { program: Some(elsewhere), daemon_exe: elsewhere, ..base() }.refusal();
        assert!(moved.contains(&format!("runs {elsewhere}")) && moved.contains(&format!("would replace {USER_BIN}")), "{moved}");
        assert!(moved.contains(&format!("copy a newer macOS build over {elsewhere}")), "{moved}");
    }

    /// Regression (review): an agent that starts flightdeckd through a wrapper — `sh -c`,
    /// or a start script setting PATH first, the shape the diagnose script finds on its own
    /// — was always refused, telling the user to copy the daemon over `/bin/sh` or over the
    /// wrapper (which would leave an agent that starts nothing). It is now judged on the
    /// executable of the daemon its job runs: the replaced binary is Ready (`lsof` reports
    /// it with symlinks resolved — `/var` is `/private/var` on a Mac), another binary names
    /// THAT binary as the one to update, and with nothing to read it is refused without
    /// ever naming the wrapper as a file to overwrite.
    #[test]
    fn a_wrapper_agent_is_judged_on_the_daemon_it_runs_never_told_to_overwrite_the_wrapper() {
        let base = MacUpdateFacts::user_server;
        let wrapper = "/Users/admin/bin/start-flightdeckd.sh";
        for program in ["/bin/sh", wrapper, "flightdeckd"] {
            let ready = MacUpdateFacts { program: Some(program), ..base() };
            assert_eq!(ready.verdict(), MacDaemonUpdate::Ready { target: USER_BIN.into() }, "{program}");

            let other = "/opt/homebrew/bin/flightdeckd";
            let elsewhere = MacUpdateFacts { program: Some(program), daemon_exe: other, ..base() }.refusal();
            assert!(elsewhere.contains(&format!("through {program}, which runs {other}")), "{elsewhere}");
            assert!(elsewhere.contains(&format!("Copy a newer macOS build over {other}")), "{elsewhere}");

            let unknown = MacUpdateFacts { program: Some(program), daemon_exe: "", ..base() }.refusal();
            assert!(unknown.contains("can't tell which flightdeckd binary"), "{unknown}");
            assert!(unknown.contains(&format!("ProgramArguments to {USER_BIN} run")), "{unknown}");
            for refusal in [&elsewhere, &unknown] {
                assert!(!refusal.contains(&format!("over {program}")), "never overwrite the wrapper: {refusal}");
            }
        }
        let canonical = "/private/var/folders/x/home/.local/bin/flightdeckd";
        let linked = MacUpdateFacts {
            program: Some(wrapper),
            target: "/var/folders/x/home/.local/bin/flightdeckd",
            canonical,
            daemon_bin: "/var/folders/x/home/.local/bin/flightdeckd",
            daemon_exe: canonical,
            ..base()
        };
        assert_eq!(linked.verdict(), MacDaemonUpdate::Ready { target: "/var/folders/x/home/.local/bin/flightdeckd".into() });
    }

    /// Regression (review): Flight Deck's own commands (attach, status, the version probe)
    /// search PATH, then `~/.local/bin`, then `/usr/local/bin`; the upload's target checks
    /// `/usr/local/bin` first. A stale `~/.local/bin` copy next to an agent running
    /// `/usr/local/bin/flightdeckd` passed, and after the update the panel kept reading
    /// the stale copy's version — no restart ever offered, "Update" offered forever.
    #[test]
    fn a_mac_update_is_refused_while_flight_decks_own_commands_run_another_copy() {
        let usr = "/usr/local/bin/flightdeckd";
        let shadowed = MacUpdateFacts {
            target: usr,
            canonical: usr,
            program: Some(usr),
            daemon_exe: usr,
            daemon_bin: USER_BIN,
            ..MacUpdateFacts::user_server()
        };
        let why = shadowed.refusal();
        assert!(why.contains(&format!("run {USER_BIN}")) && why.contains(&format!("LaunchAgent runs {usr}")), "{why}");
        assert!(why.contains(&format!("Remove {USER_BIN}")), "{why}");

        let missing = MacUpdateFacts { daemon_bin: "flightdeckd", ..MacUpdateFacts::user_server() }.refusal();
        assert!(missing.contains("can't find flightdeckd"), "{missing}");
    }

    /// Regression (review): a target in a directory this login can't write (a root-owned
    /// `/usr/local/bin` on Apple silicon) passed, then failed mid-upload as "truncated …
    /// received 0". Refused up front, saying where and what to do.
    #[test]
    fn a_mac_update_is_refused_where_this_login_cannot_write() {
        let usr = "/usr/local/bin/flightdeckd";
        let root_owned = MacUpdateFacts {
            target: usr,
            canonical: usr,
            program: Some(usr),
            daemon_exe: usr,
            daemon_bin: usr,
            writable: "no",
            ..MacUpdateFacts::user_server()
        };
        let why = root_owned.refusal();
        assert!(why.contains("can't write /usr/local/bin") && why.contains("sudo"), "{why}");
        // Unknown (the folder couldn't be checked) is no reason to refuse: the upload says.
        let unknown = MacUpdateFacts { writable: "", ..MacUpdateFacts::user_server() };
        assert_eq!(unknown.verdict(), MacDaemonUpdate::Ready { target: USER_BIN.into() });
    }

    /// The verdict rides every Mac diagnosis — and only a Mac's.
    #[test]
    fn the_mac_update_verdict_rides_the_mac_diagnosis_only() {
        // `healthy_mac_stdout` already lists the one agent's plist.
        let facts = MacUpdateFacts { plists: &[], ..MacUpdateFacts::user_server() };
        let mac = format!("{}\n{}", healthy_mac_stdout(), facts.stdout());
        let d = parse_diagnosis(&mac, true);
        assert_eq!(d.mac_daemon_update, Some(MacDaemonUpdate::Ready { target: USER_BIN.into() }));
        assert_eq!(parse_diagnosis(&healthy_stdout(), true).mac_daemon_update, None, "Linux");
        assert_eq!(parse_diagnosis("", false).mac_daemon_update, None, "unreachable");
    }

    /// Stand-ins for what the facts read off a running job — `launchctl print` (its
    /// `program` and `pid`), `ps -o args=` for that pid, `pgrep -P` (a child daemon) and
    /// `lsof` (answering ONLY for `daemon_pid`, so the right process is proven asked).
    #[cfg(target_os = "macos")]
    fn running_job(home: &FakeMacHome, program: &str, job_args: &str, daemon_pid: &str, exe: &str) {
        home.command(
            "launchctl",
            &format!("#!/bin/sh\n[ \"$1\" = print ] || exit 0\nprintf '\\tstate = running\\n\\tprogram = %s\\n\\tpid = 4242\\n' '{program}'\n"),
        );
        home.command("ps", &format!("#!/bin/sh\necho '{job_args}'\n"));
        home.command(
            "pgrep",
            "#!/bin/sh\n[ \"$1\" = -P ] && [ \"$2\" = 4242 ] && { echo 4343; exit 0; }\nexit 1\n",
        );
        home.command(
            "lsof",
            &format!("#!/bin/sh\n[ \"$4\" = '{daemon_pid}' ] || exit 1\nprintf 'p%s\\nftxt\\nn%s\\nftxt\\nn/usr/lib/dyld\\n' '{daemon_pid}' '{exe}'\n"),
        );
    }

    /// The REAL diagnose script on this Mac, against a fake home, under `/bin/sh` and
    /// `/bin/zsh` (a Mac's login shell): the verdict the panel offers "Update the daemon"
    /// on. The fake `flightdeckd` sits on the fake PATH, so it is both the upload's target
    /// and what Flight Deck's own commands run.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_judges_a_mac_update_end_to_end_under_sh_and_zsh() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            // (case, ProgramArguments, how the job runs, Ready?)
            #[derive(Clone, Copy)]
            enum Job {
                NotLoaded,
                /// The job's own pid runs `flightdeckd run` (direct, or a wrapper that `exec`s).
                Runs,
                /// A wrapper that doesn't `exec`: the daemon is its child.
                Parent,
                /// The job runs a flightdeckd from somewhere else.
                RunsOther,
            }
            let cases: [(&str, Vec<&str>, Job, bool); 7] = [
                ("a loaded agent running the binary", vec!["BIN", "run"], Job::Runs, true),
                ("an agent launchd hasn't loaded", vec!["BIN", "run"], Job::NotLoaded, true),
                ("a wrapper that execs the binary", vec!["/bin/sh", "-c", "exec BIN run"], Job::Runs, true),
                ("a wrapper whose child is the binary", vec!["/bin/sh", "-c", "BIN run"], Job::Parent, true),
                ("a wrapper running another binary", vec!["/bin/sh", "-c", "exec /opt/x/flightdeckd run"], Job::RunsOther, false),
                ("a wrapper launchd hasn't loaded", vec!["/bin/sh", "-c", "exec BIN run"], Job::NotLoaded, false),
                ("no agent at all", vec![], Job::NotLoaded, false),
            ];
            for (case, args, job, ready) in cases {
                let home = FakeMacHome::new("update");
                home.diagnose_commands(0);
                let bin = home.0.join("bin/flightdeckd").to_string_lossy().into_owned();
                let canonical = format!(
                    "{}/flightdeckd",
                    std::fs::canonicalize(home.0.join("bin")).unwrap().to_string_lossy()
                );
                let args: Vec<String> = args.iter().map(|a| a.replace("BIN", &bin)).collect();
                let program = args.first().cloned().unwrap_or_default();
                match job {
                    Job::NotLoaded => {}
                    Job::Runs => running_job(&home, &program, &format!("{bin} run"), "4242", &canonical),
                    Job::Parent => running_job(&home, &program, "/bin/sh -c x", "4343", &canonical),
                    Job::RunsOther => {
                        running_job(&home, &program, "/opt/x/flightdeckd run", "4242", "/opt/x/flightdeckd")
                    }
                }
                if !args.is_empty() {
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    home.launch_agent(
                        "com.tosse.flightdeckd.plist",
                        &agent_plist("com.tosse.flightdeckd", &args, "<key>RunAtLoad</key><true/>"),
                    );
                }

                let verdict = home.diagnose(shell).mac_daemon_update.expect("a Mac diagnosis carries the verdict");
                match (ready, verdict) {
                    (true, MacDaemonUpdate::Ready { target }) => assert_eq!(target, bin, "{case} under {shell}"),
                    (false, MacDaemonUpdate::Blocked { reason }) => {
                        assert!(!reason.contains("over /bin/sh"), "{case} under {shell}: {reason}")
                    }
                    (_, verdict) => panic!("{case} under {shell}: {verdict:?}"),
                }
            }
        }
    }

    /// The same, for a binary in a folder this login can't write: refused before any
    /// upload is offered.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_refuses_a_mac_update_into_a_folder_it_cannot_write() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = std::process::Command::new("id").arg("-u").output().map(|o| o.stdout == b"0\n").unwrap_or(false);
        if root {
            return;
        }
        let home = FakeMacHome::new("readonly");
        home.diagnose_commands(0);
        let bin = home.0.join("bin/flightdeckd").to_string_lossy().into_owned();
        home.launch_agent(
            "com.tosse.flightdeckd.plist",
            &agent_plist("com.tosse.flightdeckd", &[&bin, "run"], "<key>RunAtLoad</key><true/>"),
        );
        std::fs::set_permissions(home.0.join("bin"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let d = home.diagnose("/bin/zsh");
        std::fs::set_permissions(home.0.join("bin"), std::fs::Permissions::from_mode(0o755)).unwrap();
        match d.mac_daemon_update {
            Some(MacDaemonUpdate::Blocked { reason }) => assert!(reason.contains("can't write"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// What a Mac diagnosis prints for the update verdict — the plist lists and
    /// [`MAC_UPDATE_FACTS_FN`]'s markers — and nothing else: the live test below must not
    /// run `flightdeckd status` against this Mac's own daemon.
    #[cfg(target_os = "macos")]
    fn mac_update_facts_script() -> String {
        format!(
            "FLIGHTDECKD_BIN={}\n{}\n{}\n{}",
            resolve_daemon_bin_expr("flightdeckd"),
            mac_agent_fns(),
            mac_update_fns(),
            r#"LA_PLISTS=$(fd_mac_agent_plists)
[ -n "$LA_PLISTS" ] && printf '%s\n' "$LA_PLISTS" | sed 's/^/FLIGHTDECK_MAC_AGENT_PLIST:/'
fd_mac_invalid_agent_plists | sed 's/^/FLIGHTDECK_MAC_AGENT_INVALID:/'
if [ -n "$LA_PLISTS" ] && [ "$(printf '%s\n' "$LA_PLISTS" | grep -c .)" = 1 ]; then
    fd_mac_update_facts "$LA_PLISTS"
else
    fd_mac_update_facts ""
fi"#
        )
    }

    /// LIVE, read-only: the update verdict against THIS Mac's real `~/Library/LaunchAgents`
    /// (for a Mac that is itself a paired server — e.g. a hand-made
    /// `com.tosse.flightdeckd` agent running `~/.local/bin/flightdeckd`). It only reads
    /// plists, asks launchd what the job runs and `lsof` which binary its daemon is —
    /// never touches the daemon or its socket. Prints the verdict; fails only if the
    /// script itself does. `cargo test --lib -- --ignored --nocapture live_mac_update`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "reads this Mac's own LaunchAgents"]
    fn live_mac_update_verdict_against_this_mac() {
        let out = std::process::Command::new("/bin/zsh")
            .arg("-c")
            .arg(mac_update_facts_script())
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .output()
            .expect("run the facts");
        assert!(out.status.success(), "{out:?}");
        let stdout = String::from_utf8_lossy(&out.stdout);
        println!("{stdout}");
        println!("verdict: {:?}", judge_mac_update(&stdout));
    }

    /// The diagnose script's process check, with a fake `pgrep` that records how it was
    /// asked: a status that reaches no daemon from this login is "not running" only when
    /// pgrep — asked for THIS user's processes whose command line STARTS with
    /// `flightdeckd run` — matched nothing, saying nothing. A pgrep that is missing or
    /// rejects its options (BusyBox's usage error also exits 1) is unknown, with its own
    /// words, never "no daemon" — a live daemon would otherwise be restarted.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_cross_checks_an_unanswered_status_against_this_users_processes() {
        let uid = String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
        let uid = uid.trim();
        let cases: [(&str, &str, Option<bool>, Option<bool>, Option<&str>); 4] = [
            ("this user's daemon, its socket gone", "exit 0", Some(true), None, None),
            ("no flightdeckd run process of this user", "exit 1", Some(false), Some(false), None),
            (
                "no pgrep on the server",
                "echo 'sh: 1: pgrep: not found' >&2\nexit 127",
                None,
                None,
                Some("sh: 1: pgrep: not found"),
            ),
            (
                "a BusyBox pgrep without -u",
                "echo 'pgrep: unrecognized option: u' >&2\necho 'BusyBox v1.36.1 multi-call binary.' >&2\nexit 1",
                None,
                None,
                Some("pgrep: unrecognized option: u"),
            ),
        ];
        for shell in ["/bin/sh", "/bin/zsh", "/bin/dash"] {
            for (case, outcome, seen, running, error) in cases {
                let home = FakeMacHome::new("process");
                home.diagnose_commands(0);
                home.command("flightdeckd", "#!/bin/sh\n[ \"$1\" = --version ] && echo 'flightdeckd 0.2.0'\nexit 1\n");
                home.command("pgrep", &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/pgrep.args\"\n{outcome}\n"));
                home.launch_agent(
                    "com.example.flightdeckd.plist",
                    &agent_plist("com.example.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
                );
                let d = home.diagnose(shell);
                assert_eq!(d.daemon_process_seen, seen, "{case} under {shell}");
                assert_eq!(d.daemon_running, running, "{case} under {shell}");
                assert_eq!(d.daemon_process_check_error.as_deref(), error, "{case} under {shell}");
                assert_eq!(restart_plan(&d, "admin").is_ok(), running == Some(false), "{case} under {shell}");
                assert_eq!(
                    home.read("pgrep.args").unwrap_or_default(),
                    format!("-u\n{uid}\n-f\n{DAEMON_PROCESS_ERE}\n"),
                    "this user's processes, the anchored pattern — {case} under {shell}"
                );
            }
        }
    }

    /// A daemon whose socket accepts and never answers (its `status` client has no
    /// timeout of its own) used to hold the whole diagnosis until the Mac's deadline,
    /// losing every later check. The script bounds that one call: the rest still runs,
    /// and the silent status reads as "not answering", cross-checked like any other.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_bounds_a_daemon_status_that_never_answers() {
        for shell in ["/bin/sh", "/bin/zsh", "/bin/dash"] {
            let home = FakeMacHome::new("stuck-status");
            home.diagnose_commands(0);
            home.command(
                "flightdeckd",
                "#!/bin/sh\ncase \"$1\" in\n--version) echo 'flightdeckd 0.2.0' ;;\nstatus) exec sleep 600 ;;\nesac\n",
            );
            let started = std::time::Instant::now();
            let out = home.run(shell, &diagnose_script(), &[("FD_STEP_SECS", "1")]);
            let took = started.elapsed();
            assert!(out.status.success(), "{shell}: {out:?}");
            assert!(took < Duration::from_secs(10), "{shell} waited {took:?} on the stuck status");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(stdout.lines().any(|l| l == "FLIGHTDECK_STATUS_JSON:"), "{shell}: {stdout}");
            assert!(stdout.contains("FLIGHTDECK_LAST_BOOT:"), "the checks after it still ran under {shell}");
            let d = parse_diagnosis(&stdout, true);
            assert_eq!(d.daemon_version_running, None, "{shell}");
        }
    }

    /// The Linux branch's systemd cross-check, run on this Mac with `uname` and
    /// `systemctl` faked: a system unit systemd reports active is a running daemon even
    /// when neither its status nor its process is visible from this login.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reads_an_active_systemd_unit_as_a_daemon_seen_running() {
        for shell in ["/bin/sh", "/bin/zsh", "/bin/dash"] {
            let home = FakeMacHome::new("linux-active");
            home.diagnose_commands(0);
            home.command("uname", "#!/bin/sh\necho Linux\n");
            home.command("flightdeckd", "#!/bin/sh\n[ \"$1\" = --version ] && echo 'flightdeckd 0.2.0'\nexit 1\n");
            home.command(
                "systemctl",
                "#!/bin/sh\ncase \"$*\" in\n\"is-active flightdeckd\") echo active ;;\n\"--user is-active flightdeckd\") echo inactive ;;\nesac\n",
            );
            let d = home.diagnose(shell);
            assert_eq!(d.host_os.as_deref(), Some("Linux"), "{shell}");
            assert_eq!(d.daemon_process_seen, Some(true), "{shell}");
            assert_eq!(d.daemon_running, None, "{shell}");
        }
    }

    /// The LaunchAgent restart as [`restart_plan`] hands it to ssh, run under zsh with a
    /// fake `launchctl`: `kickstart -k` a loaded agent, `bootstrap` one launchd doesn't
    /// have, and refuse — saying why, on the one stderr line ssh reports — with nobody
    /// logged in or with several agents to choose from.
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_agent_restart_script_drives_launchctl_under_zsh() {
        let RestartPlan::Plain(script) =
            restart_plan(&ServerDiagnosis { host_os: Some(MACOS_UNAME.into()), installed_as: InstalledAs::LaunchAgent, ..base_diagnosis() }, "admin")
                .expect("a LaunchAgent restarts")
        else {
            panic!("a LaunchAgent restarts without sudo");
        };
        let uid = String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
        let uid = uid.trim();
        let launchctl = r#"#!/bin/sh
echo "$*" >> "$HOME/launchctl.log"
if [ "$1" = print ]; then
    case "$2" in
    */*/*) [ -n "$FAKE_AGENT_LOADED" ] && exit 0; exit 113 ;;
    *) [ -n "$FAKE_GUI_DOMAIN" ] && exit 0; exit 112 ;;
    esac
fi
exit 0
"#;
        let new_home = |tag: &str| {
            let home = FakeMacHome::new(tag);
            home.command("launchctl", launchctl);
            let plist = home.launch_agent(
                "com.example.flightdeckd.plist",
                &agent_plist("com.example.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
            );
            (home, plist)
        };

        let (home, _) = new_home("restart-loaded");
        let out = home.run("/bin/zsh", &script, &[("FAKE_GUI_DOMAIN", "1"), ("FAKE_AGENT_LOADED", "1")]);
        assert!(out.status.success(), "{out:?}");
        let log = home.read("launchctl.log").unwrap_or_default();
        assert!(log.contains(&format!("kickstart -k gui/{uid}/com.example.flightdeckd")), "{log}");

        let (home, plist) = new_home("restart-not-loaded");
        let out = home.run("/bin/zsh", &script, &[("FAKE_GUI_DOMAIN", "1")]);
        assert!(out.status.success(), "{out:?}");
        let log = home.read("launchctl.log").unwrap_or_default();
        assert!(log.contains(&format!("bootstrap gui/{uid} {plist}")), "{log}");
        assert!(!log.contains("kickstart"), "{log}");

        let (home, _) = new_home("restart-no-gui");
        let out = home.run("/bin/zsh", &script, &[]);
        assert!(!out.status.success());
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("nobody is logged into this Mac"), "{stderr}");
        let log = home.read("launchctl.log").unwrap_or_default();
        assert!(!log.contains("kickstart") && !log.contains("bootstrap"), "{log}");

        let (home, first) = new_home("restart-two");
        let second = home.launch_agent(
            "org.other.flightdeckd.plist",
            &agent_plist("org.other.flightdeckd", &["/opt/flightdeckd", "run"], "<key>KeepAlive</key><true/>"),
        );
        let out = home.run("/bin/zsh", &script, &[("FAKE_GUI_DOMAIN", "1"), ("FAKE_AGENT_LOADED", "1")]);
        assert!(!out.status.success(), "two agents must be refused");
        let stderr = String::from_utf8_lossy(&out.stderr);
        let last_line = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
        assert!(last_line.contains("several LaunchAgents run flightdeckd"), "{stderr}");
        assert!(last_line.contains(&first) && last_line.contains(&second), "both files named on ssh's one line: {stderr}");
        let log = home.read("launchctl.log").unwrap_or_default();
        assert!(!log.contains("kickstart") && !log.contains("bootstrap"), "nothing is restarted: {log}");

        // The only plist naming flightdeckd can't be parsed: said, with the file, and
        // never handed to launchctl (its PlistBuddy "Label" was the error text).
        let home = FakeMacHome::new("restart-invalid");
        home.command("launchctl", launchctl);
        let broken = home.launch_agent("com.tosse.flightdeckd.plist", BROKEN_AGENT_PLIST);
        let out = home.run("/bin/zsh", &script, &[("FAKE_GUI_DOMAIN", "1"), ("FAKE_AGENT_LOADED", "1")]);
        assert!(!out.status.success());
        let stderr = String::from_utf8_lossy(&out.stderr);
        let last_line = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
        assert!(last_line.contains(&broken) && last_line.contains("can't be parsed"), "{stderr}");
        assert_eq!(home.read("launchctl.log"), None, "launchctl is never touched");
    }

    /// A hand-made agent plist launchd can't load: the unescaped `&&` is invalid XML
    /// (`plutil -lint`: "unknown ampersand-escape sequence"). PlistBuddy answers every
    /// read of it with "Error Reading File: <path>" on STDOUT — which used to pass for
    /// its values (its Label "named flightdeckd", RunAtLoad read as off).
    #[cfg(target_os = "macos")]
    const BROKEN_AGENT_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.tosse.flightdeckd</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>cd ~ && exec flightdeckd run</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
"#;

    /// Regression: a plist launchd can't parse was read through PlistBuddy's error text —
    /// "detected" as the agent, with a false "set RunAtLoad to true" step. It is listed
    /// apart, as one that can't be parsed, and never counted as an agent — next to a
    /// valid one or alone.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_reports_a_plist_it_cant_parse_apart_from_the_agents() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            let home = FakeMacHome::new("invalid");
            home.diagnose_commands(0);
            let broken = home.launch_agent("com.tosse.flightdeckd.plist", BROKEN_AGENT_PLIST);
            let d = home.diagnose(shell);
            assert_eq!(d.invalid_launch_agent_plists, vec![broken.clone()], "{shell}");
            assert!(d.launch_agent_plists.is_empty(), "{shell}");
            assert_eq!(d.installed_as, InstalledAs::Detached, "a running daemon no loadable agent runs, under {shell}");
            assert_eq!(d.agent_starts_at_login, None, "never a false 'RunAtLoad is off', under {shell}");

            let agent = home.launch_agent(
                "org.admin.flightdeckd.plist",
                &agent_plist("org.admin.flightdeckd", &["/opt/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
            );
            let d = home.diagnose(shell);
            assert_eq!(d.launch_agent_plists, vec![agent], "{shell}");
            assert_eq!(d.invalid_launch_agent_plists, vec![broken], "{shell}");
            assert_eq!(d.agent_starts_at_login, Some(true), "{shell}");
        }
    }

    /// Regression: a helper job that only USES flightdeckd — rotating its log, checking
    /// its status, backing its state up, a label named after it, an app's agent under a
    /// dedicated `/Users/flightdeckd` account — counted as a second agent next to the
    /// real one: "keep only one LaunchAgent", login facts unknown, and no Restart.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_never_counts_a_helper_job_next_to_the_real_agent() {
        for shell in ["/bin/sh", "/bin/zsh"] {
            let home = FakeMacHome::new("helpers");
            home.diagnose_commands(0);
            let state = home.0.join(".flightdeckd").to_string_lossy().into_owned();
            let bin = home.0.join("bin").to_string_lossy().into_owned();
            home.write(".flightdeckd/newsyslog.conf", "/Users/admin/Library/Logs/flightdeckd.log 644 5 * $D0\n");
            home.write("bin/backup.sh", &format!("#!/bin/sh\nrsync -a {state}/ /Volumes/Backup/flightdeckd/\n"));
            home.write("bin/start-daemon.sh", "#!/bin/sh\nexport PATH=\"$HOME/.local/bin:$PATH\"\nexec flightdeckd run\n");
            let newsyslog = format!("{state}/newsyslog.conf");
            let backup = format!("{bin}/backup.sh");
            let working_dir = format!("<key>WorkingDirectory</key><string>{state}</string>");
            let helpers: [(&str, Vec<&str>, &str); 5] = [
                ("com.admin.newsyslog", vec!["/usr/sbin/newsyslog", "-f", &newsyslog], ""),
                ("com.admin.healthcheck", vec!["/bin/sh", "-c", "flightdeckd status || say down"], ""),
                ("com.tosse.flightdeckd.logrotate", vec!["/usr/bin/true"], ""),
                ("com.admin.backup", vec![&backup], &working_dir),
                (
                    "com.google.keystone.agent",
                    vec!["/Users/flightdeckd/Library/Google/GoogleSoftwareUpdate/Agent", "-runMode", "ifneeded"],
                    "<key>StandardErrorPath</key><string>/Users/flightdeckd/Library/Logs/keystone.log</string>",
                ),
            ];
            for (label, args, keys) in &helpers {
                home.launch_agent(&format!("{label}.plist"), &agent_plist(label, args, keys));
            }
            let agent = home.launch_agent(
                "com.tosse.flightdeckd.plist",
                &agent_plist("com.tosse.flightdeckd", &[&format!("{bin}/start-daemon.sh")], "<key>RunAtLoad</key><true/>"),
            );
            let d = home.diagnose(shell);
            assert_eq!(d.launch_agent_plists, vec![agent.clone()], "only the agent that starts the daemon, under {shell}");
            assert_eq!(d.agent_starts_at_login, Some(true), "{shell}");
            assert!(restart_plan(&d, "admin").is_ok(), "Restart stays offered under {shell}");

            // Only the helpers, and a daemon this user started by hand: no agent at all —
            // never the job merely named after it, which Restart would kickstart.
            std::fs::remove_file(&agent).unwrap();
            home.command("pgrep", "#!/bin/sh\n[ \"$1\" = -u ] && exit 0\nexit 1\n");
            let d = home.diagnose(shell);
            assert_eq!(d.launch_agent_plists, Vec::<String>::new(), "{shell}");
            assert_eq!(d.installed_as, InstalledAs::Detached, "{shell}");
        }
    }

    /// Two agents that both start `flightdeckd run`: the one launchd runs as the daemon
    /// right now is THE agent — its job's pid is the daemon, or (a wrapper that doesn't
    /// `exec`) the daemon's parent. Restart then kickstarts the job that runs it.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_picks_the_agent_launchd_runs_as_the_daemon() {
        // launchd runs com.b.flightdeckd as pid 4242; com.a.flightdeckd isn't loaded.
        let launchctl = r#"#!/bin/sh
case "$1 $2" in
"print gui/"*/com.b.flightdeckd)
    printf 'gui/501/com.b.flightdeckd = {\n\tstate = running\n\tpid = 4242\n\tpid-local endpoints = {\n\t}\n}\n'
    exit 0 ;;
print*) exit 113 ;;
esac
exit 0
"#;
        let cases = [
            ("the job is the daemon", "[ \"$4\" = 4242 ] && echo '/Users/admin/.local/bin/flightdeckd run'", "exit 1"),
            (
                "the job is a wrapper whose child is the daemon",
                "[ \"$4\" = 4242 ] && echo '/bin/sh /Users/admin/bin/start-daemon.sh'",
                "[ \"$1 $2\" = '-P 4242' ] && exit 0\nexit 1",
            ),
        ];
        for shell in ["/bin/sh", "/bin/zsh"] {
            for (case, ps, pgrep) in cases {
                let home = FakeMacHome::new("running-job");
                home.diagnose_commands(0);
                home.command("launchctl", launchctl);
                home.command("ps", &format!("#!/bin/sh\n{ps}\nexit 0\n"));
                home.command("pgrep", &format!("#!/bin/sh\n{pgrep}\n"));
                home.launch_agent(
                    "com.a.flightdeckd.plist",
                    &agent_plist("com.a.flightdeckd", &["/opt/old/flightdeckd", "run"], "<key>RunAtLoad</key><true/>"),
                );
                let running = home.launch_agent(
                    "com.b.flightdeckd.plist",
                    &agent_plist("com.b.flightdeckd", &["/bin/sh", "-c", "exec flightdeckd run"], "<key>KeepAlive</key><true/>"),
                );
                let d = home.diagnose(shell);
                assert_eq!(d.launch_agent_plists, vec![running], "{case} under {shell}");
                assert_eq!(d.agent_starts_at_login, Some(true), "{case} under {shell}");
            }
        }
    }

    /// Regression: the wrapper a hand-made agent launches was only read when it was
    /// named, as a plain file, by a whole argument — a symlinked wrapper, or one started
    /// through an `sh -c` string (absolute, `~/` or `$HOME/`), read as "no agent", with a
    /// false "Run flightdeckd as a LaunchAgent" step and Restart refused.
    #[cfg(target_os = "macos")]
    #[test]
    fn diagnose_script_follows_a_wrapper_through_a_symlink_or_an_sh_c_string() {
        // `(wrapper, symlink to it)` → the agent's ProgramArguments.
        type Args = fn(&str, &str) -> Vec<String>;
        let cases: [(&str, Args); 5] = [
            ("a symlink to the wrapper", |_, link| vec![link.to_string()]),
            ("the wrapper in an sh -c string", |wrapper, _| {
                vec!["/bin/sh".into(), "-c".into(), format!("exec {wrapper} --verbose")]
            }),
            ("a quoted symlink in an sh -c string", |_, link| {
                vec!["/bin/zsh".into(), "-c".into(), format!("cd /tmp &amp;&amp; exec '{link}'")]
            }),
            ("a ~/ wrapper in an sh -c string", |_, _| {
                vec!["/bin/sh".into(), "-c".into(), "exec ~/dotfiles/start-daemon.sh".into()]
            }),
            ("a $HOME/ wrapper in an sh -c string", |_, _| {
                vec!["/bin/sh".into(), "-c".into(), "\"$HOME/dotfiles/start-daemon.sh\"".into()]
            }),
        ];
        for shell in ["/bin/sh", "/bin/zsh"] {
            for (case, args) in cases {
                let home = FakeMacHome::new("wrapper-form");
                home.diagnose_commands(0);
                home.write("dotfiles/start-daemon.sh", "#!/bin/sh\nexport PATH=\"$HOME/.local/bin:$PATH\"\nexec flightdeckd run\n");
                let wrapper = home.0.join("dotfiles/start-daemon.sh");
                let link = home.0.join("bin/start-daemon");
                std::os::unix::fs::symlink(&wrapper, &link).unwrap();
                let args = args(&wrapper.to_string_lossy(), &link.to_string_lossy());
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                let plist = home.launch_agent(
                    "com.admin.daemon.plist",
                    &agent_plist(
                        "com.admin.daemon",
                        &args,
                        "<key>WorkingDirectory</key><string>/Users/admin/.flightdeckd</string><key>RunAtLoad</key><true/>",
                    ),
                );
                let d = home.diagnose(shell);
                assert_eq!(d.launch_agent_plists, vec![plist], "{case} under {shell}");
                assert_eq!(d.installed_as, InstalledAs::LaunchAgent, "{case} under {shell}");
            }
        }
    }

    // ---- the Detached restart's kill pattern ----

    /// [`DAEMON_PROCESS_ERE`] — the ERE pgrep and pkill read, checked here with the
    /// `regex` crate on whole command lines, as procps reads them (`^` is the start of
    /// the command line, not of each line) — matches a running daemon, whatever its
    /// path, and nothing else: not a client, and above all not a shell whose arguments
    /// NAME it (the restart's own `$SHELL -c '…'`, the diagnose script's).
    #[test]
    fn the_daemon_process_pattern_matches_the_daemon_and_never_a_shell_naming_it() {
        let re = regex::Regex::new(DAEMON_PROCESS_ERE).unwrap();
        for daemon in [
            "flightdeckd run",
            "./flightdeckd run",
            "/home/agent/.local/bin/flightdeckd run",
            "/usr/local/bin/flightdeckd run --verbose",
        ] {
            assert!(re.is_match(daemon), "{daemon}");
        }
        let RestartPlan::Plain(restart) =
            restart_plan(&ServerDiagnosis { installed_as: InstalledAs::Detached, ..base_diagnosis() }, "agent").unwrap()
        else {
            panic!("a detached restart runs without sudo");
        };
        let mut others = vec![
            "flightdeckd attach --conversation c".to_string(),
            "flightdeckd status".to_string(),
            "flightdeckd running".to_string(),
            "/opt/notflightdeckd run".to_string(),
            "/bin/sh /home/agent/bin/start-daemon.sh".to_string(),
        ];
        for shell in ["bash", "-bash", "/bin/sh", "dash", "zsh"] {
            others.push(format!("{shell} -c {restart}"));
            others.push(format!("{shell} -c {}", diagnose_script()));
        }
        for other in &others {
            assert!(!re.is_match(other), "{other}");
        }
    }

    /// The Detached restart end to end, under the shells a Linux login runs, with a
    /// `pkill` that behaves like procps' where it matters: it skips only itself, so the
    /// shell running the restart — its parent — is killed when its command line matches
    /// (and nothing else on this Mac is ever touched). Regression: the unanchored
    /// `'flightdeckd run'` matched that shell's own arguments, killing it before it could
    /// start the daemon (macOS's pkill skips its ancestors, which hid it there).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_detached_restart_survives_a_pkill_that_spares_only_itself() {
        let stopped = ServerDiagnosis {
            installed_as: InstalledAs::Detached,
            daemon_running: Some(false),
            daemon_process_seen: Some(false),
            busy_conversations: None,
            ..base_diagnosis()
        };
        let RestartPlan::Plain(script) = restart_plan(&stopped, "agent").expect("a stopped daemon restarts") else {
            panic!("a detached restart runs without sudo");
        };
        let pkill = r#"#!/bin/sh
printf '%s\n' "$@" > "$HOME/pkill.args"
for fd_pattern; do :; done
if ps -o args= -p "$PPID" | grep -Eq -- "$fd_pattern"; then
    echo killed >> "$HOME/pkill.log"
    kill "$PPID"
fi
exit 1
"#;
        let uid = String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
        for shell in ["/bin/sh", "/bin/dash", "/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let home = FakeMacHome::new("detached-restart");
            home.command("pkill", pkill);
            home.command("setsid", "#!/bin/sh\nexec \"$@\"\n");
            home.command("flightdeckd", "#!/bin/sh\n[ \"$1\" = run ] && echo started >> \"$HOME/started\"\nexit 0\n");
            let out = home.run(shell, &script, &[]);
            assert!(out.status.success(), "the restart's shell must survive its own pkill under {shell}: {out:?}");
            assert_eq!(home.read("pkill.log"), None, "{shell}");
            assert_eq!(home.read("pkill.args"), Some(format!("-u\n{}\n-f\n{DAEMON_PROCESS_ERE}\n", uid.trim())), "{shell}");
            let started = (0..50).any(|_| {
                std::thread::sleep(Duration::from_millis(100));
                home.read("started").is_some()
            });
            assert!(started, "the daemon was started under {shell}");
        }
    }

    // ---- restart_plan: which restart, or why none ----

    fn restart_error(d: ServerDiagnosis) -> BootstrapError {
        restart_plan(&d, "admin").expect_err("refused")
    }

    #[test]
    fn restart_plan_refuses_a_detached_daemon_on_a_mac_with_the_keychain_explanation() {
        let err = restart_error(ServerDiagnosis {
            host_os: Some(MACOS_UNAME.into()),
            installed_as: InstalledAs::Detached,
            ..base_diagnosis()
        });
        assert!(err.to_string().contains("Keychain") && err.to_string().contains("LaunchAgent"), "{err}");
    }

    #[test]
    fn restart_plan_picks_launchctl_for_a_launch_agent() {
        let plan = restart_plan(
            &ServerDiagnosis { host_os: Some(MACOS_UNAME.into()), installed_as: InstalledAs::LaunchAgent, ..base_diagnosis() },
            "admin",
        )
        .unwrap();
        assert_eq!(plan, RestartPlan::Plain(format!("{}\n{MAC_AGENT_RESTART_SCRIPT}", mac_agent_fns())));
    }

    #[test]
    fn restart_plan_picks_systemctl_for_systemd_installs() {
        assert_eq!(
            restart_plan(&base_diagnosis(), "root").unwrap(),
            RestartPlan::Plain("systemctl restart flightdeckd".into())
        );
        assert_eq!(
            restart_plan(&base_diagnosis(), "admin").unwrap(),
            RestartPlan::Sudo("systemctl restart flightdeckd".into())
        );
        let user = restart_plan(&ServerDiagnosis { installed_as: InstalledAs::User, ..base_diagnosis() }, "admin").unwrap();
        assert!(matches!(&user, RestartPlan::Plain(s) if s.contains("systemctl --user restart flightdeckd")), "{user:?}");
    }

    /// The bug this guards: "Restart the daemon" is offered precisely because the
    /// daemon is stopped, and a stopped daemon's busy count is unknown by construction —
    /// refusing on it meant the offered restart could never succeed. Linux and Mac alike.
    #[test]
    fn restart_plan_allows_a_daemon_confirmed_stopped() {
        for (host_os, installed_as) in [
            (Some("Linux"), InstalledAs::System),
            (Some("Linux"), InstalledAs::User),
            (Some("Linux"), InstalledAs::Detached),
            (Some(MACOS_UNAME), InstalledAs::LaunchAgent),
        ] {
            let d = ServerDiagnosis {
                host_os: host_os.map(str::to_string),
                installed_as,
                daemon_running: Some(false),
                daemon_process_seen: Some(false),
                busy_conversations: None,
                ..base_diagnosis()
            };
            assert!(restart_plan(&d, "admin").is_ok(), "{installed_as:?} stopped must restart");
        }
    }

    /// Regression: a status that reaches nothing from the SSH login is not proof the
    /// daemon is stopped — another user's daemon (a hand-made system unit), or one whose
    /// socket or binary is gone, answers nothing there yet runs. Restarting it would
    /// kill its conversations (and, with the binary gone, leave it dead).
    #[test]
    fn restart_plan_refuses_a_daemon_seen_running_whose_status_cannot_be_read() {
        for (host_os, installed_as) in [
            (Some("Linux"), InstalledAs::System),
            (Some("Linux"), InstalledAs::User),
            (Some(MACOS_UNAME), InstalledAs::LaunchAgent),
        ] {
            let d = ServerDiagnosis {
                host_os: host_os.map(str::to_string),
                installed_as,
                daemon_running: None,
                daemon_process_seen: Some(true),
                busy_conversations: None,
                ..base_diagnosis()
            };
            let err = restart_error(d).to_string();
            assert!(err.starts_with("won't restart flightdeckd"), "{installed_as:?}: {err}");
            assert!(err.contains("its status can't be read from this SSH login"), "{installed_as:?}: {err}");
        }
    }

    /// Defense in depth: even a `daemon_running: Some(false)` built without the process
    /// check confirming it (no `ps` on the server) is not "confirmed stopped".
    #[test]
    fn restart_plan_needs_the_process_listing_to_confirm_a_stop() {
        for daemon_process_seen in [None, Some(true)] {
            let err = restart_error(ServerDiagnosis {
                daemon_running: Some(false),
                daemon_process_seen,
                busy_conversations: None,
                ..base_diagnosis()
            });
            assert_eq!(err, BootstrapError::DaemonBusy(None), "daemon_process_seen {daemon_process_seen:?}");
        }
    }

    #[test]
    fn restart_plan_refuses_a_running_daemon_with_busy_conversations() {
        let err = restart_error(ServerDiagnosis { daemon_running: Some(true), busy_conversations: Some(2), ..base_diagnosis() });
        assert_eq!(err, BootstrapError::DaemonBusy(Some(2)));
    }

    #[test]
    fn restart_plan_refuses_when_busy_cannot_be_confirmed_for_a_running_or_unknown_daemon() {
        for daemon_running in [Some(true), None] {
            let err = restart_error(ServerDiagnosis {
                daemon_running,
                daemon_process_seen: None,
                busy_conversations: None,
                // (a daemon recent enough to report background work: an older one is
                // refused for that reason — `count_busy_conversations_is_unknown_for_…`)
                daemon_version_running: Some("0.6.0".into()),
                ..base_diagnosis()
            });
            assert_eq!(err, BootstrapError::DaemonBusy(None), "daemon_running {daemon_running:?}");
        }
    }

    #[test]
    fn restart_plan_refuses_an_install_it_cannot_identify_before_the_busy_check() {
        for installed_as in [InstalledAs::None, InstalledAs::Unknown] {
            let err = restart_error(ServerDiagnosis { installed_as, busy_conversations: None, ..base_diagnosis() });
            assert!(err.to_string().contains("could not determine how flightdeckd is installed"), "{err}");
        }
    }

    // ---- KEY_ONLY_REPAIRS: the repairs that need Flight Deck's own key ----

    #[test]
    fn repair_needs_dedicated_key_is_key_only_repairs_minus_the_path_fix() {
        for action in ALL_REPAIR_ACTIONS {
            assert_eq!(
                repair_needs_dedicated_key(action, Some(&base_diagnosis())),
                KEY_ONLY_REPAIRS.contains(&action),
                "{action:?}: KEY_ONLY_REPAIRS alone decides"
            );
        }
        let path_fix = ServerDiagnosis {
            installed_as: InstalledAs::User,
            user_unit_missing_path: Some(true),
            ..base_diagnosis()
        };
        assert!(
            !repair_needs_dedicated_key(RepairAction::InstallService, Some(&path_fix)),
            "the user-unit PATH fix rides plain ssh"
        );
    }

    /// A Mac's "Update the daemon" reads what it needs off a fresh diagnosis and uploads
    /// over plain ssh, so it works on a Mac added with this Mac's own keys — the usual way
    /// a hand-made Mac server is added. Linux keeps the installer's keyed probe, and an
    /// unknown OS (an unreachable diagnosis) keeps today's requirement.
    #[test]
    fn a_mac_update_needs_no_key_of_flight_decks() {
        let mac = ServerDiagnosis {
            host_os: Some("Darwin".into()),
            installed_as: InstalledAs::LaunchAgent,
            ..base_diagnosis()
        };
        assert!(!repair_needs_dedicated_key(RepairAction::ReuploadDaemon, Some(&mac)));
        for action in [RepairAction::InstallService, RepairAction::ReconnectMac] {
            assert!(repair_needs_dedicated_key(action, Some(&mac)), "{action:?} still re-pushes or probes with the key");
        }
        assert!(repair_needs_dedicated_key(RepairAction::ReuploadDaemon, Some(&base_diagnosis())), "Linux");
        let unknown = ServerDiagnosis { host_os: None, ..base_diagnosis() };
        assert!(repair_needs_dedicated_key(RepairAction::ReuploadDaemon, Some(&unknown)), "an unreported OS");
        assert!(repair_needs_dedicated_key(RepairAction::ReuploadDaemon, None));
    }

    /// `repair`'s routing of ReuploadDaemon, on its own: a Mac goes to its update (gated on
    /// the diagnosis's verdict), Linux and an OS never reported to the installer's keyed
    /// upload as before, and any other host is refused with the installer's words.
    #[test]
    fn a_reupload_routes_a_mac_to_its_update_and_refuses_other_non_linux_hosts() {
        assert_eq!(reupload_route(Some("Linux")), Ok(ReuploadRoute::Installer));
        assert_eq!(reupload_route(None), Ok(ReuploadRoute::Installer), "the keyed probe decides, as before");
        assert_eq!(reupload_route(Some("")), Ok(ReuploadRoute::Installer));
        assert_eq!(reupload_route(Some("Darwin")), Ok(ReuploadRoute::MacUpdate));
        assert_eq!(reupload_route(Some("Darwin\n")), Ok(ReuploadRoute::MacUpdate));
        let bsd = reupload_route(Some("FreeBSD")).unwrap_err();
        assert!(bsd.contains("FreeBSD") && bsd.contains("only sets up Linux servers"), "{bsd}");
    }

    /// The Mac update goes ahead only on the fresh diagnosis's own Ready verdict, and only
    /// for the path it approved; a fresh Mac install (no LaunchAgent) stays refused with
    /// the verdict's reason, and a Mac whose verdict or CPU couldn't be read is refused
    /// rather than guessed.
    #[test]
    fn a_mac_update_goes_ahead_only_on_the_diagnosis_own_verdict() {
        let bin = "/Users/admin/.local/bin/flightdeckd";
        let mac = |update: Option<MacDaemonUpdate>| ServerDiagnosis {
            host_os: Some("Darwin".into()),
            host_arch: Some("x86_64".into()),
            installed_as: InstalledAs::LaunchAgent,
            mac_daemon_update: update,
            ..base_diagnosis()
        };
        let ready = mac(Some(MacDaemonUpdate::Ready { target: bin.into() }));
        assert_eq!(mac_update_plan(&ready), Ok(("x86_64", bin)));

        let fresh = mac(Some(judge_mac_update(&MacUpdateFacts { plists: &[], program: None, ..MacUpdateFacts::user_server() }.stdout())));
        let why = mac_update_plan(&fresh).unwrap_err();
        assert!(why.contains("no LaunchAgent runs flightdeckd") && why.contains("by hand"), "{why}");

        let unread = mac_update_plan(&mac(None)).unwrap_err();
        assert!(unread.contains("refresh the server"), "{unread}");

        let no_arch = ServerDiagnosis { host_arch: None, ..ready };
        assert!(mac_update_plan(&no_arch).unwrap_err().contains("CPU architecture"));
    }

    /// `repair`'s arms take Flight Deck's key only from what `KEY_ONLY_REPAIRS` fetched
    /// up front — an arm reaching for one the list didn't give it fails, naming the
    /// list, rather than fetching its own (the front hides exactly the listed repairs).
    #[test]
    fn listed_dedicated_key_is_only_the_key_fetched_for_a_listed_repair() {
        assert_eq!(listed_dedicated_key(Some("/keys/m1"), RepairAction::ReuploadDaemon).unwrap(), "/keys/m1");
        let err = listed_dedicated_key(None, RepairAction::ReconnectMac).unwrap_err().to_string();
        assert!(err.contains("KEY_ONLY_REPAIRS") && err.contains(&format!("Reconnect this {MACHINE}")), "{err}");
    }

    #[test]
    fn require_dedicated_key_names_the_way_out() {
        let mut machine = machine_record("m1", "h.example");
        machine.identity_file = None;
        let err = require_dedicated_key(&machine).expect_err("no Flight Deck key").to_string();
        assert!(err.contains("Connect an existing server") && err.contains("A key for Flight Deck"), "{err}");
        machine.identity_file = Some("/keys/m1".into());
        assert_eq!(require_dedicated_key(&machine).unwrap(), "/keys/m1");
    }

    /// The front hides [`KEY_ONLY_REPAIRS`] on a server without Flight Deck's key through
    /// its own copy, `KEY_ONLY_REPAIRS` in `serverBootstrapModel.ts` — this keeps the two
    /// lists identical, in order (serde names), so neither can drift on its own.
    #[test]
    fn key_only_repairs_match_the_front() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/settings/serverBootstrapModel.ts");
        let ts = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let decl = "export const KEY_ONLY_REPAIRS = [";
        let start = ts.find(decl).unwrap_or_else(|| panic!("{} must declare `{decl}`", path.display())) + decl.len();
        let body = &ts[start..start + ts[start..].find(']').expect("the array literal is closed")];
        let front: Vec<&str> = body.split('"').skip(1).step_by(2).collect();
        let back: Vec<String> = KEY_ONLY_REPAIRS
            .iter()
            .map(|a| serde_json::to_value(a).unwrap().as_str().unwrap().to_string())
            .collect();
        assert_eq!(front, back, "serverBootstrapModel.ts's KEY_ONLY_REPAIRS must list exactly the Rust list, in order");
    }

    #[test]
    fn the_installer_refuses_a_mac_and_any_other_non_linux_host() {
        assert_eq!(linux_only_installer_refusal(Some("Linux")), None);
        assert_eq!(linux_only_installer_refusal(None), None, "an unreported OS keeps today's behaviour");
        assert_eq!(linux_only_installer_refusal(Some("")), None);
        let mac = linux_only_installer_refusal(Some("Darwin")).expect("a Mac is refused");
        assert!(mac.contains("macOS") && mac.contains("Connect an existing server"), "{mac}");
        let bsd = linux_only_installer_refusal(Some("FreeBSD")).expect("FreeBSD is refused");
        assert!(bsd.contains("FreeBSD"), "{bsd}");
    }

    #[test]
    fn a_mac_refuses_only_the_systemd_repairs() {
        let refused = [
            RepairAction::InstallService,
            RepairAction::EnableLinger,
            RepairAction::MaskSleep,
            RepairAction::SignInClaude,
        ];
        for action in refused {
            assert!(repair_unsupported_on_host(action, Some("Darwin")).is_some(), "{action:?} on a Mac");
            assert_eq!(repair_unsupported_on_host(action, Some("Linux")), None, "{action:?} on Linux");
            assert_eq!(repair_unsupported_on_host(action, None), None, "{action:?} on an unknown OS");
        }
        for action in [
            RepairAction::RestartDaemon,
            RepairAction::RunInit,
            RepairAction::InstallClaude,
            RepairAction::ProvisionPhone,
            RepairAction::ReconnectMac,
        ] {
            assert_eq!(repair_unsupported_on_host(action, Some("Darwin")), None, "{action:?} works on a Mac");
        }
    }

    #[test]
    fn parse_diagnosis_unreachable_ssh_blanks_every_field_and_fails() {
        let d = parse_diagnosis("", false);
        assert_eq!(d.state, DiagnosisState::Failed { reason: "could not reach the server".to_string() });
        assert_eq!(d.installed_as, InstalledAs::Unknown);
        assert_eq!(d.daemon_running, None);
        assert_eq!(d.claude_logged_in, None);
        assert!(!d.reachable);
    }

    /// The whole reason `reachable` is its OWN field and not something read off
    /// [`DiagnosisState`]: a server that answers ssh perfectly well but whose
    /// `flightdeckd` is stopped collapses to `Failed` too. Anything deriving "this
    /// machine is out of reach" from `Failed` — or from `Failed`'s `reason` wording —
    /// would paint the remote mark red on a machine that is up and one repair click
    /// away. The front's badge reads THIS boolean; this test is what stops the two
    /// meanings from silently merging again.
    #[test]
    fn a_reachable_server_with_a_stopped_daemon_stays_reachable_while_failing() {
        let d = parse_diagnosis(
            "FLIGHTDECK_UNIT_SYSTEM:yes\nFLIGHTDECK_STATUS_JSON:\nFLIGHTDECK_DAEMON_PROCESS:no\n",
            true,
        );
        assert!(d.reachable, "ssh came back — the machine is reachable");
        assert_eq!(d.daemon_running, Some(false));
        assert!(
            matches!(d.state, DiagnosisState::Failed { .. }),
            "a stopped daemon is still a Failed diagnosis: {:?}",
            d.state,
        );
    }

    // ---- ServerDiagnosis::unreachable_with (link classification wording) ----

    #[test]
    fn a_repair_whose_diagnosis_could_not_reach_the_server_says_so() {
        let off = ServerDiagnosis::unreachable_with(SshLinkIssue::Unreachable, None);
        let msg = diagnosis_unreachable_refusal(&off).unwrap();
        assert!(msg.contains("could not reach the server") && msg.contains("try again"), "{msg}");
        assert!(!msg.contains("key"), "never blames a missing key: {msg}");
        assert_eq!(diagnosis_unreachable_refusal(&base_diagnosis()), None);
    }

    #[test]
    fn unreachable_with_key_refused_and_host_key_changed_have_fixed_reasons() {
        let key = ServerDiagnosis::unreachable_with(SshLinkIssue::KeyRefused, None);
        assert_eq!(key.link_issue, Some(SshLinkIssue::KeyRefused));
        assert!(!key.reachable);
        assert_eq!(key.state, DiagnosisState::Failed { reason: format!("this {MACHINE}'s saved key was refused") });
        assert_eq!(key.tailscale_off_locally, None);

        let host = ServerDiagnosis::unreachable_with(SshLinkIssue::HostKeyChanged, None);
        assert_eq!(host.link_issue, Some(SshLinkIssue::HostKeyChanged));
        assert_eq!(
            host.state,
            DiagnosisState::Failed {
                reason: format!("this server's identity has changed since this {MACHINE} last connected to it")
            },
        );
    }

    #[test]
    fn unreachable_with_unreachable_reason_depends_on_tailscale_signal() {
        let no_signal = ServerDiagnosis::unreachable_with(SshLinkIssue::Unreachable, None);
        assert_eq!(no_signal.link_issue, Some(SshLinkIssue::Unreachable));
        assert_eq!(no_signal.state, DiagnosisState::Failed { reason: "could not reach the server".to_string() });
        assert_eq!(no_signal.tailscale_off_locally, None);

        let tailscale_off = ServerDiagnosis::unreachable_with(SshLinkIssue::Unreachable, Some(true));
        assert_eq!(tailscale_off.state, DiagnosisState::Failed { reason: format!("Tailscale looks off on this {MACHINE}") });
        assert_eq!(tailscale_off.tailscale_off_locally, Some(true));

        // A `Some(false)` signal (never actually produced by `tailscale_off_locally_
        // if_relevant`, which only ever returns `Some(true)` or `None` — see its own
        // doc) must not be mistaken for the positive case either.
        let not_true = ServerDiagnosis::unreachable_with(SshLinkIssue::Unreachable, Some(false));
        assert_eq!(not_true.state, DiagnosisState::Failed { reason: "could not reach the server".to_string() });
    }

    /// Runs [`diagnose_within`] against a fake `ssh` whose body is `body` (it gets the
    /// script as its last argument and ignores it), returning the diagnosis and the
    /// fake's pid once it has written one.
    async fn diagnose_against_fake_ssh(body: &str, deadline: Duration) -> (ServerDiagnosis, Option<String>) {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("fd-diagnose-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ssh = dir.join("ssh");
        std::fs::write(&ssh, format!("#!/bin/sh\necho $$ > \"$(dirname \"$0\")/pid\"\n{body}\n")).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(ssh.to_string_lossy().into_owned()));
        let machine = machine_record("m", "203.0.113.7");
        let d = tokio::time::timeout(Duration::from_secs(20), diagnose_within(&machine, None, deadline)).await;
        crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        let pid = std::fs::read_to_string(dir.join("pid")).ok().map(|p| p.trim().to_string());
        let _ = std::fs::remove_dir_all(&dir);
        (d.expect("the diagnosis's own deadline must fire"), pid)
    }

    /// A server that answers and then stalls on one check (a frozen daemon's `status`,
    /// a slow `claude`) is REACHABLE: reported as "could not reach the server", it sent
    /// the user looking at the network and refused every repair. Its ssh is reaped.
    #[tokio::test(flavor = "current_thread")]
    async fn a_diagnosis_cut_by_the_deadline_after_the_server_answered_is_not_unreachable() {
        let (d, pid) = diagnose_against_fake_ssh(
            "printf 'FLIGHTDECK_OS:Linux\\nFLIGHTDECK_ARCH:x86_64\\n'\nexec sleep 60",
            Duration::from_secs(1),
        )
        .await;
        assert!(d.reachable, "{d:?}");
        assert_eq!(d.link_issue, None);
        assert_eq!(d.host_os.as_deref(), Some("Linux"), "the facts that arrived are kept");
        match &d.state {
            DiagnosisState::Failed { reason } => assert!(reason.contains("checks did not finish"), "{reason}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(diagnosis_unreachable_refusal(&d), None);
        let pid = pid.expect("the fake ran");
        let mut gone = false;
        for _ in 0..40 {
            let ps = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid]).output().unwrap();
            let state = String::from_utf8_lossy(&ps.stdout).trim().to_string();
            if state.is_empty() || state.starts_with('Z') {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = std::process::Command::new("kill").args(["-9", &pid]).status();
        assert!(gone, "the stalled ssh {pid} must be killed");
    }

    /// Nothing at all before the deadline is still the link's fault.
    #[tokio::test(flavor = "current_thread")]
    async fn a_diagnosis_with_no_answer_before_the_deadline_stays_unreachable() {
        let (d, _) = diagnose_against_fake_ssh("exec sleep 60", Duration::from_millis(500)).await;
        assert!(!d.reachable);
        assert_eq!(d.link_issue, Some(SshLinkIssue::Unreachable));
    }

    /// The ambient probe must say WHY in the full diagnosis's own words — the mark's
    /// tooltip and the server panel can never disagree on the reason.
    #[test]
    fn reachability_carries_the_diagnosis_reason_verbatim() {
        for (issue, tailscale_off) in [
            (SshLinkIssue::KeyRefused, None),
            (SshLinkIssue::HostKeyChanged, None),
            (SshLinkIssue::Unreachable, None),
            (SshLinkIssue::Unreachable, Some(true)),
        ] {
            let d = ServerDiagnosis::unreachable_with(issue, tailscale_off);
            let DiagnosisState::Failed { reason } = &d.state else { panic!("unreachable is Failed") };
            assert_eq!(
                MachineReachability::from(&d),
                MachineReachability { reachable: false, reason: Some(reason.clone()) },
            );
        }
        let invalid = MachineReachability::from(&invalid_connection_details());
        assert!(!invalid.reachable);
        assert_eq!(
            invalid.reason.as_deref(),
            Some("this server's saved connection details are not valid — remove and re-add it"),
        );
        assert_eq!(MachineReachability::reached(), MachineReachability { reachable: true, reason: None });
    }

    /// A REACHABLE server whose daemon is stopped is `Failed` too — but it must never
    /// read as unreachable through the ambient probe's shape (same prudence as
    /// `store/machineHealth.ts`, which only ever looks at `reachable`).
    #[test]
    fn reachability_of_a_reachable_failed_diagnosis_has_no_reason() {
        let mut d = ServerDiagnosis::unreachable();
        d.reachable = true;
        d.state = DiagnosisState::Failed { reason: "flightdeckd is not running".to_string() };
        assert_eq!(MachineReachability::from(&d), MachineReachability { reachable: true, reason: None });
    }

    #[test]
    fn plain_unreachable_delegates_to_unreachable_with() {
        let d = ServerDiagnosis::unreachable();
        assert_eq!(d.link_issue, Some(SshLinkIssue::Unreachable));
        assert_eq!(d.state, DiagnosisState::Failed { reason: "could not reach the server".to_string() });
    }

    #[tokio::test]
    async fn tailscale_off_locally_if_relevant_skips_a_non_tailnet_host() {
        // Gated on `host_looks_like_tailnet` FIRST — an ordinary host must never pay
        // for (or even attempt) the local `tailscale` subprocess.
        assert_eq!(tailscale_off_locally_if_relevant("example.com").await, None);
    }

    // ---- RepairAction::ReconnectMac (CRM `c9bf1482`) ----

    #[test]
    fn require_connection_password_without_one_needs_one() {
        assert!(matches!(require_connection_password(None), Err(BootstrapError::NeedsConnectionPassword)));
    }

    #[test]
    fn require_connection_password_with_one_passes_it_through() {
        let pw = SecretString::new("hunter2".to_string());
        assert_eq!(require_connection_password(Some(&pw)).unwrap().expose(), "hunter2");
    }

    #[test]
    fn reconnect_mac_password_error_rewords_only_a_wrong_password() {
        match reconnect_mac_password_error(BootstrapError::WrongPassword) {
            BootstrapError::Other(msg) => {
                assert!(msg.contains("remove and re-add"), "{msg}");
                assert!(msg.contains("use a command instead"), "{msg}");
            }
            other => panic!("expected BootstrapError::Other(..), got {other:?}"),
        }
        // Every other `install_key` outcome is forwarded UNCHANGED — it already
        // explains itself.
        assert_eq!(reconnect_mac_password_error(BootstrapError::HostKeyMismatch), BootstrapError::HostKeyMismatch);
        assert_eq!(reconnect_mac_password_error(BootstrapError::HostUnreachable), BootstrapError::HostUnreachable);
        assert_eq!(reconnect_mac_password_error(BootstrapError::Timeout), BootstrapError::Timeout);
    }

    /// M12: "Reconnect this Mac" never pins a key on the spot to send a password to it —
    /// an unsaved key is refused with the way back; a changed one stays a mismatch.
    #[test]
    fn reconnect_mac_refuses_an_unsaved_host_key_with_the_way_back() {
        match reconnect_mac_host_key_error(BootstrapError::HostKeyUnconfirmed("SHA256:abc".into())) {
            BootstrapError::Other(msg) => {
                assert!(msg.contains("SHA256:abc") && msg.contains("won't send it a password"), "{msg}");
                assert!(msg.contains("add it again"), "{msg}");
            }
            other => panic!("expected BootstrapError::Other(..), got {other:?}"),
        }
        assert_eq!(reconnect_mac_host_key_error(BootstrapError::HostKeyMismatch), BootstrapError::HostKeyMismatch);
        assert_eq!(reconnect_mac_host_key_error(BootstrapError::HostUnreachable), BootstrapError::HostUnreachable);
    }

    // ---- daemon_is_outdated (B2/B3: bundled version vs. the server's running one) ----

    #[test]
    fn daemon_is_outdated_true_when_the_bundled_version_is_newer() {
        assert!(daemon_is_outdated(Some("0.1.0"), Some("flightdeckd 0.1.0"), Some("0.2.0")));
        assert!(daemon_is_outdated(Some("flightdeckd 0.1.0"), None, Some("0.2.0")), "an unknown disk version");
    }

    #[test]
    fn daemon_is_outdated_false_when_equal_or_the_server_is_newer() {
        assert!(!daemon_is_outdated(Some("0.2.0"), Some("flightdeckd 0.2.0"), Some("0.2.0")));
        assert!(!daemon_is_outdated(Some("0.3.0"), Some("flightdeckd 0.3.0"), Some("0.2.0")));
    }

    #[test]
    fn daemon_is_outdated_never_true_on_an_unknown_side() {
        assert!(!daemon_is_outdated(None, Some("flightdeckd 0.1.0"), Some("0.2.0")), "unknown running version must never nag");
        assert!(!daemon_is_outdated(Some("0.1.0"), Some("flightdeckd 0.1.0"), None), "no bundled daemon at all must never nag");
        assert!(!daemon_is_outdated(None, None, None));
    }

    /// Right after a successful update the server still RUNS the old daemon, with the
    /// bundled one on disk: what is left is the restart (`restart_pending`), never a
    /// second upload — offering both had the user click "Update" again for an
    /// `AlreadyCurrent`, unsure whether the first one worked. A disk copy newer than the
    /// running one but still behind the bundle does need the upload.
    #[test]
    fn an_update_that_landed_leaves_only_the_restart() {
        let stdout = [
            "FLIGHTDECK_OS:Linux",
            "FLIGHTDECK_BIN_PRESENT:yes",
            "FLIGHTDECK_VERSION_DISK:flightdeckd 0.3.0",
            r#"FLIGHTDECK_STATUS_JSON:{"type":"fd_status","version":"0.2.0","conversations":[]}"#,
        ]
        .join("\n");
        let d = parse_diagnosis_fields(&stdout);
        assert!(d.restart_pending, "0.3.0 on disk, 0.2.0 running");
        assert!(
            !daemon_is_outdated(d.daemon_version_running.as_deref(), d.daemon_version_disk.as_deref(), Some("0.3.0")),
            "the bundled version is already on disk — only the restart is left"
        );
        assert!(daemon_is_outdated(Some("0.2.0"), Some("flightdeckd 0.2.5"), Some("0.3.0")));
    }

    // ---- repair dispatch exhaustive (compile-time) ----

    /// Every [`RepairAction`], for the tests that must cover them all.
    const ALL_REPAIR_ACTIONS: [RepairAction; 10] = [
        RepairAction::ReuploadDaemon,
        RepairAction::RestartDaemon,
        RepairAction::InstallService,
        RepairAction::EnableLinger,
        RepairAction::MaskSleep,
        RepairAction::RunInit,
        RepairAction::InstallClaude,
        RepairAction::SignInClaude,
        RepairAction::ProvisionPhone,
        RepairAction::ReconnectMac,
    ];

    #[test]
    fn repair_action_label_covers_every_variant() {
        for action in ALL_REPAIR_ACTIONS {
            assert!(!repair_action_label(action).is_empty(), "{action:?} has no label");
        }
    }

    // ---- repair_action_invalidates_daemon_version_cache (B_lifecycle-#6) ----

    #[test]
    fn the_init_token_cleanup_follows_only_a_repair_that_left_a_daemon_answering() {
        for action in [RepairAction::RestartDaemon, RepairAction::InstallService] {
            assert!(init_cleanup_follows_repair(action, Some(true)), "{action:?}");
            assert!(!init_cleanup_follows_repair(action, Some(false)), "{action:?}: not running");
            assert!(!init_cleanup_follows_repair(action, None), "{action:?}: status unreadable");
        }
        for action in [
            RepairAction::ReuploadDaemon,
            RepairAction::EnableLinger,
            RepairAction::MaskSleep,
            RepairAction::RunInit,
            RepairAction::InstallClaude,
            RepairAction::SignInClaude,
            RepairAction::ProvisionPhone,
            RepairAction::ReconnectMac,
        ] {
            assert!(!init_cleanup_follows_repair(action, Some(true)), "{action:?}");
        }
    }

    #[test]
    fn repair_action_invalidates_daemon_version_cache_covers_exactly_the_daemon_changing_kinds() {
        for action in
            [RepairAction::ReuploadDaemon, RepairAction::RestartDaemon, RepairAction::InstallService]
        {
            assert!(
                repair_action_invalidates_daemon_version_cache(action),
                "{action:?} can change the remote flightdeckd — the cache must be invalidated",
            );
        }
        for action in [
            RepairAction::EnableLinger,
            RepairAction::MaskSleep,
            RepairAction::RunInit,
            RepairAction::InstallClaude,
            RepairAction::SignInClaude,
            RepairAction::ProvisionPhone,
            RepairAction::ReconnectMac,
        ] {
            assert!(
                !repair_action_invalidates_daemon_version_cache(action),
                "{action:?} never touches flightdeckd itself — invalidating for it would just \
                 force a needless re-probe on the next spawn",
            );
        }
    }

    /// The effect, not just the gate: after a successful re-upload (a Mac's update
    /// included) the machine's cached `flightdeckd --version` is gone, so the next spawn
    /// re-probes and sees the new version's flags without an app relaunch; a repair that
    /// never touches flightdeckd leaves the cache alone.
    #[test]
    fn a_successful_reupload_drops_the_cached_daemon_version() {
        let (updated, untouched) = ("m-settle-reupload", "m-settle-linger");
        crate::ipc::commands::seed_daemon_version_cache_for_test(updated, Some("flightdeckd 0.2.0".into()));
        crate::ipc::commands::seed_daemon_version_cache_for_test(untouched, Some("flightdeckd 0.2.0".into()));

        settle_daemon_version_cache_after_repair(RepairAction::ReuploadDaemon, updated);
        settle_daemon_version_cache_after_repair(RepairAction::EnableLinger, untouched);

        assert!(!crate::ipc::commands::daemon_version_cache_contains(updated), "a re-upload must drop the stale version");
        assert!(crate::ipc::commands::daemon_version_cache_contains(untouched), "linger never touches flightdeckd");
        crate::ipc::commands::invalidate_daemon_version_cache(untouched);
    }

    // ---- pipeline state machine (fake steps) ----

    fn stored_request() -> StoredBootstrapRequest {
        StoredBootstrapRequest {
            label: "l".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            mask_sleep: false,
            confirmed_host_key: None,
        }
    }

    #[tokio::test]
    async fn run_steps_ok_all_the_way_through() {
        let steps = vec![
            PipelineStep::new(StepId::InstallKey, || async { StepOutcome::Ok(None) }),
            PipelineStep::new(StepId::Probe, || async { StepOutcome::Skipped(Some("already probed".into())) }),
        ];
        let mut seen = Vec::new();
        let (states, needs_input) = run_steps(steps, &mut |s| seen.push(s.to_vec())).await;
        assert_eq!(needs_input, None);
        assert_eq!(states[0].status, StepStatus::Ok);
        assert_eq!(states[1].status, StepStatus::Skipped);
        assert!(seen.len() >= 4, "on_progress must fire at least once per transition");
    }

    #[tokio::test]
    async fn run_steps_failed_stops_the_run_with_no_needs_input() {
        let ran_third = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran_third.clone();
        let steps = vec![
            PipelineStep::new(StepId::InstallKey, || async { StepOutcome::Ok(None) }),
            PipelineStep::new(StepId::Probe, || async { StepOutcome::Failed("boom".into()) }),
            PipelineStep::new(StepId::UploadDaemon, move || async move {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                StepOutcome::Ok(None)
            }),
        ];
        let (states, needs_input) = run_steps(steps, &mut |_| {}).await;
        assert_eq!(needs_input, None);
        assert_eq!(states[1].status, StepStatus::Failed);
        assert_eq!(states[1].detail.as_deref(), Some("boom"));
        assert!(!ran_third.load(std::sync::atomic::Ordering::SeqCst), "a step after a failure must never run");
    }

    #[tokio::test]
    async fn run_steps_needs_input_continue_does_not_stop_the_run() {
        let steps = vec![
            PipelineStep::new(StepId::ClaudeAuth, || async { StepOutcome::NeedsInputContinue("Needs Claude sign-in".into()) }),
            PipelineStep::new(StepId::AddMachine, || async { StepOutcome::Ok(None) }),
        ];
        let (states, needs_input) = run_steps(steps, &mut |_| {}).await;
        assert_eq!(needs_input, None, "a non-blocking needs_input step must not pause the whole run");
        assert_eq!(states[0].status, StepStatus::NeedsInput);
        assert_eq!(states[1].status, StepStatus::Ok, "the step AFTER a non-blocking needs_input must still run");
    }

    #[tokio::test]
    async fn pipeline_needs_input_blocking_pauses_then_resume_converges() {
        let sessions = BootstrapSessions::new();
        let attempt = Arc::new(std::sync::atomic::AtomicU32::new(0));

        let make_steps = |attempt: Arc<std::sync::atomic::AtomicU32>| {
            vec![
                PipelineStep::new(StepId::InstallKey, || async { StepOutcome::Ok(None) }),
                PipelineStep::new(StepId::EscalatePersistence, move || async move {
                    if attempt.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        StepOutcome::NeedsInputBlocking("sudo password needed".into())
                    } else {
                        StepOutcome::Ok(None)
                    }
                }),
                PipelineStep::new(StepId::RunInit, || async { StepOutcome::Ok(None) }),
            ]
        };

        let (states, needs_input) = drive_and_register(
            &sessions,
            "s1".to_string(),
            stored_request(),
            None,
            "m1".to_string(),
            Some("m1".to_string()),
            make_steps(attempt.clone()),
            |_| {},
        )
        .await;
        assert_eq!(needs_input, Some(StepId::EscalatePersistence));
        assert_eq!(states[1].status, StepStatus::NeedsInput);
        // Every step is still LISTED (a UI needs to show what's left), but nothing
        // after the blocking one has actually RUN yet.
        assert_eq!(states.len(), 3);
        assert_eq!(states[2].status, StepStatus::Pending, "a step after a blocking pause must never run");

        // Still paused/resumable.
        assert!(sessions.resume("s1", None).await.is_ok());

        // Resume with a password now supplied — the SAME (idempotent) steps converge.
        let (states2, needs_input2) = drive_and_register(
            &sessions,
            "s1".to_string(),
            stored_request(),
            Some(SecretString::new("pw".to_string())),
            "m1".to_string(),
            Some("m1".to_string()),
            make_steps(attempt.clone()),
            |_| {},
        )
        .await;
        assert_eq!(needs_input2, None);
        assert!(states2.iter().all(|s| s.status == StepStatus::Ok), "a re-run must converge: {states2:?}");

        // Terminal — the session must be gone.
        assert!(sessions.resume("s1", None).await.is_err(), "a finished session must no longer be resumable");
    }

    #[tokio::test]
    async fn cancel_drops_the_sudo_password() {
        let sessions = BootstrapSessions::new();
        sessions
            .start(
                "s1".to_string(),
                stored_request(),
                Some(SecretString::new("super-secret-pw".to_string())),
                "m1".to_string(),
                Some("m1".to_string()),
            )
            .await;
        sessions.cancel("s1").await;
        assert!(
            sessions.resume("s1", None).await.is_err(),
            "cancel must drop the whole session — password included"
        );
    }

    #[tokio::test]
    async fn cancel_returns_the_paused_sessions_lock_key() {
        let sessions = BootstrapSessions::new();
        sessions.start("s1".to_string(), stored_request(), None, "m1".to_string(), Some("m1".to_string())).await;
        assert_eq!(
            sessions.cancel("s1").await,
            Some("m1".to_string()),
            "cancel must hand back the lock_key a paused run left claimed, so the caller can release it",
        );
        // Already gone — a second cancel of the same id finds nothing left to release.
        assert_eq!(sessions.cancel("s1").await, None);
    }

    // ---- resolve_resume_machine (B_lifecycle-#8) ----

    // ---- the install-key step's host-key gate, without a password too (audit
    // sec-hostkey#4) ----

    use connect::first_contact_fake::{FirstContactSsh, FIRST_CONTACT_BLOB, FIRST_CONTACT_FP};

    fn first_contact_target() -> connect::BootstrapTarget {
        connect::BootstrapTarget { host: "203.0.113.9".into(), port: 22, user: "u".into() }
    }

    /// The legacy-ticket / no-password run used to skip the M12 gate: its keyed `true`
    /// round trip pinned whatever key answered (`accept-new`), so every secret a later
    /// step sends (sudo password, Claude sign-in code, phone tokens) went to a key the
    /// user never saw. Now nothing keyed is spawned and nothing is pinned until the user
    /// confirms the fingerprint.
    #[tokio::test]
    async fn install_key_without_a_password_still_refuses_an_unconfirmed_first_contact() {
        let fake = FirstContactSsh::install();
        let ctx = Arc::new(Mutex::new(PipelineCtx::default()));
        let (outcome, announced) = install_key_core(
            &first_contact_target(),
            &fake.known_hosts(),
            &fake.dir.join("ssh_keys"),
            "server",
            None,
            None,
            false,
            &ctx,
        )
        .await;
        match outcome {
            StepOutcome::Failed(reason) => {
                assert!(reason.contains(FIRST_CONTACT_FP), "the fingerprint to check is named: {reason}");
                assert!(reason.contains("has not been confirmed"), "{reason}");
            }
            other => panic!("an unconfirmed first contact must stop the step: {other:?}"),
        }
        assert!(announced.is_none());
        assert_eq!(fake.calls(), vec!["SCAN".to_string()], "no keyed connection before the user confirms");
        assert!(!std::path::Path::new(&fake.known_hosts()).exists(), "nothing pinned");
        assert!(ctx.lock().await.identity_file.is_none());
    }

    /// Confirmed: the key the user checked is pinned BEFORE the first keyed connection,
    /// so that one checks strictly against it instead of pinning whatever answers.
    #[tokio::test]
    async fn install_key_without_a_password_pins_the_confirmed_key_before_any_keyed_ssh() {
        let fake = FirstContactSsh::install();
        let ctx = Arc::new(Mutex::new(PipelineCtx::default()));
        let (outcome, _) = install_key_core(
            &first_contact_target(),
            &fake.known_hosts(),
            &fake.dir.join("ssh_keys"),
            "server",
            None,
            Some(FIRST_CONTACT_FP),
            false,
            &ctx,
        )
        .await;
        // The fake refuses every key: the step then asks for the login password.
        assert!(matches!(outcome, StepOutcome::Failed(ref r) if r.contains("login password")), "{outcome:?}");
        let calls = fake.calls();
        assert_eq!(calls.first().map(String::as_str), Some("SCAN"), "{calls:?}");
        assert!(calls.iter().skip(1).all(|c| c == "KEYED"), "{calls:?}");
        let pinned = std::fs::read_to_string(fake.known_hosts()).unwrap();
        assert!(pinned.contains(FIRST_CONTACT_BLOB), "{pinned}");
    }

    /// A paired server's saved key needs no confirmation (a re-run of the wizard on it).
    #[tokio::test]
    async fn install_key_without_a_password_goes_on_for_a_paired_servers_saved_key() {
        let fake = FirstContactSsh::install();
        std::fs::write(fake.known_hosts(), format!("203.0.113.9 ssh-ed25519 {FIRST_CONTACT_BLOB}\n")).unwrap();
        let ctx = Arc::new(Mutex::new(PipelineCtx::default()));
        let (outcome, _) = install_key_core(
            &first_contact_target(),
            &fake.known_hosts(),
            &fake.dir.join("ssh_keys"),
            "server",
            None,
            None,
            true,
            &ctx,
        )
        .await;
        assert!(matches!(outcome, StepOutcome::Failed(ref r) if r.contains("login password")), "{outcome:?}");
        assert!(fake.calls().iter().any(|c| c == "KEYED"), "{:?}", fake.calls());
    }

    /// A resumed run carries the fingerprint its first call confirmed: the resumed
    /// install-key step re-checks the (now pinned, still unpaired) key against it.
    #[tokio::test]
    async fn a_paused_session_resumes_with_the_host_key_its_first_call_confirmed() {
        let sessions = BootstrapSessions::default();
        let mut req = stored_request();
        req.confirmed_host_key = Some(FIRST_CONTACT_FP.to_string());
        sessions.start("s1".into(), req, None, "lock".into(), None).await;
        let (resumed, ..) = sessions.resume("s1", None).await.unwrap();
        assert_eq!(resumed.confirmed_host_key.as_deref(), Some(FIRST_CONTACT_FP));
    }

    fn machine_record(id: &str, host: &str) -> MachineRecord {
        MachineRecord {
            id: id.to_string(),
            label: "l".into(),
            host: host.to_string(),
            port: 22,
            user: "u".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    #[test]
    fn resolve_resume_machine_by_id_survives_a_host_rotation_between_pause_and_resume() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine_record("m1", "old-host.example.com")).unwrap();

        // The session paused while `req.host` was still "old-host.example.com" — then,
        // while it sat paused, A6's live address rotation rewrote the SAME row's `host`
        // column (`Store::set_machine_preferred_host`, e.g. a Tailscale IP change).
        store.set_machine_preferred_host("m1", "new-host.example.com").unwrap();

        // The frozen (host, port, user) this session was captured under no longer
        // matches ANY row — an address-only lookup would find nothing.
        assert!(
            store.machine_by_address("old-host.example.com", 22, "u").unwrap().is_none(),
            "sanity: the rotation must have actually broken the address match",
        );

        // But resolving BY THE RECORDED ID still finds it, under its NEW host.
        let resolved =
            resolve_resume_machine(&store, Some("m1"), "old-host.example.com", 22, "u").unwrap();
        assert_eq!(resolved.map(|m| m.host), Some("new-host.example.com".to_string()));
    }

    // ---- sync_resume_request_to_machine (residual defect A8/R2) ----

    #[test]
    fn sync_resume_request_to_machine_adopts_the_rotated_hosts_host_port_and_user() {
        let mut req = stored_request(); // host "h", port 22, user "u"
        let rotated = MachineRecord {
            host: "new-host.example.com".into(),
            port: 2222,
            user: "rotated-user".into(),
            ..machine_record("m1", "unused")
        };
        sync_resume_request_to_machine(&mut req, Some(&rotated));
        assert_eq!(req.host, "new-host.example.com");
        assert_eq!(req.port, 2222);
        assert_eq!(req.user, "rotated-user");
    }

    #[test]
    fn sync_resume_request_to_machine_leaves_the_frozen_request_alone_when_no_machine_is_found() {
        let mut req = stored_request();
        let before = (req.host.clone(), req.port, req.user.clone());
        sync_resume_request_to_machine(&mut req, None);
        assert_eq!((req.host, req.port, req.user), before, "a genuinely first-contact host has nothing fresher to adopt");
    }

    /// End-to-end (minus the actual ssh calls, which need a `tauri::AppHandle` this
    /// crate has no unit-test harness for) through [`resolve_and_sync_resume_machine`]
    /// itself — the EXACT single call `bootstrap_resume` makes, not the two helpers it
    /// wraps exercised separately (test-honesty residual defect, CRM `1abfc028`: a
    /// counter-verification found the previous version of this test called
    /// `resolve_resume_machine` then `sync_resume_request_to_machine` by hand, so
    /// deleting `bootstrap_resume`'s own wiring call to the latter left this test, and
    /// the rest of the suite, green). Asserts the resumed `req` targets the ROTATED
    /// host, and that the row itself is still the rotated one afterward (nothing here
    /// writes it back).
    #[test]
    fn resume_after_a_host_rotation_targets_the_rotated_host_not_the_frozen_one() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine_record("m1", "old-host.example.com")).unwrap();
        store.set_machine_preferred_host("m1", "new-host.example.com").unwrap();

        let mut req = stored_request(); // frozen at pause time: host "h", not the real one
        req.host = "old-host.example.com".to_string();
        let existing_machine = resolve_and_sync_resume_machine(&store, Some("m1"), &mut req).unwrap();

        assert_eq!(req.host, "new-host.example.com", "the resumed pipeline must dial the rotated host, not the frozen one");
        assert_eq!(existing_machine.map(|m| m.host), Some("new-host.example.com".to_string()));
        assert_eq!(
            store.machine_by_id("m1").unwrap().unwrap().host,
            "new-host.example.com",
            "the row itself must still be the rotated host"
        );
    }

    #[test]
    fn resolve_resume_machine_falls_back_to_address_only_when_no_id_was_recorded() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine_record("m1", "h")).unwrap();

        let resolved = resolve_resume_machine(&store, None, "h", 22, "u").unwrap();
        assert_eq!(resolved.map(|m| m.id), Some("m1".to_string()));

        // A host this address lookup doesn't match, with no id to fall back on: not found.
        assert!(resolve_resume_machine(&store, None, "unknown-host", 22, "u").unwrap().is_none());
    }

    #[test]
    fn resolve_resume_machine_with_a_recorded_id_that_no_longer_resolves_never_falls_back_to_address() {
        let store = Store::open_in_memory().unwrap();
        // A different machine now happens to occupy the SAME address the removed one
        // (id "m1", never persisted here) used to have — falling back to the address
        // lookup would silently latch onto this UNRELATED machine instead.
        store.upsert_machine(&machine_record("m2", "h")).unwrap();

        let resolved = resolve_resume_machine(&store, Some("m1"), "h", 22, "u").unwrap();
        assert_eq!(resolved, None, "an id that doesn't resolve must never fall back to guessing by address");
    }

    // ---- ServerLocks / ServerLockGuard (B_lifecycle-#7) ----

    #[test]
    fn server_lock_key_prefers_the_machine_id_when_known() {
        assert_eq!(server_lock_key(Some("m1"), "h", 22, "u"), "m1");
        assert_eq!(server_lock_key(None, "h", 22, "u"), "h:22:u");
        // A different port or user is a genuinely different key even with the same host —
        // never folded together (a different login is a different machine).
        assert_ne!(server_lock_key(None, "h", 22, "u"), server_lock_key(None, "h", 2222, "u"));
        assert_ne!(server_lock_key(None, "h", 22, "u"), server_lock_key(None, "h", 22, "other"));
    }

    #[test]
    fn server_busy_error_names_the_running_operation() {
        let msg = server_busy_error("Re-upload the flightdeckd binary".to_string());
        assert!(msg.contains("Re-upload the flightdeckd binary"), "must name what's running: {msg}");
    }

    #[test]
    fn server_locks_claim_twice_is_rejected_with_the_running_ops_label() {
        let locks = ServerLocks::new();
        assert!(locks.claim("m1", "Add a server").is_ok());
        let err = locks.claim("m1", "Repair: restart").unwrap_err();
        assert_eq!(err, "Add a server", "the SECOND claim must fail — never silently wait — and name the FIRST op");
        // A DIFFERENT key is unaffected — this is per-server, not a global lock.
        assert!(locks.claim("m2", "Add a server").is_ok());
    }

    #[test]
    fn server_locks_release_frees_the_key_for_a_fresh_claim() {
        let locks = ServerLocks::new();
        locks.claim("m1", "Add a server").unwrap();
        locks.release("m1");
        assert!(locks.claim("m1", "Repair: restart").is_ok(), "release must actually free the key");
    }

    #[test]
    fn server_lock_guard_releases_on_drop() {
        let locks = Arc::new(ServerLocks::new());
        {
            let _guard = ServerLockGuard::acquire(&locks, "m1".to_string(), "Add a server").unwrap();
            assert!(
                ServerLockGuard::acquire(&locks, "m1".to_string(), "Add a server").is_err(),
                "held while the guard is alive"
            );
        } // guard dropped here
        assert!(
            ServerLockGuard::acquire(&locks, "m1".to_string(), "Repair: restart").is_ok(),
            "Drop must release the claim — no exit path (including an early return via `?`, or the \
             owning task being dropped/cancelled) may leave it held forever",
        );
    }

    #[test]
    fn server_lock_guard_into_forgotten_key_keeps_the_claim_held_past_the_guards_own_lifetime() {
        let locks = Arc::new(ServerLocks::new());
        let guard = ServerLockGuard::acquire(&locks, "m1".to_string(), "Add a server").unwrap();
        let key = guard.into_forgotten_key(); // simulates a run that PAUSED mid-pipeline
        assert_eq!(key, "m1");
        // Still claimed — a concurrent bootstrap_server/machine_repair against the same
        // host while this one sits paused must still be refused.
        assert!(
            ServerLockGuard::acquire(&locks, "m1".to_string(), "Repair: restart").is_err(),
            "into_forgotten_key must NOT release — the paused session still owns this claim",
        );
        // Only an explicit release (bootstrap_resume's own completion, or
        // bootstrap_cancel) frees it.
        locks.release(&key);
        assert!(ServerLockGuard::acquire(&locks, "m1".to_string(), "Repair: restart").is_ok());
    }

    #[test]
    fn server_lock_guard_adopt_does_not_re_claim_and_still_releases_on_drop() {
        let locks = Arc::new(ServerLocks::new());
        // Simulate a paused run's claim (as `into_forgotten_key` would leave it).
        locks.claim("m1", "Add a server").unwrap();
        {
            // bootstrap_resume picking the paused run back up — must NOT try to claim
            // again (it would collide with its own still-held lock) …
            let _resumed = ServerLockGuard::adopt(&locks, "m1".to_string());
        } // … and dropping the adopted guard (the resumed run finished) releases it.
        assert!(
            ServerLockGuard::acquire(&locks, "m1".to_string(), "Repair: restart").is_ok(),
            "adopt's guard must release on drop exactly like acquire's",
        );
    }

    // ---- password never leaks into a session's own Debug ----

    #[test]
    fn stored_session_debug_never_contains_the_sudo_password() {
        let session = StoredSession {
            request: stored_request(),
            sudo_password: Some(SecretString::new("super-secret-sudo-password".to_string())),
            lock_key: "m1".to_string(),
            machine_id: Some("m1".to_string()),
        };
        let debug = format!("{session:?}");
        assert!(!debug.contains("super-secret-sudo-password"), "debug leaked the password: {debug}");
        assert!(debug.contains("redacted"), "debug should show SecretString's own redaction: {debug}");
    }

    /// [`scrub_password`] — the pure helper [`run_sudo`]'s own wrong-password branch
    /// runs a captured sudo error through before it can ever become a
    /// [`BootstrapError`] — removes every literal occurrence, mirroring
    /// `askpass::classify_output`'s own scrub for the same reason.
    #[test]
    fn scrub_password_removes_every_literal_occurrence() {
        const SECRET: &str = "sUp3r-s3cr3t-sudo-p4ssw0rd-9f3c";
        let stderr = format!(
            "[sudo] password for u: \nSorry, try again.\n[sudo] password for u: {SECRET}\n\
             sudo: 1 incorrect password attempt"
        );
        let scrubbed = scrub_password(&stderr, &SecretString::new(SECRET.to_string()));
        assert!(!scrubbed.contains(SECRET), "scrub left the password in: {scrubbed}");
        assert!(scrubbed.contains("[redacted]"));

        // Guarded on non-empty — must never turn into a replace-everything mess.
        assert_eq!(scrub_password("unchanged", &SecretString::new(String::new())), "unchanged");
    }

    /// Crate-wide discipline mirrored from `askpass::
    /// askpass_errors_never_contain_the_test_password` (see this module's own doc,
    /// and the `tosse/mod.rs` precedent it in turn mirrors) — every wire-facing shape
    /// a bootstrap run can hand a caller ([`BootstrapReport`], the
    /// [`crate::ipc::events::BootstrapProgressEvent`] steps it's built from) must
    /// never carry a real password, even when a step's own detail text is built from
    /// remote output that happened to mention it. Exercises [`scrub_password`] — the
    /// SAME function [`run_sudo`]'s wrong-password branch calls — against a step
    /// outcome shaped exactly like that branch's own `Err(BootstrapError::Other(_))`,
    /// then serializes the full [`BootstrapReport`] (and the wire `StepState`s a live
    /// run actually emits) to JSON and asserts the secret is gone from both.
    #[tokio::test]
    async fn bootstrap_report_and_progress_event_json_never_contain_the_test_sudo_password() {
        const SECRET: &str = "sUp3r-s3cr3t-sudo-p4ssw0rd-9f3c";
        let raw_sudo_stderr = format!("[sudo] password for u: {SECRET}\nSorry, try again.");
        let scrubbed_detail = scrub_password(&raw_sudo_stderr, &SecretString::new(SECRET.to_string()));
        assert!(!scrubbed_detail.contains(SECRET), "the scrub itself must remove the secret before this test proceeds");

        let steps = vec![
            PipelineStep::new(StepId::InstallKey, || async { StepOutcome::Ok(None) }),
            PipelineStep::new(StepId::EscalatePersistence, move || async move { StepOutcome::Failed(scrubbed_detail) }),
        ];
        let (states, needs_input) = run_steps(steps, &mut |_| {}).await;

        let report = BootstrapReport {
            session_id: "s1".to_string(),
            host: "h".to_string(),
            steps: states.clone(),
            needs_input,
            machine_id: None,
            diagnosis: None,
        };
        let report_json = serde_json::to_string(&report).expect("BootstrapReport must serialize");
        assert!(!report_json.contains(SECRET), "BootstrapReport JSON leaked the sudo password: {report_json}");

        // The wire shape `emit_progress` actually sends on every transition.
        let event_steps: Vec<_> = states.iter().map(StepState::to_wire).collect();
        let event_json = serde_json::to_string(&event_steps).expect("BootstrapProgressStep must serialize");
        assert!(!event_json.contains(SECRET), "BootstrapProgressEvent JSON leaked the sudo password: {event_json}");
    }

    // ========================================================================
    // Live fixture tests — need Docker (`colima start`) + the in-repo `flightdeckd`
    // crate's live fixtures. `cargo test --lib -- --ignored --nocapture`.
    //
    // [`diagnose`] takes a plain `&MachineRecord` (no `tauri::AppHandle`), so it is
    // directly live-testable here. The full pipeline (`bootstrap_server`) is NOT —
    // every step needs an `AppHandle` (for `Store` state / the app data dir), and this
    // crate has no harness for constructing one outside a running app (consistent with
    // EVERY other AppHandle-dependent command in this crate: each one's live tests
    // already target its lower, AppHandle-free "pure I/O" function instead — e.g.
    // `install_key`/`upload_daemon_from_path`/`run_init` above — never the
    // `#[tauri::command]` wrapper itself). Recorded under `deviations_from_brief`.
    // ========================================================================
    mod live {
        use super::*;
        use std::path::PathBuf;

        /// Mirrors `server_setup.rs`'s own lock of the same name/reasoning — kept as a
        /// SEPARATE static (not shared) because neither module has a place to put
        /// shared test-only infra today; see that module's own doc.
        static LIVE_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        /// Locates the `flightdeckd` crate inside THIS repo — same helper as
        /// `connect.rs` / `server_setup.rs` / `install.rs` (the crate was imported
        /// from `flightdeck-server`, see `flightdeckd/docs/MONOREPO-MOVE.md`).
        /// `FLIGHTDECKD_CRATE_DIR` overrides the search entirely.
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

        struct ThrowawayKey {
            dir: PathBuf,
            private: PathBuf,
            public: String,
        }
        impl ThrowawayKey {
            fn generate(tag: &str) -> Self {
                let dir = std::env::temp_dir().join(format!("flightdeck-b11-live-{tag}-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&dir).expect("scratch dir for the throwaway key");
                let private = dir.join("id_ed25519");
                let out = std::process::Command::new("ssh-keygen")
                    .args(["-t", "ed25519", "-f"])
                    .arg(&private)
                    .args(["-N", "", "-C", "flightdeck-b11-live-test"])
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

        async fn install_key_via_password(port: u16, user: &str, password: &str, key: &ThrowawayKey) {
            use crate::bootstrap::askpass::{bootstrap_ssh_command, run_with_password};
            let remote = format!(
                "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo {} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
                shq(&key.public)
            );
            let cmd = bootstrap_ssh_command(user, "127.0.0.1", port, None, None, &remote)
                .expect("a fixed literal test user/host must always validate");
            let out = run_with_password(cmd, password, None, Duration::from_secs(15))
                .await
                .expect("installing the throwaway key over the fixture's documented password must succeed");
            assert!(out.status.success(), "key install failed: {}", String::from_utf8_lossy(&out.stderr));
        }

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

        struct ScratchKnownHosts(PathBuf);
        impl ScratchKnownHosts {
            fn new(tag: &str) -> Self {
                let path =
                    std::env::temp_dir().join(format!("flightdeck-b11-known-hosts-{tag}-{}", uuid::Uuid::new_v4()));
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

        /// PROVES [`diagnose`] against fixture C — flightdeckd ALREADY installed as a
        /// root-owned system unit, `systemctl enable`d, and pre-initialized at image
        /// build time, but `claude` never installed on ANY fixture (see the
        /// `flightdeckd/live/bootstrap-fixtures` Dockerfile). This is the exact "real
        /// server" shape the brief calls out (mirrors josty-cc).
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the in-repo flightdeckd/live/bootstrap-fixtures"]
        async fn live_diagnose_fixture_c_reports_the_pre_installed_system_unit() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("c");
            let key = ThrowawayKey::generate("diagnose-c");
            install_key_via_password(FIXTURE_C_PORT, FIXTURE_C_USER, FIXTURE_C_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_C_PORT, FIXTURE_C_USER, &key);
            let kh = ScratchKnownHosts::new("diagnose-c");

            let d = diagnose(&machine, kh.path()).await;
            assert_eq!(d.installed_as, InstalledAs::System, "fixture C ships a root-owned system unit: {d:?}");
            assert_eq!(d.daemon_running, Some(true), "fixture C's unit is enabled --now: {d:?}");
            assert_eq!(d.claude_installed, Some(false), "no fixture ever has claude installed unless a test installs it: {d:?}");
            // (B14) Split from NeedsClaudeSignIn — missing claude is its OWN state now,
            // still never `Failed` (per the original brief this test cites).
            assert_eq!(
                d.state,
                DiagnosisState::NeedsClaudeInstall,
                "missing claude must read as needs-install, never Failed, per the brief: {d:?}"
            );
            assert_eq!(d.reboot_safe, Some(true), "a `systemctl enable`d system unit survives a reboot: {d:?}");
        }

        /// PROVES [`diagnose`] against fixture A — nothing installed at all (a fresh
        /// node) — reports `InstalledAs::None` and a `Failed` headline, never a false
        /// `Ready`/`NeedsClaudeSignIn` for a server that was never bootstrapped.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the in-repo flightdeckd/live/bootstrap-fixtures"]
        async fn live_diagnose_fixture_a_fresh_reports_nothing_installed() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let key = ThrowawayKey::generate("diagnose-a");
            install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
            let kh = ScratchKnownHosts::new("diagnose-a");

            let d = diagnose(&machine, kh.path()).await;
            assert_eq!(d.installed_as, InstalledAs::None, "a fresh fixture A has nothing installed: {d:?}");
            assert_eq!(
                d.state,
                DiagnosisState::Failed { reason: "flightdeckd is not installed".to_string() },
                "a fresh, never-bootstrapped server must never report Ready/NeedsClaudeSignIn: {d:?}"
            );
        }

        /// The real incident, end to end (CRM `c9bf1482`): this Mac's key removed
        /// from a real server's `authorized_keys` mid-life. Proves `diagnose()`
        /// classifies it as `KeyRefused` (never the old single fixed "could not
        /// reach the server") against the REAL `keyed_ssh_options`/
        /// `push_ssh_destination` transport a live conversation's own reconnect loop
        /// uses — then that `repair(ReconnectMac)`'s underlying pure I/O call
        /// (`connect::install_key`, exactly what that dispatch arm delegates to —
        /// `repair()` itself needs a `tauri::AppHandle` this crate has no live-test
        /// harness for, see this module's own doc above) recovers it, confirmed by
        /// a fresh `diagnose()` reading `reachable: true` again.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the in-repo flightdeckd/live/bootstrap-fixtures"]
        async fn live_diagnose_classifies_key_refused_then_reconnect_mac_recovers_it() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let key = ThrowawayKey::generate("key-refused");
            install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
            let kh = ScratchKnownHosts::new("key-refused");

            // Sanity: the freshly-installed key genuinely works before we ever touch it.
            let before = diagnose(&machine, kh.path()).await;
            assert!(before.reachable, "the freshly-installed key must work: {before:?}");
            assert_eq!(before.link_issue, None);

            // The real incident: an operator (or this same test, standing in for one)
            // removes this Mac's key from the server's `authorized_keys` — no sudo
            // needed over ssh, so `docker exec` (root inside the container) does it
            // directly, exactly like an admin editing the file by hand would.
            let wipe = std::process::Command::new("docker")
                .args(["exec", "fd-fixture-a", "sh", "-c", "> /home/deploy/.ssh/authorized_keys"])
                .output()
                .expect("docker exec must be available");
            assert!(
                wipe.status.success(),
                "wiping authorized_keys failed: {}",
                String::from_utf8_lossy(&wipe.stderr)
            );

            let after = diagnose(&machine, kh.path()).await;
            assert!(!after.reachable, "{after:?}");
            assert_eq!(after.link_issue, Some(SshLinkIssue::KeyRefused), "{after:?}");
            assert_eq!(
                after.state,
                DiagnosisState::Failed { reason: format!("this {MACHINE}'s saved key was refused") },
                "{after:?}",
            );

            // `RepairAction::ReconnectMac`'s own arm, exactly: re-install this Mac's
            // OWN saved public key over the fixture's documented login password
            // (the dispatch arm reads it off the sibling `.pub` file; this throwaway
            // key already carries its own public half in memory).
            let target = connect::BootstrapTarget {
                host: machine.host.clone(),
                port: machine.port,
                user: machine.user.clone(),
            };
            let outcome = connect::install_key(
                &target,
                FIXTURE_A_PASSWORD,
                key.private.to_string_lossy().as_ref(),
                &key.public,
                kh.path().unwrap_or_default(),
            )
            .await
            .expect("reconnecting this Mac over the fixture's real login password must succeed");
            assert_eq!(
                outcome,
                connect::KeyInstallOutcome::Installed,
                "authorized_keys was wiped, so re-installing must genuinely APPEND the key again: {outcome:?}",
            );

            let recovered = diagnose(&machine, kh.path()).await;
            assert!(recovered.reachable, "{recovered:?}");
            assert_eq!(recovered.link_issue, None, "{recovered:?}");
        }
    }
}
