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
//! Nine steps, always in this order: [`StepId::InstallKey`], [`StepId::Probe`],
//! [`StepId::UploadDaemon`], [`StepId::InstallService`],
//! [`StepId::EscalatePersistence`], [`StepId::RunInit`], [`StepId::ClaudeAuth`],
//! [`StepId::AddMachine`], [`StepId::Diagnose`]. Every step is IDEMPOTENT — re-running
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
//! discipline as [`super::connect::PROBE_SCRIPT`] / B8's `RESOLVE_DAEMON_TARGET_SCRIPT`
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
//! "Keychain item for mac_token" idea is deliberately NOT implemented.
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

use crate::bootstrap::askpass::{BootstrapError, SecretString};
use crate::bootstrap::{connect, install, server_setup};
use crate::ipc::commands::{
    invalidate_daemon_version_cache, persist_paired_machine, probe_candidates, resolve_daemon_bin_expr,
    run_ssh_on_machine, run_ssh_on_machine_stdin, shq, RemoteProbeResult,
};
use crate::store::{MachineRecord, Store};

/// Bounded timeout for a single ssh round trip this module makes OUTSIDE the
/// password/sudo flows (which already have their own, e.g. [`run_sudo`]'s 15s/30s) —
/// [`diagnose`], [`verify_key_works`], and the plain [`run_ssh_on_machine`] calls in
/// [`fetch_busy_conversations`]/[`run_plain`]. `ConnectTimeout=10` (baked into
/// [`crate::ipc::commands::keyed_ssh_options`]) only bounds the TCP/SSH HANDSHAKE, not
/// a remote shell that hangs after connecting (a stuck lock, a wedged `flightdeckd`) —
/// without this, `machine_diagnose`/the pipeline's own `Diagnose` step/the RESTART
/// RULE's busy check could hang the caller forever (B11 review finding).
const SSH_ROUND_TRIP_TIMEOUT: Duration = Duration::from_secs(20);

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
    UploadDaemon,
    InstallService,
    EscalatePersistence,
    RunInit,
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
    let mut cmd = crate::ipc::commands::keyed_ssh_options(target.port, Some(identity_file), Some(known_hosts));
    cmd.arg("-T").arg(format!("{}@{}", target.user, target.host)).arg("true");
    matches!(tokio::time::timeout(SSH_ROUND_TRIP_TIMEOUT, cmd.output()).await, Ok(Ok(out)) if out.status.success())
}

