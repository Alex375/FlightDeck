//! First contact with a server the app has NEVER paired: the user typed host/port/user
//! and (once) a password. [`install_key`] appends the app's own dedicated key to
//! `~/.ssh/authorized_keys` over B5's password-only relay, [`probe`] then reads the
//! full install-mode picture back over the crate's normal keyed path, and
//! [`replace_host_key`] lets the user recover from a genuinely-changed host key. This is
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
//! `spawn_session`/`add_machine`). The password connection checks it STRICTLY (M12,
//! security review 2026-10-09): a first-contact host key is read beforehand with no
//! secret of any kind on the wire ([`scan_host_key`]), its fingerprint is shown to the
//! user, and it is pinned only once they confirm it ([`ensure_confirmed_host_key`]) —
//! the password then goes to exactly that key or nowhere. A host-key
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
    /// SSH login name — POSSIBLY ATTACKER-CONTROLLED: a pairing ticket
    /// (`fdpair:<base64 json>`, see `ControlSection.tsx::parseTicket`) is printed by
    /// the SERVER, so a hostile or compromised server can hand back a ticket that
    /// pre-fills a malicious `user`. Every ssh call this module makes from a
    /// `BootstrapTarget` goes through [`crate::ipc::commands::push_ssh_destination`] /
    /// [`askpass::bootstrap_ssh_command`], which validate it (and `host`) before ever
    /// building a destination argument — never trust this field un-validated.
    pub user: String,
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
/// the app's dedicated file (this function's own callers always pass
/// `app_data/remote_known_hosts`), and the server's host key must ALREADY be pinned
/// there: the password connection checks it strictly (`StrictHostKeyChecking=yes`,
/// baked into `bootstrap_ssh_command`) and never pins anything itself. Callers run
/// [`ensure_confirmed_host_key`] first — see the module doc.
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
    let cmd = askpass::bootstrap_ssh_command(
        &target.user,
        &target.host,
        target.port,
        None,
        Some(known_hosts),
        INSTALL_KEY_SCRIPT,
    )
    .map_err(BootstrapError::Other)?;
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
    cmd.arg("-T");
    crate::ipc::commands::push_ssh_destination(&mut cmd, &target.user, &target.host)
        .map_err(BootstrapError::Other)?;
    cmd.arg("true");
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
// Host key fingerprint (known_hosts lookups)
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
#[cfg(test)]
fn parse_host_key_fingerprint(stdout: &str) -> Option<String> {
    let fingerprints = parse_host_key_fingerprints(stdout);
    fingerprints
        .iter()
        .find(|(keytype, _)| keytype == "ED25519")
        .or_else(|| fingerprints.first())
        .map(|(_, fingerprint)| fingerprint.clone())
}

/// Every `(KEYTYPE, fingerprint)` pair in `ssh-keygen -l -F`'s stdout, in order (see
/// [`parse_host_key_fingerprint`] for the format). Pure.
fn parse_host_key_fingerprints(stdout: &str) -> Vec<(String, String)> {
    // Every fingerprint line's 3rd column starts with `SHA256:` (the default, and
    // only, digest format every currently-supported OpenSSH emits for `-l`) — this is
    // what tells a real data line apart from unrelated/garbled text that merely HAS
    // three whitespace-separated tokens (proven by
    // `fingerprint_parsing_returns_none_on_garbled_output` below).
    stdout
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            parts.next()?; // the host pattern column — not needed, just consumed
            let keytype = parts.next()?;
            let fingerprint = parts.next()?;
            fingerprint.starts_with("SHA256:").then(|| (keytype.to_string(), fingerprint.to_string()))
        })
        .collect()
}

/// Whether `(host, port)` already has a pinned entry in `known_hosts`.
#[cfg(test)]
pub(crate) async fn host_key_pinned(known_hosts: &str, host: &str, port: u16) -> bool {
    read_pinned_fingerprint(known_hosts, host, port).await.is_some()
}

/// Reads back the fingerprint pinned for `(host, port)` in `known_hosts`, or `None`
/// when nothing is pinned there (including a `known_hosts` file that doesn't exist
/// yet). Test-only now: the GATE before a password is [`ensure_confirmed_host_key`],
/// which also reports the fingerprint the `HostKeyFingerprintEvent` shows.
#[cfg(test)]
pub(crate) async fn read_pinned_fingerprint(known_hosts: &str, host: &str, port: u16) -> Option<String> {
    // Last line of defense (item 5 of the CRM holistic-review blocker fix): never
    // hand `ssh-keygen` a pattern built from a `host` that failed the SAME rule every
    // other ssh-argv builder in this crate enforces, even though `-F`'s own argument
    // grammar already isn't vulnerable to the `user@host` injection class this rule
    // exists for (see `crate::store::validate_address_value`'s own doc). Degrades to
    // "nothing pinned" rather than an error — this function is display-only/non-
    // blocking by design.
    crate::store::validate_address_value(host).ok()?;
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

/// What `ssh -G` resolves a typed host to — the names ssh files its host key under. No
/// port: [`resolve_ssh_host`] passes `-p`, which wins over any config `Port`, so the
/// resolved port is always the one it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ResolvedSshHost {
    /// `HostName` after this Mac's ssh config (the typed host when nothing rewrites it).
    hostname: Option<String>,
    /// `HostKeyAlias`: ssh files the key under this name instead, without a port.
    host_key_alias: Option<String>,
}

/// Parses `ssh -G`'s `key value` lines (lowercase keys; an unset `hostkeyalias` is
/// simply absent). Pure.
fn parse_ssh_g_output(stdout: &str) -> ResolvedSshHost {
    let mut resolved = ResolvedSshHost::default();
    for line in stdout.lines() {
        let Some((key, value)) = line.trim().split_once(char::is_whitespace) else { continue };
        let value = value.trim();
        if value.is_empty() || value.eq_ignore_ascii_case("none") {
            continue;
        }
        match key.to_ascii_lowercase().as_str() {
            "hostname" => resolved.hostname = Some(value.to_string()),
            "hostkeyalias" => resolved.host_key_alias = Some(value.to_string()),
            _ => {}
        }
    }
    resolved
}

/// Every `known_hosts` pattern ssh may have pinned `typed_host`'s key under, distinct
/// and in order: the typed host and its resolved `HostName` with `port` (`[name]:port`
/// off 22 — the port the connection dials, which `ssh -G -p` also resolved to), and a `HostKeyAlias` both bare — how ssh files it
/// (`sshconnect.c`: an alias never carries the port) — and with the port. A resolved
/// name that fails [`crate::store::validate_address_value`] is left out (it never
/// reaches `ssh-keygen`), and the "nothing found" error lists what was looked for. Pure.
fn host_key_forget_patterns(typed_host: &str, port: u16, resolved: &ResolvedSshHost) -> Vec<String> {
    let valid = |name: &&String| crate::store::validate_address_value(name).is_ok();
    let mut candidates = vec![host_key_search_pattern(typed_host, port)];
    if let Some(hostname) = resolved.hostname.as_ref().filter(valid) {
        candidates.push(host_key_search_pattern(hostname, port));
    }
    if let Some(alias) = resolved.host_key_alias.as_ref().filter(valid) {
        candidates.push(alias.clone());
        candidates.push(host_key_search_pattern(alias, port));
    }
    let mut patterns: Vec<String> = Vec::new();
    for c in candidates {
        if !patterns.contains(&c) {
            patterns.push(c);
        }
    }
    patterns
}

/// `ssh -G` for `host`/`port`, read through this Mac's ssh config the way the app's
/// own connection reads it — `config` overrides that file (`-F`, tests only). The host
/// is validated before it reaches ssh, and follows `--`. Local only: `ssh -G` prints
/// the resolved configuration and exits without connecting.
async fn resolve_ssh_host(host: &str, port: u16, config: Option<&Path>) -> Result<ResolvedSshHost, String> {
    crate::store::validate_address_value(host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(config) = config {
        cmd.arg("-F").arg(config);
    }
    cmd.arg("-G").arg("-p").arg(port.to_string()).arg("--").arg(host);
    // A `Match exec` in the config could hang; resolving must not.
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| "ssh -G timed out".to_string())?
        .map_err(|e| format!("could not run ssh: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("ssh -G failed")
            .trim()
            .to_string());
    }
    Ok(parse_ssh_g_output(&String::from_utf8_lossy(&out.stdout)))
}

