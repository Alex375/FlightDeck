//! Phone secrets and the CLI's output: `init --no-phone-token` mints none and
//! prints none, plain `init` is unchanged, and `run` never logs one (its log
//! is the systemd journal).

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn fd(home: &Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_flightdeckd"));
    c.env("HOME", home).env("NO_COLOR", "1");
    c
}

fn output(c: &mut Command) -> Output {
    let out = c.stdin(Stdio::null()).output().unwrap();
    assert!(out.status.success(), "command failed: {}", String::from_utf8_lossy(&out.stderr));
    out
}

fn config(home: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(home.join(".flightdeckd/config.json")).unwrap()).unwrap()
}

#[test]
fn init_without_a_phone_token_mints_none_and_prints_only_the_identity() {
    let home = tempfile::tempdir().unwrap();
    let out = output(fd(home.path()).args(["init", "--relay", "http://127.0.0.1:9", "--label", "box", "--no-phone-token"]));
    let cfg = config(home.path());
    assert_eq!(cfg["phone_tokens"], serde_json::json!([]), "a phone token was minted");

    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    let printed: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(printed, serde_json::json!({"mac_id": cfg["mac_id"], "relay_url": "http://127.0.0.1:9", "label": "box"}));
    let whoami: Value = serde_json::from_slice(&output(fd(home.path()).arg("whoami")).stdout).unwrap();
    assert_eq!(printed, whoami, "same shape as whoami");
    assert!(!stdout.contains(cfg["mac_token"].as_str().unwrap()));

    // The installer then authorizes its own token; nothing else was ever valid.
    let pairing = fd(home.path()).arg("pairing").output().unwrap();
    assert!(!pairing.status.success(), "no phone token, no pairing link");
}

#[test]
fn plain_init_still_mints_a_phone_token_and_prints_its_link() {
    let home = tempfile::tempdir().unwrap();
    let out = output(fd(home.path()).args(["init", "--relay", "http://127.0.0.1:9", "--label", "box"]));
    let cfg = config(home.path());
    let tokens = cfg["phone_tokens"].as_array().unwrap();
    assert_eq!(tokens.len(), 1);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let link = format!("http://127.0.0.1:9/#macId={}&pt={}", cfg["mac_id"].as_str().unwrap(), tokens[0]["token"].as_str().unwrap());
    assert!(stdout.contains(&link), "{stdout}");
}

#[test]
fn run_never_logs_a_phone_token() {
    let home = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let home = home.path();
    output(fd(home).args(["init", "--relay", "http://127.0.0.1:9", "--label", "box"]));
    let cfg = config(home);
    let (mac_id, mac_token) = (cfg["mac_id"].as_str().unwrap(), cfg["mac_token"].as_str().unwrap());
    let phone_token = cfg["phone_tokens"][0]["token"].as_str().unwrap();

    let mut daemon = fd(home).arg("run").stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for pipe in [Box::new(daemon.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>, Box::new(daemon.stderr.take().unwrap())] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    // Up to the first relay connect attempt (the relay is unreachable), which
    // comes after the startup lines.
    let mut log = Vec::new();
    let t0 = Instant::now();
    while !log.iter().any(|l: &String| l.contains("relay connection ended")) {
        assert!(t0.elapsed() < Duration::from_secs(10), "no relay attempt logged: {log:#?}");
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
            log.push(line);
        }
    }
    let _ = daemon.kill();
    let _ = daemon.wait();

    let all = log.join("\n");
    assert!(!all.contains(phone_token), "a phone token reached the log:\n{all}");
    assert!(!all.contains(mac_token), "the relay secret reached the log:\n{all}");
    assert!(!all.contains("#macId="), "a pairing link reached the log:\n{all}");
    assert!(all.contains(&format!("node {mac_id} starting, 1 phone(s) authorized")), "{all}");
}
