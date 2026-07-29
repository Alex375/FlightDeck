//! Claude CLI (`claude` binary) UPDATE management — surface the installed version, check
//! the latest published version, run `claude update`, and read/flip the CLI's own
//! background auto-updater.
//!
//! This is the SINGLE module that manages the PILOT binary's updates, and it is DISTINCT
//! from `tauri-plugin-updater` (which updates THIS app, Flight Deck): here we manage the
//! separate `claude` CLI the app drives. Read-mostly — the only mutation, flipping
//! auto-update, is delegated to [`crate::extensions::set_claude_auto_update`], keeping
//! `extensions` the ONE writer of `~/.claude/settings.json` (an app-wide invariant).
//!
//! ## Detection policy
//! "Is a newer version available?" is answered by comparing the installed version
//! (`claude --version`) to the latest PUBLISHED version (the npm registry `latest`
//! dist-tag), NOT by watching `~/.local/share/claude/versions/`: the native auto-updater
//! repoints the `~/.local/bin/claude` symlink to the new build almost immediately after
//! download, so that directory rarely holds a newer-than-active version — the registry
//! states it plainly. The check is BEST-EFFORT: offline / registry error →
//! `latest_version: None`, so no banner and no error (never nag on a flaky network).
//!
//! ## Config policy
//! We never touch credentials. The one config mutation writes only `env.DISABLE_AUTOUPDATER`
//! in `settings.json`, through the atomic writer in `extensions`. Reads navigate the JSON
//! with `Value` pointers so an unexpected field type degrades to a SAFE default
//! (auto-update ON) instead of failing the whole read.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// The npm registry `latest` dist-tag endpoint for the CLI package. A GET returns that
/// version's manifest, whose `version` field is the string we compare against (verified live:
/// `{"name":"@anthropic-ai/claude-code","version":"2.1.220", …}`).
const REGISTRY_LATEST_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

/// Bound for `claude --version`: a fast, read-only call — but a wedged binary (e.g. its own
/// startup update-check stalling on a dead network) must resolve to "unknown", never hang.
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound for `claude update`: it downloads a ~250 MB build, so it needs GENEROUS headroom —
/// sized for a slow-but-working link (low-single-digit Mbps) plus install/startup, not just a
/// fast one. Still bounded so a wedged download can't hang forever. NOTE: `kill_on_drop` aborts
/// the download when this fires, so too tight = a slow link could never finish updating.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(1800);

/// Snapshot for the Settings "Claude CLI" section + the update banner. Every version field is
/// `Option` because each source can be independently unavailable (binary missing →
/// `installed_version: None`; offline → `latest_version: None`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ClaudeCliStatus {
    /// Active binary version (`claude --version`), e.g. `"2.1.220"`. `None` if the binary
    /// can't be found or run.
    pub installed_version: Option<String>,
    /// Latest published version (npm registry `latest` dist-tag). `None` when the check
    /// couldn't run (offline, registry error) — best-effort, never surfaced as an error.
    pub latest_version: Option<String>,
    /// `true` only when BOTH versions are known and latest is strictly newer than installed.
    pub update_available: bool,
    /// Whether the CLI's background auto-updater is on. Two INDEPENDENT gates close it:
    /// `env.DISABLE_AUTOUPDATER` in `settings.json` (the one we own) and `autoUpdates:false`
    /// in `~/.claude.json` (the CLI's own — see [`Self::auto_update_locked`]). Defaults to
    /// `true` — the CLI's own default.
    pub auto_update_enabled: bool,
    /// `true` when auto-update is held OFF by `~/.claude.json` (`autoUpdates:false`, unprotected)
    /// — a gate our toggle CANNOT open, because that file belongs to the CLI and we never write
    /// it (writing it races the binary; see the `extensions` module's read-only policy). Without
    /// this flag the switch would appear to turn on and then silently spring back at the next
    /// read; the panel disables it and says why instead.
    pub auto_update_locked: bool,
    /// How the CLI was installed (`~/.claude.json` `installMethod`: `"native"`, `"npm"`, …).
    /// `None` if unknown. Informational: a native install auto-updates; npm/brew don't — the
    /// UI can hint accordingly.
    pub install_method: Option<String>,
    /// The auto-update release channel (`settings.json` `autoUpdatesChannel`: `"latest"` /
    /// `"stable"`). `None` = the CLI default (`"latest"`).
    pub channel: Option<String>,
    /// Set when a config file EXISTS but couldn't be parsed (corrupt `settings.json` or
    /// `~/.claude.json`), so the panel can warn instead of silently showing a fabricated
    /// default. `None` = configs read cleanly (or were simply absent — the normal case).
    pub config_warning: Option<String>,
}

