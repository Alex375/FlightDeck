//! Daemon configuration: identity on the relay + which phones are authorized.
//!
//! Lives at `~/.flightdeckd/config.json` (overridable with `--config`). Written by
//! the Mac during "add a server" provisioning (M1.2); hand-written for the M1.0
//! container proof. JSON, not TOML: the Mac-side provisioner already speaks JSON
//! and the file is machine-managed, not human-tuned.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    /// Relay origin, e.g. "https://relay-production-8fd4.up.railway.app".
    pub relay_url: String,
    /// This node's identity on the relay (the daemon presents itself as a "mac").
    pub mac_id: String,
    pub mac_token: String,
    /// Phone secrets to (re-)authorize on every relay connect.
    #[serde(default)]
    pub phone_tokens: Vec<PhoneToken>,
    /// Tombstones of removed phone secrets, re-revoked on every relay connect:
    /// the relay PERSISTS authorizations, so a revoke sent while offline (or
    /// lost with a dying link) would otherwise never land. Capped, newest last.
    #[serde(default)]
    pub revoked_phone_tokens: Vec<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Create `dir` (and any missing parent) owner-only (0700). An EXISTING
/// directory is left as is — see [`harden_state_dir`] for the daemon's own.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

/// The state dir holds the relay secret, the attach socket (full control of
/// every session) and the registry: owner-only. Created 0700; an existing one
/// that is wider (an older daemon, a hand-made dir) is narrowed, with a warning.
pub fn harden_state_dir(dir: &Path) -> Result<()> {
    create_private_dir(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let mode = std::fs::metadata(dir)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        tracing::warn!("{} was mode {mode:o} — narrowing it to 700", dir.display());
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("cannot chmod 700 {}", dir.display()))?;
    }
    Ok(())
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

/// How many phone-token tombstones the config keeps (the oldest go first).
/// Small on purpose: every one is re-sent on each relay connect, and the relay
/// silently drops a node's frames beyond a 60-frame burst.
pub const MAX_REVOKED_PHONE_TOKENS: usize = 16;

/// How many phones a node authorizes at most. Every one is re-authorized on
/// each relay connect (paced, but the relay's budget is finite) — a hard cap
/// with an explicit error beats frames silently dropped by the relay.
pub const MAX_PHONE_TOKENS: usize = 32;

/// Refuse a NEW phone once MAX_PHONE_TOKENS are authorized (relabeling an
/// authorized one is always fine).
pub fn check_phone_capacity(tokens: &[PhoneToken], token: &str) -> Result<()> {
    if tokens.len() >= MAX_PHONE_TOKENS && !tokens.iter().any(|p| p.token == token) {
        bail!("too many authorized phones (max {MAX_PHONE_TOKENS}) — remove one first");
    }
    Ok(())
}

/// How long a writer waits for the config lock before giving up.
pub const CONFIG_LOCK_WAIT: Duration = Duration::from_secs(10);

/// The sidecar lock file of a config: `config.json` → `config.json.lock`.
pub fn lock_path(config_path: &Path) -> PathBuf {
    let mut name = config_path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".lock");
    config_path.with_file_name(name)
}

/// Cross-process advisory lock serializing every WRITER of the config file.
///
/// `~/.flightdeckd/config.json` is written by several PROCESSES — the running
/// daemon (phone-token add/remove) and `flightdeckd init` (which the Mac's
/// installer also runs remotely over SSH) — so an in-process mutex cannot
/// serialize them. Every writer holds an exclusive `flock(2)` on the sidecar
/// `<config>.lock` (`~/.flightdeckd/config.json.lock`) across its WHOLE
/// read-modify-write. The config itself is always replaced atomically
/// (tmp + rename), so readers need no lock and never see a torn file.
///
/// The `flightdeckd` CLI takes this lock itself (`init` included): shelling out
/// to it needs nothing more. Anything else that edits the file directly must
/// take the SAME lock, e.g. `flock ~/.flightdeckd/config.json.lock -c '…'`
/// (util-linux `flock(1)` is `flock(2)` — compatible). The lock is released
/// when the guard drops (its file descriptor closes), including on a crash.
pub struct ConfigLock {
    config_path: PathBuf,
    _file: File,
}

