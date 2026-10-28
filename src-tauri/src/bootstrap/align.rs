//! Keeping a paired server aligned on THIS Mac (CRM `763ae7f2`): the `claude` it runs at
//! this Mac's version (never older, never moved back), its `flightdeckd` at the one this
//! app bundles (the existing rule — strictly newer, `daemon_is_outdated`), and this Mac's
//! whole `~/.claude` user config ([`super::claude_config`]). Without it a server drifted
//! silently: a `claude` too old to know the newest models (the picker showed Opus 5.5,
//! then fell back to Opus 5), a daemon updated on disk but never restarted, the Claude
//! Code settings of this Mac reaching no server at all.
//!
//! ## The contract ([`align_machine`])
//! ONE entry point, also the `align_machine` IPC: `align_machine(app, machine_id) ->
//! Result<AlignReport, String>`. `Err` only when the pass could not start (an unknown
//! server, another operation running on it, the server out of reach); once the server
//! answered, every part ([`AlignPart`]) says on its own what it changed, what is deferred
//! and what failed, and why. The transfer of a local repository onto a server (chantier 2)
//! calls it first.
//!
//! ## When it runs
//! - On demand: "Sync now" in the server's panel ([`align_machine`]).
//! - On its own ([`align_machine_if_due`], gated on the per-server "Keep this server
//!   aligned" toggle, ON by default): when the front sees a server come back within reach
//!   or a remote stream reconnect, and before a sleeping remote conversation cold-starts
//!   ([`before_cold_start`], from `spawn_session`). A pass that found everything in line
//!   less than [`FRESH_FOR`] ago, for an unchanged Mac, is not run again.
//! - Again by itself, every [`RETRY_AFTER`], while a daemon restart waits for its
//!   conversations to come to rest.
//!
//! ## Never interrupting work
//! Files on disk may change at any moment: a running `claude` keeps the binary it started
//! with, and re-reads its settings at its own pace. A process is only ever restarted at
//! rest: the daemon through the existing busy guard (`restart_daemon` refuses while a
//! conversation works — then deferred and retried), each conversation's `claude` through
//! the daemon's own recycle-at-rest (`flightdeckd recycle`, cap `recycle-idle`, 0.7.0),
//! which restarts one at work only once it comes to rest.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::bootstrap::askpass::BootstrapError;
use crate::bootstrap::claude_config::{self as cfg, LocalConfig};
use crate::bootstrap::orchestrator::{
    self, diagnose, known_hosts_path, machine_by_id, repair, server_busy_error, with_bundled_version, RepairAction,
    ServerDiagnosis, ServerLockGuard, ServerLocks,
};
use crate::bootstrap::server_setup;
use crate::ipc::commands::{
    resolve_daemon_bin_expr, run_ssh_on_machine_stdin, run_ssh_on_machine_stdin_raw_compressed, run_ssh_on_machine_within,
};
use crate::store::{MachineRecord, Store};

/// A pass that found everything aligned is trusted this long for an unchanged Mac.
const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
/// A pass that deferred or failed something is not re-run sooner than this on its own.
const RETRY_AFTER: Duration = Duration::from_secs(3 * 60);
/// How many times a deferred daemon restart is retried on its own (`RETRY_AFTER` apart: two hours).
const MAX_RETRIES: u32 = 40;
/// How long a cold start waits for the pass it triggered before spawning anyway.
const COLD_START_WAIT: Duration = Duration::from_secs(150);
/// The facts round trip (it carries `~/.claude.json` back).
const FACTS_TIMEOUT: Duration = Duration::from_secs(60);
/// Applying the config: the archive rides the ssh stdin — a first alignment sends every
/// plugin and marketplace (tens of MB on a slow link).
const APPLY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MCP_TIMEOUT: Duration = Duration::from_secs(120);
const RECYCLE_TIMEOUT: Duration = Duration::from_secs(30);
/// This Mac's `claude --version` is re-read at most this often (it spawns node).
const MAC_VERSION_TTL: Duration = Duration::from_secs(60);

/// The `meta` key of a server's "Keep this server aligned" toggle (absent = ON).
fn keep_aligned_key(machine_id: &str) -> String {
    format!("machine_keep_aligned:{machine_id}")
}

/// Pure: the stored toggle value — anything but an explicit `"0"` is ON (the default).
fn keep_aligned_from(stored: Option<&str>) -> bool {
    stored != Some("0")
}

// ============================================================================
// The report (the contract)
// ============================================================================

/// What one pass did to one part of the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AlignStatus {
    /// It already matched this Mac: nothing was written.
    Current,
    /// This pass changed it.
    Updated,
    /// It needs a change that would interrupt work right now (a daemon restart while a
    /// conversation works): retried on its own.
    Deferred,
    /// Not attempted — it can't be aligned on this server, or there was nothing to align
    /// it on (`detail` says which).
    Skipped,
    /// Tried, and failed (`detail` says why).
    Failed,
}

/// One part of an [`AlignReport`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AlignPart {
    pub status: AlignStatus,
    /// What the server had before the pass (a version, for `claude` and the daemon).
    pub before: Option<String>,
    /// What it has after it.
    pub after: Option<String>,
    /// One sentence, in the user's words.
    pub detail: Option<String>,
}

impl AlignPart {
    fn new(status: AlignStatus, before: Option<String>, after: Option<String>, detail: impl Into<Option<String>>) -> Self {
        Self { status, before, after, detail: detail.into() }
    }

    fn failed(detail: impl Into<String>) -> Self {
        Self::new(AlignStatus::Failed, None, None, Some(detail.into()))
    }
}

/// What the config part wrote (all zero when nothing changed).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConfigChanges {
    /// Files written (new or different).
    pub written: u32,
    /// Files removed (in the mirrored trees, absent from this Mac).
    pub removed: u32,
    /// User-scope MCP servers set and removed through the server's CLI.
    pub mcp_set: u32,
    pub mcp_removed: u32,
    /// MCP servers left as the server has them: their config carries credentials.
    pub mcp_withheld: Vec<String>,
    /// Where the server keeps its config from before this pass (one backup, replaced each time).
    pub backup: Option<String>,
}

