//! The background time limit of a `Bash` command (claude 2.1.285+).
//!
//! Since 2.1.285 the CLI stops a background shell command once it has run for a time
//! limit (`stopCause:"deadline"`): a dev server, a watcher or a long build launched in
//! the background dies after 30 minutes unless the model asked for longer. The wire
//! carries the stop (a `stopped` task whose summary names the cause) but NEVER the
//! limit itself — the CLI keeps `deadlineAt` in its own task registry, and the
//! `task_updated` patch omits it. So the app mirrors the CLI's arithmetic here to tell
//! the user, while the command still runs, when it will be stopped.
//!
//! The rules, dissected from the 2.1.293 binary (`t7r` / `OVt` / `Tae` / `cte` / `gke`):
//!  - foreground default `cte` = `BASH_DEFAULT_TIMEOUT_MS` (> 0) else 2 min;
//!  - foreground max `gke` = max(`BASH_MAX_TIMEOUT_MS` (> 0), `cte`) else max(10 min, `cte`);
//!  - background default = max(30 min, `cte`);
//!  - background max = min(max(2 h, `gke`), 2³¹−1 ms — the JS timer ceiling);
//!  - limit = min(the command's `timeout` when > 0, else the background default; the max).
//!
//! A command launched with `run_in_background` is timed from its launch, with its own
//! `timeout`; one moved there mid-run (auto-backgrounded at its foreground timeout, by
//! the user, or to let a message through) is timed from that move, on the DEFAULT —
//! the CLI passes it no timeout. A Monitor watch has no limit.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// First CLI version that stops background commands at a time limit.
pub const DEADLINE_SINCE: (u32, u32, u32) = (2, 1, 285);

const FOREGROUND_DEFAULT_MS: u64 = 120_000;
const FOREGROUND_MAX_MS: u64 = 600_000;
const BACKGROUND_DEFAULT_FLOOR_MS: u64 = 1_800_000;
const BACKGROUND_MAX_FLOOR_MS: u64 = 7_200_000;
/// `setTimeout` clamps at 2³¹−1 ms; the CLI caps the limit there explicitly.
const TIMER_CEILING_MS: u64 = 2_147_483_647;

/// The env variables the CLI derives its limits from.
pub const DEFAULT_TIMEOUT_VAR: &str = "BASH_DEFAULT_TIMEOUT_MS";
pub const MAX_TIMEOUT_VAR: &str = "BASH_MAX_TIMEOUT_MS";

/// The two figures a background command's limit is drawn from, as the CLI process of
/// one session sees them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BashTimeLimits {
    /// Limit of a command that asked for no `timeout` (and of any command moved to the
    /// background mid-run).
    pub default_ms: u64,
    /// Ceiling of a requested `timeout`.
    pub max_ms: u64,
}

impl Default for BashTimeLimits {
    /// The CLI's own figures with neither variable set: 30 min, 2 h.
    fn default() -> Self {
        Self::from_vars(None, None)
    }
}

impl BashTimeLimits {
    /// The limits for the given values of `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`
    /// (an unparsable or non-positive value counts as unset, like the CLI's).
    pub fn from_vars(default_var: Option<&str>, max_var: Option<&str>) -> Self {
        let fg_default = default_var.and_then(parse_ms).unwrap_or(FOREGROUND_DEFAULT_MS);
        let fg_max = match max_var.and_then(parse_ms) {
            Some(max) => max.max(fg_default),
            None => FOREGROUND_MAX_MS.max(fg_default),
        };
        Self {
            default_ms: BACKGROUND_DEFAULT_FLOOR_MS.max(fg_default),
            max_ms: BACKGROUND_MAX_FLOOR_MS.max(fg_max).min(TIMER_CEILING_MS),
        }
    }

    /// The limits a LOCAL session's CLI process runs under. Its environment is ours
    /// (inherited), overridden by `spawn_env` (what we set on the spawn), overridden in
    /// turn by the `env` block of its settings files — the CLI copies those onto its own
    /// `process.env` at startup, so they win over anything we pass. Layered like the
    /// CLI merges them: user, then project, then local settings.
    pub fn resolve(cwd: &Path, spawn_env: &[(&str, String)]) -> Self {
        let inherited = (std::env::var(DEFAULT_TIMEOUT_VAR).ok(), std::env::var(MAX_TIMEOUT_VAR).ok());
        Self::resolve_layers(inherited, spawn_env, &settings_layers(cwd))
    }

    /// [`Self::resolve`] over explicit inputs (testable without touching the real
    /// environment or home directory).
    fn resolve_layers(
        inherited: (Option<String>, Option<String>),
        spawn_env: &[(&str, String)],
        settings: &[PathBuf],
    ) -> Self {
        let (mut default_var, mut max_var) = inherited;
        for (key, value) in spawn_env {
            match *key {
                DEFAULT_TIMEOUT_VAR => default_var = Some(value.clone()),
                MAX_TIMEOUT_VAR => max_var = Some(value.clone()),
                _ => {}
            }
        }
        for path in settings {
            let Some(env) = read_settings_env(path) else { continue };
            if let Some(v) = env_value(&env, DEFAULT_TIMEOUT_VAR) {
                default_var = Some(v);
            }
            if let Some(v) = env_value(&env, MAX_TIMEOUT_VAR) {
                max_var = Some(v);
            }
        }
        Self::from_vars(default_var.as_deref(), max_var.as_deref())
    }

    /// The limit of one command: its requested `timeout` when positive (capped at the
    /// max), else the default.
    pub fn limit_for(&self, requested_ms: Option<u64>) -> u64 {
        requested_ms
            .filter(|&ms| ms > 0)
            .unwrap_or(self.default_ms)
            .min(self.max_ms)
    }
}

