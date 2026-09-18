//! Pure text generators for provisioning a remote `flightdeckd` install: the two
//! systemd unit files and the one script that needs `sudo` on the target host. Every
//! function here is a pure string builder — no I/O, no process spawn — so they are
//! exhaustively covered by golden-string tests instead of a live SSH fixture.
//!
//! ## Why `shq()` is used selectively here, not uniformly
//!
//! The brief for this module says to reuse the crate's `shq()` POSIX shell-quoting
//! helper "for every interpolation". That is exactly right for
//! [`render_persistence_escalation`] — it IS a real shell one-liner, executed by a
//! real shell on the server. It is WRONG for a systemd unit file's `User=` directive:
//! a unit file is not a shell script, and systemd's own value parser for `User=`
//! (`config_parse_user_group`) does not strip shell quoting the way its `ExecStart=`/
//! `Environment=` parsers do (those two use the same shell-like tokenizer as command
//! lines, and DO honour `shq()`-style single quotes, including PARTIAL quoting inside
//! a larger token like `PATH=/usr/local/bin:'/home/j oe'/.local/bin:...`).
//!
//! This was verified empirically against the real reference server (Ubuntu 20.04,
//! systemd 245, `josty-cc`) rather than assumed: writing a transient unit with
//! `User='josty'` and running `systemd-analyze verify` on it logs *"Accepting
//! user/group name ''josty'', which does not match strict user/group name rules"* —
//! i.e. systemd takes the quote characters as part of the literal username, so the
//! service fails to resolve a real user. Both `ExecStart='/bin/echo' hi` and
//! `Environment=HOME='/home/jos ty'` were confirmed, by actually running a transient
//! `systemctl --user` unit and reading its output back, to unquote correctly. So:
//! `home` — always used inside `ExecStart=`/`Environment=` — is `shq()`-escaped in
//! both unit renderers below; `user` — used bare on a `User=` line — is NOT, and is
//! only `shq()`-escaped where it lands in the one real shell script
//! ([`render_persistence_escalation`]).
//!
//! [`render_system_unit`] otherwise mirrors, line for line, the unit file already
//! running the real `flightdeckd` on `josty-cc` (fetched 2026-09-18, read-only, over
//! the existing SSH pairing — nothing was installed or changed on that box).
//!
//! ## Newline injection is a SEPARATE hazard from shell quoting
//!
//! `shq()` only defends shell-lexer interpolation (the hazard above). A systemd unit
//! file is parsed line by line, BEFORE any value-level tokenization — an embedded
//! `\n`/`\r` byte in `user` or `home` starts a brand-new `KEY=VALUE` line of its own,
//! regardless of any `shq()` quoting wrapped around the value (quoting a string with
//! `'...'` does not stop a literal newline INSIDE it from still being a newline once
//! that string lands in a line-oriented file rather than a shell argv). Verified
//! against `systemd-analyze verify` (systemd 252): a `user`/`home` containing
//! `\nExecStartPre=...` produces a syntactically valid, silently-accepted extra
//! directive in the rendered unit. Both renderers below therefore reject a `user`/
//! `home` carrying `\n` or `\r` up front — fail closed rather than emit a unit file
//! that isn't the one line of text its caller asked for.

use crate::ipc::commands::shq;

/// A `user`/`home` value that cannot be safely rendered into a systemd unit file: it
/// carries an embedded `\n`/`\r`, which would start a new, uncontrolled `KEY=VALUE`
/// line in the rendered file (see the module doc's "Newline injection" note) — a
/// hazard `shq()`'s shell-style quoting does not cover, since a unit file is parsed
/// line by line, not by a shell lexer.
#[derive(Debug, PartialEq, Eq)]
pub struct UnsafeUnitValue {
    /// Which parameter failed the check (`"user"` or `"home"`), for the error text.
    pub field: &'static str,
}

impl std::fmt::Display for UnsafeUnitValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} contains a newline or carriage return and cannot be safely rendered into a systemd unit file",
            self.field
        )
    }
}

impl std::error::Error for UnsafeUnitValue {}

/// Rejects a value carrying `\n`/`\r` before it is interpolated into a unit-file
/// line — the one check both unit renderers share.
fn reject_unit_line_break(field: &'static str, value: &str) -> Result<(), UnsafeUnitValue> {
    if value.contains('\n') || value.contains('\r') {
        return Err(UnsafeUnitValue { field });
    }
    Ok(())
}

