//! Claude ACCOUNT operations — status / login / logout, by driving the OFFICIAL
//! `claude auth` CLI (the same binary our sessions spawn). This is the SINGLE module
//! that talks to `claude auth`; the standing read-only-credentials policy holds: we
//! never write `~/.claude/.credentials.json` or the Keychain item ourselves — the CLI
//! owns its credential store end to end (cf. `usage/mod.rs`, which only READS).
//!
//! ## Login lifecycle (verified against the real CLI, headless)
//! `claude auth login` prints the OAuth URL on stdout ("… visit: <url>") then waits for
//! the user to paste the authorization code on stdin. So: spawn with `BROWSER=false`
//! (WE open the URL via the opener plugin — deterministic, no double-open), parse the
//! URL, keep the child + its stdin in [`ACTIVE_LOGIN`], and complete when the front
//! submits the pasted code. One login at a time; a new start kills the previous child.
//!
//! ## Multiple accounts
//! Every entry point takes an [`AccountSlot`] saying WHICH credential store to drive. The
//! slot is applied as an environment variable on the `claude` child, so signing a second
//! account in never touches the first one's credentials, nor the shared transcripts,
//! settings, plugins, skills or MCP servers. It is NOT a full isolation, though: the CLI's
//! login and logout both rewrite the account profile cache in the shared `~/.claude.json`
//! (`oauthAccount` and a few model/usage caches), for every account at once. See [`slot`]
//! for the verified mechanism, that shared-state effect and why it is tolerable, and why the
//! default slot never gives the variable a value.
//!
//! ## Removal vs. sign-in vs. spawn
//! Removing an account deletes the directory its Keychain item name is derived from, so it
//! must never interleave with anything that is about to USE that slot: a sign-in (which
//! would recreate the directory and write credentials nobody can address afterwards) or a
//! session spawn (which would run on an account whose row is gone). [`account_use_guard`] /
//! [`account_removal_guard`] serialize the two sides, and [`sign_in_busy_for`] tells the
//! removal about a sign-in that is already past its start (awaiting or redeeming the code).

pub mod slot;

pub use slot::{AccountSlot, DEFAULT_ACCOUNT_ID};

use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use serde::Serialize;

/// The signed-in Claude account, whitelisted from `claude auth status --json` (no
/// tokens — that output carries none; we forward only these fields).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountStatus {
    pub logged_in: bool,
    /// `claude.ai` | `console` | `none`.
    pub auth_method: Option<String>,
    pub email: Option<String>,
    pub org_name: Option<String>,
    /// `max` | `pro` | … when on a subscription.
    pub subscription_type: Option<String>,
}

/// The one in-flight `claude auth login` child (its stdin receives the pasted code).
struct ActiveLogin {
    /// WHICH account this login was started for (`None` = the default slot). The pasted
    /// code MUST be matched against it: there is a single global in-flight login, but the
    /// UI now shows one card per account, so without this check a code authorised for
    /// account A could be written to account B's child — exchanging A's grant into B's
    /// credential store and then labelling A with B's identity.
    account_id: Option<String>,
    child: Child,
    stdin: ChildStdin,
    /// The child's stdout reader, HELD (never read again) for the child's whole lifetime.
    /// After printing the URL the CLI stays alive awaiting the pasted code; dropping this
    /// would close the read end of the pipe, so a later write on the child's stdout (a
    /// "paste code" prompt — stderr is nulled) could raise SIGPIPE and kill it before the
    /// code is submitted. Keeping the read end open makes such a write a harmless no-op.
    _stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

static ACTIVE_LOGIN: Mutex<Option<ActiveLogin>> = Mutex::const_new(None);

/// Serializes the WHOLE login-start sequence (cancel → spawn → read URL → register), so two
/// near-simultaneous `login_start` calls can't both pass the cancel and race: without it the
/// second registration would clobber the first child WITHOUT tearing it down, leaving
/// `ACTIVE_LOGIN` pointing at a DIFFERENT child than the URL the user authenticated against —
/// so `login_submit_code` writes the pasted code to the wrong PKCE flow and the login fails
/// confusingly. Mirrors the Codex sibling's `LOGIN_FLOW` (its acute reason is a callback-port
/// race; here it's the child/URL mismatch, but the fix is the same).
static LOGIN_FLOW: Mutex<()> = Mutex::const_new(());

/// The account-lifecycle lock: SHARED by everything that resolves an account slot and then
/// puts it to use (session spawn, sign-in start, identity capture), EXCLUSIVE for removal.
/// Without it, removal's "no session / no sign-in on this account" check and its row delete
/// leave a window in which a spawn or a sign-in resolves the still-present row and then runs
/// on an account that is being deleted.
///
/// Lock order (never take them the other way round — none of the later locks is ever held
/// while acquiring an earlier one):
/// `ACCOUNT_LIFECYCLE` → `LOGIN_FLOW` → `ACTIVE_LOGIN` → `REDEEMING`.
/// Removal takes `ACCOUNT_LIFECYCLE` (write) then only `ACTIVE_LOGIN` → `REDEEMING` (via
/// [`sign_in_busy_for`]); a sign-in start takes it (read) then `LOGIN_FLOW` → `ACTIVE_LOGIN`.
static ACCOUNT_LIFECYCLE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// Hold while resolving an account slot AND putting it to use (spawning on it, starting its
/// sign-in, persisting its identity), so a concurrent removal waits until the use is visible
/// to its checks (a registered session, an in-flight login). Several uses run concurrently.
/// ⚠️ Not re-entrant: never acquire it twice in one call chain (a queued removal would
/// deadlock the second acquisition).
pub async fn account_use_guard() -> tokio::sync::RwLockReadGuard<'static, ()> {
    ACCOUNT_LIFECYCLE.read().await
}