/// Result of running `claude update`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ClaudeUpdateOutcome {
    /// `true` when the CLI reported it installed a new version; `false` when already current.
    pub updated: bool,
    /// The version updated FROM (only on a successful update).
    pub from: Option<String>,
    /// The resulting version (the new one on update, or the current one when already current).
    pub to: Option<String>,
    /// The CLI's own result line, bounded — shown verbatim so the user sees exactly what it said.
    pub message: String,
}

/// Read the full CLI update status: installed + latest version, update availability, and the
/// auto-update config. BEST-EFFORT throughout — never returns an error, so the Settings panel
/// always has something to render.
///
/// The local probes (binary version + config) run concurrently, but the REGISTRY call is
/// deliberately sequenced AFTER them and SKIPPED when no `claude` is installed: a Codex-only
/// user must not pay an outbound request on every check for a version they could never act on
/// (`update_available` needs both sides anyway, so the answer is unchanged). The trade is one
/// extra round-trip in the installed case — noticeable only on the two paths where a human is
/// waiting (opening Settings, hitting "Check for updates"), and bounded there by the version
/// probe's own timeout; the periodic background check pays nothing that matters.
pub async fn status() -> ClaudeCliStatus {
    let (installed, cfg) = tokio::join!(installed_version(), async {
        tokio::task::spawn_blocking(read_cli_config)
            .await
            .unwrap_or_else(|_| CliConfig::default())
    });
    let latest = if installed.is_some() {
        fetch_latest_version().await
    } else {
        None
    };
    let update_available = match (latest.as_deref(), installed.as_deref()) {
        (Some(l), Some(i)) => is_newer(l, i),
        _ => false,
    };
    ClaudeCliStatus {
        installed_version: installed,
        latest_version: latest,
        update_available,
        auto_update_enabled: cfg.auto_update_enabled,
        auto_update_locked: cfg.auto_update_locked,
        install_method: cfg.install_method,
        channel: cfg.channel,
        config_warning: cfg.config_warning,
    }
}

/// Run `claude update` (check + install in one shot — the CLI has no check-only mode) and
/// report what happened. `Err` ONLY when the process itself couldn't run / timed out / exited
/// non-zero; a clean "already up to date" is `Ok` with `updated: false`.
pub async fn run_update() -> Result<ClaudeUpdateOutcome, String> {
    let out = run_claude(&["update"], UPDATE_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        // On FAILURE the diagnosis is on stderr — and stdout is usually NOT empty (it carried the
        // progress lines up to the point of failure), so preferring stdout here would report
        // "Checking for updates…" as the reason the update failed. Read stderr first, and fall
        // back to stdout only when stderr said nothing at all.
        let reason = if stderr.trim().is_empty() { &stdout } else { &stderr };
        return Err(cap(last_nonempty_line(reason), 200));
    }
    // On SUCCESS the result line is on stdout; fall back to stderr if stdout is empty.
    let combined = if stdout.trim().is_empty() { stderr } else { stdout };
    Ok(parse_update_output(&combined))
}

// ---- version probing --------------------------------------------------------

/// The installed version via `claude --version` ("2.1.220 (Claude Code)"). `None` if the
/// binary can't be found/run or printed nothing version-shaped.
async fn installed_version() -> Option<String> {
    let out = run_claude(&["--version"], VERSION_TIMEOUT).await.ok()?;
    if !out.status.success() {
        return None;
    }
    first_version_in(&String::from_utf8_lossy(&out.stdout))
}