/// Why a pass ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AlignTrigger {
    /// "Sync now", or a caller that needs the server aligned (a repository transfer).
    Manual,
    /// The server came back within reach, or a remote stream reconnected.
    Connect,
    /// A sleeping remote conversation is about to cold-start.
    ColdStart,
    /// A deferred daemon restart, tried again.
    Retry,
}

/// One alignment pass — see the module doc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AlignReport {
    pub machine_id: String,
    pub trigger: AlignTrigger,
    /// The `claude` binary: this Mac's version, never older.
    pub claude: AlignPart,
    /// `flightdeckd`: the version this app bundles.
    pub daemon: AlignPart,
    /// This Mac's `~/.claude` user config.
    pub config: AlignPart,
    pub config_changes: ConfigChanges,
    /// The conversations' running `claude` processes, moved at rest onto what changed.
    pub sessions: AlignPart,
    /// This Mac's `claude --version` (the target), when known.
    pub mac_claude_version: Option<String>,
    /// The server's after the pass, when known — what the model picker reads.
    pub server_claude_version: Option<String>,
    /// No part failed.
    pub ok: bool,
    /// Unix ms.
    pub finished_at: i64,
}

/// What the server panel shows of a server's alignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MachineAlignState {
    pub machine_id: String,
    /// "Keep this server aligned with this Mac" (ON by default).
    pub keep_aligned: bool,
    /// A pass is running now.
    pub running: bool,
    pub last: Option<AlignReport>,
    /// Why the last pass could not even start (unreachable, another operation running…).
    pub last_error: Option<String>,
}

/// A server's alignment state changed: a pass started or finished, or its toggle moved.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct MachineAlignEvent {
    pub state: MachineAlignState,
}

// ============================================================================
// Registry (per-app-run memory)
// ============================================================================

#[derive(Default)]
struct Entry {
    running: bool,
    last: Option<AlignReport>,
    last_error: Option<String>,
    /// When the last pass ended, and the Mac it aligned the server on.
    last_at: Option<Instant>,
    last_fingerprint: Option<String>,
    /// The server's home, as the last pass read it (what a fingerprint is computed for).
    server_home: Option<String>,
    retry_scheduled: bool,
    retries: u32,
}

/// Every server's alignment memory for this app run, plus the per-server gate that makes
/// passes single-file (a second caller waits for the running pass, then finds it fresh).
#[derive(Default)]
pub struct AlignRegistry {
    entries: std::sync::Mutex<HashMap<String, Entry>>,
    gates: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    mac_version: std::sync::Mutex<Option<(Instant, Option<String>)>>,
}

impl AlignRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn gate(&self, machine_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.gates.lock().unwrap().entry(machine_id.to_string()).or_default().clone()
    }

    fn with<R>(&self, machine_id: &str, f: impl FnOnce(&mut Entry) -> R) -> R {
        f(self.entries.lock().unwrap().entry(machine_id.to_string()).or_default())
    }
}

/// Pure: whether the last pass still stands for a Mac whose fingerprint is `now_fp`.
fn is_fresh(last: Option<&AlignReport>, last_fp: Option<&str>, last_at: Option<Instant>, now_fp: Option<&str>, now: Instant) -> bool {
    let (Some(last), Some(at)) = (last, last_at) else { return false };
    let age = now.saturating_duration_since(at);
    let settled = [&last.claude, &last.daemon, &last.config, &last.sessions]
        .iter()
        .all(|p| !matches!(p.status, AlignStatus::Deferred | AlignStatus::Failed));
    if !settled {
        return age < RETRY_AFTER;
    }
    age < FRESH_FOR && last_fp.is_some() && last_fp == now_fp
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn keep_aligned(app: &tauri::AppHandle, machine_id: &str) -> bool {
    let stored = app.state::<Store>().get_config(&keep_aligned_key(machine_id)).ok().flatten();
    keep_aligned_from(stored.as_deref())
}

fn state_of(app: &tauri::AppHandle, machine_id: &str) -> MachineAlignState {
    let registry = app.state::<Arc<AlignRegistry>>();
    let (running, last, last_error) =
        registry.with(machine_id, |e| (e.running, e.last.clone(), e.last_error.clone()));
    MachineAlignState { machine_id: machine_id.to_string(), keep_aligned: keep_aligned(app, machine_id), running, last, last_error }
}

fn emit_state(app: &tauri::AppHandle, machine_id: &str) {
    use tauri_specta::Event;
    if let Err(e) = (MachineAlignEvent { state: state_of(app, machine_id) }).emit(app) {
        eprintln!("[bootstrap::align] failed to emit machine_align: {e}");
    }
}

/// This Mac's `claude --version` ("2.1.312"), cached [`MAC_VERSION_TTL`].
async fn mac_claude_version(app: &tauri::AppHandle) -> Option<String> {
    let registry = app.state::<Arc<AlignRegistry>>();
    if let Some((at, v)) = registry.mac_version.lock().unwrap().clone() {
        if at.elapsed() < MAC_VERSION_TTL {
            return v;
        }
    }
    let v = crate::cli_update::installed_version().await;
    *registry.mac_version.lock().unwrap() = Some((Instant::now(), v.clone()));
    v
}

fn mac_home() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or_else(|| "this Mac's home folder is unknown ($HOME)".to_string())
}

/// What a pass would align the server on: this Mac's `claude`, the bundled daemon, and the
/// config as the server (whose home is `server_home`) would hold it. `None` when the config
/// can't be read here (the pass then says why).
async fn mac_fingerprint(app: &tauri::AppHandle, server_home: &str) -> Option<String> {
    let claude = mac_claude_version(app).await;
    let bundled = crate::bootstrap::install::bundled_daemon_manifest(app).ok().map(|m| m.version);
    let home = mac_home().ok()?;
    let server_home = server_home.to_string();
    let local = tokio::task::spawn_blocking(move || cfg::collect_local(&home, &server_home)).await.ok()?.ok()?;
    Some(format!("{}|{}|{}", claude.unwrap_or_default(), bundled.unwrap_or_default(), local.digest()))
}

// ============================================================================
// Entry points
// ============================================================================

