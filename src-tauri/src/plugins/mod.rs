//! Plugin update actions — the ONE place in the core that shells out to the
//! `claude plugin …` CLI. Same encapsulation contract as [`crate::git`] (the `git`
//! CLI): nothing else spawns the plugin CLI.
//!
//! ⚠️ Every public function returns `Result<String, String>` where the `Ok` payload is
//! the CLI's own one-line verdict (see [`report_line`]) and **callers MUST render it**.
//! `claude plugin update` exits 0 while reporting `up_to_date` ("… is already at the
//! latest version") or `skipped` ("Skipped — … version range …"), so a `Result<(),
//! String>` signature here would re-introduce the swallowed-verdict bug: the spinner
//! stops, nothing changes, and the UI implies success.
//!
//! ## Why the CLI, not files
//! Plugin install/update is only officially supported through this CLI — the same
//! path the VS Code extension drives (`runClaudeCommandRaw(["plugin", …])`). Editing
//! the plugin cache or `git pull`-ing the marketplace clones by hand would break the
//! *official* marketplace, which is a GCS snapshot pinned by a `.gcs-sha` file, not a
//! git repo. So we let the binary own the mutation and stay immune to config drift.
//!
//! Reads (what's installed, what's the latest pin, per-marketplace auto-update state)
//! live in [`crate::extensions`] — the on-disk config authority. This module is
//! writes-via-CLI only. After an update, a LIVE session hot-applies it with a
//! `reload_plugins` control request (the caller's job); otherwise the new version is
//! picked up on the next session spawn (the CLI prints "restart required").

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Upper bound on a `claude plugin …` shell-out. A marketplace refresh does network git
/// fetches across several repos, so this is generous; but it MUST be bounded so a
/// stalled network / credential prompt / wedged git can't leave the mutation pending
/// forever (a permanent UI spinner) nor pin a blocking-pool thread indefinitely.
const CLAUDE_CLI_TIMEOUT: Duration = Duration::from_secs(180);

/// Refresh marketplace(s) from their upstream source
/// (`claude plugin marketplace update [name]`; all when `name` is `None`). This is the
/// network step that makes the on-disk `marketplace.json` pins current — run it before
/// re-reading update availability so newly published versions become visible. Operates
/// on `~/.claude/plugins` (user-global), so it needs no working directory.
pub fn refresh_marketplaces(name: Option<&str>) -> Result<String, String> {
    let mut args = vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "update".to_string(),
    ];
    if let Some(n) = name {
        args.push(n.to_string());
    }
    run_claude(&args, None)
}

/// Update ONE plugin to the latest version from its marketplace
/// (`claude plugin update <plugin> [-s <scope>]`). `plugin_id` is the full
/// `<plugin>@<marketplace>` id; `scope` is `"user" | "project" | "local"` (the install
/// scope). `cwd` is the repo/conversation directory the command runs in — REQUIRED for
/// project/local scope, which the CLI resolves from the working directory (there is no
/// id-based project selector); harmless for the cwd-independent user scope.
/// Returns the CLI's own one-line verdict, which the caller MUST show: an exit code
/// of 0 does NOT mean the plugin moved. `claude plugin update` exits 0 while reporting
/// `up_to_date` ("… is already at the latest version (1.3.6).") or `skipped` ("Skipped
/// — X requires … at a version range that Y does not satisfy"). Discarding stdout on
/// success made those outcomes indistinguishable from a real update: the spinner
/// stopped, nothing changed, and the user was told nothing.
pub fn update_plugin(plugin_id: &str, scope: Option<&str>, cwd: &str) -> Result<String, String> {
    let mut args = vec![
        "plugin".to_string(),
        "update".to_string(),
        plugin_id.to_string(),
    ];
    if let Some(s) = scope {
        args.push("-s".to_string());
        args.push(s.to_string());
    }
    run_claude(&args, Some(Path::new(cwd)))
}

/// The CLI's report line for a plugin operation: the last non-empty, non-progress
/// line of its output (it prints a "Checking for updates…" preamble first). Empty
/// when it said nothing usable.
fn report_line(out: &str) -> String {
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.ends_with('\u{2026}') && !l.ends_with("..."))
        .next_back()
        .unwrap_or("")
        .trim_start_matches(['\u{2714}', '\u{2713}', '*'])
        .trim()
        .to_string()
}

