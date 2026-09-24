//! Classifies a just-closed `ssh` transport's exit into one of three coarse
//! outcomes, from ssh's own exit code + stderr — the ONE place this codebase
//! decides "was that a rejected key, a changed host identity, or just an
//! ordinary network blip?" for every caller that needs the distinction:
//! the live remote session's reconnect loop (`supervisor::session::run_actor`),
//! a one-shot diagnosis (`bootstrap::orchestrator::diagnose`), and the two
//! plain keyed ssh round trips that report a bare error string
//! (`ipc::commands::run_ssh_on_machine`, `appmcp::provision::run_phone_reply`).
//!
//! Deliberately coarse: `Unreachable` folds DNS failures, connection refused,
//! no route to host, network unreachable, and a timed-out handshake into ONE
//! bucket — see the module's own design doc (CRM `c9bf1482`) for why
//! enumerating them separately was rejected. Only a rejected key and a changed
//! host identity get their own variant, because those two need a DIFFERENT
//! repair (reconnect this Mac's key / review the new identity) than "try
//! again" — everything else in `Unreachable` is retried the same way either
//! way.

use serde::{Deserialize, Serialize};
use specta::Type;

/// What kind of hard ssh-level failure just closed a transport before (or
/// instead of) ever reaching the daemon. `Unreachable` is the catch-all — see
/// the module doc for why it is not split further.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SshLinkIssue {
    /// The server rejected every key/password this Mac offered
    /// (`Permission denied (publickey…)`/`(publickey,password)`) — the
    /// saved key is no longer authorized (the real incident this module was
    /// built for: an operator removed it from `authorized_keys`).
    KeyRefused,
    /// The server's host key does not match what this Mac last saw (or, under
    /// strict checking, refused a brand-new one) — see
    /// [`crate::bootstrap::askpass::is_host_key_mismatch`], reused here so
    /// both this live-session path and the bootstrap flow recognize the SAME
    /// two OpenSSH wordings.
    HostKeyChanged,
    /// Everything else that keeps ssh from ever connecting: DNS failure,
    /// connection refused, no route to host, network unreachable, a timed-out
    /// handshake, or any other unrecognized ssh-level (exit 255) failure.
    /// Deliberately ONE bucket — see the module doc.
    Unreachable,
}

/// Classifies a closed ssh transport from its exit code + the tail of its
/// stderr. `None` when this was not an ssh-level failure at all — OpenSSH's
/// own convention is that exit code 255 means ssh ITSELF failed (auth/
/// connect/host-key); any other code (including the two other classifiers
/// `supervisor::session` checks first — a missing remote binary at 127, a
/// clap flag rejection at 2) is the REMOTE COMMAND's own exit code, carried
/// through verbatim, and this function must stay out of the way of those.
///
/// `stderr_tail` is joined with `\n` and matched case-insensitively (via
/// [`is_host_key_mismatch`](crate::bootstrap::askpass::is_host_key_mismatch)
/// for the host-key wording, and a plain lowercase `contains` for
/// "permission denied") — ssh's own wording is stable across versions for
/// both phrases, so no other heuristic is needed.
pub fn classify_transport_close(exit_code: Option<i32>, stderr_tail: &[String]) -> Option<SshLinkIssue> {
    if exit_code != Some(255) {
        return None;
    }
    let joined = stderr_tail.join("\n");
    if crate::bootstrap::askpass::is_host_key_mismatch(&joined) {
        return Some(SshLinkIssue::HostKeyChanged);
    }
    if joined.to_lowercase().contains("permission denied") {
        return Some(SshLinkIssue::KeyRefused);
    }
    Some(SshLinkIssue::Unreachable)
}

/// A plain, one-sentence description of `issue` for the two call sites that
/// report a bare `Result<_, String>` outside a live session
/// (`ipc::commands::run_ssh_on_machine`, `appmcp::provision::run_phone_reply`)
/// — never the live thread notice's own wording (that one also names the
/// Settings panel to open, which makes no sense outside the app's own UI).
/// Lowercase, no trailing punctuation, so callers compose it freely (e.g.
/// `format!("failed: {}", describe(issue))`).
pub(crate) fn describe(issue: SshLinkIssue) -> String {
    match issue {
        SshLinkIssue::KeyRefused => "this Mac's saved key was refused by this server".to_string(),
        SshLinkIssue::HostKeyChanged => {
            "this server's identity has changed since this Mac last connected to it".to_string()
        }
        SshLinkIssue::Unreachable => "could not reach the server".to_string(),
    }
}

/// Cap on [`sanitize_stderr_detail`]'s output — mirrors
/// `bootstrap::server_setup::INSTALL_LOG_MAX_CHARS`'s reasoning (same class of
/// problem: bounding server-derived text before it reaches a user-facing payload).
const DETAIL_MAX_CHARS: usize = 2000;

