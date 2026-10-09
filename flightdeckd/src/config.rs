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
    /// lost with a dying link) would otherwise never land. Newest last; see
    /// [`MAX_REVOKED_PHONE_TOKENS`] for which ones are ever evicted.
    #[serde(default)]
    pub revoked_phone_tokens: Vec<String>,
    /// The tombstones the relay CONFIRMED it processed (a subset of
    /// `revoked_phone_tokens`, see `relay::RevokeAcks`). Absent from older
    /// configs — and dropped by an older daemon that rewrites the file — which
    /// reads as "none confirmed": the safe side, everything is re-sent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivered_phone_revocations: Vec<String>,
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
    /// Whether [`PhoneToken::init_minted`] is authoritative for every token of
    /// this config: set by `init` from 0.3.0 on (which flags the one token it
    /// mints, if any), and on an older config by the first
    /// `remove-phone --init-minted` that settles it. `false` — a config an
    /// older binary wrote, or rewrote after a downgrade (it drops both fields) —
    /// leaves [`init_minted_phone_token`] to its legacy rule.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub init_phone_tracked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneToken {
    pub token: String,
    #[serde(default)]
    pub label: String,
    /// Minted by plain `init` (0.3.0 on), and not claimed since by a client
    /// through `add-phone`. Meaningful only when the config's
    /// [`Config::init_phone_tracked`] is set.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub init_minted: bool,
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

/// A secret-bearing file (the config holds `mac_token`) must be owner-only.
/// Saves always write 0600, but a file left wider by an older daemon, a
/// hand edit or an installer is narrowed here — with a warning. A missing
/// file is not an error.
pub fn harden_private_file(path: &Path) -> Result<()> {
    let mode = match std::fs::metadata(path) {
        Ok(m) => m.permissions().mode() & 0o777,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("cannot stat {}", path.display())),
    };
    if mode & 0o077 != 0 {
        tracing::warn!("{} was mode {mode:o} — narrowing it to 600 (it holds the relay secret)", path.display());
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("cannot chmod 600 {}", path.display()))?;
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

/// How many phone-token tombstones the config keeps. Only CONFIRMED ones
/// (`delivered_phone_revocations`) are ever evicted, oldest first: a
/// revocation the relay has not confirmed is kept — past this cap if need be —
/// and re-sent on every connect until it is. Every kept tombstone goes out on
/// each connect (the confirmed ones after the authorizations, in the same
/// paced burst), so a relay that lost recent state re-learns them too.
pub const MAX_REVOKED_PHONE_TOKENS: usize = 128;

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
    // Make the rename itself durable. The new file is in place either way, so
    // a failure here does not fail the save — but it must not go unnoticed.
    if let Err(e) = File::open(dir).and_then(|d| d.sync_all()) {
        tracing::warn!(
            "config {} written, but syncing its directory failed ({e}) — the change may not survive a crash",
            path.display()
        );
    }
    Ok(())
}

/// Authorize `token` (or relabel it). Clears its tombstone. Returns true when it
/// was not authorized yet. A token a client authorizes this way is that
/// client's, even the one `init` minted: it is no longer
/// [`PhoneToken::init_minted`].
pub fn upsert_phone_token(
    tokens: &mut Vec<PhoneToken>,
    revoked: &mut Vec<String>,
    delivered: &mut Vec<String>,
    token: &str,
    label: &str,
) -> bool {
    revoked.retain(|t| t != token);
    delivered.retain(|t| t != token);
    match tokens.iter_mut().find(|p| p.token == token) {
        Some(p) => {
            p.label = label.to_string();
            p.init_minted = false;
            false
        }
        None => {
            tokens.push(PhoneToken { token: token.to_string(), label: label.to_string(), init_minted: false });
            true
        }
    }
}

/// De-authorize `token` and tombstone it, newest last and not delivered yet.
/// Returns true when it was authorized; an unknown token changes nothing.
pub fn remove_phone_token(
    tokens: &mut Vec<PhoneToken>,
    revoked: &mut Vec<String>,
    delivered: &mut Vec<String>,
    token: &str,
) -> bool {
    let before = tokens.len();
    tokens.retain(|p| p.token != token);
    if tokens.len() == before {
        return false;
    }
    revoked.retain(|t| t != token);
    delivered.retain(|t| t != token);
    revoked.push(token.to_string());
    evict_delivered_tombstones(revoked, delivered);
    true
}

/// The label plain `flightdeckd init` gives the phone token it mints.
pub const INIT_PHONE_LABEL: &str = "phone";

