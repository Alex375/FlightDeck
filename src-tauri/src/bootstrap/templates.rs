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
/// closes, without waiting for an interactive login) and — when `mask_sleep` — masking
/// every sleep/suspend target (so a rebooted or GUI-driven box never suspends itself
/// out from under the daemon — the exact trap hit on `josty-cc`, see the
/// `flightdeck-server-test-box` memory). Installing the daemon binary/unit itself needs
/// no `sudo`; only THIS one step, scoped to exactly these commands, does.
///
/// `mask_sleep` is Armand's product decision (B9): an opt-out checkbox, DEFAULT ON,
/// applied to root logins too — this is a genuine, deliberate behavior CHANGE (masking
/// sleep targets is not something every box wants, e.g. a laptop dev box someone still
/// wants to suspend by hand), which is exactly why it is a parameter here rather than
/// baked in unconditionally the way it used to be.
///
/// Returns the bare command text (no `sudo` prefix baked in):
/// [`crate::bootstrap::install::escalate_persistence`] pipes a captured password to
/// `sudo -S` over the already-open SSH session and runs this string as that `sudo`'s
/// argument, mirroring how [`crate::bootstrap::askpass`] itself never touches `sudo` —
/// it only unblocks the ssh client's OWN login prompt.
pub fn render_persistence_escalation(user: &str, mask_sleep: bool) -> String {
    let linger = format!("loginctl enable-linger {u}", u = shq(user));
    if mask_sleep {
        format!(
            "{linger} && \
             systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
        )
    } else {
        linger
    }
}

/// (B8) The remote script that resolves where the daemon binary already lives (or
/// should live) on a server, mirroring `bootstrap::connect::PROBE_SCRIPT`'s own
/// CONFLICT precedence: an existing root-owned system unit, or a pre-existing
/// `/usr/local/bin/flightdeckd`, or a `flightdeckd` resolved from `PATH` OUTSIDE
/// `~/.local/bin`, all mean "adopt whatever is already there" — reported back as the
/// TARGET path itself (this script needs the actual path, not just a human sentence,
/// so it is NOT literally shared with `PROBE_SCRIPT`, just kept in lockstep with its
/// CONFLICT logic). Otherwise the target is the plain fresh-install default: for ROOT
/// (`id -u` = 0) that is `/usr/local/bin/flightdeckd` — matching what
/// [`render_system_unit`]'s (fixed, unparameterized) `ExecStart=` line ALWAYS expects,
/// so a fresh root install's unit is never pointed at a binary that was actually
/// uploaded somewhere else (root has no meaningful "user-level" install distinct from
/// a system one — VERIFIED live against fixture B: without this branch a fresh root
/// install crash-loops with `code=exited, status=203/EXEC`, systemd's own wording for
/// "the file named in `ExecStart=` does not exist") — for anyone else it is
/// `~/.local/bin/flightdeckd`. Reports the target's CURRENT sha256 too (empty when
/// nothing is there yet) so [`crate::bootstrap::install::upload_daemon`] can decide
/// `AlreadyCurrent` without ever touching the network for the bytes themselves. No
/// interpolation, so this is a fixed constant.
pub const RESOLVE_DAEMON_TARGET_SCRIPT: &str = r#"set -e
if [ -f /etc/systemd/system/flightdeckd.service ]; then
    TARGET=/usr/local/bin/flightdeckd
elif [ -x /usr/local/bin/flightdeckd ]; then
    TARGET=/usr/local/bin/flightdeckd
elif command -v flightdeckd >/dev/null 2>&1; then
    FDD=$(command -v flightdeckd)
    case "$FDD" in
        "$HOME"/.local/bin/flightdeckd) TARGET="$HOME/.local/bin/flightdeckd" ;;
        *) TARGET="$FDD" ;;
    esac
elif [ "$(id -u)" = "0" ]; then
    TARGET=/usr/local/bin/flightdeckd
else
    TARGET="$HOME/.local/bin/flightdeckd"
fi
echo "FLIGHTDECK_TARGET:$TARGET"
if [ -f "$TARGET" ]; then
    SHA=$(sha256sum "$TARGET" 2>/dev/null | awk '{print $1}')
    echo "FLIGHTDECK_TARGET_SHA256:$SHA"
else
    echo "FLIGHTDECK_TARGET_SHA256:"
fi
"#;

