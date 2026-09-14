//! WHICH Claude credential store a `claude` invocation uses — the isolation primitive
//! behind multi-account support.
//!
//! ## The mechanism (VERIFIED live against claude 2.1.263)
//! The CLI has TWO independent scoping axes, and picking the right one is the whole
//! design:
//!
//! | env                                    | `loggedIn` | `projectsDirectory` |
//! |----------------------------------------|------------|---------------------|
//! | *(none)*                               | true       | `~/.claude/projects`|
//! | `CLAUDE_CONFIG_DIR=<isolated>`         | **false**  | `<isolated>/projects` |
//! | `CLAUDE_SECURESTORAGE_CONFIG_DIR=<iso>`| **false**  | `~/.claude/projects` |
//! | `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`   | true       | `~/.claude/projects`|
//!
//! `CLAUDE_CONFIG_DIR` would isolate EVERYTHING — transcripts, `settings.json`, plugins,
//! skills, MCP servers, history. Switching accounts would then fragment the user's
//! conversations, which is exactly what this feature must not do. So we scope ONLY the
//! credential store, with `CLAUDE_SECURESTORAGE_CONFIG_DIR`: the account changes, every
//! other piece of `~/.claude` stays shared, and resume / fork / rewind are untouched.
//!
//! ## Where the credentials land (read from the CLI bundle, clean-room)
//! ```js
//! var $5 = "-credentials";
//! function A_(){ let n = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
//!                if (n !== void 0) return (n || join(homedir(), ".claude")).normalize("NFC");
//!                return configDir(); }
//! function Sx(n=""){ let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
//!                        t = e !== void 0 ? !e : !process.env.CLAUDE_CONFIG_DIR,
//!                        r = e !== void 0 ? e.normalize("NFC") : configDir(),
//!                        c = t ? "" : `-${sha256(r).hex.substring(0,8)}`;
//!                    return `Claude Code${OAUTH_FILE_SUFFIX}${n}${c}`; }
//! // and the keychain store calls it as: Sx($5)
//! ```
//! ⚠️ The call site is what fixes the ORDER, and it is easy to get backwards: `$5` is
//! passed as `n`, which lands BEFORE the hash. With `OAUTH_FILE_SUFFIX` empty (the prod
//! config), an isolated slot's service is therefore
//! `Claude Code-credentials-<sha256(dir)[0..8]>` — NOT `Claude Code-<sha8>-credentials`.
//! The default slot (`c` empty) collapses to plain `Claude Code-credentials` either way,
//! which is exactly why an inverted derivation looks fine on a single-account machine and
//! only breaks the accounts the feature exists for. The file fallback is
//! `<dir>/.credentials.json`, and on macOS the CLI DELETES it once the Keychain write
//! succeeds — so for an isolated account the Keychain item is the only copy, and getting
//! this name wrong means its usage can never be read at all.
//!
//! [`AccountSlot::keychain_service`] mirrors that derivation so `usage/` can read a
//! NON-ACTIVE account's token — the only way to show every account's rate limits from one
//! app.
//!
//! ## Why the default slot passes NO variable
//! An empty string is NOT equivalent to "unset": per `t` above, `""` forces the
//! *no-suffix* item even when `CLAUDE_CONFIG_DIR` is set, whereas leaving it unset lets
//! the config dir keep deriving the name. A user who already scopes their CLI with
//! `CLAUDE_CONFIG_DIR` must keep the exact credentials they have today, so the default
//! slot sets nothing at all — the single-account setup is bit-for-bit unchanged.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

/// Id of the slot that uses the CLI's own, un-scoped credential store: the account the
/// user was already signed into before this feature existed. Never a directory.
pub const DEFAULT_ACCOUNT_ID: &str = "default";

/// The env var scoping ONLY the credential store (see the module docs).
const SECURESTORAGE_ENV: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/// Directory holding one isolated credential store per account, under the app data dir.
const ACCOUNTS_DIRNAME: &str = "claude-accounts";

