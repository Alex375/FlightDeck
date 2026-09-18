//! First contact with a server the app has NEVER paired: the user typed host/port/user
//! and (once) a password. [`install_key`] appends the app's own dedicated key to
//! `~/.ssh/authorized_keys` over B5's password-only relay, [`probe`] then reads the
//! full install-mode picture back over the crate's normal keyed path, and
//! [`forget_host_key`] lets the user recover from a genuinely-changed host key. This is
//! deliberately upstream of [`crate::store::MachineRecord`]/pairing — nothing here is
//! persisted, there is no `machine_id` yet, and A1's own pairing probe
//! ([`crate::ipc::commands::add_machine`]) is untouched (see
//! [`crate::ipc::commands::RemoteProbeResult`]'s doc for how the two share one struct
//! without sharing behavior).
//!
//! Two ssh paths, exactly the split `bootstrap::server_setup` already uses for an
//! ALREADY-paired machine (see that module's doc): [`install_key`]'s FIRST connection
//! goes over [`askpass::bootstrap_ssh_command`] + [`askpass::run_with_password`] — the
//! ONE place in this crate without `BatchMode` — and every connection after that (the
//! verify reconnect inside [`install_key`], and [`probe`]) goes over the crate's normal
//! KEYED path ([`crate::ipc::commands::keyed_ssh_options`]). Both share the SAME
//! dedicated `known_hosts` file (`app_data/remote_known_hosts`, exactly like
//! `spawn_session`/`add_machine`), pinned TOFU (`StrictHostKeyChecking=accept-new`) on
//! first contact — see the module's host-key-fingerprint helpers below. A host-key
//! mismatch discovered on ANY of the three ssh invocations in this module — the
//! password-only first connection, or either of the two later keyed calls
//! ([`verify_key_accepted`], [`probe`]) — is classified the SAME way, via
//! [`askpass::is_host_key_mismatch`], so [`BootstrapError::HostKeyMismatch`] is never
//! mistaken for a generic connection failure regardless of which call produced it.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::bootstrap::askpass::{self, BootstrapError};
use crate::ipc::commands::{keyed_ssh_options, parse_probe_output, RemoteProbeResult};

// ============================================================================
// BootstrapTarget
// ============================================================================

/// Connection coordinates for a server the app has NEVER paired: no key yet, no
/// [`crate::store::MachineRecord`] — just what "Add a server" collected. Distinct from
/// [`crate::supervisor::transport::RemoteTarget`] (the POST-pairing shape, carrying
/// `daemon_bin`/`addresses` fields that make no sense before either exists).
#[derive(Debug, Clone)]
pub struct BootstrapTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl BootstrapTarget {
    /// The ssh DESTINATION string [`install_key`]'s password step dials: `user@host`
    /// for the default port 22 ([`askpass::bootstrap_ssh_command`]'s own unit tests
    /// use exactly this shape), or the `ssh://user@host:port` URI form for any other
    /// port — a plain `user@host:port` destination does NOT parse the trailing
    /// `:port` (documented and exercised in `askpass.rs`'s own live test); OpenSSH's
    /// URI form does.
    fn ssh_destination(&self) -> String {
        if self.port == 22 {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("ssh://{}@{}:{}", self.user, self.host, self.port)
        }
    }
}

// ============================================================================
// install_key
// ============================================================================

/// Outcome of [`install_key`]'s idempotent append: whether the app's public key was
/// FRESHLY added to `authorized_keys`, or was already there (a re-run of the same "add
/// a server" step — e.g. the wizard was closed and reopened, or the same pairing
/// command was pasted twice).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum KeyInstallOutcome {
    Installed,
    AlreadyPresent,
}

