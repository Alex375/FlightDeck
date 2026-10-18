//! Shared test fixtures (compiled for `cargo test` only).

use crate::config::Config;
use crate::registry::Registry;
use crate::session::SessionManager;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn test_cfg() -> Config {
    Config {
        relay_url: "http://localhost:1".into(),
        mac_id: "m".into(),
        mac_token: "t".into(),
        phone_tokens: vec![],
        revoked_phone_tokens: vec![],
        delivered_phone_revocations: vec![],
        label: "test".into(),
        default_workdir: None,
        claude_bin: "claude".into(),
        permission_mode: crate::config::default_permission_mode(),
        init_phone_tracked: false,
        devices: vec![],
    }
}

/// A well-formed sealed-channel device record (`n` varies the ids and key).
pub fn test_device(n: u8, generation: u32) -> crate::config::Device {
    use tarmac_e2e::keys::{DeviceId, DeviceSecret};
    crate::config::Device {
        device_id: DeviceId::from_bytes([n; 16]).to_b64(),
        label: format!("phone {n}"),
        relay_token: format!("rt-{n}"),
        keys: vec![crate::config::DeviceKey {
            generation,
            key: DeviceSecret::from_bytes([n; 32]).node_key("m").to_b64(),
            issued_at_ms: 1_000,
            expires_at_ms: u64::MAX / 2,
        }],
        push: vec![],
    }
}

/// A temp dir with a SHORT path: Unix socket paths are capped at ~104 bytes on
/// macOS, and the default `$TMPDIR` there is already long.
pub fn short_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("fdd").tempdir_in("/tmp").expect("tempdir")
}

/// A manager over an in-memory registry. Its config path is unwritable: tests
/// that persist phone tokens build their own manager over a temp config.
pub fn test_manager(cfg: Config) -> Arc<SessionManager> {
    SessionManager::new(
        cfg,
        Registry::open_in_memory().expect("registry"),
        PathBuf::from("/dev/null/flightdeckd-test/config.json"),
    )
}

/// A manager whose config is persisted at `dir/config.json` (phone-token
/// changes land there).
pub fn manager_with_config(dir: &Path, cfg: Config) -> Arc<SessionManager> {
    let path = dir.join("config.json");
    cfg.save(&path).expect("save test config");
    SessionManager::new(cfg, Registry::open_in_memory().expect("registry"), path)
}

/// Serve the attach plane on `dir/fd.sock` and wait until it accepts.
pub async fn serve_attach(manager: Arc<SessionManager>, dir: &Path) -> PathBuf {
    let socket = dir.join("fd.sock");
    let s = socket.clone();
    tokio::spawn(async move { crate::attach::serve(manager, &s).await });
    for _ in 0..200 {
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return socket;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("attach socket never came up at {}", socket.display());
}

/// An executable stand-in for claude: announces `session_id` in an init
/// frame, then holds stdin open (a live session) until EOF.
pub fn fake_claude(dir: &Path, session_id: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-claude");
    let script = format!(
        "#!/bin/sh\necho '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session_id}\"}}'\ncat >/dev/null\n"
    );
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

/// Like [`fake_claude`], but each launch also writes its argv, one argument
/// per line, to `<dir>/argv-<session_id>` — what the daemon really spawned.
pub fn fake_claude_recording_argv(dir: &Path, session_id: &str) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(format!("fake-claude-argv-{session_id}"));
    let argv = dir.join(format!("argv-{session_id}"));
    let script = format!(
        "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{0}.tmp'\nmv '{0}.tmp' '{0}'\n\
         echo '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session_id}\"}}'\ncat >/dev/null\n",
        argv.display()
    );
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (path, argv)
}

/// A stand-in claude that announces `session_id`, prints `prompts` (e.g.
/// `can_use_tool` control requests) right away, then records every line written
/// to its stdin in `<dir>/stdin-<session_id>` — what the daemon answered.
pub fn fake_claude_prompting(dir: &Path, session_id: &str, prompts: &[String]) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let data = dir.join(format!("prompts-{session_id}.jsonl"));
    std::fs::write(&data, prompts.join("\n") + "\n").expect("write prompts");
    let stdin_log = dir.join(format!("stdin-{session_id}"));
    let path = dir.join(format!("fake-claude-prompting-{session_id}"));
    let script = format!(
        "#!/bin/sh\necho '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{session_id}\"}}'\n\
         cat '{}'\ncat > '{}'\n",
        data.display(),
        stdin_log.display()
    );
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (path, stdin_log)
}

