//! Copying a composer attachment TO a paired server — the one writer next to this module's
//! readers.
//!
//! A file attached to a conversation that runs on a server (the composer's "+", a Finder drop) is
//! a file on THIS Mac: its path means nothing to the agent, which reads the SERVER's disk. At best
//! it answers "no such file"; at worst — the same repository at the same path on both machines, a
//! common setup — the mention resolves on the server to a DIFFERENT file, and the agent reads it
//! without a word. So the file is copied there first, and the composer mentions the server path.
//! (Images never come here: they travel in-band, base64, inside the user message.)
//!
//! Where: `~/.cache/flightdeck/uploads/<conversation id>/<name>` on the server, created `umask 077`.
//! The name is sanitized HERE (`[A-Za-z0-9._-]`, no leading dot) and made unique THERE —
//! `notes.md`, then `notes-2.md`, … — so attaching a second file of the same name never changes
//! the one an earlier message pointed at.
//!
//! Transport: ONE `ssh … sh -c '<script>' fd-upload <args>` round trip with the bytes on stdin
//! ([`crate::ipc::commands::run_ssh_on_machine_stdin`]). Unlike the readers, the script cannot
//! ride on stdin (the bytes do), so it goes through the login shell's parser — which is why it is
//! a FIXED string with no `'`, no `\` and nothing a fish or zsh login shell would expand inside
//! single quotes; every value reaches it as a positional argument, validated here and quoted by
//! [`shq`]. Framing: one `FDUP1 ok <path>` / `FDUP1 short <bytes>` / `FDUP1 error <reason>` line;
//! anything printed before it (a chatty login script) is skipped.
//!
//! Bounded: [`UPLOAD_MAX_BYTES`] (the composer's own attachment ceiling, `fs::MAX_FILE_BYTES`),
//! checked on this Mac BEFORE any connection; [`UPLOAD_TIMEOUT`] for the whole round trip.

use std::path::Path;

use super::{sanitize, Server};
use crate::ipc::commands::shq;

/// Largest file copied to a server — the composer's attachment ceiling, the same 16 MiB the
/// editor and the image attach read path already enforce.
pub const UPLOAD_MAX_BYTES: u64 = crate::fs::MAX_FILE_BYTES;

/// How long one copy may take, end to end: handshake, SENDING the bytes (the stdin helper bounds
/// its write and its wait together) and the server's answer. 16 MiB over a slow link takes a
/// while; a wedged connection — a far side that stopped reading — must still end.
///
/// ⚠️ The composer waits on this call with its own backstop (`UPLOAD_DEADLINE_MS`,
/// `composerAttachments.ts`), which must stay LONGER than this: a front that gave up first would
/// report a failure while the copy still landed — unmentioned, and duplicated by the retry.
const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The header tag. Versioned, like the readers' `FDREAD1`.
const FRAME_TAG: &str = "FDUP1 ";

/// The server-side script, run as `sh -c SCRIPT fd-upload <conversation> <stem> <ext> <size>`.
/// ⚠️ Keep it free of `'` and `\` (it is single-quoted for the login shell) — a test checks.
/// The unique name is claimed under `set -C` (noclobber: `>` refuses an existing file), with
/// `true`, NOT `:` — a redirection error on a SPECIAL built-in makes a POSIX shell exit.
const SCRIPT: &str = r#"umask 077
D="$HOME/.cache/flightdeck/uploads/$1"
mkdir -p "$D" 2>/dev/null
if [ ! -d "$D" ] || [ ! -w "$D" ]; then echo "FDUP1 error cannot write to $D"; exit 0; fi
set -C
F="$D/$2$3"
n=1
until true 2>/dev/null > "$F"; do
  n=$((n + 1))
  if [ "$n" -gt 999 ]; then echo "FDUP1 error no free file name in $D"; exit 0; fi
  F="$D/$2-$n$3"
done
set +C
cat > "$F"
S=$(wc -c < "$F" | tr -d " ")
if [ "$S" != "$4" ]; then rm -f "$F"; echo "FDUP1 short $S"; exit 0; fi
echo "FDUP1 ok $F"
"#;