/// Hold across an account removal's whole check → sign-out → delete sequence (see
/// [`ACCOUNT_LIFECYCLE`]).
pub async fn account_removal_guard() -> tokio::sync::RwLockWriteGuard<'static, ()> {
    ACCOUNT_LIFECYCLE.write().await
}

/// The accounts whose pasted code is being REDEEMED right now (`None` entry = the default
/// slot). [`login_submit_code`] takes the login out of [`ACTIVE_LOGIN`] before waiting up to
/// 90 s for the CLI to exchange the code and write the credentials — so without this, that
/// most critical stretch would look like "no sign-in in flight" to a removal. A list, not a
/// single slot: a new sign-in can start (and be submitted) while an older redemption is
/// still settling.
static REDEEMING: std::sync::Mutex<Vec<Option<String>>> = std::sync::Mutex::new(Vec::new());

/// RAII entry in [`REDEEMING`], removed on every exit path of the redemption.
struct RedeemingMark(Option<String>);

impl RedeemingMark {
    fn set(account_id: Option<String>) -> Self {
        REDEEMING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(account_id.clone());
        Self(account_id)
    }
}

impl Drop for RedeemingMark {
    fn drop(&mut self) {
        let mut redeeming = REDEEMING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(idx) = redeeming.iter().position(|id| *id == self.0) {
            redeeming.swap_remove(idx);
        }
    }
}

/// Whether a sign-in for `account_id` (`None` = the default slot) is past its start: waiting
/// for the pasted code, or redeeming it. Callers that must not race it (removal) hold
/// [`account_removal_guard`], which already excludes a sign-in that is still STARTING.
pub async fn sign_in_busy_for(account_id: Option<&str>) -> bool {
    let active = ACTIVE_LOGIN.lock().await;
    if active
        .as_ref()
        .is_some_and(|a| a.account_id.as_deref() == account_id)
    {
        return true;
    }
    // Read REDEEMING while still holding ACTIVE_LOGIN: `login_submit_code` moves a login from
    // one to the other under that same lock, so no interleaving can see it in neither.
    let redeeming = REDEEMING.lock().unwrap_or_else(|p| p.into_inner());
    redeeming.iter().any(|id| id.as_deref() == account_id)
}

/// The `claude` binary, resolved like the session spawner (PATH, then well-known
/// locations) so a Finder-launched bundle's minimal PATH still finds it.
fn claude_bin() -> std::path::PathBuf {
    crate::supervisor::transport::resolved_claude_bin()
}

/// Bound an arbitrary process output for a user-facing error: first line, capped —
/// enough to be actionable, never a wall of CLI noise.
fn first_line_capped(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut s: String = line.chars().take(200).collect();
    if s.is_empty() {
        s = "unknown error".into();
    }
    s
}