/// [`StepId::InstallKey`] — connect + install the app's dedicated key (B4/B7), with the
/// host-key fingerprint event folded in (see the module doc: it is a non-blocking
/// decision riding along this same step, not a separate checkpoint). Password path
/// ONLY when a keyed connection doesn't already work.
async fn step_install_key(
    app: &tauri::AppHandle,
    req: &StoredBootstrapRequest,
    password: Option<&SecretString>,
    ctx: &Arc<Mutex<PipelineCtx>>,
) -> StepOutcome {
    let Some(known_hosts) = known_hosts_path(app) else {
        return StepOutcome::Failed("could not resolve the app's data directory".to_string());
    };
    let target = connect::BootstrapTarget { host: req.host.clone(), port: req.port, user: req.user.clone() };

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
        if verify_key_works(&target, &known_identity, &known_hosts).await {
            return StepOutcome::Skipped(Some("the previously paired key already works".to_string()));
        }
    }

    let ssh_keys_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("ssh_keys"),
        Err(e) => return StepOutcome::Failed(format!("could not resolve the app's data directory: {e}")),
    };
    let key = match crate::ipc::commands::generate_or_reuse_pending_key(&ssh_keys_dir, &req.label).await {
        Ok(k) => k,
        Err(e) => return StepOutcome::Failed(e),
    };

    if verify_key_works(&target, &key.identity_file, &known_hosts).await {
        ctx.lock().await.identity_file = Some(key.identity_file.clone());
        return StepOutcome::Skipped(Some("the key is already installed".to_string()));
    }

    let Some(password) = password else {
        return StepOutcome::Failed(
            "this server needs its login password to install Flight Deck's key (first contact only)".to_string(),
        );
    };

    let known_before = connect::host_key_pinned(&known_hosts, &req.host, req.port).await;
    match connect::install_key(&target, password.expose(), &key.identity_file, &key.public_key, &known_hosts).await {
        Ok(outcome) => {
            if let Some(fingerprint) = connect::read_pinned_fingerprint(&known_hosts, &req.host, req.port).await {
                connect::emit_host_key_fingerprint(app, &req.host, req.port, &fingerprint, known_before);
            }
            ctx.lock().await.identity_file = Some(key.identity_file.clone());
            StepOutcome::Ok(Some(format!("{outcome:?}")))
        }
        Err(e) => StepOutcome::Failed(e.to_string()),
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
            let detail = format!("{probe:?}");
            ctx.lock().await.probe = Some(probe);
            StepOutcome::Ok(Some(detail))
        }
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
/// shape (see `flightdeckd/src/frames.rs::fd_status`) into a busy count. `None` on
/// anything that doesn't parse — never assumed zero.
fn count_busy_conversations(status_stdout: &str) -> Option<u32> {
    let v: serde_json::Value = serde_json::from_str(status_stdout.trim()).ok()?;
    let rows = v.get("conversations")?.as_array()?;
    Some(rows.iter().filter(|r| r.get("busy").and_then(serde_json::Value::as_bool) == Some(true)).count() as u32)
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
/// [`diagnose`] call this function already makes for `installed_as`).
async fn restart_daemon(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    sudo_password: Option<&SecretString>,
) -> Result<(), BootstrapError> {
    let diagnosis = diagnose(machine, known_hosts).await;
    if diagnosis.busy_conversations != Some(0) {
        return Err(BootstrapError::DaemonBusy(diagnosis.busy_conversations));
    }
    match diagnosis.installed_as {
        InstalledAs::System if machine.user == "root" => {
            run_plain(machine, known_hosts, "systemctl restart flightdeckd").await
        }
        InstalledAs::System => run_sudo(machine, known_hosts, sudo_password, "systemctl restart flightdeckd").await,
        InstalledAs::User => {
            run_plain(
                machine,
                known_hosts,
                "export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart flightdeckd",
            )
            .await
        }
        InstalledAs::Detached => {
            let bin = resolve_daemon_bin_expr("flightdeckd");
            let script = format!(
                "pkill -u \"$(id -un)\" -f 'flightdeckd run' 2>/dev/null; sleep 1; \
                 setsid nohup {bin} run >/dev/null 2>&1 </dev/null &"
            );
            run_plain(machine, known_hosts, &script).await
        }
        InstalledAs::None | InstalledAs::Unknown => Err(BootstrapError::Other(
            "could not determine how flightdeckd is installed on this server, so it cannot be restarted \
             automatically"
                .to_string(),
        )),
    }
}

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
    let outcome = match install::upload_daemon(app, &machine, &arch, Some(&known_hosts)).await {
        Ok(o) => o,
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
/// ([`StepId::Probe`] succeeded) and "claude missing" is ALREADY handled as its own,
/// separate, non-blocking [`StepId::ClaudeAuth`] step — gating pairing on it again
/// here would just re-fail what that step deliberately lets through.
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
fn build_pipeline(
    app: tauri::AppHandle,
    req: StoredBootstrapRequest,
    password: Option<SecretString>,
    sudo_password: Option<SecretString>,
    ctx: Arc<Mutex<PipelineCtx>>,
) -> Vec<PipelineStep> {
    vec![
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::InstallKey, move || async move {
                step_install_key(&app, &req, password.as_ref(), &ctx).await
            })
        },
        {
            let (app, req, ctx) = (app.clone(), req.clone(), ctx.clone());
            PipelineStep::new(StepId::Probe, move || async move { step_probe(&app, &req, &ctx).await })
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
            PipelineStep::new(StepId::RunInit, move || async move { step_run_init(&app, &req, &ctx).await })
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
    ]
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
async fn run_pipeline_and_register(
    app: &tauri::AppHandle,
    sessions: &BootstrapSessions,
    session_id: String,
    req: StoredBootstrapRequest,
    password: Option<SecretString>,
    sudo_password: Option<SecretString>,
    existing_machine: Option<MachineRecord>,
    lock_guard: ServerLockGuard,
) -> BootstrapReport {
    let ctx = Arc::new(Mutex::new(PipelineCtx {
        identity_file: existing_machine.as_ref().and_then(|m| m.identity_file.clone()),
        machine_id: existing_machine.as_ref().map(|m| m.id.clone()),
        ..Default::default()
    }));
    let steps = build_pipeline(app.clone(), req.clone(), password, sudo_password.clone(), ctx.clone());
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
    let final_ctx = ctx.lock().await;
    // B_lifecycle-#6 review finding: a completed run (`needs_input: None` — paused
    // sessions haven't finished anything yet) may have uploaded/upgraded this
    // machine's `flightdeckd` (`step_upload_daemon`'s own RESTART RULE), so drop
    // whatever `crate::ipc::commands::DAEMON_VERSION_CACHE` still holds for it from an
    // earlier spawn THIS SAME APP RUN — same reasoning as `repair`'s own invalidation,
    // for the guided-install path instead of the Repair buttons. Harmless (a plain
    // cache miss) when nothing was ever cached, or nothing changed.
    if needs_input.is_none() {
        if let Some(id) = &final_ctx.machine_id {
            invalidate_daemon_version_cache(id);
        }
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
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_server(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, Arc<BootstrapSessions>>,
    locks: tauri::State<'_, Arc<ServerLocks>>,
    label: String,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    mask_sleep: bool,
    sudo_password: Option<String>,
) -> Result<BootstrapReport, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let req = StoredBootstrapRequest { label, host, port, user, mask_sleep };
    let password = password.map(SecretString::new);
    let sudo_password = sudo_password.map(SecretString::new);
    let existing_machine =
        app.state::<Store>().machine_by_address(&req.host, req.port, &req.user).map_err(|e| e.to_string())?;
    let lock_key = server_lock_key(existing_machine.as_ref().map(|m| m.id.as_str()), &req.host, req.port, &req.user);
    let guard = ServerLockGuard::acquire(&locks, lock_key, "Add a server").map_err(server_busy_error)?;
    Ok(run_pipeline_and_register(&app, &sessions, session_id, req, password, sudo_password, existing_machine, guard).await)
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
/// simply collide with this very session's own still-held lock.
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
    let (req, resolved_password, lock_key, machine_id) = sessions.resume(&session_id, sudo_password).await?;
    let existing_machine =
        resolve_resume_machine(&app.state::<Store>(), machine_id.as_deref(), &req.host, req.port, &req.user)?;
    let guard = ServerLockGuard::adopt(&locks, lock_key);
    Ok(run_pipeline_and_register(&app, &sessions, session_id, req, None, resolved_password, existing_machine, guard).await)
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
    Detached,
    None,
    Unknown,
}

/// The single headline verdict [`collapse_state`] reduces every independent fact to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiagnosisState {
    Ready,
    NeedsClaudeSignIn,
    RunningNotRebootSafe,
    Failed { reason: String },
}

/// One `machine_diagnose` result — every field besides [`Self::state`]/
/// [`Self::restart_pending`] is TRI-STATE (`Option<...>`): a missing/garbled marker in
/// [`diagnose`]'s own accumulating script degrades to `None` ("unknown"), never a
/// false `Some(false)` — see [`parse_diagnosis_fields`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ServerDiagnosis {
    pub state: DiagnosisState,
    pub installed_as: InstalledAs,
    pub daemon_running: Option<bool>,
    pub daemon_version_disk: Option<String>,
    pub daemon_version_running: Option<String>,
    /// `true` only when BOTH versions are known and differ — an upload landed new
    /// bytes that the currently-running process hasn't picked up yet.
    pub restart_pending: bool,
    pub reboot_safe: Option<bool>,
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
    pub sleep_masked: Option<bool>,
    pub claude_installed: Option<bool>,
    pub claude_logged_in: Option<bool>,
    pub claude_email: Option<String>,
    pub tailscale_name: Option<String>,
    pub last_boot: Option<String>,
    pub busy_conversations: Option<u32>,
    /// (B2/B3) This Mac's OWN bundled `flightdeckd` version (from [`install::
    /// bundled_daemon_manifest`]) — NEVER read off the remote server, so it is folded in
    /// by [`with_bundled_version`] AFTER [`diagnose`]'s ssh round trip, not inside
    /// [`parse_diagnosis_fields`] (which has no [`tauri::AppHandle`] to read it from —
    /// see the module doc's "`diagnose` / `repair`" section). `None` when this build has
    /// no daemon bundled at all (a fresh clone, no `pnpm daemon:build` ever run).
    pub bundled_daemon_version: Option<String>,
    /// `true` only when BOTH [`Self::daemon_version_running`] and
    /// [`Self::bundled_daemon_version`] are known and the bundled one is strictly newer
    /// — the server needs [`RepairAction::ReuploadDaemon`] (then, once
    /// [`Self::restart_pending`] shows it, [`RepairAction::RestartDaemon`]) to catch up.
    /// See [`daemon_is_outdated`].
    pub daemon_outdated: bool,
}

impl ServerDiagnosis {
    /// The whole-fields-unknown shape [`diagnose`] returns when the ssh round trip
    /// itself never even reached the server.
    fn unreachable() -> Self {
        Self {
            state: DiagnosisState::Failed { reason: "could not reach the server".to_string() },
            installed_as: InstalledAs::Unknown,
            daemon_running: None,
            daemon_version_disk: None,
            daemon_version_running: None,
            restart_pending: false,
            reboot_safe: None,
            linger: None,
            sleep_masked: None,
            claude_installed: None,
            claude_logged_in: None,
            claude_email: None,
            tailscale_name: None,
            last_boot: None,
            busy_conversations: None,
            bundled_daemon_version: None,
            daemon_outdated: false,
        }
    }
}

/// The static (non-interpolated) body of [`diagnose_script`] — everything after the
/// one line that resolves `$FLIGHTDECKD_BIN` (kept as a separate `format!` argument
/// rather than inlined, so this constant's own literal `{`/`}` — e.g. `awk
/// '{print $2}'` — never has to be escaped for `format!`). Never `exit`s early — same
/// accumulating discipline as [`super::connect::PROBE_SCRIPT`]: every check below runs
/// regardless of any earlier one's outcome.
const DIAGNOSE_SCRIPT_BODY: &str = r#"
if [ -f /etc/systemd/system/flightdeckd.service ]; then
    echo FLIGHTDECK_UNIT_SYSTEM:yes
else
    echo FLIGHTDECK_UNIT_SYSTEM:no
fi
if [ -f "$HOME/.config/systemd/user/flightdeckd.service" ]; then
    echo FLIGHTDECK_UNIT_USER:yes
else
    echo FLIGHTDECK_UNIT_USER:no
fi
if [ -n "$FLIGHTDECKD_BIN" ] && (command -v "$FLIGHTDECKD_BIN" >/dev/null 2>&1 || [ -x "$FLIGHTDECKD_BIN" ]); then
    echo FLIGHTDECK_BIN_PRESENT:yes
    echo "FLIGHTDECK_VERSION_DISK:$("$FLIGHTDECKD_BIN" --version 2>/dev/null)"
else
    echo FLIGHTDECK_BIN_PRESENT:no
    echo "FLIGHTDECK_VERSION_DISK:"
fi
STATUS_JSON=$("$FLIGHTDECKD_BIN" status 2>/dev/null)
echo "FLIGHTDECK_STATUS_JSON:$STATUS_JSON"
LINGER=$(loginctl show-user "$USER" -p Linger 2>/dev/null | sed -n 's/^Linger=//p')
echo "FLIGHTDECK_LINGER:$LINGER"
ENABLED_SYSTEM=$(systemctl is-enabled flightdeckd 2>/dev/null)
echo "FLIGHTDECK_ENABLED_SYSTEM:$ENABLED_SYSTEM"
ENABLED_USER=$(export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-enabled flightdeckd 2>/dev/null)
echo "FLIGHTDECK_ENABLED_USER:$ENABLED_USER"
SLEEP_MASKED=$(systemctl is-enabled sleep.target 2>/dev/null)
echo "FLIGHTDECK_SLEEP_MASKED:$SLEEP_MASKED"
if command -v claude >/dev/null 2>&1; then
    echo FLIGHTDECK_CLAUDE_INSTALLED:yes
    echo "FLIGHTDECK_CLAUDE_AUTH_JSON:$(claude auth status --json 2>/dev/null)"
else
    echo FLIGHTDECK_CLAUDE_INSTALLED:no
    echo "FLIGHTDECK_CLAUDE_AUTH_JSON:"
fi
if command -v tailscale >/dev/null 2>&1; then
    echo "FLIGHTDECK_TAILSCALE:$(tailscale status --self --peers=false 2>/dev/null | awk '{print $2}' | head -1)"
else
    echo "FLIGHTDECK_TAILSCALE:"
fi
echo "FLIGHTDECK_LAST_BOOT:$(uptime -s 2>/dev/null)"
"#;

fn diagnose_script() -> String {
    format!("FLIGHTDECKD_BIN={}\n{}", resolve_daemon_bin_expr("flightdeckd"), DIAGNOSE_SCRIPT_BODY)
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

/// Pure core of [`diagnose`] — every sub-probe read independently off `stdout`, never
/// gated on any other one succeeding. See the module doc.
fn parse_diagnosis_fields(stdout: &str) -> ServerDiagnosis {
    use crate::ipc::commands::{extract_marker, parse_yes_no_marker};

    let unit_system = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_UNIT_SYSTEM:"));
    let unit_user = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_UNIT_USER:"));
    let bin_present = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_BIN_PRESENT:"));

    let status_json = extract_marker(stdout, "FLIGHTDECK_STATUS_JSON:");
    let (daemon_running, daemon_version_running, busy_conversations) = match status_json.as_deref() {
        None => (None, None, None),
        Some("") => (Some(false), None, None),
        Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(v) if v.get("type").and_then(serde_json::Value::as_str) == Some("fd_status") => {
                let version = v.get("version").and_then(serde_json::Value::as_str).map(str::to_string);
                let busy = v.get("conversations").and_then(serde_json::Value::as_array).map(|rows| {
                    rows.iter().filter(|r| r.get("busy").and_then(serde_json::Value::as_bool) == Some(true)).count()
                        as u32
                });
                (Some(true), version, busy)
            }
            _ => (None, None, None),
        },
    };

    let installed_as = match (unit_system, unit_user) {
        (Some(true), _) => InstalledAs::System,
        (Some(false), Some(true)) => InstalledAs::User,
        (Some(false), Some(false)) => {
            if daemon_running == Some(true) || bin_present == Some(true) {
                InstalledAs::Detached
            } else if daemon_running == Some(false) && bin_present == Some(false) {
                InstalledAs::None
            } else {
                InstalledAs::Unknown
            }
        }
        _ => InstalledAs::Unknown,
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
        InstalledAs::None | InstalledAs::Unknown => None,
    };

    let sleep_masked = extract_marker(stdout, "FLIGHTDECK_SLEEP_MASKED:").map(|v| v == "masked");

    let claude_installed = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_CLAUDE_INSTALLED:"));
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

    let tailscale_name = extract_marker(stdout, "FLIGHTDECK_TAILSCALE:").filter(|s| !s.is_empty());
    let last_boot = extract_marker(stdout, "FLIGHTDECK_LAST_BOOT:").filter(|s| !s.is_empty());

    ServerDiagnosis {
        // Overwritten by `collapse_state` right after this returns — see `parse_diagnosis`.
        state: DiagnosisState::Ready,
        installed_as,
        daemon_running,
        daemon_version_disk,
        daemon_version_running,
        restart_pending,
        reboot_safe,
        linger,
        sleep_masked,
        claude_installed,
        claude_logged_in,
        claude_email,
        tailscale_name,
        last_boot,
        busy_conversations,
        // Folded in by `with_bundled_version` at the module's public boundaries
        // (`machine_diagnose`, `step_diagnose`, `repair`) — never a remote fact this
        // script's markers could carry, see `ServerDiagnosis::bundled_daemon_version`'s
        // own doc.
        bundled_daemon_version: None,
        daemon_outdated: false,
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
        InstalledAs::System | InstalledAs::User | InstalledAs::Detached => {}
    }
    match d.daemon_running {
        Some(false) => return DiagnosisState::Failed { reason: "flightdeckd is not running".to_string() },
        None => {
            return DiagnosisState::Failed {
                reason: "could not determine whether flightdeckd is running".to_string(),
            }
        }
        Some(true) => {}
    }
    // `claude` missing entirely, confirmed logged out, OR "could not confirm either
    // way" all land in the SAME bucket — never `Failed`: the live fixtures (which
    // never have `claude` installed AT ALL, only a fresh flightdeckd) must reach
    // `NeedsClaudeSignIn`, not fail the whole diagnosis over it (per the brief's own
    // explicit "the pipeline must END in NeedsClaudeSignIn there, not fail"). A
    // missing `claude` binary is, in practice, exactly as actionable as a present-but-
    // signed-out one: [`RepairAction::SignInClaude`] is the SAME next step either way
    // (and surfaces its own clear error if `claude` genuinely isn't installed) — the
    // brief's own `RepairAction` list has no separate "install claude" action.
    if d.claude_installed != Some(true) || d.claude_logged_in != Some(true) {
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
/// module doc.
async fn diagnose(machine: &MachineRecord, known_hosts: Option<&str>) -> ServerDiagnosis {
    let mut cmd = crate::ipc::commands::keyed_ssh_options(machine.port, machine.identity_file.as_deref(), known_hosts);
    cmd.arg("-T").arg(format!("{}@{}", machine.user, machine.host)).arg(diagnose_script());
    // A wedged remote shell (stuck lock, hung `flightdeckd`) must not hang this
    // forever — `ConnectTimeout=10` only bounds the handshake (B11 review finding).
    match tokio::time::timeout(SSH_ROUND_TRIP_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => parse_diagnosis(&String::from_utf8_lossy(&out.stdout), out.status.success()),
        Ok(Err(_)) | Err(_) => parse_diagnosis("", false),
    }
}

/// Pure: does the server's own RUNNING `flightdeckd` (never `daemon_version_disk` — a
/// binary already re-uploaded but not yet restarted into is exactly what
/// [`ServerDiagnosis::restart_pending`] already reports, not a second "outdated"
/// signal here) trail this Mac's BUNDLED version? `false` whenever either side is
/// unknown — never a false positive nagging to re-upload over a probe that simply
/// couldn't confirm a version.
fn daemon_is_outdated(running: Option<&str>, bundled: Option<&str>) -> bool {
    match (running, bundled) {
        (Some(r), Some(b)) => !crate::ipc::commands::version_at_least(r, b),
        _ => false,
    }
}

/// Folds this Mac's BUNDLED `flightdeckd` version into an already-computed
/// [`ServerDiagnosis`] — see [`ServerDiagnosis::bundled_daemon_version`]'s own doc for
/// why this happens here and not inside [`diagnose`] itself. Applied at every point a
/// diagnosis crosses out of this module ([`machine_diagnose`], [`step_diagnose`],
/// [`repair`]'s own final diagnosis) — never at [`restart_daemon`]'s internal
/// busy-conversations check, which has no [`tauri::AppHandle`] and no need for this
/// fact either.
fn with_bundled_version(app: &tauri::AppHandle, mut d: ServerDiagnosis) -> ServerDiagnosis {
    let bundled = install::bundled_daemon_manifest(app).ok().map(|m| m.version);
    d.daemon_outdated = daemon_is_outdated(d.daemon_version_running.as_deref(), bundled.as_deref());
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
    SignInClaude,
    ProvisionPhone,
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
        RepairAction::SignInClaude => "Start the Claude sign-in flow",
        RepairAction::ProvisionPhone => "Provision this Mac's phone token",
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

/// Dispatch + apply one [`RepairAction`] against an ALREADY-PAIRED `machine`, then
/// re-diagnose. `sudo_password` beyond the brief's own shorthand signature — see the
/// module doc.
async fn repair(
    app: &tauri::AppHandle,
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    action: RepairAction,
    sudo_password: Option<&SecretString>,
) -> Result<RepairOutcome, BootstrapError> {
    let identity_file = machine
        .identity_file
        .as_deref()
        .ok_or_else(|| BootstrapError::Other("this server has no dedicated key on record".to_string()))?;
    // `install::escalate_persistence` reports no idempotency signal of its own (`()`
    // whether it changed anything or the server was already in that state) — captured
    // BEFORE dispatch so `EnableLinger`/`MaskSleep`'s summaries below can say "already
    // enabled/masked" instead of a fixed string that claims a change even on a no-op
    // re-run (B11 review finding).
    let before = match action {
        RepairAction::EnableLinger | RepairAction::MaskSleep => Some(diagnose(machine, known_hosts).await),
        _ => None,
    };
    let summary = match action {
        RepairAction::ReuploadDaemon => {
            let target =
                connect::BootstrapTarget { host: machine.host.clone(), port: machine.port, user: machine.user.clone() };
            let probe = connect::probe(&target, identity_file, known_hosts.unwrap_or_default()).await?;
            let arch = probe
                .arch
                .ok_or_else(|| BootstrapError::Other("the server did not report its CPU architecture".to_string()))?;
            let outcome = install::upload_daemon(app, machine, &arch, known_hosts).await?;
            format!("{outcome:?}")
        }
        RepairAction::RestartDaemon => {
            restart_daemon(machine, known_hosts, sudo_password).await?;
            "restarted".to_string()
        }
        RepairAction::InstallService => {
            let target =
                connect::BootstrapTarget { host: machine.host.clone(), port: machine.port, user: machine.user.clone() };
            let probe = connect::probe(&target, identity_file, known_hosts.unwrap_or_default()).await?;
            let outcome = install::install_service(machine, &probe, known_hosts).await?;
            format!("{outcome:?}")
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
    if repair_action_invalidates_daemon_version_cache(action) {
        invalidate_daemon_version_cache(&machine.id);
    }
    let diagnosis = with_bundled_version(app, diagnose(machine, known_hosts).await);
    Ok(RepairOutcome { action, label: repair_action_label(action), summary, diagnosis })
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
            "FLIGHTDECK_STATUS_JSON:",
        );
        let d = parse_diagnosis_fields(&stdout);
        assert_eq!(d.daemon_running, Some(false));
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
            installed_as: InstalledAs::System,
            daemon_running: Some(true),
            daemon_version_disk: Some("0.2.0".into()),
            daemon_version_running: Some("0.2.0".into()),
            restart_pending: false,
            reboot_safe: Some(true),
            linger: Some(false),
            sleep_masked: Some(true),
            claude_installed: Some(true),
            claude_logged_in: Some(true),
            claude_email: Some("a@b.com".into()),
            tailscale_name: None,
            last_boot: Some("2026-01-01 00:00:00".into()),
            busy_conversations: Some(0),
            bundled_daemon_version: None,
            daemon_outdated: false,
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
                ServerDiagnosis { daemon_running: None, ..base_diagnosis() },
                DiagnosisState::Failed { reason: "could not determine whether flightdeckd is running".into() },
            ),
            (
                "claude not installed at all (the live fixtures' own case) — never Failed",
                ServerDiagnosis { claude_installed: Some(false), ..base_diagnosis() },
                DiagnosisState::NeedsClaudeSignIn,
            ),
            (
                "claude install unknown — treated the same as not installed",
                ServerDiagnosis { claude_installed: None, ..base_diagnosis() },
                DiagnosisState::NeedsClaudeSignIn,
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

    #[test]
    fn parse_diagnosis_unreachable_ssh_blanks_every_field_and_fails() {
        let d = parse_diagnosis("", false);
        assert_eq!(d.state, DiagnosisState::Failed { reason: "could not reach the server".to_string() });
        assert_eq!(d.installed_as, InstalledAs::Unknown);
        assert_eq!(d.daemon_running, None);
        assert_eq!(d.claude_logged_in, None);
    }

    // ---- daemon_is_outdated (B2/B3: bundled version vs. the server's running one) ----

    #[test]
    fn daemon_is_outdated_true_when_the_bundled_version_is_newer() {
        assert!(daemon_is_outdated(Some("0.1.0"), Some("0.2.0")));
        assert!(daemon_is_outdated(Some("flightdeckd 0.1.0"), Some("0.2.0")));
    }

    #[test]
    fn daemon_is_outdated_false_when_equal_or_the_server_is_newer() {
        assert!(!daemon_is_outdated(Some("0.2.0"), Some("0.2.0")));
        assert!(!daemon_is_outdated(Some("0.3.0"), Some("0.2.0")));
    }

    #[test]
    fn daemon_is_outdated_never_true_on_an_unknown_side() {
        assert!(!daemon_is_outdated(None, Some("0.2.0")), "unknown running version must never nag");
        assert!(!daemon_is_outdated(Some("0.1.0"), None), "no bundled daemon at all must never nag");
        assert!(!daemon_is_outdated(None, None));
    }

    // ---- repair dispatch exhaustive (compile-time) ----

    #[test]
    fn repair_action_label_covers_every_variant() {
        for action in [
            RepairAction::ReuploadDaemon,
            RepairAction::RestartDaemon,
            RepairAction::InstallService,
            RepairAction::EnableLinger,
            RepairAction::MaskSleep,
            RepairAction::RunInit,
            RepairAction::SignInClaude,
            RepairAction::ProvisionPhone,
        ] {
            assert!(!repair_action_label(action).is_empty(), "{action:?} has no label");
        }
    }

    // ---- repair_action_invalidates_daemon_version_cache (B_lifecycle-#6) ----

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
            RepairAction::SignInClaude,
            RepairAction::ProvisionPhone,
        ] {
            assert!(
                !repair_action_invalidates_daemon_version_cache(action),
                "{action:?} never touches flightdeckd itself — invalidating for it would just \
                 force a needless re-probe on the next spawn",
            );
        }
    }

    // ---- pipeline state machine (fake steps) ----

    fn stored_request() -> StoredBootstrapRequest {
        StoredBootstrapRequest { label: "l".into(), host: "h".into(), port: 22, user: "u".into(), mask_sleep: false }
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
            let cmd = bootstrap_ssh_command(&format!("ssh://{user}@127.0.0.1:{port}"), None, None, &remote);
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
            assert_eq!(d.claude_installed, Some(false), "no fixture ever has claude installed: {d:?}");
            assert_eq!(
                d.state,
                DiagnosisState::NeedsClaudeSignIn,
                "missing claude must read as needs-sign-in, never Failed, per the brief: {d:?}"
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
    }
}
