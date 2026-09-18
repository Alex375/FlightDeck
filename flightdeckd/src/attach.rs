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
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
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

pub async fn serve(manager: Arc<SessionManager>, socket: &Path) -> Result<()> {
    if socket.exists() {
        std::fs::remove_file(socket).ok();
    }
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = UnixListener::bind(socket)
        .with_context(|| format!("cannot bind {}", socket.display()))?;
    info!("attach socket ready at {}", socket.display());
    loop {
        // One failed accept (EMFILE, a raced peer) must not take the whole
        // daemon — and every live session — down with it.
        match listener.accept().await {
            Ok((conn, _)) => {
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
    let writer = {
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
        })
    };

    // client → daemon (complete lines only, same contract as the stdout pump)
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
                if manager.route(&conv_id, SessionMsg::ClientLine(line)).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = manager.route(&conv_id, SessionMsg::ClientGone(client_id)).await;
    writer.abort();
    Ok(())
}

/// Once a write has stalled, how long the farewell (`fd_detach{stalled}`) gets.
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
/// On a stall: one best-effort write, bounded by `farewell_timeout`, of the
/// torn line's remainder (if it was half-written — the client must never see a
/// spliced line) followed by `fd_detach{stalled}`; the unwritten backlog is
/// abandoned — the client gets it back by replay from its cursor.
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
                let _ = tokio::time::timeout(
                    farewell_timeout,
                    write_bounded(out, &farewell, &mut 0, farewell_timeout),
                )
                .await;
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
    let stdin_pump = tokio::spawn(async move {
        while let Some(chunk) = stdin_rx.recv().await {
            if write_half.write_all(&chunk).await.is_err() || write_half.flush().await.is_err() {
                break;
            }
        }
        write_half.shutdown().await.ok();
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
    stdin_pump.abort();
    Ok(())
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
