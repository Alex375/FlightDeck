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
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::ipc::commands::shq;

/// Everything that can go wrong running a bootstrap ssh command. Every variant's
/// [`Display`](std::fmt::Display) is worded from ssh's OWN exit status/stderr or a
/// plumbing failure message — never from the password, which none of this module's
/// code ever formats into a string. See
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
            Self::Other(d) => write!(f, "{d}"),
        }
    }
}

impl std::error::Error for BootstrapError {}

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
/// Does NOT itself set `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE`: this builds the ssh
/// invocation's argv/options, which are the same regardless of which relay ends up
/// answering the prompt; [`run_with_password`] is what owns an [`AskpassGuard`] and
/// wires those two env vars to ITS helper right before spawning. A caller that never
/// goes through `run_with_password` (there is none in this crate yet) would need to
/// set them itself.
pub fn bootstrap_ssh_command(target: &str, identity_or_none: Option<&str>, remote_cmd: &str) -> Command {
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
    if let Some(identity) = identity_or_none {
        cmd.arg("-i").arg(identity).arg("-o").arg("IdentitiesOnly=yes");
    } else {
        cmd.arg("-o")
            .arg("PreferredAuthentications=password,keyboard-interactive");
    }
    cmd.arg(target).arg(remote_cmd);
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
        std::fs::create_dir(&dir)
            .map_err(|e| BootstrapError::Other(format!("askpass: could not create temp dir: {e}")))?;
        if let Err(e) =
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(BootstrapError::Other(format!(
                "askpass: could not restrict the temp dir's permissions: {e}"
            )));
        }

        let fifo = dir.join("pass.fifo");
        if let Err(e) = make_fifo(&fifo) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }

        let helper = dir.join("askpass.sh");
        // `exec cat` the fifo once — `exec` replaces the shell so no extra process
        // lingers between ssh and the fifo read.
        let script = format!("#!/bin/sh\nexec cat {}\n", shq(&fifo.to_string_lossy()));
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
///
/// Sets `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE` on `cmd` itself, pointed at its OWN
/// [`AskpassGuard`] — `cmd` (typically built by [`bootstrap_ssh_command`]) does not
/// need to carry them already.
pub async fn run_with_password(
    mut cmd: Command,
    password: &str,
    deadline: Duration,
) -> Result<std::process::Output, BootstrapError> {
    let guard = AskpassGuard::new()?;
    cmd.env("SSH_ASKPASS", &guard.helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| BootstrapError::Other(format!("could not start ssh: {e}")))?;
    let pid = child.id();
    // A future that reads stdout+stderr to completion (avoiding a pipe-buffer
    // deadlock) AND waits for exit, spawned as its own task so it can be raced
    // against delivery below without losing the ability to kill-by-pid afterward.
    let mut wait_task = tokio::spawn(async move { child.wait_with_output().await });

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
            // Delivery settled first (delivered, or timed out on its own). Either
            // way ssh is still the one running; give it the same overall deadline to
            // actually exit and produce output, rather than hanging indefinitely.
            match timeout(deadline, &mut wait_task).await {
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
    classify_output(output)
}

/// Turns ssh's raw exit status/stderr into the typed outcome callers actually want.
/// ssh's own convention: exit code 255 means SSH ITSELF failed (auth/connect/host-key)
/// — any other code is the REMOTE COMMAND's own exit code carried through verbatim,
/// meaning the connection and auth succeeded, so that case is always `Ok`.
fn classify_output(out: std::process::Output) -> Result<std::process::Output, BootstrapError> {
    if out.status.code() != Some(255) {
        return Ok(out);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if stderr.contains("permission denied") {
        return Err(BootstrapError::WrongPassword);
    }
    if stderr.contains("host key verification failed")
        || stderr.contains("remote host identification has changed")
    {
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
    Err(BootstrapError::Other(
        String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("ssh failed")
            .to_string(),
    ))
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
        let cmd = bootstrap_ssh_command("tester@127.0.0.1", None, "true");
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
        let cmd = bootstrap_ssh_command("tester@127.0.0.1", Some("/tmp/some_key"), "true");
        let std_cmd = cmd.as_std();
        let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"));
        assert!(
            !args.iter().any(|a| a == "PreferredAuthentications=password,keyboard-interactive"),
            "an identity was given, so this restriction must not be applied: {args:?}"
        );
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
        let cmd = bootstrap_ssh_command("ssh://nobody@127.0.0.1:1", None, "true");
        let result = run_with_password(cmd, "irrelevant", Duration::from_secs(10)).await;
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

        // Best-effort teardown of a stale container from a previous aborted run,
        // THEN register the guard so THIS run's container is removed on every exit
        // path (including a panic from an assertion below).
        let _ = std::process::Command::new("docker").args(["rm", "-f", CONTAINER]).output();
        let _guard = ContainerGuard;

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

        // Poll with the WRONG password until sshd actually accepts connections (a
        // freshly started container's sshd takes a moment to come up) — this
        // incidentally exercises the wrong-password path repeatedly instead of
        // needing a fixed sleep.
        let mut ready = false;
        let mut last_result = String::new();
        for _ in 0..30 {
            let cmd = bootstrap_ssh_command(&target, None, "true");
            match run_with_password(cmd, "definitely-wrong-password", Duration::from_secs(5)).await {
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
        let cmd = bootstrap_ssh_command(&target, None, "echo REMOTE_OK_$(id -un)");
        let out = run_with_password(cmd, PASSWORD, Duration::from_secs(10))
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
    /// `HostUnreachable`/`HostKeyMismatch` are fixed text; `Other` carries only ssh's
    /// own diagnostic output or a plumbing-failure reason, neither of which this
    /// module ever seeds with the password) — so this stays true structurally, not by
    /// luck, and would fail LOUDLY if a future change added `format!("... {password}
    /// ...")` to any error path.
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
        let err = classify_output(out).expect_err("\"Permission denied\" classifies as WrongPassword");
        assert_eq!(err, BootstrapError::WrongPassword);
        rendered.push(err.to_string());

        // The fixed-message variants this module can also produce.
        rendered.push(BootstrapError::HostUnreachable.to_string());
        rendered.push(BootstrapError::HostKeyMismatch.to_string());

        for r in &rendered {
            assert!(!r.contains(SECRET), "a BootstrapError rendering leaked the password: {r:?}");
        }
    }
}