/// The Keychain service name of the CLI's own, un-scoped credential store — and the PREFIX
/// every isolated slot's item extends with `-<sha8>` (the hash is a suffix, see the module
/// docs). Kept as one constant so the two cannot drift apart.
const KEYCHAIN_BASE: &str = "Claude Code-credentials";

/// Which credential store to drive a `claude` invocation against. `dir: None` is the
/// default slot (no env var at all); `Some(dir)` isolates via [`SECURESTORAGE_ENV`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSlot {
    dir: Option<PathBuf>,
}

impl AccountSlot {
    /// The pre-existing, un-scoped credential store.
    pub fn default_slot() -> Self {
        Self { dir: None }
    }

    /// An isolated store rooted at `dir`.
    pub fn isolated(dir: PathBuf) -> Self {
        Self { dir: Some(dir) }
    }

    /// The slot for `account_id` under `data_dir` (the app data dir). The reserved
    /// [`DEFAULT_ACCOUNT_ID`] maps to the default slot; anything else gets its own
    /// directory. `account_id` is app-minted (a uuid), so it needs no sanitising beyond
    /// the guard below, which refuses a path-traversing id rather than escaping the root.
    pub fn for_account(data_dir: &Path, account_id: &str) -> Result<Self, String> {
        if account_id == DEFAULT_ACCOUNT_ID {
            return Ok(Self::default_slot());
        }
        if account_id.is_empty()
            || account_id.contains('/')
            || account_id.contains('\\')
            || account_id.contains("..")
        {
            return Err(format!("invalid Claude account id: {account_id:?}"));
        }
        Ok(Self::isolated(
            data_dir.join(ACCOUNTS_DIRNAME).join(account_id),
        ))
    }

    /// The isolated directory, or `None` for the default slot.
    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// True for the CLI's own, un-scoped store.
    pub fn is_default(&self) -> bool {
        self.dir.is_none()
    }

    /// Create the slot's directory when it is isolated. The CLI writes its credential
    /// file there on platforms without a Keychain, and (on macOS) the path only has to
    /// EXIST for the hash-derived Keychain item to be stable across launches.
    pub fn ensure_dir(&self) -> Result<(), String> {
        let Some(dir) = &self.dir else { return Ok(()) };
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create the account directory {}: {e}", dir.display()))
    }

    /// Remove the slot's directory (isolated slots only). Best-effort: an absent
    /// directory is success. The Keychain item is NOT touched here — `claude auth logout`
    /// owns that, and it is run first by the caller (the CLI stays the sole writer of its
    /// own credential store).
    pub fn remove_dir(&self) -> Result<(), String> {
        let Some(dir) = &self.dir else {
            return Err("the default Claude account has no directory to remove".into());
        };
        match std::fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "could not remove the account directory {}: {e}",
                dir.display()
            )),
        }
    }

    /// The path the CLI would read/write its credentials FILE at for this slot.
    /// On macOS the Keychain is the real store and this file is normally absent, but it
    /// is still consulted first (and it is the only store off macOS).
    pub fn credentials_file(&self) -> Option<PathBuf> {
        match &self.dir {
            Some(dir) => Some(dir.join(".credentials.json")),
            // Default slot: `~/.claude/.credentials.json`, as today.
            None => std::env::var_os("HOME")
                .map(|home| Path::new(&home).join(".claude").join(".credentials.json")),
        }
    }

    /// The macOS Keychain service name holding this slot's credentials, derived exactly
    /// like the CLI does (module docs). Reading it is what lets us fetch the plan usage of
    /// an account that has no live session.
    pub fn keychain_service(&self) -> String {
        match &self.dir {
            None => KEYCHAIN_BASE.to_string(),
            Some(dir) => {
                // The hash goes LAST: the CLI calls `Sx("-credentials")`, so `-credentials`
                // is inserted before the directory suffix. See the module docs.
                let suffix = dir_hash_suffix(&dir.to_string_lossy());
                format!("{KEYCHAIN_BASE}-{suffix}")
            }
        }
    }

    /// Apply this slot to a `claude` invocation. The default slot deliberately sets
    /// NOTHING (see the module docs) — that is what keeps a single-account setup, and a
    /// user who scopes their CLI with `CLAUDE_CONFIG_DIR`, working exactly as before.
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        if let Some(dir) = &self.dir {
            cmd.env(SECURESTORAGE_ENV, dir);
        }
    }

    /// Same as [`Self::apply`] for the blocking `std` command type used by the spawner.
    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        if let Some(dir) = &self.dir {
            cmd.env(SECURESTORAGE_ENV, dir);
        }
    }

    /// The `(key, value)` this slot contributes to a child environment, or `None` for the
    /// default slot. For spawners that build their env as a map rather than on a Command.
    pub fn env_pair(&self) -> Option<(&'static str, String)> {
        self.dir
            .as_ref()
            .map(|dir| (SECURESTORAGE_ENV, dir.to_string_lossy().into_owned()))
    }
}