/// A file name the server-side script can take as-is: its characters reduced to
/// `[A-Za-z0-9._-]` (anything else → `_`), no leading dot (never a hidden file, never `..`),
/// capped, never empty. Returned split as (stem, extension-with-its-dot) so the script can insert
/// a `-2` before the extension.
pub(crate) fn safe_upload_name(file_name: &str) -> (String, String) {
    let mut clean: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    while clean.starts_with('.') {
        clean.remove(0);
    }
    let clean: String = clean.chars().take(120).collect();
    let (stem, ext) = match clean.rfind('.') {
        // An extension is what follows the LAST dot: short, letters and digits only, after a
        // non-empty stem (`_.._etc` has none — its last "dot part" is not an extension).
        Some(i)
            if i > 0
                && (2..=16).contains(&(clean.len() - i))
                && clean[i + 1..].bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            (clean[..i].to_string(), clean[i..].to_string())
        }
        _ => (clean.clone(), String::new()),
    };
    let stem = if stem.is_empty() { "file".to_string() } else { stem };
    (stem, ext)
}

/// A conversation id as a directory name: what the app mints (a uuid) and nothing else.
fn is_safe_conversation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The remote command line for one upload. `Err` for an id that is not a plain uuid-like token.
fn upload_command(conversation_id: &str, stem: &str, ext: &str, size: u64) -> Result<String, String> {
    if !is_safe_conversation_id(conversation_id) {
        return Err(format!("not a conversation id: {conversation_id:?}"));
    }
    Ok(format!(
        "sh -c {} fd-upload {} {} {} {}",
        shq(SCRIPT),
        shq(conversation_id),
        shq(stem),
        shq(ext),
        size
    ))
}

/// What the script answered.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Ok(String),
    Short(String),
    Error(String),
}

/// Read the script's header line (skipping anything a login script printed first).
fn parse_answer(stdout: &str) -> Option<Answer> {
    let line = stdout.lines().find_map(|l| l.strip_prefix(FRAME_TAG))?;
    let (status, rest) = line.split_once(' ').unwrap_or((line, ""));
    match status {
        "ok" if rest.starts_with('/') => Some(Answer::Ok(rest.to_string())),
        "short" => Some(Answer::Short(sanitize(rest))),
        "error" => Some(Answer::Error(sanitize(rest))),
        _ => None,
    }
}

