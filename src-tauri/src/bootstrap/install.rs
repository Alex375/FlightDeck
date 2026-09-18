//! Getting the `flightdeckd` binary itself onto an already-paired server (B8,
//! [`upload_daemon`]) and making it PERSIST there — a systemd unit (system or user), or
//! a detached fallback — plus the one privileged step that can require it
//! (B9, [`install_service`] / [`escalate_persistence`]).
//!
//! Both halves go over the crate's existing KEYED ssh path (`keyed_ssh_options` /
//! [`crate::ipc::commands::run_ssh_on_machine`] / [`crate::ipc::commands::
//! run_ssh_on_machine_stdin`]) — never `bootstrap::askpass`'s first-contact,
//! password-only relay: by this point in the flow the server already has the app's key
//! (see [`crate::bootstrap::connect`]) and has already been probed
//! ([`crate::ipc::commands::RemoteProbeResult`], B7). The ONE place this module DOES
//! touch a login/`sudo` password is [`escalate_persistence`]'s fallback when
//! passwordless `sudo` is unavailable — and even there the password travels only on an
//! ssh child's own stdin pipe, never argv/env/disk (see [`SecretString`] and that
//! function's own doc).
//!
//! ## Testability without a live server
//!
//! Every remote script here is a fixed [`crate::bootstrap::templates`] generator or a
//! constant, and every I/O function that DRIVES one is split from the PURE function
//! that PARSES its result — the same "pure core, thin I/O shell" split every other
//! module in `bootstrap/` uses ([`parse_resolve_target_output`], [`parse_upload_output`],
//! [`classify_conflict`], [`plan_service_install`]). For the handful of behaviors that
//! can only be proven by actually running SOMETHING (does a mismatch really leave zero
//! bytes written? does a truncated transfer really get cleaned up?), the low-level ssh
//! calls accept an `ssh_bin_override: Option<&Path>` that — ONLY in tests — is prepended
//! to the spawned CHILD's own `PATH` (via `Command::env`, never the app's own
//! process-wide environment, so this never risks another concurrently-running test's
//! own real `ssh` calls), pointing `ssh` at a throwaway fake script instead of a real
//! connection. Production call sites always pass `None`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::bootstrap::askpass::{self, BootstrapError, SecretString};
use crate::bootstrap::templates;
use crate::ipc::commands::{resolve_daemon_bin_expr, run_ssh_on_machine, run_ssh_on_machine_stdin, RemoteProbeResult};
use crate::store::{MachineRecord, Store};

/// Default bound for this module's stdin-bearing ssh calls — every one here except the
/// daemon binary upload itself is a short script with no meaningful payload (a unit
/// file is a few hundred bytes, a status/sudo check has none at all).
const SSH_STDIN_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound for [`stream_upload`] specifically — the static musl `flightdeckd` binary can
/// be tens of MB, over whatever link the target VPS happens to have; the default
/// [`SSH_STDIN_TIMEOUT`] would be too tight for a slow connection.
const SSH_UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);

// ============================================================================
// B8 — upload_daemon
// ============================================================================

/// Dev/test override for [`daemon_binary_path`]/[`bundled_daemon_manifest`]'s
/// resolution: a directory holding the two static musl binaries directly
/// (`flightdeckd-x86_64-unknown-linux-musl` / `flightdeckd-aarch64-unknown-linux-musl`)
/// plus their `manifest.json` — e.g. this repo's own `flightdeckd/target/deploy/<tag>/`,
/// or (the normal case, see `scripts/build-daemon.mjs`)
/// `src-tauri/resources/flightdeckd/` itself. Always wins over the app's bundled
/// resource dir — the escape hatch `tauri dev`/tests use to point at binaries without
/// going through a real bundle.
pub const TOSSE_FLIGHTDECKD_BIN_DIR_ENV: &str = "TOSSE_FLIGHTDECKD_BIN_DIR";

/// The static musl binary's filename for a given `uname -m` arch string, or `None` for
/// an arch this app doesn't ship a build for at all (yet). Pure — the one place that
/// knows the naming convention, so [`resolve_daemon_binary_path`] and its tests share
/// it rather than repeating the two literal filenames.
fn daemon_binary_filename(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("flightdeckd-x86_64-unknown-linux-musl"),
        "aarch64" => Some("flightdeckd-aarch64-unknown-linux-musl"),
        _ => None,
    }
}

/// The [`daemon_target_triple`] sibling of [`daemon_binary_filename`]: the bare Rust
/// target triple for `arch`, e.g. `"x86_64"` -> `"x86_64-unknown-linux-musl"` — the key
/// [`DaemonManifest::targets`] is keyed by. Derived from [`daemon_binary_filename`]
/// (strips the shared `"flightdeckd-"` prefix) rather than repeating the two arch
/// literals a second time — the filename and the triple must never drift apart, since
/// `scripts/build-daemon.mjs` (the manifest's own writer) derives the triple from the
/// SAME filename convention on the JS side.
fn daemon_target_triple(arch: &str) -> Option<&'static str> {
    daemon_binary_filename(arch).map(|f| {
        f.strip_prefix("flightdeckd-")
            .expect("daemon_binary_filename always returns a \"flightdeckd-<triple>\" name")
    })
}

/// The pure core of [`daemon_binary_path`]: env override always wins, `resource_dir`
/// (the app's bundled `flightdeckd/` — populated by `scripts/build-daemon.mjs` +
/// `tauri.conf.json`'s `bundle.resources`, see the module doc) is the fallback the
/// caller supplies, so this is unit-testable without a running Tauri app. Every
/// non-success path — an arch this app doesn't ship a build for, no resource dir
/// available, or a resolved path that simply isn't a file on disk — comes back as the
/// SAME [`BootstrapError::DaemonBinaryNotBundled`] naming the arch, never a generic IO
/// error a caller would have to guess the meaning of.
pub(crate) fn resolve_daemon_binary_path(
    arch: &str,
    resource_dir: Option<&Path>,
) -> Result<PathBuf, BootstrapError> {
    let not_bundled = || BootstrapError::DaemonBinaryNotBundled(arch.to_string());
    let filename = daemon_binary_filename(arch).ok_or_else(not_bundled)?;
    let dir = daemon_resource_dir(resource_dir).ok_or_else(not_bundled)?;
    let path = dir.join(filename);
    if !path.is_file() {
        return Err(not_bundled());
    }
    Ok(path)
}

/// Shared by [`resolve_daemon_binary_path`] and [`resolve_daemon_manifest`]: the
/// directory that holds both the binaries AND `manifest.json` — `$TOSSE_
/// FLIGHTDECKD_BIN_DIR` when set (dev/test override, always wins), else `resource_dir/
/// flightdeckd/` (the app's real bundled resources — `None` when the caller has no
/// resource dir at all, e.g. `resource_dir()` itself failed).
fn daemon_resource_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    match std::env::var(TOSSE_FLIGHTDECKD_BIN_DIR_ENV) {
        Ok(d) if !d.is_empty() => Some(PathBuf::from(d)),
        _ => resource_dir.map(|d| d.join("flightdeckd")),
    }
}

/// (B8) Resolve the local path of the static musl `flightdeckd` binary for `arch`
/// (`"x86_64"` | `"aarch64"`, straight off [`RemoteProbeResult::arch`]): the app's own
/// resource dir, or `$TOSSE_FLIGHTDECKD_BIN_DIR` in dev/tests — see
/// [`resolve_daemon_binary_path`], the actual (testable) resolver this just feeds the
/// app's real bundled resource dir into. `resource_dir()` resolves correctly in BOTH a
/// real bundled `.app` (`Contents/Resources`, populated at build time by `tauri.conf.
/// json`'s `bundle.resources`) and a `tauri dev` run (Tauri's CLI copies `bundle.
/// resources` next to the dev binary too, under `target/debug/`) — no separate dev-mode
/// path needed here.
pub fn daemon_binary_path(app: &tauri::AppHandle, arch: &str) -> Result<PathBuf, BootstrapError> {
    use tauri::Manager;
    let resource_dir = app.path().resource_dir().ok();
    resolve_daemon_binary_path(arch, resource_dir.as_deref())
}

/// (B2/B3) One target's entry in [`DaemonManifest::targets`] — the sha256 [`upload_daemon`]
/// verifies the bundled binary against before ever sending it, plus its byte size
/// (informational, e.g. for a UI showing bundle size — not itself checked today).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonManifestTarget {
    pub sha256: String,
    pub size: u64,
}

/// (B2/B3) `manifest.json`, written by `scripts/build-daemon.mjs` alongside the
/// binaries it copies into `src-tauri/resources/flightdeckd/` (and, after `tauri
/// build`/`tauri dev`, resolved via [`bundled_daemon_manifest`] exactly like the
/// binaries themselves — see [`daemon_resource_dir`]). `version` is read from
/// `flightdeckd/Cargo.toml` at build time — ONE version for the whole manifest (both
/// target triples are always built from the same commit), which is what makes it
/// directly comparable to a server's own `flightdeckd --version` output via
/// [`crate::ipc::commands::version_at_least`], no per-arch lookup needed for that
/// comparison (see `bootstrap::orchestrator::daemon_is_outdated`). `targets` may hold
/// only ONE entry when the manifest was produced by a partial (`TARGETS=`-limited)
/// build — never assumed to have both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonManifest {
    pub version: String,
    pub built_at: String,
    pub targets: std::collections::HashMap<String, DaemonManifestTarget>,
}

/// Pure core of [`bundled_daemon_manifest`]: resolves `manifest.json` the SAME way
/// [`resolve_daemon_binary_path`] resolves a binary (via [`daemon_resource_dir`] — env
/// override always wins), then parses it. A missing OR unparseable manifest both come
/// back as [`BootstrapError::DaemonManifestMissing`] — a caller about to upload cares
/// only "can I verify?", not which of the two ways that failed.
pub(crate) fn resolve_daemon_manifest(resource_dir: Option<&Path>) -> Result<DaemonManifest, BootstrapError> {
    let dir = daemon_resource_dir(resource_dir).ok_or(BootstrapError::DaemonManifestMissing)?;
    let bytes = std::fs::read(dir.join("manifest.json")).map_err(|_| BootstrapError::DaemonManifestMissing)?;
    serde_json::from_slice(&bytes).map_err(|_| BootstrapError::DaemonManifestMissing)
}

/// (B2/B3) This Mac's BUNDLED `flightdeckd` manifest — see [`DaemonManifest`]'s own
/// doc. Read fresh every call (a `manifest.json` a few hundred bytes on local disk;
/// never worth caching like [`crate::ipc::commands`]'s per-run remote-version cache).
pub fn bundled_daemon_manifest(app: &tauri::AppHandle) -> Result<DaemonManifest, BootstrapError> {
    use tauri::Manager;
    let resource_dir = app.path().resource_dir().ok();
    resolve_daemon_manifest(resource_dir.as_deref())
}

/// (B2/B3) Refuses to trust a bundled binary that doesn't match its own manifest —
/// [`upload_daemon`]'s preflight, called with the ACTUAL bytes about to be uploaded
/// (never re-reads the file: the caller already has them in hand for the upload
/// itself). `arch` maps to the manifest's target-triple key via
/// [`daemon_target_triple`]; an arch with no manifest entry at all (a partial build
/// that only produced the OTHER architecture) is [`BootstrapError::DaemonManifestMissing`]
/// — same "can't verify" bucket as a missing manifest file, not a tamper report (nothing
/// to compare against, no claim about the bytes being wrong).
pub(crate) fn verify_daemon_binary_sha256(
    arch: &str,
    bytes: &[u8],
    manifest: &DaemonManifest,
) -> Result<(), BootstrapError> {
    let triple = daemon_target_triple(arch).ok_or_else(|| BootstrapError::DaemonBinaryNotBundled(arch.to_string()))?;
    let expected =
        manifest.targets.get(triple).map(|t| t.sha256.clone()).ok_or(BootstrapError::DaemonManifestMissing)?;
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        Err(BootstrapError::DaemonBinaryTampered { arch: arch.to_string(), expected, actual })
    }
}

/// Outcome of [`upload_daemon`]. `restart_required` is `true` whenever bytes were
/// actually written over a PRE-EXISTING binary (the remote's own sha256 for the target
/// came back non-empty before the upload, whether or not it happened to still match —
/// it didn't, or this would have been `AlreadyCurrent`) — a fresh install (nothing was
/// there before) is `false`: there is nothing running to interrupt. Restarting an
/// already-running daemon is deliberately NOT done here — see this crate's own doc for
/// why (a restart kills live sessions; it is B9/B11's explicit decision, never
/// automatic).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum UploadOutcome {
    /// The target already holds the exact bytes about to be sent — nothing was
    /// written, over the wire or to disk on either end.
    AlreadyCurrent,
    Uploaded { restart_required: bool },
}

/// `sha256(bytes)` as a lowercase hex digest — matches `sha256sum`'s own stdout column
/// exactly (the format every remote script here compares against), via the `sha2` crate
/// (already in the tree transitively, see `Cargo.toml`) rather than shelling out to a
/// platform-specific checksum binary on THIS Mac.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Parses [`templates::RESOLVE_DAEMON_TARGET_SCRIPT`]'s stdout into `(target,
/// existing_sha256)` — `existing_sha256` is `None` when nothing is at `target` yet (a
/// fresh install), `Some` (possibly differing from what we're about to send) when
/// something already is. Pure — the ssh round trip itself is
/// [`resolve_target_and_check`]. A connection-level failure (the script never even ran)
/// is reported via `ssh_succeeded`, never conflated with "ran, target has no existing
/// file" — that would silently misreport a dead connection as a fresh, uploadable
/// target.
fn parse_resolve_target_output(
    stdout: &str,
    stderr: &str,
    ssh_succeeded: bool,
) -> Result<(String, Option<String>), BootstrapError> {
    if !ssh_succeeded {
        if askpass::is_host_key_mismatch(stderr) {
            return Err(BootstrapError::HostKeyMismatch);
        }
        return Err(BootstrapError::Other(
            stderr
                .trim()
                .lines()
                .last()
                .unwrap_or("could not resolve the install target")
                .to_string(),
        ));
    }
    let target = crate::ipc::commands::extract_marker(stdout, "FLIGHTDECK_TARGET:")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            BootstrapError::Other("the target-resolution script reported no target".to_string())
        })?;
    let existing_sha =
        crate::ipc::commands::extract_marker(stdout, "FLIGHTDECK_TARGET_SHA256:").filter(|s| !s.is_empty());
    Ok((target, existing_sha))
}

/// Runs [`templates::RESOLVE_DAEMON_TARGET_SCRIPT`] on `machine` and parses its result.
/// See [`parse_resolve_target_output`].
async fn resolve_target_and_check(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
) -> Result<(String, Option<String>), BootstrapError> {
    let out = run_ssh_on_machine_stdin(
        machine,
        known_hosts,
        templates::RESOLVE_DAEMON_TARGET_SCRIPT,
        &[],
        ssh_bin_override,
        SSH_STDIN_TIMEOUT,
    )
    .await
    .map_err(BootstrapError::Other)?;
    parse_resolve_target_output(&out.stdout, &out.stderr, out.success)
}