/// Removes every one of `patterns` pinned in `known_hosts` (`ssh-keygen -F` to look,
/// `-R` to remove), returning the ones that were there. A missing `known_hosts` holds
/// nothing. Any `ssh-keygen` failure — neither "found" (0) nor "not found" (1) on a
/// lookup, or a failed removal — is an `Err` carrying its own last stderr line.
async fn forget_host_key_patterns(known_hosts: &str, patterns: &[String]) -> Result<Vec<String>, BootstrapError> {
    if !Path::new(known_hosts).exists() {
        return Ok(Vec::new());
    }
    let last_stderr_line = |out: &std::process::Output, fallback: &str| {
        String::from_utf8_lossy(&out.stderr)
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or(fallback)
            .trim()
            .to_string()
    };
    let mut forgotten = Vec::new();
    for pattern in patterns {
        let lookup = tokio::process::Command::new("ssh-keygen")
            .arg("-F")
            .arg(pattern)
            .arg("-f")
            .arg(known_hosts)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| BootstrapError::Other(format!("could not run ssh-keygen: {e}")))?;
        match lookup.status.code() {
            Some(0) => {}
            Some(1) => continue,
            _ => {
                return Err(BootstrapError::Other(format!(
                    "could not read Flight Deck's known hosts: {}",
                    last_stderr_line(&lookup, "ssh-keygen -F failed")
                )))
            }
        }
        let removal = tokio::process::Command::new("ssh-keygen")
            .arg("-R")
            .arg(pattern)
            .arg("-f")
            .arg(known_hosts)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| BootstrapError::Other(format!("could not run ssh-keygen: {e}")))?;
        if !removal.status.success() {
            return Err(BootstrapError::Other(last_stderr_line(&removal, "ssh-keygen -R failed")));
        }
        forgotten.push(pattern.clone());
    }
    Ok(forgotten)
}

// ============================================================================
// Host key check before any secret is sent (M12 / I6)
// ============================================================================

/// How the key a server presents RIGHT NOW compares with what this Mac has saved for it
/// in the dedicated `known_hosts` — see [`classify_host_key`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyTrust {
    /// Nothing saved for this server: first contact. Its fingerprint must be confirmed
    /// before a password is sent to it.
    New,
    /// The presented key is the one saved.
    Known,
    /// A key of the same type is saved, and it is not this one.
    Changed,
}

/// What [`bootstrap_check_host_key`] reports to the "Add a server" wizard and the
/// "Connect an existing server" form: the key the server presents now, next to what
/// this Mac has saved for it, read without sending any secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct HostKeyCheck {
    pub host: String,
    pub port: u16,
    /// `ED25519`, `ECDSA`, `RSA`, … — which `/etc/ssh/ssh_host_<type>_key.pub` to
    /// compare on the server's own console.
    pub key_type: String,
    /// `SHA256:…` of the key the server presents right now.
    pub fingerprint: String,
    pub trust: HostKeyTrust,
    /// Every fingerprint this Mac has saved for that server (empty when `New`).
    pub saved_fingerprints: Vec<String>,
}

/// The key one [`scan_host_key`] read, ready to be pinned verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScannedHostKey {
    /// The `known_hosts` line(s) ssh itself wrote for this key — pinned as-is, so the
    /// real connection (same ssh config, same host and port) finds exactly this key
    /// under exactly the name it looks for.
    lines: Vec<String>,
    /// The names ssh filed it under (the pattern column, comma-split) — where to look
    /// for a key this Mac already saved.
    patterns: Vec<String>,
    /// Short type, as `ssh-keygen -l` prints it (`ED25519`, …).
    key_type: String,
    /// `SHA256:…`.
    fingerprint: String,
}

/// One `known_hosts` line's three columns. `None` for a blank line, a comment, or a
/// marker line (`@cert-authority`/`@revoked`) — none of which a scan ever writes. Pure.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KnownHostsEntry {
    pattern: String,
    key_type: String,
    key_blob: String,
}

fn parse_known_hosts_line(line: &str) -> Option<KnownHostsEntry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
        return None;
    }
    let mut parts = line.split_whitespace();
    let pattern = parts.next()?.to_string();
    let key_type = parts.next()?.to_string();
    let key_blob = parts.next()?.to_string();
    Some(KnownHostsEntry { pattern, key_type, key_blob })
}

/// `SHA256:<unpadded base64 of sha256(key blob)>` — the exact string `ssh`,
/// `ssh-keygen -l` and `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` print, so the user
/// can compare it character for character on the server. `None` for a blob that isn't
/// base64. Pure.
pub(crate) fn sha256_fingerprint(key_blob_b64: &str) -> Option<String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let raw = base64::engine::general_purpose::STANDARD.decode(key_blob_b64).ok()?;
    if raw.is_empty() {
        return None;
    }
    let digest = Sha256::digest(&raw);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

/// The short type name `ssh-keygen -l` prints for a `known_hosts` key type — the SAME
/// spelling [`parse_host_key_fingerprints`] reads back, so a scanned key and a saved one
/// compare directly. Pure.
fn short_key_type(key_type: &str) -> String {
    match key_type {
        "ssh-ed25519" => "ED25519".to_string(),
        "sk-ssh-ed25519@openssh.com" => "ED25519-SK".to_string(),
        "sk-ecdsa-sha2-nistp256@openssh.com" => "ECDSA-SK".to_string(),
        "ssh-rsa" => "RSA".to_string(),
        "ssh-dss" => "DSA".to_string(),
        t if t.starts_with("ecdsa-sha2-") => "ECDSA".to_string(),
        other => other.to_uppercase(),
    }
}

/// What [`scan_host_key`]'s scratch `known_hosts` ended up holding → the one key the
/// server presented. Several lines are tolerated only when they all carry the SAME key
/// (one name per line); two different keys from one scan is refused rather than
/// guessed between. Pure.
fn scanned_key_from_known_hosts(contents: &str) -> Result<ScannedHostKey, String> {
    let entries: Vec<KnownHostsEntry> = contents.lines().filter_map(parse_known_hosts_line).collect();
    let first = entries.first().ok_or_else(|| "the server presented no host key".to_string())?;
    if entries.iter().any(|e| e.key_blob != first.key_blob || e.key_type != first.key_type) {
        return Err("the server presented more than one host key".to_string());
    }
    let fingerprint =
        sha256_fingerprint(&first.key_blob).ok_or_else(|| "the server's host key could not be read".to_string())?;
    let mut patterns: Vec<String> = Vec::new();
    for name in entries.iter().flat_map(|e| e.pattern.split(',')) {
        if !name.is_empty() && !patterns.iter().any(|p| p == name) {
            patterns.push(name.to_string());
        }
    }
    Ok(ScannedHostKey {
        lines: entries.iter().map(|e| format!("{} {} {}", e.pattern, e.key_type, e.key_blob)).collect(),
        patterns,
        key_type: short_key_type(&first.key_type),
        fingerprint,
    })
}

/// The names to look a saved key up under: the ones ssh itself filed the scanned key
/// under (its own resolution of the typed host through this Mac's ssh config — exactly
/// what the real connection looks up), never a hashed name or one that could read as an
/// `ssh-keygen` option. Falls back to the typed host's own pattern only when ssh gave
/// nothing usable. Pure.
fn host_key_lookup_patterns(scanned: &ScannedHostKey, typed_host: &str, port: u16) -> Vec<String> {
    let usable: Vec<String> = scanned
        .patterns
        .iter()
        .filter(|p| !p.starts_with('|') && !p.starts_with('-'))
        .cloned()
        .collect();
    if !usable.is_empty() {
        return usable;
    }
    if crate::store::validate_address_value(typed_host).is_ok() {
        vec![host_key_search_pattern(typed_host, port)]
    } else {
        Vec::new()
    }
}