/// Fetch the latest published version from the npm registry. BEST-EFFORT: any failure
/// (offline, TLS, non-2xx, unparseable) → `None`, never surfaced as an error.
async fn fetch_latest_version() -> Option<String> {
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .get(REGISTRY_LATEST_URL)
        .header(reqwest::header::USER_AGENT, "tosse-code")
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    v.get("version").and_then(Value::as_str).map(str::to_string)
}

/// Run a `claude` subcommand, bounded. `kill_on_drop` reaps the child if the timeout drops
/// the future, so a hung CLI never lingers as a stuck process.
async fn run_claude(args: &[&str], timeout: Duration) -> Result<std::process::Output, String> {
    let fut = tokio::process::Command::new(crate::supervisor::transport::resolved_claude_bin())
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(o)) => Ok(o),
        Ok(Err(e)) => Err(format!("could not run `claude {}`: {e}", args.join(" "))),
        Err(_) => Err(format!(
            "`claude {}` did not respond in time ({}s)",
            args.join(" "),
            timeout.as_secs()
        )),
    }
}

// ---- config reading (blocking) ---------------------------------------------

#[derive(Debug, Clone)]
struct CliConfig {
    auto_update_enabled: bool,
    /// Auto-update is held OFF by `~/.claude.json`, which we never write (see
    /// [`ClaudeCliStatus::auto_update_locked`]).
    auto_update_locked: bool,
    install_method: Option<String>,
    channel: Option<String>,
    /// A config file EXISTS but couldn't be parsed (see [`ClaudeCliStatus::config_warning`]).
    config_warning: Option<String>,
}

impl Default for CliConfig {
    /// The CLI's own defaults when nothing is configured: auto-update ON and unlocked,
    /// method/channel unknown. Crucially `auto_update_enabled` defaults to `true` (NOT
    /// `bool::default()`).
    fn default() -> Self {
        Self {
            auto_update_enabled: true,
            auto_update_locked: false,
            install_method: None,
            channel: None,
            config_warning: None,
        }
    }
}

/// The subset of `~/.claude.json` we need. A targeted struct (not a full `Value`) so serde
/// skips the file's multi-MB of caches/telemetry instead of allocating a whole JSON tree.
#[derive(Default, Deserialize)]
struct ClaudeGlobalJson {
    #[serde(rename = "installMethod")]
    install_method: Option<String>,
    #[serde(rename = "autoUpdates")]
    auto_updates: Option<bool>,
    #[serde(rename = "autoUpdatesProtectedForNative")]
    auto_updates_protected_for_native: Option<bool>,
}

/// The CLI's OWN config-based auto-update gate, verified against the 2.1.220 binary:
/// `autoUpdates:false` disables the background updater UNLESS a native install protected it
/// (`installMethod == "native"` && `autoUpdatesProtectedForNative == true`). `DISABLE_AUTOUPDATER`
/// (read separately) overrides everything. Pure → unit-tested.
fn is_config_disabled(
    auto_updates: Option<bool>,
    install_method: Option<&str>,
    protected: Option<bool>,
) -> bool {
    auto_updates == Some(false)
        && !(install_method == Some("native") && protected == Some(true))
}