/// Parses [`templates::render_upload_script`]'s result. `Ok(())` ONLY when the script's
/// own self-verification (size AND sha256 of the temp file) both matched and it reached
/// the atomic `mv` — every other case (a recognized mismatch, a connection that died
/// before the script could even report, ssh itself failing) is
/// [`BootstrapError::UploadTruncated`], with `got` read from whatever `FLIGHTDECK_
/// GOT_SIZE` marker made it back (`0` when nothing did) — never a false success. Pure —
/// [`stream_upload`] is the (untestable without a real/fake ssh) shell around it.
///
/// The success check is a LINE-ANCHORED match (mirrors `extract_marker`'s own
/// discipline for every other marker this module reads) rather than a bare substring
/// search — a substring search could be satisfied by an unrelated banner/MOTD line (or
/// leaked stderr text) that merely happens to CONTAIN the marker, which would defeat
/// this function's own "never a false success" guarantee.
fn parse_upload_output(stdout: &str, ssh_succeeded: bool, expected_size: u64) -> Result<(), BootstrapError> {
    if ssh_succeeded && stdout.lines().any(|l| l == "FLIGHTDECK_UPLOAD_OK") {
        return Ok(());
    }
    let got = crate::ipc::commands::extract_marker(stdout, "FLIGHTDECK_GOT_SIZE:")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Err(BootstrapError::UploadTruncated { expected: expected_size, got })
}

/// Streams `bytes` into `target` on `machine` via [`templates::render_upload_script`],
/// then classifies the result via [`parse_upload_output`]. A host-key mismatch on the
/// ssh call itself is classified before falling through to the generic truncation case
/// — a reimaged/impersonating server is never just "the upload didn't finish".
async fn stream_upload(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
    target: &str,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), BootstrapError> {
    let script = templates::render_upload_script(target, bytes.len() as u64, expected_sha256);
    let out = run_ssh_on_machine_stdin(machine, known_hosts, &script, bytes, ssh_bin_override, SSH_UPLOAD_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if !out.success && askpass::is_host_key_mismatch(&out.stderr) {
        return Err(BootstrapError::HostKeyMismatch);
    }
    parse_upload_output(&out.stdout, out.success, bytes.len() as u64)
}

/// Best-effort removal of any leftover `.flightdeckd.upload.*` temp file under
/// `target`'s own directory — [`templates::render_upload_script`]'s OWN mismatch branch
/// already does this when the connection survives long enough for the script to reach
/// it, but a connection that died mid-stream (the remote shell killed by SIGHUP before
/// it could run its own cleanup) needs a SEPARATE reconnect to actually remove it.
/// Every failure here is swallowed (logged, never surfaced) — this is hygiene, not a
/// correctness requirement: a stray temp file left behind is harmless (never promoted
/// over the real target — only an explicit, self-verified `mv` in the script itself
/// does that), so a failed cleanup must never turn an already-reported upload failure
/// into two errors.
async fn cleanup_upload_temp(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
    target: &str,
) {
    let cmd = format!(
        "rm -f \"$(dirname {target})\"/.flightdeckd.upload.* 2>/dev/null",
        target = crate::ipc::commands::shq(target)
    );
    if let Err(e) =
        run_ssh_on_machine_stdin(machine, known_hosts, &cmd, &[], ssh_bin_override, SSH_STDIN_TIMEOUT).await
    {
        eprintln!("[bootstrap::install] best-effort upload-temp cleanup failed: {e}");
    }
}

/// A direct, UNVERIFIED path-to-upload primitive — no manifest, no sha256 check
/// against anything but the remote's own existing binary. Production code no longer
/// calls this directly (see [`upload_daemon_verified`], which verifies-then-uploads a
/// single read); it remains `pub(crate)` as the escape hatch this module's own
/// `$TOSSE_FLIGHTDECKD_BIN_DIR`-pointed dev/live tests use to push a bare pair of
/// binaries with no manifest at all, plus the fake-ssh unit tests that exercise the
/// resolve/stream/cleanup sequence in isolation. `#[allow(dead_code)]` outside tests
/// because of exactly that: nothing in the non-test binary calls it any more.
///
/// Reads `local_binary_path` itself (this is the ONLY read of the path in this call —
/// see [`upload_daemon_bytes`]'s own doc for why that matters) and uploads exactly
/// those bytes.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn upload_daemon_from_path(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    local_binary_path: &Path,
    ssh_bin_override: Option<&Path>,
) -> Result<UploadOutcome, BootstrapError> {
    let bytes = tokio::fs::read(local_binary_path)
        .await
        .map_err(|e| BootstrapError::Other(format!("could not read the local daemon binary: {e}")))?;
    upload_daemon_bytes(machine, known_hosts, &bytes, ssh_bin_override).await
}

/// Shared core of [`upload_daemon_from_path`] and [`upload_daemon_verified`]: hashes
/// `bytes`, resolves the remote target + its existing sha256, and — unless they
/// already match — streams exactly `bytes` (never re-reading anything off disk).
///
/// ⚠️ This is the ONE place that decides what actually goes over the wire.
/// [`upload_daemon`] used to verify one read of the binary's sha256 and then call
/// (what was then) `upload_daemon_from_path` with a PATH, which did its own,
/// completely separate `tokio::fs::read` for the upload itself — so the
/// manifest-verified buffer was discarded and a file that changed on disk between
/// the two reads would upload unverified bytes with zero manifest protection. Taking
/// `bytes: &[u8]` here instead of a path closes that gap structurally: a caller that
/// has already read-and-verified a buffer (like [`upload_daemon_verified`]) passes
/// that SAME buffer straight through, with no way to accidentally re-read the path.
async fn upload_daemon_bytes(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    bytes: &[u8],
    ssh_bin_override: Option<&Path>,
) -> Result<UploadOutcome, BootstrapError> {
    let local_sha = sha256_hex(bytes);

    let (target, existing_sha) = resolve_target_and_check(machine, known_hosts, ssh_bin_override).await?;

    if existing_sha.as_deref() == Some(local_sha.as_str()) {
        return Ok(UploadOutcome::AlreadyCurrent);
    }
    let restart_required = existing_sha.is_some();

    match stream_upload(machine, known_hosts, ssh_bin_override, &target, bytes, &local_sha).await {
        Ok(()) => Ok(UploadOutcome::Uploaded { restart_required }),
        Err(e) => {
            cleanup_upload_temp(machine, known_hosts, ssh_bin_override, &target).await;
            Err(e)
        }
    }
}

/// (B8) Upload the static musl `flightdeckd` binary for `probe`'s reported arch onto
/// `machine` — idempotent (a byte-identical target is [`UploadOutcome::AlreadyCurrent`],
/// nothing written on either end), and self-verified end to end (a truncated transfer
/// NEVER silently promotes a corrupt/partial binary — see [`templates::
/// render_upload_script`]'s own doc). Never restarts anything: see [`UploadOutcome`]'s
/// own doc for why replacing a RUNNING daemon's binary is safe (atomic rename, the
/// process keeps its old inode) but restarting it is deliberately left to the caller.
///
/// (B2/B3) Before anything touches the network: the chosen binary's sha256 is verified
/// against [`bundled_daemon_manifest`] ([`verify_daemon_binary_sha256`]) — a mismatch
/// (or no manifest to check against at all) returns
/// [`BootstrapError::DaemonBinaryTampered`]/[`BootstrapError::DaemonManifestMissing`]
/// and NOTHING is uploaded. Only the app-handle plumbing (resolving `arch` to a
/// bundled path + manifest) lives here — the actual read-verify-upload sequence is
/// [`upload_daemon_verified`], so it can be driven directly in tests without a real
/// `tauri::AppHandle`.
pub async fn upload_daemon(
    app: &tauri::AppHandle,
    machine: &MachineRecord,
    arch: &str,
    known_hosts: Option<&str>,
) -> Result<UploadOutcome, BootstrapError> {
    let local_path = daemon_binary_path(app, arch)?;
    let manifest = bundled_daemon_manifest(app)?;
    upload_daemon_verified(machine, arch, &local_path, &manifest, known_hosts, None).await
}

/// The testable core of [`upload_daemon`]: reads `local_path` **exactly once**,
/// verifies that single buffer's sha256 against `manifest` ([`verify_daemon_binary_sha256`]),
/// and — only if that passes — uploads that SAME buffer via [`upload_daemon_bytes`],
/// which never re-reads the path. A mismatch returns before [`upload_daemon_bytes`] is
/// even called, so a tampered binary never reaches the network.
pub(crate) async fn upload_daemon_verified(
    machine: &MachineRecord,
    arch: &str,
    local_path: &Path,
    manifest: &DaemonManifest,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
) -> Result<UploadOutcome, BootstrapError> {
    let bytes = tokio::fs::read(local_path)
        .await
        .map_err(|e| BootstrapError::Other(format!("could not read the local daemon binary: {e}")))?;
    verify_daemon_binary_sha256(arch, &bytes, manifest)?;
    upload_daemon_bytes(machine, known_hosts, &bytes, ssh_bin_override).await
}

// ============================================================================
// B9 — install_service
// ============================================================================

/// What [`ServiceOutcome::Adopted`] found already running on the server — mirrors
/// `bootstrap::connect::PROBE_SCRIPT`'s own three CONFLICT shapes (see
/// [`classify_conflict`]), so the UI can word "adopt" differently for "there's already
/// a real systemd unit" versus "there's just a binary/config sitting there".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum AdoptedKind {
    SystemUnit,
    ExistingBinary,
    ExistingConfig,
}

/// Classifies [`RemoteProbeResult::conflict`]'s free-text description into an
/// [`AdoptedKind`] + the path it names (when it names one) — parses the EXACT three
/// sentence shapes `bootstrap::connect::PROBE_SCRIPT`'s own `CONFLICT=` assignments
/// produce (`"an existing system unit at …"` / `"an existing flightdeckd binary at …"` /
/// `"an existing ~/.flightdeckd/config.json"`). Pure, and duplicated from that script
/// rather than sharing a formatter with it — the two run at very different points in the
/// flow (a shell script vs. a Rust match) and this is the one place that ever needs to
/// go the OTHER direction, text back to structured data.
pub(crate) fn classify_conflict(conflict: &str) -> (AdoptedKind, Option<String>) {
    if let Some(path) = conflict.strip_prefix("an existing system unit at ") {
        return (AdoptedKind::SystemUnit, Some(path.to_string()));
    }
    if let Some(path) = conflict.strip_prefix("an existing flightdeckd binary at ") {
        return (AdoptedKind::ExistingBinary, Some(path.to_string()));
    }
    (AdoptedKind::ExistingConfig, None)
}

/// Outcome of [`install_service`] — which persistence mechanism actually ended up
/// governing `flightdeckd` on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ServiceOutcome {
    /// B7 already found something there (a unit, a binary, a config) — NOTHING was
    /// written; the pre-existing install is left exactly as found.
    Adopted { kind: AdoptedKind, unit_path: Option<String> },
    /// A root-owned `/etc/systemd/system/flightdeckd.service`, enabled `--now`.
    SystemUnit,
    /// A per-user `~/.config/systemd/user/flightdeckd.service`, enabled `--now
    /// --user`, with `loginctl enable-linger` confirmed so it survives logout.
    UserUnit,
    /// No systemd, or linger/`sudo` both unavailable: a `setsid`+`nohup`-detached
    /// process — survives THIS session closing (`KillUserProcesses=no`, verified
    /// before this is ever chosen) but never a reboot, and has no `Restart=` on a
    /// crash.
    DetachedProcess { survives_reboot: bool },
}

/// The pure decision [`install_service`] makes, given B7's probe facts plus whatever
/// THIS call has actually learned by attempting a no-sudo self-linger — split out so
/// EVERY branch in the brief's table is exhaustively unit-tested without touching a
/// live server. [`install_service`] is the (untestable) I/O shell that gathers these
/// facts, in this exact order, and executes the chosen plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServicePlan {
    Adopt(AdoptedKind, Option<String>),
    SystemUnit,
    UserUnit,
    /// Linger is refused without `sudo`, but `sudo` IS available (passwordless, per
    /// probe — [`install_service`] never carries a captured password of its own, so
    /// this is the only escalation it can perform unattended) — escalate via
    /// [`escalate_persistence`], THEN install the user unit.
    EscalateLingerThenUserUnit,
    DetachedProcess { survives_reboot: bool },
    /// Nothing left to automate: linger refused, no (passwordless) `sudo` to escalate
    /// with, and either systemd is entirely absent or a background process would not
    /// survive the session closing (`KillUserProcesses` is `yes`/unknown) — a real
    /// administrator needs to act.
    NeedsAdmin,
}

/// The "no systemd at all" arm of [`ServicePlan`]'s decision table, keyed purely on
/// `kill_user_processes` — shared verbatim by [`plan_service_install`] (the general,
/// exhaustively unit-tested decision table) and [`install_service`]'s own early
/// no-systemd short-circuit (skipped ahead of a wasted [`attempt_self_linger`] round
/// trip — see that call site's own doc), so the two identical match arms can never
/// silently drift out of sync with each other.
fn plan_without_systemd(kill_user_processes: Option<bool>) -> ServicePlan {
    match kill_user_processes {
        Some(false) => ServicePlan::DetachedProcess { survives_reboot: false },
        _ => ServicePlan::NeedsAdmin,
    }
}

/// See [`ServicePlan`]. Pure.
pub(crate) fn plan_service_install(
    is_root: bool,
    conflict: Option<&str>,
    systemd: Option<bool>,
    linger_ok: bool,
    sudo_available: bool,
    kill_user_processes: Option<bool>,
) -> ServicePlan {
    if let Some(c) = conflict {
        let (kind, path) = classify_conflict(c);
        return ServicePlan::Adopt(kind, path);
    }
    if is_root {
        return ServicePlan::SystemUnit;
    }
    if systemd != Some(true) {
        return plan_without_systemd(kill_user_processes);
    }
    if linger_ok {
        return ServicePlan::UserUnit;
    }
    if sudo_available {
        return ServicePlan::EscalateLingerThenUserUnit;
    }
    match kill_user_processes {
        Some(false) => ServicePlan::DetachedProcess { survives_reboot: false },
        _ => ServicePlan::NeedsAdmin,
    }
}

/// `printf '%s' "$HOME"` on `machine` — needed to render either unit file
/// ([`templates::render_user_unit`] / [`templates::render_system_unit`]).
async fn remote_home_dir(machine: &MachineRecord, known_hosts: Option<&str>) -> Result<String, BootstrapError> {
    run_ssh_on_machine(machine, known_hosts, "printf '%s' \"$HOME\"")
        .await
        .map_err(BootstrapError::Other)
}

/// `loginctl show-user <user> -p Linger` on `machine`, parsed into a bool. Any failure
/// to even run the check (unreachable, `loginctl` missing) reads as `false` — "not
/// confirmed enabled" is the safe default for a decision that gates whether
/// [`install_service`] tries to escalate.
async fn linger_is_enabled(machine: &MachineRecord, known_hosts: Option<&str>) -> bool {
    let cmd = format!("loginctl show-user {} -p Linger", crate::ipc::commands::shq(&machine.user));
    match run_ssh_on_machine(machine, known_hosts, &cmd).await {
        Ok(out) => out.trim() == "Linger=yes",
        Err(_) => false,
    }
}

/// Attempts `loginctl enable-linger <user>` WITHOUT `sudo` (per the empirical facts in
/// the brief: polkit's `org.freedesktop.login1.set-self-linger` allows this for the
/// user's OWN account on every distro this app targets), then re-checks via
/// [`linger_is_enabled`] — the attempt's own exit code is deliberately ignored (a
/// refusal there and a refusal on the re-check are the SAME "not enabled" outcome to
/// the caller; the re-check is the authoritative signal either way).
async fn attempt_self_linger(machine: &MachineRecord, known_hosts: Option<&str>) -> bool {
    let cmd = format!("loginctl enable-linger {}", crate::ipc::commands::shq(&machine.user));
    let _ = run_ssh_on_machine(machine, known_hosts, &cmd).await;
    linger_is_enabled(machine, known_hosts).await
}