/// Align `machine_id` on this Mac now — THE contract (also the `align_machine` IPC, and
/// "Sync now"): runs regardless of the server's "Keep aligned" toggle, which only governs
/// the automatic passes. See the module doc for what `Err` means.
#[tauri::command]
#[specta::specta]
pub async fn align_machine(app: tauri::AppHandle, machine_id: String) -> Result<AlignReport, String> {
    run(&app, &machine_id, AlignTrigger::Manual, false).await.map(|r| r.expect("an unconditional pass always runs"))
}

/// An automatic pass (`trigger`): only when the server's toggle is ON and the last pass no
/// longer stands (see [`is_fresh`]). `Ok(None)` when it did not run.
pub(crate) async fn align_if_due(
    app: &tauri::AppHandle,
    machine_id: &str,
    trigger: AlignTrigger,
) -> Result<Option<AlignReport>, String> {
    if !keep_aligned(app, machine_id) {
        return Ok(None);
    }
    run(app, machine_id, trigger, true).await
}

/// The front's automatic trigger: the server came back within reach, or a remote stream
/// reconnected. `Ok(None)`: not due (toggle off, or the last pass still stands).
#[tauri::command]
#[specta::specta]
pub async fn align_machine_if_due(app: tauri::AppHandle, machine_id: String) -> Result<Option<AlignReport>, String> {
    align_if_due(&app, &machine_id, AlignTrigger::Connect).await
}

/// Before a sleeping remote conversation cold-starts (`spawn_session`): a due pass runs
/// first, so the new `claude` starts on what this Mac runs. Never fails the spawn, and
/// never holds it past [`COLD_START_WAIT`] — the pass then goes on, and its report is
/// still shown in the server panel.
pub(crate) async fn before_cold_start(app: &tauri::AppHandle, machine_id: &str) {
    let app2 = app.clone();
    let id = machine_id.to_string();
    let pass = tauri::async_runtime::spawn(async move { align_if_due(&app2, &id, AlignTrigger::ColdStart).await });
    match tokio::time::timeout(COLD_START_WAIT, pass).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(e))) => eprintln!("[bootstrap::align] cold-start alignment of {machine_id} did not run: {e}"),
        Ok(Err(e)) => eprintln!("[bootstrap::align] cold-start alignment of {machine_id} panicked: {e}"),
        Err(_) => eprintln!("[bootstrap::align] cold-start alignment of {machine_id} still running — spawning anyway"),
    }
}

#[tauri::command]
#[specta::specta]
pub fn machine_align_state(app: tauri::AppHandle, machine_id: String) -> MachineAlignState {
    state_of(&app, &machine_id)
}

/// The server's "Keep this server aligned with this Mac" toggle. Turning it back ON runs
/// a pass when one is due.
#[tauri::command]
#[specta::specta]
pub async fn set_machine_keep_aligned(
    app: tauri::AppHandle,
    machine_id: String,
    enabled: bool,
) -> Result<MachineAlignState, String> {
    machine_by_id(&app, &machine_id)?;
    app.state::<Store>()
        .set_config(&keep_aligned_key(&machine_id), if enabled { "1" } else { "0" })
        .map_err(|e| format!("could not save the setting: {e}"))?;
    emit_state(&app, &machine_id);
    if enabled {
        let app2 = app.clone();
        let id = machine_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = align_if_due(&app2, &id, AlignTrigger::Connect).await {
                eprintln!("[bootstrap::align] alignment of {id} did not run: {e}");
            }
        });
    }
    Ok(state_of(&app, &machine_id))
}

/// One pass, single-file per server. `only_if_due`: skip (Ok(None)) when the last pass
/// still stands for this Mac.
async fn run(
    app: &tauri::AppHandle,
    machine_id: &str,
    trigger: AlignTrigger,
    only_if_due: bool,
) -> Result<Option<AlignReport>, String> {
    let machine = machine_by_id(app, machine_id)?;
    let registry = app.state::<Arc<AlignRegistry>>().inner().clone();
    let gate = registry.gate(machine_id);
    let _single = gate.lock().await;
    if only_if_due {
        let home = registry.with(machine_id, |e| e.server_home.clone());
        let fp = match home {
            Some(h) => mac_fingerprint(app, &h).await,
            None => None,
        };
        let fresh = registry.with(machine_id, |e| {
            is_fresh(e.last.as_ref(), e.last_fingerprint.as_deref(), e.last_at, fp.as_deref(), Instant::now())
        });
        if fresh {
            return Ok(None);
        }
    }
    // Never alongside a bootstrap or a repair of the same server (they would interleave
    // uploads and restarts). An automatic pass that finds one running just doesn't run.
    let locks = app.state::<Arc<ServerLocks>>().inner().clone();
    let guard = match ServerLockGuard::acquire(&locks, machine.id.clone(), "Sync with this Mac") {
        Ok(g) => g,
        Err(running) if only_if_due => {
            eprintln!("[bootstrap::align] {machine_id}: \"{running}\" is running — automatic alignment skipped");
            return Ok(None);
        }
        Err(running) => return Err(server_busy_error(running)),
    };
    registry.with(machine_id, |e| e.running = true);
    emit_state(app, machine_id);
    let known_hosts = known_hosts_path(app);
    let result = pass(app, &machine, known_hosts.as_deref(), trigger).await;
    drop(guard);
    let retry = match &result {
        Ok((report, home)) => {
            let fp = mac_fingerprint(app, home).await;
            let deferred = report.daemon.status == AlignStatus::Deferred;
            registry.with(machine_id, |e| {
                e.last = Some(report.clone());
                e.last_error = None;
                e.last_at = Some(Instant::now());
                e.last_fingerprint = fp;
                e.server_home = Some(home.clone());
                if !deferred {
                    e.retries = 0;
                }
            });
            deferred
        }
        // The last REPORT still stands as it was (its age included): a pass that could not
        // start says nothing new about the server, and the next trigger — it coming back
        // within reach — must find it due.
        Err(err) => {
            registry.with(machine_id, |e| e.last_error = Some(err.clone()));
            false
        }
    };
    registry.with(machine_id, |e| e.running = false);
    emit_state(app, machine_id);
    if retry {
        schedule_retry(app, machine_id);
    }
    result.map(|(r, _)| Some(r))
}

