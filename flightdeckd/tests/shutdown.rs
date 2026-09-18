//! `systemctl stop/restart` sends SIGTERM: the daemon must stop its sessions
//! through their ladder, tell attached clients, and exit cleanly.

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn sigterm_stops_sessions_gracefully_and_tells_attached_clients() {
    let home = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let home = home.path();
    let work = home.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let pidfile = home.join("claude.pid");
    let fake = home.join("fake-claude");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\necho $$ > '{}'\necho '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sid-term\"}}'\ncat >/dev/null\n",
            pidfile.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fd = |args: &[&str]| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_flightdeckd"));
        c.args(args).env("HOME", home).stderr(Stdio::null());
        c
    };
    assert!(fd(&["init", "--relay", "http://127.0.0.1:9"]).stdout(Stdio::null()).status().unwrap().success());
    let cfg_path = home.join(".flightdeckd/config.json");
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(&cfg_path).unwrap()).unwrap();
    cfg["claude_bin"] = Value::String(fake.to_string_lossy().into());
    std::fs::write(&cfg_path, serde_json::to_vec(&cfg).unwrap()).unwrap();

    let mut daemon = fd(&["run"]).stdout(Stdio::null()).spawn().unwrap();
    let socket = home.join(".flightdeckd/flightdeckd.sock");
    let t0 = Instant::now();
    while !socket.exists() {
        assert!(t0.elapsed() < Duration::from_secs(10), "daemon never opened its socket");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut bridge = fd(&["attach", "--cwd", &work.to_string_lossy()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let _stdin = bridge.stdin.take().unwrap(); // the client stays attached
    let mut out = BufReader::new(bridge.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert!(line.contains("fd_attach"), "{line}");
    line.clear();
    out.read_line(&mut line).unwrap();
    assert!(line.contains("\"init\""), "{line}");
    let claude_pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();

    // SAFETY: plain kill(2) on our own child.
    assert_eq!(unsafe { libc::kill(daemon.id() as i32, libc::SIGTERM) }, 0);

    let t0 = Instant::now();
    let status = loop {
        if let Some(s) = daemon.try_wait().unwrap() {
            break s;
        }
        assert!(t0.elapsed() < Duration::from_secs(12), "the daemon ignored SIGTERM");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "SIGTERM must be a clean exit, got {status:?}");
    let rest: Vec<String> = out.lines().map(|l| l.unwrap()).collect();
    let detach: Value = serde_json::from_str(rest.last().expect("no fd_detach before EOF")).unwrap();
    assert_eq!(detach["type"], "fd_detach");
    assert_eq!(detach["reason"], "exited");
    assert_eq!(unsafe { libc::kill(claude_pid, 0) }, -1, "claude outlived the daemon");
    assert!(!socket.exists(), "the socket was left behind");
    bridge.wait().unwrap();
}