/// Writes [`templates::render_system_unit`] to `/etc/systemd/system/flightdeckd.service`
/// and enables it — the ROOT-login path, so no `sudo` wrapper anywhere here (the brief's
/// own "no sudo wrapper" requirement: the ssh session itself already IS root).
async fn install_system_unit(machine: &MachineRecord, known_hosts: Option<&str>) -> Result<(), BootstrapError> {
    let home = remote_home_dir(machine, known_hosts).await?;
    let unit = templates::render_system_unit(&machine.user, &home)
        .map_err(|e| BootstrapError::Other(e.to_string()))?;
    let script = "cat > /etc/systemd/system/flightdeckd.service && systemctl daemon-reload && \
                   systemctl enable --now flightdeckd";
    let out = run_ssh_on_machine_stdin(machine, known_hosts, script, unit.as_bytes(), None, SSH_STDIN_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if out.success {
        Ok(())
    } else {
        Err(BootstrapError::Other(
            out.stderr.trim().lines().last().unwrap_or("could not install the system unit").to_string(),
        ))
    }
}

/// Writes [`templates::render_user_unit`] to `~/.config/systemd/user/flightdeckd.service`
/// and enables it — the NON-root path, run only once [`linger_is_enabled`] (or
/// [`attempt_self_linger`]) has already confirmed linger, so the unit actually survives
/// the session closing. `export XDG_RUNTIME_DIR=/run/user/$(id -u)` up front: a
/// non-login ssh session usually has no user bus attached yet, and exporting it here is
/// what lets `systemctl --user` find (or, via linger, start) the user's manager instead
/// of failing with "Failed to connect to bus".
async fn install_user_unit(machine: &MachineRecord, known_hosts: Option<&str>) -> Result<(), BootstrapError> {
    let home = remote_home_dir(machine, known_hosts).await?;
    let unit = templates::render_user_unit(&home).map_err(|e| BootstrapError::Other(e.to_string()))?;
    let script = "export XDG_RUNTIME_DIR=/run/user/$(id -u); \
                   mkdir -p ~/.config/systemd/user && \
                   cat > ~/.config/systemd/user/flightdeckd.service && \
                   systemctl --user daemon-reload && \
                   systemctl --user enable --now flightdeckd";
    let out = run_ssh_on_machine_stdin(machine, known_hosts, script, unit.as_bytes(), None, SSH_STDIN_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if out.success {
        Ok(())
    } else {
        Err(BootstrapError::Other(
            out.stderr.trim().lines().last().unwrap_or("could not install the user unit").to_string(),
        ))
    }
}

/// Launches `flightdeckd` as a `setsid`+`nohup`-detached process, run out of the SAME
/// `~/.local/bin/flightdeckd` [`upload_daemon`] targets for a fresh, non-root install —
/// the last-resort path, chosen ONLY when [`plan_service_install`] has already confirmed
/// `KillUserProcesses=no` (the one fact that makes this survive the ssh session closing
/// at all — see the brief's own empirical table). No `Restart=` here (nothing manages
/// it), and it does NOT survive a reboot — [`ServiceOutcome::DetachedProcess`] reports
/// both honestly.
///
/// ⚠️ Idempotency guard: neither B7's probe nor B8's `RESOLVE_DAEMON_TARGET_SCRIPT`
/// treat a detached-launched `~/.local/bin/flightdeckd` as a "conflict" (that path is
/// deliberately the FRESH-INSTALL target, not something either script would ever flag),
/// so a RETRIED [`install_service`] call — a transient [`verify_daemon_running`]
/// timeout, a re-run of the bootstrap wizard — would otherwise reach this exact branch
/// again and launch a SECOND, competing `flightdeckd` process, with nothing downstream
/// able to detect it (both would answer `flightdeckd status` identically). Checked live
/// against a fresh Docker fixture: running this function's own script twice left two
/// live `flightdeckd run` processes. [`daemon_already_running`] closes that gap by
/// checking first — never a bulletproof lock (there is still a narrow TOCTOU window
/// between the check and the spawn), but it turns the routine "retry after a timeout"
/// case, the one this is actually reachable from, into a genuine no-op.
async fn install_detached_process(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
) -> Result<(), BootstrapError> {
    if daemon_already_running(machine, known_hosts, ssh_bin_override).await {
        return Ok(());
    }
    let script = "setsid nohup \"$HOME/.local/bin/flightdeckd\" run >/dev/null 2>&1 </dev/null &";
    let out = run_ssh_on_machine_stdin(machine, known_hosts, script, &[], ssh_bin_override, SSH_STDIN_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if out.success {
        Ok(())
    } else {
        Err(BootstrapError::Other(
            out.stderr
                .trim()
                .lines()
                .last()
                .unwrap_or("could not launch the detached flightdeckd process")
                .to_string(),
        ))
    }
}

/// Whether `flightdeckd status` already reports the daemon running, via
/// [`daemon_status_cmd`] — the SAME application-level check [`verify_daemon_running`]
/// polls for (never a `pgrep`/`ps` cmdline match, which a renamed or re-exec'd process
/// could dodge). Used by [`install_detached_process`] as its idempotency guard. A
/// failure to even run the check (unreachable, no output) reads as "not confirmed
/// running" — the safe default for a decision that only ever gates "should we launch
/// one", never one that silently skips reporting a real failure to the caller.
async fn daemon_already_running(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
) -> bool {
    let cmd = daemon_status_cmd();
    match run_ssh_on_machine_stdin(machine, known_hosts, &cmd, &[], ssh_bin_override, SSH_STDIN_TIMEOUT).await {
        Ok(out) => out.success && out.stdout.contains("fd_status"),
        Err(_) => false,
    }
}

/// Which `systemctl` scope (if any) governs the daemon — feeds
/// [`verify_daemon_running`]'s crash-loop check; `None` for the detached-process
/// fallback, which nothing supervises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnitScope {
    System,
    User,
}

impl UnitScope {
    fn systemctl(self) -> &'static str {
        match self {
            Self::System => "systemctl",
            Self::User => "export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user",
        }
    }
}

const DAEMON_UP_POLL_ATTEMPTS: u32 = 10;
const DAEMON_UP_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The `flightdeckd status` command run by [`daemon_already_running`] /
/// [`verify_daemon_running`], resolving the binary via the crate's ONE shared
/// resolver ([`resolve_daemon_bin_expr`] — B11's unification of what used to be this
/// function's own, narrower PATH-then-`~/.local/bin` search, missing the
/// `/usr/local/bin` fallback the shared resolver also covers) rather than a bare
/// `flightdeckd` — a non-interactive ssh command never sources `.profile`/`.bashrc`, so
/// `~/.local/bin` is never on `PATH` for the NON-root install paths this module itself
/// uploads to (see [`templates::RESOLVE_DAEMON_TARGET_SCRIPT`]'s own doc for the
/// identical trap on the upload side) — VERIFIED live: without this resolution,
/// [`verify_daemon_running`] reported a false "did not come up" against fixture A/D
/// even though `systemctl is-active` showed the unit genuinely running (`command not
/// found` on the bare name). The root/system-unit path (`/usr/local/bin`) is
/// unaffected either way — it is on the default non-interactive `PATH` on every distro
/// this app targets.
fn daemon_status_cmd() -> String {
    format!("{} status 2>/dev/null", resolve_daemon_bin_expr("flightdeckd"))
}

/// Polls `flightdeckd status` up to [`DAEMON_UP_POLL_ATTEMPTS`] times
/// ([`DAEMON_UP_POLL_INTERVAL`] apart) for the real daemon's own `fd_status` response —
/// never just ASSUMED from an `enable --now`/detached-launch exit code, which proves
/// nothing about whether the process is actually still up a moment later (a
/// crash-looping unit exits 0 on `enable --now` every time). On failure to see it in
/// time, `unit_scope` (when the daemon is systemd-managed) is used for ONE more
/// diagnostic round trip — `systemctl is-active` + `NRestarts` — so a crash loop is
/// reported as exactly that, not a generic timeout.
async fn verify_daemon_running(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    unit_scope: Option<UnitScope>,
) -> Result<(), BootstrapError> {
    let status_cmd = daemon_status_cmd();
    for attempt in 0..DAEMON_UP_POLL_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(DAEMON_UP_POLL_INTERVAL).await;
        }
        if let Ok(out) = run_ssh_on_machine(machine, known_hosts, &status_cmd).await {
            if out.contains("fd_status") {
                return Ok(());
            }
        }
    }
    if let Some(scope) = unit_scope {
        let check =
            format!("{sc} is-active flightdeckd; {sc} show -p NRestarts --value flightdeckd", sc = scope.systemctl());
        if let Ok(out) = run_ssh_on_machine(machine, known_hosts, &check).await {
            let mut lines = out.lines();
            let active = lines.next().unwrap_or("unknown").trim();
            let restarts = lines.next().unwrap_or("").trim();
            if !restarts.is_empty() && restarts != "0" {
                return Err(BootstrapError::Other(format!(
                    "flightdeckd did not come up — the unit is crash-looping \
                     (systemctl is-active: {active}, {restarts} restart(s))"
                )));
            }
            return Err(BootstrapError::Other(format!(
                "flightdeckd did not come up in time (systemctl is-active: {active})"
            )));
        }
    }
    Err(BootstrapError::Other("flightdeckd did not come up in time".to_string()))
}

/// (B9) Set up `flightdeckd` to PERSIST on an already-paired, already-uploaded-to
/// (see [`upload_daemon`]) `machine`, choosing among a root-owned system unit, a
/// per-user unit (with self-`linger`, escalating to `sudo` only when self-linger is
/// refused AND passwordless `sudo` is available — see [`ServicePlan::
/// EscalateLingerThenUserUnit`]), a detached fallback, or adopting whatever B7's
/// `probe` already found — see [`plan_service_install`] for the exact decision table.
/// Every branch that installs something VERIFIES the daemon is actually up afterward
/// (see [`verify_daemon_running`]) before returning `Ok`.
///
/// ⚠️ `probe` MUST be the SAME [`RemoteProbeResult`] a caller already had BEFORE
/// calling [`upload_daemon`] — never a fresh re-probe taken after it. For a root
/// install, B8's `RESOLVE_DAEMON_TARGET_SCRIPT` targets `/usr/local/bin/flightdeckd`,
/// which IS one of the paths `bootstrap::connect::PROBE_SCRIPT`'s own conflict check
/// looks for (unlike the non-root `~/.local/bin/flightdeckd` target, which that script
/// deliberately excludes). A caller that re-probes in between (e.g. a UI wizard
/// refreshing displayed state) would see B8's own freshly-uploaded binary and
/// misreport it as a pre-existing conflict — this function would then return
/// `Adopted` and write NOTHING, silently leaving a fresh install with a binary in
/// place but no persistence at all while still reporting success (reproduced live
/// while building this module's own tests — see `live_install_service_root_gets_a_
/// system_unit`'s doc for how that test avoids it).
pub async fn install_service(
    machine: &MachineRecord,
    probe: &RemoteProbeResult,
    known_hosts: Option<&str>,
) -> Result<ServiceOutcome, BootstrapError> {
    if let Some(conflict) = probe.conflict.as_deref() {
        let (kind, unit_path) = classify_conflict(conflict);
        return Ok(ServiceOutcome::Adopted { kind, unit_path });
    }

    // Checked ahead of the root branch (not folded into `plan_service_install`,
    // which a root call site never actually reaches — see the `unreachable!` arm
    // below): a root login with no systemd would otherwise fall into
    // `install_system_unit`'s raw `systemctl` invocation and surface an opaque,
    // untyped ssh failure instead of the SAME typed `AdminRequired` the non-root
    // no-systemd case already gets just below. It is deliberately NOT routed into
    // the detached-process fallback either — that fallback's script hardcodes the
    // NON-root install target (`$HOME/.local/bin/flightdeckd`), which is the wrong
    // path for a root install (root's own target is `/usr/local/bin/flightdeckd`,
    // per `RESOLVE_DAEMON_TARGET_SCRIPT`).
    let is_root = machine.user == "root";
    if is_root && probe.systemd != Some(true) {
        return Err(BootstrapError::AdminRequired(
            "this server has no systemd — a root login has no automatable persistence \
             path here (its non-root detached fallback targets a different binary path \
             than a root install uses) — an administrator needs to set persistence up \
             manually"
                .to_string(),
        ));
    }
    if is_root {
        install_system_unit(machine, known_hosts).await?;
        verify_daemon_running(machine, known_hosts, Some(UnitScope::System)).await?;
        return Ok(ServiceOutcome::SystemUnit);
    }

    if probe.systemd != Some(true) {
        return match plan_without_systemd(probe.kill_user_processes) {
            ServicePlan::DetachedProcess { survives_reboot } => {
                install_detached_process(machine, known_hosts, None).await?;
                verify_daemon_running(machine, known_hosts, None).await?;
                Ok(ServiceOutcome::DetachedProcess { survives_reboot })
            }
            ServicePlan::NeedsAdmin => Err(BootstrapError::AdminRequired(
                "this server has no systemd and no confirmed way for a background process to \
                 survive logout — an administrator needs to set persistence up manually"
                    .to_string(),
            )),
            _ => unreachable!("plan_without_systemd only ever returns DetachedProcess or NeedsAdmin"),
        };
    }

    let linger_ok = attempt_self_linger(machine, known_hosts).await;
    let plan = plan_service_install(
        is_root,
        probe.conflict.as_deref(),
        probe.systemd,
        linger_ok,
        probe.passwordless_sudo == Some(true),
        probe.kill_user_processes,
    );

    match plan {
        ServicePlan::UserUnit => {
            install_user_unit(machine, known_hosts).await?;
            verify_daemon_running(machine, known_hosts, Some(UnitScope::User)).await?;
            Ok(ServiceOutcome::UserUnit)
        }
        ServicePlan::EscalateLingerThenUserUnit => {
            // Only reached when `probe.passwordless_sudo == Some(true)` (see
            // `plan_service_install`) — `escalate_persistence`'s own `sudo -n true`
            // fast path is expected to succeed here without ever needing a captured
            // password. `mask_sleep: true` — Armand's DEFAULT-ON product decision —
            // since this self-escalation has no UI checkbox to consult.
            escalate_persistence(machine, known_hosts, None, true).await?;
            if !linger_is_enabled(machine, known_hosts).await {
                return Err(BootstrapError::Other(
                    "linger was escalated via sudo but is still not enabled".to_string(),
                ));
            }
            install_user_unit(machine, known_hosts).await?;
            verify_daemon_running(machine, known_hosts, Some(UnitScope::User)).await?;
            Ok(ServiceOutcome::UserUnit)
        }
        ServicePlan::DetachedProcess { survives_reboot } => {
            install_detached_process(machine, known_hosts, None).await?;
            verify_daemon_running(machine, known_hosts, None).await?;
            Ok(ServiceOutcome::DetachedProcess { survives_reboot })
        }
        ServicePlan::NeedsAdmin => Err(BootstrapError::AdminRequired(
            "linger is refused and no passwordless sudo is available to escalate it — an \
             administrator needs to run `loginctl enable-linger` on this server"
                .to_string(),
        )),
        ServicePlan::Adopt(..) | ServicePlan::SystemUnit => {
            unreachable!("conflict and root are both handled before plan_service_install is even called")
        }
    }
}