/// systemd **user** unit for `flightdeckd` (installed at
/// `~/.config/systemd/user/flightdeckd.service`, enabled with
/// `systemctl --user enable --now flightdeckd`). No `sudo` needed to install or
/// manage a user unit — this is the no-escalation install path; the [`String`]
/// returned here is the unit's byte-for-byte contents.
///
/// `home` lands inside `ExecStart=`, whose tokenizer honours `shq()`'s single-quote
/// escaping (see the module doc), so a home directory with a space or a shell
/// metacharacter in it still resolves to the right, single path — it does not need to
/// be a "normal" path for this to stay correct. It still must not carry an embedded
/// newline (see the module doc); this returns [`UnsafeUnitValue`] rather than emit an
/// injectable unit file.
pub fn render_user_unit(home: &str) -> Result<String, UnsafeUnitValue> {
    reject_unit_line_break("home", home)?;
    let home = shq(home);
    Ok(format!(
        "[Unit]\n\
         Description=Flight Deck server daemon (flightdeckd)\n\
         \n\
         [Service]\n\
         ExecStart={home}/.local/bin/flightdeckd run\n\
         Restart=always\n\
         RestartSec=3\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    ))
}

/// systemd **system** unit for `flightdeckd` (installed at
/// `/etc/systemd/system/flightdeckd.service`, enabled with
/// `sudo systemctl enable --now flightdeckd`) — the shape actually running on the
/// real reference server (see the module doc). Placing the unit file itself still
/// needs root (it writes under `/etc`), but that is a plain privileged file write done
/// by a later task, not a script this module renders — the ONE thing in this whole
/// flow that this module renders as needing `sudo` is
/// [`render_persistence_escalation`].
///
/// `user` sits on a bare `User=` line (systemd does not shell-unquote that directive
/// — see the module doc) so it is interpolated RAW; `home` sits inside `Environment=`/
/// `ExecStart=` (both DO shell-unquote) so it is `shq()`-escaped, matching the real
/// file's `PATH` line, which threads a quoted home in between two unquoted,
/// colon-separated literal segments. Neither may carry an embedded newline (see the
/// module doc); this returns [`UnsafeUnitValue`] rather than emit an injectable unit
/// file.
pub fn render_system_unit(user: &str, home: &str) -> Result<String, UnsafeUnitValue> {
    reject_unit_line_break("user", user)?;
    reject_unit_line_break("home", home)?;
    let home = shq(home);
    Ok(format!(
        "[Unit]\n\
         Description=Flight Deck server daemon (flightdeckd)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         User={user}\n\
         Environment=HOME={home}\n\
         Environment=PATH=/usr/local/bin:{home}/.local/bin:/usr/bin:/bin\n\
         ExecStart=/usr/local/bin/flightdeckd run\n\
         Restart=always\n\
         RestartSec=3\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n"
    ))
}

/// The ONE command in the whole bootstrap flow that needs `sudo` on the target host:
/// linger (so `flightdeckd` keeps running after the SSH session that installed it
/// closes, without waiting for an interactive login) and masking every sleep/suspend
/// target (so a rebooted or GUI-driven box never suspends itself out from under the
/// daemon — the exact trap hit on `josty-cc`, see the `flightdeck-server-test-box`
/// memory). Installing the daemon binary/unit itself needs no `sudo`; only THIS one
/// step, scoped to exactly these two commands, does.
///
/// Returns the bare command text (no `sudo` prefix baked in): a later task pipes a
/// captured password to `sudo -S` over the already-open SSH session and runs this
/// string as that `sudo`'s argument, mirroring how [`crate::bootstrap::askpass`]
/// itself never touches `sudo` — it only unblocks the ssh client's OWN login prompt.
pub fn render_persistence_escalation(user: &str) -> String {
    format!(
        "loginctl enable-linger {u} && \
         systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
        u = shq(user)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_unit_golden_string() {
        let got = render_user_unit("/home/alex").expect("plain home must render");
        let want = "[Unit]\n\
                     Description=Flight Deck server daemon (flightdeckd)\n\
                     \n\
                     [Service]\n\
                     ExecStart='/home/alex'/.local/bin/flightdeckd run\n\
                     Restart=always\n\
                     RestartSec=3\n\
                     \n\
                     [Install]\n\
                     WantedBy=default.target\n";
        assert_eq!(got, want);
    }

    /// Byte-for-byte against the file fetched from `josty-cc`'s
    /// `/etc/systemd/system/flightdeckd.service` (User/HOME substituted to the same
    /// account it runs under there).
    #[test]
    fn system_unit_matches_the_real_server() {
        let got = render_system_unit("josty", "/home/josty").expect("plain user/home must render");
        let want = "[Unit]\n\
                     Description=Flight Deck server daemon (flightdeckd)\n\
                     After=network-online.target\n\
                     Wants=network-online.target\n\
                     \n\
                     [Service]\n\
                     User=josty\n\
                     Environment=HOME='/home/josty'\n\
                     Environment=PATH=/usr/local/bin:'/home/josty'/.local/bin:/usr/bin:/bin\n\
                     ExecStart=/usr/local/bin/flightdeckd run\n\
                     Restart=always\n\
                     RestartSec=3\n\
                     \n\
                     [Install]\n\
                     WantedBy=multi-user.target\n";
        assert_eq!(got, want);
    }

    /// An embedded newline in `home` must be REJECTED, not silently rendered — a raw
    /// `\n` would start a brand-new, uncontrolled `KEY=VALUE` line in the unit file
    /// regardless of `shq()`'s shell-style quoting (see the module doc's "Newline
    /// injection" note). Both renderers share this check.
    #[test]
    fn user_unit_rejects_a_newline_in_home() {
        let evil = "/home/alex\nExecStartPre=/bin/touch /tmp/PWNED";
        let err = render_user_unit(evil).expect_err("a newline in home must be rejected");
        assert_eq!(err, UnsafeUnitValue { field: "home" });
    }

    #[test]
    fn system_unit_rejects_a_newline_in_user() {
        let evil = "josty\nExecStartPre=/bin/touch /tmp/PWNED\n#";
        let err = render_system_unit(evil, "/home/josty").expect_err("a newline in user must be rejected");
        assert_eq!(err, UnsafeUnitValue { field: "user" });
    }

    #[test]
    fn system_unit_rejects_a_newline_in_home() {
        let evil = "/home/x\nExecStartPre=/bin/touch /tmp/PWNED\n#";
        let err = render_system_unit("josty", evil).expect_err("a newline in home must be rejected");
        assert_eq!(err, UnsafeUnitValue { field: "home" });
    }

    /// A carriage return is just as much a line terminator to a line-oriented parser
    /// as `\n` is — reject it too, on either field.
    #[test]
    fn system_unit_rejects_a_carriage_return_in_either_field() {
        assert_eq!(
            render_system_unit("jos\rty", "/home/josty").unwrap_err(),
            UnsafeUnitValue { field: "user" }
        );
        assert_eq!(
            render_system_unit("josty", "/home/jos\rty").unwrap_err(),
            UnsafeUnitValue { field: "home" }
        );
    }

    #[test]
    fn persistence_escalation_golden_string() {
        let got = render_persistence_escalation("josty");
        let want = "loginctl enable-linger 'josty' && \
                     systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target";
        assert_eq!(got, want);
    }

    /// A username carrying shell metacharacters (a space, and a command substitution)
    /// run through `render_persistence_escalation` must come out `shq()`-quoted, so a
    /// shell evaluating the rendered line treats it as one inert literal string, never
    /// as code to run.
    #[test]
    fn persistence_escalation_shell_metacharacter_username_is_shq_safe() {
        let evil = "al $(rm -rf /) ex";
        let got = render_persistence_escalation(evil);

        // Matches exactly what `shq()` produces for this input: single-quoted, with
        // the whole malicious payload inert INSIDE the quotes (no unescaped `'`
        // anywhere in `evil`, so no `'\''` splice is needed here).
        let want = format!(
            "loginctl enable-linger '{evil}' && \
             systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
        );
        assert_eq!(got, want);

        // And the defining property of `shq()`-quoting, checked directly rather than
        // by scanning for metacharacters (the template's OWN `&&` between the two
        // real commands would otherwise register as a false "leak"): the quoted
        // payload appears intact exactly once, and removing that one occurrence
        // leaves NOTHING of `evil` behind — i.e. every metacharacter from `evil` is
        // accounted for inside the quotes, not duplicated or dangling outside them.
        let quoted = format!("'{evil}'");
        assert_eq!(got.matches(&quoted).count(), 1, "the escaped username must appear intact, exactly once");
        let skeleton = got.replacen(&quoted, "<USER>", 1);
        assert_eq!(
            skeleton,
            "loginctl enable-linger <USER> && \
             systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
            "everything outside the quoted username must be exactly the fixed template"
        );
    }

    /// A username carrying an embedded single quote (the one character `shq()` must
    /// itself escape, via the `'\''` splice) still comes out safe.
    #[test]
    fn persistence_escalation_embedded_single_quote_is_shq_safe() {
        let evil = "o'brien";
        let got = render_persistence_escalation(evil);
        let want = "loginctl enable-linger 'o'\\''brien' && \
                     systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target";
        assert_eq!(got, want);
    }

    #[test]
    fn user_unit_home_with_space_is_shq_safe() {
        let got = render_user_unit("/home/jos ty").expect("a space is not a line break");
        assert!(got.contains("ExecStart='/home/jos ty'/.local/bin/flightdeckd run"));
    }
}
