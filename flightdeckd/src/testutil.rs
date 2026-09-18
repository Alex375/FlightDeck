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

/// A manager over an in-memory registry.
pub fn test_manager(cfg: Config) -> Arc<SessionManager> {
    SessionManager::new(cfg, Registry::open_in_memory().expect("registry"))
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