// ============================================================================
// B9 — escalate_persistence
// ============================================================================

/// `sudo -n true` on `machine` — whether passwordless `sudo` works RIGHT NOW (never
/// trusted from a stale probe value: this is a security-relevant decision, checked live
/// every time [`escalate_persistence`] runs).
///
/// Returns `Err` for an ssh-level failure this crate already knows how to name
/// specifically — a host-key mismatch, or the ssh child failing to spawn at all —
/// rather than folding it into a plain `false`. An ordinary `sudo -n true` running and
/// simply exiting non-zero (no passwordless sudo configured — the routine, expected
/// case) is still `Ok(false)`: this only intercepts the failures that mean the ssh
/// round trip itself did not really happen the way it looks like it did. Mirrors
/// [`resolve_target_and_check`]'s / [`stream_upload`]'s own discipline (see their
/// docs) — without it, a stale/changed host key or an unreachable machine at this
/// exact call site would previously surface as [`BootstrapError::NeedsSudoPassword`]
/// ("this server needs a sudo password") instead of the real, potentially
/// security-relevant problem.
async fn sudo_dash_n_true(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
) -> Result<bool, BootstrapError> {
    let out = run_ssh_on_machine_stdin(machine, known_hosts, "sudo -n true", &[], ssh_bin_override, SSH_STDIN_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if !out.success && askpass::is_host_key_mismatch(&out.stderr) {
        return Err(BootstrapError::HostKeyMismatch);
    }
    Ok(out.success)
}

/// Runs `script` under passwordless `sudo -n` — only ever called once
/// [`sudo_dash_n_true`] has already confirmed it works, but re-asserts `-n` anyway so
/// this can never itself block on a password prompt if something changed in the
/// intervening instant.
async fn run_sudo_passwordless(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
    script: &str,
) -> Result<(), BootstrapError> {
    let remote = format!("sudo -n sh -c {}", crate::ipc::commands::shq(script));
    let out = run_ssh_on_machine_stdin(machine, known_hosts, &remote, &[], ssh_bin_override, SSH_STDIN_TIMEOUT)
        .await
        .map_err(BootstrapError::Other)?;
    if out.success {
        Ok(())
    } else {
        Err(BootstrapError::Other(
            out.stderr.trim().lines().last().unwrap_or("sudo escalation failed").to_string(),
        ))
    }
}

/// Whether `stderr` from a failed `sudo -S` invocation reads as "the password itself
/// was wrong" (as opposed to some other failure — `script` itself erroring, a dead
/// connection). Best-effort text matching against `sudo`'s own wording (`-S` reading a
/// single line then EOF, per `escalate_persistence`'s own doc, typically produces "no
/// password was provided" or "N incorrect password attempt(s)"; an interactive-feeling
/// retry loop instead says "Sorry, try again."), mirrored from `bootstrap::connect::
/// key_rejection_hint`'s own "match on the real wording, not a guess" discipline.
pub(crate) fn is_wrong_sudo_password(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("incorrect password") || lower.contains("try again") || lower.contains("no password was provided")
}

/// Pipes `password.expose()` (plus a trailing newline) to `sudo -S -p '' sh -c
/// '<script>'`'s own stdin — the ONE place in this crate a login/`sudo` password ever
/// touches a process — never as an argv element (would show up in a LOCAL `ps` listing
/// on this Mac) or an env var or a file, exactly the discipline
/// [`crate::bootstrap::askpass`] already uses for the SSH client's own login prompt (see
/// that module's doc) and [`crate::bootstrap::connect::install_key`] uses for the public
/// key itself. `-p ''` suppresses `sudo`'s own "[sudo] password for …: " prompt text
/// (nothing is reading it from a terminal anyway) so it can never leak into stdout by
/// accident.
async fn run_sudo_with_password(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    ssh_bin_override: Option<&Path>,
    script: &str,
    password: &SecretString,
) -> Result<(), BootstrapError> {
    let remote = format!("sudo -S -p '' sh -c {}", crate::ipc::commands::shq(script));
    let payload = format!("{}\n", password.expose());
    let out = run_ssh_on_machine_stdin(
        machine,
        known_hosts,
        &remote,
        payload.as_bytes(),
        ssh_bin_override,
        SSH_STDIN_TIMEOUT,
    )
    .await
    .map_err(BootstrapError::Other)?;
    if out.success {
        return Ok(());
    }
    if is_wrong_sudo_password(&out.stderr) {
        return Err(BootstrapError::NeedsSudoPassword);
    }
    let last_line = out.stderr.trim().lines().last().unwrap_or("sudo escalation failed").to_string();
    // Scrub any literal occurrence of the password before it becomes a
    // `BootstrapError` — mirrors `askpass::classify_output`'s own discipline for the
    // SAME reason: this is the one branch that forwards a raw line of the remote's own
    // stderr, and nothing stops a broken (or actively malicious) remote script from
    // echoing back whatever it read on stdin.
    let last_line =
        if password.expose().is_empty() { last_line } else { last_line.replace(password.expose(), "[redacted]") };
    Err(BootstrapError::Other(last_line))
}

/// (B9) Run [`templates::render_persistence_escalation`] on `machine` — the one
/// `sudo`-requiring step in the whole bootstrap flow (`loginctl enable-linger`, and,
/// when `mask_sleep`, masking every sleep/suspend target). Order, per Armand's decision:
/// try passwordless `sudo -n` FIRST ([`sudo_dash_n_true`], checked live, never off a
/// stale probe) — so a password is NEVER requested when it isn't needed. Only when that
/// fails does `captured_password` get used at all: `None` there means this call cannot
/// proceed without one, and returns [`BootstrapError::NeedsSudoPassword`] so a caller
/// (a wizard step) can prompt ONCE and retry with `Some`; a WRONG password (the sudo
/// password can genuinely differ from the login password that was captured) reaches the
/// SAME [`BootstrapError::NeedsSudoPassword`], never a bare generic failure — so a
/// caller always knows "ask again" is the right next step regardless of which of the
/// two cases it was.
pub async fn escalate_persistence(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    captured_password: Option<&SecretString>,
    mask_sleep: bool,
) -> Result<(), BootstrapError> {
    escalate_persistence_with_override(machine, known_hosts, captured_password, mask_sleep, None).await
}

/// The testable core of [`escalate_persistence`] — see the module doc for
/// `ssh_bin_override`.
pub(crate) async fn escalate_persistence_with_override(
    machine: &MachineRecord,
    known_hosts: Option<&str>,
    captured_password: Option<&SecretString>,
    mask_sleep: bool,
    ssh_bin_override: Option<&Path>,
) -> Result<(), BootstrapError> {
    let script = templates::render_persistence_escalation(&machine.user, mask_sleep);

    if sudo_dash_n_true(machine, known_hosts, ssh_bin_override).await? {
        return run_sudo_passwordless(machine, known_hosts, ssh_bin_override, &script).await;
    }

    let Some(password) = captured_password else {
        return Err(BootstrapError::NeedsSudoPassword);
    };
    run_sudo_with_password(machine, known_hosts, ssh_bin_override, &script, password).await
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Resolve the app's dedicated `known_hosts` path — mirrors
/// `bootstrap::connect::known_hosts_path` / `bootstrap::server_setup::known_hosts_path`,
/// each module's own tiny, App-Handle-only copy of this same resolution rather than a
/// shared helper (established convention in this directory already).
fn known_hosts_path(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned())
}

/// Emit a [`crate::ipc::events::BootstrapStepEvent`], logging (never swallowing) a
/// failed emit — mirrors `ipc::events::emit_logged`'s discipline for every other event
/// in this crate. Coarse-grained on purpose (one `started` + one `ok`/`failed` per
/// command, not per internal ssh round trip): the three commands below are each already
/// a single bounded operation from the UI's point of view, and `detail` on the terminal
/// event carries the actual outcome/error text.
fn emit_step(app: &tauri::AppHandle, machine: &MachineRecord, step: &str, status: &str, detail: Option<String>) {
    use tauri_specta::Event;
    let ev = crate::ipc::events::BootstrapStepEvent {
        machine_id: machine.id.clone(),
        host: machine.host.clone(),
        step: step.to_string(),
        status: status.to_string(),
        detail,
    };
    if let Err(e) = ev.emit(app) {
        eprintln!("[bootstrap::install] failed to emit bootstrap_step event: {e}");
    }
}

fn machine_by_id(app: &tauri::AppHandle, machine_id: &str) -> Result<MachineRecord, String> {
    use tauri::Manager;
    app.state::<Store>()
        .machine_by_id(machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())
}

/// Upload the static musl `flightdeckd` binary for `arch` onto `machine_id`. See
/// [`upload_daemon`].
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_upload_daemon(
    app: tauri::AppHandle,
    machine_id: String,
    arch: String,
) -> Result<UploadOutcome, String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let known_hosts = known_hosts_path(&app);
    emit_step(&app, &machine, "upload_daemon", "started", None);
    let result = upload_daemon(&app, &machine, &arch, known_hosts.as_deref()).await;
    match &result {
        Ok(outcome) => emit_step(&app, &machine, "upload_daemon", "ok", Some(format!("{outcome:?}"))),
        Err(e) => emit_step(&app, &machine, "upload_daemon", "failed", Some(e.to_string())),
    }
    result.map_err(|e| e.to_string())
}

/// Set up `flightdeckd` to persist on `machine_id`, given B7's `probe`. See
/// [`install_service`].
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_install_service(
    app: tauri::AppHandle,
    machine_id: String,
    probe: RemoteProbeResult,
) -> Result<ServiceOutcome, String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let known_hosts = known_hosts_path(&app);
    emit_step(&app, &machine, "install_service", "started", None);
    let result = install_service(&machine, &probe, known_hosts.as_deref()).await;
    match &result {
        Ok(outcome) => emit_step(&app, &machine, "install_service", "ok", Some(format!("{outcome:?}"))),
        Err(e) => emit_step(&app, &machine, "install_service", "failed", Some(e.to_string())),
    }
    result.map_err(|e| e.to_string())
}

