//! The attach plane: a Unix socket the `flightdeckd attach` subcommand (run
//! over SSH by the Mac) bridges to its stdio. First line in is the request
//! (`attach`, or a one-shot: `status`, `stop`, `add_phone`, `remove_phone`);
//! for `attach` the connection then becomes a transparent line pipe: client →
//! claude stdin, claude stdout (replay + live) → client.

use crate::frames;
use crate::session::{ClientQueue, SessionManager, SessionMsg, ACTOR_REPLY_TIMEOUT, ATTACH_WRITE_TIMEOUT};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
struct FirstLine {
    attach: Option<AttachParams>,
    status: Option<serde_json::Value>,
    stop: Option<StopParams>,
    add_phone: Option<AddPhoneParams>,
    remove_phone: Option<RemovePhoneParams>,
}

#[derive(Debug, Deserialize)]
struct AddPhoneParams {
    token: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Deserialize)]
struct RemovePhoneParams {
    token: String,
}

#[derive(Debug, Deserialize)]
struct AttachParams {
    conversation: Option<String>,
    cwd: Option<String>,
    resume_session: Option<String>,
    epoch: Option<String>,
    #[serde(default)]
    cursor: u64,
    #[serde(default)]
    claude_args: Vec<String>,
    /// The client's title for the conversation — authoritative (overwrites).
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StopParams {
    conversation: String,
}

/// Bind the attach socket owner-only: whoever can connect controls every
/// session and the phone access. The umask is narrowed AROUND the bind so the
/// socket is never born group/world-accessible (a bind-then-chmod leaves a
/// window); the chmod after is a second belt.
fn bind_private(socket: &Path) -> Result<UnixListener> {
    // SAFETY: umask(2) cannot fail; the previous mask is restored right after.
    let old = unsafe { libc::umask(0o077) };
    let bound = UnixListener::bind(socket);
    unsafe { libc::umask(old) };
    let listener = bound.with_context(|| format!("cannot bind {}", socket.display()))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("cannot chmod 600 {}", socket.display()))?;
    Ok(listener)
}

/// Only the daemon's own user may use the socket (defense in depth beside the
/// socket's mode and the 0700 state dir).
fn peer_is_owner(conn: &UnixStream) -> std::result::Result<(), String> {
    // SAFETY: geteuid(2) cannot fail.
    let own = unsafe { libc::geteuid() };
    match conn.peer_cred() {
        Ok(cred) if cred.uid() == own => Ok(()),
        Ok(cred) => Err(format!("uid {} (the daemon runs as uid {own})", cred.uid())),
        Err(e) => Err(format!("unknown peer credentials ({e})")),
    }
}