/// The phone token plain `init` minted, if it is still authorized as minted —
/// never `keep` (the caller's own token).
///
/// `tracked` ([`Config::init_phone_tracked`]): the token flagged
/// [`PhoneToken::init_minted`], wherever it sits. A config `init` 0.3.0 wrote
/// with `--no-phone-token` has none, so no token any Mac added is ever taken
/// for it, whatever its label.
///
/// Not tracked (a config an older binary wrote, which records no provenance):
/// plain `init` wrote exactly ONE token, labelled [`INIT_PHONE_LABEL`], as the
/// only entry of a fresh config (`init --force` replaces the whole config), and
/// the token list is append-only from then on: `add-phone` appends a new token
/// or relabels one in place, `remove-phone` keeps the order of the rest. So an
/// init-minted token that is still authorized under its original label is the
/// FIRST entry. Requiring both — first AND labelled exactly "phone" — keeps a
/// token any client added later through `add-phone` out of reach, even one
/// whose label happens to be "phone" (a Mac's node label is user-editable): it
/// is never first while the init token is still there. One someone relabeled
/// through `add-phone` is theirs now and is kept too. The first cleanup then
/// settles the config ([`settle_init_phone_tracking`]), so the legacy rule
/// applies at most once per config: the case it cannot tell apart — the init
/// token removed by hand earlier, and a Mac labelled "phone" first since — needs
/// both before that first cleanup.
pub fn init_minted_phone_token(tokens: &[PhoneToken], tracked: bool, keep: &str) -> Option<String> {
    let candidate = if tracked {
        tokens.iter().find(|p| p.init_minted && p.token != keep)
    } else {
        tokens.first().filter(|p| p.label == INIT_PHONE_LABEL && p.token != keep)
    };
    candidate.map(|p| p.token.clone())
}

/// After an init-minted cleanup that `keep` asked for: provenance is known from
/// now on — any init token is gone (or is `keep`'s, which this call adopts: it
/// is the caller's own) — so the legacy rule of [`init_minted_phone_token`]
/// never runs again on this config.
pub fn settle_init_phone_tracking(cfg: &mut Config, keep: &str) {
    cfg.init_phone_tracked = true;
    for p in cfg.phone_tokens.iter_mut().filter(|p| p.token == keep) {
        p.init_minted = false;
    }
}

/// Record that the relay confirmed the revocation of `confirmed`. Only tokens
/// still tombstoned count (one re-authorized meanwhile is ignored). Returns
/// true when anything changed.
pub fn mark_revocations_delivered(revoked: &mut Vec<String>, delivered: &mut Vec<String>, confirmed: &[String]) -> bool {
    let mut changed = false;
    for t in confirmed {
        if revoked.contains(t) && !delivered.contains(t) {
            delivered.push(t.clone());
            changed = true;
        }
    }
    if changed {
        evict_delivered_tombstones(revoked, delivered);
    }
    changed
}

