//! Local `SSH_ASKPASS` relay for the ONE interactive prompt the bootstrap flow needs:
//! the LOCAL `ssh` client's own login-password prompt, entered once in the Tauri GUI,
//! for a fresh server that has no key installed yet.
//!
//! Scope — read this before touching anything here: this module relays a password to
//! the local ssh CLIENT's own auth prompt. It does NOT relay a `sudo` password to the
//! remote host — `sudo` runs ON THE SERVER, over an already-open SSH session; a later
//! task pipes the captured password to `sudo -S` on that session's stdin instead. This
//! module never even imports the word.
//!
//! Every other `ssh` call in this codebase hardcodes `-o BatchMode=yes`, which
//! disables password prompts outright (see `ipc/commands.rs`, `supervisor/
//! transport.rs`) — correct there, because those calls run against a server that
//! already has our key. [`bootstrap_ssh_command`] is the one deliberate exception: the
//! bootstrap's FIRST connection needs the opposite, so it omits `BatchMode` and wires
//! up the relay below instead.
//!
//! ## The relay mechanism
//!
//! Per call: a private (0700) temp dir holding a FIFO (`pass.fifo`) and a tiny (0700)
//! helper script (`askpass.sh`) that just `cat`s the FIFO. `ssh` is told
//! `SSH_ASKPASS=<helper>` + `SSH_ASKPASS_REQUIRE=force` (a Tauri GUI process has no
//! `DISPLAY`; OpenSSH only invokes `SSH_ASKPASS` when `DISPLAY` is set unless this
//! override exists — the local client here is OpenSSH_10.3, which has had the
//! override since 8.4). `ssh` runs the helper, the helper opens the FIFO for reading
//! and blocks; this module opens it for writing and blocks too — a FIFO's
//! `open(O_WRONLY)` blocks until a reader arrives, which is exactly the rendezvous we
//! want, so the password is written the instant, and only the instant, `ssh` actually
//! asks for it. That open call is genuinely blocking, so it runs on a blocking thread,
//! bounded by a deadline. The password touches no argv, no disk, no regular file —
//! only pipe bytes.
//!
//! [`AskpassGuard`] is the RAII holder: the dir + FIFO are removed on every exit path
//! (success, error, timeout, an early `?` return) via `Drop`.

use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::ipc::commands::shq;