/// A deferred daemon restart is tried again [`RETRY_AFTER`] later, on its own, while the
/// app runs — one retry queued per server, at most [`MAX_RETRIES`] in a row.
fn schedule_retry(app: &tauri::AppHandle, machine_id: &str) {
    let registry = app.state::<Arc<AlignRegistry>>().inner().clone();
    let go = registry.with(machine_id, |e| {
        if e.retry_scheduled || e.retries >= MAX_RETRIES {
            return false;
        }
        e.retry_scheduled = true;
        e.retries += 1;
        true
    });
    if !go {
        return;
    }
    let app = app.clone();
    let id = machine_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RETRY_AFTER).await;
        registry.with(&id, |e| e.retry_scheduled = false);
        if let Err(e) = align_if_due(&app, &id, AlignTrigger::Retry).await {
            eprintln!("[bootstrap::align] retried alignment of {id} did not run: {e}");
        }
    });
}

// ============================================================================
// The pass
// ============================================================================

/// One pass against a reachable server: `claude`, the config, the daemon, then the
/// conversations' processes. Returns the report and the server's home.
async fn pass(
    app: &tauri::AppHandle,
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    trigger: AlignTrigger,
) -> Result<(AlignReport, String), String> {
    let diagnosis = with_bundled_version(app, diagnose(machine, known_hosts).await);
    if !diagnosis.reachable {
        let why = match &diagnosis.state {
            orchestrator::DiagnosisState::Failed { reason } => reason.clone(),
            _ => "could not reach the server".to_string(),
        };
        return Err(format!("couldn't sync with this server — {why}"));
    }
    let home = mac_home()?;
    let mac_claude = mac_claude_version(app).await;

    // The hook scripts' paths, read off this Mac's settings: the server lists them too.
    let extras = {
        let home = home.clone();
        tokio::task::spawn_blocking(move || local_extras(&home)).await.unwrap_or_default()
    };
    let facts = read_facts(machine, known_hosts, &extras).await;
    let server_home = facts.as_ref().ok().and_then(|f| f.home.clone()).unwrap_or_default();

    let claude = match &facts {
        Ok(f) => align_claude(machine, known_hosts, mac_claude.as_deref(), f.claude_version.as_deref()).await,
        Err(e) => AlignPart::failed(e.clone()),
    };
    let claude_works = claude.after.is_some();
    let (config, config_changes, config_restart) = match &facts {
        Ok(f) => align_config(machine, known_hosts, &home, f, claude_works).await,
        Err(e) => (AlignPart::failed(e.clone()), ConfigChanges::default(), false),
    };
    let (daemon, daemon_restarted, running_daemon) = align_daemon(app, machine, known_hosts, &diagnosis).await;
    let claude_changed = claude.status == AlignStatus::Updated;
    let sessions = if !(claude_changed || config_restart) {
        AlignPart::new(AlignStatus::Current, None, None, None)
    } else if daemon_restarted {
        AlignPart::new(
            AlignStatus::Updated,
            None,
            None,
            Some("the daemon restarted with every conversation at rest — each starts on the new setup with its next message".to_string()),
        )
    } else {
        recycle_sessions(machine, known_hosts, running_daemon.as_deref()).await
    };
    let parts = [&claude, &daemon, &config, &sessions];
    let ok = parts.iter().all(|p| p.status != AlignStatus::Failed);
    let report = AlignReport {
        machine_id: machine.id.clone(),
        trigger,
        server_claude_version: claude.after.clone(),
        mac_claude_version: mac_claude,
        claude,
        daemon,
        config,
        config_changes,
        sessions,
        ok,
        finished_at: now_ms(),
    };
    Ok((report, server_home))
}