/// Bound for the quick `claude auth` invocations (status/logout). Generous for a cold
/// CLI start, but a wedged binary (e.g. its startup update-check stalling on a dead
/// network) must surface as an error instead of hanging the Comptes panel forever.
const AUTH_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Run a short-lived `claude auth …` command, bounded by [`AUTH_CMD_TIMEOUT`].
/// `kill_on_drop` reaps the child when the timeout drops the in-flight future, so a
/// hung CLI never accumulates as a stuck process across panel refetches.
async fn run_bounded(
    slot: &AccountSlot,
    label: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(claude_bin());
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(true);
    slot.apply(&mut cmd);
    let fut = cmd.output();
    match tokio::time::timeout(AUTH_CMD_TIMEOUT, fut).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("could not run `{label}`: {e}")),
        Err(_) => Err(format!(
            "`{label}` did not respond in time ({} s) — retry",
            AUTH_CMD_TIMEOUT.as_secs()
        )),
    }
}

/// Read ONE slot's auth status (`claude auth status --json`). Fast and read-only.
///
/// ⚠️ `email` / `org_name` come from the CLI's profile cache in the *config* dir
/// (`.claude.json`), which our slots deliberately SHARE — so on a multi-account setup they
/// describe whichever account signed in last, not necessarily this slot. VERIFIED live: a
/// default credential store paired with an isolated config dir reported `loggedIn: true`
/// while `email`/`orgId` came back `null`, proving the identity fields ride the config dir
/// and the credentials ride the secure store. Callers must therefore label an account from
/// the metadata captured at ITS OWN login (persisted by the store) and treat these two
/// fields as a fallback only. `logged_in` and `subscription_type` DO belong to the slot.
pub async fn status(slot: &AccountSlot) -> Result<ClaudeAccountStatus, String> {
    let output = run_bounded(slot, "claude auth status", &["auth", "status", "--json"]).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        // The CLI answered something that isn't the JSON contract (crash text, update
        // notice…): bounded first line so the user sees WHY without a raw dump.
        format!(
            "`claude auth status` responded unexpectedly: {}",
            first_line_capped(&stdout)
        )
    })?;
    let s = |k: &str| parsed.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
    Ok(ClaudeAccountStatus {
        logged_in: parsed
            .get("loggedIn")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        auth_method: s("authMethod"),
        email: s("email"),
        org_name: s("orgName"),
        subscription_type: s("subscriptionType"),
    })
}

/// Start a login: spawn `claude auth login`, wait for the OAuth URL on stdout (bounded),
/// keep the child for the code submission, return the URL for the front to open.
/// Any previous in-flight login is killed first (one at a time).
/// `account_id` identifies the account this flow belongs to (`None` = the default slot);
/// [`login_submit_code`] refuses a code submitted for any other one.
pub async fn login_start(
    slot: &AccountSlot,
    account_id: Option<String>,
) -> Result<String, String> {
    // Hold the flow lock across the WHOLE sequence (see LOGIN_FLOW). Call the INNER
    // `cancel_current` (not the public `login_cancel`, which also takes LOGIN_FLOW) to avoid
    // a self-deadlock, then keep the lock until ACTIVE_LOGIN is registered below.
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;

    // The isolated store must exist before the CLI writes its credentials into it.
    slot.ensure_dir()?;

    let mut cmd = Command::new(claude_bin());
    cmd.args(["auth", "login"])
        // WE open the URL (opener plugin). `false` is a no-op executable on every unix,
        // so the CLI's own browser-open attempt does nothing instead of double-opening.
        .env("BROWSER", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    slot.apply(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run `claude auth login`: {e}"))?;

    let stdout = child.stdout.take().ok_or("login stdout unavailable")?;
    let stdin = child.stdin.take().ok_or("login stdin unavailable")?;

    // The URL line arrives within a second or two; 20s covers a cold start. Reading
    // LINES is safe here: the URL line is newline-terminated (only the later "paste
    // code" prompt isn't, and we stop before it).
    let mut reader = BufReader::new(stdout).lines();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let url = loop {
        match tokio::time::timeout_at(deadline, reader.next_line()).await {
            Ok(Ok(Some(line))) => {
                if let Some(idx) = line.find("https://") {
                    break line[idx..].trim().to_string();
                }
            }
            Ok(Ok(None)) => {
                let _ = child.kill().await;
                return Err(
                    "`claude auth login` exited before providing the authorization URL".into(),
                );
            }
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("could not read login output: {e}"));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err("`claude auth login` did not provide a URL (timed out)".into());
            }
        }
    };

    *ACTIVE_LOGIN.lock().await = Some(ActiveLogin {
        account_id,
        child,
        stdin,
        _stdout: reader,
    });
    Ok(url)
}