/// Sanitizes `stderr_lines` for use as a notice's collapsed "Technical details"
/// payload. `stderr_lines` is SERVER-controlled text (an ssh pre-auth banner, or
/// whatever the remote daemon/shell wrote to stderr before the transport closed) —
/// this strips ANSI/control sequences (`bootstrap::server_setup::strip_ansi`) and
/// caps the result at [`DETAIL_MAX_CHARS`] before it is ever wrapped in a `Value`
/// and sent to the front end, mirroring the discipline `appmcp::provision` and
/// `ipc::commands::run_ssh_on_machine` already apply to the SAME stderr via
/// `describe` — this is for the raw collapsed detail, they are for the headline
/// sentence. Returns `None` for empty/blank input so callers can plug this
/// straight into a `Value::Null` fallback with no extra `is_empty()` check.
pub(crate) fn sanitize_stderr_detail(stderr_lines: &[String]) -> Option<String> {
    let stripped = crate::bootstrap::server_setup::strip_ansi(&stderr_lines.join("\n"));
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(DETAIL_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &[&str]) -> Vec<String> {
        s.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn key_refused_for_both_real_openssh_wordings() {
        assert_eq!(
            classify_transport_close(Some(255), &lines(&["Permission denied (publickey)."])),
            Some(SshLinkIssue::KeyRefused),
        );
        assert_eq!(
            classify_transport_close(Some(255), &lines(&["Permission denied (publickey,password)."])),
            Some(SshLinkIssue::KeyRefused),
        );
    }

    #[test]
    fn host_key_changed_for_both_real_openssh_wordings() {
        assert_eq!(
            classify_transport_close(Some(255), &lines(&["Host key verification failed."])),
            Some(SshLinkIssue::HostKeyChanged),
        );
        assert_eq!(
            classify_transport_close(
                Some(255),
                &lines(&["@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@", "REMOTE HOST IDENTIFICATION HAS CHANGED!"]),
            ),
            Some(SshLinkIssue::HostKeyChanged),
        );
    }

    #[test]
    fn unreachable_for_every_live_verified_network_wording() {
        for line in [
            "ssh: Could not resolve hostname does-not-exist.invalid: nodename nor servname provided, or not known",
            "ssh: connect to host 203.0.113.1 port 22: Operation timed out",
            "ssh: connect to host 10.0.0.5 port 22: Connection timed out",
            "ssh: connect to host 127.0.0.1 port 1: Connection refused",
            "ssh: connect to host 10.0.0.5 port 22: No route to host",
            "ssh: connect to host 10.0.0.5 port 22: Network is unreachable",
            "some ssh failure this classifier has never seen before",
        ] {
            assert_eq!(
                classify_transport_close(Some(255), &lines(&[line])),
                Some(SshLinkIssue::Unreachable),
                "line: {line}",
            );
        }
    }

    #[test]
    fn none_for_a_missing_daemon_or_clap_rejection_exit_code() {
        // Regression guard: this classifier must never shadow the two exit-code
        // classifiers `run_actor` checks first (127 = missing remote binary, 2 =
        // clap flag rejection) — both are unrelated to ssh itself.
        assert_eq!(classify_transport_close(Some(127), &lines(&["bash: flightdeckd: command not found"])), None);
        assert_eq!(
            classify_transport_close(Some(2), &lines(&["error: unexpected argument '--supports-skip' found"])),
            None,
        );
        assert_eq!(classify_transport_close(None, &lines(&["Permission denied (publickey)."])), None);
    }

    #[test]
    fn describe_is_lowercase_and_unpunctuated_for_composing() {
        for issue in [SshLinkIssue::KeyRefused, SshLinkIssue::HostKeyChanged, SshLinkIssue::Unreachable] {
            let d = describe(issue);
            assert!(!d.ends_with('.'), "{issue:?}: {d:?}");
            assert!(d.chars().next().is_some_and(|c| !c.is_uppercase()), "{issue:?}: {d:?}");
        }
    }

    #[test]
    fn sanitize_stderr_detail_is_none_for_empty_or_blank_input() {
        assert_eq!(sanitize_stderr_detail(&[]), None);
        assert_eq!(sanitize_stderr_detail(&lines(&["", "   "])), None);
    }

    #[test]
    fn sanitize_stderr_detail_strips_ansi_and_joins_lines() {
        let raw = lines(&["\u{1b}[31mPermission denied\u{1b}[0m (publickey).", "second line"]);
        assert_eq!(sanitize_stderr_detail(&raw).as_deref(), Some("Permission denied (publickey).\nsecond line"));
    }

    #[test]
    fn sanitize_stderr_detail_caps_length() {
        let huge = "x".repeat(DETAIL_MAX_CHARS + 500);
        let out = sanitize_stderr_detail(&lines(&[&huge])).unwrap();
        assert_eq!(out.chars().count(), DETAIL_MAX_CHARS);
    }
}