/// Everything that can go wrong running a bootstrap ssh command. Every variant's
/// [`Display`](std::fmt::Display) is worded from ssh's OWN exit status/stderr or a
/// plumbing failure message — never from the password. No code in this module ever
/// formats the password INTO a message; the one place that even sees it after
/// delivery (`classify_output`'s `Other` branch, which forwards a raw line of ssh's
/// own stderr) only uses it to SCRUB a literal occurrence back out, for the untrusted
/// first-contact host this bootstrap flow talks to — see that function's doc. See
/// `askpass_errors_never_contain_the_test_password` at the bottom of this file, which
/// mirrors the repo's `session_gone_errors_keep_the_wording_the_front_matches_on`
/// discipline (`tosse/mod.rs`) for this module.
#[derive(Debug, PartialEq, Eq)]
pub enum BootstrapError {
    /// ssh rejected the password (detected from its exit code + stderr wording).
    WrongPassword,
    /// The overall deadline elapsed — most often because the password was never
    /// consumed (the askpass prompt never opened, e.g. an unreachable host that never
    /// got far enough to ask), but also covers ssh hanging after a good password.
    Timeout,
    /// Could not establish the connection at all (DNS/refused/unreachable/timed out
    /// at the TCP level).
    HostUnreachable,
    /// The host key changed, or a brand-new host key was refused.
    HostKeyMismatch,
    /// (B7) `bootstrap::connect::install_key` appended the key to the server's
    /// `authorized_keys` (or found it already there), but a VERIFICATION reconnect
    /// using it over the normal keyed/`BatchMode` path then failed — the server
    /// accepted the PASSWORD but something about the key path specifically is broken
    /// (`PubkeyAuthentication no`, a non-default `AuthorizedKeysFile`, permissions
    /// sshd itself refuses). Carries a hint built from the verification failure, so
    /// this is never reported as a bare, unexplained "it didn't work".
    KeyInstalledButNotAccepted(String),
    /// (B8) [`crate::bootstrap::install::daemon_binary_path`] could not find a static
    /// musl binary for this arch — either the arch itself isn't one this app ships for
    /// (`x86_64`/`aarch64`), or it IS, but neither `$TOSSE_FLIGHTDECKD_BIN_DIR` (dev/
    /// tests) nor the app's bundled resource dir actually has the file. Carries the arch
    /// string so the message names what's missing rather than a generic IO error — the
    /// brief's own requirement.
    DaemonBinaryNotBundled(String),
    /// (B2/B3) [`crate::bootstrap::install::bundled_daemon_manifest`] found no
    /// `manifest.json` next to the bundled binaries (or couldn't parse it) — a fresh
    /// clone with no `pnpm daemon:build` ever run (Docker not available), or the
    /// bundled resource dir is otherwise incomplete. Distinct from
    /// [`Self::DaemonBinaryNotBundled`] (one specific binary file missing): this means
    /// "there is no way to VERIFY whichever binary IS there", which must block an
    /// upload exactly as hard — see [`crate::bootstrap::install::upload_daemon`].
    DaemonManifestMissing,
    /// (B2/B3) [`crate::bootstrap::install::upload_daemon`] hashed the bundled binary
    /// for `arch` and it does NOT match the sha256 its own
    /// [`crate::bootstrap::install::DaemonManifest`] records for that target — the
    /// resource on disk was corrupted, tampered with, or left over from a partial/stale
    /// build. Never uploaded; there is no fallback, only a fresh `pnpm daemon:build`.
    DaemonBinaryTampered { arch: String, expected: String, actual: String },
    /// (B8) [`crate::bootstrap::install::upload_daemon`]'s remote self-verification
    /// (size AND sha256 of the temp file, BEFORE it is ever promoted over the real
    /// target) found a mismatch, or the transfer never finished at all (the ssh
    /// connection died mid-stream). `got` is the byte count the remote side actually
    /// reports having received — `0` when nothing recognizable came back at all (a
    /// connection that died before the remote script could report anything). The temp
    /// file is always removed (best-effort) before this is returned — this is never a
    /// false success.
    UploadTruncated { expected: u64, got: u64 },
    /// (B9) [`crate::bootstrap::install::escalate_persistence`] found passwordless
    /// `sudo` unavailable (`sudo -n true` failed) and was given no
    /// [`crate::bootstrap::install::SecretString`] to fall back to piping — the caller
    /// (a wizard step) should prompt for the server's login password and retry with it.
    NeedsSudoPassword,
    /// (B9) [`crate::bootstrap::install::install_service`] ran out of automatable
    /// options (no systemd at all with `KillUserProcesses` unknown/`yes`, or linger
    /// refused with no `sudo` to escalate through) — carries a human explanation of
    /// what a real administrator on that box would need to do; never silently falls
    /// back to a fallback that might not actually survive.
    AdminRequired(String),
    /// (B11) [`crate::bootstrap::orchestrator::restart_daemon`] refused to restart
    /// `flightdeckd` because a fresh diagnosis could not confirm zero busy
    /// conversations — `Some(n)` for `n` confirmed-busy conversations, `None` when the
    /// count itself couldn't be confirmed (never treated as safe-to-restart either
    /// way). Never silently proceeding here is the whole point (B11 review finding):
    /// this is what stands between `repair(RestartDaemon)` — reachable directly from a
    /// future wizard UI — and killing a live Claude Code session on that server.
    DaemonBusy(Option<u32>),
    /// Anything else — the ssh/askpass plumbing itself failing, not the login
    /// outcome. Carries a short, already-scrubbed-of-secrets diagnostic.
    Other(String),
}

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPassword => write!(f, "wrong password"),
            Self::Timeout => write!(f, "timed out waiting for the server to respond"),
            Self::HostUnreachable => write!(f, "could not reach the server"),
            Self::HostKeyMismatch => {
                write!(f, "the server's host key does not match what was expected")
            }
            Self::KeyInstalledButNotAccepted(hint) => write!(f, "{hint}"),
            Self::DaemonBinaryNotBundled(arch) => {
                write!(f, "no bundled flightdeckd binary for arch \"{arch}\"")
            }
            Self::DaemonManifestMissing => write!(
                f,
                "no bundled flightdeckd manifest — run `pnpm daemon:build` (or set $TOSSE_FLIGHTDECKD_BIN_DIR) first"
            ),
            Self::DaemonBinaryTampered { arch, expected, actual } => write!(
                f,
                "the bundled flightdeckd binary for \"{arch}\" does not match its manifest (expected sha256 {expected}, got {actual}) — refusing to upload it"
            ),
            Self::UploadTruncated { expected, got } => write!(
                f,
                "the daemon upload was truncated: expected {expected} bytes, the server received {got}"
            ),
            Self::NeedsSudoPassword => {
                write!(f, "this server needs a sudo password to continue")
            }
            Self::AdminRequired(reason) => write!(f, "{reason}"),
            Self::DaemonBusy(Some(n)) => {
                write!(f, "won't restart flightdeckd while {n} conversation(s) are busy")
            }
            Self::DaemonBusy(None) => {
                write!(f, "won't restart flightdeckd — could not confirm no conversations are busy")
            }
            Self::Other(d) => write!(f, "{d}"),
        }
    }
}

impl std::error::Error for BootstrapError {}

/// A password held only long enough to pipe it to a remote `sudo -S`'s stdin (see
/// [`crate::bootstrap::install::escalate_persistence`]) — never argv, env, or disk. No
/// `secrecy` crate is in this tree (nothing else in the crate needed one yet); this is
/// a minimal stand-in with the ONE property that actually matters here: an accidental
/// `{:?}`/panic/log message never prints the password. [`Self::expose`] is the single,
/// deliberately-named escape hatch — every call site of it should be somewhere that
/// genuinely needs the plaintext (feeding a pipe), never a log line.
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// The plaintext password. Named loudly on purpose — `grep`-able, unlike a `Deref`
    /// or `AsRef` impl that would let it slip out through an ordinary-looking call.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

/// Builds the bootstrap-flow `ssh` invocation: the ONE call site in this codebase that
/// deliberately OMITS `BatchMode=yes` (see the module doc) so a password prompt is
/// even possible in the first place.
///
/// `identity_or_none`: `Some` when this connection already has a key to offer (a
/// later bootstrap step, once our key is installed) — that path leaves ssh's normal
/// auth negotiation alone. `None` is the FIRST-contact, password-only step: it tells
/// ssh not to try anything else and to ask exactly once
/// (`NumberOfPasswordPrompts=1`) — a wrong password should fail fast, not retry
/// itself into a lockout on the server.
///
/// `known_hosts`: `Some` pins `StrictHostKeyChecking=accept-new`'s TOFU pin into THAT
/// file (`-o UserKnownHostsFile=...`) instead of the developer's real
/// `~/.ssh/known_hosts` — `bootstrap::connect` (B7) always passes the app's own
/// dedicated `remote_known_hosts` here, exactly like [`crate::ipc::commands::
/// keyed_ssh_options`] does for the already-paired path. `None` (this module's own
/// unit tests, which never actually complete a handshake) leaves ssh's default alone.
///
/// Does NOT itself set `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`: this builds the ssh
/// invocation's argv/options, which are the same regardless of which relay ends up
/// answering the prompt; [`run_with_password`] is what owns an [`AskpassGuard`] and
/// wires those two env vars to ITS helper right before spawning. A caller that never
/// goes through `run_with_password` (there is none in this crate yet) would need to
/// set them itself.
pub fn bootstrap_ssh_command(
    target: &str,
    identity_or_none: Option<&str>,
    known_hosts: Option<&str>,
    remote_cmd: &str,
) -> Command {
    let mut cmd = bootstrap_ssh_options(identity_or_none, known_hosts);
    // MUST be the last two args appended: ssh's own argv grammar is
    // `ssh [options] destination [command]` — anything appended after the
    // destination is part of the REMOTE command line, not parsed as an ssh option
    // any more.
    cmd.arg(target).arg(remote_cmd);
    cmd
}