/// The home-relative hook scripts this Mac's settings run (see `claude_config::hook_script_paths`).
fn local_extras(mac_home: &std::path::Path) -> Vec<String> {
    let settings = std::fs::read(mac_home.join(".claude/settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    cfg::hook_script_paths(&settings, &mac_home.to_string_lossy())
        .into_iter()
        .filter(|r| !cfg::is_synced_path(r))
        .collect()
}

async fn read_facts(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    extras: &[String],
) -> Result<cfg::ServerConfigFacts, String> {
    let script = cfg::as_remote_command(&cfg::facts_script(extras));
    let out = run_ssh_on_machine_stdin_raw_compressed(machine, known_hosts, &script, &[], None, FACTS_TIMEOUT, true, 64 << 20)
        .await
        .map_err(|e| format!("couldn't read the server's setup: {e}"))?;
    let facts = cfg::parse_facts(&String::from_utf8_lossy(&out.stdout));
    if !facts.complete || facts.home.is_none() {
        let why = out.stderr.trim().lines().last().unwrap_or("its answer was cut short").to_string();
        return Err(format!("couldn't read the server's setup: {why}"));
    }
    Ok(facts)
}

/// What to do about the server's `claude` (pure).
#[derive(Debug, Clone, PartialEq, Eq)]
enum ClaudePlan {
    /// Already at (or past) this Mac's version.
    Current { server: String, newer: bool },
    /// Install this Mac's version (`from` = the server's, `None` = none that works).
    Install { target: String, from: Option<String> },
    /// This Mac's version is unknown: nothing to align on.
    NoTarget { server: Option<String> },
}

fn plan_claude(mac: Option<&str>, server: Option<&str>) -> ClaudePlan {
    let norm = |v: Option<&str>| v.and_then(crate::cli_update::first_version_in);
    let (mac, server) = (norm(mac), norm(server));
    match (mac, server) {
        (None, server) => ClaudePlan::NoTarget { server },
        (Some(target), None) => ClaudePlan::Install { target, from: None },
        (Some(target), Some(server)) if crate::cli_update::is_newer(&target, &server) => {
            ClaudePlan::Install { target, from: Some(server) }
        }
        (Some(target), Some(server)) => {
            let newer = crate::cli_update::is_newer(&server, &target);
            ClaudePlan::Current { server, newer }
        }
    }
}

async fn align_claude(machine: &MachineRecord, known_hosts: Option<&str>, mac: Option<&str>, server: Option<&str>) -> AlignPart {
    match plan_claude(mac, server) {
        ClaudePlan::NoTarget { server } => AlignPart::new(
            AlignStatus::Skipped,
            server.clone(),
            server,
            Some("this Mac's Claude Code version couldn't be read, so there is nothing to align the server on".to_string()),
        ),
        ClaudePlan::Current { server, newer } => AlignPart::new(
            AlignStatus::Current,
            Some(server.clone()),
            Some(server),
            newer.then(|| "newer than this Mac's — left as it is".to_string()),
        ),
        ClaudePlan::Install { target, from } => {
            match server_setup::install_claude_version(machine, known_hosts, Some(&target)).await {
                Ok(installed) => {
                    let now = crate::cli_update::first_version_in(&installed);
                    match now {
                        Some(v) if !crate::cli_update::is_newer(&target, &v) => {
                            AlignPart::new(AlignStatus::Updated, from, Some(v), None)
                        }
                        other => AlignPart::new(
                            AlignStatus::Failed,
                            from,
                            other.clone(),
                            Some(format!(
                                "Claude Code {target} was installed, but the `claude` the server runs still answers {} — \
                                 an older install earlier on its PATH may shadow it",
                                other.as_deref().unwrap_or("nothing")
                            )),
                        ),
                    }
                }
                Err(e) => AlignPart::new(
                    AlignStatus::Failed,
                    from.clone(),
                    from,
                    Some(format!("couldn't install Claude Code {target} on the server: {e}")),
                ),
            }
        }
    }
}

/// The config part: `(part, what changed, whether a running claude must restart to see it)`.
async fn align_config(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    mac_home: &std::path::Path,
    facts: &cfg::ServerConfigFacts,
    claude_works: bool,
) -> (AlignPart, ConfigChanges, bool) {
    let none = ConfigChanges::default();
    if facts.no_hasher {
        return (
            AlignPart::failed("the server has neither sha256sum nor shasum to compare its config with — install coreutils there"),
            none,
            false,
        );
    }
    let Some(server_home) = facts.home.clone() else {
        return (AlignPart::failed("the server didn't say where its home folder is"), none, false);
    };
    let local = {
        let home = mac_home.to_path_buf();
        let sh = server_home.clone();
        match tokio::task::spawn_blocking(move || cfg::collect_local(&home, &sh)).await {
            Ok(Ok(l)) => l,
            Ok(Err(e)) => return (AlignPart::failed(e), none, false),
            Err(e) => return (AlignPart::failed(format!("reading this Mac's config failed: {e}")), none, false),
        }
    };
    let plan = cfg::plan_sync(&local, &facts.manifest);
    let mcp_plan = match (&facts.mcp, &local.mcp_unknown) {
        (Some(server), None) => Ok(cfg::plan_mcp(&local, server)),
        (_, Some(mac_err)) => Err(mac_err.clone()),
        (None, None) => Err(format!(
            "the server's MCP servers couldn't be read ({})",
            facts.mcp_unreadable.as_deref().unwrap_or("unknown reason")
        )),
    };
    let mcp_changes = mcp_plan.as_ref().map(Vec::as_slice).unwrap_or(&[]);
    let mut changes = ConfigChanges { mcp_withheld: local.mcp_withheld.clone(), ..Default::default() };
    let mut problems: Vec<String> = Vec::new();
    if let Err(e) = &mcp_plan {
        problems.push(format!("{e} — they were left as they are"));
    }
    if plan.is_empty() && mcp_changes.is_empty() {
        let status = if problems.is_empty() { AlignStatus::Current } else { AlignStatus::Failed };
        let detail = config_detail(&changes, &problems);
        return (AlignPart::new(status, None, None, detail), changes, false);
    }

    // Files (and the backup, which covers ~/.claude.json too, before any MCP change).
    match apply_files(machine, known_hosts, &local, &plan).await {
        Ok(outcome) => {
            changes.backup = outcome.backup.clone();
            let failed_writes: std::collections::BTreeSet<&str> = outcome.write_failed.iter().map(String::as_str).collect();
            changes.written = plan.write.iter().filter(|&&i| !failed_writes.contains(local.files[i].rel.as_str())).count() as u32;
            changes.removed = plan.delete.len().saturating_sub(outcome.remove_failed.len()) as u32;
            if !outcome.write_failed.is_empty() {
                problems.push(format!("couldn't write {}", list_some(&outcome.write_failed)));
            }
            if !outcome.remove_failed.is_empty() {
                problems.push(format!("couldn't remove {}", list_some(&outcome.remove_failed)));
            }
        }
        Err(e) => {
            problems.push(e);
            let detail = config_detail(&changes, &problems);
            return (AlignPart::new(AlignStatus::Failed, None, None, detail), changes, false);
        }
    }

    let mut mcp_applied = false;
    if !mcp_changes.is_empty() {
        if !claude_works {
            problems.push("its MCP servers need the server's own `claude` to change them, and it has none that works".to_string());
        } else {
            match apply_mcp(machine, known_hosts, mcp_changes).await {
                Ok((ok, failed)) => {
                    for name in &ok {
                        match mcp_changes.iter().find(|c| mcp_name(c) == name) {
                            Some(cfg::McpChange::Set(..)) => changes.mcp_set += 1,
                            Some(cfg::McpChange::Remove(_)) => changes.mcp_removed += 1,
                            None => {}
                        }
                    }
                    mcp_applied = !ok.is_empty();
                    for (name, why) in failed {
                        problems.push(format!("MCP server \"{name}\": {why}"));
                    }
                }
                Err(e) => problems.push(e),
            }
        }
    }
    let restart = plan.needs_restart(&local) || mcp_applied;
    let status = if problems.is_empty() { AlignStatus::Updated } else { AlignStatus::Failed };
    (AlignPart::new(status, None, None, config_detail(&changes, &problems)), changes, restart)
}

fn mcp_name(c: &cfg::McpChange) -> &str {
    match c {
        cfg::McpChange::Set(n, _) | cfg::McpChange::Remove(n) => n,
    }
}

/// A few names, then how many more.
fn list_some(items: &[String]) -> String {
    let shown: Vec<&str> = items.iter().take(3).map(String::as_str).collect();
    match items.len().saturating_sub(shown.len()) {
        0 => shown.join(", "),
        more => format!("{} and {more} more", shown.join(", ")),
    }
}

/// The config part's sentence (pure).
fn config_detail(c: &ConfigChanges, problems: &[String]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if c.written > 0 {
        parts.push(format!("{} file{} written", c.written, if c.written == 1 { "" } else { "s" }));
    }
    if c.removed > 0 {
        parts.push(format!("{} removed", c.removed));
    }
    if c.mcp_set + c.mcp_removed > 0 {
        parts.push(format!("MCP servers: {} set, {} removed", c.mcp_set, c.mcp_removed));
    }
    if !c.mcp_withheld.is_empty() {
        parts.push(format!(
            "MCP server{} {} not copied (credentials in its config — add it on the server with `claude mcp add-json --scope user`)",
            if c.mcp_withheld.len() == 1 { "" } else { "s" },
            list_some(&c.mcp_withheld)
        ));
    }
    if let Some(b) = &c.backup {
        parts.push(format!("the previous config is saved in {b}"));
    }
    parts.extend(problems.iter().cloned());
    (!parts.is_empty()).then(|| {
        let mut s = parts.join("; ");
        if let Some(first) = s.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        s
    })
}

async fn apply_files(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    local: &LocalConfig,
    plan: &cfg::SyncPlan,
) -> Result<cfg::ApplyOutcome, String> {
    let payload = {
        let local = local.clone();
        let plan = plan.clone();
        tokio::task::spawn_blocking(move || cfg::build_payload(&local, &plan))
            .await
            .map_err(|e| format!("packing the config failed: {e}"))??
    };
    let script = cfg::as_remote_command(&cfg::apply_script(&local.extras));
    let out = run_ssh_on_machine_stdin(machine, known_hosts, &script, &payload, None, APPLY_TIMEOUT)
        .await
        .map_err(|e| format!("couldn't send the config to the server: {e}"))?;
    let outcome = cfg::parse_apply(&out.stdout);
    if !out.success || !outcome.applied {
        let why = out
            .stderr
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix("FD_FAIL:"))
            .map(str::to_string)
            .or_else(|| out.stderr.trim().lines().last().map(str::to_string))
            .unwrap_or_else(|| "the server stopped before it was done".to_string());
        return Err(format!("couldn't apply the config on the server: {why}"));
    }
    Ok(outcome)
}

async fn apply_mcp(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    changes: &[cfg::McpChange],
) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    let script = cfg::as_remote_command(&cfg::mcp_script(changes));
    let out = run_ssh_on_machine_within(machine, known_hosts, &script, MCP_TIMEOUT)
        .await
        .map_err(|e| format!("couldn't change the server's MCP servers: {e}"))?;
    let (ok, mut failed) = cfg::parse_mcp(&out);
    for c in changes {
        let n = mcp_name(c);
        if !ok.iter().any(|o| o == n) && !failed.iter().any(|(f, _)| f == n) {
            failed.push((n.to_string(), "the server gave no answer for it".to_string()));
        }
    }
    Ok((ok, failed))
}