/// The JSON lines a [`fake_claude_prompting`] claude received, once there are
/// at least `count` of them.
pub async fn stdin_lines_at_least(stdin_log: &Path, count: usize) -> Vec<serde_json::Value> {
    for _ in 0..300 {
        if let Ok(raw) = std::fs::read_to_string(stdin_log) {
            let lines: Vec<serde_json::Value> =
                raw.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            if lines.len() >= count {
                return lines;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("claude never received {count} lines (see {})", stdin_log.display());
}

/// The argv a [`fake_claude_recording_argv`] launch wrote, once it has.
pub async fn recorded_argv(argv: &Path) -> Vec<String> {
    for _ in 0..300 {
        if let Ok(raw) = std::fs::read_to_string(argv) {
            if !raw.is_empty() {
                return raw.lines().map(String::from).collect();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("claude was never launched (no {})", argv.display());
}

/// Wait until a conversation's live actor reports `session_id` (10 s budget,
/// see [`wait_until`]).
pub async fn wait_for_session_id(m: &Arc<SessionManager>, conv_id: &str, session_id: &str) {
    for _ in 0..1000 {
        if let crate::session::LiveStatus::Live(st) = m.status(conv_id).await {
            if st.session_id.as_deref() == Some(session_id) {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{conv_id} never reported session {session_id}");
}

/// Builders for claude stream-json lines with partial messages, in the order
/// observed from real claude (see `replay.rs`).
pub mod stream {
    use serde_json::json;

    pub fn se(parent: Option<&str>, event: serde_json::Value) -> String {
        json!({"type": "stream_event", "event": event, "parent_tool_use_id": parent, "session_id": "s"}).to_string()
    }
    pub fn start(parent: Option<&str>, id: &str) -> String {
        se(parent, json!({"type": "message_start", "message": {"id": id, "role": "assistant", "content": []}}))
    }
    pub fn delta(parent: Option<&str>, text: &str) -> String {
        se(parent, json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}))
    }
    pub fn ev(parent: Option<&str>, kind: &str) -> String {
        se(parent, json!({"type": kind, "index": 0}))
    }
    pub fn assistant(parent: Option<&str>, id: &str, text: &str) -> String {
        json!({"type": "assistant", "parent_tool_use_id": parent, "session_id": "s",
               "message": {"id": id, "role": "assistant", "content": [{"type": "text", "text": text}]}})
        .to_string()
    }
    pub fn other(kind: &str) -> String {
        json!({"type": kind}).to_string()
    }

    /// One complete message in the observed claude order.
    pub fn message(parent: Option<&str>, id: &str) -> Vec<String> {
        vec![
            start(parent, id),
            ev(parent, "content_block_start"),
            delta(parent, "Hel"),
            delta(parent, "lo"),
            assistant(parent, id, "Hello"),
            ev(parent, "content_block_stop"),
            ev(parent, "message_delta"),
            ev(parent, "message_stop"),
        ]
    }

    /// A realistic turn: init, the user echo, a streamed message, a tool
    /// result, a second streamed message, the result.
    pub fn turn() -> Vec<String> {
        let mut t = vec![other("system"), other("user")];
        t.extend(message(None, "msg_1"));
        t.push(other("user")); // tool result
        t.extend(message(None, "msg_2"));
        t.push(other("result"));
        t
    }
}

/// A manager whose claude config dir (sub-agent sidecars) is `claude_dir`.
pub fn test_manager_with_claude_dir(cfg: Config, claude_dir: &Path) -> Arc<SessionManager> {
    SessionManager::with_claude_config_dir(
        cfg,
        Registry::open_in_memory().expect("registry"),
        PathBuf::from("/dev/null/flightdeckd-test/config.json"),
        claude_dir.to_path_buf(),
    )
}

/// A scriptable stand-in for claude, driven by files the test writes in `dir`
/// (before the triggering line reaches it):
///  - `on-0.jsonl` is printed at start, `on-<n>.jsonl` after the n-th stdin line;
///  - `reply-<n>.jsonl` likewise, with every `REQID` replaced by the
///    `request_id` the n-th line carries (to answer a daemon `fdd-*` request);
///  - `err-<n>.txt` goes to stderr at the same points;
///  - `hold-<n>` (holding seconds) leaves a background child holding its
///    stderr open that long (a grandchild that inherited the pipe); its pid
///    goes to `hold-<n>.pid`;
///  - `exit-<n>` (holding a code) makes it exit right after.
///
/// Each spawn appends `--spawn--` then its argv (one per line) to `args.log`;
/// every stdin line is appended to `stdin.log`.
pub fn scripted_claude(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("scripted-claude");
    let d = dir.display();
    let script = format!(
        r#"#!/bin/sh
D='{d}'
printf '%s\n' --spawn-- >> "$D/args.log"
for a in "$@"; do printf '%s\n' "$a" >> "$D/args.log"; done
emit() {{
  if [ -f "$D/err-$1.txt" ]; then cat "$D/err-$1.txt" >&2; fi
  if [ -f "$D/on-$1.jsonl" ]; then cat "$D/on-$1.jsonl"; fi
  if [ -f "$D/reply-$1.jsonl" ]; then sed "s/REQID/$2/g" "$D/reply-$1.jsonl"; fi
  if [ -f "$D/hold-$1" ]; then sleep "$(cat "$D/hold-$1")" >/dev/null </dev/null & echo $! > "$D/hold-$1.pid"; fi
  if [ -f "$D/exit-$1" ]; then exit "$(cat "$D/exit-$1")"; fi
}}
emit 0 ""
n=0
while IFS= read -r line; do
  n=$((n+1))
  printf '%s\n' "$line" >> "$D/stdin.log"
  rid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  emit "$n" "$rid"
done
"#
    );
    std::fs::write(&path, script).expect("write scripted claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

/// Script what [`scripted_claude`] prints after its `n`-th stdin line (0 = at start).
pub fn script_on(dir: &Path, n: usize, lines: &[String]) {
    std::fs::write(dir.join(format!("on-{n}.jsonl")), lines.join("\n") + "\n").expect("write script step");
}

/// Script an answer to the `n`-th stdin line (`REQID` = its request id).
pub fn script_reply(dir: &Path, n: usize, lines: &[String]) {
    std::fs::write(dir.join(format!("reply-{n}.jsonl")), lines.join("\n") + "\n").expect("write script reply");
}

/// The stdin lines [`scripted_claude`] received so far, parsed.
pub fn stdin_lines(dir: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(dir.join("stdin.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdin line is JSON"))
        .collect()
}

/// The argv of each spawn of [`scripted_claude`], in order.
pub fn spawn_args(dir: &Path) -> Vec<Vec<String>> {
    let raw = std::fs::read_to_string(dir.join("args.log")).unwrap_or_default();
    let mut spawns: Vec<Vec<String>> = Vec::new();
    for l in raw.lines() {
        if l == "--spawn--" {
            spawns.push(Vec::new());
        } else if let Some(last) = spawns.last_mut() {
            last.push(l.to_string());
        }
    }
    spawns
}

/// Poll `check` until it holds, else panic naming `what`. The 10 s budget is
/// only spent on a real failure; it is that generous because these tests spawn
/// processes and share the machine with whatever else is building.
pub async fn wait_until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..1000 {
        if check().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting until {what}");
}

/// A raw attach client over the socket: the parsed `fd_attach`, and the open
/// connection to read the stream from / write client lines to.
pub async fn attach_raw(
    socket: &Path,
    req: serde_json::Value,
) -> (serde_json::Value, tokio::io::BufReader<tokio::net::UnixStream>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let mut conn = tokio::net::UnixStream::connect(socket).await.expect("connect");
    conn.write_all(format!("{}\n", serde_json::json!({ "attach": req })).as_bytes()).await.expect("send attach");
    let mut r = tokio::io::BufReader::new(conn);
    let mut line = String::new();
    r.read_line(&mut line).await.expect("fd_attach");
    (serde_json::from_str(&line).expect("fd_attach is JSON"), r)
}

/// The next line of an attach stream, parsed (10 s budget).
pub async fn next_json(r: &mut tokio::io::BufReader<tokio::net::UnixStream>) -> serde_json::Value {
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    let n = tokio::time::timeout(std::time::Duration::from_secs(10), r.read_line(&mut line))
        .await
        .expect("no line within 10 s")
        .expect("read");
    assert!(n > 0, "the attach stream ended");
    serde_json::from_str(&line).expect("stream line is JSON")
}

/// Read the attach stream until a line matches `pred` (returns it).
pub async fn next_matching(
    r: &mut tokio::io::BufReader<tokio::net::UnixStream>,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    loop {
        let v = next_json(r).await;
        if pred(&v) {
            return v;
        }
    }
}

/// Write one client line on an attach stream.
pub async fn client_send(r: &mut tokio::io::BufReader<tokio::net::UnixStream>, line: &str) {
    use tokio::io::AsyncWriteExt;
    r.get_mut().write_all(format!("{line}\n").as_bytes()).await.expect("client write");
}

/// Every event emitted so far on `rx`.
pub fn drain_events(rx: &mut tokio::sync::broadcast::Receiver<crate::events::Event>) -> Vec<crate::events::Event> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(e);
    }
    out
}

/// A stand-in claude that waits for its first stdin line (the first turn),
/// then prints `lines` and holds stdin open.
pub fn fake_claude_emitting(dir: &Path, lines: &[String]) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let data = dir.join("turn.jsonl");
    std::fs::write(&data, lines.join("\n") + "\n").expect("write turn");
    let path = dir.join("fake-claude-turn");
    let script = format!("#!/bin/sh\nread _first\ncat '{}'\ncat >/dev/null\n", data.display());
    std::fs::write(&path, script).expect("write fake claude");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}