/// The option half of [`bootstrap_ssh_command`], without the destination/remote
/// command it appends last (see that function's doc for why the order matters).
fn bootstrap_ssh_options(identity_or_none: Option<&str>, known_hosts: Option<&str>) -> Command {
    let mut cmd = Command::new("ssh");
    cmd
        // No controlling terminal for ssh to fall back to prompting on either — a
        // Tauri GUI process has none of its own, and leaving stdin inherited could
        // let ssh read a stray byte from wherever ours happens to be wired up.
        .stdin(Stdio::null())
        .arg("-T") // no PTY: we want plain output, not a terminal session
        .arg("-o")
        .arg("NumberOfPasswordPrompts=1")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new"); // TOFU: pin on first sight
    if let Some(kh) = known_hosts {
        cmd.arg("-o").arg(format!("UserKnownHostsFile={kh}"));
    }
    if let Some(identity) = identity_or_none {
        cmd.arg("-i").arg(identity).arg("-o").arg("IdentitiesOnly=yes");
    } else {
        cmd.arg("-o")
            .arg("PreferredAuthentications=password,keyboard-interactive");
    }
    cmd
}

/// RAII holder for the per-call askpass relay: a private temp dir containing a FIFO
/// (`pass.fifo`) and a tiny helper script (`askpass.sh`) that just `cat`s it. Nothing
/// here is meant to outlive one [`run_with_password`] call — [`Drop`] removes the dir
/// (and the FIFO with it) on every exit path, success, error, timeout, or an early
/// `?` return out of the caller.
struct AskpassGuard {
    dir: PathBuf,
    fifo: PathBuf,
    /// Absolute path to the helper script, handed to callers as `SSH_ASKPASS`.
    helper: PathBuf,
}

impl AskpassGuard {
    /// Creates the private dir + FIFO + helper script. Fails closed: if any step
    /// fails, whatever was already created this call is removed before returning —
    /// construction either fully succeeds or leaves nothing behind (this is the ONE
    /// path where cleanup can't be `Drop`'s job, since `Self` does not exist yet).
    fn new() -> Result<Self, BootstrapError> {
        let dir = std::env::temp_dir().join(format!("flightdeck-askpass-{}", uuid::Uuid::new_v4()));
        // Created ALREADY-restricted (mode passed to the syscall itself), not
        // created-then-chmod'd: the latter would leave a brief window where the dir
        // exists at the process's default (umask-derived) mode before being narrowed,
        // a create-then-restrict TOCTOU this relay's own safety bar rules out.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| BootstrapError::Other(format!("askpass: could not create temp dir: {e}")))?;

        let fifo = dir.join("pass.fifo");
        if let Err(e) = make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }

        let helper = dir.join("askpass.sh");
        // `exec /bin/cat` the fifo once — `exec` replaces the shell so no extra
        // process lingers between ssh and the fifo read. An ABSOLUTE path, not a
        // bare `cat` resolved via the ambient `PATH`: this is the one process in the
        // whole relay whose job is to read the secret in cleartext, so it should not
        // trust whatever `PATH` this process (and its ssh/sh children) happen to
        // inherit.
        let script = format!("#!/bin/sh\nexec /bin/cat {}\n", shq(&fifo.to_string_lossy()));
        if let Err(e) = std::fs::write(&helper, script)
            .map_err(|e| format!("could not write the helper script: {e}"))
            .and_then(|()| {
                std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("could not make the helper script executable: {e}"))
            })
        {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(BootstrapError::Other(format!("askpass: {e}")));
        }

        Ok(Self { dir, fifo, helper })
    }

    /// Writes `password` into the FIFO, BLOCKING until ssh's askpass helper opens the
    /// read end — a FIFO's `open(O_WRONLY)` blocks until a reader arrives, which is
    /// exactly the rendezvous this relay wants, so this runs on a blocking thread,
    /// bounded by `deadline`. Delivered exactly once: nothing re-opens the fifo for a
    /// second write, and the whole dir (fifo included) is gone by the time any retry
    /// could even find it, via [`Drop`].
    async fn deliver(&self, password: &str, deadline: Duration) -> Result<(), BootstrapError> {
        let fifo = self.fifo.clone();
        let password = password.to_owned();
        let write = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).open(&fifo)?;
            // No trailing newline: ssh's askpass protocol reads the helper's ENTIRE
            // stdout as the secret and trims it itself.
            f.write_all(password.as_bytes())?;
            Ok(())
        });
        match timeout(deadline, write).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(e))) => Err(BootstrapError::Other(format!(
                "askpass: could not write the password to the relay: {e}"
            ))),
            Ok(Err(_join_err)) => Err(BootstrapError::Other(
                "askpass: internal error delivering the password".to_string(),
            )),
            Err(_elapsed) => Err(BootstrapError::Timeout),
        }
    }

    /// Best-effort release of a writer thread possibly still parked in a blocking
    /// `open(O_WRONLY)` on the fifo — ssh exiting without ever invoking the askpass
    /// helper (host unreachable, or a key already worked) leaves that thread with
    /// nothing to unblock it otherwise: dropping the `deliver()` future only detaches
    /// the underlying `spawn_blocking` OS thread, it does not stop it. Per POSIX,
    /// opening a FIFO's read end — even just to close it again immediately — is what
    /// releases a pending write-only opener; this uses `O_NONBLOCK` so the poke itself
    /// can never block. Not doing this would leak one blocking-pool OS thread, parked
    /// forever, per call whose ssh process exits before ever asking for a password.
    fn poke_writer(&self) {
        let _ = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&self.fifo);
    }
}