/// The daemon part: `(part, restarted, the version running after it)`.
async fn align_daemon(
    app: &tauri::AppHandle,
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    d: &ServerDiagnosis,
) -> (AlignPart, bool, Option<String>) {
    let running = d.daemon_version_running.clone();
    if !d.daemon_outdated && !d.restart_pending {
        let part = match d.daemon_running {
            Some(false) => AlignPart::new(
                AlignStatus::Skipped,
                running.clone(),
                running.clone(),
                Some("flightdeckd isn't running on the server — start it from the server panel".to_string()),
            ),
            _ => AlignPart::new(AlignStatus::Current, running.clone(), running.clone(), None),
        };
        return (part, false, running);
    }
    let mut fresh = d.clone();
    if d.daemon_outdated {
        if d.bundled_daemon_for_host == Some(false) {
            let part = AlignPart::new(
                AlignStatus::Skipped,
                running.clone(),
                running.clone(),
                Some("this app carries no flightdeckd build for this server's system".to_string()),
            );
            return (part, false, running);
        }
        match repair(app, machine, known_hosts, RepairAction::ReuploadDaemon, None).await {
            Ok(outcome) => fresh = outcome.diagnosis,
            Err(e) => {
                let part = AlignPart::new(
                    AlignStatus::Failed,
                    running.clone(),
                    running.clone(),
                    Some(format!("couldn't update flightdeckd: {e}")),
                );
                return (part, false, running);
            }
        }
    }
    let target = fresh.daemon_version_disk.clone().or_else(|| fresh.bundled_daemon_version.clone());
    if !fresh.restart_pending {
        // Uploaded and already running (or nothing to restart into).
        let now = fresh.daemon_version_running.clone();
        return (AlignPart::new(AlignStatus::Updated, running, now.clone(), None), false, now);
    }
    match repair(app, machine, known_hosts, RepairAction::RestartDaemon, None).await {
        Ok(outcome) => {
            let now = outcome.diagnosis.daemon_version_running.clone();
            (AlignPart::new(AlignStatus::Updated, running, now.clone(), None), true, now)
        }
        Err(BootstrapError::DaemonBusy(n)) => {
            let at_work = match n {
                Some(n) => format!("{n} conversation{} at work", if n == 1 { " is" } else { "s are" }),
                None => "whether its conversations are at work can't be told".to_string(),
            };
            let part = AlignPart::new(
                AlignStatus::Deferred,
                running.clone(),
                running.clone(),
                Some(format!(
                    "flightdeckd {} is on the server; it restarts once no conversation works ({at_work}) — tried again on its own",
                    target.as_deref().unwrap_or("(new)")
                )),
            );
            (part, false, running)
        }
        Err(BootstrapError::NeedsSudoPassword) => {
            let part = AlignPart::new(
                AlignStatus::Failed,
                running.clone(),
                running.clone(),
                Some("restarting flightdeckd needs a sudo password on this server — use \"Restart the daemon\" in its panel".to_string()),
            );
            (part, false, running)
        }
        Err(e) => {
            let part = AlignPart::new(
                AlignStatus::Failed,
                running.clone(),
                running.clone(),
                Some(format!("couldn't restart flightdeckd: {e}")),
            );
            (part, false, running)
        }
    }
}

