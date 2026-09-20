//! The `flightdeckd attach` stdio bridge, as a real process against a fake
//! daemon socket.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// When the daemon closes the stream (fd_detach, or a stalled link given up
/// on), the bridge must EXIT even though its stdin is still open — otherwise
/// its stdout stays open, ssh never sees EOF and the Mac never learns the
/// link is gone.
#[test]
fn bridge_exits_when_the_daemon_closes_even_with_stdin_open() {
    let dir = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("fd.sock");
    let listener = UnixListener::bind(&socket).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_flightdeckd"))
        .args(["attach", "--cwd", "/tmp", "--socket"])
        .arg(&socket)
        .stdin(Stdio::piped()) // held open for the whole test
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _stdin = child.stdin.take().unwrap();

    let (conn, _) = listener.accept().unwrap();
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut request = String::new();
    reader.read_line(&mut request).unwrap();
    assert!(request.contains("\"attach\""), "unexpected request: {request}");
    let mut w = conn;
    w.write_all(b"{\"type\":\"fd_attach\"}\n{\"type\":\"fd_detach\",\"reason\":\"stalled\"}\n").unwrap();
    w.shutdown(std::net::Shutdown::Write).unwrap();

    let t0 = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if t0.elapsed() > Duration::from_secs(5) {
            child.kill().ok();
            panic!("the attach bridge lingered after the daemon closed the stream");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success());
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut out).unwrap();
    assert_eq!(out, "{\"type\":\"fd_attach\"}\n{\"type\":\"fd_detach\",\"reason\":\"stalled\"}\n");
}

/// Lines the client wrote just before the daemon closed the stream are still
/// delivered to the daemon (the bridge drains its stdin queue on the way out).
#[test]
fn bridge_delivers_stdin_lines_written_just_before_the_daemon_closes() {
    let dir = tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("fd.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_flightdeckd"))
        .args(["attach", "--cwd", "/tmp", "--socket"])
        .arg(&socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let (conn, _) = listener.accept().unwrap();
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut request = String::new();
    reader.read_line(&mut request).unwrap();

    for i in 0..40 {
        writeln!(stdin, "{{\"type\":\"user\",\"i\":{i}}}").unwrap();
    }
    stdin.flush().unwrap();
    let mut w = conn;
    w.write_all(b"{\"type\":\"fd_detach\",\"reason\":\"replaced\"}\n").unwrap();
    w.shutdown(std::net::Shutdown::Write).unwrap(); // the daemon is done talking

    let lines: Vec<String> = reader.lines().map(|l| l.unwrap()).collect(); // until the bridge closes
    assert_eq!(lines.len(), 40, "stdin lines were lost: got {}", lines.len());
    assert!(child.wait().unwrap().success());
    drop(stdin);
}