/// Escalate persistence (linger + optional sleep-target masking) on `machine_id`. See
/// [`escalate_persistence`]. `password`, when given, is the ALREADY-CAPTURED server
/// login password from earlier in the wizard (never re-typed here) — held only long
/// enough to build a [`SecretString`] for this one call.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_escalate_persistence(
    app: tauri::AppHandle,
    machine_id: String,
    password: Option<String>,
    mask_sleep: bool,
) -> Result<(), String> {
    let machine = machine_by_id(&app, &machine_id)?;
    let known_hosts = known_hosts_path(&app);
    let secret = password.map(SecretString::new);
    emit_step(&app, &machine, "escalate_persistence", "started", None);
    let result = escalate_persistence(&machine, known_hosts.as_deref(), secret.as_ref(), mask_sleep).await;
    match &result {
        Ok(()) => emit_step(&app, &machine, "escalate_persistence", "ok", None),
        Err(e) => emit_step(&app, &machine, "escalate_persistence", "failed", Some(e.to_string())),
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn test_machine() -> MachineRecord {
        MachineRecord {
            id: "m1".to_string(),
            label: "test".to_string(),
            host: "example.invalid".to_string(),
            port: 22,
            user: "deploy".to_string(),
            identity_file: None,
            added_at: 0,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    fn probe(
        conflict: Option<&str>,
        os: Option<&str>,
        arch: Option<&str>,
        systemd: Option<bool>,
        passwordless_sudo: Option<bool>,
        linger: Option<bool>,
        kill_user_processes: Option<bool>,
    ) -> RemoteProbeResult {
        RemoteProbeResult {
            claude_version: Some("2.0.0".to_string()),
            claude_missing: false,
            flightdeckd_version: None,
            flightdeckd_missing: true,
            flightdeckd_outdated: false,
            conflict: conflict.map(str::to_string),
            os: os.map(str::to_string),
            arch: arch.map(str::to_string),
            systemd,
            passwordless_sudo,
            linger,
            kill_user_processes,
        }
    }

    // ---- daemon_binary_filename / resolve_daemon_binary_path (arch mapping + DaemonBinaryNotBundled) ----

    #[test]
    fn daemon_binary_filename_maps_the_two_known_arches() {
        assert_eq!(daemon_binary_filename("x86_64"), Some("flightdeckd-x86_64-unknown-linux-musl"));
        assert_eq!(daemon_binary_filename("aarch64"), Some("flightdeckd-aarch64-unknown-linux-musl"));
    }

    #[test]
    fn daemon_binary_filename_is_none_for_an_unmapped_arch() {
        assert_eq!(daemon_binary_filename("armv7l"), None);
        assert_eq!(daemon_binary_filename(""), None);
    }

    #[test]
    fn resolve_daemon_binary_path_finds_a_real_file_in_the_resource_dir() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("flightdeckd")).unwrap();
        let bin = dir.join("flightdeckd/flightdeckd-aarch64-unknown-linux-musl");
        std::fs::write(&bin, b"fake-binary-bytes").unwrap();

        let got = resolve_daemon_binary_path("aarch64", Some(&dir));
        assert_eq!(got, Ok(bin));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_daemon_binary_path_is_not_bundled_when_the_resource_dir_lacks_the_file() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let got = resolve_daemon_binary_path("x86_64", Some(&dir));
        assert_eq!(got, Err(BootstrapError::DaemonBinaryNotBundled("x86_64".to_string())));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_daemon_binary_path_is_not_bundled_with_no_resource_dir_at_all() {
        let got = resolve_daemon_binary_path("x86_64", None);
        assert_eq!(got, Err(BootstrapError::DaemonBinaryNotBundled("x86_64".to_string())));
    }

    #[test]
    fn resolve_daemon_binary_path_is_not_bundled_for_an_unmapped_arch_even_with_a_resource_dir() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-unmapped-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let got = resolve_daemon_binary_path("riscv64", Some(&dir));
        assert_eq!(got, Err(BootstrapError::DaemonBinaryNotBundled("riscv64".to_string())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The env override (`$TOSSE_FLIGHTDECKD_BIN_DIR`, the dev/test path) always wins
    /// over the resource dir, even when the resource dir ALSO has a (different) file —
    /// proves the precedence, not just that the env path works in isolation.
    /// `ENV_LOCK` below serializes this against every other test in this file that
    /// touches the same process-wide env var.
    #[tokio::test]
    async fn resolve_daemon_binary_path_env_override_wins_over_the_resource_dir() {
        let _guard = ENV_LOCK.lock().await;
        let env_dir = std::env::temp_dir().join(format!("flightdeck-install-test-envdir-{}", uuid::Uuid::new_v4()));
        let resource_dir =
            std::env::temp_dir().join(format!("flightdeck-install-test-resdir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&env_dir).unwrap();
        std::fs::create_dir_all(resource_dir.join("flightdeckd")).unwrap();
        let env_bin = env_dir.join("flightdeckd-x86_64-unknown-linux-musl");
        std::fs::write(&env_bin, b"env-bytes").unwrap();
        std::fs::write(resource_dir.join("flightdeckd/flightdeckd-x86_64-unknown-linux-musl"), b"resource-bytes")
            .unwrap();

        std::env::set_var(TOSSE_FLIGHTDECKD_BIN_DIR_ENV, &env_dir);
        let got = resolve_daemon_binary_path("x86_64", Some(&resource_dir));
        std::env::remove_var(TOSSE_FLIGHTDECKD_BIN_DIR_ENV);

        assert_eq!(got, Ok(env_bin));
        let _ = std::fs::remove_dir_all(&env_dir);
        let _ = std::fs::remove_dir_all(&resource_dir);
    }

    // ---- daemon_target_triple ----

    #[test]
    fn daemon_target_triple_strips_the_shared_filename_prefix() {
        assert_eq!(daemon_target_triple("x86_64"), Some("x86_64-unknown-linux-musl"));
        assert_eq!(daemon_target_triple("aarch64"), Some("aarch64-unknown-linux-musl"));
        assert_eq!(daemon_target_triple("armv7l"), None);
    }

    // ---- resolve_daemon_manifest (manifest resolution + DaemonManifestMissing) ----

    fn write_test_manifest(dir: &std::path::Path, targets_json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(r#"{{"version":"0.2.0","built_at":"2026-09-18T00:00:00Z","targets":{targets_json}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn resolve_daemon_manifest_parses_a_real_manifest_in_the_resource_dir() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-manifest-{}", uuid::Uuid::new_v4()));
        write_test_manifest(
            &dir.join("flightdeckd"),
            r#"{"x86_64-unknown-linux-musl":{"sha256":"aa","size":10},"aarch64-unknown-linux-musl":{"sha256":"bb","size":11}}"#,
        );

        let got = resolve_daemon_manifest(Some(&dir)).expect("a well-formed manifest must parse");
        assert_eq!(got.version, "0.2.0");
        assert_eq!(got.targets.len(), 2);
        assert_eq!(got.targets["x86_64-unknown-linux-musl"].sha256, "aa");
        assert_eq!(got.targets["x86_64-unknown-linux-musl"].size, 10);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_daemon_manifest_is_missing_when_the_resource_dir_has_no_manifest_json() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-nomanifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("flightdeckd")).unwrap();
        // A binary with no accompanying manifest — e.g. a hand-copied dist dir.
        std::fs::write(dir.join("flightdeckd/flightdeckd-x86_64-unknown-linux-musl"), b"bytes").unwrap();

        assert_eq!(resolve_daemon_manifest(Some(&dir)), Err(BootstrapError::DaemonManifestMissing));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_daemon_manifest_is_missing_with_no_resource_dir_at_all() {
        assert_eq!(resolve_daemon_manifest(None), Err(BootstrapError::DaemonManifestMissing));
    }

    #[test]
    fn resolve_daemon_manifest_is_missing_on_malformed_json() {
        let dir = std::env::temp_dir().join(format!("flightdeck-install-test-badjson-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("flightdeckd")).unwrap();
        std::fs::write(dir.join("flightdeckd/manifest.json"), b"{ not json").unwrap();

        assert_eq!(resolve_daemon_manifest(Some(&dir)), Err(BootstrapError::DaemonManifestMissing));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- verify_daemon_binary_sha256 (integrity gate before any upload) ----

    fn manifest_with(triple: &str, sha256: &str) -> DaemonManifest {
        let mut targets = std::collections::HashMap::new();
        targets.insert(triple.to_string(), DaemonManifestTarget { sha256: sha256.to_string(), size: 42 });
        DaemonManifest { version: "0.2.0".to_string(), built_at: "2026-09-18T00:00:00Z".to_string(), targets }
    }

    #[test]
    fn verify_daemon_binary_sha256_accepts_a_matching_hash() {
        let bytes = b"the-real-daemon-bytes";
        let manifest = manifest_with("x86_64-unknown-linux-musl", &sha256_hex(bytes));
        assert_eq!(verify_daemon_binary_sha256("x86_64", bytes, &manifest), Ok(()));
    }

    #[test]
    fn verify_daemon_binary_sha256_refuses_a_mismatched_hash_as_tampered_never_a_generic_error() {
        let bytes = b"tampered-or-corrupted-bytes";
        let manifest = manifest_with("x86_64-unknown-linux-musl", &sha256_hex(b"the-real-daemon-bytes"));
        let got = verify_daemon_binary_sha256("x86_64", bytes, &manifest);
        assert_eq!(
            got,
            Err(BootstrapError::DaemonBinaryTampered {
                arch: "x86_64".to_string(),
                expected: sha256_hex(b"the-real-daemon-bytes"),
                actual: sha256_hex(bytes),
            })
        );
    }

    #[test]
    fn verify_daemon_binary_sha256_is_missing_when_the_manifest_has_no_entry_for_this_arch() {
        // e.g. a partial TARGETS=aarch64-only build's manifest, asked to verify x86_64.
        let manifest = manifest_with("aarch64-unknown-linux-musl", &sha256_hex(b"bytes"));
        assert_eq!(
            verify_daemon_binary_sha256("x86_64", b"bytes", &manifest),
            Err(BootstrapError::DaemonManifestMissing)
        );
    }

    #[test]
    fn verify_daemon_binary_sha256_is_not_bundled_for_an_unmapped_arch() {
        let manifest = manifest_with("x86_64-unknown-linux-musl", &sha256_hex(b"bytes"));
        assert_eq!(
            verify_daemon_binary_sha256("riscv64", b"bytes", &manifest),
            Err(BootstrapError::DaemonBinaryNotBundled("riscv64".to_string()))
        );
    }

    // ---- sha256_hex ----

    #[test]
    fn sha256_hex_matches_the_well_known_empty_string_digest() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ---- parse_resolve_target_output ----

    #[test]
    fn parse_resolve_target_output_reads_target_and_existing_sha() {
        let stdout = "FLIGHTDECK_TARGET:/home/deploy/.local/bin/flightdeckd\nFLIGHTDECK_TARGET_SHA256:abc123\n";
        assert_eq!(
            parse_resolve_target_output(stdout, "", true),
            Ok(("/home/deploy/.local/bin/flightdeckd".to_string(), Some("abc123".to_string())))
        );
    }

    #[test]
    fn parse_resolve_target_output_none_sha_means_nothing_there_yet() {
        let stdout = "FLIGHTDECK_TARGET:/home/deploy/.local/bin/flightdeckd\nFLIGHTDECK_TARGET_SHA256:\n";
        assert_eq!(
            parse_resolve_target_output(stdout, "", true),
            Ok(("/home/deploy/.local/bin/flightdeckd".to_string(), None))
        );
    }

    #[test]
    fn parse_resolve_target_output_errors_when_ssh_itself_failed() {
        let err = parse_resolve_target_output("", "connection reset by peer\n", false)
            .expect_err("a failed ssh round trip must be an error");
        assert_eq!(err, BootstrapError::Other("connection reset by peer".to_string()));
    }

    #[test]
    fn parse_resolve_target_output_recognizes_a_host_key_mismatch() {
        let err = parse_resolve_target_output("", "Host key verification failed.\n", false)
            .expect_err("must be an error");
        assert_eq!(err, BootstrapError::HostKeyMismatch);
    }

    #[test]
    fn parse_resolve_target_output_errors_when_no_target_marker_shows_up() {
        let err = parse_resolve_target_output("some unrelated banner\n", "", true)
            .expect_err("success with no target marker must not be silently accepted");
        assert!(matches!(err, BootstrapError::Other(_)));
    }

    // ---- parse_upload_output ----

    #[test]
    fn parse_upload_output_ok_on_the_real_success_marker() {
        let stdout = "FLIGHTDECK_GOT_SIZE:100\nFLIGHTDECK_GOT_SHA256:abc\nFLIGHTDECK_UPLOAD_OK\n";
        assert_eq!(parse_upload_output(stdout, true, 100), Ok(()));
    }

    #[test]
    fn parse_upload_output_reports_truncated_with_the_reported_size() {
        let stdout = "FLIGHTDECK_GOT_SIZE:42\nFLIGHTDECK_GOT_SHA256:deadbeef\n";
        assert_eq!(
            parse_upload_output(stdout, false, 12345),
            Err(BootstrapError::UploadTruncated { expected: 12345, got: 42 })
        );
    }

    #[test]
    fn parse_upload_output_reports_truncated_with_got_zero_when_nothing_came_back() {
        assert_eq!(
            parse_upload_output("", false, 12345),
            Err(BootstrapError::UploadTruncated { expected: 12345, got: 0 })
        );
    }

    /// Success exit code alone is NOT enough — the OK marker must also be present, so a
    /// future script edit that drops it (or a truly bizarre partial-success shape) can
    /// never be silently reported as a real success.
    #[test]
    fn parse_upload_output_requires_the_ok_marker_even_on_a_successful_exit() {
        assert_eq!(
            parse_upload_output("", true, 100),
            Err(BootstrapError::UploadTruncated { expected: 100, got: 0 })
        );
    }

    /// A banner/MOTD (or leaked stderr) line that merely CONTAINS the marker as a
    /// substring — never on its own line — must not satisfy the check; only a
    /// line-anchored match does. Closes the review finding that this was a bare
    /// substring search.
    #[test]
    fn parse_upload_output_rejects_the_marker_as_a_mere_substring() {
        let stdout = "Welcome! FLIGHTDECK_UPLOAD_OK is not a real success line\nFLIGHTDECK_GOT_SIZE:42\n";
        assert_eq!(
            parse_upload_output(stdout, true, 12345),
            Err(BootstrapError::UploadTruncated { expected: 12345, got: 42 })
        );
    }

    // ---- classify_conflict ----

    #[test]
    fn classify_conflict_recognizes_a_system_unit() {
        assert_eq!(
            classify_conflict("an existing system unit at /etc/systemd/system/flightdeckd.service"),
            (AdoptedKind::SystemUnit, Some("/etc/systemd/system/flightdeckd.service".to_string()))
        );
    }

    #[test]
    fn classify_conflict_recognizes_an_existing_binary() {
        assert_eq!(
            classify_conflict("an existing flightdeckd binary at /usr/local/bin/flightdeckd"),
            (AdoptedKind::ExistingBinary, Some("/usr/local/bin/flightdeckd".to_string()))
        );
    }

    #[test]
    fn classify_conflict_recognizes_an_existing_config_with_no_path() {
        assert_eq!(
            classify_conflict("an existing ~/.flightdeckd/config.json"),
            (AdoptedKind::ExistingConfig, None)
        );
    }

    // ---- plan_service_install (pure branch-selection table) ----

    #[test]
    fn plan_conflict_always_adopts_regardless_of_everything_else() {
        let plan = plan_service_install(
            true,
            Some("an existing system unit at /etc/systemd/system/flightdeckd.service"),
            Some(true),
            true,
            true,
            Some(true),
        );
        assert_eq!(
            plan,
            ServicePlan::Adopt(AdoptedKind::SystemUnit, Some("/etc/systemd/system/flightdeckd.service".to_string()))
        );
    }

    #[test]
    fn plan_root_installs_the_system_unit() {
        let plan = plan_service_install(true, None, Some(true), false, false, None);
        assert_eq!(plan, ServicePlan::SystemUnit);
    }

    #[test]
    fn plan_non_root_with_linger_already_ok_installs_the_user_unit() {
        let plan = plan_service_install(false, None, Some(true), true, false, None);
        assert_eq!(plan, ServicePlan::UserUnit);
    }

    #[test]
    fn plan_linger_refused_with_sudo_available_escalates_then_user_unit() {
        let plan = plan_service_install(false, None, Some(true), false, true, Some(true));
        assert_eq!(plan, ServicePlan::EscalateLingerThenUserUnit);
    }

    #[test]
    fn plan_no_systemd_with_kill_user_processes_no_falls_back_to_detached() {
        let plan = plan_service_install(false, None, Some(false), false, false, Some(false));
        assert_eq!(plan, ServicePlan::DetachedProcess { survives_reboot: false });
    }

    #[test]
    fn plan_no_systemd_with_kill_user_processes_yes_needs_an_admin() {
        let plan = plan_service_install(false, None, Some(false), false, false, Some(true));
        assert_eq!(plan, ServicePlan::NeedsAdmin);
    }

    #[test]
    fn plan_no_systemd_with_kill_user_processes_unknown_needs_an_admin() {
        let plan = plan_service_install(false, None, None, false, false, None);
        assert_eq!(plan, ServicePlan::NeedsAdmin);
    }

    /// Systemd IS present, but linger is refused AND no sudo is available to escalate
    /// with — "everything refused" per the brief — falls to the SAME detached/needs-
    /// admin split as the no-systemd case, keyed on `kill_user_processes`.
    #[test]
    fn plan_systemd_present_linger_refused_no_sudo_falls_back_to_detached_when_safe() {
        let plan = plan_service_install(false, None, Some(true), false, false, Some(false));
        assert_eq!(plan, ServicePlan::DetachedProcess { survives_reboot: false });
    }

    #[test]
    fn plan_systemd_present_linger_refused_no_sudo_needs_an_admin_when_kill_user_processes_is_yes() {
        let plan = plan_service_install(false, None, Some(true), false, false, Some(true));
        assert_eq!(plan, ServicePlan::NeedsAdmin);
    }

    // ---- is_wrong_sudo_password ----

    #[test]
    fn is_wrong_sudo_password_recognizes_no_password_provided() {
        assert!(is_wrong_sudo_password("sudo: no password was provided\n"));
    }

    #[test]
    fn is_wrong_sudo_password_recognizes_incorrect_password_attempts() {
        assert!(is_wrong_sudo_password("sudo: 1 incorrect password attempt\n"));
    }

    #[test]
    fn is_wrong_sudo_password_recognizes_try_again() {
        assert!(is_wrong_sudo_password("Sorry, try again.\n"));
    }

    #[test]
    fn is_wrong_sudo_password_is_false_for_unrelated_failures() {
        assert!(!is_wrong_sudo_password("sudo: a command is required\n"));
        assert!(!is_wrong_sudo_password(""));
    }

    // ---- install_service's conflict short-circuit ----

    /// `install_service` must never make an ssh call at all when B7's probe already
    /// found a conflict — proven here with a `machine.host` that would fail DNS/
    /// connect if actually dialed (`test_machine()`'s `"example.invalid"`, a reserved
    /// non-resolvable TLD per RFC 2606): this test would hang or fail on a connect
    /// timeout if the "write nothing" claim were ever violated.
    #[tokio::test]
    async fn install_service_conflict_adopts_without_any_ssh_call() {
        let machine = test_machine();
        let p = probe(
            Some("an existing system unit at /etc/systemd/system/flightdeckd.service"),
            Some("Linux"),
            Some("aarch64"),
            Some(true),
            Some(true),
            Some(true),
            None,
        );
        let outcome = install_service(&machine, &p, None)
            .await
            .expect("adopting a conflict must never touch the network, let alone fail");
        assert_eq!(
            outcome,
            ServiceOutcome::Adopted {
                kind: AdoptedKind::SystemUnit,
                unit_path: Some("/etc/systemd/system/flightdeckd.service".to_string())
            }
        );
    }

    /// A root login on a box with no systemd (a minimal container image, for
    /// instance) must get the SAME typed `AdminRequired` the non-root no-systemd case
    /// already gets — never fall through into `install_system_unit`'s raw `systemctl`
    /// invocation and surface an opaque ssh failure. Proven with a non-resolvable host
    /// (mirrors `install_service_conflict_adopts_without_any_ssh_call`'s own
    /// discipline): this must return BEFORE any ssh call is even attempted.
    #[tokio::test]
    async fn install_service_root_without_systemd_is_a_typed_admin_required_error() {
        let mut machine = test_machine();
        machine.user = "root".to_string();
        let p = probe(None, Some("Linux"), Some("aarch64"), Some(false), None, None, None);

        let err = install_service(&machine, &p, None)
            .await
            .expect_err("a root login without systemd must never attempt the raw system-unit install");
        assert!(matches!(err, BootstrapError::AdminRequired(_)), "expected AdminRequired, got {err:?}");
    }

    // ========================================================================
    // Fake-ssh integration tests — a throwaway shell script standing in for the
    // real `ssh` binary, so the actual I/O SHAPE (bytes on the wire, a second
    // reconnect for cleanup) is proven without a live server. See the module
    // doc for why `ssh_bin_override` is safe against other tests' own real
    // `ssh` calls running concurrently (it only ever touches ONE spawned
    // child's own `PATH`, never this process's).
    // ========================================================================

    /// Serializes every test in this file that mutates process-wide env
    /// (`$TOSSE_FLIGHTDECKD_BIN_DIR`) against every OTHER one that does —
    /// mirrors `connect.rs`'s/`server_setup.rs`'s own `LIVE_FIXTURE_LOCK`
    /// pattern for a different shared resource. The fake-ssh tests below do
    /// NOT need this lock (they use `ssh_bin_override`, a per-Command env
    /// override, never a process-wide `std::env::set_var`).
    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A scratch dir on the CHILD's own `PATH` (never this process's) holding a fake
    /// `ssh` executable — `script`'s literal text, already carrying whatever
    /// canned values a given test needs (baked in via `format!`, not env vars — so
    /// there is nothing else to inject or clean up). Removed on drop.
    struct FakeSsh {
        dir: PathBuf,
    }

    impl FakeSsh {
        fn new(script: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("flightdeck-install-fakessh-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).expect("scratch dir for the fake ssh");
            let path = dir.join("ssh");
            std::fs::write(&path, script).expect("write the fake ssh script");
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&path, perms).unwrap();
            Self { dir }
        }

        fn path(&self) -> &Path {
            &self.dir
        }
    }

    impl Drop for FakeSsh {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A local file standing in for the daemon binary, with real, non-trivial content
    /// (so its sha256 is a real, unpredictable digest — never a value a test could
    /// accidentally hardcode-match against a fake "existing" sha). Removed on drop.
    struct FakeBinary {
        path: PathBuf,
        bytes: Vec<u8>,
    }

    impl FakeBinary {
        fn new(tag: &str, size: usize) -> Self {
            let path = std::env::temp_dir().join(format!("flightdeck-install-bin-{tag}-{}", uuid::Uuid::new_v4()));
            // Deterministic but non-trivial content — not all-zero, so a bug that
            // hashed the WRONG (e.g. empty) buffer would not accidentally match.
            let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            std::fs::write(&path, &bytes).expect("write the fake binary");
            Self { path, bytes }
        }
    }

    impl Drop for FakeBinary {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// A fake `ssh` that recognizes THIS module's own scripts by a unique substring
    /// each one alone carries (`RESOLVE_DAEMON_TARGET_SCRIPT` never mentions
    /// `FLIGHTDECK_UPLOAD_OK`; [`templates::render_upload_script`] never mentions the
    /// literal `rm -f` this module's own cleanup call is built from) — logs which kind
    /// of call arrived (`>> "$LOG"`) before answering it, so a test can assert exactly
    /// which calls did (and did NOT) happen.
    fn fake_ssh_already_current(log: &Path, target: &str, sha256: &str) -> String {
        format!(
            "#!/bin/bash\n\
             LOG={log}\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   *FLIGHTDECK_UPLOAD_OK*)\n\
             \x20       echo UPLOAD_INVOKED >> \"$LOG\"\n\
             \x20       exit 1\n\
             \x20       ;;\n\
             \x20   *)\n\
             \x20       echo RESOLVE_INVOKED >> \"$LOG\"\n\
             \x20       echo \"FLIGHTDECK_TARGET:{target}\"\n\
             \x20       echo \"FLIGHTDECK_TARGET_SHA256:{sha256}\"\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             esac\n",
            log = crate::ipc::commands::shq(&log.to_string_lossy()),
        )
    }

    #[tokio::test]
    async fn sha_equal_is_already_current_and_sends_zero_bytes() {
        let bin = FakeBinary::new("already-current", 4096);
        let local_sha = sha256_hex(&bin.bytes);
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_already_current(
            &log,
            "/home/deploy/.local/bin/flightdeckd",
            &local_sha,
        ));
        let machine = test_machine();

        let result = upload_daemon_from_path(&machine, None, &bin.path, Some(fake.path())).await;
        assert_eq!(result, Ok(UploadOutcome::AlreadyCurrent));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("RESOLVE_INVOKED"), "the resolve call must have run: {log_text:?}");
        assert!(
            !log_text.contains("UPLOAD_INVOKED"),
            "AlreadyCurrent must never invoke the upload script (zero bytes sent): {log_text:?}"
        );
        let _ = std::fs::remove_file(&log);
    }

    /// Fake `ssh` for the truncated-transfer test: the resolve call reports a
    /// DIFFERENT (fixed, fake) sha so the upload always proceeds; the upload call
    /// reads only `n_bytes` off stdin (simulating a connection that dies partway
    /// through — `head -c` closes its own stdin once satisfied, so the writer's
    /// remaining `write_all` best-effort-fails exactly like a real dropped pipe
    /// would) and reports that truncated size WITHOUT the `FLIGHTDECK_UPLOAD_OK`
    /// marker — mirroring the real script's own self-verification failing.
    fn fake_ssh_truncated_upload(log: &Path, n_bytes: usize) -> String {
        format!(
            "#!/bin/bash\n\
             LOG={log}\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   *FLIGHTDECK_UPLOAD_OK*)\n\
             \x20       echo UPLOAD_INVOKED >> \"$LOG\"\n\
             \x20       GOT=$(head -c {n_bytes} | wc -c | tr -d ' ')\n\
             \x20       echo \"FLIGHTDECK_GOT_SIZE:$GOT\"\n\
             \x20       exit 6\n\
             \x20       ;;\n\
             \x20   *\"rm -f \"*)\n\
             \x20       echo CLEANUP_INVOKED >> \"$LOG\"\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             \x20   *)\n\
             \x20       echo RESOLVE_INVOKED >> \"$LOG\"\n\
             \x20       echo \"FLIGHTDECK_TARGET:/home/deploy/.local/bin/flightdeckd\"\n\
             \x20       echo \"FLIGHTDECK_TARGET_SHA256:{stale_sha}\"\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             esac\n",
            log = crate::ipc::commands::shq(&log.to_string_lossy()),
            stale_sha = "f".repeat(64),
        )
    }

    #[tokio::test]
    async fn a_truncated_transfer_is_reported_and_cleaned_up() {
        let bin = FakeBinary::new("truncated", 10_000);
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_truncated_upload(&log, 123));
        let machine = test_machine();

        let result = upload_daemon_from_path(&machine, None, &bin.path, Some(fake.path())).await;
        assert_eq!(result, Err(BootstrapError::UploadTruncated { expected: 10_000, got: 123 }));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("UPLOAD_INVOKED"), "the upload script must have run: {log_text:?}");
        assert!(
            log_text.contains("CLEANUP_INVOKED"),
            "a failed upload must trigger the best-effort temp-file cleanup reconnect: {log_text:?}"
        );
        let _ = std::fs::remove_file(&log);
    }

    /// Fake `ssh` for [`upload_daemon_verified`]'s composition tests: resolves to a
    /// fresh target (no existing sha, so the upload always proceeds), then
    /// unconditionally succeeds the upload call — but first saves whatever bytes
    /// arrived on stdin to `<log>.bytes`, so a test can assert EXACTLY which buffer
    /// was streamed over the wire, not just that some upload happened.
    fn fake_ssh_upload_success(log: &Path, target: &str) -> String {
        format!(
            "#!/bin/bash\n\
             LOG={log}\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   *FLIGHTDECK_UPLOAD_OK*)\n\
             \x20       echo UPLOAD_INVOKED >> \"$LOG\"\n\
             \x20       cat > \"$LOG.bytes\"\n\
             \x20       echo FLIGHTDECK_UPLOAD_OK\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             \x20   *)\n\
             \x20       echo RESOLVE_INVOKED >> \"$LOG\"\n\
             \x20       echo \"FLIGHTDECK_TARGET:{target}\"\n\
             \x20       echo \"FLIGHTDECK_TARGET_SHA256:\"\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             esac\n",
            log = crate::ipc::commands::shq(&log.to_string_lossy()),
        )
    }

    /// A manifest whose single entry (for `arch`) expects `sha256` — built directly,
    /// bypassing [`bundled_daemon_manifest`]/`resolve_daemon_manifest` (which need a
    /// resource dir / app handle this unit test has neither of).
    fn manifest_for(arch: &str, sha256: &str, size: u64) -> DaemonManifest {
        let triple = daemon_target_triple(arch).expect("test arch must map to a known triple").to_string();
        DaemonManifest {
            version: "0.2.0-test".to_string(),
            built_at: "test".to_string(),
            targets: std::collections::HashMap::from([(
                triple,
                DaemonManifestTarget { sha256: sha256.to_string(), size },
            )]),
        }
    }

    /// Regression test for the composition bug the review flagged: [`upload_daemon`]
    /// (via its testable core, [`upload_daemon_verified`], since it needs no
    /// `tauri::AppHandle`) must upload the EXACT byte buffer it just verified against
    /// the manifest — never a second, independent read of the path. Proven here by
    /// capturing what actually hit the wire (via [`fake_ssh_upload_success`]'s stdin
    /// capture) and asserting it equals the on-disk bytes the sha256 was computed
    /// from, closing the "verified one read, uploaded a different one" gap.
    #[tokio::test]
    async fn upload_daemon_verified_uploads_exactly_the_bytes_it_verified() {
        let bin = FakeBinary::new("verified-upload", 4096);
        let manifest = manifest_for("aarch64", &sha256_hex(&bin.bytes), bin.bytes.len() as u64);
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_upload_success(&log, "/home/deploy/.local/bin/flightdeckd"));
        let machine = test_machine();

        let result =
            upload_daemon_verified(&machine, "aarch64", &bin.path, &manifest, None, Some(fake.path())).await;
        assert_eq!(result, Ok(UploadOutcome::Uploaded { restart_required: false }));

        let bytes_path = format!("{}.bytes", log.display());
        let sent = std::fs::read(&bytes_path).expect("the uploaded bytes must have been captured on the wire");
        assert_eq!(
            sent, bin.bytes,
            "must upload exactly the sha256-verified buffer, never a fresh re-read of the path"
        );

        let _ = std::fs::remove_file(&log);
        let _ = std::fs::remove_file(&bytes_path);
    }

    /// The other half of the same regression test: a binary whose sha256 does NOT
    /// match its manifest entry (simulating either real tampering, or the disk
    /// changing between an earlier read and this one) is refused — and, crucially,
    /// this happens BEFORE any ssh call at all (the log file stays empty), proving
    /// [`upload_daemon_verified`] never uploads unverified bytes on a mismatch.
    #[tokio::test]
    async fn upload_daemon_verified_refuses_a_tampered_binary_and_never_touches_the_network() {
        let bin = FakeBinary::new("tampered-upload", 4096);
        let manifest = manifest_for("aarch64", &"f".repeat(64), bin.bytes.len() as u64);
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_upload_success(&log, "/home/deploy/.local/bin/flightdeckd"));
        let machine = test_machine();

        let result =
            upload_daemon_verified(&machine, "aarch64", &bin.path, &manifest, None, Some(fake.path())).await;
        assert!(
            matches!(result, Err(BootstrapError::DaemonBinaryTampered { .. })),
            "expected DaemonBinaryTampered, got {result:?}"
        );

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.is_empty(), "a tampered binary must never invoke ssh at all: {log_text:?}");
        let bytes_path = format!("{}.bytes", log.display());
        assert!(!Path::new(&bytes_path).exists(), "nothing must ever have been streamed");

        let _ = std::fs::remove_file(&log);
    }

    // ---- install_detached_process idempotency (fake ssh) ----

    /// A fake `ssh` for [`install_detached_process`]'s idempotency guard: any call
    /// whose LAST arg contains `setsid nohup` logs `SPAWN_INVOKED` (the actual launch);
    /// every other call (the `flightdeckd status` idempotency check) logs
    /// `STATUS_INVOKED` and either reports the daemon already up (`already_running`) or
    /// fails the way a not-yet-running daemon does.
    fn fake_ssh_detached_process(log: &Path, already_running: bool) -> String {
        let status_body = if already_running {
            "echo '{\"type\":\"fd_status\"}'\n\x20       exit 0"
        } else {
            "exit 1"
        };
        format!(
            "#!/bin/bash\n\
             LOG={log}\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   *'setsid nohup'*)\n\
             \x20       echo SPAWN_INVOKED >> \"$LOG\"\n\
             \x20       exit 0\n\
             \x20       ;;\n\
             \x20   *)\n\
             \x20       echo STATUS_INVOKED >> \"$LOG\"\n\
             \x20       {status_body}\n\
             \x20       ;;\n\
             esac\n",
            log = crate::ipc::commands::shq(&log.to_string_lossy()),
        )
    }

    /// PROVES the B8/B9 review fix: a RETRIED `install_service` call (a transient
    /// `verify_daemon_running` timeout, a re-run of the bootstrap wizard) reaching
    /// `install_detached_process` a second time — while the daemon it already launched
    /// is still up — must never spawn a SECOND, competing process.
    #[tokio::test]
    async fn detached_process_already_running_skips_the_spawn() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_detached_process(&log, true));
        let machine = test_machine();

        install_detached_process(&machine, None, Some(fake.path()))
            .await
            .expect("must succeed when the daemon is already confirmed running");

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("STATUS_INVOKED"), "must check before launching: {log_text:?}");
        assert!(
            !log_text.contains("SPAWN_INVOKED"),
            "an already-running daemon must never be launched a second time: {log_text:?}"
        );
        let _ = std::fs::remove_file(&log);
    }

    /// The ordinary, fresh-install case: nothing is running yet, so the launch DOES
    /// happen — the idempotency guard must never turn into a guard against ever
    /// launching anything at all.
    #[tokio::test]
    async fn detached_process_not_running_launches_it() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_ssh_detached_process(&log, false));
        let machine = test_machine();

        install_detached_process(&machine, None, Some(fake.path()))
            .await
            .expect("must succeed on a fresh install with nothing running yet");

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("STATUS_INVOKED"));
        assert!(log_text.contains("SPAWN_INVOKED"), "a fresh install must actually launch the process: {log_text:?}");
        let _ = std::fs::remove_file(&log);
    }

    // ---- escalate_persistence ordering (fake sudo) ----

    /// Fake `ssh` for `escalate_persistence`'s ordering tests: answers `sudo -n true`
    /// with `n_true_ok`, `sudo -n sh -c ...` with `n_sh_ok`, and `sudo -S -p '' sh -c
    /// ...` by reading the piped password line and comparing it to `expected_password`
    /// — `s_result` controls what it reports (`"ok"` / `"wrong"` / a case that should
    /// never be reached given `expected_password`). Every branch logs which case fired.
    fn fake_sudo_ssh(log: &Path, n_true_ok: bool, n_sh_ok: bool, expected_password: &str, s_ok: bool) -> String {
        format!(
            "#!/bin/bash\n\
             LOG={log}\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   \"sudo -n true\")\n\
             \x20       echo N_TRUE_INVOKED >> \"$LOG\"\n\
             \x20       {n_true_exit}\n\
             \x20       ;;\n\
             \x20   *\"sudo -n sh -c \"*)\n\
             \x20       echo N_SH_INVOKED >> \"$LOG\"\n\
             \x20       {n_sh_exit}\n\
             \x20       ;;\n\
             \x20   *\"sudo -S -p '' sh -c \"*)\n\
             \x20       echo S_INVOKED >> \"$LOG\"\n\
             \x20       read -r got\n\
             \x20       if [ \"$got\" = {expected_password} ]; then\n\
             \x20           echo PASSWORD_MATCHED >> \"$LOG\"\n\
             \x20       else\n\
             \x20           echo PASSWORD_MISMATCHED >> \"$LOG\"\n\
             \x20       fi\n\
             \x20       {s_exit}\n\
             \x20       ;;\n\
             \x20   *)\n\
             \x20       echo UNEXPECTED_INVOKED >> \"$LOG\"\n\
             \x20       exit 1\n\
             \x20       ;;\n\
             esac\n",
            log = crate::ipc::commands::shq(&log.to_string_lossy()),
            n_true_exit = if n_true_ok { "exit 0" } else { "exit 1" },
            n_sh_exit = if n_sh_ok { "exit 0" } else { "exit 1" },
            expected_password = crate::ipc::commands::shq(expected_password),
            s_exit = if s_ok {
                "exit 0".to_string()
            } else {
                "echo 'Sorry, try again.' >&2; exit 1".to_string()
            },
        )
    }

    #[tokio::test]
    async fn escalate_sudo_n_ok_never_touches_the_captured_password() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_sudo_ssh(&log, true, true, "SHOULD_NEVER_BE_SENT", true));
        let machine = test_machine();
        let poison = SecretString::new("SHOULD_NEVER_BE_SENT".to_string());

        let result =
            escalate_persistence_with_override(&machine, None, Some(&poison), true, Some(fake.path())).await;
        assert_eq!(result, Ok(()));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("N_TRUE_INVOKED"));
        assert!(log_text.contains("N_SH_INVOKED"), "must escalate via the passwordless path: {log_text:?}");
        assert!(
            !log_text.contains("S_INVOKED"),
            "sudo -n succeeding must mean `sudo -S` (the captured-password path) is never even invoked: {log_text:?}"
        );
        assert!(!log_text.contains("SHOULD_NEVER_BE_SENT"));
        let _ = std::fs::remove_file(&log);
    }

    #[tokio::test]
    async fn escalate_sudo_n_fails_falls_back_to_the_captured_password_with_no_second_prompt() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_sudo_ssh(&log, false, false, "correct-horse-battery", true));
        let machine = test_machine();
        let password = SecretString::new("correct-horse-battery".to_string());

        let result =
            escalate_persistence_with_override(&machine, None, Some(&password), true, Some(fake.path())).await;
        assert_eq!(result, Ok(()));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("N_TRUE_INVOKED"));
        assert!(!log_text.contains("N_SH_INVOKED"), "sudo -n true failing must skip the passwordless path entirely");
        assert!(log_text.contains("S_INVOKED"));
        assert!(log_text.contains("PASSWORD_MATCHED"));
        assert_eq!(log_text.matches("S_INVOKED").count(), 1, "no second prompt/attempt");
        let _ = std::fs::remove_file(&log);
    }

    #[tokio::test]
    async fn escalate_both_sudo_paths_failing_reports_needs_sudo_password() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_sudo_ssh(&log, false, false, "correct-horse-battery", false));
        let machine = test_machine();
        let wrong = SecretString::new("wrong-password".to_string());

        let result =
            escalate_persistence_with_override(&machine, None, Some(&wrong), true, Some(fake.path())).await;
        assert_eq!(result, Err(BootstrapError::NeedsSudoPassword));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("S_INVOKED"));
        let _ = std::fs::remove_file(&log);
    }

    #[tokio::test]
    async fn escalate_sudo_n_fails_with_no_captured_password_needs_sudo_password_without_an_s_attempt() {
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_sudo_ssh(&log, false, false, "irrelevant", true));
        let machine = test_machine();

        let result = escalate_persistence_with_override(&machine, None, None, true, Some(fake.path())).await;
        assert_eq!(result, Err(BootstrapError::NeedsSudoPassword));

        let log_text = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(log_text.contains("N_TRUE_INVOKED"));
        assert!(!log_text.contains("S_INVOKED"), "with no captured password at all, `sudo -S` must never even be tried");
        let _ = std::fs::remove_file(&log);
    }

    /// A fake `ssh` whose `sudo -n true` call fails the way a genuinely broken
    /// ssh-level connection would (an ssh-itself failure carrying OpenSSH's own
    /// host-key wording on stderr) — never a real `sudo` round trip at all.
    fn fake_ssh_host_key_mismatch_on_sudo_n_true() -> String {
        "#!/bin/bash\n\
         last=\"${@: -1}\"\n\
         case \"$last\" in\n\
         \x20   \"sudo -n true\")\n\
         \x20       echo 'Host key verification failed.' >&2\n\
         \x20       exit 255\n\
         \x20       ;;\n\
         \x20   *)\n\
         \x20       exit 1\n\
         \x20       ;;\n\
         esac\n"
            .to_string()
    }

    /// PROVES the review fix: a host-key mismatch on the very first `sudo -n true`
    /// probe must surface as `HostKeyMismatch`, never get collapsed into the ordinary
    /// "no passwordless sudo, ask for a password" case — even with NO captured
    /// password at all, which is exactly the state `bootstrap_escalate_persistence` is
    /// normally first called in (so the OLD behavior would have reported the much more
    /// misleading `NeedsSudoPassword` here).
    #[tokio::test]
    async fn escalate_sudo_n_true_host_key_mismatch_is_reported_not_needs_sudo_password() {
        let fake = FakeSsh::new(&fake_ssh_host_key_mismatch_on_sudo_n_true());
        let machine = test_machine();

        let result = escalate_persistence_with_override(&machine, None, None, true, Some(fake.path())).await;
        assert_eq!(result, Err(BootstrapError::HostKeyMismatch));
    }

    /// Mirrors `askpass.rs`'s own `askpass_errors_never_contain_the_test_password`
    /// discipline for this module: drives every function here that ever TOUCHES a
    /// captured sudo password down a REAL failure path (a wrong password, and a
    /// remote that reflects the password back in its own stderr) and greps every
    /// resulting `BootstrapError`'s rendering for the literal secret.
    #[tokio::test]
    async fn escalate_errors_never_contain_the_captured_password() {
        const SECRET: &str = "sUp3r-s3cr3t-sudo-p4ssw0rd-7x2q";
        let mut rendered = Vec::new();

        // (1) An ordinary wrong-password rejection.
        let log = std::env::temp_dir().join(format!("flightdeck-install-log-{}", uuid::Uuid::new_v4()));
        let fake = FakeSsh::new(&fake_sudo_ssh(&log, false, false, "the-real-password", false));
        let machine = test_machine();
        let wrong = SecretString::new(SECRET.to_string());
        let err = escalate_persistence_with_override(&machine, None, Some(&wrong), true, Some(fake.path()))
            .await
            .expect_err("a wrong password must be an error");
        rendered.push(err.to_string());
        let _ = std::fs::remove_file(&log);

        // (2) A remote that REFLECTS the password back in its own stderr, on a
        // failure that does NOT match `is_wrong_sudo_password`'s wording (so it falls
        // through to the raw-stderr `Other` branch — the one path that forwards
        // remote text at all).
        let reflecting = format!(
            "#!/bin/bash\n\
             last=\"${{@: -1}}\"\n\
             case \"$last\" in\n\
             \x20   \"sudo -n true\") exit 1 ;;\n\
             \x20   *\"sudo -S -p '' sh -c \"*)\n\
             \x20       read -r got\n\
             \x20       echo \"remote saw: $got\" >&2\n\
             \x20       exit 1\n\
             \x20       ;;\n\
             \x20   *) exit 1 ;;\n\
             esac\n"
        );
        let fake2 = FakeSsh::new(&reflecting);
        let leak_secret = SecretString::new(SECRET.to_string());
        let err2 = escalate_persistence_with_override(&machine, None, Some(&leak_secret), true, Some(fake2.path()))
            .await
            .expect_err("a reflecting remote must still be an error");
        rendered.push(err2.to_string());

        for r in &rendered {
            assert!(!r.contains(SECRET), "a BootstrapError rendering leaked the sudo password: {r:?}");
        }
    }

    // ========================================================================
    // Live fixture tests (B8/B9) — need Docker (colima start) + the
    // `flightdeckd/live/bootstrap-fixtures` fixtures in this same repo.
    // `cargo test --lib -- --ignored --nocapture`.
    // ========================================================================
    mod live {
        use super::*;
        use std::path::PathBuf;

        /// Serializes every live test below against every OTHER live test in this
        /// crate that touches the SAME fixture containers — mirrors `connect.rs`'s /
        /// `server_setup.rs`'s own `LIVE_FIXTURE_LOCK`: `fixture.sh up` always
        /// `docker rm -f`s then `docker run`s fresh, so two tests racing the same
        /// letter would tear down state out from under each other.
        static LIVE_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        /// Locates the `flightdeckd` crate as an ancestor descendant of this crate's
        /// own checkout — mirrors `connect.rs`'s/`server_setup.rs`'s own helper of the
        /// same name. `flightdeckd` moved into this repo (imported from
        /// `flightdeck-server`, see `flightdeckd/docs/MONOREPO-MOVE.md`).
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

        fn fixture_down(letter: &str) {
            let script = flightdeckd_crate_dir().join("live/bootstrap-fixtures/fixture.sh");
            let _ = std::process::Command::new("bash").arg(&script).args(["down", letter]).output();
        }

        /// Runs a plain (password, no key yet) command against a fixture over
        /// `bootstrap::askpass`'s own first-contact relay — used by these tests only
        /// to install the throwaway key, exactly like every other live bootstrap test
        /// in this crate.
        async fn install_key_via_password(port: u16, user: &str, password: &str, key: &ThrowawayKey) {
            use crate::bootstrap::askpass::{bootstrap_ssh_command, run_with_password};
            let remote = format!(
                "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo {} >> ~/.ssh/authorized_keys && \
                 chmod 600 ~/.ssh/authorized_keys",
                crate::ipc::commands::shq(&key.public)
            );
            let cmd = bootstrap_ssh_command(user, "127.0.0.1", port, None, None, &remote)
                .expect("a fixed literal test user/host must always validate");
            let out = run_with_password(cmd, password, None, Duration::from_secs(15))
                .await
                .expect("installing the throwaway key over the fixture's documented password must succeed");
            assert!(out.status.success(), "key install failed: {}", String::from_utf8_lossy(&out.stderr));
        }

        struct ThrowawayKey {
            dir: PathBuf,
            private: PathBuf,
            public: String,
        }

        impl ThrowawayKey {
            fn generate(tag: &str) -> Self {
                let dir = std::env::temp_dir().join(format!("flightdeck-b8b9-live-{tag}-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&dir).expect("scratch dir for the throwaway key");
                let private = dir.join("id_ed25519");
                let out = std::process::Command::new("ssh-keygen")
                    .args(["-t", "ed25519", "-f"])
                    .arg(&private)
                    .args(["-N", "", "-C", "flightdeck-b8b9-live-test"])
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

        struct ScratchKnownHosts(PathBuf);
        impl ScratchKnownHosts {
            fn new(tag: &str) -> Self {
                let path = std::env::temp_dir().join(format!("flightdeck-b8b9-known-hosts-{tag}-{}", uuid::Uuid::new_v4()));
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

        fn fixture_machine(port: u16, user: &str, key: &ThrowawayKey) -> MachineRecord {
            MachineRecord {
                id: format!("live-b8b9-{port}"),
                label: format!("live-b8b9-fixture-{port}"),
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

        /// Points `$TOSSE_FLIGHTDECKD_BIN_DIR` at this repo's real, committed dist
        /// binaries (see the module doc + `daemon_binary_path`'s own doc) for the
        /// duration of the closure, serialized via `ENV_LOCK` against every other test
        /// in this file that touches the same process-wide var — restored afterward
        /// regardless of how the closure returns.
        async fn with_real_dist_dir<F, Fut, T>(f: F) -> T
        where
            F: FnOnce(PathBuf) -> Fut,
            Fut: std::future::Future<Output = T>,
        {
            let _guard = super::ENV_LOCK.lock().await;
            let dist = flightdeckd_crate_dir().join("target/deploy/wave2-089a8f2-0.2.0");
            assert!(
                dist.is_dir(),
                "expected the committed dist binaries at {} — build/commit them first",
                dist.display()
            );
            let previous = std::env::var("TOSSE_FLIGHTDECKD_BIN_DIR").ok();
            std::env::set_var("TOSSE_FLIGHTDECKD_BIN_DIR", &dist);
            let result = f(dist).await;
            match previous {
                Some(p) => std::env::set_var("TOSSE_FLIGHTDECKD_BIN_DIR", p),
                None => std::env::remove_var("TOSSE_FLIGHTDECKD_BIN_DIR"),
            }
            result
        }

        const FIXTURE_A_PORT: u16 = 2231;
        const FIXTURE_A_USER: &str = "deploy";
        const FIXTURE_A_PASSWORD: &str = "deploy-pw";
        const FIXTURE_B_PORT: u16 = 2232;
        const FIXTURE_B_USER: &str = "root";
        const FIXTURE_B_PASSWORD: &str = "root-pw";
        const FIXTURE_C_PORT: u16 = 2233;
        const FIXTURE_C_USER: &str = "josty";
        const FIXTURE_C_PASSWORD: &str = "josty-pw";
        const FIXTURE_D_PORT: u16 = 2234;
        const FIXTURE_D_USER: &str = "nosudo";
        const FIXTURE_D_PASSWORD: &str = "nosudo-pw";

        /// This host's own arch, matching `RemoteProbeResult::arch` shape (`uname -m`
        /// inside the fixture containers, which run under Docker's own arch — same
        /// machine as this test process, so `std::env::consts::ARCH` (`"aarch64"` /
        /// `"x86_64"`) matches directly).
        fn host_arch() -> &'static str {
            std::env::consts::ARCH
        }

        /// PROVES B8 end to end against a genuinely fresh node (fixture A): the very
        /// first upload is `Uploaded { restart_required: false }` (nothing was there
        /// before), a second upload of the SAME bytes is `AlreadyCurrent`, and the
        /// uploaded binary is real/executable on the server (`flightdeckd --version`).
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_upload_daemon_fresh_node_then_already_current() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let key = ThrowawayKey::generate("upload-fresh");
            install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
            let kh = ScratchKnownHosts::new("upload-fresh");

            with_real_dist_dir(|dist| async move {
                let local_path = dist.join(format!(
                    "flightdeckd-{}-unknown-linux-musl",
                    if host_arch() == "aarch64" { "aarch64" } else { "x86_64" }
                ));

                let first = upload_daemon_from_path(&machine, kh.path(), &local_path, None)
                    .await
                    .expect("the first upload to a fresh node must succeed");
                assert_eq!(first, UploadOutcome::Uploaded { restart_required: false });

                let version = run_ssh_on_machine(&machine, kh.path(), "$HOME/.local/bin/flightdeckd --version")
                    .await
                    .expect("the uploaded binary must actually run");
                assert!(!version.trim().is_empty(), "flightdeckd --version produced no output");

                let second = upload_daemon_from_path(&machine, kh.path(), &local_path, None)
                    .await
                    .expect("the second, identical upload must succeed");
                assert_eq!(second, UploadOutcome::AlreadyCurrent);
            })
            .await;

            fixture_down("a");
        }

        /// PROVES B8's `AlreadyCurrent` path against fixture C, whose pre-baked
        /// `/usr/local/bin/flightdeckd` is BYTE-IDENTICAL to the committed dist binary
        /// on this dev machine's own arch (verified by hand: both are the wave2 build)
        /// — meaning this exercises the READ-ONLY sha comparison against a binary this
        /// SSH user (`josty`, non-root) could not actually WRITE to without sudo
        /// (`/usr/local/bin` is root-owned) — proving upload never even attempts that.
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_upload_daemon_against_fixture_c_is_already_current() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("c");
            let key = ThrowawayKey::generate("upload-c");
            install_key_via_password(FIXTURE_C_PORT, FIXTURE_C_USER, FIXTURE_C_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_C_PORT, FIXTURE_C_USER, &key);
            let kh = ScratchKnownHosts::new("upload-c");

            with_real_dist_dir(|dist| async move {
                let local_path = dist.join(format!("flightdeckd-{}-unknown-linux-musl", host_arch()));
                let outcome = upload_daemon_from_path(&machine, kh.path(), &local_path, None).await;
                assert_eq!(
                    outcome,
                    Ok(UploadOutcome::AlreadyCurrent),
                    "fixture C's pre-baked binary is expected to byte-match the committed dist build \
                     for this host's own arch — if this fails after a real flightdeckd version bump, \
                     rebuild fixture C's image (fixture.sh up c) against the new dist binary first"
                );
            })
            .await;

            fixture_down("c");
        }

        /// Resolves the SAME way `bootstrap::connect::PROBE_SCRIPT` does (PATH, then
        /// `/usr/local/bin`, then `~/.local/bin`) and runs `flightdeckd init` via that
        /// FULL path — never a bare `flightdeckd`. `bootstrap::server_setup::run_init`
        /// (B10, already landed) invokes a bare `flightdeckd`, which relies on PATH
        /// already including wherever B8 placed the binary: true when adopting an
        /// install that was already on PATH, but NOT for a fresh upload to
        /// `~/.local/bin/flightdeckd` — a non-interactive ssh command never sources
        /// `.profile`/`.bashrc`, so it never has `~/.local/bin` on PATH (the SAME gap
        /// `server_setup.rs`'s own live tests already document and work around for
        /// `claude`, see `install_claude_on_fixture_a`'s doc there). This is a test-only
        /// workaround — B10 itself is out of scope for B8/B9 and is not modified — see
        /// this crate's own open-issues note for the real fix this integration gap
        /// needs (B10 resolving the SAME way B7/B8/B9 already do, or B8 always leaving
        /// something PATH-resolvable behind).
        async fn init_via_resolved_path(machine: &MachineRecord, known_hosts: Option<&str>, label: &str) {
            let resolve = "if command -v flightdeckd >/dev/null 2>&1; then command -v flightdeckd; \
                            elif [ -x /usr/local/bin/flightdeckd ]; then echo /usr/local/bin/flightdeckd; \
                            else echo \"$HOME/.local/bin/flightdeckd\"; fi";
            let bin = run_ssh_on_machine(machine, known_hosts, resolve)
                .await
                .expect("resolving the flightdeckd path must succeed")
                .trim()
                .to_string();
            let cmd =
                format!("{} init --label {}", crate::ipc::commands::shq(&bin), crate::ipc::commands::shq(label));
            run_ssh_on_machine(machine, known_hosts, &cmd)
                .await
                .expect("flightdeckd init (via its resolved full path) must succeed");
        }

        /// PROVES B9 end to end against fixture B (root login): a root-owned SYSTEM
        /// unit, enabled and actually running (`flightdeckd status` answers). Probes
        /// FIRST (mirroring the real B7 -> B8 -> B10 -> B9 order) and reuses that SAME
        /// probe for `install_service` — probing AGAIN after the upload would see B8's
        /// OWN freshly-placed `/usr/local/bin/flightdeckd` and misreport it as a
        /// pre-existing conflict (reproduced while building this test).
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_install_service_root_gets_a_system_unit() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("b");
            let key = ThrowawayKey::generate("service-root");
            install_key_via_password(FIXTURE_B_PORT, FIXTURE_B_USER, FIXTURE_B_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_B_PORT, FIXTURE_B_USER, &key);
            let kh = ScratchKnownHosts::new("service-root");

            let probe_result = crate::bootstrap::connect::probe(
                &crate::bootstrap::connect::BootstrapTarget {
                    host: machine.host.clone(),
                    port: machine.port,
                    user: machine.user.clone(),
                },
                machine.identity_file.as_deref().unwrap(),
                kh.path().unwrap(),
            )
            .await
            .expect("B7 probe against fixture B must succeed");
            assert!(probe_result.conflict.is_none(), "a fresh fixture B must not already report a conflict");

            with_real_dist_dir(|dist| async move {
                let local_path = dist.join(format!("flightdeckd-{}-unknown-linux-musl", host_arch()));
                upload_daemon_from_path(&machine, kh.path(), &local_path, None)
                    .await
                    .expect("upload to fixture B must succeed");
                // `flightdeckd run` refuses to start without `~/.flightdeckd/config.json`
                // — the real orchestration this test mirrors is pair (B7) -> upload
                // (B8) -> init (B10) -> persist (B9), never B9 alone against an
                // un-initialized binary. See `init_via_resolved_path`'s own doc.
                init_via_resolved_path(&machine, kh.path(), "service-root-live-test").await;

                let outcome = install_service(&machine, &probe_result, kh.path())
                    .await
                    .expect("install_service against a root login must succeed");
                assert_eq!(outcome, ServiceOutcome::SystemUnit);

                let active = run_ssh_on_machine(&machine, kh.path(), "systemctl is-active flightdeckd")
                    .await
                    .expect("systemctl is-active must succeed");
                assert_eq!(active.trim(), "active");
            })
            .await;

            fixture_down("b");
        }

        /// PROVES B9 end to end against fixture A (non-root, sudo WITH password): a
        /// per-user unit via self-linger (NO sudo needed for THIS part, per the
        /// empirical facts — see the module doc), surviving the ssh session that
        /// installed it actually closing (waited out, then checked from OUTSIDE via
        /// `docker exec` so a lingering local ssh connection can't mask a false
        /// positive) — then `escalate_persistence` WITH the fixture's real sudo
        /// password masks the sleep targets.
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_install_service_fixture_a_user_unit_survives_session_close_then_escalate_masks_sleep() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let key = ThrowawayKey::generate("service-a");
            install_key_via_password(FIXTURE_A_PORT, FIXTURE_A_USER, FIXTURE_A_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_A_PORT, FIXTURE_A_USER, &key);
            let kh = ScratchKnownHosts::new("service-a");

            let probe_result = crate::bootstrap::connect::probe(
                &crate::bootstrap::connect::BootstrapTarget {
                    host: machine.host.clone(),
                    port: machine.port,
                    user: machine.user.clone(),
                },
                machine.identity_file.as_deref().unwrap(),
                kh.path().unwrap(),
            )
            .await
            .expect("B7 probe against fixture A must succeed");
            assert_eq!(probe_result.passwordless_sudo, Some(false), "fixture A's sudo needs a password");

            with_real_dist_dir(|dist| async move {
                let local_path = dist.join(format!("flightdeckd-{}-unknown-linux-musl", host_arch()));
                upload_daemon_from_path(&machine, kh.path(), &local_path, None)
                    .await
                    .expect("upload to fixture A must succeed");
                init_via_resolved_path(&machine, kh.path(), "service-a-live-test").await;

                let outcome = install_service(&machine, &probe_result, kh.path())
                    .await
                    .expect("install_service against fixture A must succeed");
                assert_eq!(outcome, ServiceOutcome::UserUnit);

                // Wait past logind's ~10s user-manager teardown window, THEN check
                // from OUTSIDE this test's own ssh connections (a fresh `docker exec`
                // as root) — never by reusing a connection THIS test kept open, which
                // would prove nothing about surviving the ORIGINAL session closing.
                tokio::time::sleep(Duration::from_secs(30)).await;
                let check = std::process::Command::new("docker")
                    .args(["exec", "fd-fixture-a", "su", FIXTURE_A_USER, "-c", "systemctl --user is-active flightdeckd"])
                    .output()
                    .expect("docker exec must be available");
                assert_eq!(
                    String::from_utf8_lossy(&check.stdout).trim(),
                    "active",
                    "the user unit must survive the ssh session that installed it closing: {check:?}"
                );

                // Escalate WITH the fixture's real (documented, throwaway) sudo
                // password — fixture A's sudo needs one (see the assertion above).
                let password = SecretString::new(FIXTURE_A_PASSWORD.to_string());
                escalate_persistence(&machine, kh.path(), Some(&password), true)
                    .await
                    .expect("escalate_persistence with the real password must succeed");
                // `systemctl is-enabled` exits NON-zero for a masked unit (it's not
                // "enabled" in the ordinary sense) — `run_ssh_on_machine` discards
                // stdout on a non-zero exit, so `; true` forces a zero exit here purely
                // to keep the real stdout ("masked") instead of losing it.
                let masked = run_ssh_on_machine(&machine, kh.path(), "systemctl is-enabled sleep.target 2>&1; true")
                    .await
                    .unwrap_or_default();
                assert!(masked.trim() == "masked", "expected sleep.target to be masked, got {masked:?}");
            })
            .await;

            fixture_down("a");
        }

        /// PROVES B9's `Adopted` branch against fixture C: `install_service` writes
        /// NOTHING and reports `Adopted`, and the pre-installed daemon is left running,
        /// untouched (same `MainPID` before and after).
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_install_service_fixture_c_is_adopted_and_untouched() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("c");
            let key = ThrowawayKey::generate("service-c");
            install_key_via_password(FIXTURE_C_PORT, FIXTURE_C_USER, FIXTURE_C_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_C_PORT, FIXTURE_C_USER, &key);
            let kh = ScratchKnownHosts::new("service-c");

            let probe_result = crate::bootstrap::connect::probe(
                &crate::bootstrap::connect::BootstrapTarget {
                    host: machine.host.clone(),
                    port: machine.port,
                    user: machine.user.clone(),
                },
                machine.identity_file.as_deref().unwrap(),
                kh.path().unwrap(),
            )
            .await
            .expect("B7 probe against fixture C must succeed");
            assert!(probe_result.conflict.is_some(), "fixture C must be reported as a conflict");

            let pid_before = run_ssh_on_machine(&machine, kh.path(), "systemctl show -p MainPID --value flightdeckd")
                .await
                .expect("reading MainPID before must succeed");

            let outcome = install_service(&machine, &probe_result, kh.path())
                .await
                .expect("install_service against fixture C must succeed");
            assert_eq!(
                outcome,
                ServiceOutcome::Adopted {
                    kind: AdoptedKind::SystemUnit,
                    unit_path: Some("/etc/systemd/system/flightdeckd.service".to_string())
                }
            );

            let pid_after = run_ssh_on_machine(&machine, kh.path(), "systemctl show -p MainPID --value flightdeckd")
                .await
                .expect("reading MainPID after must succeed");
            assert_eq!(pid_before, pid_after, "adopting must never touch the pre-existing, running daemon");

            fixture_down("c");
        }

        /// PROVES B9 against fixture D (no sudo binary at all): per the brief's own
        /// empirical facts, self-linger STILL works there (a user-level polkit policy,
        /// not gated on the `sudo` binary's mere presence) — so this fixture ALSO ends
        /// up on the user-unit path, same as fixture A. Then re-run with
        /// `KillUserProcesses` forced to `yes` (simulated by probing with that field
        /// overridden — this fixture's own real logind default is whatever the base
        /// image ships) to prove the detached fallback is correctly REFUSED
        /// (`AdminRequired`) when linger is unavailable and a background process
        /// would not survive either — `plan_service_install`'s own unit tests already
        /// cover the pure decision; this proves `install_service` actually reaches it
        /// end to end against a fixture with no `sudo` to fall back on.
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_install_service_fixture_d_self_linger_works_and_refuses_when_forced_unsafe() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("d");
            let key = ThrowawayKey::generate("service-d");
            install_key_via_password(FIXTURE_D_PORT, FIXTURE_D_USER, FIXTURE_D_PASSWORD, &key).await;
            let machine = fixture_machine(FIXTURE_D_PORT, FIXTURE_D_USER, &key);
            let kh = ScratchKnownHosts::new("service-d");

            let probe_result = crate::bootstrap::connect::probe(
                &crate::bootstrap::connect::BootstrapTarget {
                    host: machine.host.clone(),
                    port: machine.port,
                    user: machine.user.clone(),
                },
                machine.identity_file.as_deref().unwrap(),
                kh.path().unwrap(),
            )
            .await
            .expect("B7 probe against fixture D must succeed");

            with_real_dist_dir(|dist| async move {
                let local_path = dist.join(format!("flightdeckd-{}-unknown-linux-musl", host_arch()));
                upload_daemon_from_path(&machine, kh.path(), &local_path, None)
                    .await
                    .expect("upload to fixture D must succeed");
                init_via_resolved_path(&machine, kh.path(), "service-d-live-test").await;

                let outcome = install_service(&machine, &probe_result, kh.path())
                    .await
                    .expect("install_service against fixture D must succeed via self-linger");
                assert_eq!(outcome, ServiceOutcome::UserUnit, "fixture D is expected to self-linger successfully");

                // Undo the self-linger + stop the unit this test just installed
                // (fixture D has no `sudo`, but linger can be DISABLED by the user
                // themselves too — mirrors `enable-linger`'s own no-sudo grant).
                let _ = run_ssh_on_machine(
                    &machine,
                    kh.path(),
                    "export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user disable --now flightdeckd",
                )
                .await;
                let _ = run_ssh_on_machine(&machine, kh.path(), "loginctl disable-linger nosudo").await;

                // Now force the "everything refused" scenario for real: per the
                // brief's own empirical facts, self-linger is ALLOWED for this user
                // without sudo (VERIFIED above — the first `install_service` call just
                // proved it), so `install_service`'s own re-attempt
                // (`attempt_self_linger`) would otherwise just succeed again and mask
                // this scenario entirely. Genuinely deny it by revoking execute
                // permission on `loginctl` itself (root, via `docker exec` — NOT
                // through the ssh session, which has no `sudo`) — this also makes
                // `linger_is_enabled`'s own check fail the same way a truly
                // linger-less system would, so BOTH the attempt and the verification
                // see a real refusal, not a synthetic one. Restored afterward
                // regardless of the assertion's outcome.
                let loginctl_path = run_ssh_on_machine(&machine, kh.path(), "command -v loginctl")
                    .await
                    .expect("locating loginctl must succeed")
                    .trim()
                    .to_string();
                let deny = std::process::Command::new("docker")
                    .args(["exec", "fd-fixture-d", "chmod", "000", &loginctl_path])
                    .output()
                    .expect("docker exec must be available");
                assert!(deny.status.success(), "revoking loginctl must succeed: {deny:?}");

                let mut forced_unsafe = probe_result.clone();
                forced_unsafe.kill_user_processes = Some(true);
                let refused = install_service(&machine, &forced_unsafe, kh.path()).await;

                // Restore BEFORE asserting, so a failed assertion (panic) never leaves
                // the fixture's `loginctl` broken for whatever runs next against it.
                let restore = std::process::Command::new("docker")
                    .args(["exec", "fd-fixture-d", "chmod", "755", &loginctl_path])
                    .output()
                    .expect("docker exec must be available");
                assert!(restore.status.success(), "restoring loginctl must succeed: {restore:?}");

                assert!(
                    matches!(refused, Err(BootstrapError::AdminRequired(_))),
                    "expected AdminRequired when linger is refused, no sudo exists, and a background \
                     process would not survive — got {refused:?}"
                );
            })
            .await;

            fixture_down("d");
        }
    }
}
