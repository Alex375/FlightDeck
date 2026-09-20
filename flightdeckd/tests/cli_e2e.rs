//! The CLI end to end against a real `flightdeckd run` (temp HOME, a fake
//! claude, an unreachable relay): attach --title, status, add-phone /
//! remove-phone, whoami.

use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn fd(home: &Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_flightdeckd"));
    c.env("HOME", home).stderr(Stdio::null());
    c
}

fn run_ok(c: &mut Command, stdin: Option<&str>) -> Value {
    c.stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = c.spawn().unwrap();
    if let Some(s) = stdin {
        child.stdin.take().unwrap().write_all(s.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "command failed: {:?}", String::from_utf8_lossy(&out.stdout));
    serde_json::from_slice(&out.stdout).unwrap()
}

/// `flightdeckd attach`: returns the conversation id from fd_attach, then
/// closes stdin (the bridge exits, the session lives on).
fn attach(home: &Path, args: &[&str]) -> String {
    let mut child = fd(home).arg("attach").args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["type"], "fd_attach", "{line}");
    drop(child.stdin.take());
    child.wait().unwrap();
    v["conversation"].as_str().unwrap().to_string()
}

fn title_in_status(home: &Path, conv: &str) -> String {
    let st = run_ok(fd(home).arg("status"), None);
    let row = st["conversations"].as_array().unwrap().iter().find(|c| c["conversation"] == conv).unwrap();
    row["title"].as_str().unwrap().to_string()
}

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn cli_end_to_end() {
    let home = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let home = home.path();
    let work = home.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let fake = home.join("fake-claude");
    std::fs::write(&fake, "#!/bin/sh\necho '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sid-e2e\"}'\ncat >/dev/null\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(fd(home).args(["init", "--relay", "http://127.0.0.1:9", "--label", "e2e"]).stdout(Stdio::null()).status().unwrap().success());
    let cfg_path = home.join(".flightdeckd/config.json");
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(&cfg_path).unwrap()).unwrap();
    cfg["claude_bin"] = Value::String(fake.to_string_lossy().into());
    std::fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    std::fs::set_permissions(&cfg_path, std::fs::Permissions::from_mode(0o664)).unwrap(); // like josty-cc's

    // whoami needs no daemon and never prints the secret
    let who = run_ok(fd(home).arg("whoami"), None);
    assert_eq!(who, serde_json::json!({"mac_id": cfg["mac_id"], "relay_url": "http://127.0.0.1:9", "label": "e2e"}));

    let _daemon = Daemon(fd(home).arg("run").stdout(Stdio::null()).spawn().unwrap());
    let t0 = Instant::now();
    while !home.join(".flightdeckd/flightdeckd.sock").exists() {
        assert!(t0.elapsed() < Duration::from_secs(10), "daemon never opened its socket");
        std::thread::sleep(Duration::from_millis(20));
    }

    // The config was rewritten above with the default umask (0644 here): the
    // daemon narrows it back to owner-only on start.
    assert_eq!(std::fs::metadata(&cfg_path).unwrap().permissions().mode() & 0o777, 0o600);

    let cwd = work.to_string_lossy().to_string();
    let conv = attach(home, &["--cwd", &cwd, "--title", "My Feature"]);
    assert_eq!(title_in_status(home, &conv), "My Feature");
    attach(home, &["--conversation", &conv, "--title", "Renamed"]);
    assert_eq!(title_in_status(home, &conv), "Renamed");

    let added = run_ok(fd(home).args(["add-phone", "--token", "-", "--label", "Pixel"]), Some("pt-e2e\n"));
    assert_eq!(added, serde_json::json!({"type": "fd_phone_added", "ok": true, "added": true}));
    let disk: Value = serde_json::from_slice(&std::fs::read(&cfg_path).unwrap()).unwrap();
    assert!(disk["phone_tokens"].as_array().unwrap().iter().any(|p| p["token"] == "pt-e2e" && p["label"] == "Pixel"));
    let removed = run_ok(fd(home).args(["remove-phone", "--token", "pt-e2e"]), None);
    assert_eq!(removed, serde_json::json!({"type": "fd_phone_removed", "ok": true, "removed": true}));
    let empty = fd(home).args(["add-phone", "--token", "-"]).stdin(Stdio::null()).stdout(Stdio::null()).status().unwrap();
    assert!(!empty.success(), "an empty token must fail the CLI");
}

/// A phone secret on the command line works but is flagged (argv is
/// world-readable); `--token -` stays quiet. No daemon needed: the warning
/// comes before the socket connect, which then fails.
#[test]
fn a_token_on_the_command_line_is_flagged_stdin_is_not() {
    let home = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let run = |args: &[&str], stdin: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_flightdeckd"))
            .args(args)
            .env("HOME", home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stderr).unwrap()
    };
    for verb in ["add-phone", "remove-phone"] {
        let err = run(&[verb, "--token", "s3cret"], "");
        assert!(err.contains("visible to every user"), "{verb}: {err}");
        assert!(err.contains("--token -"), "{verb}: {err}");
        let err = run(&[verb, "--token", "-"], "s3cret\n");
        assert!(!err.contains("visible to every user"), "{verb}: {err}");
        assert!(err.contains("not running"), "{verb}: {err}");
    }
}