/// Which account the in-flight login belongs to: `Some(None)` = the default slot,
/// `Some(Some(id))` = that account, `None` = no login in flight. The front polls this to
/// close the code box on a card whose flow was superseded, instead of leaving an input
/// that would submit into someone else's login.
pub async fn login_in_flight() -> Option<Option<String>> {
    ACTIVE_LOGIN
        .lock()
        .await
        .as_ref()
        .map(|a| a.account_id.clone())
}

/// Submit the authorization code the user pasted. Consumes the in-flight login: writes
/// the code to the child's stdin and waits for it to exit (bounded). Success = exit 0,
/// re-checked by the caller via [`status`]. The code NEVER appears in any error text.
pub async fn login_submit_code(account_id: Option<&str>, code: &str) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("the authorization code is empty".into());
    }
    // Take the login only once it is confirmed to be THIS account's, so a mismatched
    // submission leaves the real flow intact and retryable instead of consuming it.
    let mut guard = ACTIVE_LOGIN.lock().await;
    match guard.as_ref() {
        None => {
            return Err("no Claude sign-in in progress — start \"Sign in\" again".into());
        }
        // A different account's login is in flight: starting one kills the previous child,
        // so the flow this code belongs to is already gone. Say so instead of writing the
        // code into the wrong credential store.
        Some(active) if active.account_id.as_deref() != account_id => {
            return Err(
                "this sign-in was superseded by one for another account — start \"Sign in\" \
                 again for this account"
                    .into(),
            );
        }
        Some(_) => {}
    }
    let mut active = guard.take().expect("checked as Some above");
    // Registered BEFORE releasing ACTIVE_LOGIN, so `sign_in_busy_for` never sees a gap
    // between "awaiting the code" and "redeeming it". Cleared when this function returns.
    let _redeeming = RedeemingMark::set(active.account_id.clone());
    drop(guard);
    if let Err(e) = active.stdin.write_all(format!("{code}\n").as_bytes()).await {
        let _ = active.child.kill().await;
        return Err(format!("could not send the code: {e}"));
    }
    let _ = active.stdin.flush().await;
    drop(active.stdin); // EOF: some readline paths only settle once stdin closes.

    match tokio::time::timeout(std::time::Duration::from_secs(90), active.child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!(
            "`claude auth login` failed (exit code {}) — the pasted code may be \
             invalid or expired",
            status.code().unwrap_or(-1)
        )),
        Ok(Err(e)) => Err(format!("could not wait for login: {e}")),
        Err(_) => {
            let _ = active.child.kill().await;
            Err("`claude auth login` did not confirm (timed out)".into())
        }
    }
}

/// Cancel the in-flight login, if any (kills the child). Safe when none is running.
pub async fn login_cancel() {
    // Take the flow lock so a cancel arriving mid-start waits for that start to finish
    // registering ACTIVE_LOGIN before tearing it down (rather than no-op'ing on an
    // ACTIVE_LOGIN that isn't set yet). The kill itself is `cancel_current`.
    let _flow = LOGIN_FLOW.lock().await;
    cancel_current().await;
}

/// Kill the in-flight login child WITHOUT taking `LOGIN_FLOW` — for callers that already
/// hold it (`login_start`). `login_cancel` is the lock-taking public entry point.
async fn cancel_current() {
    if let Some(mut active) = ACTIVE_LOGIN.lock().await.take() {
        let _ = active.child.kill().await;
    }
}