/// Compares the scanned key with what is saved (`(KEYTYPE, fingerprint)` pairs).
/// Saved under OTHER key types only counts as `Known`: the real connection prefers a
/// key type it already knows and, checking strictly, refuses any key it has no pin for
/// — so the saved pin, not this scan, decides that connection. Pure.
fn classify_host_key(key_type: &str, fingerprint: &str, saved: &[(String, String)]) -> HostKeyTrust {
    if saved.is_empty() {
        HostKeyTrust::New
    } else if saved.iter().any(|(_, fp)| fp == fingerprint) {
        HostKeyTrust::Known
    } else if saved.iter().any(|(t, _)| t == key_type) {
        HostKeyTrust::Changed
    } else {
        HostKeyTrust::Known
    }
}

/// What to do before a password goes to a server — see [`host_key_gate`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostKeyGate {
    /// The saved pin covers it: the strict password connection checks against it.
    Proceed,
    /// First contact, and the user confirmed exactly this fingerprint: pin it first.
    Pin,
    /// Send nothing.
    Refuse(BootstrapError),
}

/// The M12 decision, pure: a password only ever goes to a key already saved, or to the
/// exact first-contact key whose fingerprint the user confirmed.
pub(crate) fn host_key_gate(trust: HostKeyTrust, presented: &str, confirmed: Option<&str>) -> HostKeyGate {
    match trust {
        HostKeyTrust::Known => HostKeyGate::Proceed,
        HostKeyTrust::Changed => HostKeyGate::Refuse(BootstrapError::HostKeyMismatch),
        HostKeyTrust::New => match confirmed {
            Some(c) if c == presented => HostKeyGate::Pin,
            Some(c) => HostKeyGate::Refuse(BootstrapError::Other(format!(
                "the server now presents host key {presented}, not the {c} you confirmed — nothing was sent to it; check the server before trying again"
            ))),
            None => HostKeyGate::Refuse(BootstrapError::HostKeyUnconfirmed(presented.to_string())),
        },
    }
}

/// The `ssh` invocation [`scan_host_key`] runs: it completes the key exchange — which
/// is where a server proves it holds its host key — and records that key in a SCRATCH
/// `known_hosts`, while offering no credential of any kind (no password, no key, no
/// agent, no Kerberos): the server only ever sees a login name and a `none`
/// authentication request, which it refuses. Reads this Mac's ssh config like every
/// other connection (so `HostName`/`HostKeyAlias`/`ProxyJump` resolve the same way),
/// but the options below are given on the command line and so win over it.
fn host_key_scan_command(port: u16, scratch_known_hosts: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true).arg("-T").arg("-p").arg(port.to_string());
    let options = [
        "BatchMode=yes".to_string(),
        "ConnectTimeout=10".to_string(),
        // Record whatever key answers — into the scratch file only, never the
        // dedicated one: nothing is trusted until the user confirms the fingerprint.
        "StrictHostKeyChecking=accept-new".to_string(),
        format!("UserKnownHostsFile={scratch_known_hosts}"),
        "GlobalKnownHostsFile=/dev/null".to_string(),
        // A readable name to look a saved key up by, and one line per key (no extra
        // IP-address entry).
        "HashKnownHosts=no".to_string(),
        "CheckHostIP=no".to_string(),
        "UpdateHostKeys=no".to_string(),
        // A live multiplexed master would skip the key exchange altogether.
        "ControlMaster=no".to_string(),
        "ControlPath=none".to_string(),
        "PubkeyAuthentication=no".to_string(),
        "PasswordAuthentication=no".to_string(),
        "KbdInteractiveAuthentication=no".to_string(),
        "GSSAPIAuthentication=no".to_string(),
        "HostbasedAuthentication=no".to_string(),
        "IdentitiesOnly=yes".to_string(),
        "IdentityAgent=none".to_string(),
    ];
    for option in options {
        cmd.arg("-o").arg(option);
    }
    cmd
}

/// A private (0700) scratch directory removed on drop — holds [`scan_host_key`]'s
/// throwaway `known_hosts`, so cancelling a first contact leaves no key behind anywhere.
struct ScratchDir(std::path::PathBuf);

impl ScratchDir {
    fn new() -> Result<Self, BootstrapError> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("flightdeck-hostkey-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| BootstrapError::Other(format!("could not create a scratch directory: {e}")))?;
        Ok(Self(dir))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Why a scan recorded no key: unreachable, or ssh's own last word.
fn scan_failure(stderr: &str) -> BootstrapError {
    if askpass::is_host_unreachable(stderr) {
        return BootstrapError::HostUnreachable;
    }
    let last = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("ssh failed");
    BootstrapError::Other(format!("could not read this server's host key: {last}"))
}

/// Reads the host key `target` presents WITHOUT sending any secret (see
/// [`host_key_scan_command`]) and without touching the dedicated `known_hosts`.
pub(crate) async fn scan_host_key(target: &BootstrapTarget) -> Result<ScannedHostKey, BootstrapError> {
    let scratch = ScratchDir::new()?;
    let known_hosts = scratch.0.join("known_hosts");
    std::fs::write(&known_hosts, "")
        .map_err(|e| BootstrapError::Other(format!("could not create a scratch known_hosts: {e}")))?;
    let known_hosts_str = known_hosts
        .to_str()
        .ok_or_else(|| BootstrapError::Other("the scratch directory's path is not UTF-8".to_string()))?;
    let mut cmd = host_key_scan_command(target.port, known_hosts_str);
    crate::ipc::commands::push_ssh_destination(&mut cmd, &target.user, &target.host)
        .map_err(BootstrapError::Other)?;
    cmd.arg("true");
    let out = tokio::time::timeout(crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| BootstrapError::Timeout)?
        .map_err(|e| BootstrapError::Other(format!("could not run ssh: {e}")))?;
    let contents = std::fs::read_to_string(&known_hosts).unwrap_or_default();
    if contents.lines().any(|l| parse_known_hosts_line(l).is_some()) {
        return scanned_key_from_known_hosts(&contents).map_err(BootstrapError::Other);
    }
    Err(scan_failure(&String::from_utf8_lossy(&out.stderr)))
}

/// Every `(KEYTYPE, fingerprint)` saved in `known_hosts` under any of `patterns`, in
/// order, without duplicates. A missing file saves nothing; an `ssh-keygen` that
/// neither finds (0) nor misses (1) is an `Err` — never read as "nothing saved", which
/// would turn an unreadable file into a first contact.
async fn saved_host_keys(known_hosts: &str, patterns: &[String]) -> Result<Vec<(String, String)>, BootstrapError> {
    if !Path::new(known_hosts).exists() {
        return Ok(Vec::new());
    }
    let mut saved: Vec<(String, String)> = Vec::new();
    for pattern in patterns {
        let out = tokio::process::Command::new("ssh-keygen")
            .arg("-l")
            .arg("-F")
            .arg(pattern)
            .arg("-f")
            .arg(known_hosts)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| BootstrapError::Other(format!("could not run ssh-keygen: {e}")))?;
        match out.status.code() {
            Some(0) => {
                for pair in parse_host_key_fingerprints(&String::from_utf8_lossy(&out.stdout)) {
                    if !saved.contains(&pair) {
                        saved.push(pair);
                    }
                }
            }
            Some(1) => {}
            _ => {
                let last = String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .rev()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .unwrap_or("ssh-keygen -F failed")
                    .to_string();
                return Err(BootstrapError::Other(format!("could not read Flight Deck's known hosts: {last}")));
            }
        }
    }
    Ok(saved)
}

/// Scan `target` and compare with what `known_hosts` saved for it. Sends no secret.
pub(crate) async fn check_host_key(
    target: &BootstrapTarget,
    known_hosts: &str,
) -> Result<(HostKeyCheck, ScannedHostKey), BootstrapError> {
    let scanned = scan_host_key(target).await?;
    let saved = saved_host_keys(known_hosts, &host_key_lookup_patterns(&scanned, &target.host, target.port)).await?;
    let trust = classify_host_key(&scanned.key_type, &scanned.fingerprint, &saved);
    let mut saved_fingerprints: Vec<String> = Vec::new();
    for (_, fp) in saved {
        if !saved_fingerprints.contains(&fp) {
            saved_fingerprints.push(fp);
        }
    }
    let check = HostKeyCheck {
        host: target.host.clone(),
        port: target.port,
        key_type: scanned.key_type.clone(),
        fingerprint: scanned.fingerprint.clone(),
        trust,
        saved_fingerprints,
    };
    Ok((check, scanned))
}

/// Serializes this module's own writes to the dedicated `known_hosts` (a pin's append,
/// a replacement's `ssh-keygen -R` rewrite + append): two of them interleaving could
/// lose one. ssh's own `accept-new` appends from keyed connections are not ours to
/// lock, but none of those runs against a host this module is pinning.
static KNOWN_HOSTS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Appends `lines` to `known_hosts` (created 0600 when missing), on a line of their
/// own even when the file's last line lacks its newline. One write call.
fn append_known_hosts_lines(known_hosts: &Path, lines: &[String]) -> std::io::Result<()> {
    use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new().read(true).append(true).create(true).mode(0o600).open(known_hosts)?;
    let mut text = String::new();
    if file.metadata()?.len() > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            text.push('\n');
        }
    }
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    file.write_all(text.as_bytes())
}