pub async fn serve(manager: Arc<SessionManager>, socket: &Path) -> Result<()> {
    if socket.exists() {
        std::fs::remove_file(socket).ok();
    }
    if let Some(dir) = socket.parent().filter(|d| !d.as_os_str().is_empty()) {
        crate::config::create_private_dir(dir)?;
    }
    let listener = bind_private(socket)?;
    info!("attach socket ready at {}", socket.display());
    loop {
        // One failed accept (EMFILE, a raced peer) must not take the whole
        // daemon — and every live session — down with it.
        match listener.accept().await {
            Ok((conn, _)) => {
                if let Err(who) = peer_is_owner(&conn) {
                    warn!("attach connection refused: {who}");
                    continue; // dropping `conn` closes it
                }
                let manager = manager.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(manager, conn).await {
                        warn!("attach connection ended with error: {e:#}");
                    }
                });
            }
            Err(e) => {
                warn!("attach accept failed: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_conn(manager: Arc<SessionManager>, conn: UnixStream) -> Result<()> {
    let (read_half, mut write_half) = conn.into_split();
    let mut reader = BufReader::new(read_half);

    let mut first = String::new();
    reader.read_line(&mut first).await?;
    let parsed: FirstLine = match serde_json::from_str(first.trim()) {
        Ok(p) => p,
        Err(e) => {
            let msg = json!({"type": "fd_detach", "reason": "error", "message": format!("bad attach request: {e}")});
            write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
            return Ok(());
        }
    };

    if parsed.status.is_some() {
        let mut out = Vec::new();
        let rows = manager.with_registry(|r| r.list(true)).unwrap_or_default();
        for row in rows {
            let live = manager.status(&row.id).await;
            out.push(json!({
                "conversation": row.id,
                "title": row.title,
                "repo_path": row.repo_path,
                "session_id": row.session_id,
                "archived": row.archived,
                "running": live.as_ref().map(|s| s.running).unwrap_or(false),
                "busy": live.as_ref().map(|s| s.busy).unwrap_or(false),
                "pending": live.as_ref().map(|s| s.pending.len()).unwrap_or(0),
            }));
        }
        let line = frames::fd_status(&manager.cfg.label, out);
        write_half.write_all(format!("{line}\n").as_bytes()).await.ok();
        return Ok(());
    }

    if let Some(stop) = parsed.stop {
        let (ack, rx) = oneshot::channel();
        let line = match manager.route(&stop.conversation, SessionMsg::Stop { ack }).await {
            Ok(()) => {
                let _ = tokio::time::timeout(ACTOR_REPLY_TIMEOUT, rx).await;
                json!({"type": "fd_stopped", "conversation": stop.conversation, "stopped": true})
            }
            Err(_) => {
                json!({"type": "fd_stopped", "conversation": stop.conversation, "stopped": false, "note": "it was not running"})
            }
        };
        write_half.write_all(format!("{line}\n").as_bytes()).await.ok();
        return Ok(());
    }

    // Phone access changes: blocking (config file + its cross-process lock),
    // so off the async workers. Replies never echo the token (a secret).
    if let Some(add) = parsed.add_phone {
        let m = manager.clone();
        let res = tokio::task::spawn_blocking(move || m.add_phone_token(&add.token, &add.label)).await;
        let line = match res.map_err(anyhow::Error::from).and_then(|r| r) {
            Ok(added) => json!({"type": "fd_phone_added", "ok": true, "added": added}),
            Err(e) => json!({"type": "fd_phone_added", "ok": false, "error": format!("{e:#}")}),
        };
        write_half.write_all(format!("{line}\n").as_bytes()).await.ok();
        return Ok(());
    }
    if let Some(rm) = parsed.remove_phone {
        let m = manager.clone();
        let res = tokio::task::spawn_blocking(move || m.remove_phone_token(&rm.token)).await;
        let line = match res.map_err(anyhow::Error::from).and_then(|r| r) {
            Ok(removed) => json!({"type": "fd_phone_removed", "ok": true, "removed": removed}),
            Err(e) => json!({"type": "fd_phone_removed", "ok": false, "error": format!("{e:#}")}),
        };
        write_half.write_all(format!("{line}\n").as_bytes()).await.ok();
        return Ok(());
    }

    let Some(p) = parsed.attach else {
        let msg = json!({"type": "fd_detach", "reason": "error", "message": "missing attach, status, stop, add_phone or remove_phone"});
        write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
        return Ok(());
    };

    let (queue, lines_rx, outstanding) = ClientQueue::new();
    let attached = manager
        .attach(p.conversation, p.cwd, p.resume_session, p.claude_args, p.epoch, p.cursor, queue)
        .await;
    let (conv_id, client_id) = match attached {
        Ok(x) => x,
        Err(e) => {
            let msg = json!({"type": "fd_detach", "reason": "error", "message": e.to_string()});
            write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
            return Ok(());
        }
    };
    if let Some(title) = p.title.as_deref() {
        if let Err(e) = manager.with_registry(|r| r.set_title_authoritative(&conv_id, title)) {
            warn!(conv = conv_id.as_str(), "cannot record the client's title: {e:#}");
        }
    }

    // daemon → client. Ending the pump drops the queue's receiver, so the
    // actor's next push fails and it forgets this client.
    let mut writer = {
        let conv_id = conv_id.clone();
        tokio::spawn(async move {
            let end = pump_to_client(
                &mut write_half,
                lines_rx,
                &outstanding,
                ATTACH_WRITE_TIMEOUT,
                STALL_FAREWELL_TIMEOUT,
            )
            .await;
            if end == PumpEnd::Stalled {
                warn!(
                    conv = conv_id.as_str(),
                    "attach client accepted nothing for {ATTACH_WRITE_TIMEOUT:?} — dropped (stalled)"
                );
            }
            write_half.shutdown().await.ok();
            end
        })
    };

    let writer_end = async { (&mut writer).await.unwrap_or(PumpEnd::Broken) };
    read_client(&mut reader, &manager, &conv_id, writer_end).await;
    let _ = manager.route(&conv_id, SessionMsg::ClientGone(client_id)).await;
    writer.abort();
    Ok(())
}

/// Client → daemon: route complete lines (same contract as the stdout pump)
/// into the session until the client closes. If the write pump gives up first
/// (stalled or broken link), the connection is dead: stop right away and
/// release it, instead of holding the task and fd until ssh or the kernel
/// notices. No idle timeout — a healthy client can stay silent for hours.
/// When the session closed the stream (Closed: replaced / stopped / exited),
/// the peer is healthy and closes on its own: keep reading until it does.
async fn read_client<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    manager: &SessionManager,
    conv_id: &str,
    writer_end: impl std::future::Future<Output = PumpEnd>,
) {
    let lines = async {
        let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    if buf.last() != Some(&b'\n') {
                        break;
                    }
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if manager.route(conv_id, SessionMsg::ClientLine(line)).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };
    tokio::pin!(lines);
    tokio::select! {
        _ = &mut lines => {}
        end = writer_end => {
            if end == PumpEnd::Closed {
                lines.await;
            }
        }
    }
}

/// Once a write has stalled, how long each write of the farewell
/// (`fd_detach{stalled}`) may make no progress before it is abandoned.
const STALL_FAREWELL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
enum PumpEnd {
    /// The session dropped this client's queue (replaced / stopped / exited).
    Closed,
    /// A hard write error: the peer is gone.
    Broken,
    /// The link stopped accepting bytes for `write_timeout`: the client was
    /// sent `fd_detach{stalled}` (best effort) and dropped.
    Stalled,
}

/// Drain the actor's queue into the attach socket, one newline-terminated line
/// at a time. Every `write` is bounded by `write_timeout` — a link that is
/// alive but accepts nothing (Wi-Fi cut under a half-open ssh) would otherwise
/// block forever, pinning the client as attached while the daemon queues
/// everything for it. The bound is on PROGRESS, not on a whole line, so a big
/// line over a slow-but-moving link is not mistaken for a stall.
///
/// On a stall: one best-effort write of the torn line's remainder (if it was
/// half-written — the client must never see a spliced line) followed by
/// `fd_detach{stalled}`, bounded like every write here: it gives up once one
/// write makes no progress for `farewell_timeout` (a link that drains again,
/// even slowly, gets the whole farewell). The unwritten backlog is abandoned —
/// the client gets it back by replay from its cursor.
async fn pump_to_client<W: AsyncWrite + Unpin>(
    out: &mut W,
    mut lines_rx: mpsc::UnboundedReceiver<String>,
    outstanding: &AtomicI64,
    write_timeout: Duration,
    farewell_timeout: Duration,
) -> PumpEnd {
    while let Some(line) = lines_rx.recv().await {
        let mut buf = line.into_bytes();
        buf.push(b'\n');
        let bytes = buf.len() as i64;
        let mut written = 0;
        let res = write_bounded(out, &buf, &mut written, write_timeout).await;
        outstanding.fetch_sub(bytes, Ordering::Relaxed);
        match res {
            Ok(()) => {}
            Err(WriteFail::Io) => return PumpEnd::Broken,
            Err(WriteFail::Stalled) => {
                let mut farewell = Vec::new();
                if written > 0 {
                    farewell.extend_from_slice(&buf[written..]);
                }
                farewell.extend_from_slice(frames::fd_detach("stalled", None).as_bytes());
                farewell.push(b'\n');
                let _ = write_bounded(out, &farewell, &mut 0, farewell_timeout).await;
                return PumpEnd::Stalled;
            }
        }
    }
    PumpEnd::Closed
}

enum WriteFail {
    Io,
    Stalled,
}

/// Write `buf[*written..]`, advancing `*written` as bytes land (a cancelled
/// `write` writes nothing, so the count stays exact). Fails as `Stalled` when
/// one `write` makes no progress for `stall_after`.
async fn write_bounded<W: AsyncWrite + Unpin>(
    out: &mut W,
    buf: &[u8],
    written: &mut usize,
    stall_after: Duration,
) -> std::result::Result<(), WriteFail> {
    while *written < buf.len() {
        match tokio::time::timeout(stall_after, out.write(&buf[*written..])).await {
            Ok(Ok(0)) | Ok(Err(_)) => return Err(WriteFail::Io),
            Ok(Ok(n)) => *written += n,
            Err(_) => return Err(WriteFail::Stalled),
        }
    }
    match tokio::time::timeout(stall_after, out.flush()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(WriteFail::Io),
        Err(_) => Err(WriteFail::Stalled),
    }
}

// ---------------------------------------------------------------------------
// The client side (`flightdeckd attach` / `status` / `stop`), run over SSH.

#[allow(clippy::too_many_arguments)]
pub async fn attach_client(
    socket: &Path,
    conversation: Option<String>,
    cwd: Option<String>,
    resume_session: Option<String>,
    epoch: Option<String>,
    cursor: u64,
    claude_args: Vec<String>,
    title: Option<String>,
) -> Result<()> {
    let conn = UnixStream::connect(socket).await.with_context(|| {
        format!("flightdeckd is not running (no socket at {})", socket.display())
    })?;
    let (read_half, mut write_half) = conn.into_split();
    let req = json!({"attach": {
        "conversation": conversation,
        "cwd": cwd,
        "resume_session": resume_session,
        "epoch": epoch,
        "cursor": cursor,
        "claude_args": claude_args,
        "title": title,
    }});
    write_half.write_all(format!("{req}\n").as_bytes()).await?;
    write_half.flush().await?;

    // stdin → socket. Read on a plain detached thread, NOT tokio::io::stdin:
    // tokio reads stdin on its blocking pool, whose uncancellable read the
    // runtime shutdown waits on — once the daemon closed the stream the
    // process would linger with stdout open (ssh never sees EOF, the Mac never
    // learns the link is gone) until the client wrote another line. A
    // detached thread dies with the process.
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut stdin = std::io::stdin().lock();
        let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match stdin.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if stdin_tx.blocking_send(buf.clone()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let stdin_pump = tokio::spawn(async move {
        let res = pump_stdin(&mut write_half, &mut stdin_rx, stop_rx, STDIN_DRAIN_QUIET).await;
        write_half.shutdown().await.ok();
        res
    });

    // socket → stdout; ends when the daemon closes (fd_detach) or the pipe dies.
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(read_half);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                if stdout.write_all(&buf).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    // Lines already read off stdin were SENT as far as the client knows:
    // deliver them (bounded) or fail loudly — never drop them silently.
    let _ = stop_tx.send(());
    match tokio::time::timeout(STDIN_DRAIN_TOTAL, stdin_pump).await {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => Err(anyhow::anyhow!("the stdin pump crashed: {e}")),
        Err(_) => anyhow::bail!(
            "stdin lines were still queued {STDIN_DRAIN_TOTAL:?} after flightdeckd closed the stream — not delivered"
        ),
    }
}

/// How long the bridge may spend delivering the stdin lines it had already
/// read when the daemon ended the stream.
const STDIN_DRAIN_TOTAL: Duration = Duration::from_secs(2);
/// During that drain, a line that has not arrived within this long is not
/// coming (the stdin thread is waiting on the client, not holding a line).
const STDIN_DRAIN_QUIET: Duration = Duration::from_millis(200);

/// stdin lines → the daemon socket, in order. Runs until stdin ends (Ok) or
/// `stop` fires (the daemon ended the stream); then it DRAINS what the stdin
/// thread already read: every such line is written, or this fails with an
/// explicit error — a line is never dropped silently.
async fn pump_stdin<W: AsyncWrite + Unpin>(
    out: &mut W,
    rx: &mut mpsc::Receiver<Vec<u8>>,
    stop: oneshot::Receiver<()>,
    quiet: Duration,
) -> Result<()> {
    tokio::pin!(stop);
    loop {
        tokio::select! {
            biased;
            chunk = rx.recv() => match chunk {
                Some(c) => deliver_stdin(out, &c, rx).await?,
                None => return Ok(()), // stdin EOF
            },
            _ = &mut stop => break,
        }
    }
    while let Ok(Some(c)) = tokio::time::timeout(quiet, rx.recv()).await {
        deliver_stdin(out, &c, rx).await?;
    }
    Ok(())
}

async fn deliver_stdin<W: AsyncWrite + Unpin>(out: &mut W, chunk: &[u8], rx: &mpsc::Receiver<Vec<u8>>) -> Result<()> {
    let res = async {
        out.write_all(chunk).await?;
        out.flush().await
    }
    .await;
    res.map_err(|e| {
        anyhow::anyhow!("{} stdin line(s) could not be delivered to flightdeckd: {e}", 1 + rx.len())
    })
}

async fn one_shot(socket: &Path, request: serde_json::Value) -> Result<String> {
    let conn = UnixStream::connect(socket).await.with_context(|| {
        format!("flightdeckd is not running (no socket at {})", socket.display())
    })?;
    let (read_half, mut write_half) = conn.into_split();
    write_half.write_all(format!("{request}\n").as_bytes()).await?;
    write_half.flush().await?;
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    Ok(line.trim().to_string())
}

/// The daemon's `fd_status` line: `{type, version, label, conversations}` —
/// `version` is the RUNNING daemon's (see [`frames::DAEMON_VERSION`]).
pub async fn status_client(socket: &Path) -> Result<String> {
    one_shot(socket, json!({"status": {}})).await
}

/// Stop one conversation's claude process (used by the Mac's explicit Stop when
/// its attach link is already gone — `ssh host flightdeckd stop --conversation X`).
pub async fn stop_client(socket: &Path, conversation: &str) -> Result<String> {
    one_shot(socket, json!({"stop": {"conversation": conversation}})).await
}

/// A one-shot whose reply carries `ok`: an `ok:false` reply becomes an Err
/// (so the CLI exits non-zero), otherwise the raw line is returned.
async fn one_shot_checked(socket: &Path, request: serde_json::Value) -> Result<String> {
    let line = one_shot(socket, request).await?;
    let v: serde_json::Value = serde_json::from_str(&line)
        .with_context(|| format!("unexpected reply from flightdeckd: {line:?}"))?;
    if v["ok"] != json!(true) {
        anyhow::bail!("{}", v["error"].as_str().unwrap_or("flightdeckd refused the request"));
    }
    Ok(line)
}

/// Authorize a phone on this node (persisted + pushed to the relay live):
/// `{"type":"fd_phone_added","ok":true,"added":<new?>}`.
pub async fn add_phone_client(socket: &Path, token: &str, label: &str) -> Result<String> {
    one_shot_checked(socket, json!({"add_phone": {"token": token, "label": label}})).await
}

/// De-authorize a phone: `{"type":"fd_phone_removed","ok":true,"removed":<was it?>}`.
pub async fn remove_phone_client(socket: &Path, token: &str) -> Result<String> {
    one_shot_checked(socket, json!({"remove_phone": {"token": token}})).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use serde_json::Value;

    /// `n` distinct small JSON lines (like stream_event deltas), queued. The
    /// sender comes back too: dropping it would end the pump once drained.
    fn burst(n: usize) -> (mpsc::UnboundedSender<String>, mpsc::UnboundedReceiver<String>, Vec<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let lines: Vec<String> = (0..n)
            .map(|i| json!({"type": "stream_event", "i": i, "pad": "x".repeat(80)}).to_string())
            .collect();
        for l in &lines {
            tx.send(l.clone()).unwrap();
        }
        (tx, rx, lines)
    }

    async fn read_all_lines<R: tokio::io::AsyncRead + Unpin>(r: R, after: Duration) -> Vec<String> {
        tokio::time::sleep(after).await;
        let mut got = Vec::new();
        let mut r = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => got.push(String::from_utf8(buf.clone()).unwrap()),
            }
        }
        got
    }

    fn assert_stalled_farewell(got: &[String], lines: &[String]) -> usize {
        let last = got.last().expect("nothing received");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(last.trim_end()).unwrap(),
            json!({"type": "fd_detach", "reason": "stalled"})
        );
        // Everything before the farewell is the in-order, WHOLE-line prefix of
        // the burst: a torn line was completed, never spliced.
        let body = &got[..got.len() - 1];
        for (i, l) in body.iter().enumerate() {
            assert!(l.ends_with('\n'));
            assert_eq!(l.trim_end(), lines[i], "line {i} torn or out of order");
        }
        body.len()
    }

    #[tokio::test]
    async fn stalled_reader_is_given_up_on_within_the_write_timeout() {
        let (mut ours, _theirs) = UnixStream::pair().unwrap(); // `_theirs` never reads
        let (tx, rx, _) = burst(20_000);
        let outstanding = AtomicI64::new(0);
        let write_timeout = Duration::from_millis(150);
        let t0 = std::time::Instant::now();
        let end = tokio::time::timeout(
            Duration::from_secs(5),
            pump_to_client(&mut ours, rx, &outstanding, write_timeout, Duration::from_millis(100)),
        )
        .await
        .expect("the pump hung on a stalled reader");
        assert_eq!(end, PumpEnd::Stalled);
        assert!(t0.elapsed() < write_timeout + Duration::from_secs(2), "took {:?}", t0.elapsed());
        // Ending the pump dropped the receiver: the actor's next push fails.
        assert!(tx.send("more".into()).is_err());
    }

    #[tokio::test]
    async fn resumed_reader_gets_the_buffered_lines_then_fd_detach_stalled_not_the_backlog() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let (_tx, rx, lines) = burst(20_000);
        let outstanding = AtomicI64::new(0);
        // The peer is frozen well past the write timeout, then drains (a
        // SIGSTOPped ssh getting SIGCONT) — within the farewell window.
        let reader = tokio::spawn(read_all_lines(theirs, Duration::from_millis(600)));
        let end = pump_to_client(&mut ours, rx, &outstanding, Duration::from_millis(100), Duration::from_secs(3)).await;
        assert_eq!(end, PumpEnd::Stalled);
        ours.shutdown().await.unwrap();
        let got = reader.await.unwrap();
        let body = assert_stalled_farewell(&got, &lines);
        assert!(body < lines.len() / 2, "the stalled backlog was dumped ({body} lines)");
    }

    #[tokio::test]
    async fn a_line_torn_by_the_stall_is_completed_before_the_farewell() {
        // A 1000-byte pipe and ~112-byte lines: the 9th line is half-written
        // when the pipe fills — deterministic torn line.
        let (mut ours, theirs) = tokio::io::duplex(1000);
        let (_tx, rx, lines) = burst(100);
        assert!(lines[0].len() + 1 > 100 && 8 * (lines[0].len() + 1) < 1000);
        let outstanding = AtomicI64::new(0);
        let reader = tokio::spawn(read_all_lines(theirs, Duration::from_millis(400)));
        let end = pump_to_client(&mut ours, rx, &outstanding, Duration::from_millis(100), Duration::from_secs(3)).await;
        assert_eq!(end, PumpEnd::Stalled);
        drop(ours);
        let got = reader.await.unwrap();
        assert_eq!(assert_stalled_farewell(&got, &lines), 9);
    }

    #[tokio::test]
    async fn a_farewell_needing_several_slow_writes_still_gets_through() {
        // A ~5 KB line through a 1000-byte pipe: 1000 bytes land, then the
        // peer freezes → stall. It then drains 500 bytes every 150 ms: each
        // farewell write progresses well within the 300 ms budget, but the
        // whole farewell takes ~1.2 s — it must not be cut at 300 ms.
        let (mut ours, mut theirs) = tokio::io::duplex(1000);
        let (tx, rx) = mpsc::unbounded_channel();
        let big = json!({"type": "user", "pad": "y".repeat(5000)}).to_string();
        tx.send(big.clone()).unwrap();
        let reader = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let mut all = Vec::new();
            let mut chunk = [0u8; 500];
            loop {
                match theirs.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => all.extend_from_slice(&chunk[..n]),
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            String::from_utf8(all).unwrap()
        });
        let outstanding = AtomicI64::new(0);
        let end = pump_to_client(&mut ours, rx, &outstanding, Duration::from_millis(100), Duration::from_millis(300)).await;
        assert_eq!(end, PumpEnd::Stalled);
        drop(ours);
        let got = reader.await.unwrap();
        let lines: Vec<&str> = got.lines().collect();
        assert_eq!(lines, vec![big.as_str(), r#"{"reason":"stalled","type":"fd_detach"}"#]);
        drop(tx);
    }

    #[tokio::test]
    async fn healthy_reader_gets_every_line_and_the_pump_ends_when_the_queue_closes() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let (tx, rx, lines) = burst(5_000);
        drop(tx); // the session "closes" the queue once it is drained
        let outstanding = AtomicI64::new(0);
        let reader = tokio::spawn(async move {
            let mut r = BufReader::new(theirs).lines();
            let mut got = Vec::new();
            while let Ok(Some(l)) = r.next_line().await {
                got.push(l);
            }
            got
        });
        let end = pump_to_client(&mut ours, rx, &outstanding, Duration::from_millis(500), Duration::from_millis(100)).await;
        assert_eq!(end, PumpEnd::Closed);
        ours.shutdown().await.unwrap();
        assert_eq!(reader.await.unwrap(), lines);
    }

    #[tokio::test]
    async fn one_shot_verbs_drive_phone_access_over_the_socket() {
        let dir = testutil::short_tempdir();
        let mut cfg = testutil::test_cfg();
        cfg.phone_tokens = vec![crate::config::PhoneToken { token: "seed".into(), label: String::new() }];
        let m = testutil::manager_with_config(dir.path(), cfg);
        let socket = testutil::serve_attach(m.clone(), dir.path()).await;
        let parse = |l: String| serde_json::from_str::<Value>(&l).unwrap();

        let v = parse(add_phone_client(&socket, "pt-1", "iPhone").await.unwrap());
        assert_eq!(v, json!({"type": "fd_phone_added", "ok": true, "added": true}));
        let v = parse(add_phone_client(&socket, "pt-1", "iPhone 16").await.unwrap());
        assert_eq!(v["added"], false);
        {
            let phones = m.phones.lock().unwrap();
            let tokens: Vec<(&str, &str)> =
                phones.tokens.iter().map(|p| (p.token.as_str(), p.label.as_str())).collect();
            assert_eq!(tokens, vec![("seed", ""), ("pt-1", "iPhone 16")]);
        }
        let err = add_phone_client(&socket, " ", "x").await.unwrap_err();
        assert!(err.to_string().contains("phone token is empty"), "{err}");

        let v = parse(remove_phone_client(&socket, "seed").await.unwrap());
        assert_eq!(v, json!({"type": "fd_phone_removed", "ok": true, "removed": true}));
        let v = parse(remove_phone_client(&socket, "seed").await.unwrap());
        assert_eq!(v["removed"], false);
        {
            let phones = m.phones.lock().unwrap();
            assert_eq!(phones.tokens.len(), 1);
            assert_eq!(phones.revoked, vec!["seed".to_string()]);
        }
        let disk = crate::config::Config::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(disk.phone_tokens.len(), 1);
        assert_eq!(disk.revoked_phone_tokens, vec!["seed".to_string()]);

        // the older verbs still answer on the same socket
        let v = parse(stop_client(&socket, "no-such-conv").await.unwrap());
        assert_eq!(v["type"], "fd_stopped");
        assert_eq!(v["stopped"], false);
        let v = parse(status_client(&socket).await.unwrap());
        assert_eq!(v["type"], "fd_status");
    }

    #[tokio::test]
    async fn attach_title_is_authoritative() {
        let dir = testutil::short_tempdir();
        let mut cfg = testutil::test_cfg();
        cfg.claude_bin = testutil::fake_claude(dir.path(), "sid-t").to_string_lossy().into();
        let m = testutil::test_manager(cfg);
        let socket = testutil::serve_attach(m.clone(), dir.path()).await;
        let cwd = dir.path().to_string_lossy().to_string();

        let attach = |conversation: Option<String>, title: Option<&str>| {
            let socket = socket.clone();
            let req = json!({"attach": {"conversation": conversation, "cwd": cwd, "title": title}});
            async move {
                let mut conn = UnixStream::connect(&socket).await.unwrap();
                conn.write_all(format!("{req}\n").as_bytes()).await.unwrap();
                let mut line = String::new();
                BufReader::new(&mut conn).read_line(&mut line).await.unwrap();
                serde_json::from_str::<Value>(&line).unwrap()["conversation"].as_str().unwrap().to_string()
            }
        };
        let title_of = |id: &str| m.with_registry(|r| r.get(id)).unwrap().unwrap().title;

        let conv = attach(None, Some("My Feature")).await;
        assert_eq!(title_of(&conv), "My Feature");
        attach(Some(conv.clone()), Some("Renamed on the Mac")).await;
        assert_eq!(title_of(&conv), "Renamed on the Mac");
        attach(Some(conv.clone()), None).await; // no title: unchanged
        attach(Some(conv.clone()), Some("  ")).await; // blank: unchanged
        assert_eq!(title_of(&conv), "Renamed on the Mac");
    }

    fn queued_lines(n: usize) -> (mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(64);
        for i in 0..n {
            tx.try_send(format!("{{\"type\":\"user\",\"i\":{i}}}\n").into_bytes()).unwrap();
        }
        (tx, rx)
    }

    #[tokio::test]
    async fn stdin_lines_queued_when_the_daemon_closes_are_all_delivered() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let (_tx, mut rx) = queued_lines(50); // stdin still open, 50 lines already read
        let (stop_tx, stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap(); // the daemon ended the stream right away
        pump_stdin(&mut ours, &mut rx, stop_rx, Duration::from_millis(50)).await.unwrap();
        drop(ours);
        let got = read_all_lines(theirs, Duration::ZERO).await;
        assert_eq!(got.len(), 50, "a queued stdin line was dropped");
        assert!(got[49].contains("\"i\":49"));
    }

    #[tokio::test]
    async fn a_stdin_line_arriving_during_the_drain_is_delivered_too() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let (tx, mut rx) = queued_lines(1);
        let (stop_tx, stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await; // the stdin thread hands over one more
            tx.send(b"{\"type\":\"late\"}\n".to_vec()).await.unwrap();
        });
        pump_stdin(&mut ours, &mut rx, stop_rx, Duration::from_millis(300)).await.unwrap();
        drop(ours);
        assert_eq!(read_all_lines(theirs, Duration::ZERO).await.len(), 2);
    }

    #[tokio::test]
    async fn undeliverable_stdin_lines_fail_loudly() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        drop(theirs); // the daemon's side is gone
        let (_tx, mut rx) = queued_lines(3);
        let (stop_tx, stop_rx) = oneshot::channel();
        stop_tx.send(()).unwrap();
        let err = pump_stdin(&mut ours, &mut rx, stop_rx, Duration::from_millis(50)).await.unwrap_err();
        assert!(err.to_string().contains("3 stdin line(s) could not be delivered"), "{err}");
    }

    #[tokio::test]
    async fn the_attach_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = testutil::short_tempdir();
        let socket = testutil::serve_attach(testutil::test_manager(testutil::test_cfg()), dir.path()).await;
        assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);
        // and its owner still gets in (peer credentials match)
        let line = status_client(&socket).await.unwrap();
        assert!(line.contains("fd_status"));
    }

    #[tokio::test]
    async fn a_given_up_writer_releases_a_silent_connection_at_once() {
        let m = testutil::test_manager(testutil::test_cfg());
        for end in [PumpEnd::Stalled, PumpEnd::Broken] {
            let (ours, _peer) = UnixStream::pair().unwrap(); // the peer never writes nor closes
            let mut reader = BufReader::new(ours);
            let writer_end = async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                end
            };
            tokio::time::timeout(Duration::from_secs(2), read_client(&mut reader, &m, "c", writer_end))
                .await
                .expect("the reader outlived a write pump that gave up");
        }
    }

    #[tokio::test]
    async fn a_silent_healthy_client_is_never_timed_out() {
        let m = testutil::test_manager(testutil::test_cfg());
        let (ours, peer) = UnixStream::pair().unwrap();
        let mut reader = BufReader::new(ours);
        let never = std::future::pending::<PumpEnd>();
        let r = tokio::time::timeout(Duration::from_millis(400), read_client(&mut reader, &m, "c", never)).await;
        assert!(r.is_err(), "an idle but healthy client was dropped");
        // after the session closed the stream, the reader waits for the peer to close
        let closed = async { PumpEnd::Closed };
        let wait = read_client(&mut reader, &m, "c", closed);
        tokio::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_millis(200), &mut wait).await.is_err());
        drop(peer);
        tokio::time::timeout(Duration::from_secs(2), wait).await.expect("EOF must end the reader");
    }

    #[tokio::test]
    async fn status_client_round_trips_the_daemon_version() {
        let dir = testutil::short_tempdir();
        let manager = testutil::test_manager(testutil::test_cfg());
        let socket = testutil::serve_attach(manager, dir.path()).await;
        let line = status_client(&socket).await.unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "fd_status");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["label"], "test");
        assert!(v["conversations"].as_array().unwrap().is_empty());
    }
}