impl Drop for AskpassGuard {
    /// The one guarantee that survives every exit path, including an early `?`
    /// return from [`run_with_password`]: the manual cleanup in [`AskpassGuard::new`]
    /// only covers ITS OWN construction failures (before `Self` exists to be
    /// dropped); everything after that goes through here.
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `mkfifo(2)` at `path`, mode 0600 (only this user can read/write it).
fn make_fifo(path: &std::path::Path) -> Result<(), BootstrapError> {
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| BootstrapError::Other("askpass: temp path had an embedded NUL".to_string()))?;
    // SAFETY: `c_path` is a valid NUL-terminated C string for the duration of this
    // call; `mkfifo` takes no ownership of it and we don't retain the pointer.
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return Err(BootstrapError::Other(format!("askpass: mkfifo failed: {err}")));
    }
    Ok(())
}

/// Runs `cmd` (built by [`bootstrap_ssh_command`]) delivering `password` the moment
/// ssh's askpass helper opens the relay, and returns its output.
///
/// The password never touches argv (ssh reads it from the askpass helper's stdout,
/// which reads it from the FIFO), never touches disk, never touches a regular file —
/// only pipe bytes inside a 0700 temp dir that is gone before this function returns.
/// This is a SEPARATE channel from `stdin_payload` below: the askpass relay answers
/// ssh's OWN login prompt (via `SSH_ASKPASS`, never the process's real stdin); the
/// remote command's stdin is the process's ordinary stdin pipe, untouched by any of
/// that.
///
/// `stdin_payload`, when `Some`, is written to the spawned ssh process's stdin and
/// the pipe is then closed (EOF) — for a remote command that reads its own input from
/// stdin (`bootstrap::connect::install_key`'s key-append script, notably: the public
/// key line is piped in rather than interpolated into the command string). Written
/// eagerly, right after spawn, before the password-delivery race below: ssh buffers
/// stdin in the pipe regardless of whether the remote command has even started
/// reading yet (no reader needs to be attached for a `write` to a pipe to complete),
/// so this never blocks on the remote side being ready — as long as the payload
/// stays comfortably under a pipe's OS buffer size, true for every payload this crate
/// actually sends here (a public key line, at most a few hundred bytes). `None`
/// (every OTHER call site) sets `Stdio::null()` exactly as before this parameter
/// existed.
///
/// Sets `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE` on `cmd` itself, pointed at its OWN
/// [`AskpassGuard`] — `cmd` (typically built by [`bootstrap_ssh_command`]) does not
/// need to carry them already.
pub async fn run_with_password(
    mut cmd: Command,
    password: &str,
    stdin_payload: Option<&[u8]>,
    deadline: Duration,
) -> Result<std::process::Output, BootstrapError> {
    let guard = AskpassGuard::new()?;
    cmd.env("SSH_ASKPASS", &guard.helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .stdin(if stdin_payload.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| BootstrapError::Other(format!("could not start ssh: {e}")))?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt as _;
            if let Err(e) = stdin.write_all(payload).await {
                return Err(BootstrapError::Other(format!(
                    "could not write to ssh's stdin: {e}"
                )));
            }
            // Drop to close (EOF) — the remote command's own `cat`/`read` is waiting
            // on exactly this to know the payload is complete.
            drop(stdin);
        }
    }
    let pid = child.id();
    // A future that reads stdout+stderr to completion (avoiding a pipe-buffer
    // deadlock) AND waits for exit, spawned as its own task so it can be raced
    // against delivery below without losing the ability to kill-by-pid afterward.
    let mut wait_task = tokio::spawn(async move { child.wait_with_output().await });

    // A single overall deadline instant, used for BOTH waits below (delivery, then
    // ssh's own exit) — not `deadline` applied twice in sequence. Applying it twice
    // would let a caller wait up to `2 * deadline` in exactly the case this relay
    // exists for: a fifo that's never opened (e.g. a host slow enough that neither
    // ssh's own `ConnectTimeout` nor the askpass prompt fires within `deadline`, but
    // ssh eventually gives up on its own a bit later).
    let started = std::time::Instant::now();

    // Race delivery against ssh exiting on its own: ssh may fail (or, with a key,
    // succeed) before it EVER opens the askpass prompt — e.g. an unreachable host, or
    // a host-key mismatch — and that must not make this call sit out the whole
    // `deadline` waiting on a fifo nobody will ever open.
    let exited_first = tokio::select! {
        biased;
        joined = &mut wait_task => Some(joined),
        _delivered = guard.deliver(password, deadline) => None,
    };

    let joined = match exited_first {
        Some(joined) => {
            // ssh exited before (or right as) delivery settled — release any writer
            // thread still parked waiting for a reader that will now never come.
            guard.poke_writer();
            joined
        }
        None => {
            // Delivery settled first — delivered, OR timed out on its own without
            // ever being opened (in which case the writer thread from `deliver()` is
            // still parked in a blocking `open()`, per its own doc). Poke
            // UNCONDITIONALLY here, before waiting on ssh's own exit below: this is
            // the only place that can release that thread if ssh goes on to exit
            // gracefully (not via our own SIGKILL path further down) without ever
            // invoking the askpass helper — the one interleaving none of the other
            // exit paths in this function cover. Cheap and idempotent (a nonblocking
            // open+close) when a reader already arrived.
            guard.poke_writer();

            // Either way ssh is still the one running; give it the REST of the
            // overall deadline to actually exit and produce output (not a fresh
            // `deadline`), so the total wall-clock bound on this whole call stays
            // `deadline`, not `2 * deadline`.
            let remaining = deadline.saturating_sub(started.elapsed());
            match timeout(remaining, &mut wait_task).await {
                Ok(joined) => joined,
                Err(_elapsed) => {
                    if let Some(pid) = pid {
                        // SAFETY: plain signal-by-pid, mirrored from `terminal/mod.rs`
                        // and `power/mod.rs` elsewhere in this crate.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                    guard.poke_writer();
                    return Err(BootstrapError::Timeout);
                }
            }
        }
    };

    let output = joined
        .map_err(|e| BootstrapError::Other(format!("internal error running ssh: {e}")))?
        .map_err(|e| BootstrapError::Other(format!("could not read ssh's output: {e}")))?;
    classify_output(output, password)
}