/// Run `claude <args>` to completion (in `cwd` when given), mapping a non-zero exit
/// into a human `Err` that carries the tail of the binary's output (so a rejection is
/// surfaced in the UI, never silent). Resolves the same `claude` binary our sessions
/// spawn (works in a bundle's minimal PATH). Bounded by [`CLAUDE_CLI_TIMEOUT`]: on
/// timeout the child's whole process group is killed and a timeout `Err` returned, so a
/// hung git fetch can't wedge the mutation forever. Synchronous — the IPC layer runs it
/// off the async runtime.
fn run_claude(args: &[String], cwd: Option<&Path>) -> Result<String, String> {
    let bin = crate::supervisor::transport::resolved_claude_bin();
    let joined = args.join(" ");
    let mut cmd = Command::new(&bin);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // Own process group so a timeout kill reaps claude AND its git subprocesses (same
    // anti-orphan pattern as the session supervisor).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not launch \"claude {joined}\": {e}"))?;
    let pid = child.id();
    // Drain + wait on a helper thread so a full stdout/stderr pipe can't deadlock the
    // wait; the main thread bounds it with a timeout.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(CLAUDE_CLI_TIMEOUT) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("\"claude {joined}\" failed: {e}")),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_group(pid);
            return Err(format!(
                "\"claude {joined}\" timed out ({} s) and was interrupted.",
                CLAUDE_CLI_TIMEOUT.as_secs()
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(format!("\"claude {joined}\": the process disappeared without a result."));
        }
    };
    if output.status.success() {
        // Success ≠ "it changed". Hand the CLI's verdict back so the caller can say so.
        return Ok(report_line(&String::from_utf8_lossy(&output.stdout)));
    }
    // Prefer stderr for the failure reason, falling back to stdout; keep only the tail.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let body = if stderr.trim().is_empty() { stdout } else { stderr };
    let tail = tail_lines(body.trim(), 8);
    Err(format!(
        "\"claude {joined}\" failed ({}){}",
        output.status,
        if tail.is_empty() {
            String::new()
        } else {
            format!(" : {tail}")
        }
    ))
}

/// Best-effort SIGKILL of the child's whole process group (claude + its git
/// subprocesses) after a timeout — the child is its own group leader via
/// `process_group(0)`, so a negative pid targets the group. Unix-only (this app is
/// macOS-first); a no-op elsewhere.
fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Keep the last `n` lines of `text` (the useful part of a CLI failure). Pure/testable.
fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_keeps_the_last_n() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("only", 8), "only");
        assert_eq!(tail_lines("", 8), "");
    }

    /// REGRESSION: `claude plugin update` exits 0 even when it did NOT move the
    /// plugin, and its verdict is the LAST line — the first is a "Checking for
    /// updates…" preamble. Reporting the wrong line (or none) is what made the
    /// Update button look broken: it spun, stopped, and said nothing while the
    /// plugin stayed flagged.
    #[test]
    fn report_line_keeps_the_verdict_not_the_progress_preamble() {
        // The real up-to-date output that made the button look dead.
        let out = "Checking for updates for plugin \"railway@claude-plugins-official\" at user scope…\n\
                   ✔ railway is already at the latest version (1.3.6).\n";
        assert_eq!(
            report_line(out),
            "railway is already at the latest version (1.3.6)."
        );

        // A skip is an exit-0 outcome too and must survive.
        let skipped = "Checking for updates…\nSkipped — foo requires bar at a version range that 1.0.0 does not satisfy";
        assert_eq!(
            report_line(skipped),
            "Skipped — foo requires bar at a version range that 1.0.0 does not satisfy"
        );

        // A real update keeps its line; trailing blanks and the check glyph are trimmed.
        assert_eq!(report_line("✔ Updated railway to 1.4.0.\n\n"), "Updated railway to 1.4.0.");

        // Nothing usable → empty (the caller renders no box rather than a blank one).
        assert_eq!(report_line("Checking for updates…\n"), "");
        assert_eq!(report_line(""), "");
    }
}