impl ConfigLock {
    pub fn acquire(config_path: &Path) -> Result<Self> {
        Self::acquire_within(config_path, CONFIG_LOCK_WAIT)
    }

    pub fn acquire_within(config_path: &Path, wait: Duration) -> Result<Self> {
        let path = lock_path(config_path);
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            create_private_dir(dir)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&path)
            .with_context(|| format!("cannot open the config lock {}", path.display()))?;
        let deadline = Instant::now() + wait;
        loop {
            // SAFETY: a plain syscall on a descriptor we own.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { config_path: config_path.to_path_buf(), _file: file });
            }
            let err = std::io::Error::last_os_error();
            if err.kind() != std::io::ErrorKind::WouldBlock && err.kind() != std::io::ErrorKind::Interrupted {
                return Err(err).with_context(|| format!("cannot lock {}", path.display()));
            }
            if Instant::now() >= deadline {
                bail!(
                    "{} is locked by another flightdeckd process (waited {wait:?})",
                    config_path.display()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read config {}", path.display()))?;
        serde_json::from_str(&raw).with_context(|| format!("invalid config {}", path.display()))
    }

    /// Atomically write the config (tmp + fsync + rename, mode 0600 — it holds
    /// the relay secret) under the cross-process [`ConfigLock`].
    pub fn save(&self, path: &Path) -> Result<()> {
        let lock = ConfigLock::acquire(path)?;
        self.save_locked(path, &lock)
    }

    /// [`Config::save`] for a writer that already holds the lock across its
    /// read-modify-write.
    pub fn save_locked(&self, path: &Path, lock: &ConfigLock) -> Result<()> {
        if lock.config_path != path {
            bail!("config lock is for {}, not {}", lock.config_path.display(), path.display());
        }
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        write_atomic(path, &bytes)
    }

    /// Read-modify-write under the lock: `f` edits the CURRENT on-disk config
    /// (so a concurrent writer's changes are never clobbered by a stale copy);
    /// it is saved only if it changed. Returns the result and `f`'s value.
    pub fn update<T>(path: &Path, f: impl FnOnce(&mut Config) -> T) -> Result<(Config, T)> {
        let lock = ConfigLock::acquire(path)?;
        let mut cfg = Config::load(path)?;
        let before = cfg.clone();
        let out = f(&mut cfg);
        if cfg != before {
            cfg.save_locked(path, &lock)?;
        }
        Ok((cfg, out))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    create_private_dir(dir)?;
    let name = path.file_name().context("config path has no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp.{}", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("cannot write config {}", path.display()));
    }
    // Make the rename itself durable.
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Authorize `token` (or relabel it). Clears its tombstone. Returns true when it
/// was not authorized yet.
pub fn upsert_phone_token(tokens: &mut Vec<PhoneToken>, revoked: &mut Vec<String>, token: &str, label: &str) -> bool {
    revoked.retain(|t| t != token);
    match tokens.iter_mut().find(|p| p.token == token) {
        Some(p) => {
            p.label = label.to_string();
            false
        }
        None => {
            tokens.push(PhoneToken { token: token.to_string(), label: label.to_string() });
            true
        }
    }
}

/// De-authorize `token` and tombstone it (capped, newest last). Returns true
/// when it was authorized; an unknown token changes nothing.
pub fn remove_phone_token(tokens: &mut Vec<PhoneToken>, revoked: &mut Vec<String>, token: &str) -> bool {
    let before = tokens.len();
    tokens.retain(|p| p.token != token);
    if tokens.len() == before {
        return false;
    }
    revoked.retain(|t| t != token);
    revoked.push(token.to_string());
    let excess = revoked.len().saturating_sub(MAX_REVOKED_PHONE_TOKENS);
    revoked.drain(..excess);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::test_cfg;

    fn sample() -> Config {
        let mut c = test_cfg();
        c.phone_tokens = vec![
            PhoneToken { token: "pt-1".into(), label: "iPhone".into() },
            PhoneToken { token: "pt-2".into(), label: String::new() },
        ];
        c.revoked_phone_tokens = vec!["old".into()];
        c.default_workdir = Some("/work".into());
        c
    }

    #[test]
    fn save_round_trips_through_load_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a.json"), dir.path().join("b.json"));
        let cfg = sample();
        cfg.save(&a).unwrap();
        let loaded = Config::load(&a).unwrap();
        assert_eq!(loaded, cfg);
        assert_eq!(loaded.phone_tokens, cfg.phone_tokens);
        loaded.save(&b).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
    }

    #[test]
    fn save_is_private_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        sample().save(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let mut names: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec!["config.json", "config.json.lock"]);
    }