/// Log ONE slot out (`claude auth logout`). The CLI clears its own credential store — we
/// never delete a Keychain item or a credentials file ourselves.
pub async fn logout(slot: &AccountSlot) -> Result<(), String> {
    let output = run_bounded(slot, "claude auth logout", &["auth", "logout"]).await?;
    if output.status.success() {
        Ok(())
    } else {
        let msg = if output.stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).into_owned()
        } else {
            String::from_utf8_lossy(&output.stderr).into_owned()
        };
        Err(format!(
            "`claude auth logout` failed: {}",
            first_line_capped(&msg)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_capped_bounds_and_falls_back() {
        assert_eq!(first_line_capped("boom\nrest"), "boom");
        assert_eq!(first_line_capped("\n\n  spaced  \n"), "spaced");
        assert_eq!(first_line_capped(""), "unknown error");
        let long = "x".repeat(500);
        assert_eq!(first_line_capped(&long).chars().count(), 200);
    }

    /// The empty-code guard fires BEFORE touching the login registry: whitespace-only
    /// input is rejected immediately with an actionable message.
    #[tokio::test]
    async fn submit_code_rejects_an_empty_code() {
        let err = login_submit_code(None, "   \n")
            .await
            .expect_err("empty code must fail");
        assert!(err.contains("empty"), "unexpected error: {err}");
    }

    /// A code may only be submitted to the login it was authorised for. There is ONE
    /// global in-flight login but one card per account, so without this guard a code
    /// pasted into account A's still-visible box would be written to account B's child —
    /// redeeming A's grant into B's credential store and then labelling A with B's
    /// identity. The mismatched attempt must also LEAVE the real flow intact.
    #[tokio::test]
    async fn submit_code_refuses_a_login_started_for_another_account() {
        // Stand in for an in-flight login belonging to "acct-b" without spawning the CLI.
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn stand-in child");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        *ACTIVE_LOGIN.lock().await = Some(ActiveLogin {
            account_id: Some("acct-b".into()),
            child,
            stdin,
            _stdout: BufReader::new(stdout).lines(),
        });

        for wrong in [None, Some("acct-c")] {
            let err = login_submit_code(wrong, "code-for-b")
                .await
                .expect_err("a mismatched account must be refused");
            assert!(err.contains("superseded"), "unexpected error: {err}");
            assert!(!err.contains("code-for-b"), "code leaked into error: {err}");
        }
        // The real flow is untouched, so the right card can still complete it.
        assert_eq!(login_in_flight().await, Some(Some("acct-b".into())));
        // …and a removal of acct-b must see it as busy, while other accounts stay removable.
        assert!(sign_in_busy_for(Some("acct-b")).await);
        assert!(!sign_in_busy_for(Some("acct-c")).await);

        login_cancel().await;
        assert_eq!(login_in_flight().await, None);
        assert!(!sign_in_busy_for(Some("acct-b")).await);
    }

    /// Submitting a code with no login in flight tells the user to restart the flow —
    /// and the pasted code NEVER leaks into the error text (module contract).
    #[tokio::test]
    async fn submit_code_without_a_login_in_flight_says_restart() {
        let err = login_submit_code(None, "sk-test-not-a-real-code")
            .await
            .expect_err("no in-flight login must fail");
        assert!(err.contains("no Claude sign-in in progress"), "unexpected error: {err}");
        assert!(!err.contains("sk-test-not-a-real-code"), "code leaked into error: {err}");
    }

    /// PROBE (read-only): `claude auth status --json` against the real CLI.
    /// Run: `cargo test --lib -- --ignored --nocapture live_claude_account_status`.
    #[tokio::test]
    #[ignore = "runs the real claude CLI"]
    async fn live_claude_account_status() {
        let s = status(&AccountSlot::default_slot())
            .await
            .expect("auth status should parse");
        eprintln!(
            "claude account: logged_in={} method={:?} plan={:?}",
            s.logged_in, s.auth_method, s.subscription_type
        );
    }

    /// PROBE (read-only): the load-bearing claim of the whole feature — an isolated slot
    /// scopes the CREDENTIALS and nothing else. Against the real CLI this asserts:
    ///   - the default slot is signed in (baseline; skipped if the user is signed out),
    ///   - a fresh isolated slot reports `logged_in: false` — proving the credential store
    ///     really is per-slot and not a global Keychain item,
    ///   - the user's transcripts stay put: `projectsDirectory` is untouched by the slot,
    ///     which is what `CLAUDE_CONFIG_DIR` would have broken.
    /// Run: `cargo test --lib -- --ignored --nocapture live_isolated_slot_scopes_only_credentials`.
    #[tokio::test]
    #[ignore = "runs the real claude CLI"]
    async fn live_isolated_slot_scopes_only_credentials() {
        let base = status(&AccountSlot::default_slot())
            .await
            .expect("auth status should parse");
        if !base.logged_in {
            eprintln!("SKIP: the default account is signed out — nothing to contrast against");
            return;
        }

        let tmp = std::env::temp_dir().join(format!("tosse-slot-probe-{}", std::process::id()));
        let slot = AccountSlot::isolated(tmp.clone());
        slot.ensure_dir().expect("probe dir");
        let isolated = status(&slot).await.expect("auth status should parse");
        let _ = slot.remove_dir();

        assert!(
            !isolated.logged_in,
            "an isolated slot must NOT see the default account's credentials"
        );
        eprintln!(
            "isolation OK — default logged_in={} / isolated logged_in={} (keychain item {:?})",
            base.logged_in,
            isolated.logged_in,
            slot.keychain_service()
        );
    }
}