/// What `flightdeckd recycle` answered (pure).
fn parse_recycle(stdout: &str) -> Option<(u32, u32)> {
    let line = stdout.lines().rev().find(|l| l.contains("fd_recycled"))?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    (v["ok"] == serde_json::json!(true)).then(|| {
        (v["recycled"].as_u64().unwrap_or(0) as u32, v["deferred"].as_u64().unwrap_or(0) as u32)
    })
}

/// The sessions part: ask the daemon to restart every `claude` at rest (now) and the others
/// as they come to rest.
async fn recycle_sessions(machine: &MachineRecord, known_hosts: Option<&str>, running_daemon: Option<&str>) -> AlignPart {
    let too_old = || {
        AlignPart::new(
            AlignStatus::Deferred,
            None,
            None,
            Some(format!(
                "the running flightdeckd{} can't restart conversations at rest — each picks the change up when it next starts",
                running_daemon.map(|v| format!(" ({v})")).unwrap_or_default()
            )),
        )
    };
    if running_daemon.is_some_and(|v| !crate::ipc::commands::version_at_least(v, "0.7.0")) {
        return too_old();
    }
    let cmd = format!("{} recycle", resolve_daemon_bin_expr("flightdeckd"));
    match run_ssh_on_machine_stdin(machine, known_hosts, &cmd, &[], None, RECYCLE_TIMEOUT).await {
        Ok(out) if out.success => match parse_recycle(&out.stdout) {
            Some((0, 0)) => AlignPart::new(AlignStatus::Current, None, None, Some("no conversation is running".to_string())),
            Some((now, later)) => {
                let mut s = Vec::new();
                if now > 0 {
                    s.push(format!("{now} conversation{} at rest restarted", if now == 1 { "" } else { "s" }));
                }
                if later > 0 {
                    s.push(format!("{later} at work restart{} once at rest", if later == 1 { "s" } else { "" }));
                }
                AlignPart::new(AlignStatus::Updated, None, None, Some(s.join(", ")))
            }
            None => AlignPart::failed(format!("flightdeckd recycle gave an unexpected answer: {}", out.stdout.trim())),
        },
        Ok(out) if out.stderr.contains("predates") || out.stderr.contains("unrecognized subcommand") => too_old(),
        Ok(out) => AlignPart::failed(format!(
            "couldn't restart the conversations at rest: {}",
            out.stderr.trim().lines().last().unwrap_or("flightdeckd recycle failed")
        )),
        Err(e) => AlignPart::failed(format!("couldn't restart the conversations at rest: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_toggle_is_on_unless_turned_off() {
        assert!(keep_aligned_from(None));
        assert!(keep_aligned_from(Some("1")));
        assert!(!keep_aligned_from(Some("0")));
    }

    #[test]
    fn claude_is_brought_to_the_macs_version_and_never_moved_back() {
        assert_eq!(
            plan_claude(Some("2.1.312 (Claude Code)"), Some("2.1.278 (Claude Code)")),
            ClaudePlan::Install { target: "2.1.312".into(), from: Some("2.1.278".into()) }
        );
        assert_eq!(plan_claude(Some("2.1.312"), None), ClaudePlan::Install { target: "2.1.312".into(), from: None });
        assert_eq!(
            plan_claude(Some("2.1.312"), Some("2.1.312 (Claude Code)")),
            ClaudePlan::Current { server: "2.1.312".into(), newer: false }
        );
        assert_eq!(
            plan_claude(Some("2.1.312"), Some("2.1.320 (Claude Code)")),
            ClaudePlan::Current { server: "2.1.320".into(), newer: true }
        );
        // Numeric, not lexicographic.
        assert_eq!(
            plan_claude(Some("2.1.100"), Some("2.1.99")),
            ClaudePlan::Install { target: "2.1.100".into(), from: Some("2.1.99".into()) }
        );
        assert_eq!(plan_claude(None, Some("2.1.1")), ClaudePlan::NoTarget { server: Some("2.1.1".into()) });
    }

    fn report(status: AlignStatus) -> AlignReport {
        let p = AlignPart::new(status, None, None, None);
        AlignReport {
            machine_id: "m".into(),
            trigger: AlignTrigger::Connect,
            claude: p.clone(),
            daemon: p.clone(),
            config: p.clone(),
            config_changes: ConfigChanges::default(),
            sessions: p,
            mac_claude_version: None,
            server_claude_version: None,
            ok: true,
            finished_at: 0,
        }
    }

    #[test]
    fn a_settled_pass_stands_for_an_unchanged_mac_only() {
        let t0 = Instant::now();
        let ok = report(AlignStatus::Current);
        let fresh = |fp_then: &str, fp_now: Option<&str>, age: Duration| {
            is_fresh(Some(&ok), Some(fp_then), Some(t0), fp_now, t0 + age)
        };
        assert!(fresh("a", Some("a"), Duration::from_secs(60)));
        assert!(!fresh("a", Some("b"), Duration::from_secs(60)), "the Mac changed");
        assert!(!fresh("a", None, Duration::from_secs(60)), "the Mac couldn't be read");
        assert!(!fresh("a", Some("a"), FRESH_FOR), "too old");
        assert!(!is_fresh(None, None, None, Some("a"), t0), "never ran");
    }

    #[test]
    fn a_deferred_or_failed_pass_is_retried_after_a_while_whatever_the_mac() {
        let t0 = Instant::now();
        for status in [AlignStatus::Deferred, AlignStatus::Failed] {
            let r = report(status);
            assert!(is_fresh(Some(&r), Some("a"), Some(t0), Some("b"), t0 + Duration::from_secs(30)));
            assert!(!is_fresh(Some(&r), Some("a"), Some(t0), Some("a"), t0 + RETRY_AFTER));
        }
    }

    #[test]
    fn the_recycle_answer_is_read() {
        assert_eq!(parse_recycle(r#"{"type":"fd_recycled","ok":true,"recycled":2,"deferred":1}"#), Some((2, 1)));
        assert_eq!(parse_recycle("garbage"), None);
        assert_eq!(parse_recycle(r#"{"type":"fd_recycled","ok":false}"#), None);
    }

    #[test]
    fn the_config_sentence_says_what_changed_and_what_went_wrong() {
        let c = ConfigChanges {
            written: 3,
            removed: 1,
            mcp_set: 1,
            mcp_removed: 0,
            mcp_withheld: vec!["github".into()],
            backup: Some("~/.flightdeckd/claude-config-backup.tar.gz".into()),
        };
        let s = config_detail(&c, &["couldn't write .claude/x".to_string()]).unwrap();
        assert!(s.starts_with("3 files written; 1 removed; MCP servers: 1 set, 0 removed; MCP server github not copied"), "{s}");
        assert!(s.ends_with("couldn't write .claude/x"), "{s}");
        assert_eq!(config_detail(&ConfigChanges::default(), &[]), None);
        assert_eq!(list_some(&["a".into(), "b".into(), "c".into(), "d".into(), "e".into()]), "a, b, c and 2 more");
    }

    // ---- Live, against the disposable test box (josty@josty-CC over Tailscale) --------
    //
    // `cargo test --lib bootstrap::align::tests::live_ -- --ignored --nocapture`. Each runs the
    // real scripts over real ssh; the config ones in a THROWAWAY home on the server
    // (`HOME=/tmp/fd-align-live-…`), never the account's real `~/.claude`.

    fn josty() -> MachineRecord {
        let home = std::env::var("HOME").unwrap();
        MachineRecord {
            id: "live-josty".into(),
            label: "josty-CC".into(),
            host: std::env::var("FD_LIVE_HOST").unwrap_or_else(|_| "josty-cc".into()),
            port: 22,
            user: "josty".into(),
            identity_file: Some(format!("{home}/.ssh/flightdeck_box_ed25519")),
            added_at: 0,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    /// The facts round trip answers in full on the real server: its home, its `claude`, a
    /// manifest of its real `~/.claude`, and its `~/.claude.json` decoded.
    #[tokio::test]
    #[ignore = "needs the josty-CC test box"]
    async fn live_facts_read_the_real_server() {
        let facts = read_facts(&josty(), None, &[]).await.expect("facts");
        println!("home={:?} claude={:?} files={} mcp={:?}", facts.home, facts.claude_version, facts.manifest.len(), facts.mcp.as_ref().map(|m| m.keys().collect::<Vec<_>>()));
        assert_eq!(facts.home.as_deref(), Some("/home/josty"));
        assert!(facts.claude_version.is_some());
        assert!(facts.mcp.is_some(), "{:?}", facts.mcp_unreadable);
    }

    /// The config mirror end to end, in a throwaway home on the server: a first apply writes
    /// everything (and removes a stale agent), the server then holds exactly this Mac's
    /// files — a second read plans nothing — and the backup holds what was there before.
    #[tokio::test]
    #[ignore = "needs the josty-CC test box"]
    async fn live_config_mirror_converges_in_a_throwaway_home() {
        let m = josty();
        let tag = uuid::Uuid::new_v4();
        let remote_home = format!("/tmp/fd-align-live-{tag}");
        let local_home = std::env::temp_dir().join(format!("fd-align-live-mac-{tag}"));
        let w = |rel: &str, text: &str| {
            let p = local_home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let lh = local_home.to_string_lossy().into_owned();
        w(".claude/settings.json", &format!(r#"{{"env":{{"CLAUDE_CODE_SUBAGENT_MODEL":"sonnet"}},"statusLine":{{"type":"command","command":"{lh}/bin/status.sh"}}}}"#));
        w(".claude/agents/Explore.md", "---\nmodel: haiku\n---\n");
        w(".claude/skills/s/SKILL.md", "# s\n");
        w("bin/status.sh", "#!/bin/sh\necho ok\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(local_home.join("bin/status.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let in_home = |script: &str| format!("mkdir -p {h} && HOME={h} {}", cfg::as_remote_command(script), h = crate::ipc::commands::shq(&remote_home));
        // A stale agent the Mac doesn't have.
        run_ssh_on_machine_within(&m, None, &format!("mkdir -p {remote_home}/.claude/agents && echo old > {remote_home}/.claude/agents/old.md"), Duration::from_secs(20)).await.unwrap();

        let local = cfg::collect_local(&local_home, &remote_home).unwrap();
        assert_eq!(local.extras, vec!["bin/status.sh"]);
        let read = |extras: Vec<String>| {
            let m = m.clone();
            let script = in_home(&cfg::facts_script(&extras));
            async move {
                let out = run_ssh_on_machine_stdin_raw_compressed(&m, None, &script, &[], None, FACTS_TIMEOUT, true, 64 << 20).await.unwrap();
                cfg::parse_facts(&String::from_utf8_lossy(&out.stdout))
            }
        };
        let facts = read(local.extras.clone()).await;
        assert!(facts.complete && facts.home.as_deref() == Some(remote_home.as_str()), "{facts:?}");
        let plan = cfg::plan_sync(&local, &facts.manifest);
        assert_eq!(plan.write.len(), local.files.len());
        assert_eq!(plan.delete, vec![".claude/agents/old.md"]);

        let payload = cfg::build_payload(&local, &plan).unwrap();
        let out = run_ssh_on_machine_stdin(&m, None, &in_home(&cfg::apply_script(&local.extras)), &payload, None, APPLY_TIMEOUT).await.unwrap();
        let applied = cfg::parse_apply(&out.stdout);
        assert!(out.success && applied.applied, "{} / {}", out.stdout, out.stderr);
        assert!(applied.write_failed.is_empty() && applied.remove_failed.is_empty(), "{applied:?}");
        assert!(applied.backup.is_some(), "the stale agent was backed up first");

        let again = read(local.extras.clone()).await;
        assert!(cfg::plan_sync(&local, &again.manifest).is_empty(), "the server holds exactly this Mac's config: {:?}", again.manifest);
        let settings = run_ssh_on_machine_within(&m, None, &format!("cat {remote_home}/.claude/settings.json; test -x {remote_home}/bin/status.sh && echo EXEC"), Duration::from_secs(20)).await.unwrap();
        assert!(settings.contains(&format!("{remote_home}/bin/status.sh")) && !settings.contains(&lh), "{settings}");
        assert!(settings.contains("EXEC"), "the hook script kept its exec bit");

        let _ = run_ssh_on_machine_within(&m, None, &format!("rm -rf {remote_home}"), Duration::from_secs(20)).await;
        let _ = std::fs::remove_dir_all(&local_home);
    }
}
