//! The attach plane: a Unix socket the `flightdeckd attach` subcommand (run
//! over SSH by the Mac) bridges to its stdio. First line in is the attach
//! request; after that the connection is a transparent line pipe:
//! client → claude stdin, claude stdout (replay + live) → client.

use crate::session::{SessionManager, SessionMsg};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
struct FirstLine {
    attach: Option<AttachParams>,
    status: Option<serde_json::Value>,
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
        let (conn, _) = listener.accept().await?;
        let manager = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(manager, conn).await {
                warn!("attach connection ended with error: {e:#}");
            }
        });
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
        let line = json!({"type": "fd_status", "label": manager.cfg.label, "conversations": out});
        write_half.write_all(format!("{line}\n").as_bytes()).await.ok();
        return Ok(());
    }

    let Some(p) = parsed.attach else {
        let msg = json!({"type": "fd_detach", "reason": "error", "message": "missing attach or status"});
        write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
        return Ok(());
    };

    let (lines_tx, mut lines_rx) = mpsc::unbounded_channel::<String>();
    let attached = manager
        .attach(p.conversation, p.cwd, p.resume_session, p.claude_args, p.epoch, p.cursor, lines_tx)
        .await;
    let (conv_id, client_id) = match attached {
        Ok(x) => x,
        Err(e) => {
            let msg = json!({"type": "fd_detach", "reason": "error", "message": e.to_string()});
            write_half.write_all(format!("{msg}\n").as_bytes()).await.ok();
            return Ok(());
        }
    };

    // daemon → client
    let writer = tokio::spawn(async move {
        while let Some(line) = lines_rx.recv().await {
            if write_half.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
            if write_half.flush().await.is_err() {
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
// The client side (`flightdeckd attach` / `flightdeckd status`), run over SSH.

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

pub async fn status_client(socket: &Path) -> Result<String> {
    let conn = UnixStream::connect(socket).await.with_context(|| {
        format!("flightdeckd is not running (no socket at {})", socket.display())
    })?;
    let (read_half, mut write_half) = conn.into_split();
    write_half.write_all(b"{\"status\":{}}\n").await?;
    write_half.flush().await?;
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    Ok(line.trim().to_string())
}