/// Copy `local_path` (a file on THIS Mac) to `server`, under this conversation's upload folder,
/// and return its absolute path THERE. Every `Err` is a full sentence naming the file and the
/// server — the composer shows it as is.
///
/// `ssh_bin_override`: the test seam of [`crate::ipc::commands::run_ssh_on_machine_stdin`].
pub async fn upload_attachment(
    server: &Server<'_>,
    conversation_id: &str,
    local_path: &Path,
    ssh_bin_override: Option<&Path>,
) -> Result<String, String> {
    let name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| local_path.to_string_lossy().into_owned());
    let to = server.name();
    // This Mac's side first: nothing goes over the wire for a file that can't be sent.
    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("Couldn't read {name} on this Mac: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{name} is a folder — only files can be sent to {to}; attach the files inside it."));
    }
    if !meta.is_file() {
        return Err(format!("{name} is not a regular file, so it can't be sent to {to}."));
    }
    let too_large = |len: u64| {
        format!(
            "{name} is too large to send to {to} ({:.1} MiB — the limit is {} MiB).",
            len as f64 / (1024.0 * 1024.0),
            UPLOAD_MAX_BYTES / (1024 * 1024)
        )
    };
    if meta.len() > UPLOAD_MAX_BYTES {
        return Err(too_large(meta.len()));
    }
    let bytes = tokio::fs::read(local_path)
        .await
        .map_err(|e| format!("Couldn't read {name} on this Mac: {e}"))?;
    // It may have grown between the stat and the read.
    if bytes.len() as u64 > UPLOAD_MAX_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    let (stem, ext) = safe_upload_name(&name);
    let cmd = upload_command(conversation_id, &stem, &ext, bytes.len() as u64)
        .map_err(|e| format!("Couldn't send {name} to {to}: {e}"))?;
    let out = crate::ipc::commands::run_ssh_on_machine_stdin(
        server.machine,
        server.known_hosts,
        &cmd,
        &bytes,
        ssh_bin_override,
        UPLOAD_TIMEOUT,
    )
    .await
    .map_err(|e| {
        if e.contains("timed out") {
            format!(
                "Couldn't send {name} to {to}: the copy didn't finish within {}s — the link may be too slow for \
                 a file this size, or {to} stopped answering.",
                UPLOAD_TIMEOUT.as_secs()
            )
        } else {
            format!("Couldn't send {name} to {to}: {e}.")
        }
    })?;
    match parse_answer(&out.stdout) {
        Some(Answer::Ok(path)) => Ok(path),
        Some(Answer::Short(got)) => Err(format!(
            "Couldn't send {name} to {to}: the copy arrived incomplete ({got} of {} bytes) — try again.",
            bytes.len()
        )),
        Some(Answer::Error(reason)) => Err(format!("Couldn't send {name} to {to}: {reason}.")),
        None => {
            // No answer at all: ssh itself failed (exit 255 — key refused, host changed,
            // unreachable), or the shell did. Say which when we can tell.
            let stderr: Vec<String> = out.stderr.lines().map(str::to_string).collect();
            let why = match crate::ssh_link::classify_transport_close(out.exit_code, &stderr) {
                Some(issue) => crate::ssh_link::describe(issue),
                None => stderr
                    .iter()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .map(|l| sanitize(l))
                    .unwrap_or_else(|| "the server gave no answer".to_string()),
            };
            Err(format!("Couldn't send {name} to {to}: {why}."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MachineRecord;
    use std::path::PathBuf;

    fn machine() -> MachineRecord {
        MachineRecord {
            id: "m1".into(),
            label: "Base".into(),
            host: "base.example".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fd-upload-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake `ssh` that does what sshd does with a command: hands it to a shell (`sh -c`), with
    /// `home` as the login's `$HOME` — so the real upload command line runs end to end, its
    /// quoting included, against a scratch "server" home. Lives in `<dir>/bin/ssh` (the seam
    /// takes the directory holding it).
    fn fake_ssh(dir: &Path, home: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("ssh");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do last=$a; done\nHOME={}\nexport HOME\nexec /bin/sh -c \"$last\"\n",
                shq(&home.to_string_lossy())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin_dir
    }

    const CONV: &str = "3f1c9a2e-1111-4222-8333-944455556666";

    #[test]
    fn the_script_survives_single_quoting_for_the_login_shell() {
        assert!(!SCRIPT.contains('\''), "a quote would end the single-quoted script early");
        assert!(!SCRIPT.contains('\\'), "fish rewrites backslashes inside single quotes");
    }

    #[test]
    fn names_are_reduced_to_a_safe_set_and_split_at_the_extension() {
        assert_eq!(safe_upload_name("notes.md"), ("notes".into(), ".md".into()));
        assert_eq!(
            safe_upload_name("Capture d’écran 2026-09-19 à 14.03.21.pdf"),
            ("Capture_d__cran_2026-09-19___14.03.21".into(), ".pdf".into())
        );
        assert_eq!(safe_upload_name("../../etc/passwd"), ("_.._etc_passwd".into(), String::new()));
        assert_eq!(safe_upload_name(".env"), ("env".into(), String::new()));
        assert_eq!(safe_upload_name("Makefile"), ("Makefile".into(), String::new()));
        assert_eq!(safe_upload_name("'; rm -rf ~ #.sh"), ("___rm_-rf____".into(), ".sh".into()));
        assert_eq!(safe_upload_name("..."), ("file".into(), String::new()));
    }

    #[test]
    fn a_conversation_id_that_is_not_a_plain_token_is_refused_before_any_command() {
        assert!(upload_command("../x", "a", ".md", 1).is_err());
        assert!(upload_command("a b", "a", ".md", 1).is_err());
        assert!(upload_command(CONV, "a", ".md", 1).is_ok());
    }

    #[test]
    fn the_answer_header_is_found_past_login_noise() {
        assert_eq!(
            parse_answer("Welcome to Ubuntu\nFDUP1 ok /home/agent/.cache/flightdeck/uploads/c/n.md\n"),
            Some(Answer::Ok("/home/agent/.cache/flightdeck/uploads/c/n.md".into()))
        );
        assert_eq!(parse_answer("FDUP1 short 12\n"), Some(Answer::Short("12".into())));
        assert_eq!(parse_answer("FDUP1 error cannot write to /x\n"), Some(Answer::Error("cannot write to /x".into())));
        assert_eq!(parse_answer("FDUP1 ok relative/path\n"), None, "a server path is absolute");
        assert_eq!(parse_answer("nothing here\n"), None);
    }

    #[tokio::test]
    async fn a_file_lands_under_the_conversations_upload_dir_and_a_second_one_never_overwrites_it() {
        let dir = scratch("roundtrip");
        let home = dir.join("server-home");
        std::fs::create_dir_all(&home).unwrap();
        let seam = fake_ssh(&dir, &home);
        let local = dir.join("notes.md");
        std::fs::write(&local, "first").unwrap();
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };

        let first = upload_attachment(&server, CONV, &local, Some(&seam)).await.unwrap();
        let expected_dir = home.join(".cache/flightdeck/uploads").join(CONV);
        assert_eq!(PathBuf::from(&first), expected_dir.join("notes.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first");

        std::fs::write(&local, "second").unwrap();
        let second = upload_attachment(&server, CONV, &local, Some(&seam)).await.unwrap();
        assert_eq!(PathBuf::from(&second), expected_dir.join("notes-2.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first", "the earlier upload is untouched");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "second");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_awkward_file_name_reaches_the_server_sanitized() {
        let dir = scratch("awkward");
        let home = dir.join("server-home");
        std::fs::create_dir_all(&home).unwrap();
        let seam = fake_ssh(&dir, &home);
        let local = dir.join("it's a $(test) file.txt");
        std::fs::write(&local, b"bytes\x00\xff").unwrap();
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        let path = upload_attachment(&server, CONV, &local, Some(&seam)).await.unwrap();
        assert!(path.ends_with("/it_s_a___test__file.txt"), "{path}");
        assert_eq!(std::fs::read(&path).unwrap(), b"bytes\x00\xff");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_folder_or_an_oversized_file_is_refused_without_connecting() {
        let dir = scratch("refused");
        let marker = dir.join("ssh-ran");
        // An ssh that would only leave a trace — it must never run.
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        {
            use std::os::unix::fs::PermissionsExt as _;
            let bin = bin_dir.join("ssh");
            std::fs::write(&bin, format!("#!/bin/sh\ntouch {}\n", shq(&marker.to_string_lossy()))).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };

        let folder = dir.join("assets");
        std::fs::create_dir_all(&folder).unwrap();
        let err = upload_attachment(&server, CONV, &folder, Some(&bin_dir)).await.unwrap_err();
        assert!(err.contains("assets is a folder") && err.contains("Base"), "{err}");

        let big = dir.join("dump.bin");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(UPLOAD_MAX_BYTES + 1).unwrap();
        let err = upload_attachment(&server, CONV, &big, Some(&bin_dir)).await.unwrap_err();
        assert!(err.contains("too large") && err.contains("16 MiB"), "{err}");

        let err = upload_attachment(&server, CONV, &dir.join("gone.md"), Some(&bin_dir)).await.unwrap_err();
        assert!(err.contains("gone.md"), "{err}");

        assert!(!marker.exists(), "nothing may reach the server for a file that can't be sent");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_ssh_failure_is_said_with_the_servers_name() {
        let dir = scratch("sshfail");
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        {
            use std::os::unix::fs::PermissionsExt as _;
            let bin = bin_dir.join("ssh");
            std::fs::write(
                &bin,
                "#!/bin/sh\necho 'agent@base.example: Permission denied (publickey).' >&2\nexit 255\n",
            )
            .unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let local = dir.join("a.txt");
        std::fs::write(&local, "x").unwrap();
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        let err = upload_attachment(&server, CONV, &local, Some(&bin_dir)).await.unwrap_err();
        assert_eq!(err, "Couldn't send a.txt to Base: this Mac's saved key was refused by this server.");
        std::fs::remove_dir_all(&dir).ok();
    }
}