    #[test]
    fn older_configs_without_tombstones_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"relay_url":"r","mac_id":"m","mac_token":"t"}"#).unwrap();
        let c = Config::load(&path).unwrap();
        assert!(c.phone_tokens.is_empty() && c.revoked_phone_tokens.is_empty());
    }

    #[test]
    fn state_dirs_are_created_private_and_widened_ones_are_narrowed() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let fresh = root.path().join("a/b/.flightdeckd");
        harden_state_dir(&fresh).unwrap();
        assert_eq!(mode(&fresh), 0o700);
        assert_eq!(mode(&root.path().join("a")), 0o700, "missing parents are created private too");
        let wide = root.path().join("wide");
        std::fs::create_dir(&wide).unwrap();
        std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o755)).unwrap();
        harden_state_dir(&wide).unwrap();
        assert_eq!(mode(&wide), 0o700);
        // a config saved into a missing dir creates it private as well
        let nested = root.path().join("new/config.json");
        test_cfg().save(&nested).unwrap();
        assert_eq!(mode(&root.path().join("new")), 0o700);
    }

    #[test]
    fn the_lock_excludes_a_second_holder_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let held = ConfigLock::acquire(&path).unwrap();
        // A second open file description conflicts even in the same process —
        // exactly like another process would.
        let err = ConfigLock::acquire_within(&path, Duration::from_millis(100)).err().expect("must not lock twice");
        assert!(err.to_string().contains("locked by another flightdeckd process"), "{err}");
        drop(held);
        ConfigLock::acquire_within(&path, Duration::from_millis(100)).unwrap();
    }

    #[test]
    fn racing_writers_never_tear_the_file_nor_lose_an_update() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        test_cfg().save(&path).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (path, stop) = (path.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut reads = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    Config::load(&path).expect("a reader saw a torn config");
                    reads += 1;
                }
                reads
            })
        };
        let writers: Vec<_> = (0..4)
            .map(|w| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        Config::update(&path, |c| {
                            upsert_phone_token(&mut c.phone_tokens, &mut c.revoked_phone_tokens, &format!("w{w}-{i}"), "")
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0);
        let tokens = Config::load(&path).unwrap().phone_tokens;
        assert_eq!(tokens.len(), 100, "a read-modify-write lost another writer's update");
    }

    #[test]
    fn phone_token_edits_dedupe_relabel_and_tombstone() {
        let (mut tokens, mut revoked) = (Vec::new(), Vec::new());
        assert!(upsert_phone_token(&mut tokens, &mut revoked, "a", "one"));
        assert!(!upsert_phone_token(&mut tokens, &mut revoked, "a", "two"));
        assert_eq!(tokens, vec![PhoneToken { token: "a".into(), label: "two".into() }]);
        assert!(!remove_phone_token(&mut tokens, &mut revoked, "nope"));
        assert!(revoked.is_empty());
        assert!(remove_phone_token(&mut tokens, &mut revoked, "a"));
        assert!(tokens.is_empty());
        assert_eq!(revoked, vec!["a".to_string()]);
        // re-adding clears the tombstone
        assert!(upsert_phone_token(&mut tokens, &mut revoked, "a", ""));
        assert!(revoked.is_empty());
        // the tombstone list is capped, oldest first out
        for i in 0..MAX_REVOKED_PHONE_TOKENS + 3 {
            upsert_phone_token(&mut tokens, &mut revoked, &format!("t{i}"), "");
            remove_phone_token(&mut tokens, &mut revoked, &format!("t{i}"));
        }
        assert_eq!(revoked.len(), MAX_REVOKED_PHONE_TOKENS);
        assert_eq!(revoked.last().unwrap(), &format!("t{}", MAX_REVOKED_PHONE_TOKENS + 2));
        assert_eq!(revoked.first().unwrap(), "t3");
    }
}
