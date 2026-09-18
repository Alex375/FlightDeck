//! Shared test fixtures (compiled for `cargo test` only).

use crate::config::Config;
use crate::registry::Registry;
use crate::session::SessionManager;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn test_cfg() -> Config {
    Config {
        relay_url: "http://localhost:1".into(),
        mac_id: "m".into(),
        mac_token: "t".into(),
        phone_tokens: vec![],
        revoked_phone_tokens: vec![],
        label: "test".into(),
        default_workdir: None,
        claude_bin: "claude".into(),
        permission_mode: "bypassPermissions".into(),
    }
}

/// A temp dir with a SHORT path: Unix socket paths are capped at ~104 bytes on
/// macOS, and the default `$TMPDIR` there is already long.
pub fn short_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").expect("tempdir")
}

/// A manager over an in-memory registry. Its config path is unwritable: tests
/// that persist phone tokens build their own manager over a temp config.
pub fn test_manager(cfg: Config) -> Arc<SessionManager> {
    SessionManager::new(
        cfg,
        Registry::open_in_memory().expect("registry"),
        PathBuf::from("/dev/null/flightdeckd-test/config.json"),
    )
}

/// A manager whose config is persisted at `dir/config.json` (phone-token
/// changes land there).
pub fn manager_with_config(dir: &Path, cfg: Config) -> Arc<SessionManager> {
    let path = dir.join("config.json");
    cfg.save(&path).expect("save test config");
    SessionManager::new(cfg, Registry::open_in_memory().expect("registry"), path)
}

/// Serve the attach plane on `dir/fd.sock` and wait until it accepts.
pub async fn serve_attach(manager: Arc<SessionManager>, dir: &Path) -> PathBuf {
    let socket = dir.join("fd.sock");
    let s = socket.clone();
    tokio::spawn(async move { crate::attach::serve(manager, &s).await });
    for _ in 0..200 {
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return socket;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("attach socket never came up at {}", socket.display());
}

/// An executable stand-in for claude: announces `session_id` in an init
/// frame, then holds stdin open (a live session) until EOF.
pub fn fake_claude(dir: &Path, session_id: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-claude");
    let script = format!(
        "#!/bin/sh\necho '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session_id}\"}}'\ncat >/dev/null\n"
    );
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

/// Wait until a conversation's live actor reports `session_id`.
pub async fn wait_for_session_id(m: &Arc<SessionManager>, conv_id: &str, session_id: &str) {
    for _ in 0..300 {
        if let Some(st) = m.status(conv_id).await {
            if st.session_id.as_deref() == Some(session_id) {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{conv_id} never reported session {session_id}");
}

/// Builders for claude stream-json lines with partial messages, in the order
/// observed from real claude (see `replay.rs`).
pub mod stream {
    use serde_json::json;

    pub fn se(parent: Option<&str>, event: serde_json::Value) -> String {
        json!({"type": "stream_event", "event": event, "parent_tool_use_id": parent, "session_id": "s"}).to_string()
    }
    pub fn start(parent: Option<&str>, id: &str) -> String {
        se(parent, json!({"type": "message_start", "message": {"id": id, "role": "assistant", "content": []}}))
    }
    pub fn delta(parent: Option<&str>, text: &str) -> String {
        se(parent, json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}))
    }
    pub fn ev(parent: Option<&str>, kind: &str) -> String {
        se(parent, json!({"type": kind, "index": 0}))
    }
    pub fn assistant(parent: Option<&str>, id: &str, text: &str) -> String {
        json!({"type": "assistant", "parent_tool_use_id": parent, "session_id": "s",
               "message": {"id": id, "role": "assistant", "content": [{"type": "text", "text": text}]}})
        .to_string()
    }
    pub fn other(kind: &str) -> String {
        json!({"type": kind}).to_string()
    }

    /// One complete message in the observed claude order.
    pub fn message(parent: Option<&str>, id: &str) -> Vec<String> {
        vec![
            start(parent, id),
            ev(parent, "content_block_start"),
            delta(parent, "Hel"),
            delta(parent, "lo"),
            assistant(parent, id, "Hello"),
            ev(parent, "content_block_stop"),
            ev(parent, "message_delta"),
            ev(parent, "message_stop"),
        ]
    }

    /// A realistic turn: init, the user echo, a streamed message, a tool
    /// result, a second streamed message, the result.
    pub fn turn() -> Vec<String> {
        let mut t = vec![other("system"), other("user")];
        t.extend(message(None, "msg_1"));
        t.push(other("user")); // tool result
        t.extend(message(None, "msg_2"));
        t.push(other("result"));
        t
    }
}

/// A stand-in claude that waits for its first stdin line (the first turn),
/// then prints `lines` and holds stdin open.
pub fn fake_claude_emitting(dir: &Path, lines: &[String]) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let data = dir.join("turn.jsonl");
    std::fs::write(&data, lines.join("\n") + "\n").expect("write turn");
    let path = dir.join("fake-claude-turn");
    let script = format!("#!/bin/sh\nread _first\ncat '{}'\ncat >/dev/null\n", data.display());
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}