/// Removes every entry under `patterns`, then pins `scanned` — the core of
/// [`replace_host_key`], testable against a scratch file.
async fn replace_pinned_key(known_hosts: &str, patterns: &[String], scanned: &ScannedHostKey) -> Result<(), BootstrapError> {
    forget_host_key_patterns(known_hosts, patterns).await?;
    append_known_hosts_lines(Path::new(known_hosts), &scanned.lines)
        .map_err(|e| BootstrapError::Other(format!("could not save the host key in Flight Deck's known hosts: {e}")))
}

/// What [`ensure_confirmed_host_key`] let through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfirmedHostKey {
    pub fingerprint: String,
    /// Already saved before this call (`false`: pinned just now, on confirmation).
    pub known_before: bool,
}

/// The gate before ANY password goes to `target` (M12): scan its key with no secret
/// sent, then [`host_key_gate`] — proceed when the saved pin covers it, pin it first
/// when it is a first contact whose fingerprint the user confirmed (`confirmed`), and
/// refuse otherwise ([`BootstrapError::HostKeyMismatch`] for a changed key,
/// [`BootstrapError::HostKeyUnconfirmed`] for an unconfirmed new one). Nothing is
/// written unless it pins.
pub(crate) async fn ensure_confirmed_host_key(
    target: &BootstrapTarget,
    known_hosts: &str,
    confirmed: Option<&str>,
) -> Result<ConfirmedHostKey, BootstrapError> {
    let _lock = KNOWN_HOSTS_LOCK.lock().await;
    let (check, scanned) = check_host_key(target, known_hosts).await?;
    match host_key_gate(check.trust, &check.fingerprint, confirmed) {
        HostKeyGate::Proceed => Ok(ConfirmedHostKey { fingerprint: check.fingerprint, known_before: true }),
        HostKeyGate::Pin => {
            append_known_hosts_lines(Path::new(known_hosts), &scanned.lines).map_err(|e| {
                BootstrapError::Other(format!("could not save the host key in Flight Deck's known hosts: {e}"))
            })?;
            Ok(ConfirmedHostKey { fingerprint: check.fingerprint, known_before: false })
        }
        HostKeyGate::Refuse(e) => Err(e),
    }
}

/// Replace the key saved for `target` with the one it presents now — only if that is
/// exactly `confirmed_new`, the fingerprint the user was shown next to the saved one
/// and confirmed (I6). The old key is removed under every name ssh may have filed it
/// (what the scan says ssh uses now, plus the typed host's `~/.ssh/config`
/// resolutions — see [`host_key_forget_patterns`]); the new one is pinned in the same
/// step, so no later connection ever re-pins blindly in between. A key that is already
/// the saved one is left alone.
pub(crate) async fn replace_host_key(
    target: &BootstrapTarget,
    known_hosts: &str,
    confirmed_new: &str,
) -> Result<(), BootstrapError> {
    let _lock = KNOWN_HOSTS_LOCK.lock().await;
    let (check, scanned) = check_host_key(target, known_hosts).await?;
    if check.fingerprint != confirmed_new {
        return Err(BootstrapError::Other(format!(
            "the server now presents host key {}, not the {confirmed_new} you confirmed — the saved key was left as it was",
            check.fingerprint
        )));
    }
    if check.trust == HostKeyTrust::Known {
        return Ok(());
    }
    let resolved = resolve_ssh_host(&target.host, target.port, None).await.unwrap_or_default();
    let mut patterns = host_key_forget_patterns(&target.host, target.port, &resolved);
    for p in host_key_lookup_patterns(&scanned, &target.host, target.port) {
        if !patterns.contains(&p) {
            patterns.push(p);
        }
    }
    replace_pinned_key(known_hosts, &patterns, &scanned).await
}