/// (B8) Streams a new daemon binary into place at `target`: a private (mode 600, via
/// `umask 077`) temp file `.flightdeckd.upload.$$` in the SAME directory (so the final
/// `mv` below is an atomic same-filesystem rename — replacing a RUNNING daemon's binary
/// this way is safe because the process keeps its old inode open, unlike an in-place
/// truncate-and-rewrite), read back and verified by SIZE **and** SHA256 before it is
/// EVER promoted over `target` — a truncated transfer (a dropped connection, a short
/// write) looks like an ordinary, successful `cat` to the shell (EOF is EOF, not an
/// error), so this never trusts the write's own exit code alone. On any mismatch the
/// temp file is removed and the script fails loudly (`FLIGHTDECK_UPLOAD_MISMATCH`) —
/// never a false success. See [`crate::bootstrap::install::upload_daemon`]'s own doc.
///
/// `target` is `shq()`-escaped here (mirroring every other real-path interpolation in
/// this module). `expected_size`/`expected_sha256` come from THIS Mac's own read of the
/// exact bytes about to be piped in over stdin — never off the wire — so they are safe
/// to interpolate as plain digits / a 64-char lowercase hex digest without further
/// escaping.
pub fn render_upload_script(target: &str, expected_size: u64, expected_sha256: &str) -> String {
    let target = shq(target);
    format!(
        "set -e\n\
         TARGET={target}\n\
         DIR=$(dirname \"$TARGET\")\n\
         mkdir -p -m 755 \"$DIR\" 2>/dev/null || {{ echo FLIGHTDECK_MKDIR_FAILED >&2; exit 5; }}\n\
         TMP=\"$DIR/.flightdeckd.upload.$$\"\n\
         umask 077\n\
         cat > \"$TMP\" 2>/dev/null || {{ rm -f \"$TMP\" 2>/dev/null; echo FLIGHTDECK_WRITE_FAILED >&2; exit 5; }}\n\
         GOT_SIZE=$(wc -c < \"$TMP\" 2>/dev/null | tr -d ' ')\n\
         GOT_SHA=$(sha256sum \"$TMP\" 2>/dev/null | awk '{{print $1}}')\n\
         echo \"FLIGHTDECK_GOT_SIZE:$GOT_SIZE\"\n\
         echo \"FLIGHTDECK_GOT_SHA256:$GOT_SHA\"\n\
         if [ \"$GOT_SIZE\" != \"{expected_size}\" ] || [ \"$GOT_SHA\" != \"{expected_sha256}\" ]; then\n\
         \x20   rm -f \"$TMP\" 2>/dev/null\n\
         \x20   echo FLIGHTDECK_UPLOAD_MISMATCH >&2\n\
         \x20   exit 6\n\
         fi\n\
         chmod 755 \"$TMP\"\n\
         mv -f \"$TMP\" \"$TARGET\"\n\
         echo FLIGHTDECK_UPLOAD_OK\n"
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
        let got = render_persistence_escalation("josty", true);
        let want = "loginctl enable-linger 'josty' && \
                     systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target";
        assert_eq!(got, want);
    }

    /// (B9) `mask_sleep: false` is the opt-out — linger alone, no sleep-target masking.
    #[test]
    fn persistence_escalation_without_mask_sleep_is_linger_only() {
        let got = render_persistence_escalation("josty", false);
        assert_eq!(got, "loginctl enable-linger 'josty'");
    }

    /// A username carrying shell metacharacters (a space, and a command substitution)
    /// run through `render_persistence_escalation` must come out `shq()`-quoted, so a
    /// shell evaluating the rendered line treats it as one inert literal string, never
    /// as code to run.
    #[test]
    fn persistence_escalation_shell_metacharacter_username_is_shq_safe() {
        let evil = "al $(rm -rf /) ex";
        let got = render_persistence_escalation(evil, true);

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
        let got = render_persistence_escalation(evil, true);
        let want = "loginctl enable-linger 'o'\\''brien' && \
                     systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target";
        assert_eq!(got, want);
    }

    #[test]
    fn user_unit_home_with_space_is_shq_safe() {
        let got = render_user_unit("/home/jos ty").expect("a space is not a line break");
        assert!(got.contains("ExecStart='/home/jos ty'/.local/bin/flightdeckd run"));
    }

    // ---- RESOLVE_DAEMON_TARGET_SCRIPT / render_upload_script (B8) ----

    /// Independent literal copy — proves the shipped text hasn't drifted, mirroring
    /// `connect.rs`'s own `install_key_script_is_the_reviewed_golden_string` discipline
    /// for its fixed, no-interpolation sibling script.
    #[test]
    fn resolve_daemon_target_script_is_the_reviewed_golden_string() {
        let expected = r#"set -e
if [ -f /etc/systemd/system/flightdeckd.service ]; then
    TARGET=/usr/local/bin/flightdeckd
elif [ -x /usr/local/bin/flightdeckd ]; then
    TARGET=/usr/local/bin/flightdeckd
elif command -v flightdeckd >/dev/null 2>&1; then
    FDD=$(command -v flightdeckd)
    case "$FDD" in
        "$HOME"/.local/bin/flightdeckd) TARGET="$HOME/.local/bin/flightdeckd" ;;
        *) TARGET="$FDD" ;;
    esac
