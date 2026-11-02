//! Sending a FILE to a server over one ssh session, with progress — the bundle and the
//! staged changes can weigh hundreds of megabytes, which the crate's in-memory stdin helpers
//! (`ipc::commands::run_ssh_on_machine_stdin`) are not made for.
//!
//! Bounded three ways: a stall bound (no chunk accepted for [`STALL`] — a link that stopped
//! moving), an overall bound ([`OVERALL`]), and cancellation (the user abandoned the launch).
//! Each ends the ssh child (`kill_on_drop`, set by the keyed builder) and says which it was.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;

use crate::store::MachineRecord;

/// No chunk accepted by the link for this long: it is not moving any more.
pub const STALL: Duration = Duration::from_secs(60);
/// No transfer takes longer than this, however it moves.
pub const OVERALL: Duration = Duration::from_secs(2 * 60 * 60);
/// How often progress is reported, at most.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const CHUNK: usize = 256 * 1024;
const STDOUT_MAX: u64 = 64 * 1024;

/// A launch's cancellation: a flag, and a wake-up for whatever is waiting on the link.
#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    /// Resolves once cancelled (immediately when it already is).
    async fn cancelled(&self) {
        loop {
            let n = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            n.await;
        }
    }
}

/// What the remote command answered.
pub struct Answer {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Why a send did not complete.
#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    Cancelled,
    Stalled,
    TooLong,
    /// ssh could not be started, or the local file read failed.
    Local(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Cancelled => write!(f, "cancelled"),
            SendError::Stalled => write!(f, "the link stopped moving for {}s", STALL.as_secs()),
            SendError::TooLong => write!(f, "the transfer did not finish within {} minutes", OVERALL.as_secs() / 60),
            SendError::Local(e) => write!(f, "{e}"),
        }
    }
}

/// Run `remote_cmd` on `m` with the file at `local` on its stdin, then EOF, reporting the
/// bytes sent through `progress` (`(sent, total)`), and return what the command answered.
/// `ssh_bin`: the test seam (a directory holding a fake `ssh`), as in
/// `run_ssh_on_machine_stdin`.
#[allow(clippy::too_many_arguments)]
pub async fn send_file(
    m: &MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    local: &Path,
    total: u64,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &Cancel,
    ssh_bin: Option<&Path>,
) -> Result<Answer, SendError> {
    let mut cmd = match ssh_bin {
        Some(dir) => {
            let bin = dir.join("ssh");
            let mut c = crate::ipc::commands::keyed_ssh_options_with_bin(
                &bin.to_string_lossy(),
                m.port,
                m.identity_file.as_deref(),
                known_hosts,
            )
            .map_err(SendError::Local)?;
            let path = std::env::var("PATH").unwrap_or_default();
            c.env("PATH", format!("{}:{path}", dir.display()));
            c
        }
        None => crate::ipc::commands::keyed_ssh_options(m.port, m.identity_file.as_deref(), known_hosts)
            .map_err(SendError::Local)?,
    };
    cmd.arg("-T");
    crate::ipc::commands::push_ssh_destination(&mut cmd, &m.user, &m.host).map_err(SendError::Local)?;
    cmd.arg(remote_cmd);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut file = tokio::fs::File::open(local)
        .await
        .map_err(|e| SendError::Local(format!("cannot read {}: {e}", local.display())))?;
    let mut child = cmd.spawn().map_err(|e| SendError::Local(format!("cannot start ssh: {e}")))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");

    let feed = async {
        let mut buf = vec![0u8; CHUNK];
        let mut sent = 0u64;
        let mut last = Instant::now();
        progress(0, total);
        loop {
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| SendError::Local(format!("cannot read {}: {e}", local.display())))?;
            if n == 0 {
                break;
            }
            tokio::select! {
                r = tokio::time::timeout(STALL, stdin.write_all(&buf[..n])) => match r {
                    Err(_) => return Err(SendError::Stalled),
                    // The far side closed early: its answer says why.
                    Ok(Err(_)) => break,
                    Ok(Ok(())) => {}
                },
                _ = cancel.cancelled() => return Err(SendError::Cancelled),
            }
            sent += n as u64;
            if last.elapsed() >= PROGRESS_EVERY {
                progress(sent, total);
                last = Instant::now();
            }
        }
        progress(sent, total);
        drop(stdin); // EOF
        Ok::<(), SendError>(())
    };
    // Sent, then the answer: it comes once the server checked what it got — bounded too.
    let drive = async {
        feed.await?;
        tokio::select! {
            r = tokio::time::timeout(STALL, child.wait()) => match r {
                Ok(Ok(status)) => Ok(status.code()),
                Ok(Err(e)) => Err(SendError::Local(format!("ssh: {e}"))),
                Err(_) => Err(SendError::Stalled),
            },
            _ = cancel.cancelled() => Err(SendError::Cancelled),
        }
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    // Drained WHILE sending, so a command that talks before it reads cannot wedge the pipes.
    let read_out = async {
        let _ = (&mut stdout).take(STDOUT_MAX).read_to_end(&mut out).await;
        let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        Ok::<(), SendError>(())
    };
    let read_err = async {
        let _ = (&mut stderr).take(STDOUT_MAX).read_to_end(&mut err).await;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        Ok::<(), SendError>(())
    };
    // `try_join`: a stall or a cancel ends it at once; the child, dropped, is killed.
    let code = match tokio::time::timeout(OVERALL, async { tokio::try_join!(drive, read_out, read_err) }).await {
        Ok(r) => r?.0,
        Err(_) => return Err(SendError::TooLong),
    };
    Ok(Answer {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        exit_code: code,
    })
}
