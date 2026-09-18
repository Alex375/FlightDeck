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