/// `sha256(NFC(path))` truncated to the first 8 hex characters — the CLI's own suffix.
/// NFC matters: a home directory carrying an accent can reach us decomposed (NFD) from the
/// macOS filesystem APIs, and hashing that would derive a service name the CLI never wrote.
fn dir_hash_suffix(path: &str) -> String {
    let normalized: String = path.nfc().collect();
    let digest = ring::digest::digest(&ring::digest::SHA256, normalized.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .chars()
        .take(8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default slot contributes NO environment: a single-account setup — and a user
    /// who scopes the CLI with `CLAUDE_CONFIG_DIR` — must be bit-for-bit unchanged. An
    /// empty string would NOT do (it forces the no-suffix item); only "unset" is correct.
    #[test]
    fn the_default_slot_sets_no_environment() {
        let slot = AccountSlot::default_slot();
        assert!(slot.is_default());
        assert_eq!(slot.env_pair(), None);
        assert_eq!(slot.keychain_service(), "Claude Code-credentials");
    }

    /// An isolated slot scopes ONLY the credential store, never the config dir (which
    /// would fragment transcripts/settings/plugins).
    #[test]
    fn an_isolated_slot_scopes_only_the_credential_store() {
        let slot = AccountSlot::isolated(PathBuf::from("/tmp/acc/abc"));
        let (key, value) = slot.env_pair().expect("isolated slot must carry an env pair");
        assert_eq!(key, "CLAUDE_SECURESTORAGE_CONFIG_DIR");
        assert_eq!(value, "/tmp/acc/abc");
    }

    /// The Keychain service mirrors the CLI's derivation, HASH LAST:
    /// `Claude Code-credentials-<sha8>`.
    ///
    /// ⚠️ This assertion is pinned to a LITERAL expected value, deliberately. The previous
    /// version of this test only checked the shape the code itself produced ("starts with
    /// `Claude Code-`, ends with `-credentials`, 8 hex in the middle"), so it happily passed
    /// while the two segments were in the wrong ORDER — a bug that is invisible on a
    /// single-account machine (where the suffix is empty) and makes every added account's
    /// usage unreadable. A test that can only ever agree with the implementation is not a
    /// test; the literal below, and `live_keychain_item_name_matches_the_cli`, are.
    ///
    /// The digest is `sha256("/tmp/acc/abc")[0..8]`, verifiable independently:
    /// `printf '/tmp/acc/abc' | shasum -a 256 | cut -c1-8` → `8ebb034c`.
    #[test]
    fn keychain_service_mirrors_the_cli_derivation() {
        assert_eq!(
            AccountSlot::isolated(PathBuf::from("/tmp/acc/abc")).keychain_service(),
            "Claude Code-credentials-8ebb034c",
        );
        // The default slot is the CLI's own item, with no suffix at all.
        assert_eq!(
            AccountSlot::default_slot().keychain_service(),
            "Claude Code-credentials",
        );
        // Same path → same item (stable across launches); different path → different item.
        assert_ne!(
            AccountSlot::isolated(PathBuf::from("/tmp/acc/abc")).keychain_service(),
            AccountSlot::isolated(PathBuf::from("/tmp/acc/def")).keychain_service(),
        );
    }

    /// PROBE (read-only): assert our derivation against the CLI'S OWN, rather than against
    /// ourselves. Spawns `claude auth status` under an isolated slot with `security`
    /// SHIMMED on PATH, and captures the `-s <service>` the CLI actually queries with.
    ///
    /// This is the test that would have caught the inverted order: it compares
    /// `keychain_service()` to a string produced by the binary, not by us.
    /// Run: `cargo test --lib -- --ignored --nocapture live_keychain_item_name_matches_the_cli`.
    #[tokio::test]
    #[ignore = "runs the real claude CLI"]
    async fn live_keychain_item_name_matches_the_cli() {
        use std::io::Write;

        let root = std::env::temp_dir().join(format!("tosse-kc-probe-{}", std::process::id()));
        let bin_dir = root.join("bin");
        let slot_dir = root.join("slot");
        std::fs::create_dir_all(&bin_dir).expect("probe bin dir");
        std::fs::create_dir_all(&slot_dir).expect("probe slot dir");
        let log = root.join("service.log");

        // A `security` shim that records the service name it was asked for, then reports
        // "item not found" (exit 44) so the CLI proceeds exactly as with a fresh slot.
        let shim = bin_dir.join("security");
        {
            let mut f = std::fs::File::create(&shim).expect("write shim");
            writeln!(
                f,
                "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"-s\" ]; then echo \"$2\" >> '{}'; fi\n  shift\ndone\nexit 44",
                log.display()
            )
            .expect("write shim");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))
                .expect("chmod shim");
        }

        let slot = AccountSlot::isolated(slot_dir.clone());
        let path = format!(
            "{}:{}",
            bin_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut cmd = tokio::process::Command::new(
            crate::supervisor::transport::resolved_claude_bin(),
        );
        cmd.args(["auth", "status", "--json"])
            .env("PATH", path)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        slot.apply(&mut cmd);
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;

        let asked = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&root);

        let expected = slot.keychain_service();
        eprintln!("CLI queried: {asked:?}\nwe derive:   {expected:?}");
        assert!(
            asked.lines().any(|l| l.trim() == expected),
            "the CLI queried a Keychain service we do not derive.\n  CLI asked for: {asked:?}\n  we derive:     {expected:?}"
        );
    }

    /// NFC normalisation is applied, so a decomposed path (as macOS filesystem APIs can
    /// hand it back) hashes to the SAME item the CLI wrote from the composed form.
    #[test]
    fn the_hash_normalises_to_nfc() {
        let composed = AccountSlot::isolated(PathBuf::from("/Users/josé/acc")).keychain_service();
        let decomposed =
            AccountSlot::isolated(PathBuf::from("/Users/jose\u{0301}/acc")).keychain_service();
        assert_eq!(composed, decomposed);
    }

    /// The reserved id maps to the default slot; a traversing id is refused rather than
    /// silently escaping the accounts root.
    #[test]
    fn for_account_maps_the_reserved_id_and_refuses_traversal() {
        let root = Path::new("/data");
        assert!(AccountSlot::for_account(root, DEFAULT_ACCOUNT_ID)
            .unwrap()
            .is_default());
        assert_eq!(
            AccountSlot::for_account(root, "abc").unwrap().dir(),
            Some(Path::new("/data/claude-accounts/abc"))
        );
        for bad in ["", "../escape", "a/b", "a\\b"] {
            assert!(
                AccountSlot::for_account(root, bad).is_err(),
                "id {bad:?} must be refused"
            );
        }
    }

    /// The credentials file follows the slot: inside the isolated directory, or the
    /// CLI's own `~/.claude/.credentials.json` for the default slot.
    #[test]
    fn credentials_file_follows_the_slot() {
        assert_eq!(
            AccountSlot::isolated(PathBuf::from("/tmp/acc/abc")).credentials_file(),
            Some(PathBuf::from("/tmp/acc/abc/.credentials.json"))
        );
        if let Some(path) = AccountSlot::default_slot().credentials_file() {
            assert!(path.ends_with(".claude/.credentials.json"), "{path:?}");
        }
    }
}
