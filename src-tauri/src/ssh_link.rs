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
    /// (`Permission denied (publickey…)`/`(publickey,password)`, or `Too many
    /// authentication failures` — see [`is_key_refusal_text`]) — the
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
/// for the host-key wording, and [`is_key_refusal_text`] for a refused key) —
/// ssh's own wording is stable across versions for these phrases, so no other
/// heuristic is needed.
pub fn classify_transport_close(exit_code: Option<i32>, stderr_tail: &[String]) -> Option<SshLinkIssue> {
    if exit_code != Some(255) {
        return None;
    }
    let joined = stderr_tail.join("\n");
    if crate::bootstrap::askpass::is_host_key_mismatch(&joined) {
        return Some(SshLinkIssue::HostKeyChanged);
    }
    if is_key_refusal_text(&joined) {
        return Some(SshLinkIssue::KeyRefused);
    }
    Some(SshLinkIssue::Unreachable)
}

/// Whether ssh's stderr says the server REFUSED the identities it was offered:
/// `Permission denied (publickey…)`, or a server that cut the connection after more
/// of them than its `MaxAuthTries` (`Received disconnect from …: Too many
/// authentication failures` — offering Flight Deck's key first, `-i`, it was among
/// those refused). Never for a changed host key, which fails the same way whatever key
/// is offered. Case-insensitive.
///
/// The ONE reading of these wordings: [`classify_transport_close`] (a live session, a
/// diagnosis) and `ipc::commands::first_working_login` (which tries this Mac's own
/// keys only where Flight Deck's was refused) both go through it, so a server can't be
/// "refused" for one and "unreachable" for the other.
pub(crate) fn is_key_refusal_text(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    !crate::bootstrap::askpass::is_host_key_mismatch(stderr)
        && (lower.contains("permission denied") || lower.contains("too many authentication failures"))
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

/// [`describe`], keeping ssh's own reason when the catch-all has no name for it: an
/// `Unreachable` close whose stderr says something other than a plain network failure
/// (see [`unexplained_failure_line`]) reads `could not reach the server (ssh: Cannot
/// execute command-line and remote command.)` — a `RemoteCommand` in the user's ssh
/// config, `Bad owner or permissions on ~/.ssh/config`, a cipher nobody shares, a
/// tailnet policy refusal: causes the user can act on, which the fixed sentence hid.
pub(crate) fn describe_with_detail(issue: SshLinkIssue, stderr_lines: &[String]) -> String {
    match (issue, unexplained_failure_line(stderr_lines)) {
        (SshLinkIssue::Unreachable, Some(line)) => format!("{} (ssh: {line})", describe(issue)),
        _ => describe(issue),
    }
}

/// Longest line [`unexplained_failure_line`] keeps.
const FAILURE_LINE_MAX_CHARS: usize = 200;

/// ssh's last stderr line, when it explains a failure [`classify_transport_close`] files
/// under `Unreachable` without a name: `None` for no output, or for a link that simply
/// could not be reached or died ([`is_plain_link_failure`]), which "could not reach the
/// server" already says. A bare `Disconnected from …` gives way to the `Received
/// disconnect from …: <reason>` ssh logs just before it — the server's own stated reason.
/// Control characters stripped, a leading `ssh: ` dropped, capped at
/// [`FAILURE_LINE_MAX_CHARS`].
pub(crate) fn unexplained_failure_line(stderr_lines: &[String]) -> Option<String> {
    let mut written = stderr_lines.iter().rev().map(|l| l.trim()).filter(|l| !l.is_empty());
    let mut last = written.next()?;
    if last.to_lowercase().starts_with("disconnected from ") {
        match written.next() {
            Some(reason) if reason.to_lowercase().starts_with("received disconnect from ") => last = reason,
            _ => return None,
        }
    }
    if is_plain_link_failure(last) {
        return None;
    }
    let clean: String = crate::bootstrap::server_setup::strip_ansi(last).chars().filter(|c| !c.is_control()).collect();
    let clean = clean.trim();
    let clean = clean.strip_prefix("ssh: ").unwrap_or(clean).trim();
    (!clean.is_empty()).then(|| clean.chars().take(FAILURE_LINE_MAX_CHARS).collect())
}

/// Whether ssh's `line` only says the link could not be reached or died — nothing the
/// user can act on beyond "could not reach the server": the network wordings the
/// bootstrap reads ([`crate::bootstrap::askpass::is_host_unreachable`]), and the ones ssh
/// logs when an established link goes (the ServerAlive deadline, a reset, a close, a
/// broken pipe, a timed-out read). Those last ones matter since the ssh this crate spawns
/// logs at INFO and every one-shot has a ServerAlive deadline: a link that died
/// mid-command ends on one of them, never on the server's login-shell noise above it.
/// A `kex_exchange_identification` line is never plain: a server whose sshd drops the
/// connection before its banner (fail2ban, MaxStartups) is up, and refusing this Mac.
fn is_plain_link_failure(line: &str) -> bool {
    let lower = line.to_lowercase();
    if lower.contains("kex_exchange_identification") {
        return false;
    }
    crate::bootstrap::askpass::is_host_unreachable(line)
        || [
            "not responding",
            "timed out",
            "connection closed by",
            "connection reset by",
            "closed by remote host",
            "broken pipe",
            "host is down",
            "can't assign requested address",
        ]
        .iter()
        .any(|w| lower.contains(w))
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

    /// A cause the catch-all has no name for keeps ssh's own words; a plain network
    /// failure, a refused key and a changed host key keep their fixed sentences.
    #[test]
    fn describe_with_detail_keeps_sshs_line_for_an_unexplained_unreachable_close() {
        let remote_command = lines(&["Cannot execute command-line and remote command."]);
        assert_eq!(
            describe_with_detail(SshLinkIssue::Unreachable, &remote_command),
            "could not reach the server (ssh: Cannot execute command-line and remote command.)"
        );
        let perms = lines(&["Bad owner or permissions on /Users/u/.ssh/config", ""]);
        assert_eq!(
            describe_with_detail(SshLinkIssue::Unreachable, &perms),
            "could not reach the server (ssh: Bad owner or permissions on /Users/u/.ssh/config)"
        );
        let refused = lines(&["ssh: connect to host h port 22: Connection refused"]);
        assert_eq!(describe_with_detail(SshLinkIssue::Unreachable, &refused), "could not reach the server");
        assert_eq!(describe_with_detail(SshLinkIssue::Unreachable, &[]), "could not reach the server");
        assert_eq!(
            describe_with_detail(SshLinkIssue::KeyRefused, &remote_command),
            describe(SshLinkIssue::KeyRefused)
        );
        assert_eq!(
            describe_with_detail(SshLinkIssue::HostKeyChanged, &remote_command),
            describe(SshLinkIssue::HostKeyChanged)
        );
        let hostile = lines(&[&format!("\u{1b}[31m{}", "x".repeat(500))]);
        let kept = unexplained_failure_line(&hostile).unwrap();
        assert!(kept.chars().count() <= 200 && !kept.contains('\u{1b}'), "{kept}");
    }

    /// A link that simply died keeps the plain sentence: ssh's own words for it (the
    /// ServerAlive deadline, a reset, a close, a broken pipe) say nothing "could not reach
    /// the server" does not — and the ServerAlive one must never let the remote login
    /// shell's last complaint above it pass for the reason. A server's own DISCONNECT
    /// reason, which ssh follows with a bare "Disconnected from …", is still named.
    #[test]
    fn unexplained_failure_line_leaves_a_dead_link_to_the_plain_sentence() {
        for tail in [
            &["stty: 'standard input': Inappropriate ioctl for device", "Timeout, server 100.64.0.7 not responding."][..],
            &["Connection closed by 100.64.0.7 port 22"],
            &["Connection reset by 100.64.0.7 port 22"],
            &["Connection to 100.64.0.7 port 22 timed out"],
            &["Read from remote host 100.64.0.7: Operation timed out"],
            &["Connection to 100.64.0.7 closed by remote host."],
            &["client_loop: send disconnect: Broken pipe"],
            &["Connection to 100.64.0.7 port 22: Broken pipe"],
            &["ssh: connect to host 100.64.0.7 port 22: Host is down"],
            &["ssh: connect to host 100.64.0.7 port 22: Can't assign requested address"],
            &["Connection timed out during banner exchange"],
        ] {
            assert_eq!(
                describe_with_detail(SshLinkIssue::Unreachable, &lines(tail)),
                "could not reach the server",
                "{tail:?}",
            );
        }
        assert_eq!(
            describe_with_detail(
                SshLinkIssue::Unreachable,
                &lines(&[
                    "Received disconnect from 100.64.0.7 port 22:2: tailnet policy does not permit you to SSH to this node",
                    "Disconnected from 100.64.0.7 port 22",
                ]),
            ),
            "could not reach the server (ssh: Received disconnect from 100.64.0.7 port 22:2: tailnet policy does not \
             permit you to SSH to this node)",
        );
        // A server whose sshd drops the connection before its banner (fail2ban, MaxStartups)
        // is not an outage: its own line stays.
        assert_eq!(
            describe_with_detail(SshLinkIssue::Unreachable, &lines(&["kex_exchange_identification: read: Connection reset by peer"])),
            "could not reach the server (ssh: kex_exchange_identification: read: Connection reset by peer)",
        );
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

    /// Real OpenSSH_10.3 stderr against a server with `MaxAuthTries 2` offered four keys
    /// — the reason line, then the `Disconnected from` trailer.
    #[test]
    fn key_refused_for_too_many_authentication_failures() {
        assert_eq!(
            classify_transport_close(
                Some(255),
                &lines(&[
                    "Received disconnect from 127.0.0.1 port 22999:2: Too many authentication failures",
                    "Disconnected from 127.0.0.1 port 22999",
                ]),
            ),
            Some(SshLinkIssue::KeyRefused),
        );
    }

    #[test]
    fn is_key_refusal_text_only_for_a_refused_identity() {
        assert!(is_key_refusal_text("Could not connect over SSH: admin@h: Permission denied (publickey)."));
        assert!(is_key_refusal_text(
            "Could not connect over SSH: Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures"
        ));
        assert!(!is_key_refusal_text("ssh command timed out"));
        assert!(!is_key_refusal_text("Could not connect over SSH: ssh: connect to host h port 22: Operation timed out"));
        assert!(!is_key_refusal_text("Could not connect over SSH: Host key verification failed."));
        assert!(!is_key_refusal_text("Could not connect over SSH: Disconnected from 1.2.3.4 port 22"));
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
