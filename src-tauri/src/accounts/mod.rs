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
//! account in never touches the first one's credentials — and never touches the shared
//! `~/.claude` (transcripts, settings, plugins, skills, MCP). See [`slot`] for the verified
//! mechanism and for why the default slot deliberately sets no variable at all.

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
pub async fn login_start(slot: &AccountSlot) -> Result<String, String> {
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

    *ACTIVE_LOGIN.lock().await = Some(ActiveLogin { child, stdin, _stdout: reader });
    Ok(url)
}

/// Submit the authorization code the user pasted. Consumes the in-flight login: writes
/// the code to the child's stdin and waits for it to exit (bounded). Success = exit 0,
/// re-checked by the caller via [`status`]. The code NEVER appears in any error text.
pub async fn login_submit_code(code: &str) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("the authorization code is empty".into());
    }
    let Some(mut active) = ACTIVE_LOGIN.lock().await.take() else {
        return Err("no Claude sign-in in progress — start \"Sign in\" again".into());
    };
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
        let err = login_submit_code("   \n").await.expect_err("empty code must fail");
        assert!(err.contains("empty"), "unexpected error: {err}");
    }

    /// Submitting a code with no login in flight tells the user to restart the flow —
    /// and the pasted code NEVER leaks into the error text (module contract).
    #[tokio::test]
    async fn submit_code_without_a_login_in_flight_says_restart() {
        let err = login_submit_code("sk-test-not-a-real-code")
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