/// Bring the tombstones down to [`MAX_REVOKED_PHONE_TOKENS`] by dropping the
/// oldest DELIVERED ones. An undelivered one is never dropped: with only those
/// left, the list stays over the cap.
fn evict_delivered_tombstones(revoked: &mut Vec<String>, delivered: &mut Vec<String>) {
    delivered.retain(|t| revoked.contains(t));
    while revoked.len() > MAX_REVOKED_PHONE_TOKENS {
        let Some(i) = revoked.iter().position(|t| delivered.contains(t)) else { break };
        let gone = revoked.remove(i);
        delivered.retain(|t| *t != gone);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::test_cfg;

    fn sample() -> Config {
        let mut c = test_cfg();
        c.phone_tokens = vec![
            PhoneToken { token: "pt-1".into(), label: "iPhone".into(), init_minted: false },
            PhoneToken { token: "pt-2".into(), label: String::new(), init_minted: false },
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
    fn a_config_left_wider_is_narrowed_to_600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        harden_private_file(&path).unwrap(); // missing: fine
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o664)).unwrap();
        harden_private_file(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}", "only the mode changes");
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
                            upsert_phone_token(
                                &mut c.phone_tokens,
                                &mut c.revoked_phone_tokens,
                                &mut c.delivered_phone_revocations,
                                &format!("w{w}-{i}"),
                                "",
                            )
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
        let (mut tokens, mut revoked, mut delivered) = (Vec::new(), Vec::new(), Vec::new());
        assert!(upsert_phone_token(&mut tokens, &mut revoked, &mut delivered, "a", "one"));
        assert!(!upsert_phone_token(&mut tokens, &mut revoked, &mut delivered, "a", "two"));
        assert_eq!(tokens, vec![PhoneToken { token: "a".into(), label: "two".into(), init_minted: false }]);
        assert!(!remove_phone_token(&mut tokens, &mut revoked, &mut delivered, "nope"));
        assert!(revoked.is_empty());
        assert!(remove_phone_token(&mut tokens, &mut revoked, &mut delivered, "a"));
        assert!(tokens.is_empty());
        assert_eq!(revoked, vec!["a".to_string()]);
        assert!(delivered.is_empty(), "a fresh tombstone is not delivered yet");
        // re-adding clears the tombstone, delivered or not
        assert!(mark_revocations_delivered(&mut revoked, &mut delivered, &["a".into()]));
        assert!(upsert_phone_token(&mut tokens, &mut revoked, &mut delivered, "a", ""));
        assert!(revoked.is_empty() && delivered.is_empty());
        // removed again: a NEW revocation, undelivered until confirmed again
        assert!(remove_phone_token(&mut tokens, &mut revoked, &mut delivered, "a"));
        assert_eq!((revoked.len(), delivered.len()), (1, 0));
    }

    fn phone(token: &str, label: &str) -> PhoneToken {
        PhoneToken { token: token.into(), label: label.into(), init_minted: false }
    }

    fn minted(token: &str) -> PhoneToken {
        PhoneToken { token: token.into(), label: INIT_PHONE_LABEL.into(), init_minted: true }
    }

    #[test]
    fn the_init_minted_token_is_the_first_one_still_labelled_phone() {
        // A config an older binary wrote: no provenance, the legacy rule.
        let legacy = false;
        let init_then_macs = vec![phone("init", "phone"), phone("mac-a", "This Mac"), phone("mac-b", "phone")];
        assert_eq!(init_minted_phone_token(&init_then_macs, legacy, "mac-a"), Some("init".into()));
        // The caller's own token is never selected, even when it is first and
        // labelled "phone".
        assert_eq!(init_minted_phone_token(&init_then_macs, legacy, "init"), None);
        // A token some client added later with the label "phone" is never
        // first while the init token is there — and not first means not init's.
        let no_init = vec![phone("mac-a", "This Mac"), phone("mac-b", "phone")];
        assert_eq!(init_minted_phone_token(&no_init, legacy, "mac-a"), None);
        // Exactly "phone": relabeled, re-cased or padded is someone else's now.
        for label in ["Phone", "phone ", "", "my phone"] {
            let tokens = [phone("init", label), phone("mac-a", "x")];
            assert_eq!(init_minted_phone_token(&tokens, legacy, "mac-a"), None, "{label:?}");
        }
        assert_eq!(init_minted_phone_token(&[], legacy, "mac-a"), None);
    }

    #[test]
    fn a_tracked_config_goes_by_the_flag_never_by_label_or_place() {
        let tracked = true;
        // `init --no-phone-token` (0.3.0): the first token is a Mac's, labelled
        // "phone" — never taken for init's.
        let macs_only = vec![phone("mac-a", "phone"), phone("mac-b", "Laptop")];
        assert_eq!(init_minted_phone_token(&macs_only, tracked, "mac-b"), None);
        // Plain `init` (0.3.0): the flagged token, wherever it sits.
        let flagged = vec![phone("mac-a", "phone"), minted("init"), phone("mac-b", "Laptop")];
        assert_eq!(init_minted_phone_token(&flagged, tracked, "mac-b"), Some("init".into()));
        assert_eq!(init_minted_phone_token(&flagged, tracked, "init"), None, "never the caller's own");
        // The flag is all that counts once tracked — not the legacy label.
        assert_eq!(init_minted_phone_token(&[phone("init", "phone")], tracked, "x"), None);
    }

    #[test]
    fn add_phone_claims_the_init_token_and_a_cleanup_settles_provenance() {
        let (mut tokens, mut revoked, mut delivered) = (vec![minted("init")], Vec::new(), Vec::new());
        assert!(!upsert_phone_token(&mut tokens, &mut revoked, &mut delivered, "init", "phone"));
        assert!(!tokens[0].init_minted, "authorized through add-phone: someone's now");

        // A legacy config settled by a cleanup that `mine` asked for: tracked,
        // and the caller's own token adopted, so no later call ever takes it.
        let mut cfg = crate::testutil::test_cfg();
        cfg.phone_tokens = vec![minted("mine"), phone("other", "phone")];
        settle_init_phone_tracking(&mut cfg, "mine");
        assert!(cfg.init_phone_tracked);
        assert_eq!(cfg.phone_tokens, vec![phone("mine", "phone"), phone("other", "phone")]);
        assert_eq!(init_minted_phone_token(&cfg.phone_tokens, cfg.init_phone_tracked, "other"), None);
    }

    #[test]
    fn provenance_fields_are_absent_from_an_older_config_and_only_written_when_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // What 0.2.0 wrote: neither field.
        std::fs::write(
            &path,
            r#"{"relay_url":"r","mac_id":"m","mac_token":"t","phone_tokens":[{"token":"a","label":"phone"}]}"#,
        )
        .unwrap();
        let old = Config::load(&path).unwrap();
        assert!(!old.init_phone_tracked && !old.phone_tokens[0].init_minted);
        // Unset flags are not written: such a config still reads the same to 0.2.0.
        old.save(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("init_phone_tracked") && !raw.contains("init_minted"), "{raw}");

        let mut cfg = crate::testutil::test_cfg();
        cfg.phone_tokens = vec![minted("init")];
        cfg.init_phone_tracked = true;
        cfg.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), cfg);
    }

    /// Remove `n` phones `t{from}..` (each authorized first).
    fn tombstone(revoked: &mut Vec<String>, delivered: &mut Vec<String>, from: usize, n: usize) {
        let mut tokens = Vec::new();
        for i in from..from + n {
            upsert_phone_token(&mut tokens, revoked, delivered, &format!("t{i}"), "");
            remove_phone_token(&mut tokens, revoked, delivered, &format!("t{i}"));
        }
    }

    #[test]
    fn an_undelivered_revocation_is_never_evicted() {
        let (mut revoked, mut delivered) = (Vec::new(), Vec::new());
        tombstone(&mut revoked, &mut delivered, 0, MAX_REVOKED_PHONE_TOKENS + 3);
        assert_eq!(revoked.len(), MAX_REVOKED_PHONE_TOKENS + 3, "unconfirmed tombstones were dropped at the cap");
        assert_eq!(revoked.first().unwrap(), "t0");

        // Confirming t5 and t9 makes exactly those evictable (oldest first),
        // and the list comes back down only as far as they allow.
        assert!(mark_revocations_delivered(&mut revoked, &mut delivered, &["t9".into(), "t5".into()]));
        assert_eq!(revoked.len(), MAX_REVOKED_PHONE_TOKENS + 1);
        assert!(!revoked.contains(&"t5".to_string()) && !revoked.contains(&"t9".to_string()));
        assert!(delivered.is_empty(), "evicted tombstones leave the delivered set too");
        assert_eq!(revoked.first().unwrap(), "t0", "an undelivered tombstone was evicted");
    }

    #[test]
    fn delivered_tombstones_are_evicted_oldest_first_at_the_cap() {
        let (mut revoked, mut delivered) = (Vec::new(), Vec::new());
        tombstone(&mut revoked, &mut delivered, 0, MAX_REVOKED_PHONE_TOKENS);
        let all = revoked.clone();
        assert!(mark_revocations_delivered(&mut revoked, &mut delivered, &all));
        assert_eq!(revoked.len(), MAX_REVOKED_PHONE_TOKENS, "nothing to evict below the cap");
        tombstone(&mut revoked, &mut delivered, MAX_REVOKED_PHONE_TOKENS, 2);
        assert_eq!(revoked.len(), MAX_REVOKED_PHONE_TOKENS);
        assert_eq!(revoked.first().unwrap(), "t2", "the two oldest delivered ones went first");
        let newest = format!("t{}", MAX_REVOKED_PHONE_TOKENS + 1);
        assert_eq!(revoked.last().unwrap(), &newest);
        assert!(!delivered.contains(&newest), "the new revocations are not delivered yet");
    }

    #[test]
    fn confirmations_only_count_for_tokens_still_tombstoned() {
        let (mut revoked, mut delivered) = (vec!["a".to_string()], Vec::new());
        assert!(!mark_revocations_delivered(&mut revoked, &mut delivered, &["re-added".into()]));
        assert!(delivered.is_empty());
        assert!(mark_revocations_delivered(&mut revoked, &mut delivered, &["a".into()]));
        assert!(!mark_revocations_delivered(&mut revoked, &mut delivered, &["a".into()]), "idempotent");
        assert_eq!(delivered, vec!["a".to_string()]);
    }

    #[test]
    fn the_delivered_set_is_optional_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // Nothing delivered: the file keeps the shape older daemons write.
        let mut cfg = sample();
        cfg.save(&path).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("delivered_phone_revocations"));
        // Once something is, it round-trips.
        cfg.delivered_phone_revocations = vec!["old".into()];
        cfg.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap().delivered_phone_revocations, vec!["old".to_string()]);
    }
}