elif [ "$(id -u)" = "0" ]; then
    TARGET=/usr/local/bin/flightdeckd
else
    TARGET="$HOME/.local/bin/flightdeckd"
fi
echo "FLIGHTDECK_TARGET:$TARGET"
if [ -f "$TARGET" ]; then
    SHA=$(sha256sum "$TARGET" 2>/dev/null | awk '{print $1}')
    echo "FLIGHTDECK_TARGET_SHA256:$SHA"
else
    echo "FLIGHTDECK_TARGET_SHA256:"
fi
"#;
        assert_eq!(RESOLVE_DAEMON_TARGET_SCRIPT, expected);
    }

    /// A fresh root login (nothing pre-existing at all) must resolve to
    /// `/usr/local/bin/flightdeckd`, NEVER `~/.local/bin/flightdeckd` — the exact
    /// live-verified regression this branch exists to prevent (see this constant's
    /// own doc): `render_system_unit`'s `ExecStart=` is a fixed literal that only ever
    /// points at `/usr/local/bin/flightdeckd`, so a fresh root install uploaded
    /// anywhere else would crash-loop on `status=203/EXEC`. Runs the REAL, unmodified
    /// script text through a real `sh`, with a local `id() { echo 0; }` shadowing the
    /// real `id` builtin/binary to simulate root WITHOUT needing to actually be root
    /// or edit the script text at all.
    #[test]
    fn resolve_daemon_target_script_sends_a_fresh_root_login_to_usr_local_bin() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("id() {{ echo 0; }}\nHOME=/root\n{RESOLVE_DAEMON_TARGET_SCRIPT}"))
            .output()
            .expect("sh must be available to exercise this golden script directly");
        assert!(out.status.success(), "script failed: {}", String::from_utf8_lossy(&out.stderr));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("FLIGHTDECK_TARGET:/usr/local/bin/flightdeckd"),
            "expected the root fallback target, got: {stdout}"
        );
    }

    /// The same fresh-install case for a NON-root login stays at the plain
    /// `~/.local/bin/flightdeckd` default — proves the new root branch didn't widen
    /// beyond root.
    #[test]
    fn resolve_daemon_target_script_sends_a_fresh_non_root_login_to_local_bin() {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("HOME=/home/deploy; {RESOLVE_DAEMON_TARGET_SCRIPT}"))
            .output()
            .expect("sh must be available to exercise this golden script directly");
        assert!(out.status.success(), "script failed: {}", String::from_utf8_lossy(&out.stderr));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("FLIGHTDECK_TARGET:/home/deploy/.local/bin/flightdeckd"),
            "expected the plain non-root default, got: {stdout}"
        );
    }

    #[test]
    fn upload_script_interpolates_target_size_and_sha() {
        let got = render_upload_script("/home/deploy/.local/bin/flightdeckd", 12345, "a".repeat(64).as_str());
        assert!(got.contains("TARGET='/home/deploy/.local/bin/flightdeckd'"));
        assert!(got.contains(r#"[ "$GOT_SIZE" != "12345" ]"#));
        assert!(got.contains(&format!(r#"[ "$GOT_SHA" != "{}" ]"#, "a".repeat(64))));
        assert!(got.contains("umask 077"));
        assert!(got.contains(r#"TMP="$DIR/.flightdeckd.upload.$$""#));
        assert!(got.contains("mv -f \"$TMP\" \"$TARGET\""));
        assert!(got.contains("echo FLIGHTDECK_UPLOAD_OK"));
    }

    /// A target path carrying a shell metacharacter comes out `shq()`-quoted, same
    /// discipline as every other real-path interpolation in this module.
    #[test]
    fn upload_script_target_is_shq_safe() {
        let evil = "/home/al $(rm -rf /) ex/.local/bin/flightdeckd";
        let got = render_upload_script(evil, 1, "b".repeat(64).as_str());
        assert!(got.contains(&format!("TARGET='{evil}'")));
    }
}