/// Idempotent remote script [`install_key`] runs over the password-only first-contact
/// connection: creates `~/.ssh` (700) if missing, then appends the app's dedicated
/// PUBLIC key — read off the connection's OWN stdin, NEVER interpolated into this
/// script text — to `~/.ssh/authorized_keys` (600), only if that exact line is not
/// already present (`grep -qxF`). Refuses to follow either path when it is a symlink
/// that RESOLVES OUTSIDE `$HOME` (a symlink resolving inside `$HOME` is left alone —
/// live-verified against a real fixture: both the escaping-HOME refusal and the
/// tolerated within-HOME case). No interpolation at all anywhere in this script — the
/// key travels on stdin — so this is a fixed constant, golden-string tested.
const INSTALL_KEY_SCRIPT: &str = r#"set -e
REAL_SSH_DIR=""
if [ -e "$HOME/.ssh" ] || [ -L "$HOME/.ssh" ]; then
    REAL_SSH_DIR=$(readlink -f "$HOME/.ssh" 2>/dev/null) || { echo FLIGHTDECK_SSH_DIR_UNREADABLE >&2; exit 5; }
    case "$REAL_SSH_DIR" in
        "$HOME"|"$HOME"/*) ;;
        *) echo FLIGHTDECK_SSH_DIR_ESCAPES_HOME >&2; exit 5 ;;
    esac
fi
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
AUTH_KEYS="$HOME/.ssh/authorized_keys"
if [ -e "$AUTH_KEYS" ] || [ -L "$AUTH_KEYS" ]; then
    REAL_AUTH_KEYS=$(readlink -f "$AUTH_KEYS" 2>/dev/null) || { echo FLIGHTDECK_AUTHORIZED_KEYS_UNREADABLE >&2; exit 5; }
    case "$REAL_AUTH_KEYS" in
        "$HOME"|"$HOME"/*) ;;
        *) echo FLIGHTDECK_AUTHORIZED_KEYS_ESCAPES_HOME >&2; exit 5 ;;
    esac
fi
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
KEY=$(cat)
if [ -z "$KEY" ]; then
    echo FLIGHTDECK_EMPTY_KEY >&2
    exit 5
fi
if grep -qxF "$KEY" "$AUTH_KEYS" 2>/dev/null; then
    echo FLIGHTDECK_KEY_ALREADY_PRESENT
else
    printf '%s\n' "$KEY" >> "$AUTH_KEYS"
    echo FLIGHTDECK_KEY_INSTALLED
fi
"#;

/// Turns [`INSTALL_KEY_SCRIPT`]'s exit-success/stdout/stderr into a
/// [`KeyInstallOutcome`], or a descriptive [`BootstrapError::Other`] on refusal (a
/// symlink escaping `$HOME`, an empty key, …). Pure — this is what makes the parsing
/// half of [`install_key`] unit-testable without a real ssh round-trip.
fn parse_install_key_output(success: bool, stdout: &str, stderr: &str) -> Result<KeyInstallOutcome, BootstrapError> {
    if success {
        if stdout.contains("FLIGHTDECK_KEY_ALREADY_PRESENT") {
            return Ok(KeyInstallOutcome::AlreadyPresent);
        }
        if stdout.contains("FLIGHTDECK_KEY_INSTALLED") {
            return Ok(KeyInstallOutcome::Installed);
        }
        // Defensive: exited 0 but neither marker showed up (a future script edit
        // dropped one) — never silently report success without evidence for it.
        return Err(BootstrapError::Other(
            "the key-install script exited successfully but reported no outcome".to_string(),
        ));
    }
    let reason = stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("the key-install script failed");
    Err(BootstrapError::Other(reason.to_string()))
}

/// How long [`install_key`]'s password-authenticated connection is allowed to take —
/// generous (a slow/loaded fresh VPS), but bounded: this is a first-contact
/// interactive step the user is actively waiting on, not a background poll.
const INSTALL_KEY_DEADLINE: Duration = Duration::from_secs(30);

/// Serializes [`install_key`] end to end (password-step append, then the
/// verify-reconnect) against every OTHER concurrent call — mirrors
/// `ipc::commands::PENDING_KEY_LOCK`'s own reasoning (single global lock, not
/// per-target: `install_key` is only ever driven by one human at a time through the
/// wizard, so cross-target serialization costs nothing worth avoiding). Needed because
/// [`INSTALL_KEY_SCRIPT`]'s own check-then-append (`grep -qxF` then `printf >>`) is not
/// atomic across two simultaneous remote shells: without this lock, two overlapping
/// `install_key` calls (e.g. a double click on "Add a server" before a future front end
/// debounces it) could each read "not present yet" and both append the key line,
/// leaving a duplicate in `authorized_keys`.
static INSTALL_KEY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Idempotently install the app's dedicated PUBLIC key on a server the app has never
/// paired, over B5's password-only first-contact path ([`askpass::bootstrap_ssh_command`]
/// + [`askpass::run_with_password`]), then VERIFY it actually took by reconnecting
/// with `identity_file` over the crate's normal keyed/`BatchMode` path — a server that
/// accepted the password but somehow rejects the freshly-installed key
/// (`PubkeyAuthentication no`, a non-default `AuthorizedKeysFile`, ownership/
/// permissions sshd itself refuses) fails LOUDLY here as
/// [`BootstrapError::KeyInstalledButNotAccepted`], never a bare
/// `Installed`/`AlreadyPresent` the caller would otherwise trust without proof.
///
/// `identity_file`/`public_key` are expected to be
/// [`crate::ipc::commands::generate_or_reuse_pending_key`]'s own output — A3's
/// per-server dedicated key. This function never mints a key itself. `known_hosts` is
/// the app's dedicated file (`bootstrap_install_key` always passes
/// `app_data/remote_known_hosts`): the FIRST connection here is what TOFU-pins the
/// server's host key (`StrictHostKeyChecking=accept-new`, baked into
/// `bootstrap_ssh_command`) — see the module doc and
/// [`read_pinned_fingerprint`]/[`HostKeyFingerprintEvent`].
///
/// A host key that has CHANGED since a previous pin surfaces as
/// [`BootstrapError::HostKeyMismatch`] — the password step's own connection classifies
/// it via [`askpass::classify_output`] (already wired in `askpass.rs`), before either
/// the append or the verify step gets a chance to run; [`verify_key_accepted`]'s own
/// reconnect classifies the SAME mismatch the same way (via
/// [`askpass::is_host_key_mismatch`]), should the key somehow change again in the few
/// seconds between the two connections — never falling through to the ordinary
/// [`BootstrapError::KeyInstalledButNotAccepted`] path in that case.
pub async fn install_key(
    target: &BootstrapTarget,
    password: &str,
    identity_file: &str,
    public_key: &str,
    known_hosts: &str,
) -> Result<KeyInstallOutcome, BootstrapError> {
    let _guard = INSTALL_KEY_LOCK.lock().await;
    let dest = target.ssh_destination();
    let cmd = askpass::bootstrap_ssh_command(&dest, None, Some(known_hosts), INSTALL_KEY_SCRIPT);
    let out = askpass::run_with_password(cmd, password, Some(public_key.as_bytes()), INSTALL_KEY_DEADLINE).await?;
    let outcome = parse_install_key_output(
        out.status.success(),
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )?;

    verify_key_accepted(target, identity_file, known_hosts).await?;
    Ok(outcome)
}

/// [`install_key`]'s verification reconnect: a plain `true` over the crate's normal
/// keyed/batch ssh path, using the key that was (or already was) just installed. Any
/// failure here — auth refused, connection dropped — becomes
/// [`BootstrapError::KeyInstalledButNotAccepted`] with a hint built from ssh's own
/// stderr, never a bare connection error (the password step already proved the host
/// itself is reachable) — UNLESS the failure is itself a host-key mismatch (the server
/// was reimaged, or something is impersonating it, in the seconds between the password
/// step and this reconnect), which is classified as [`BootstrapError::HostKeyMismatch`]
/// via [`askpass::is_host_key_mismatch`] instead: a changed host key is never just "the
/// key wasn't accepted".
async fn verify_key_accepted(
    target: &BootstrapTarget,
    identity_file: &str,
    known_hosts: &str,
) -> Result<(), BootstrapError> {
    let mut cmd = keyed_ssh_options(target.port, Some(identity_file), Some(known_hosts));
    cmd.arg("-T")
        .arg(format!("{}@{}", target.user, target.host))
        .arg("true");
    let out = cmd
        .output()
        .await
        .map_err(|e| BootstrapError::Other(format!("could not run ssh: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if askpass::is_host_key_mismatch(&stderr) {
        return Err(BootstrapError::HostKeyMismatch);
    }
    let hint = key_rejection_hint(&stderr);
    Err(BootstrapError::KeyInstalledButNotAccepted(hint))
}

/// Builds [`BootstrapError::KeyInstalledButNotAccepted`]'s hint from the verification
/// reconnect's raw stderr: recognizes the standard OpenSSH client wording for the
/// common sshd-side causes, falling back to ssh's own last stderr line so nothing is
/// ever silently generic. Pure, unit-tested against real OpenSSH wording.
///
/// This is fed ONLY [`verify_key_accepted`]'s stderr, and that reconnect authenticates
/// through nothing but our OWN dedicated key (`IdentitiesOnly=yes`, and `BatchMode=yes`
/// means password/keyboard-interactive is never even attempted) — so ANY "permission
/// denied" there inherently means the key path is what failed, regardless of which
/// method name ssh cites in parentheses. That parenthetical lists what the SERVER still
/// offers as continuable, not what THIS client tried: VERIFIED live against a real
/// fixture with `PubkeyAuthentication no` flipped on sshd AFTER a successful install —
/// ssh's own message there reads `Permission denied (password).` (the server no longer
/// offers publickey at all, so the client's summary names its next method instead),
/// never `(publickey)` as might be assumed from the method WE offered; a bad
/// `authorized_keys` entry/permissions instead produces `(publickey)` (the server still
/// offers it, the specific key is what got rejected). Matching on the bare "permission
/// denied" prefix, not a specific parenthetical, covers both real causes with the one,
/// more useful hint instead of silently falling back to raw ssh wording for either one.
fn key_rejection_hint(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("permission denied") {
        return "the key was installed but the server refused it when reconnecting — check that \
                sshd has `PubkeyAuthentication yes` and `AuthorizedKeysFile` pointing at the \
                default `~/.ssh/authorized_keys`"
            .to_string();
    }
    stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("the key was installed but a reconnect using it failed")
        .to_string()
}

// ============================================================================
// Host key fingerprint (TOFU display)
// ============================================================================

/// `ssh-keygen -F`'s search pattern for a pinned host-key entry: `host` alone for the
/// default port 22 (the plain `host ssh-ed25519 ...` form `known_hosts` uses there),
/// or the bracketed `[host]:port` form OpenSSH pins EVERY non-default port under —
/// VERIFIED live against this crate's own bootstrap fixtures (`ssh -p 2232 ...` pinned
/// `[127.0.0.1]:2232 ssh-ed25519 ...`, never a bare `127.0.0.1` line).
fn host_key_search_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Parses `ssh-keygen -lf <known_hosts> -F <pattern>`'s stdout into the pinned
/// fingerprint, picking the ED25519 line when several key types are pinned for the
/// same host (every host key this app TOFU-pins is negotiated ed25519 in practice, so
/// there is normally exactly one line; the preference is defensive, not load-bearing).
/// `None` on anything that doesn't parse — never an error, this is a display-only
/// nicety riding along a successful connection.
///
/// Real format (VERIFIED live, OpenSSH_10.3, against this crate's own bootstrap
/// fixtures): a `# Host ... found: line N` comment line, then one
/// `<pattern> <KEYTYPE> <fingerprint>` line per matching key type — e.g.
/// `[127.0.0.1]:2232 ED25519 SHA256:UYbh2ooFoe4Qn7oxvgUhfu4o/b6IiIxhpMXYlXGLHfk`.
fn parse_host_key_fingerprint(stdout: &str) -> Option<String> {
    // Every fingerprint line's 3rd column starts with `SHA256:` (the default, and
    // only, digest format every currently-supported OpenSSH emits for `-l`) — this is
    // what tells a real data line apart from unrelated/garbled text that merely HAS
    // three whitespace-separated tokens (proven by
    // `fingerprint_parsing_returns_none_on_garbled_output` below).
    let fingerprints: Vec<(&str, &str)> = stdout
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            parts.next()?; // the host pattern column — not needed, just consumed
            let keytype = parts.next()?;
            let fingerprint = parts.next()?;
            fingerprint.starts_with("SHA256:").then_some((keytype, fingerprint))
        })
        .collect();
    fingerprints
        .iter()
        .find(|(keytype, _)| *keytype == "ED25519")
        .or_else(|| fingerprints.first())
        .map(|(_, fingerprint)| fingerprint.to_string())
}

/// Whether `(host, port)` already has a pinned entry in `known_hosts` — read BEFORE a
/// connection attempt. [`bootstrap_install_key`] compares this against a fresh read
/// AFTER the attempt to decide [`HostKeyFingerprintEvent::known`].
async fn host_key_pinned(known_hosts: &str, host: &str, port: u16) -> bool {
    read_pinned_fingerprint(known_hosts, host, port).await.is_some()
}

/// Reads back the fingerprint TOFU-pinned for `(host, port)` in `known_hosts`, or
/// `None` when nothing is pinned there (including a `known_hosts` file that doesn't
/// exist yet). Never an error either way — this rides along a successful connection as
/// a nicety, never a gate on it (per Armand's display-only, non-blocking decision).
async fn read_pinned_fingerprint(known_hosts: &str, host: &str, port: u16) -> Option<String> {
    if !Path::new(known_hosts).exists() {
        return None;
    }
    let pattern = host_key_search_pattern(host, port);
    let out = tokio::process::Command::new("ssh-keygen")
        .arg("-lf")
        .arg(known_hosts)
        .arg("-F")
        .arg(&pattern)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_host_key_fingerprint(&String::from_utf8_lossy(&out.stdout))
}

/// Un-pins `(host, port)`'s host key from `known_hosts` (`ssh-keygen -R`) — what
/// [`bootstrap_forget_host_key`] runs after the user confirms a
/// [`BootstrapError::HostKeyMismatch`] is an expected change (a reimaged/rebuilt
/// server, say), not an attack, and wants to reconnect. Idempotent: a `known_hosts`
/// that doesn't exist yet, or one that simply never had this host pinned, is success
/// either way — there is nothing to forget in both cases, and `ssh-keygen -R` itself
/// already treats "not pinned, but the file exists" as success (VERIFIED live).
pub async fn forget_host_key(known_hosts: &str, host: &str, port: u16) -> Result<(), BootstrapError> {
    if !Path::new(known_hosts).exists() {
        return Ok(());
    }
    let pattern = host_key_search_pattern(host, port);
    let out = tokio::process::Command::new("ssh-keygen")
        .arg("-R")
        .arg(&pattern)
        .arg("-f")
        .arg(known_hosts)
        .output()
        .await
        .map_err(|e| BootstrapError::Other(format!("could not run ssh-keygen: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    Err(BootstrapError::Other(
        String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("ssh-keygen -R failed")
            .to_string(),
    ))
}

// ============================================================================
// probe
// ============================================================================

/// [`probe`]'s own EXTENDED accumulating probe script: a superset of A1's
/// `probe_remote` script in `ipc/commands.rs` — the SAME two tool checks (so a caller
/// gets the full picture: is this server even pairable, in addition to the
/// install-mode facts below), PLUS every B7 marker
/// [`crate::ipc::commands::parse_probe_output`] knows how to read. Never `exit`s
/// early (see `probe_remote`'s own doc for why that matters): every check below runs
/// regardless of any earlier one's outcome, so a server missing everything reports
/// EVERY blocker/fact at once, not just whichever check happened to run first.
///
/// Every fact beyond `claude`/`flightdeckd` is BEST-EFFORT: a missing tool
/// (`loginctl`, `busctl`, `sudo`) degrades its own marker to an empty/negative value,
/// never aborts the rest of the script (see [`crate::ipc::commands::parse_yes_no_marker`]
/// — an empty or garbled value parses as `None`, never an error).
const PROBE_SCRIPT: &str = r#"
MISSING=""
CLAUDE_VERSION=""
if command -v claude >/dev/null 2>&1; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null)
else
    MISSING="$MISSING claude"
fi
FLIGHTDECKD_BIN=""
if command -v flightdeckd >/dev/null 2>&1; then
    FLIGHTDECKD_BIN=flightdeckd
elif [ -x "$HOME/.local/bin/flightdeckd" ]; then
    FLIGHTDECKD_BIN="$HOME/.local/bin/flightdeckd"
elif [ -x /usr/local/bin/flightdeckd ]; then
    FLIGHTDECKD_BIN=/usr/local/bin/flightdeckd
fi
FLIGHTDECKD_VERSION=""
if [ -n "$FLIGHTDECKD_BIN" ]; then
    FLIGHTDECKD_VERSION=$("$FLIGHTDECKD_BIN" --version 2>/dev/null)
else
    MISSING="$MISSING flightdeckd"
fi
echo "FLIGHTDECK_CLAUDE_VERSION:$CLAUDE_VERSION"
echo "FLIGHTDECK_DAEMON_VERSION:$FLIGHTDECKD_VERSION"
case " $MISSING " in
    *" claude "*) echo FLIGHTDECK_NO_CLAUDE >&2 ;;
esac
case " $MISSING " in
    *" flightdeckd "*) echo FLIGHTDECK_NO_DAEMON >&2 ;;
esac

echo "FLIGHTDECK_OS:$(uname -s 2>/dev/null)"
echo "FLIGHTDECK_ARCH:$(uname -m 2>/dev/null)"

if [ -d /run/systemd/system ]; then
    echo FLIGHTDECK_SYSTEMD:yes
else
    echo FLIGHTDECK_SYSTEMD:no
fi

if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo FLIGHTDECK_PASSWORDLESS_SUDO:yes
else
    echo FLIGHTDECK_PASSWORDLESS_SUDO:no
fi

LINGER=$(loginctl show-user "$USER" -p Linger 2>/dev/null | sed -n 's/^Linger=//p')
echo "FLIGHTDECK_LINGER:$LINGER"

KUP=""
if command -v busctl >/dev/null 2>&1; then
    KUP_RAW=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)
    case "$KUP_RAW" in
        *"true"*) KUP=yes ;;
        *"false"*) KUP=no ;;
    esac
fi
echo "FLIGHTDECK_KILL_USER_PROCESSES:$KUP"

CONFLICT=""
if [ -f /etc/systemd/system/flightdeckd.service ]; then
    CONFLICT="an existing system unit at /etc/systemd/system/flightdeckd.service"
elif [ -x /usr/local/bin/flightdeckd ]; then
    CONFLICT="an existing flightdeckd binary at /usr/local/bin/flightdeckd"
elif command -v flightdeckd >/dev/null 2>&1; then
    FDD_PATH=$(command -v flightdeckd)
    case "$FDD_PATH" in
        "$HOME"/.local/bin/flightdeckd) ;;
        *) CONFLICT="an existing flightdeckd binary at $FDD_PATH" ;;
    esac
elif [ -f "$HOME/.flightdeckd/config.json" ]; then
    CONFLICT="an existing ~/.flightdeckd/config.json"
fi
if [ -n "$CONFLICT" ]; then
    echo "FLIGHTDECK_CONFLICT:$CONFLICT"
fi

if [ -n "$MISSING" ]; then
    case "$MISSING" in
        *claude*) exit 3 ;;
        *) exit 4 ;;
    esac
fi
exit 0
"#;

/// Probe a server that ALREADY holds the app's key (post [`install_key`]) for the
/// full picture [`RemoteProbeResult`] carries — both A1's original pairability facts
/// (`claude`/`flightdeckd` presence) and B7's install-mode facts (os/arch/systemd/
/// passwordless-sudo/linger/`KillUserProcesses`/`conflict`) — over the crate's normal
/// KEYED ssh path (never password: by this point in the bootstrap flow the key
/// already works, see the module doc). Parsing goes through the SAME
/// [`crate::ipc::commands::parse_probe_output`] A1's own pairing probe uses — one
/// parser, one struct (see that function's doc) — fed THIS module's own, extended
/// [`PROBE_SCRIPT`]. A connection-level failure that is itself a host-key mismatch
/// (the server was reimaged, or something is impersonating it, since [`install_key`]
/// last pinned it) is classified as [`BootstrapError::HostKeyMismatch`] via
/// [`askpass::is_host_key_mismatch`] BEFORE falling through to `parse_probe_output`'s
/// generic "could not connect" string — otherwise this exact case (a LATER connect
/// against an already-keyed server, per this function's own doc) would be
/// indistinguishable from an ordinary connection failure once the error is flattened
/// to a `String` at the `#[tauri::command]` boundary, and a caller could never offer
/// [`forget_host_key`] in response to it.
pub async fn probe(
    target: &BootstrapTarget,
    identity_file: &str,
    known_hosts: &str,
) -> Result<RemoteProbeResult, BootstrapError> {
    let mut cmd = keyed_ssh_options(target.port, Some(identity_file), Some(known_hosts));
    cmd.arg("-T")
        .arg(format!("{}@{}", target.user, target.host))
        .arg(PROBE_SCRIPT);
    let out = cmd
        .output()
        .await
        .map_err(|e| BootstrapError::Other(format!("could not run ssh: {e}")))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() && askpass::is_host_key_mismatch(&stderr) {
        return Err(BootstrapError::HostKeyMismatch);
    }
    parse_probe_output(&String::from_utf8_lossy(&out.stdout), &stderr, out.status.success())
        .map_err(BootstrapError::Other)
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Resolve the app's dedicated `known_hosts` path — mirrors `add_machine`'s /
/// `server_setup::known_hosts_path`'s own resolution (`app_data/remote_known_hosts`).
/// `None` only when the app data dir itself can't be resolved.
fn known_hosts_path(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned())
}

/// Emit [`crate::ipc::events::HostKeyFingerprintEvent`], logging (never swallowing) a
/// failed emit, mirroring every other event in this crate.
fn emit_host_key_fingerprint(app: &tauri::AppHandle, host: &str, port: u16, fingerprint: &str, known: bool) {
    use tauri_specta::Event;
    let ev = crate::ipc::events::HostKeyFingerprintEvent {
        host: host.to_string(),
        port,
        fingerprint: fingerprint.to_string(),
        known,
    };
    if let Err(e) = ev.emit(app) {
        eprintln!("[bootstrap] failed to emit host_key_fingerprint event: {e}");
    }
}

/// Install the app's dedicated key on `host:port` (first contact, password-only — see
/// [`install_key`]), reusing [`crate::ipc::commands::generate_or_reuse_pending_key`]
/// for the key itself (A3's lookup-or-generate primitive — never mints a key here).
///
/// On SUCCESS ONLY — [`install_key`] returns `Ok`, whether the outcome is `Installed`
/// or `AlreadyPresent` — emits [`crate::ipc::events::HostKeyFingerprintEvent`] with the
/// fingerprint TOFU-pinned in the app's dedicated `known_hosts` and whether it was
/// ALREADY pinned before THIS call — display-only, NON-BLOCKING (Armand's decision: no
/// confirmation gate). The emit is gated on the OVERALL `Result`, never on "some
/// fingerprint happens to be readable": TOFU pinning happens at the transport layer,
/// before auth, so a fingerprint can be readable even after a FAILED call (a wrong
/// password still pins a fresh host key; a stale pin is still readable right after a
/// [`BootstrapError::HostKeyMismatch`]) — without this gate a caller could mistake
/// receipt of the event for a successful pairing step. Concretely: a wrong password on
/// a brand-new host pins the key but does NOT emit here; the fingerprint becomes
/// visible on the next, successful call instead (at which point `known` correctly
/// reads `true`). A host key that CHANGED since a previous pin never reaches
/// `Ok` at all — it fails as [`BootstrapError::HostKeyMismatch`] — so no event fires
/// for that call either.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_install_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    label: String,
) -> Result<KeyInstallOutcome, String> {
    use tauri::Manager;
    let ssh_keys_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh_keys");
    let key = crate::ipc::commands::generate_or_reuse_pending_key(&ssh_keys_dir, &label)
        .await
        .map_err(|e| e.to_string())?;
    let known_hosts =
        known_hosts_path(&app).ok_or_else(|| "could not resolve the app's data directory".to_string())?;
    let target = BootstrapTarget { host: host.clone(), port, user };

    let known_before = host_key_pinned(&known_hosts, &host, port).await;
    let result = install_key(&target, &password, &key.identity_file, &key.public_key, &known_hosts).await;

    // Gated on success (see this function's own doc): the TOFU pin itself happens at
    // the transport layer, before auth, so a fingerprint can be readable here even
    // after a FAILED call (a wrong password still pins a fresh host; a stale pin is
    // still readable after a `HostKeyMismatch`) — emitting unconditionally would let a
    // caller mistake receipt of this event for a successful pairing step.
    if result.is_ok() {
        if let Some(fingerprint) = read_pinned_fingerprint(&known_hosts, &host, port).await {
            emit_host_key_fingerprint(&app, &host, port, &fingerprint, known_before);
        }
    }

    result.map_err(|e| e.to_string())
}

/// Probe an already-keyed server for the full install-mode picture. See [`probe`].
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_probe(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    identity_file: String,
) -> Result<RemoteProbeResult, String> {
    let known_hosts =
        known_hosts_path(&app).ok_or_else(|| "could not resolve the app's data directory".to_string())?;
    let target = BootstrapTarget { host, port, user };
    probe(&target, &identity_file, &known_hosts).await.map_err(|e| e.to_string())
}

/// Forget a server's pinned host key (after [`BootstrapError::HostKeyMismatch`], once
/// the user has confirmed the change is expected) so the next connection re-pins it
/// TOFU. See [`forget_host_key`].
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_forget_host_key(app: tauri::AppHandle, host: String, port: u16) -> Result<(), String> {
    let known_hosts =
        known_hosts_path(&app).ok_or_else(|| "could not resolve the app's data directory".to_string())?;
    forget_host_key(&known_hosts, &host, port).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- BootstrapTarget::ssh_destination ----

    #[test]
    fn ssh_destination_uses_plain_form_on_the_default_port() {
        let t = BootstrapTarget { host: "example.com".to_string(), port: 22, user: "deploy".to_string() };
        assert_eq!(t.ssh_destination(), "deploy@example.com");
    }

    #[test]
    fn ssh_destination_uses_the_uri_form_on_a_non_default_port() {
        let t = BootstrapTarget { host: "127.0.0.1".to_string(), port: 2231, user: "deploy".to_string() };
        assert_eq!(t.ssh_destination(), "ssh://deploy@127.0.0.1:2231");
    }

    // ---- INSTALL_KEY_SCRIPT (golden string) ----

    /// Makes [`INSTALL_KEY_SCRIPT`]'s doc claim of being "golden-string tested" true: an
    /// INDEPENDENT literal copy of the script text, so an accidental edit to the real
    /// constant (e.g. narrowing one of the two symlink-tolerance `case` patterns back to
    /// an exact match, the actual shape of the blocker this test now guards against) is
    /// caught here even though nothing else in this file necessarily exercises that
    /// exact line — the live fixture tests prove BEHAVIOR against a real server, this
    /// test proves the shipped TEXT hasn't drifted from what was reviewed.
    #[test]
    fn install_key_script_is_the_reviewed_golden_string() {
        let expected = r#"set -e
REAL_SSH_DIR=""
if [ -e "$HOME/.ssh" ] || [ -L "$HOME/.ssh" ]; then
    REAL_SSH_DIR=$(readlink -f "$HOME/.ssh" 2>/dev/null) || { echo FLIGHTDECK_SSH_DIR_UNREADABLE >&2; exit 5; }
    case "$REAL_SSH_DIR" in
        "$HOME"|"$HOME"/*) ;;
        *) echo FLIGHTDECK_SSH_DIR_ESCAPES_HOME >&2; exit 5 ;;
    esac
fi
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
AUTH_KEYS="$HOME/.ssh/authorized_keys"
if [ -e "$AUTH_KEYS" ] || [ -L "$AUTH_KEYS" ]; then
    REAL_AUTH_KEYS=$(readlink -f "$AUTH_KEYS" 2>/dev/null) || { echo FLIGHTDECK_AUTHORIZED_KEYS_UNREADABLE >&2; exit 5; }
    case "$REAL_AUTH_KEYS" in
        "$HOME"|"$HOME"/*) ;;
        *) echo FLIGHTDECK_AUTHORIZED_KEYS_ESCAPES_HOME >&2; exit 5 ;;
    esac
fi
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
KEY=$(cat)
if [ -z "$KEY" ]; then
    echo FLIGHTDECK_EMPTY_KEY >&2
    exit 5
fi
if grep -qxF "$KEY" "$AUTH_KEYS" 2>/dev/null; then
    echo FLIGHTDECK_KEY_ALREADY_PRESENT
else
    printf '%s\n' "$KEY" >> "$AUTH_KEYS"
    echo FLIGHTDECK_KEY_INSTALLED
fi
"#;
        assert_eq!(
            INSTALL_KEY_SCRIPT, expected,
            "INSTALL_KEY_SCRIPT's text has drifted from what was reviewed — in particular, both \
             the ~/.ssh AND authorized_keys symlink checks must tolerate any resolved path under \
             $HOME (`\"$HOME\"|\"$HOME\"/*`), not just an exact-match literal"
        );
    }

    // ---- parse_install_key_output ----

    #[test]
    fn install_key_parsing_recognizes_a_fresh_install() {
        assert_eq!(
            parse_install_key_output(true, "FLIGHTDECK_KEY_INSTALLED\n", ""),
            Ok(KeyInstallOutcome::Installed)
        );
    }

    #[test]
    fn install_key_parsing_recognizes_an_already_present_key() {
        assert_eq!(
            parse_install_key_output(true, "FLIGHTDECK_KEY_ALREADY_PRESENT\n", ""),
            Ok(KeyInstallOutcome::AlreadyPresent)
        );
    }

    #[test]
    fn install_key_parsing_surfaces_a_symlink_refusal() {
        let err = parse_install_key_output(false, "", "FLIGHTDECK_SSH_DIR_ESCAPES_HOME\n")
            .expect_err("a symlink escaping $HOME must be refused, not silently accepted");
        assert_eq!(err, BootstrapError::Other("FLIGHTDECK_SSH_DIR_ESCAPES_HOME".to_string()));
    }

    #[test]
    fn install_key_parsing_surfaces_an_authorized_keys_symlink_refusal() {
        let err = parse_install_key_output(false, "", "FLIGHTDECK_AUTHORIZED_KEYS_ESCAPES_HOME\n")
            .expect_err("a symlinked authorized_keys escaping $HOME must be refused");
        assert_eq!(err, BootstrapError::Other("FLIGHTDECK_AUTHORIZED_KEYS_ESCAPES_HOME".to_string()));
    }

    #[test]
    fn install_key_parsing_never_silently_succeeds_without_a_recognized_marker() {
        let err = parse_install_key_output(true, "some unrelated banner\n", "")
            .expect_err("success with no recognized marker must not be reported as success");
        assert!(matches!(err, BootstrapError::Other(_)));
    }

    #[test]
    fn install_key_parsing_falls_back_to_the_last_stderr_line_on_failure() {
        let err = parse_install_key_output(false, "", "line one\nconnection reset by peer\n")
            .expect_err("a non-success exit must be an error");
        assert_eq!(err, BootstrapError::Other("connection reset by peer".to_string()));
    }

    // ---- key_rejection_hint ----

    #[test]
    fn key_rejection_hint_recognizes_the_real_publickey_denial_wording() {
        let hint = key_rejection_hint("deploy@127.0.0.1: Permission denied (publickey).\n");
        assert!(hint.contains("PubkeyAuthentication"));
        assert!(hint.contains("AuthorizedKeysFile"));
    }

    /// The wording ssh ACTUALLY produces (VERIFIED live against a real fixture) when
    /// `PubkeyAuthentication no` is the sshd-side cause — a different parenthetical
    /// than the "bad authorized_keys" case above, but the same underlying "your key
    /// path is broken" situation, so it must produce the SAME actionable hint rather
    /// than falling through to a bare, unexplained stderr line.
    #[test]
    fn key_rejection_hint_recognizes_the_real_wording_when_pubkeyauthentication_is_off() {
        let hint = key_rejection_hint("deploy@127.0.0.1: Permission denied (password).\n");
        assert!(hint.contains("PubkeyAuthentication"));
        assert!(hint.contains("AuthorizedKeysFile"));
    }

    #[test]
    fn key_rejection_hint_falls_back_to_the_last_stderr_line_otherwise() {
        let hint = key_rejection_hint("debug1: something\nkex_exchange_identification: read: Connection reset by peer\n");
        assert_eq!(hint, "kex_exchange_identification: read: Connection reset by peer");
    }

    // ---- host_key_search_pattern ----

    #[test]
    fn search_pattern_is_bare_host_on_the_default_port() {
        assert_eq!(host_key_search_pattern("example.com", 22), "example.com");
    }

    #[test]
    fn search_pattern_is_bracketed_on_a_non_default_port() {
        assert_eq!(host_key_search_pattern("127.0.0.1", 2232), "[127.0.0.1]:2232");
    }

    // ---- parse_host_key_fingerprint ----

    /// Byte-for-byte the real `ssh-keygen -lf known_hosts -F [127.0.0.1]:2232` output
    /// captured live against this crate's own fixture B (port 2232, root).
    #[test]
    fn fingerprint_parsing_reads_the_real_captured_output() {
        let stdout = "# Host [127.0.0.1]:2232 found: line 1 \n\
                       [127.0.0.1]:2232 ED25519 SHA256:UYbh2ooFoe4Qn7oxvgUhfu4o/b6IiIxhpMXYlXGLHfk\n";
        assert_eq!(
            parse_host_key_fingerprint(stdout),
            Some("SHA256:UYbh2ooFoe4Qn7oxvgUhfu4o/b6IiIxhpMXYlXGLHfk".to_string())
        );
    }

    #[test]
    fn fingerprint_parsing_picks_the_ed25519_line_among_several() {
        let stdout = "# Host example.com found: line 1 \n\
                       example.com RSA SHA256:rsaFingerprintHere\n\
                       example.com ED25519 SHA256:ed25519FingerprintHere\n";
        assert_eq!(parse_host_key_fingerprint(stdout), Some("SHA256:ed25519FingerprintHere".to_string()));
    }

    #[test]
    fn fingerprint_parsing_falls_back_when_no_ed25519_line_is_present() {
        let stdout = "# Host example.com found: line 1 \n\
                       example.com RSA SHA256:onlyRsaFingerprint\n";
        assert_eq!(parse_host_key_fingerprint(stdout), Some("SHA256:onlyRsaFingerprint".to_string()));
    }

    #[test]
    fn fingerprint_parsing_returns_none_on_empty_output() {
        assert_eq!(parse_host_key_fingerprint(""), None);
    }

    #[test]
    fn fingerprint_parsing_returns_none_on_garbled_output() {
        assert_eq!(parse_host_key_fingerprint("not what we expected at all"), None);
    }

    // ========================================================================
    // Live fixture tests (B7) — need Docker (colima start) + the
    // flightdeck-server repo's bootstrap-fixtures checked out as a sibling.
    // `cargo test --lib -- --ignored --nocapture`.
    // ========================================================================
    mod live {
        use super::*;
        use std::path::PathBuf;

        /// Serializes every live test below against every OTHER live test in this
        /// crate that touches the SAME fixture containers (mirrors
        /// `server_setup.rs`'s own `LIVE_FIXTURE_LOCK`): `fixture.sh up` always
        /// `docker rm -f`s then `docker run`s fresh (never a true no-op reuse), so two
        /// tests racing the same letter would tear down state out from under each
        /// other. Run this file's live suite on its own (or with
        /// `--test-threads=1`) rather than interleaved with `server_setup.rs`'s.
        static LIVE_FIXTURE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        /// Locates the `flightdeck-server` repo as an ancestor sibling of this crate's
        /// own checkout — mirrors `server_setup.rs`'s own helper of the same name
        /// (duplicated rather than shared: neither module has a place to put shared
        /// test-only infra today).
        fn flightdeck_server_repo() -> PathBuf {
            if let Ok(p) = std::env::var("FLIGHTDECK_SERVER_REPO") {
                return PathBuf::from(p);
            }
            let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            loop {
                let candidate = dir.join("flightdeck-server");
                if candidate.join("bootstrap-fixtures").is_dir() {
                    return candidate;
                }
                if !dir.pop() {
                    panic!(
                        "could not locate the flightdeck-server repo as an ancestor sibling of {} \
                         — check it out next to tosse-code, or set FLIGHTDECK_SERVER_REPO",
                        env!("CARGO_MANIFEST_DIR")
                    );
                }
            }
        }

        /// Brings a fixture up FRESH (`fixture.sh up` always `docker rm -f`s then
        /// `docker run`s — never a state-preserving no-op reuse, verified against the
        /// script's own source). Panics with the script's own output on failure.
        fn fixture_up(letter: &str) {
            let script = flightdeck_server_repo().join("bootstrap-fixtures/fixture.sh");
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

        /// A scratch `known_hosts`, isolated per test run — never the developer's real
        /// `~/.ssh/known_hosts`. Removed on every exit path via `Drop`.
        struct ScratchKnownHosts(PathBuf);
        impl ScratchKnownHosts {
            fn new(tag: &str) -> Self {
                let path =
                    std::env::temp_dir().join(format!("flightdeck-b7-known-hosts-{tag}-{}", uuid::Uuid::new_v4()));
                std::fs::write(&path, "").expect("scratch known_hosts");
                Self(path)
            }
            fn path(&self) -> &str {
                self.0.to_str().expect("scratch known_hosts path must be UTF-8")
            }
        }
        impl Drop for ScratchKnownHosts {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        /// A throwaway keypair for one test run, removed on drop — never the
        /// developer's real SSH key (mirrors `server_setup.rs`'s own `ThrowawayKey`).
        struct ThrowawayKey {
            dir: PathBuf,
            private: PathBuf,
            public: String,
        }
        impl ThrowawayKey {
            fn generate(tag: &str) -> Self {
                let dir = std::env::temp_dir().join(format!("flightdeck-b7-live-{tag}-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&dir).expect("scratch dir for the throwaway key");
                let private = dir.join("id_ed25519");
                let out = std::process::Command::new("ssh-keygen")
                    .args(["-t", "ed25519", "-f"])
                    .arg(&private)
                    .args(["-N", "", "-C", "flightdeck-b7-live-test"])
                    .output()
                    .expect("ssh-keygen must be available");
                assert!(out.status.success(), "ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr));
                let public =
                    std::fs::read_to_string(dir.join("id_ed25519.pub")).expect("read the generated pubkey");
                Self { dir, private, public: public.trim().to_string() }
            }
            fn path(&self) -> &str {
                self.private.to_str().expect("throwaway key path must be UTF-8")
            }
        }
        impl Drop for ThrowawayKey {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
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

        /// PROVES the whole `install_key` flow end to end against a REAL, freshly
        /// provisioned node (fixture A: password-protected sudo, root login refused):
        /// (1) a symlinked `~/.ssh` escaping `$HOME` is REFUSED, never followed; (2) a
        /// wrong password is `WrongPassword`, never a generic error; (3) the real
        /// idempotence claim — `Installed` then `AlreadyPresent` — with the key
        /// genuinely usable afterwards (a real BatchMode reconnect using it succeeds).
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_a_install_key_end_to_end() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_A_PORT, user: FIXTURE_A_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-a");
            let kh = ScratchKnownHosts::new("fixture-a");

            // Checked BEFORE any connection at all touches `kh` — every ssh call
            // below (even the poison setup and the wrong-password attempt) pins the
            // host key at the TRANSPORT level before auth is even attempted, so this
            // must be read right here, not after those steps.
            let known_before_any_connection = host_key_pinned(kh.path(), &target.host, target.port).await;
            assert!(!known_before_any_connection, "a fresh scratch known_hosts must start with nothing pinned");

            // --- (1) symlink refusal, on the PRISTINE (no ~/.ssh yet) node ---
            let poison = "rm -rf ~/.ssh /tmp/b7-evil-ssh-dir; mkdir -p /tmp/b7-evil-ssh-dir; ln -s /tmp/b7-evil-ssh-dir ~/.ssh";
            let poison_cmd = askpass::bootstrap_ssh_command(
                &target.ssh_destination(),
                None,
                Some(kh.path()),
                poison,
            );
            let out = askpass::run_with_password(poison_cmd, FIXTURE_A_PASSWORD, None, Duration::from_secs(15))
                .await
                .expect("poisoning ~/.ssh on the fixture must succeed");
            assert!(out.status.success(), "poison setup failed: {}", String::from_utf8_lossy(&out.stderr));

            let refused = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path()).await;
            assert!(
                matches!(refused, Err(BootstrapError::Other(ref m)) if m.contains("ESCAPES_HOME")),
                "a symlinked ~/.ssh escaping $HOME must be refused, got {refused:?}"
            );

            // Clean up the poison before the real flow below.
            let cleanup = askpass::bootstrap_ssh_command(
                &target.ssh_destination(),
                None,
                Some(kh.path()),
                "rm -rf ~/.ssh /tmp/b7-evil-ssh-dir",
            );
            let out = askpass::run_with_password(cleanup, FIXTURE_A_PASSWORD, None, Duration::from_secs(15))
                .await
                .expect("cleaning up the poison must succeed");
            assert!(out.status.success());

            // --- (2) wrong password ---
            let wrong = install_key(&target, "definitely-wrong-password", key.path(), &key.public, kh.path()).await;
            assert_eq!(wrong, Err(BootstrapError::WrongPassword));

            // --- (3) the real idempotent install, twice, with fingerprint known/known_before semantics ---
            // NOTE: `known_before_any_connection` above is what proves "false on the
            // server's genuine first contact" — by THIS point in the test, earlier
            // connections (poison/cleanup/wrong-password) have already pinned it, so
            // `install_key`'s own event-driving check would read `known=true` for
            // every one of these from here on, exactly as production code would
            // report for a server this app has already talked to once.
            let first = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("the first install, with the correct password, must succeed");
            assert_eq!(first, KeyInstallOutcome::Installed);

            let fingerprint_after_first = read_pinned_fingerprint(kh.path(), &target.host, target.port).await;
            assert!(
                fingerprint_after_first.is_some(),
                "install_key's own password-step connection must TOFU-pin a host key fingerprint"
            );

            let known_before_second = host_key_pinned(kh.path(), &target.host, target.port).await;
            assert!(known_before_second, "the SAME host key must already be pinned before the second call");

            let second = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("the second install must also succeed");
            assert_eq!(second, KeyInstallOutcome::AlreadyPresent);

            let fingerprint_after_second = read_pinned_fingerprint(kh.path(), &target.host, target.port).await;
            assert_eq!(
                fingerprint_after_first, fingerprint_after_second,
                "the pinned fingerprint must not change across the second call"
            );

            // The key genuinely works: a fresh, independent BatchMode reconnect with it.
            let mut verify = keyed_ssh_options(target.port, Some(key.path()), Some(kh.path()));
            verify
                .arg("-T")
                .arg(format!("{}@{}", target.user, target.host))
                .arg("echo REMOTE_OK");
            let out = verify.output().await.expect("could not run ssh");
            assert!(out.status.success(), "key login must work: {}", String::from_utf8_lossy(&out.stderr));
            assert!(String::from_utf8_lossy(&out.stdout).contains("REMOTE_OK"));
        }

        /// PROVES the blocker fix: an `~/.ssh` symlink that resolves WITHIN `$HOME` (a
        /// dotfiles-managed setup, say) with a PRE-EXISTING `authorized_keys` living
        /// behind it is TOLERATED, not refused as escaping `$HOME`. Before the fix, the
        /// `~/.ssh` check already tolerated any within-$HOME symlink target via a glob
        /// pattern, but the `authorized_keys` check right after it used an EXACT
        /// literal match against `$HOME/.ssh/authorized_keys` — so a real
        /// `authorized_keys` living behind a within-$HOME `~/.ssh` symlink (anywhere
        /// other than that one exact literal path) was wrongly refused with
        /// `FLIGHTDECK_AUTHORIZED_KEYS_ESCAPES_HOME`, the SAME wording a genuine
        /// escaping-HOME attack produces — reproduced live against this very fixture
        /// while diagnosing the bug.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_a_tolerates_a_within_home_ssh_symlink_with_existing_authorized_keys() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_A_PORT, user: FIXTURE_A_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-a-dotfiles-ssh");
            let kh = ScratchKnownHosts::new("fixture-a-dotfiles-ssh");

            // A dotfiles-managed ~/.ssh: a within-$HOME symlink pointing at a real
            // directory that ALREADY has an authorized_keys file behind it (non-empty,
            // like a real one would be) — every path here resolves under $HOME, so
            // none of it should be refused.
            let setup = "rm -rf ~/.ssh ~/dotfiles; mkdir -p ~/dotfiles/ssh; \
                          printf '# pre-existing\\n' > ~/dotfiles/ssh/authorized_keys; \
                          ln -s ~/dotfiles/ssh ~/.ssh";
            let setup_cmd = askpass::bootstrap_ssh_command(&target.ssh_destination(), None, Some(kh.path()), setup);
            let out = askpass::run_with_password(setup_cmd, FIXTURE_A_PASSWORD, None, Duration::from_secs(15))
                .await
                .expect("setting up the dotfiles-style ~/.ssh symlink must succeed");
            assert!(out.status.success(), "dotfiles setup failed: {}", String::from_utf8_lossy(&out.stderr));

            let outcome = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect(
                    "a within-$HOME ~/.ssh symlink with an existing authorized_keys behind it must \
                     be tolerated, not refused as escaping $HOME",
                );
            assert_eq!(outcome, KeyInstallOutcome::Installed);

            // Prove the key was appended to the REAL file behind the symlink (not
            // silently dropped, and not some fresh ~/.ssh materialized alongside the
            // symlink instead of through it) — a genuine BatchMode reconnect using it
            // must work, exactly like the ordinary (no-symlink) case.
            let mut verify = keyed_ssh_options(target.port, Some(key.path()), Some(kh.path()));
            verify
                .arg("-T")
                .arg(format!("{}@{}", target.user, target.host))
                .arg("echo REMOTE_OK");
            let out = verify.output().await.expect("could not run ssh");
            assert!(
                out.status.success(),
                "key login through the dotfiles symlink must work: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(String::from_utf8_lossy(&out.stdout).contains("REMOTE_OK"));
        }

        /// PROVES the brief's explicit "verification failure" scenario end to end — the
        /// one live scenario the original review found completely unexercised:
        /// `install_key`'s password step succeeds (it never uses key auth at all — see
        /// `bootstrap_ssh_command`'s own doc — so disabling the server's key auth
        /// afterward doesn't touch it), but the verify-reconnect that follows DOES use
        /// the key, and genuinely fails once `PubkeyAuthentication` is turned off
        /// server-side (flipped AFTER a first successful install, via `docker exec` —
        /// mirrors the host-key-regeneration test's own technique). Proves this
        /// "accepted the password but the key path specifically is broken" state
        /// surfaces LOUDLY as `KeyInstalledButNotAccepted` with the sshd hint, never a
        /// silent bare success.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_a_verify_failure_surfaces_as_key_installed_but_not_accepted() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_A_PORT, user: FIXTURE_A_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-a-verify-fail");
            let kh = ScratchKnownHosts::new("fixture-a-verify-fail");

            let first = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("the first install (append + verify) must succeed");
            assert_eq!(first, KeyInstallOutcome::Installed);

            // Break ONLY the key path from outside.
            let disable_pubkey = std::process::Command::new("docker")
                .args([
                    "exec",
                    "fd-fixture-a",
                    "sh",
                    "-c",
                    "echo 'PubkeyAuthentication no' >> /etc/ssh/sshd_config && systemctl restart ssh",
                ])
                .output()
                .expect("docker exec must be available");
            assert!(
                disable_pubkey.status.success(),
                "disabling PubkeyAuthentication failed: {}",
                String::from_utf8_lossy(&disable_pubkey.stderr)
            );

            let second = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path()).await;
            match second {
                Err(BootstrapError::KeyInstalledButNotAccepted(hint)) => {
                    assert!(
                        hint.contains("PubkeyAuthentication"),
                        "the hint must mention PubkeyAuthentication, got: {hint:?}"
                    );
                }
                other => panic!("expected KeyInstalledButNotAccepted, got {other:?}"),
            }
        }

        /// PROVES `install_key` works end to end against `root` (fixture B, `sudo` not
        /// even installed) — the "no sudo at all, but you ARE root" shape — and that
        /// [`probe`] reports a sane, no-conflict picture on a vanilla node.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_b_root_install_key_and_probe_work() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("b");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_B_PORT, user: FIXTURE_B_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-b");
            let kh = ScratchKnownHosts::new("fixture-b");

            let outcome = install_key(&target, FIXTURE_B_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("install_key against root must succeed");
            assert_eq!(outcome, KeyInstallOutcome::Installed);

            let result = probe(&target, key.path(), kh.path())
                .await
                .expect("probe against an already-keyed root connection must succeed");
            assert_eq!(result.systemd, Some(true), "every fixture boots systemd as PID 1");
            assert_eq!(result.conflict, None, "a vanilla node must report no conflict");
            assert_eq!(result.os.as_deref(), Some("Linux"));
        }

        /// PROVES [`probe`]'s conflict detection against fixture C, whose `flightdeckd`
        /// is ALREADY installed as a root-owned system unit (mirrors the real
        /// `josty-cc` test server) — the exact scenario B7's brief calls out by name.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_c_probe_reports_the_system_unit_conflict() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("c");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_C_PORT, user: FIXTURE_C_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-c");
            let kh = ScratchKnownHosts::new("fixture-c");

            install_key(&target, FIXTURE_C_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("install_key against fixture C must succeed");

            let result = probe(&target, key.path(), kh.path())
                .await
                .expect("probe against fixture C must succeed");
            let conflict = result.conflict.expect("fixture C must report a conflict — it ships flightdeckd pre-installed");
            assert!(
                conflict.contains("system unit") || conflict.contains("flightdeckd.service"),
                "the conflict description must mention the system unit, got: {conflict:?}"
            );
        }

        /// PROVES [`probe`]'s best-effort facts against fixture D (`sudo` not even
        /// installed, non-root): `passwordless_sudo` must read `false` (never `None` —
        /// the absence of the `sudo` binary itself is a confident "no", not an
        /// unknown), and `linger` reads the real default (`no`) via `loginctl`, which
        /// works fine here since every fixture — D included — boots systemd/logind.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_fixture_d_probe_reports_no_passwordless_sudo_and_no_linger() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("d");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_D_PORT, user: FIXTURE_D_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-d");
            let kh = ScratchKnownHosts::new("fixture-d");

            install_key(&target, FIXTURE_D_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("install_key against fixture D must succeed");

            let result = probe(&target, key.path(), kh.path())
                .await
                .expect("probe against fixture D must succeed");
            assert_eq!(result.passwordless_sudo, Some(false), "fixture D has no sudo binary at all");
            assert_eq!(result.linger, Some(false), "a fresh user's Linger defaults to no");
        }

        /// PROVES the host-key-change path end to end: pin a fixture's REAL host key,
        /// then genuinely regenerate it INSIDE the running container (`ssh-keygen -A`
        /// + `systemctl restart ssh` — VERIFIED the only way to actually change it:
        /// `fixture.sh up` alone reuses the SAME baked-in key across rebuilds, since
        /// it's generated once at IMAGE BUILD time, not per-container), proving a
        /// reconnect against the STALE pin fails as `HostKeyMismatch`, and that
        /// [`forget_host_key`] recovers it.
        #[tokio::test]
        #[ignore = "needs Docker (colima start) + the flightdeck-server repo checked out as a sibling"]
        async fn live_host_key_change_is_detected_then_recoverable_via_forget_host_key() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("b");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_B_PORT, user: FIXTURE_B_USER.to_string() };
            let key = ThrowawayKey::generate("host-key-change");
            let kh = ScratchKnownHosts::new("host-key-change");

            let first = install_key(&target, FIXTURE_B_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("the first connection must pin the fixture's real host key");
            assert_eq!(first, KeyInstallOutcome::Installed);
            let fingerprint_before = read_pinned_fingerprint(kh.path(), &target.host, target.port)
                .await
                .expect("a fingerprint must be pinned after a successful connection");

            // Regenerate the container's ACTUAL host key from the outside (root via
            // `docker exec`) — this is a genuinely different key, not a re-pin of the
            // same one.
            let regen = std::process::Command::new("docker")
                .args([
                    "exec",
                    "fd-fixture-b",
                    "sh",
                    "-c",
                    "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null 2>&1 && systemctl restart ssh",
                ])
                .output()
                .expect("docker exec must be available");
            assert!(regen.status.success(), "regenerating the host key failed: {}", String::from_utf8_lossy(&regen.stderr));

            // A reconnect against the STALE pin must fail as HostKeyMismatch — proven
            // via the verify-reconnect path inside `install_key` (the password step
            // itself would ALSO trip this the same way; either ssh invocation in this
            // module hits the exact same OpenSSH client behavior).
            let mismatched = install_key(&target, FIXTURE_B_PASSWORD, key.path(), &key.public, kh.path()).await;
            assert_eq!(mismatched, Err(BootstrapError::HostKeyMismatch));

            let fingerprint_still_pinned = read_pinned_fingerprint(kh.path(), &target.host, target.port)
                .await
                .expect("the OLD fingerprint must still be the one pinned — a mismatch must never silently overwrite it");
            assert_eq!(fingerprint_still_pinned, fingerprint_before);

            forget_host_key(kh.path(), &target.host, target.port)
                .await
                .expect("forgetting the stale host key must succeed");
            assert!(
                read_pinned_fingerprint(kh.path(), &target.host, target.port).await.is_none(),
                "nothing should be pinned right after forgetting it"
            );

            // Reconnecting now succeeds and re-pins the NEW (different) fingerprint.
            let recovered = install_key(&target, FIXTURE_B_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("reconnecting after forget_host_key must succeed and re-pin the new key");
            assert_eq!(recovered, KeyInstallOutcome::AlreadyPresent, "the key itself was never removed, only the host pin");
            let fingerprint_after = read_pinned_fingerprint(kh.path(), &target.host, target.port)
                .await
                .expect("a fingerprint must be pinned again after recovering");
            assert_ne!(fingerprint_after, fingerprint_before, "the newly pinned fingerprint must be the REGENERATED key");
        }
    }
}
