//! The attach plane: a Unix socket the `flightdeckd attach` subcommand (run
//! over SSH by the Mac) bridges to its stdio. First line in is the request
//! (`attach`, `status` or `stop`); for `attach` the connection then becomes a
//! transparent line pipe: client → claude stdin, claude stdout (replay + live)
//! → client.

use crate::frames;
use crate::session::{ClientQueue, SessionManager, SessionMsg, ACTOR_REPLY_TIMEOUT};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
struct FirstLine {
    attach: Option<AttachParams>,
    status: Option<serde_json::Value>,
    stop: Option<StopParams>,
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

    let Some(p) = parsed.attach else {
        let msg = json!({"type": "fd_detach", "reason": "error", "message": "missing attach, status or stop"});
        write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
        return Ok(());
    };

    let (queue, mut lines_rx, outstanding) = ClientQueue::new();
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

    // daemon → client. The outstanding counter tracks queued-but-unwritten
    // bytes: the actor refuses to queue past the budget (stalled link) and
    // drops the client instead — it reattaches from its cursor.
    let writer = tokio::spawn(async move {
        while let Some(line) = lines_rx.recv().await {
            let bytes = line.len() as i64 + 1;
            let write = async {
                write_half.write_all(line.as_bytes()).await?;
                write_half.write_all(b"\n").await?;
                write_half.flush().await
            }
            .await;
            outstanding.fetch_sub(bytes, Ordering::Relaxed);
            if write.is_err() {
                break;
            }
        }
        write_half.shutdown().await.ok();
    });

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
    }});
    write_half.write_all(format!("{req}\n").as_bytes()).await?;
    write_half.flush().await?;

    // stdin → socket
    let stdin_pump = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match stdin.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    if write_half.write_all(&buf).await.is_err() || write_half.flush().await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use serde_json::Value;

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