/// Whether `stderr` from a FAILED ssh invocation carries one of OpenSSH's two host-key
/// wordings for a genuine mismatch (an already-pinned key that changed, or — under
/// `StrictHostKeyChecking=yes`, not used by this crate's TOFU paths, but tolerated here
/// too — a new key refused outright). Pulled out of [`classify_output`] so
/// `bootstrap::connect`'s two KEYED call sites (`verify_key_accepted`, `probe`) can
/// classify the SAME wording without routing through `classify_output` itself: its
/// `permission denied` branch would misclassify a rejected KEY — neither of those two
/// calls ever involves a password at all — as [`BootstrapError::WrongPassword`].
pub(crate) fn is_host_key_mismatch(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("host key verification failed") || lower.contains("remote host identification has changed")
}

/// Turns ssh's raw exit status/stderr into the typed outcome callers actually want.
/// ssh's own convention: exit code 255 means SSH ITSELF failed (auth/connect/host-key)
/// — any other code is the REMOTE COMMAND's own exit code carried through verbatim,
/// meaning the connection and auth succeeded, so that case is always `Ok`.
///
/// That convention only applies to a process that actually exited normally.
/// `ExitStatus::code()` returns `None` when ssh was instead terminated BY A SIGNAL
/// (e.g. it crashed, or something other than this module's own SIGKILL timeout path —
/// which returns `Timeout` directly and never reaches this function — killed it); such
/// a status is neither a real "255" nor a real "auth succeeded" exit code, so it is
/// classified as its own `Other` outcome rather than folded into the success branch
/// below (`out.status.success()` would already read `false` there, but the `Output`
/// itself would misleadingly flow back to the caller as `Ok`).
///
/// `password` is taken here ONLY to scrub it out of the one branch (`Other`, below)
/// that forwards a raw line of ssh's own stderr verbatim — never to format it INTO a
/// message. This matters specifically because [`bootstrap_ssh_command`] connects with
/// `StrictHostKeyChecking=accept-new` (TOFU): on that first, not-yet-verified
/// connection, the remote sshd receives our real password over the wire to check it,
/// and — being unverified — could be malicious or a MITM; such a host can craft its
/// own banner/diagnostic text (which ssh prints to stderr and this branch would
/// otherwise forward untouched) to include whatever it just read, including our
/// password reflected back. Redacting any literal occurrence of `password` here closes
/// that reflection path without weakening the diagnostic value of the rest of the line.
pub(crate) fn classify_output(
    out: std::process::Output,
    password: &str,
) -> Result<std::process::Output, BootstrapError> {
    if out.status.code().is_none() {
        return Err(BootstrapError::Other(format!(
            "ssh exited abnormally: {}",
            out.status
        )));
    }
    if out.status.code() != Some(255) {
        return Ok(out);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if stderr.contains("permission denied") {
        return Err(BootstrapError::WrongPassword);
    }
    if is_host_key_mismatch(&stderr) {
        return Err(BootstrapError::HostKeyMismatch);
    }
    if stderr.contains("could not resolve hostname")
        || stderr.contains("connection refused")
        || stderr.contains("no route to host")
        || stderr.contains("connection timed out")
        || stderr.contains("network is unreachable")
    {
        return Err(BootstrapError::HostUnreachable);
    }
    let last_line = String::from_utf8_lossy(&out.stderr)
        .trim()
        .lines()
        .last()
        .unwrap_or("ssh failed")
        .to_string();
    // Scrub any literal occurrence of the password before it becomes a
    // `BootstrapError` (see this function's doc) — guarded on non-empty so an empty
    // `password` (never a real login password, but worth being defensive about)
    // can't turn this into a no-op replace-everything-with-redacted mess.
    let last_line = if password.is_empty() {
        last_line
    } else {
        last_line.replace(password, "[redacted]")
    };
    Err(BootstrapError::Other(last_line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::FileTypeExt;

    fn make_guard() -> AskpassGuard {
        AskpassGuard::new().expect("guard construction should succeed in a normal temp dir")
    }

    #[test]
    fn guard_creates_a_private_dir_fifo_and_executable_helper() {
        let g = make_guard();
        assert!(g.dir.is_dir());
        let dir_mode = std::fs::metadata(&g.dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "temp dir must be private to this user");

        let fifo_meta = std::fs::metadata(&g.fifo).unwrap();
        assert!(
            fifo_meta.file_type().is_fifo(),
            "pass.fifo must actually be a named pipe"
        );
        assert_eq!(fifo_meta.permissions().mode() & 0o777, 0o600);

        let helper_meta = std::fs::metadata(&g.helper).unwrap();
        assert_eq!(helper_meta.permissions().mode() & 0o777, 0o700);
        let script = std::fs::read_to_string(&g.helper).unwrap();
        assert!(script.contains("cat "), "helper must cat the fifo");
    }

    #[test]
    fn guard_removes_its_dir_and_fifo_on_drop_after_success() {
        let g = make_guard();
        let dir = g.dir.clone();
        assert!(dir.exists());
        drop(g);
        assert!(!dir.exists(), "dir (and the fifo inside it) must be gone after Drop");
    }

    /// Mirrors an early `?` return: a function that constructs a guard and bails out
    /// before doing anything else with it still must not leak the dir.
    ///
    /// The guard's own path is captured via a side channel rather than diffing a
    /// directory listing of `temp_dir()` before/after — tests run in parallel, and
    /// other tests' own live guards sharing that same system temp dir would make a
    /// listing-count comparison flaky.
    #[test]
    fn guard_removes_its_dir_on_an_early_question_mark_return() {
        fn early_return(seen_dir: &mut Option<PathBuf>) -> Result<(), BootstrapError> {
            let g = AskpassGuard::new()?;
            *seen_dir = Some(g.dir.clone());
            Err(BootstrapError::Other("pretend failure right after construction".into()))
        }
        let mut seen_dir = None;
        let result = early_return(&mut seen_dir);
        assert!(result.is_err());
        let dir = seen_dir.expect("early_return must have constructed a guard before bailing out");
        assert!(!dir.exists(), "dir must be gone after the early `?` return dropped the guard: {dir:?}");
    }

    #[tokio::test]
    async fn guard_delivers_the_password_to_a_concurrent_reader() {
        let g = make_guard();
        let fifo = g.fifo.clone();
        let reader = tokio::task::spawn_blocking(move || std::fs::read_to_string(&fifo));
        let delivered = g.deliver("hunter2", Duration::from_secs(5)).await;
        assert!(delivered.is_ok());
        let got = reader.await.unwrap().unwrap();
        assert_eq!(got, "hunter2");
        let dir = g.dir.clone();
        drop(g);
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn guard_delivery_times_out_when_nothing_ever_reads() {
        let g = make_guard();
        let result = g.deliver("never-read", Duration::from_millis(100)).await;
        assert_eq!(result, Err(BootstrapError::Timeout));
        // The writer thread spawned inside `deliver` is still blocked in `open()` —
        // nothing ever read the fifo, so `timeout()` gave up on it, not the OS thread
        // itself (dropping a `JoinHandle` only detaches it). `run_with_password`
        // always pokes after a timed-out delivery for exactly this reason (see its
        // doc); a unit test calling `deliver` directly must do the same, or the
        // `#[tokio::test]` runtime's teardown hangs forever waiting for that
        // permanently-blocked blocking-pool thread to finish.
        g.poke_writer();
        let dir = g.dir.clone();
        drop(g);
        assert!(!dir.exists(), "dir must still be removed after a timed-out delivery");
    }

    #[test]
    fn bootstrap_ssh_command_omits_batch_mode() {
        let cmd = bootstrap_ssh_command("tester@127.0.0.1", None, None, "true");
        let std_cmd = cmd.as_std();
        let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(
            !args.iter().any(|a| a == "BatchMode=yes"),
            "the bootstrap ssh command must NOT set BatchMode=yes: {args:?}"
        );
        assert!(args.iter().any(|a| a == "NumberOfPasswordPrompts=1"));
        assert!(args.iter().any(|a| a == "PreferredAuthentications=password,keyboard-interactive"));
    }

    #[test]
    fn bootstrap_ssh_command_with_identity_skips_password_only_restriction() {
        let cmd = bootstrap_ssh_command("tester@127.0.0.1", Some("/tmp/some_key"), None, "true");
        let std_cmd = cmd.as_std();
        let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"));
        assert!(
            !args.iter().any(|a| a == "PreferredAuthentications=password,keyboard-interactive"),
            "an identity was given, so this restriction must not be applied: {args:?}"
        );
    }

    /// (B7) `bootstrap::connect` always passes the app's dedicated `known_hosts` here
    /// so the first-contact TOFU pin never touches the developer's real
    /// `~/.ssh/known_hosts` — proves the option actually lands on the built command.
    #[test]
    fn bootstrap_ssh_command_with_known_hosts_sets_the_dedicated_file() {
        let cmd = bootstrap_ssh_command("tester@127.0.0.1", None, Some("/tmp/dedicated_known_hosts"), "true");
        let std_cmd = cmd.as_std();
        let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(
            args.iter().any(|a| a == "UserKnownHostsFile=/tmp/dedicated_known_hosts"),
            "expected the dedicated known_hosts override in {args:?}"
        );
    }

    // ---- is_host_key_mismatch (B7 — shared by classify_output AND
    // bootstrap::connect's two KEYED call sites, verify_key_accepted/probe) ----

    #[test]
    fn is_host_key_mismatch_recognizes_a_changed_key() {
        assert!(is_host_key_mismatch(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
             WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n\
             IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n"
        ));
    }

    #[test]
    fn is_host_key_mismatch_recognizes_a_refused_new_key() {
        assert!(is_host_key_mismatch("Host key verification failed.\n"));
    }

    #[test]
    fn is_host_key_mismatch_is_false_for_unrelated_failures() {
        assert!(!is_host_key_mismatch("Permission denied (publickey).\n"));
        assert!(!is_host_key_mismatch("ssh: connect to host example.com port 22: Connection refused\n"));
        assert!(!is_host_key_mismatch(""));
    }

    /// `classify_output` must still route through [`is_host_key_mismatch`] correctly
    /// after being refactored to call it — driven through a synthetic `Output` exactly
    /// like `askpass_errors_never_contain_the_test_password` does below, rather than a
    /// real ssh round-trip.
    #[test]
    fn classify_output_reports_host_key_mismatch_for_the_real_openssh_wording() {
        let out = std::process::Output {
            status: std::os::unix::process::ExitStatusExt::from_raw(255 << 8),
            stdout: Vec::new(),
            stderr: b"Host key verification failed.\n".to_vec(),
        };
        let err = classify_output(out, "").expect_err("must classify as an error, not success");
        assert_eq!(err, BootstrapError::HostKeyMismatch);
    }

    /// `run_with_password` is the one that owns `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`
    /// (see `bootstrap_ssh_command`'s doc) — this proves it, and exercises the REAL
    /// `ssh` binary end to end, WITHOUT Docker: connecting to a port nothing is
    /// listening on fails at the TCP level almost instantly ("Connection refused"),
    /// well before ssh would ever need the askpass relay, so this stays fast and
    /// deterministic enough to run by default (not `#[ignore]`d) while still proving
    /// `classify_output`'s `HostUnreachable` path against ssh's real exit
    /// code/wording, not a hand-built `Output`.
    #[tokio::test]
    async fn run_with_password_reports_host_unreachable_against_a_real_closed_port() {
        // Port 1 is reserved and never has anything listening on it locally. The
        // `ssh://` URI destination form is used (rather than `user@host`) because a
        // plain destination doesn't accept a trailing `:port` — OpenSSH's URI form
        // does (manually verified against the local OpenSSH_10.3 client).
        let cmd = bootstrap_ssh_command("ssh://nobody@127.0.0.1:1", None, None, "true");
        let result = run_with_password(cmd, "irrelevant", None, Duration::from_secs(10)).await;
        assert_eq!(result, Err(BootstrapError::HostUnreachable));
    }

    /// Live fixture: spins up a throwaway `sshd` (password auth,
    /// `linuxserver/openssh-server`) via Docker and proves `run_with_password`
    /// distinguishes a wrong password (`WrongPassword`) from a right one — which
    /// runs the remote command and returns ITS real output — end to end against a
    /// real `ssh` binary and a real `sshd`, no mocking anywhere. Needs Docker
    /// (`colima start` first if using colima, exactly as this repo's server-side
    /// live tests do — see the `flightdeck-server-test-box` memory). `#[ignore]`d
    /// like every other live-spawn test in this crate
    /// (`cargo test --lib -- --ignored --nocapture`); the container is torn down on
    /// every exit path, including a panicking assertion below, via `ContainerGuard`.
    ///
    /// ⚠️ Uses an ISOLATED `known_hosts` file, scoped to this one run, rather than
    /// the developer's real `~/.ssh/known_hosts` that `bootstrap_ssh_command`'s
    /// `StrictHostKeyChecking=accept-new` would otherwise pin into: the
    /// `linuxserver/openssh-server` image generates a FRESH host key on every
    /// `docker run`, so a second run on the same machine, on the same fixed
    /// `PORT`, would collide with the first run's key pinned into a shared file and
    /// fail with `HostKeyMismatch` instead of proving anything — reproduced while
    /// fixing this test. A scratch `known_hosts` (removed on every exit path via
    /// `KnownHostsGuard`) makes each run start from a clean slate.
    #[tokio::test]
    #[ignore]
    async fn run_with_password_distinguishes_wrong_from_right_over_a_live_sshd() {
        const CONTAINER: &str = "flightdeck-askpass-live-test";
        const PORT: u16 = 12245;
        const USER: &str = "tester";
        const PASSWORD: &str = "flightdeck-live-test-pw";

        struct ContainerGuard;
        impl Drop for ContainerGuard {
            fn drop(&mut self) {
                let _ = std::process::Command::new("docker").args(["rm", "-f", CONTAINER]).output();
            }
        }

        /// Scratch dir holding this run's own `known_hosts` file, removed on every
        /// exit path — never the developer's real `~/.ssh/known_hosts`.
        struct KnownHostsGuard(PathBuf);
        impl Drop for KnownHostsGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        // Best-effort teardown of a stale container from a previous aborted run,
        // THEN register the guard so THIS run's container is removed on every exit
        // path (including a panic from an assertion below).
        let _ = std::process::Command::new("docker").args(["rm", "-f", CONTAINER]).output();
        let _guard = ContainerGuard;

        let known_hosts_dir =
            std::env::temp_dir().join(format!("flightdeck-askpass-live-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&known_hosts_dir).expect("could not create a scratch dir for known_hosts");
        let _kh_guard = KnownHostsGuard(known_hosts_dir.clone());
        let known_hosts_file = known_hosts_dir.join("known_hosts");

        let run = std::process::Command::new("docker")
            .args([
                "run",
                "-d",
                "--name",
                CONTAINER,
                "-e",
                "PASSWORD_ACCESS=true",
                "-e",
                &format!("USER_NAME={USER}"),
                "-e",
                &format!("USER_PASSWORD={PASSWORD}"),
                "-p",
                &format!("127.0.0.1:{PORT}:2222"),
                "lscr.io/linuxserver/openssh-server:latest",
            ])
            .output()
            .expect("`docker` must be available (colima start) to run this live test");
        assert!(
            run.status.success(),
            "docker run failed: {}",
            String::from_utf8_lossy(&run.stderr)
        );

        let target = format!("ssh://{USER}@127.0.0.1:{PORT}");
        // Every ssh invocation in this test goes through this helper so all of them
        // — polling AND the final proof — share the same isolated `known_hosts`, via
        // `bootstrap_ssh_command`'s own `known_hosts` parameter (B7) rather than a
        // hand-appended `-o UserKnownHostsFile=...` (that used to be the only way
        // before this parameter existed — appending it AFTER `bootstrap_ssh_command`
        // built its own destination/remote-command pair was a no-op, since ssh treats
        // anything after those as part of the REMOTE command line, not its own
        // options; reproduced while first building this test).
        let known_hosts_str = known_hosts_file.to_str().expect("scratch known_hosts path must be UTF-8");
        let ssh_cmd = |remote_cmd: &str| bootstrap_ssh_command(&target, None, Some(known_hosts_str), remote_cmd);

        // Poll with the WRONG password until sshd actually accepts connections (a
        // freshly started container's sshd takes a moment to come up) — this
        // incidentally exercises the wrong-password path repeatedly instead of
        // needing a fixed sleep.
        let mut ready = false;
        let mut last_result = String::new();
        for _ in 0..30 {
            let cmd = ssh_cmd("true");
            match run_with_password(cmd, "definitely-wrong-password", None, Duration::from_secs(5)).await {
                Err(BootstrapError::WrongPassword) => {
                    ready = true;
                    break;
                }
                other => {
                    last_result = format!("{other:?}");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        assert!(ready, "sshd never came up accepting password auth in time; last result: {last_result}");

        // The actual proof: the right password succeeds AND runs the remote
        // command, returning its real output.
        let cmd = ssh_cmd("echo REMOTE_OK_$(id -un)");
        let out = run_with_password(cmd, PASSWORD, None, Duration::from_secs(10))
            .await
            .expect("the correct password must succeed");
        assert!(out.status.success(), "remote command should have exited 0: {out:?}");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains(&format!("REMOTE_OK_{USER}")),
            "expected the remote command's real output, got: {stdout:?}"
        );
    }

    /// Grep every error string this module can actually produce, driven through the
    /// REAL functions with a real secret flowing through them (not just hand-built
    /// enum values), for the literal test password — it must never appear, mirroring
    /// `tosse/mod.rs`'s `session_gone_errors_keep_the_wording_the_front_matches_on`
    /// discipline for this module. None of `BootstrapError`'s variants are ever built
    /// by formatting the password itself into a string (`WrongPassword`/`Timeout`/
    /// `HostUnreachable`/`HostKeyMismatch` are fixed text; `Other`'s raw-stderr line is
    /// actively scrubbed of any literal occurrence of the password passed alongside
    /// it) — so this stays true structurally, not by luck, and would fail LOUDLY if a
    /// future change added `format!("... {password} ...")` to any error path, or
    /// dropped the scrub in `classify_output`'s `Other` branch.
    #[tokio::test]
    async fn askpass_errors_never_contain_the_test_password() {
        const SECRET: &str = "sUp3r-s3cr3t-t3st-p4ssw0rd-9f3c";
        let mut rendered = Vec::new();

        // The one function in this module whose signature even TAKES a password:
        // drive it, with the real secret, down its one error path (nothing ever
        // reads the fifo, so it times out) — proves the secret never leaks through
        // `deliver`'s own error formatting.
        let g = make_guard();
        let err = g
            .deliver(SECRET, Duration::from_millis(50))
            .await
            .expect_err("nothing reads the fifo, so this must time out");
        assert_eq!(err, BootstrapError::Timeout);
        rendered.push(err.to_string());
        // See `guard_delivery_times_out_when_nothing_ever_reads`: release the
        // still-blocked writer thread so the `#[tokio::test]` runtime's teardown
        // does not hang waiting for it.
        g.poke_writer();

        // `classify_output`'s WrongPassword branch discards ssh's raw stderr in
        // favour of a fixed message — even stderr that happens to carry the secret
        // (e.g. a verbose debug line) nearby must not leak, since the branch never
        // reads the stderr bytes into the returned error at all.
        let stderr_with_secret_nearby = format!(
            "debug1: Authentications that can continue: password\n\
             debug1: (secret marker present in this line for the test: {SECRET})\n\
             Permission denied, please try again.\n"
        );
        let out = std::process::Output {
            status: std::os::unix::process::ExitStatusExt::from_raw(255 << 8),
            stdout: Vec::new(),
            stderr: stderr_with_secret_nearby.into_bytes(),
        };
        let err = classify_output(out, SECRET).expect_err("\"Permission denied\" classifies as WrongPassword");
        assert_eq!(err, BootstrapError::WrongPassword);
        rendered.push(err.to_string());

        // The fixed-message variants this module can also produce.
        rendered.push(BootstrapError::HostUnreachable.to_string());
        rendered.push(BootstrapError::HostKeyMismatch.to_string());

        // `classify_output`'s catch-all `Other` branch is the ONE path that forwards
        // a raw line of ssh's own stderr — exactly the case an untrusted first-contact
        // host (this bootstrap flow's `StrictHostKeyChecking=accept-new`) could try to
        // exploit by reflecting the password it just received back in a banner/
        // disconnect message. Stderr here deliberately does NOT match any of the
        // fixed-message branches above (no "permission denied" / host-key / hostname
        // wording), so it must fall all the way through to `Other`.
        let reflecting_stderr = format!("Disconnected by application: you sent '{SECRET}', goodbye");
        let out = std::process::Output {
            status: std::os::unix::process::ExitStatusExt::from_raw(255 << 8),
            stdout: Vec::new(),
            stderr: reflecting_stderr.into_bytes(),
        };
        let err = classify_output(out, SECRET).expect_err("unrecognized 255 stderr classifies as Other");
        assert!(matches!(err, BootstrapError::Other(_)));
        rendered.push(err.to_string());

        for r in &rendered {
            assert!(!r.contains(SECRET), "a BootstrapError rendering leaked the password: {r:?}");
        }
    }

    // ---- SecretString ----

    #[test]
    fn secret_string_debug_never_prints_the_password() {
        let s = SecretString::new("hunter2-sudo-pw".to_string());
        let rendered = format!("{s:?}");
        assert_eq!(rendered, "SecretString(<redacted>)");
        assert!(!rendered.contains("hunter2-sudo-pw"));
    }

    #[test]
    fn secret_string_expose_returns_the_plaintext() {
        let s = SecretString::new("hunter2-sudo-pw".to_string());
        assert_eq!(s.expose(), "hunter2-sudo-pw");
    }
}