/// Read the auto-update config from disk. Distinguishes an ABSENT config (normal → safe
/// default) from a PRESENT-BUT-CORRUPT one (recorded in `config_warning` so the panel can warn
/// instead of silently showing a fabricated default). `settings.json` is small (Value
/// navigation); `~/.claude.json` can be multi-MB (targeted struct).
fn read_cli_config() -> CliConfig {
    let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
    else {
        return CliConfig::default();
    };
    let mut warnings: Vec<String> = Vec::new();

    // settings.json → env.DISABLE_AUTOUPDATER (the hard off-switch, honored on every install
    // method) + autoUpdatesChannel. Tolerate the flag as "1", 1, or true.
    let settings: Option<Value> =
        read_json_checked(&home.join(".claude/settings.json"), &mut warnings);
    let env_disabled = settings
        .as_ref()
        .and_then(|v| v.pointer("/env/DISABLE_AUTOUPDATER"))
        .map(|v| v.as_str() == Some("1") || v.as_i64() == Some(1) || v.as_bool() == Some(true))
        .unwrap_or(false);
    let channel = settings
        .as_ref()
        .and_then(|v| v.get("autoUpdatesChannel"))
        .and_then(Value::as_str)
        .map(str::to_string);

    // ~/.claude.json → installMethod + the two config-gate keys, so a NON-native install's
    // `autoUpdates:false` is reflected too (not only DISABLE_AUTOUPDATER).
    let global: ClaudeGlobalJson =
        read_json_checked(&home.join(".claude.json"), &mut warnings).unwrap_or_default();
    let config_disabled = is_config_disabled(
        global.auto_updates,
        global.install_method.as_deref(),
        global.auto_updates_protected_for_native,
    );

    CliConfig {
        auto_update_enabled: !(env_disabled || config_disabled),
        // Only the `~/.claude.json` gate is a LOCK: `DISABLE_AUTOUPDATER` is the key our own
        // toggle turns, so it never locks anything.
        auto_update_locked: config_disabled,
        install_method: global.install_method,
        channel,
        config_warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    }
}

/// Read+parse a JSON file into `T`, distinguishing ABSENT (`None`, no warning) from
/// PRESENT-BUT-CORRUPT (`None` + a pushed warning) — the "never equate broken with missing"
/// discipline (mirrors `extensions::read_json_checked`).
fn read_json_checked<T: serde::de::DeserializeOwned>(
    path: &Path,
    warnings: &mut Vec<String>,
) -> Option<T> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                warnings.push(format!("{} is corrupt: {e}", path.display()));
                None
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            warnings.push(format!("{} unreadable: {e}", path.display()));
            None
        }
    }
}

// ---- pure helpers (unit-tested) --------------------------------------------

/// reqwest is built with `rustls-no-provider`; install the `ring` provider before the first
/// client build (idempotent — a no-op if the updater plugin already installed it).
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Strip surrounding punctuation (parens, `v`, `-suffix`, …) so a token like `(2.1.220)` or
/// `v2.1.220` reduces to `2.1.220`. Keeps inner dots; only trims leading/trailing non-digits.
fn clean_token(t: &str) -> &str {
    t.trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
}

/// Parse a `MAJOR.MINOR.PATCH` token into a comparable tuple; `None` if not version-shaped.
/// The patch keeps only its leading digits so `220` parses even from `220-beta`.
fn parse_version(token: &str) -> Option<(u64, u64, u64)> {
    let mut it = clean_token(token).split('.');
    let major = it.next()?.parse::<u64>().ok()?;
    let minor = it.next()?.parse::<u64>().ok()?;
    let patch_digits: String = it.next()?.chars().take_while(|c| c.is_ascii_digit()).collect();
    let patch = patch_digits.parse::<u64>().ok()?;
    Some((major, minor, patch))
}

/// The first version-shaped token in some text (`claude --version` → "2.1.220 (Claude Code)").
fn first_version_in(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(clean_token)
        .find(|t| parse_version(t).is_some())
        .map(str::to_string)
}

/// Every version-shaped token, in order (used to pull "from"/"to" out of an update line).
fn all_versions_in(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(clean_token)
        .filter(|t| parse_version(t).is_some())
        .map(str::to_string)
        .collect()
}

/// True when `latest` is strictly newer than `installed` (both must parse). NUMERIC, not
/// lexicographic: `2.1.220` beats `2.1.99`.
fn is_newer(latest: &str, installed: &str) -> bool {
    match (parse_version(latest), parse_version(installed)) {
        (Some(l), Some(i)) => l > i,
        _ => false,
    }
}

/// The last non-blank line of some output (used for an ERROR, where the CLI's complaint is last).
fn last_nonempty_line(text: &str) -> &str {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("")
}

/// Markers of `claude update`'s RESULT line, lowercased. `"updated"` appears only in the
/// success wording ("Successfully updated…"); `"up to date"` only in the no-op one. Note
/// `"Checking for updates…"` matches NEITHER (it says "updates", not "updated").
const UPDATE_RESULT_MARKERS: [&str; 2] = ["updated", "up to date"];

