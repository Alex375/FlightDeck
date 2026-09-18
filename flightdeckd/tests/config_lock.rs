//! The config lock is a cross-PROCESS contract: `flightdeckd init` must wait
//! for whoever holds `~/.flightdeckd/config.json.lock` (the daemon, another
//! init, the Mac's installer via flock(1)) and write atomically after.

use std::fs::OpenOptions;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn init_waits_for_the_config_lock_then_writes_a_private_config() {
    let home = tempfile::tempdir().unwrap();
    let state = home.path().join(".flightdeckd");
    std::fs::create_dir_all(&state).unwrap();
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(state.join("config.json.lock")).unwrap();
    // SAFETY: plain syscall on a descriptor we own.
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);

    let mut init = Command::new(env!("CARGO_BIN_EXE_flightdeckd"))
        .args(["init", "--relay", "http://127.0.0.1:9", "--label", "lock-test"])
        .env("HOME", home.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(700));
    assert!(init.try_wait().unwrap().is_none(), "init wrote while another process held the lock");
    assert!(!state.join("config.json").exists());

    drop(lock); // release: init proceeds
    let t0 = Instant::now();
    let status = loop {
        if let Some(s) = init.try_wait().unwrap() {
            break s;
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "init never took the released lock");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success());
    let path = state.join("config.json");
    let cfg: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(cfg["label"], "lock-test");
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

    // A second init without --force still refuses (checked under the lock).
    let again = Command::new(env!("CARGO_BIN_EXE_flightdeckd"))
        .args(["init"]).env("HOME", home.path()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().unwrap();
    assert!(!again.success());
}