/// Does this CLI version stop background commands at a limit? An unparsable version
/// is taken as a current one (the limit is the norm since 2.1.285).
pub fn cli_has_deadline(version: &str) -> bool {
    parse_version(version).is_none_or(|v| v >= DEADLINE_SINCE)
}

fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    // "2.1.293", tolerating a suffix ("2.1.293 (Claude Code)", "2.1.293-beta").
    let core = version.trim().split(|c: char| !(c.is_ascii_digit() || c == '.')).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// A millisecond count, read like the CLI's `parseInt`: leading digits after optional
/// whitespace, anything after them ignored; 0 or no digits = unset.
fn parse_ms(raw: &str) -> Option<u64> {
    let s = raw.trim_start();
    let s = s.strip_prefix('+').unwrap_or(s);
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u64>().ok().filter(|&ms| ms > 0)
}

/// The settings files whose `env` reaches a session started in `cwd`, lowest priority
/// first.
fn settings_layers(cwd: &Path) -> Vec<PathBuf> {
    let mut layers = Vec::new();
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        layers.push(PathBuf::from(home).join(".claude/settings.json"));
    }
    layers.push(cwd.join(".claude/settings.json"));
    layers.push(cwd.join(".claude/settings.local.json"));
    layers
}

fn read_settings_env(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.get("env").cloned()
}

/// One variable of a settings `env` block — a string, or a bare number some users write.
fn env_value(env: &Value, key: &str) -> Option<String> {
    match env.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_thirty_minutes_and_two_hours() {
        let limits = BashTimeLimits::default();
        assert_eq!(limits.default_ms, 30 * 60_000);
        assert_eq!(limits.max_ms, 2 * 3_600_000);
    }

    #[test]
    fn a_requested_timeout_sets_the_limit_up_to_the_max() {
        let limits = BashTimeLimits::default();
        assert_eq!(limits.limit_for(None), 30 * 60_000);
        assert_eq!(limits.limit_for(Some(0)), 30 * 60_000, "0 = no timeout asked, like the CLI's `||`");
        assert_eq!(limits.limit_for(Some(5_000)), 5_000, "a short timeout is honoured as is");
        assert_eq!(limits.limit_for(Some(3_600_000)), 3_600_000);
        assert_eq!(limits.limit_for(Some(10 * 3_600_000)), 2 * 3_600_000, "capped at the max");
    }

    #[test]
    fn the_env_raises_the_figures_like_the_cli() {
        // Only a default above 30 min moves the background default; the foreground max
        // follows the default when it is larger.
        let limits = BashTimeLimits::from_vars(Some("600000"), None);
        assert_eq!(limits.default_ms, 30 * 60_000);
        let limits = BashTimeLimits::from_vars(Some("5400000"), None);
        assert_eq!(limits.default_ms, 5_400_000);
        assert_eq!(limits.max_ms, 2 * 3_600_000);
        let limits = BashTimeLimits::from_vars(None, Some("28800000"));
        assert_eq!(limits.default_ms, 30 * 60_000);
        assert_eq!(limits.max_ms, 8 * 3_600_000);
        let limits = BashTimeLimits::from_vars(Some("36000000"), Some("1000"));
        assert_eq!(limits.default_ms, 36_000_000);
        assert_eq!(limits.max_ms, 36_000_000, "the max never falls below the default");
    }

    #[test]
    fn the_limit_never_exceeds_the_timer_ceiling() {
        let limits = BashTimeLimits::from_vars(Some("9999999999999"), Some("9999999999999"));
        assert_eq!(limits.max_ms, TIMER_CEILING_MS);
        assert_eq!(limits.limit_for(None), TIMER_CEILING_MS);
    }

    #[test]
    fn bad_values_count_as_unset() {
        assert_eq!(BashTimeLimits::from_vars(Some("abc"), Some("-5")), BashTimeLimits::default());
        assert_eq!(BashTimeLimits::from_vars(Some("0"), Some("")), BashTimeLimits::default());
        assert_eq!(parse_ms(" 3600000ms"), Some(3_600_000), "parseInt keeps the leading digits");
    }

    #[test]
    fn settings_env_wins_over_the_spawn_env() {
        let dir = std::env::temp_dir().join(format!("bash-limits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let layers = [dir.join(".claude/settings.json"), dir.join(".claude/settings.local.json")];
        let resolve = |spawn: &[(&str, String)]| {
            BashTimeLimits::resolve_layers((None, Some("10800000".into())), spawn, &layers)
        };
        let spawn = [(MAX_TIMEOUT_VAR, "14400000".to_string())];
        // The inherited env counts; the spawn env overrides it.
        assert_eq!(resolve(&[]).max_ms, 3 * 3_600_000);
        assert_eq!(resolve(&spawn).max_ms, 4 * 3_600_000);
        // A project settings env block overrides both (number form tolerated).
        std::fs::write(&layers[0], r#"{"env":{"BASH_MAX_TIMEOUT_MS":21600000}}"#).unwrap();
        assert_eq!(resolve(&spawn).max_ms, 6 * 3_600_000);
        // The local file outranks the project one.
        std::fs::write(&layers[1], r#"{"env":{"BASH_MAX_TIMEOUT_MS":"28800000"}}"#).unwrap();
        assert_eq!(resolve(&spawn).max_ms, 8 * 3_600_000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_limit_exists_from_2_1_285() {
        assert!(!cli_has_deadline("2.1.284"));
        assert!(cli_has_deadline("2.1.285"));
        assert!(cli_has_deadline("2.1.293 (Claude Code)"));
        assert!(cli_has_deadline("2.2.0"));
        assert!(!cli_has_deadline("1.9.999"));
        assert!(cli_has_deadline("garbage"), "unknown → assume a current CLI");
    }
}