/// The RESULT line of `claude update`'s output: the LAST line carrying a known marker,
/// scanned from the END so a trailing progress/noise line can't shadow it. Falls back to the
/// last non-blank line when no marker is present, so an unknown future wording is still shown
/// verbatim rather than dropped. (Taking the last line BLINDLY was fragile: one extra trailing
/// line and a real update silently read as `updated: false`.)
fn update_result_line(text: &str) -> &str {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .find(|l| {
            let low = l.to_lowercase();
            UPDATE_RESULT_MARKERS.iter().any(|m| low.contains(m))
        })
        .or_else(|| lines.last())
        .copied()
        .unwrap_or("")
}

/// Cap a string to `n` chars for a user-facing message; never empty (→ "unknown").
fn cap(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if t.is_empty() {
        "unknown".to_string()
    } else {
        t
    }
}

/// Parse `claude update`'s result line. Real forms (verified live, 2.1.220):
/// - `"Successfully updated from 2.1.218 to version 2.1.220"` → updated, from + to.
/// - `"Claude Code is up to date (2.1.220)"` → not updated, to = current.
///
/// The line is located by marker (see [`update_result_line`]), not by position, so trailing
/// output after the result doesn't turn a real update into a silent no-op.
fn parse_update_output(raw: &str) -> ClaudeUpdateOutcome {
    let line = update_result_line(raw);
    let versions = all_versions_in(line);
    // "updated" appears only in the success line; "up to date" does not contain it.
    let updated = line.to_lowercase().contains("updated");
    let (from, to) = if updated {
        // `to` is the last version on the line; `from` is the first ONLY when the line really
        // carries two versions ("updated from X to version Y"). A single-version success line
        // ("updated to version Y") has no real "from" → leave it None rather than mislabel the
        // new version as the old one.
        let to = versions.get(1).cloned().or_else(|| versions.first().cloned());
        let from = if versions.len() >= 2 { versions.first().cloned() } else { None };
        (from, to)
    } else {
        (None, versions.last().cloned())
    };
    ClaudeUpdateOutcome {
        updated,
        from,
        to,
        message: cap(line, 200),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_tuple_and_tolerates_wrapping() {
        assert_eq!(parse_version("2.1.220"), Some((2, 1, 220)));
        assert_eq!(parse_version("v2.1.220"), Some((2, 1, 220)));
        assert_eq!(parse_version("(2.1.220)"), Some((2, 1, 220)));
        assert_eq!(parse_version("2.1.220-beta"), Some((2, 1, 220)));
        assert_eq!(parse_version("(Claude"), None);
        assert_eq!(parse_version("2.1"), None);
    }

    #[test]
    fn first_version_in_reads_the_claude_version_line() {
        // The exact live format of `claude --version`.
        assert_eq!(first_version_in("2.1.220 (Claude Code)").as_deref(), Some("2.1.220"));
        assert_eq!(first_version_in("no version here"), None);
    }

    #[test]
    fn is_newer_is_numeric_not_lexicographic() {
        assert!(is_newer("2.1.220", "2.1.218"));
        assert!(is_newer("2.1.220", "2.1.99")); // 220 > 99 numerically (lexicographic would fail)
        assert!(is_newer("2.2.0", "2.1.999"));
        assert!(is_newer("3.0.0", "2.9.9"));
        assert!(!is_newer("2.1.220", "2.1.220"));
        assert!(!is_newer("2.1.218", "2.1.220"));
        assert!(!is_newer("garbage", "2.1.0")); // unparseable → not "newer"
        assert!(!is_newer("2.1.0", "garbage"));
    }

    #[test]
    fn parses_successful_update_line() {
        // Verified live: `claude update` from 2.1.218 printed exactly this.
        let raw = "Current version: 2.1.218\nChecking for updates...\n\
                   Successfully updated from 2.1.218 to version 2.1.220";
        let o = parse_update_output(raw);
        assert!(o.updated);
        assert_eq!(o.from.as_deref(), Some("2.1.218"));
        assert_eq!(o.to.as_deref(), Some("2.1.220"));
    }

    #[test]
    fn parses_already_up_to_date_line() {
        // Verified live (already on 2.1.220): the parenthesized version must still be read,
        // and "up to date" must NOT be misread as an update.
        let raw = "Current version: 2.1.220\nChecking for updates to latest version...\n\
                   Claude Code is up to date (2.1.220)";
        let o = parse_update_output(raw);
        assert!(!o.updated);
        assert_eq!(o.from, None);
        assert_eq!(o.to.as_deref(), Some("2.1.220"));
    }

    #[test]
    fn result_line_is_found_by_marker_not_by_position() {
        // A trailing line after the result (progress tail, hint, blank-ish noise) must NOT
        // shadow it — taking the last line blindly read a real update as "not updated".
        let raw = "Checking for updates...\n\
                   Successfully updated from 2.1.218 to version 2.1.220\n\
                   Restart your terminal to use the new version.";
        let o = parse_update_output(raw);
        assert!(o.updated, "the result line is found despite the trailing line");
        assert_eq!(o.from.as_deref(), Some("2.1.218"));
        assert_eq!(o.to.as_deref(), Some("2.1.220"));

        // Same for the no-op wording.
        let o2 = parse_update_output(
            "Checking for updates to latest version...\n\
             Claude Code is up to date (2.1.220)\n\
             Run `claude` to start.",
        );
        assert!(!o2.updated);
        assert_eq!(o2.to.as_deref(), Some("2.1.220"));
    }

    #[test]
    fn unknown_wording_falls_back_to_the_last_line_verbatim() {
        // No known marker → we still surface SOMETHING the user can read, never an empty
        // message that would look like nothing happened. Trailing blanks must not win either
        // (the old last-line rule and the new marker rule agree here — that's the point:
        // hardening the good case must not regress the unknown one).
        let o = parse_update_output("Some future wording\nfinal line 9.9.9\n   \n");
        assert!(!o.updated);
        assert_eq!(o.message, "final line 9.9.9");
        assert_eq!(o.to.as_deref(), Some("9.9.9"), "the version is still read out of it");
        // Nothing at all to say → the capped message is "unknown", never empty.
        assert_eq!(parse_update_output("\n  \n").message, "unknown");
    }

    #[test]
    fn checking_line_is_not_mistaken_for_a_result() {
        // "Checking for updates" says "updates", not "updated" — it must not match.
        assert_eq!(update_result_line("Checking for updates...\nlast"), "last");
    }

    #[test]
    fn cap_caps_and_is_never_empty() {
        assert_eq!(cap("", 10), "unknown");
        assert_eq!(cap("hello", 3), "hel");
        assert_eq!(cap("hi", 10), "hi");
    }

    #[test]
    fn single_version_success_line_leaves_from_none() {
        // "updated to version X" (no "from Y") must NOT mislabel X as the previous version.
        let o = parse_update_output("Successfully updated to version 2.1.220");
        assert!(o.updated);
        assert_eq!(o.from, None);
        assert_eq!(o.to.as_deref(), Some("2.1.220"));
    }

    #[test]
    fn config_gate_matches_the_cli_binary() {
        // Verified against the 2.1.220 binary: autoUpdates:false disables auto-update UNLESS a
        // native install protected it.
        assert!(!is_config_disabled(Some(false), Some("native"), Some(true)), "native+protected neutralizes");
        assert!(is_config_disabled(Some(false), Some("npm"), None), "npm honors autoUpdates:false");
        assert!(is_config_disabled(Some(false), Some("native"), Some(false)), "native but unprotected → disabled");
        assert!(!is_config_disabled(Some(true), Some("npm"), None), "autoUpdates true → enabled");
        assert!(!is_config_disabled(None, Some("npm"), None), "autoUpdates absent → enabled");
    }

    #[test]
    fn default_config_is_unlocked_and_on() {
        // The safe default must never present the toggle as locked (which would deny the user
        // a control that actually works).
        let c = CliConfig::default();
        assert!(c.auto_update_enabled);
        assert!(!c.auto_update_locked);
    }
}