/// Test-only: scan `target` (retrying while a freshly started fixture's sshd comes up)
/// and pin whatever it presents — what a confirmed first contact does, for the live
/// fixture tests that drive the strict password path directly.
#[cfg(test)]
pub(crate) async fn scan_and_pin_for_test(known_hosts: &str, target: &BootstrapTarget) -> Result<(), BootstrapError> {
    let mut last = BootstrapError::Timeout;
    for _ in 0..30 {
        match scan_host_key(target).await {
            Ok(scanned) => {
                return append_known_hosts_lines(Path::new(known_hosts), &scanned.lines)
                    .map_err(|e| BootstrapError::Other(e.to_string()))
            }
            Err(e) => {
                last = e;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(last)
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
///
/// `claude` is resolved through [`crate::ipc::commands::resolve_claude_bin_expr`] (B14)
/// — a bare `command -v claude` reported a genuinely-installed, official-installer
/// `claude` (which lands in `~/.local/bin`, never on a non-interactive ssh shell's
/// `PATH`) as missing.
const PROBE_SCRIPT_BODY: &str = r#"
MISSING=""
CLAUDE_VERSION=""
if [ -n "$CLAUDE_BIN" ] && (command -v "$CLAUDE_BIN" >/dev/null 2>&1 || [ -x "$CLAUDE_BIN" ]); then
    CLAUDE_VERSION=$("$CLAUDE_BIN" --version 2>/dev/null)
    # (review fix) Same discipline as `ipc::commands::PROBE_SCRIPT_BODY`'s sibling
    # copy: a present-but-broken binary (wrong arch/libc, a truncated download, a
    # dangling `versions/` dir) must not be reported as "installed" just because it
    # exists and is executable — only a ZERO exit AND non-empty output count as
    # "claude actually works". Without this, `StepId::InstallClaude`'s own
    # `claude_already_resolvable` skip-gate (fed by THIS script's `claude_missing`)
    # would skip re-installing over a broken binary, routing it straight into
    # `NeedsClaudeSignIn` instead.
    if [ $? -ne 0 ] || [ -z "$CLAUDE_VERSION" ]; then
        CLAUDE_VERSION=""
        MISSING="$MISSING claude"
    fi
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

/// [`PROBE_SCRIPT_BODY`] prefixed with the `CLAUDE_BIN` resolution line — same split as
/// `bootstrap::orchestrator::diagnose_script`'s own `FLIGHTDECKD_BIN` injection.
/// `pub(crate)` so it can be exercised directly by the crate-wide "no bare
/// `command -v claude`" regression test in `bootstrap::orchestrator`.
pub(crate) fn probe_script() -> String {
    format!("CLAUDE_BIN={}\n{}", crate::ipc::commands::resolve_claude_bin_expr(), PROBE_SCRIPT_BODY)
}

/// Probe a server that ALREADY holds the app's key (post [`install_key`]) for the
/// full picture [`RemoteProbeResult`] carries — both A1's original pairability facts
/// (`claude`/`flightdeckd` presence) and B7's install-mode facts (os/arch/systemd/
/// passwordless-sudo/linger/`KillUserProcesses`/`conflict`) — over the crate's normal
/// KEYED ssh path (never password: by this point in the bootstrap flow the key
/// already works, see the module doc). Parsing goes through the SAME
/// [`crate::ipc::commands::parse_probe_output`] A1's own pairing probe uses — one
/// parser, one struct (see that function's doc) — fed THIS module's own, extended
/// [`probe_script`]. A connection-level failure that is itself a host-key mismatch
/// (the server was reimaged, or something is impersonating it, since [`install_key`]
/// last pinned it) is classified as [`BootstrapError::HostKeyMismatch`] via
/// [`askpass::is_host_key_mismatch`] BEFORE falling through to `parse_probe_output`'s
/// generic "could not connect" string — otherwise this exact case (a LATER connect
/// against an already-keyed server, per this function's own doc) would be
/// indistinguishable from an ordinary connection failure once the error is flattened
/// to a `String` at the `#[tauri::command]` boundary, and a caller could never offer
/// [`replace_host_key`] in response to it.
///
/// (B14 fix round 3 — major) Bounded by
/// [`crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT`], the same guard
/// `orchestrator::diagnose` already applies to its own `cmd.output()`: this function
/// backs `step_probe` (the very first pipeline step after key install) and `repair`'s
/// `ReuploadDaemon`/generic `InstallService` arms, so a wedged remote shell — including
/// one stuck in the B14 broken-install check's own `"$CLAUDE_BIN" --version` — must not
/// stall them forever either.
pub async fn probe(
    target: &BootstrapTarget,
    identity_file: &str,
    known_hosts: &str,
) -> Result<RemoteProbeResult, BootstrapError> {
    let mut cmd = keyed_ssh_options(target.port, Some(identity_file), Some(known_hosts));
    cmd.arg("-T");
    crate::ipc::commands::push_ssh_destination(&mut cmd, &target.user, &target.host)
        .map_err(BootstrapError::Other)?;
    cmd.arg(probe_script());
    let out = tokio::time::timeout(crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| BootstrapError::Timeout)?
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
pub(crate) fn emit_host_key_fingerprint(app: &tauri::AppHandle, host: &str, port: u16, fingerprint: &str, known: bool) {
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

/// Validates one connection's `(host, port, user)` the way every ssh entry point does
/// (CRM holistic-review blocker #3, chantier A `bd7ca709`) and resolves the dedicated
/// `known_hosts`.
fn host_key_command_target(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
) -> Result<(BootstrapTarget, String), String> {
    crate::store::validate_address_value(&host)?;
    crate::store::validate_ssh_port(port)?;
    crate::store::validate_ssh_user(&user)?;
    let known_hosts =
        known_hosts_path(app).ok_or_else(|| "could not resolve the app's data directory".to_string())?;
    Ok((BootstrapTarget { host, port, user }, known_hosts))
}

/// Read the host key `host:port` presents and compare it with what this Mac saved —
/// WITHOUT sending any secret (M12). The wizard calls this before a login password goes
/// anywhere, to show a first contact's fingerprint for the user to confirm; both the
/// wizard and the "Connect an existing server" form call it on a mismatch, to show the
/// saved fingerprint next to the new one (I6). `user` is only the login name ssh
/// announces before its (refused) `none` authentication.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_check_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
) -> Result<HostKeyCheck, String> {
    let (target, known_hosts) = host_key_command_target(&app, host, port, user)?;
    check_host_key(&target, &known_hosts).await.map(|(check, _)| check).map_err(|e| e.to_string())
}

/// Replace a server's saved host key (after [`BootstrapError::HostKeyMismatch`]) with
/// the one it presents now — only when that is `new_fingerprint`, the key the user was
/// shown next to the saved one and confirmed (I6). See [`replace_host_key`]: the old key
/// goes under every name an `~/.ssh/config` alias resolves to, and the confirmed key is
/// pinned in the same step — never left for the next connection to re-pin unseen.
#[tauri::command]
#[specta::specta]
pub async fn bootstrap_forget_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    new_fingerprint: String,
) -> Result<(), String> {
    let (target, known_hosts) = host_key_command_target(&app, host, port, user)?;
    replace_host_key(&target, &known_hosts, &new_fingerprint).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- install_key rejects an ssh-option-injection user/host before ever
    // spawning (blocker fix — CRM chantier A bd7ca709) ----

    #[tokio::test]
    async fn install_key_rejects_an_option_injection_user_without_spawning_ssh() {
        let target = BootstrapTarget {
            host: "example.com".to_string(),
            port: 22,
            user: "-oProxyCommand=touch /tmp/pwned".to_string(),
        };
        let err = install_key(&target, "irrelevant", "/tmp/nonexistent-key", "ssh-ed25519 AAAA test", "/tmp/kh")
            .await
            .expect_err("an ssh-option-shaped user must be refused");
        assert!(matches!(err, BootstrapError::Other(_)));
    }

    #[tokio::test]
    async fn install_key_rejects_an_option_injection_host_without_spawning_ssh() {
        let target = BootstrapTarget {
            host: "-oProxyCommand=touch /tmp/pwned".to_string(),
            port: 22,
            user: "deploy".to_string(),
        };
        let err = install_key(&target, "irrelevant", "/tmp/nonexistent-key", "ssh-ed25519 AAAA test", "/tmp/kh")
            .await
            .expect_err("an ssh-option-shaped host must be refused");
        assert!(matches!(err, BootstrapError::Other(_)));
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

    // ---- forget_host_key: an ~/.ssh/config alias is forgotten under what it resolves to ----

    /// Excerpt of real `ssh -G -p 22 -- myalias` output (OpenSSH_10.3) for an alias
    /// with `HostName`, `Port` and `HostKeyAlias` — the command line's `-p` wins over
    /// the config's `Port`.
    #[test]
    fn parse_ssh_g_output_reads_hostname_and_alias() {
        let stdout = "user admin\nhostname 10.1.2.3\nport 22\nhostkeyalias pinned-name\naddressfamily any\n";
        assert_eq!(
            parse_ssh_g_output(stdout),
            ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: Some("pinned-name".into()) }
        );
        // An unset HostKeyAlias is simply absent from the output.
        let plain = parse_ssh_g_output("hostname example.com\nport 2200\n");
        assert_eq!(plain.host_key_alias, None);
        assert_eq!(parse_ssh_g_output(""), ResolvedSshHost::default());
    }

    #[test]
    fn host_key_forget_patterns_cover_every_name_ssh_may_have_pinned() {
        // Nothing rewrites the host: just itself, once.
        let same = ResolvedSshHost { hostname: Some("example.com".into()), host_key_alias: None };
        assert_eq!(host_key_forget_patterns("example.com", 22, &same), vec!["example.com".to_string()]);

        // An alias: the typed name AND its HostName, both with the resolved port.
        let alias = ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: None };
        assert_eq!(
            host_key_forget_patterns("myalias", 2200, &alias),
            vec!["[myalias]:2200".to_string(), "[10.1.2.3]:2200".to_string()]
        );

        // HostKeyAlias: filed bare by ssh, also tried with the port.
        let key_alias =
            ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: Some("pinned".into()) };
        assert_eq!(
            host_key_forget_patterns("myalias", 2200, &key_alias),
            vec![
                "[myalias]:2200".to_string(),
                "[10.1.2.3]:2200".to_string(),
                "pinned".to_string(),
                "[pinned]:2200".to_string(),
            ]
        );

        // A resolved name that fails address validation never reaches ssh-keygen.
        let invalid = ResolvedSshHost { hostname: Some("-oProxyCommand=x".into()), host_key_alias: None };
        assert_eq!(host_key_forget_patterns("myalias", 22, &invalid), vec!["myalias".to_string()]);
    }

    /// A scratch `known_hosts` holding one throwaway ed25519 key under each of
    /// `patterns`. Removed (with `ssh-keygen -R`'s `.old` backup) on drop.
    struct ScratchKnownHostsFile(std::path::PathBuf);

    impl ScratchKnownHostsFile {
        fn with(patterns: &[&str]) -> Self {
            let path = std::env::temp_dir().join(format!("fd-forget-kh-{}", uuid::Uuid::new_v4()));
            let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQn4iO0v6TSOXZ4/XheXm1CKcHaPA3KWoEBFM/Q1GKt";
            let lines: String = patterns.iter().map(|p| format!("{p} {key}\n")).collect();
            std::fs::write(&path, lines).unwrap();
            Self(path)
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }

        fn contents(&self) -> String {
            std::fs::read_to_string(&self.0).unwrap()
        }
    }

    impl Drop for ScratchKnownHostsFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_file(format!("{}.old", self.0.display()));
        }
    }

    // ---- Host key check before any secret is sent (M12 / I6) ----

    /// The throwaway key `ScratchKnownHostsFile` pins, and its fingerprint as
    /// `ssh-keygen -l` prints it (captured with OpenSSH_9.8).
    const OLD_BLOB: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIGQn4iO0v6TSOXZ4/XheXm1CKcHaPA3KWoEBFM/Q1GKt";
    const OLD_FP: &str = "SHA256:Y+1xbXiH1LUarmQuavun7h8cUpRXEvSbqwm0IcM4FiA";
    /// A second, unrelated ed25519 key (same capture).
    const NEW_BLOB: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIMp2wMVSvMO6Tn2abHoZ+G+ggpDJ28swcWCnebagD4Rs";
    const NEW_FP: &str = "SHA256:/Qg4/li+Q4AspKI0PyunFVuFlL3HCB7nlFDYbe2dy6c";
    /// An ECDSA key (same capture).
    const ECDSA_BLOB: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBAmfgydLt+ZPQ+5tYfnlNUdKNHGrFNY0F1aKCE4PdQAU9AiNZFmDyDHtCZUTOEy2EJnfp/zgMJ2NPjIpENLtwVM=";
    const ECDSA_FP: &str = "SHA256:Yx8LcxVVJTR+AoQYYLGHT1/4r7T3CQzd+p28QZHQHq8";

    fn scanned(pattern: &str, blob: &str) -> ScannedHostKey {
        scanned_key_from_known_hosts(&format!("{pattern} ssh-ed25519 {blob}\n")).unwrap()
    }

    #[test]
    fn sha256_fingerprint_matches_what_ssh_keygen_prints() {
        assert_eq!(sha256_fingerprint(OLD_BLOB).as_deref(), Some(OLD_FP));
        assert_eq!(sha256_fingerprint(NEW_BLOB).as_deref(), Some(NEW_FP));
        assert_eq!(sha256_fingerprint(ECDSA_BLOB).as_deref(), Some(ECDSA_FP));
        assert_eq!(sha256_fingerprint("not base64 at all!"), None);
        assert_eq!(sha256_fingerprint(""), None);
    }

    #[test]
    fn short_key_type_uses_ssh_keygens_spelling() {
        assert_eq!(short_key_type("ssh-ed25519"), "ED25519");
        assert_eq!(short_key_type("ecdsa-sha2-nistp256"), "ECDSA");
        assert_eq!(short_key_type("ecdsa-sha2-nistp521"), "ECDSA");
        assert_eq!(short_key_type("ssh-rsa"), "RSA");
        assert_eq!(short_key_type("sk-ssh-ed25519@openssh.com"), "ED25519-SK");
    }

    #[test]
    fn known_hosts_lines_skip_blanks_comments_and_markers() {
        assert_eq!(parse_known_hosts_line(""), None);
        assert_eq!(parse_known_hosts_line("# comment"), None);
        assert_eq!(parse_known_hosts_line("@revoked * ssh-ed25519 AAAA"), None);
        assert_eq!(parse_known_hosts_line("host-only"), None);
        assert_eq!(
            parse_known_hosts_line("  [h]:2222 ssh-ed25519 AAAA trailing comment"),
            Some(KnownHostsEntry { pattern: "[h]:2222".into(), key_type: "ssh-ed25519".into(), key_blob: "AAAA".into() })
        );
    }

    #[test]
    fn a_scan_reads_back_the_one_key_ssh_recorded() {
        let one = scanned_key_from_known_hosts(&format!("[10.1.2.3]:2200 ssh-ed25519 {NEW_BLOB}\n")).unwrap();
        assert_eq!(one.fingerprint, NEW_FP);
        assert_eq!(one.key_type, "ED25519");
        assert_eq!(one.patterns, vec!["[10.1.2.3]:2200".to_string()]);
        assert_eq!(one.lines, vec![format!("[10.1.2.3]:2200 ssh-ed25519 {NEW_BLOB}")]);

        // The same key under two names (and a comma list) is still one key.
        let two = scanned_key_from_known_hosts(&format!(
            "host.example,10.1.2.3 ssh-ed25519 {NEW_BLOB}\nalias ssh-ed25519 {NEW_BLOB}\n"
        ))
        .unwrap();
        assert_eq!(two.patterns, vec!["host.example".to_string(), "10.1.2.3".into(), "alias".into()]);
        assert_eq!(two.lines.len(), 2);

        // Two different keys from one scan are refused, never guessed between.
        assert!(scanned_key_from_known_hosts(&format!("a ssh-ed25519 {NEW_BLOB}\nb ssh-ed25519 {OLD_BLOB}\n")).is_err());
        assert!(scanned_key_from_known_hosts("").is_err());
        assert!(scanned_key_from_known_hosts("# nothing\n").is_err());
    }

    #[test]
    fn lookups_use_the_names_ssh_filed_the_key_under() {
        let s = scanned("[10.1.2.3]:2200", NEW_BLOB);
        assert_eq!(host_key_lookup_patterns(&s, "myalias", 2200), vec!["[10.1.2.3]:2200".to_string()]);
        // A hashed name (never written by the scan, which forces HashKnownHosts=no) is
        // unusable for a lookup: fall back to the typed host.
        let hashed = scanned("|1|abc=|def=", NEW_BLOB);
        assert_eq!(host_key_lookup_patterns(&hashed, "example.com", 22), vec!["example.com".to_string()]);
        assert_eq!(host_key_lookup_patterns(&hashed, "-oProxyCommand=x", 22), Vec::<String>::new());
    }

    #[test]
    fn classify_host_key_tells_first_contact_known_and_changed_apart() {
        let saved = |pairs: &[(&str, &str)]| pairs.iter().map(|(t, f)| (t.to_string(), f.to_string())).collect::<Vec<_>>();
        assert_eq!(classify_host_key("ED25519", NEW_FP, &[]), HostKeyTrust::New);
        assert_eq!(classify_host_key("ED25519", NEW_FP, &saved(&[("ED25519", NEW_FP)])), HostKeyTrust::Known);
        assert_eq!(classify_host_key("ED25519", NEW_FP, &saved(&[("ED25519", OLD_FP)])), HostKeyTrust::Changed);
        // Saved under another key type only: the strict connection checks THAT pin.
        assert_eq!(classify_host_key("ED25519", NEW_FP, &saved(&[("ECDSA", ECDSA_FP)])), HostKeyTrust::Known);
        // One of several saved keys matching is enough.
        assert_eq!(
            classify_host_key("ED25519", NEW_FP, &saved(&[("ED25519", OLD_FP), ("ED25519", NEW_FP)])),
            HostKeyTrust::Known
        );
    }

    /// M12: no password ever goes to a first-contact key the user has not confirmed,
    /// nor to a changed one, nor to a key other than the exact one they confirmed.
    #[test]
    fn the_host_key_gate_only_lets_a_password_through_to_a_saved_or_confirmed_key() {
        assert_eq!(host_key_gate(HostKeyTrust::Known, NEW_FP, None), HostKeyGate::Proceed);
        assert_eq!(host_key_gate(HostKeyTrust::Known, NEW_FP, Some(OLD_FP)), HostKeyGate::Proceed);
        assert_eq!(
            host_key_gate(HostKeyTrust::Changed, NEW_FP, Some(NEW_FP)),
            HostKeyGate::Refuse(BootstrapError::HostKeyMismatch),
            "a changed key is replaced only through the explicit I6 flow, never by a confirmation for a first contact"
        );
        assert_eq!(host_key_gate(HostKeyTrust::New, NEW_FP, Some(NEW_FP)), HostKeyGate::Pin);
        assert_eq!(
            host_key_gate(HostKeyTrust::New, NEW_FP, None),
            HostKeyGate::Refuse(BootstrapError::HostKeyUnconfirmed(NEW_FP.to_string()))
        );
        match host_key_gate(HostKeyTrust::New, NEW_FP, Some(OLD_FP)) {
            HostKeyGate::Refuse(BootstrapError::Other(m)) => {
                assert!(m.contains(NEW_FP) && m.contains(OLD_FP) && m.contains("nothing was sent"), "{m}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// The scan offers no credential of any kind, records into the scratch file only,
    /// and cannot be short-circuited by a multiplexed master that skips the key exchange.
    #[test]
    fn the_host_key_scan_sends_no_secret_and_writes_only_its_scratch_file() {
        let cmd = host_key_scan_command(2200, "/tmp/scratch/known_hosts");
        let args: Vec<String> = cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        for expected in [
            "BatchMode=yes",
            "StrictHostKeyChecking=accept-new",
            "UserKnownHostsFile=/tmp/scratch/known_hosts",
            "GlobalKnownHostsFile=/dev/null",
            "HashKnownHosts=no",
            "ControlPath=none",
            "PubkeyAuthentication=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "GSSAPIAuthentication=no",
            "HostbasedAuthentication=no",
            "IdentityAgent=none",
        ] {
            assert!(args.iter().any(|a| a == expected), "missing {expected}: {args:?}");
        }
        assert!(!args.iter().any(|a| a == "-i"), "no identity file is ever offered: {args:?}");
        assert_eq!(&args[..3], ["-T", "-p", "2200"]);
    }

    #[tokio::test]
    async fn a_scan_of_a_closed_port_is_unreachable_not_a_key() {
        let target = BootstrapTarget { host: "127.0.0.1".into(), port: 1, user: "nobody".into() };
        assert_eq!(scan_host_key(&target).await, Err(BootstrapError::HostUnreachable));
        let evil = BootstrapTarget { host: "-oProxyCommand=x".into(), port: 22, user: "nobody".into() };
        assert!(matches!(scan_host_key(&evil).await, Err(BootstrapError::Other(_))), "validated before ssh");
    }

    #[test]
    fn a_failed_scan_says_why() {
        assert_eq!(
            scan_failure("ssh: connect to host 10.0.0.1 port 22: Connection refused\n"),
            BootstrapError::HostUnreachable
        );
        assert_eq!(
            scan_failure("kex_exchange_identification: Connection closed by remote host\n"),
            BootstrapError::Other(
                "could not read this server's host key: kex_exchange_identification: Connection closed by remote host"
                    .into()
            )
        );
    }

    #[tokio::test]
    async fn saved_host_keys_reads_every_key_under_the_names_given() {
        let kh = ScratchKnownHostsFile::with(&["[10.1.2.3]:2200", "other.example"]);
        let saved = saved_host_keys(kh.path(), &["[10.1.2.3]:2200".to_string()]).await.unwrap();
        assert_eq!(saved, vec![("ED25519".to_string(), OLD_FP.to_string())]);
        assert!(saved_host_keys(kh.path(), &["nowhere.example".to_string()]).await.unwrap().is_empty());
        let missing = std::env::temp_dir().join(format!("fd-kh-missing-{}", uuid::Uuid::new_v4()));
        assert!(saved_host_keys(missing.to_str().unwrap(), &["x".to_string()]).await.unwrap().is_empty());
    }

    #[test]
    fn pinning_appends_on_a_line_of_its_own_and_creates_a_private_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new().unwrap();
        let path = dir.0.join("known_hosts");
        append_known_hosts_lines(&path, &["a ssh-ed25519 AAAA".to_string()]).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::write(&path, "x ssh-ed25519 BBBB").unwrap(); // no trailing newline
        append_known_hosts_lines(&path, &["a ssh-ed25519 AAAA".to_string(), "b ssh-ed25519 AAAA".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x ssh-ed25519 BBBB\na ssh-ed25519 AAAA\nb ssh-ed25519 AAAA\n");
    }

    /// I6: the confirmed key replaces the old one under the name an `~/.ssh/config`
    /// alias resolves to, in one step — nothing else in the file is touched, and the
    /// old key is gone rather than kept alongside (which would let it still pass).
    #[tokio::test]
    async fn replacing_swaps_the_old_key_for_the_confirmed_one_under_the_resolved_name() {
        let kh = ScratchKnownHostsFile::with(&["[10.1.2.3]:2200", "other.example"]);
        let resolved = ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: None };
        let patterns = host_key_forget_patterns("myalias", 2200, &resolved);
        replace_pinned_key(kh.path(), &patterns, &scanned("[10.1.2.3]:2200", NEW_BLOB)).await.unwrap();
        let saved = saved_host_keys(kh.path(), &["[10.1.2.3]:2200".to_string()]).await.unwrap();
        assert_eq!(saved, vec![("ED25519".to_string(), NEW_FP.to_string())]);
        assert!(kh.contents().contains("other.example"), "only this server's key changes: {}", kh.contents());
    }

    #[tokio::test]
    async fn replacing_removes_a_bare_host_key_alias_entry_and_tolerates_a_missing_file() {
        let kh = ScratchKnownHostsFile::with(&["pinned"]);
        let resolved = ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: Some("pinned".into()) };
        let patterns = host_key_forget_patterns("myalias", 2200, &resolved);
        replace_pinned_key(kh.path(), &patterns, &scanned("pinned", NEW_BLOB)).await.unwrap();
        assert_eq!(
            saved_host_keys(kh.path(), &["pinned".to_string()]).await.unwrap(),
            vec![("ED25519".to_string(), NEW_FP.to_string())]
        );

        let dir = ScratchDir::new().unwrap();
        let missing = dir.0.join("known_hosts");
        replace_pinned_key(missing.to_str().unwrap(), &["example.com".to_string()], &scanned("example.com", NEW_BLOB))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&missing).unwrap(), format!("example.com ssh-ed25519 {NEW_BLOB}\n"));
    }

    /// End to end against THIS Mac's own sshd (Remote Login on, port 22) — no secret is
    /// sent anywhere: a first contact reads `New`, a confirmed pin turns it `Known`, a
    /// different key saved under the same name reads `Changed`, and the confirmed
    /// replacement turns it `Known` again. `#[ignore]`d: needs a local sshd.
    #[tokio::test]
    #[ignore = "needs a local sshd on 127.0.0.1:22 (macOS Remote Login)"]
    async fn live_local_sshd_first_contact_confirm_then_change_then_replace() {
        let target = BootstrapTarget { host: "127.0.0.1".into(), port: 22, user: "nobody".into() };
        let dir = ScratchDir::new().unwrap();
        let kh = dir.0.join("known_hosts");
        let kh = kh.to_str().unwrap();

        let (first, _) = check_host_key(&target, kh).await.expect("the local sshd presents a key");
        assert_eq!(first.trust, HostKeyTrust::New);
        assert!(first.fingerprint.starts_with("SHA256:"));
        assert!(!Path::new(kh).exists(), "checking writes nothing to the dedicated file");

        assert_eq!(
            ensure_confirmed_host_key(&target, kh, None).await,
            Err(BootstrapError::HostKeyUnconfirmed(first.fingerprint.clone()))
        );
        let confirmed = ensure_confirmed_host_key(&target, kh, Some(&first.fingerprint)).await.unwrap();
        assert!(!confirmed.known_before);
        assert_eq!(check_host_key(&target, kh).await.unwrap().0.trust, HostKeyTrust::Known);

        // Some other key saved under the same name: the server's real key is "changed".
        std::fs::write(kh, format!("127.0.0.1 ssh-ed25519 {OLD_BLOB}\n")).unwrap();
        let (changed, _) = check_host_key(&target, kh).await.unwrap();
        assert_eq!(changed.trust, HostKeyTrust::Changed);
        assert_eq!(changed.saved_fingerprints, vec![OLD_FP.to_string()]);
        assert_eq!(
            ensure_confirmed_host_key(&target, kh, Some(&changed.fingerprint)).await,
            Err(BootstrapError::HostKeyMismatch)
        );
        assert!(replace_host_key(&target, kh, OLD_FP).await.is_err(), "only the presented key can be confirmed");
        replace_host_key(&target, kh, &changed.fingerprint).await.unwrap();
        let after = check_host_key(&target, kh).await.unwrap().0;
        assert_eq!(after.trust, HostKeyTrust::Known);
        assert_eq!(after.saved_fingerprints, vec![changed.fingerprint]);
    }

    /// The real `ssh -G` against a scratch config (`-F`): an alias resolves to its
    /// HostName and HostKeyAlias. (The command line's `-p` wins over the config's
    /// `Port` — why `ResolvedSshHost` carries no port.)
    #[tokio::test]
    async fn resolve_ssh_host_reads_an_alias_through_ssh_g() {
        let config = std::env::temp_dir().join(format!("fd-ssh-config-{}", uuid::Uuid::new_v4()));
        std::fs::write(&config, "Host myalias\n  HostName 10.1.2.3\n  Port 2200\n  HostKeyAlias pinned-name\n").unwrap();
        let resolved = resolve_ssh_host("myalias", 2222, Some(&config)).await;
        let _ = std::fs::remove_file(&config);
        assert_eq!(
            resolved.expect("ssh -G resolves locally"),
            ResolvedSshHost { hostname: Some("10.1.2.3".into()), host_key_alias: Some("pinned-name".into()) }
        );
        assert!(resolve_ssh_host("-oProxyCommand=x", 22, None).await.is_err(), "validated before ssh");
    }

    // ========================================================================
    // Live fixture tests (B7) — need Docker (colima start) + the
    // `flightdeckd/live/bootstrap-fixtures` fixtures in this same repo.
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

        /// Locates the `flightdeckd` crate as an ancestor descendant of this crate's
        /// own checkout — mirrors `server_setup.rs`'s own helper of the same name
        /// (duplicated rather than shared: neither module has a place to put shared
        /// test-only infra today). `flightdeckd` moved into this repo (imported from
        /// `flightdeck-server`, see `flightdeckd/docs/MONOREPO-MOVE.md`); this walks
        /// up from `CARGO_MANIFEST_DIR` (rather than a fixed relative path) so it
        /// resolves correctly both from the main checkout and from a feature worktree
        /// nested deeper. `FLIGHTDECKD_CRATE_DIR` overrides the search entirely.
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

        /// Brings a fixture up FRESH (`fixture.sh up` always `docker rm -f`s then
        /// `docker run`s — never a state-preserving no-op reuse, verified against the
        /// script's own source). Panics with the script's own output on failure.
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
        #[ignore = "needs Docker (colima start)"]
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
            // The password path checks the host key strictly (M12): an unpinned host is
            // refused before any password prompt — pin it the way a confirmed first
            // contact does.
            assert_eq!(
                install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path()).await,
                Err(BootstrapError::HostKeyMismatch),
                "an unpinned host must be refused, never TOFU-pinned by the password connection"
            );
            assert!(!host_key_pinned(kh.path(), &target.host, target.port).await, "nothing pinned by the refusal");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

            // --- (1) symlink refusal, on the PRISTINE (no ~/.ssh yet) node ---
            let poison = "rm -rf ~/.ssh /tmp/b7-evil-ssh-dir; mkdir -p /tmp/b7-evil-ssh-dir; ln -s /tmp/b7-evil-ssh-dir ~/.ssh";
            let poison_cmd = askpass::bootstrap_ssh_command(
                &target.user,
                &target.host,
                target.port,
                None,
                Some(kh.path()),
                poison,
            )
            .expect("a fixed literal test user/host must always validate");
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
                &target.user,
                &target.host,
                target.port,
                None,
                Some(kh.path()),
                "rm -rf ~/.ssh /tmp/b7-evil-ssh-dir",
            )
            .expect("a fixed literal test user/host must always validate");
            let out = askpass::run_with_password(cleanup, FIXTURE_A_PASSWORD, None, Duration::from_secs(15))
                .await
                .expect("cleaning up the poison must succeed");
            assert!(out.status.success());

            // --- (2) wrong password ---
            let wrong = install_key(&target, "definitely-wrong-password", key.path(), &key.public, kh.path()).await;
            assert_eq!(wrong, Err(BootstrapError::WrongPassword));

            // --- (3) the real idempotent install, twice, against the pinned key ---
            let first = install_key(&target, FIXTURE_A_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("the first install, with the correct password, must succeed");
            assert_eq!(first, KeyInstallOutcome::Installed);

            let fingerprint_after_first = read_pinned_fingerprint(kh.path(), &target.host, target.port).await;
            assert!(
                fingerprint_after_first.is_some(),
                "the confirmed pin must still be there after the password-step connection"
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
            verify.arg("-T");
            crate::ipc::commands::push_ssh_destination(&mut verify, &target.user, &target.host)
                .expect("a fixed literal test user/host must always validate");
            verify.arg("echo REMOTE_OK");
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
        #[ignore = "needs Docker (colima start)"]
        async fn live_fixture_a_tolerates_a_within_home_ssh_symlink_with_existing_authorized_keys() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_A_PORT, user: FIXTURE_A_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-a-dotfiles-ssh");
            let kh = ScratchKnownHosts::new("fixture-a-dotfiles-ssh");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

            // A dotfiles-managed ~/.ssh: a within-$HOME symlink pointing at a real
            // directory that ALREADY has an authorized_keys file behind it (non-empty,
            // like a real one would be) — every path here resolves under $HOME, so
            // none of it should be refused.
            let setup = "rm -rf ~/.ssh ~/dotfiles; mkdir -p ~/dotfiles/ssh; \
                          printf '# pre-existing\\n' > ~/dotfiles/ssh/authorized_keys; \
                          ln -s ~/dotfiles/ssh ~/.ssh";
            let setup_cmd = askpass::bootstrap_ssh_command(&target.user, &target.host, target.port, None, Some(kh.path()), setup)
                .expect("a fixed literal test user/host must always validate");
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
            verify.arg("-T");
            crate::ipc::commands::push_ssh_destination(&mut verify, &target.user, &target.host)
                .expect("a fixed literal test user/host must always validate");
            verify.arg("echo REMOTE_OK");
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
        #[ignore = "needs Docker (colima start)"]
        async fn live_fixture_a_verify_failure_surfaces_as_key_installed_but_not_accepted() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("a");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_A_PORT, user: FIXTURE_A_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-a-verify-fail");
            let kh = ScratchKnownHosts::new("fixture-a-verify-fail");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

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
        #[ignore = "needs Docker (colima start)"]
        async fn live_fixture_b_root_install_key_and_probe_work() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("b");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_B_PORT, user: FIXTURE_B_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-b");
            let kh = ScratchKnownHosts::new("fixture-b");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

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
        #[ignore = "needs Docker (colima start)"]
        async fn live_fixture_c_probe_reports_the_system_unit_conflict() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("c");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_C_PORT, user: FIXTURE_C_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-c");
            let kh = ScratchKnownHosts::new("fixture-c");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

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
        #[ignore = "needs Docker (colima start)"]
        async fn live_fixture_d_probe_reports_no_passwordless_sudo_and_no_linger() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("d");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_D_PORT, user: FIXTURE_D_USER.to_string() };
            let key = ThrowawayKey::generate("fixture-d");
            let kh = ScratchKnownHosts::new("fixture-d");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

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
        /// [`replace_host_key`] — with the newly presented fingerprint the user would
        /// have confirmed — recovers it.
        #[tokio::test]
        #[ignore = "needs Docker (colima start)"]
        async fn live_host_key_change_is_detected_then_recoverable_via_replace_host_key() {
            let _guard = LIVE_FIXTURE_LOCK.lock().await;
            fixture_up("b");
            let target =
                BootstrapTarget { host: "127.0.0.1".to_string(), port: FIXTURE_B_PORT, user: FIXTURE_B_USER.to_string() };
            let key = ThrowawayKey::generate("host-key-change");
            let kh = ScratchKnownHosts::new("host-key-change");
            scan_and_pin_for_test(kh.path(), &target).await.expect("pin the fixture's host key");

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

            let (check, _) = check_host_key(&target, kh.path()).await.expect("the new key is readable");
            assert_eq!(check.trust, HostKeyTrust::Changed);
            assert_eq!(check.saved_fingerprints, vec![fingerprint_before.clone()]);
            replace_host_key(&target, kh.path(), &check.fingerprint)
                .await
                .expect("replacing the stale host key with the confirmed new one must succeed");

            // Reconnecting now succeeds against the NEW (different) fingerprint.
            let recovered = install_key(&target, FIXTURE_B_PASSWORD, key.path(), &key.public, kh.path())
                .await
                .expect("reconnecting after replace_host_key must succeed against the new key");
            assert_eq!(recovered, KeyInstallOutcome::AlreadyPresent, "the key itself was never removed, only the host pin");
            let fingerprint_after = read_pinned_fingerprint(kh.path(), &target.host, target.port)
                .await
                .expect("a fingerprint must be pinned again after recovering");
            assert_ne!(fingerprint_after, fingerprint_before, "the newly pinned fingerprint must be the REGENERATED key");
        }
    }
}
