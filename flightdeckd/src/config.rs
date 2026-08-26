//! Daemon configuration: identity on the relay + which phones are authorized.
//!
//! Lives at `~/.flightdeckd/config.json` (overridable with `--config`). Written by
//! the Mac during "add a server" provisioning (M1.2); hand-written for the M1.0
//! container proof. JSON, not TOML: the Mac-side provisioner already speaks JSON
//! and the file is machine-managed, not human-tuned.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Relay origin, e.g. "https://relay-production-8fd4.up.railway.app".
    pub relay_url: String,
    /// This node's identity on the relay (the daemon presents itself as a "mac").
    pub mac_id: String,
    pub mac_token: String,
    /// Phone secrets to (re-)authorize on every relay connect.
    #[serde(default)]
    pub phone_tokens: Vec<PhoneToken>,
    /// Human-readable node label (shown by clients).
    #[serde(default = "default_label")]
    pub label: String,
    /// Where claude sessions run from by default when a phone creates a
    /// conversation with a relative repo_path.
    #[serde(default)]
    pub default_workdir: Option<String>,
    /// The claude binary (default: "claude" from PATH).
    #[serde(default = "default_claude_bin")]
    pub claude_bin: String,
    /// Permission mode passed to claude sessions the daemon spawns.
    /// The container/server runs headless: there is no UI to answer permission
    /// prompts yet (M1 limitation, documented), so default to bypassPermissions.
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoneToken {
    pub token: String,
    #[serde(default)]
    pub label: String,
}

fn default_label() -> String {
    "flightdeckd".into()
}
fn default_claude_bin() -> String {
    "claude".into()
}
fn default_permission_mode() -> String {
    "bypassPermissions".into()
}

pub fn state_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".flightdeckd")
}

pub fn default_config_path() -> PathBuf {
    state_dir().join("config.json")
}

/// The Unix socket `flightdeckd attach` (invoked over SSH) connects to.
pub fn socket_path() -> PathBuf {
    state_dir().join("flightdeckd.sock")
}

pub fn registry_path() -> PathBuf {
    state_dir().join("registry.sqlite")
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        serde_json::from_str(&raw).with_context(|| format!("invalid config {}", path.display()))
    }
}
