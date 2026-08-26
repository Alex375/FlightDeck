//! Transport layer for a single `claude` session (subtask 1).
//!
//! Responsibilities, and *only* these:
//!   - spawn the `claude` binary in persistent bidirectional `stream-json` mode
//!     (see `docs/claude-code-protocol.md` §1–§2),
//!   - read its stdout as newline-delimited JSON, parse each line into a
//!     [`CliMessage`], and hand it to a consumer over an mpsc channel,
//!   - serialize outbound messages (one full JSON line at a time) onto stdin,
//!     keeping stdin open for the whole session,
//!   - drain stderr to our log,
//!   - tear the process down gracefully.
//!
//! It does NOT implement the control-channel responder table / state machine
//! (subtask 2) nor the content assembler / IPC surface (subtask 3). Those build
//! on the [`CliMessage`] stream this layer produces and the [`Transport::send_line`]
//! escape hatch it exposes.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use super::protocol::CliMessage;

/// How many trailing stderr lines from the `claude` process to keep buffered, so an
/// abnormal exit can surface the tail (auth failure, panic, MCP error) in the UI
/// without streaming every line into the conversation.
const STDERR_TAIL_MAX: usize = 80;

/// Shared, bounded ring of the process's most recent stderr lines.
type StderrTail = Arc<Mutex<VecDeque<String>>>;
/// Shared slot for a pump task's terminal error (reader IO / writer IO), so the
/// session actor can explain WHY the process went away instead of treating every
/// disappearance as a clean exit.
type ErrSlot = Arc<Mutex<Option<String>>>;

/// How a `claude` process is launched. Build with [`SpawnConfig::new`] and tweak
/// the optional fields.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// Path to the `claude` binary. Defaults to `$TOSSE_CLAUDE_BIN`, else `claude`
    /// resolved on `PATH`.
    pub claude_bin: PathBuf,
    /// Working directory for the session (the repo/workspace folder).
    pub cwd: PathBuf,
    /// Resume an existing conversation by session id (`--resume`).
    pub resume: Option<String>,
    /// Static tool allowlist (`--allowedTools`, comma-joined). Tools resolved
    /// here never trigger a `can_use_tool` prompt.
    pub allowed_tools: Vec<String>,
    /// Static tool denylist (`--disallowedTools`, comma-joined).
    pub disallowed_tools: Vec<String>,
    /// Extra directories tools may access (`--add-dir`, repeated).
    pub add_dirs: Vec<PathBuf>,
    /// Override the session model (`--model`).
    pub model: Option<String>,
    /// Initial reasoning effort level (`--effort`, e.g. "xhigh"). The "ultracode"
    /// tier is NOT set here (it has no spawn flag) — the session re-enables it after
    /// init via the control channel; see [`super::session::InitialControls`].
    pub effort: Option<String>,
    /// Initial permission mode (`--permission-mode`, e.g. "default", "plan"). `None`
    /// lets the CLI use its own default. NOTE: `bypassPermissions` is downgraded to
    /// `default` server-side unless [`Self::allow_bypass_permissions`] is set.
    pub permission_mode: Option<String>,
    /// Pass `--allow-dangerously-skip-permissions`, which UNLOCKS `bypassPermissions`
    /// as a selectable mode without turning it on. Verified against the CLI's own help
    /// (2.1.220): "Enable bypassing all permission checks *as an option, without it
    /// being enabled by default*". Without it the CLI silently downgrades a
    /// `bypassPermissions` request (spawn flag or runtime `set_permission_mode`) to
    /// `default` — see `control::parse_set_permission_mode_ack`.
    ///
    /// ⚠️ NOT `--dangerously-skip-permissions` (no `--allow-` prefix): that one turns
    /// the bypass ON outright, which is never what this flag is for. Off unless the
    /// user opted in via Settings → General → Permissions.
    pub allow_bypass_permissions: bool,
    /// When set, this session runs on a REMOTE host: ssh executes `flightdeckd
    /// attach`, and the DAEMON on the server owns the actual `claude` process —
    /// detached from this connection, so a network cut never kills the session.
    /// The stream-json protocol, the [`CliMessage`] stream and every layer above
    /// the transport are identical; the daemon replays what was missed on
    /// reattach (see [`SpawnConfig::attach`]). `None` (the default) is the
    /// unchanged local path. Codex ignores this — remote is Claude-only for now.
    pub remote: Option<RemoteTarget>,
    /// Reattach coordinates for a REMOTE session (ignored locally). `None` on
    /// the first spawn; the session actor fills it from the daemon's
    /// `fd_attach` handshake to reconnect after a drop without losing stream.
    pub attach: Option<AttachPoint>,
}

/// Where to resume a remote attach stream: the daemon-side conversation, the
/// claude-process epoch, and how many replayable lines this client has already
/// received in that epoch (the cursor). See flightdeckd `frames.rs` — the
/// replay-eligibility predicate ([`is_replayable_line`]) is a shared contract.
#[derive(Debug, Clone, Default)]
pub struct AttachPoint {
    pub conversation: Option<String>,
    pub epoch: Option<String>,
    pub cursor: u64,
}

/// How to reach a remote host that runs `claude` over SSH. Self-contained — Flight
/// Deck owns the connection coordinates (from the paired [`super::super::store::
/// MachineRecord`]), so no `~/.ssh/config` editing is required. Holds NO secret: only
/// a path to a private-key FILE on this Mac, never the key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTarget {
    /// Hostname or IP reachable from this Mac.
    pub host: String,
    /// SSH port.
    pub port: u16,
    /// SSH user to log in as.
    pub user: String,
    /// Path to the private key file (`ssh -i`). `None` uses the user's default keys /
    /// agent.
    pub identity_file: Option<String>,
    /// A dedicated `known_hosts` file (`UserKnownHostsFile`), so pinning a server's
    /// host key never touches the user's `~/.ssh/known_hosts`. `None` uses the default.
    pub known_hosts_file: Option<String>,
    /// The `flightdeckd` binary name/path ON THE REMOTE host (resolved on the
    /// remote PATH). Defaults to `"flightdeckd"`. The daemon resolves `claude`
    /// itself, server-side.
    pub daemon_bin: String,
}

impl SpawnConfig {
    /// A default config for `cwd`, using the `claude` binary on `PATH` (or
    /// `$TOSSE_CLAUDE_BIN`).
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            claude_bin: default_claude_bin(),
            cwd: cwd.into(),
            resume: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            add_dirs: Vec::new(),
            model: None,
            effort: None,
            permission_mode: None,
            allow_bypass_permissions: false,
            remote: None,
            attach: None,
        }
    }
}

fn default_claude_bin() -> PathBuf {
    std::env::var_os("TOSSE_CLAUDE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// Build the `claude` argv (everything after the binary) from a [`SpawnConfig`].
/// Shared verbatim by the local and remote launchers: the SAME flags must run
/// whether `claude` is spawned here or over SSH, so the wire protocol is identical
/// on both sides. The fixed prefix is the persistent bidirectional stream-json mode
/// (spec §1–§2); the rest are the optional per-session flags.
fn build_claude_args(cfg: &SpawnConfig) -> Vec<String> {
    let mut a: Vec<String> = vec![
        // Persistent bidirectional stream-json mode. NOT `-p`/`--print`: with
        // `--input-format stream-json` the process lives for the whole session and
        // reads many messages from stdin (spec §1.1).
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        // Route permission decisions back over the stdio control channel as
        // `control_request{can_use_tool}` (answered in subtask 2).
        "--permission-prompt-tool".into(),
        "stdio".into(),
        // Re-emit user messages on stdout (`isReplay:true`) — the only way a turn
        // injected by Remote Control (phone/web) reaches us live; our own turns are
        // deduped by the uuid we stamp. Unconditional, like the official extension.
        "--replay-user-messages".into(),
        // Forward a sub-agent's OWN text and thinking, not just its tool calls
        // (verified present in 2.1.220 / 2.1.222).
        "--forward-subagent-text".into(),
    ];
    if let Some(resume) = &cfg.resume {
        a.push("--resume".into());
        a.push(resume.clone());
    }
    if !cfg.allowed_tools.is_empty() {
        a.push("--allowedTools".into());
        a.push(cfg.allowed_tools.join(","));
    }
    if !cfg.disallowed_tools.is_empty() {
        a.push("--disallowedTools".into());
        a.push(cfg.disallowed_tools.join(","));
    }
    for dir in &cfg.add_dirs {
        a.push("--add-dir".into());
        a.push(dir.to_string_lossy().into_owned());
    }
    if let Some(model) = &cfg.model {
        a.push("--model".into());
        a.push(model.clone());
    }
    if let Some(effort) = &cfg.effort {
        a.push("--effort".into());
        a.push(effort.clone());
    }
    if let Some(mode) = &cfg.permission_mode {
        a.push("--permission-mode".into());
        a.push(mode.clone());
    }
    // Unlocks `bypassPermissions` as a choice (it does NOT enable it). Opt-in.
    if cfg.allow_bypass_permissions {
        a.push("--allow-dangerously-skip-permissions".into());
    }
    a
}

/// Build the single POSIX-sh command `ssh` runs on the remote host: `exec
/// flightdeckd attach …`. The DAEMON owns the `claude` process server-side
/// (spawning it with the argv passed after `--` if it isn't already running,
/// env included) and bridges this ssh channel to it — replaying everything the
/// client missed since [`AttachPoint::cursor`]. Every interpolated value is
/// single-quote-escaped, so remote paths/args with spaces or metacharacters are
/// safe.
fn build_remote_command(cfg: &SpawnConfig, remote: &RemoteTarget, args: &[String]) -> String {
    let attach = cfg.attach.clone().unwrap_or_default();
    let mut s = format!("exec {} attach", shell_quote(&remote.daemon_bin));
    s.push_str(&format!(" --cwd {}", shell_quote(&cfg.cwd.to_string_lossy())));
    if let Some(resume) = &cfg.resume {
        s.push_str(&format!(" --resume-session {}", shell_quote(resume)));
    }
    if let Some(conv) = &attach.conversation {
        s.push_str(&format!(" --conversation {}", shell_quote(conv)));
    }
    if let Some(epoch) = &attach.epoch {
        s.push_str(&format!(" --epoch {}", shell_quote(epoch)));
    }
    s.push_str(&format!(" --cursor {}", attach.cursor));
    s.push_str(" --");
    for arg in args {
        s.push(' ');
        s.push_str(&shell_quote(arg));
    }
    s
}

/// Best-effort remote stop: `ssh <dest> 'exec flightdeckd stop --conversation X'`.
/// The deterministic tail of the user's explicit Stop for a remote session —
/// the in-band `fd_stop` only reaches the daemon while the attach link is
/// alive, and an explicit Stop must work precisely when it is not. Idempotent
/// server-side (stopping a stopped session is a no-op). Returns whether the
/// command ran and exited 0; failures are logged, never surfaced (the session
/// is already torn down locally).
pub async fn run_remote_stop(remote: &RemoteTarget, conversation: &str) -> bool {
    let mut cmd = Command::new("ssh");
    cmd.arg("-T")
        .arg("-p")
        .arg(remote.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    if let Some(kh) = &remote.known_hosts_file {
        cmd.arg("-o").arg(format!("UserKnownHostsFile={kh}"));
    }
    if let Some(identity) = &remote.identity_file {
        cmd.arg("-i").arg(identity).arg("-o").arg("IdentitiesOnly=yes");
    }
    cmd.arg(format!("{}@{}", remote.user, remote.host)).arg(format!(
        "exec {} stop --conversation {}",
        shell_quote(&remote.daemon_bin),
        shell_quote(conversation),
    ));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match cmd.spawn() {
        Ok(mut child) => matches!(
            tokio::time::timeout(Duration::from_secs(15), child.wait()).await,
            Ok(Ok(status)) if status.success()
        ),
        Err(e) => {
            eprintln!("[transport] remote stop failed to launch ssh: {e}");
            false
        }
    }
}

/// Replay-cursor eligibility of one raw stdout line — a CONTRACT shared
/// line-for-line with flightdeckd (`frames::is_replayable_line`): a line counts
/// iff it parses as a JSON object whose `type` is a string outside the control
/// plane (`control_request` / `control_response` / `control_cancel_request` /
/// `keep_alive`, which are correlation-scoped to one client and never
/// replayed) and not a daemon `fd_*` frame. Both sides count the same lines or
/// reattach cursors would drift.
fn is_replayable_line(line: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct Probe {
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    match serde_json::from_str::<Probe>(line) {
        Ok(Probe { kind: Some(k) }) => {
            !matches!(
                k.as_str(),
                "control_response" | "control_request" | "control_cancel_request" | "keep_alive"
            ) && !k.starts_with("fd_")
        }
        _ => false,
    }
}

/// POSIX single-quote escaping: wrap in single quotes and rewrite each embedded
/// quote as `'\''`. Safe for arbitrary values inside a `/bin/sh -c` command.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// The `claude` binary path this app would spawn, resolved exactly as at session
/// spawn (`$TOSSE_CLAUDE_BIN` → `PATH` → well-known install locations). Exposed for
/// OUT-of-session CLI calls (e.g. `claude plugin update`) so they hit the same binary
/// as our sessions — and still resolve in a Finder-launched bundle's minimal PATH.
pub fn resolved_claude_bin() -> PathBuf {
    resolve_bin(&default_claude_bin())
}

/// Whether a usable `claude` binary is present on this machine. Powers the proactive
/// "CLI not detected" surfaces (composer bar + Settings → Accounts) so the user learns
/// the binary is missing BEFORE the first message fails — the twin of
/// [`super::codex::codex_available`]. Cheap: a `PATH` / well-known-location file check,
/// never a process spawn. Mirrors [`resolve_bin`]'s structure: an explicit path (incl.
/// `$TOSSE_CLAUDE_BIN`) is "available" iff that file exists; a bare `claude` is available
/// when it resolves on `PATH` or exists at a well-known install location.
pub fn claude_available() -> bool {
    let bin = default_claude_bin();
    let has_dir = bin.parent().map(|p| !p.as_os_str().is_empty()).unwrap_or(false);
    if has_dir {
        return bin.is_file();
    }
    find_on_path(&bin).is_some()
        || (bin.as_os_str() == "claude" && known_claude_locations().iter().any(|p| p.is_file()))
}

/// Resolve the binary actually handed to `Command::new` at spawn time.
///
/// Normally `claude` resolves on `PATH` (the terminal PATH in dev; the PATH
/// restored at boot by `lib::repair_env_path` in a Finder-launched bundle). This
/// is the belt to that suspenders: if `claude` is a bare name that STILL won't
/// resolve — e.g. the login-shell PATH probe failed or timed out — fall back to a
/// well-known absolute install location so the session can start anyway. An
/// explicit path (anything with a directory component, incl. `$TOSSE_CLAUDE_BIN`)
/// or a name that already resolves is returned unchanged.
fn resolve_bin(bin: &Path) -> PathBuf {
    let has_dir = bin.parent().map(|p| !p.as_os_str().is_empty()).unwrap_or(false);
    if has_dir || find_on_path(bin).is_some() {
        return bin.to_path_buf();
    }
    if bin.as_os_str() == "claude" {
        if let Some(found) = known_claude_locations().into_iter().find(|p| p.is_file()) {
            return found;
        }
    }
    bin.to_path_buf()
}

/// A tiny `which`: is `bin` resolvable as a file on the current `$PATH`? Lets us
/// tell whether a bare program name will spawn before falling back to absolute
/// install locations.
fn find_on_path(bin: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

/// Well-known install locations for the `claude` binary, most-specific first.
/// Used only as a fallback when `claude` does not resolve on `PATH`.
fn known_claude_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".claude/local/claude"));
        out.push(home.join(".bun/bin/claude"));
    }
    out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    out.push(PathBuf::from("/usr/local/bin/claude"));
    out
}

/// An image joined to a user turn: base64 bytes + their MIME type. Sent inside the
/// message `content` array as an `image` block (spec §3.10) — verified accepted by
/// `claude` 2.1.187, which "sees" it and answers about its content. The `data` field
/// is raw base64 (NO `data:` URL prefix). Also an IPC command param (`send_message`),
/// so it derives `specta::Type` for the generated TS bindings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ImageAttachment {
    /// MIME type, e.g. `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
    pub media_type: String,
    /// Base64-encoded image bytes, with NO `data:image/...;base64,` prefix.
    pub data: String,
}

/// Build a `user` turn message in the Anthropic message shape (spec §2.3), stamped
/// with `uuid`. The uuid is echoed back verbatim by `--replay-user-messages`
/// (`isReplay:true`), which is how the core recognises — and suppresses — the echo of
/// a turn WE sent (vs a remote turn, whose uuid we never sent). Mirrors the official
/// extension, which sends its own `crypto.randomUUID()` and dedupes the replay by it.
pub fn user_message(text: impl Into<String>, uuid: &str) -> Value {
    user_message_with_images(text, &[], uuid)
}

/// Build a `user` turn with an optional text block followed by any joined images
/// (`image` blocks). `content` is an ARRAY of blocks (spec §3.10): the text block is
/// included only when non-empty, so an images-only turn carries just the image blocks.
/// An all-empty turn can't happen from the UI (empty sends are gated), but we still
/// emit a single empty text block as a defensive floor so `content` is never `[]`.
pub fn user_message_with_images(
    text: impl Into<String>,
    images: &[ImageAttachment],
    uuid: &str,
) -> Value {
    let text = text.into();
    let mut content: Vec<Value> = Vec::new();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for img in images {
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.media_type, "data": img.data },
        }));
    }
    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "" }));
    }
    json!({
        "type": "user",
        "uuid": uuid,
        "message": { "role": "user", "content": content }
    })
}

/// Errors surfaced by the transport's synchronous API.
#[derive(Debug)]
pub enum TransportError {
    /// The `claude` process failed to spawn.
    Spawn(std::io::Error),
    /// The conversation's working directory no longer exists (e.g. its worktree
    /// was removed, or the folder was moved) — so `claude` can't be launched
    /// there. Kept distinct from [`Spawn`] because a missing cwd and a missing
    /// binary both surface as `NotFound`, and the two need different fixes.
    CwdMissing(std::path::PathBuf),
    /// The writer channel is closed — the session is gone.
    Closed,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Human-readable + actionable: this string is surfaced verbatim in the
            // UI (commands map the error to a string). NotFound is the common case
            // for a Finder-launched bundle whose PATH could not be repaired.
            TransportError::Spawn(e) if e.kind() == std::io::ErrorKind::NotFound => write!(
                f,
                "Could not start \"claude\": binary not found. \
                 Check that Claude Code is installed (try \"claude --version\" \
                 in a terminal), or set the TOSSE_CLAUDE_BIN variable to the \
                 binary's full path.",
            ),
            TransportError::Spawn(e) => write!(f, "Could not start \"claude\": {e}"),
            TransportError::CwdMissing(p) => write!(
                f,
                "This conversation's working directory no longer exists: {}. \
                 Its worktree may have been removed, or the folder moved.",
                p.display(),
            ),
            TransportError::Closed => write!(f, "claude session transport is closed"),
        }
    }
}

impl std::error::Error for TransportError {}

/// A live `claude` session transport. Owns the child process and the writer
/// half of stdin; inbound messages are delivered over the receiver returned by
/// [`Transport::spawn`].
pub struct Transport {
    pid: Option<u32>,
    /// `None` once [`Transport::shutdown`] has closed stdin.
    writer_tx: Option<mpsc::UnboundedSender<Value>>,
    child: Child,
    /// The reader / writer / stderr pump tasks. Aborted on shutdown so none
    /// outlive the process (no dangling tokio task, no pipe left open).
    pumps: Vec<tokio::task::JoinHandle<()>>,
    /// Last N stderr lines, for surfacing the cause of an abnormal exit.
    stderr_tail: StderrTail,
    /// Set if the stdout reader ended on an IO error (vs a clean EOF).
    reader_err: ErrSlot,
    /// Set if the stdin writer died on a write/flush/serialize failure.
    writer_err: ErrSlot,
    /// Count of REPLAYABLE stdout lines received (see [`is_replayable_line`]) —
    /// the reattach cursor for remote sessions. Always 0-based per transport.
    lines_seen: Arc<AtomicU64>,
    /// Whether this transport is an ssh→flightdeckd attach stream (drives the
    /// `fd_stop` escalation in [`Transport::shutdown`]).
    is_remote: bool,
}

impl Transport {
    /// Spawn `claude` and start the reader / writer / stderr tasks.
    ///
    /// Returns the [`Transport`] handle plus the receiver of parsed inbound
    /// [`CliMessage`]s. The session stays alive (stdin held open) until
    /// [`Transport::shutdown`] is called or the handle is dropped.
    pub fn spawn(
        cfg: SpawnConfig,
    ) -> Result<(Transport, mpsc::UnboundedReceiver<CliMessage>), TransportError> {
        let args = build_claude_args(&cfg);

        // Local vs remote (SSH) launch. Everything downstream — the CliMessage
        // stream, the session actor, the emit layer, the whole UI — is
        // transport-neutral: only HOW `claude` is started, and where its cwd/env
        // live, differs here (the "machine boundary", SSH-first).
        let mut cmd = if let Some(remote) = &cfg.remote {
            // Remote: `ssh <dest> "<export env; cd cwd && exec claude …>"`. The
            // IDENTICAL stream-json argv runs on the remote host; stdin/stdout/stderr
            // are the ssh channel, so the reader/writer/stderr pumps below are reused
            // verbatim. No local cwd/bin check — both live on the remote side.
            let remote_cmd = build_remote_command(&cfg, remote, &args);
            let mut cmd = Command::new("ssh");
            cmd.arg("-T") // no PTY: the channel carries raw JSON lines both ways
                .arg("-p")
                .arg(remote.port.to_string())
                .arg("-o")
                .arg("BatchMode=yes") // never block a GUI app on a password prompt
                .arg("-o")
                .arg("ConnectTimeout=10") // fail fast if the host is unreachable
                // A REAL network cut (wifi off, cable pulled) sends no FIN: without
                // keepalives the ssh client hangs on a dead TCP connection for many
                // minutes and the actor never sees the EOF that triggers its
                // auto-reconnect. 5s probes × 3 misses → a dead link is detected in
                // ~15s and the reattach/replay path takes over.
                .arg("-o")
                .arg("ServerAliveInterval=5")
                .arg("-o")
                .arg("ServerAliveCountMax=3")
                .arg("-o")
                .arg("StrictHostKeyChecking=accept-new"); // TOFU: pin on first sight
            if let Some(kh) = &remote.known_hosts_file {
                cmd.arg("-o").arg(format!("UserKnownHostsFile={kh}"));
            }
            if let Some(identity) = &remote.identity_file {
                // IdentitiesOnly so ssh offers ONLY our dedicated key (avoids "too many
                // authentication failures" when the agent holds many keys).
                cmd.arg("-i").arg(identity).arg("-o").arg("IdentitiesOnly=yes");
            }
            cmd.arg(format!("{}@{}", remote.user, remote.host)).arg(remote_cmd);
            cmd
        } else {
            // Local: a conversation whose cwd has vanished (e.g. its worktree was
            // removed) makes `spawn` fail with NotFound — indistinguishable from a
            // missing `claude` binary. Check first so the error names the real cause.
            // (A relative cwd like "." resolves against the process dir and exists.)
            if !cfg.cwd.exists() {
                return Err(TransportError::CwdMissing(cfg.cwd.clone()));
            }
            let mut cmd = Command::new(resolve_bin(&cfg.claude_bin));
            cmd.args(&args)
                .current_dir(&cfg.cwd)
                .env("CLAUDE_CODE_ENTRYPOINT", "tosse-code")
                .env("MCP_CONNECTION_NONBLOCKING", "true")
                .env("CLAUDE_CODE_ENABLE_TASKS", "0")
                // Turn on the binary's file checkpointing so `rewind_files` can restore
                // what a turn edited. In SDK/piloted mode (our case) its
                // `fileHistoryEnabled` gate reads ONLY this env var — without it every
                // rewind answers "File rewinding is not enabled." (verified live against
                // 2.1.224). Costs nothing when unused.
                .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
                .env_remove("NODE_OPTIONS");
            cmd
        };

        // Shared by both launchers: piped stdio + own process group + drop backstop.
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Backstop: if the handle is dropped without shutdown, don't orphan the
            // process (locally the `claude` child; remotely the `ssh` client).
            .kill_on_drop(true);

        // Own process group (group leader, pgid == pid). On shutdown we signal the
        // whole group (`-pid`), reaching every descendant — tool subprocesses / MCP
        // servers locally, or the `ssh` client remotely — so none is orphaned.
        // A remote `claude` then exits on its own when the ssh channel closes
        // (stdin EOF), the same graceful path the local child follows.
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().map_err(TransportError::Spawn)?;
        let pid = child.id();

        let stdout = child.stdout.take().expect("stdout was piped");
        let stdin = child.stdin.take().expect("stdin was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<CliMessage>();
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Value>();

        let stderr_tail: StderrTail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_MAX)));
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let writer_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

        let pumps = vec![
            tokio::spawn(reader_loop(stdout, msg_tx, reader_err.clone(), lines_seen.clone())),
            tokio::spawn(writer_loop(stdin, writer_rx, writer_err.clone())),
            tokio::spawn(stderr_loop(stderr, stderr_tail.clone())),
        ];

        Ok((
            Transport {
                pid,
                writer_tx: Some(writer_tx),
                child,
                pumps,
                stderr_tail,
                reader_err,
                writer_err,
                lines_seen,
                is_remote: cfg.remote.is_some(),
            },
            msg_rx,
        ))
    }

    /// How many replayable stream lines this transport has delivered — the
    /// reattach cursor contribution of the CURRENT connection (the actor adds
    /// the daemon's `replay_from` base).
    pub fn lines_seen(&self) -> u64 {
        self.lines_seen.load(Ordering::Relaxed)
    }

    /// OS process id, while the child is alive.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The buffered tail of the process's stderr (oldest → newest), for surfacing the
    /// cause of an abnormal exit. Empty when the process never wrote to stderr.
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The stdout reader's terminal IO error, if it ended on one (vs a clean EOF).
    pub fn reader_error(&self) -> Option<String> {
        self.reader_err.lock().ok().and_then(|e| e.clone())
    }

    /// The stdin writer's terminal error, if a write/flush/serialize failure killed it.
    pub fn writer_error(&self) -> Option<String> {
        self.writer_err.lock().ok().and_then(|e| e.clone())
    }

    /// Reap the child and return its exit status. Safe to call before [`shutdown`]
    /// (tokio's `Child::wait` is idempotent — `shutdown`'s own wait then returns the
    /// same status). Used by the session actor to report the exit code of a process
    /// that died on its own.
    pub async fn wait_status(&mut self) -> Option<ExitStatus> {
        self.child.wait().await.ok()
    }

    /// Queue a user turn as a `user` message in the Anthropic message shape
    /// (spec §2.3). Non-blocking: the writer task serializes it onto stdin. Stamps a
    /// fresh uuid (the session actor's own send path stamps + records it for
    /// echo-suppression; this convenience is used by the live tests, which don't
    /// exercise the replay dedup).
    pub fn send_user_text(&self, text: impl Into<String>) -> Result<(), TransportError> {
        self.send_line(user_message(text, &uuid::Uuid::new_v4().to_string()))
    }

    /// A clone of the outbound line sender, feeding the same stdin writer task.
    /// Lets a higher layer (the session actor) own the send half while this
    /// `Transport` retains ownership for lifecycle/teardown.
    pub fn outbound(&self) -> mpsc::UnboundedSender<Value> {
        self.writer_tx
            .as_ref()
            .expect("transport is alive immediately after spawn")
            .clone()
    }

    /// Queue an arbitrary already-shaped message onto stdin (one JSON line).
    /// This is the escape hatch the control channel (subtask 2) uses to send
    /// `control_request` / `control_response` lines.
    pub fn send_line(&self, value: Value) -> Result<(), TransportError> {
        self.writer_tx
            .as_ref()
            .ok_or(TransportError::Closed)?
            .send(value)
            .map_err(|_| TransportError::Closed)
    }

    /// Tear the session down (spec §2.5) along a graduated ladder, so the common
    /// case is clean and the worst case still leaves zero orphans:
    ///
    ///   1. close stdin (EOF) and let `claude` exit on its own,
    ///   2. else `SIGTERM` the process group — `claude` reaps its own children,
    ///   3. else `SIGKILL` the child handle as a last resort,
    ///   4. always finish with a `SIGKILL` sweep of the whole process group, so
    ///      any straggler the leader left behind is reaped even on the graceful
    ///      path (a no-op if the group is already empty).
    ///
    /// `kill_on_drop` remains the backstop if this is never called. On non-Unix
    /// the signal steps degrade to `tokio`'s force-kill (`SIGKILL`-equivalent).
    ///
    /// `stop_remote` (remote transports only): send `fd_stop` first, telling the
    /// DAEMON to kill the server-side `claude` too. Without it, closing an
    /// attach stream merely DETACHES — the session keeps running on the server
    /// (that's the point: app quit / handle drop must not kill remote work; only
    /// the user's explicit Stop does).
    pub async fn shutdown(&mut self, stop_remote: bool) {
        if stop_remote && self.is_remote {
            if let Some(tx) = &self.writer_tx {
                let _ = tx.send(serde_json::json!({ "type": "fd_stop" }));
            }
        }
        // Step 1 — graceful EOF: drop the writer sender → writer_loop ends → stdin
        // is dropped → the child sees EOF and normally exits once the turn settles.
        self.writer_tx = None;
        let mut exited = self.wait_for_exit(Duration::from_secs(2)).await;

        // Step 2 — SIGTERM the whole group: a clean termination request that lets
        // `claude` tear down its own subprocesses before dying.
        #[cfg(unix)]
        if !exited {
            self.signal_group(libc::SIGTERM);
            exited = self.wait_for_exit(Duration::from_secs(2)).await;
        }

        // Step 3 — SIGKILL the child handle if it is still standing.
        if !exited {
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }

        // Step 4 — final SIGKILL sweep of the group. The leader is gone now, but a
        // misbehaving child it failed to reap would still be a member; this kills
        // it. Synchronous right after the leader exits → no pgid-reuse window.
        // ESRCH (empty group) is the benign, expected case.
        #[cfg(unix)]
        self.signal_group(libc::SIGKILL);

        self.stop_pumps();
    }

    /// Wait up to `d` for the child to exit; returns `true` if it did.
    async fn wait_for_exit(&mut self, d: Duration) -> bool {
        tokio::time::timeout(d, self.child.wait()).await.is_ok()
    }

    /// Send `sig` to the child's entire process group (negative pid). No-op if the
    /// pid is already gone. The child is the group leader (see [`Transport::spawn`]),
    /// so this reaches every descendant and prevents orphaned grandchildren.
    #[cfg(unix)]
    fn signal_group(&self, sig: i32) {
        if let Some(pid) = self.pid {
            // SAFETY: a plain `kill(2)` with a constant signal. The only realistic
            // error is ESRCH (the group already exited), which is benign.
            unsafe {
                libc::kill(-(pid as i32), sig);
            }
        }
    }

    /// Abort the stdio pump tasks so none outlive the process. By the time we get
    /// here the child is gone and its pipes are closed, so the loops have already
    /// hit EOF; this is the belt-and-suspenders guarantee of "no dangling task".
    fn stop_pumps(&mut self) {
        for task in self.pumps.drain(..) {
            task.abort();
        }
    }
}

/// Read stdout as newline-delimited JSON. Each non-empty line is parsed into a
/// [`CliMessage`]; parse failures are logged and skipped, never fatal (spec
/// §2.1). Ends when the stream closes or the consumer drops the receiver.
async fn reader_loop(
    stdout: ChildStdout,
    tx: mpsc::UnboundedSender<CliMessage>,
    reader_err: ErrSlot,
    lines_seen: Arc<AtomicU64>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if is_replayable_line(trimmed) {
                    lines_seen.fetch_add(1, Ordering::Relaxed);
                }
                match serde_json::from_str::<CliMessage>(trimmed) {
                    Ok(msg) => {
                        if tx.send(msg).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[transport] skipping unparseable stdout line: {e}: {}",
                            truncate(trimmed, 160)
                        );
                    }
                }
            }
            Ok(None) => break, // EOF: process closed stdout (clean — no reader_err)
            Err(e) => {
                // An IO error (broken pipe, …), NOT a clean EOF: record it so the
                // session can report a transport failure instead of a silent end.
                eprintln!("[transport] stdout read error: {e}");
                if let Ok(mut slot) = reader_err.lock() {
                    *slot = Some(e.to_string());
                }
                break;
            }
        }
    }
}

/// Drain the outbound queue onto stdin, one full JSON line at a time, flushing
/// after each so the CLI sees complete lines. Stdin stays open until the queue
/// is closed (writer sender dropped), which then signals EOF to the child.
async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Value>, writer_err: ErrSlot) {
    let record = |e: String| {
        if let Ok(mut slot) = writer_err.lock() {
            *slot = Some(e);
        }
    };
    while let Some(value) = rx.recv().await {
        let mut line = match serde_json::to_string(&value) {
            Ok(s) => s,
            Err(e) => {
                // A message we couldn't serialize is dropped (the session continues);
                // record it so a lost outbound line is diagnosable, not silent.
                eprintln!("[transport] dropping unserializable outbound message: {e}");
                record(format!("unserializable message: {e}"));
                continue;
            }
        };
        line.push('\n');
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            eprintln!("[transport] stdin write failed: {e}");
            record(format!("stdin write failed: {e}"));
            break;
        }
        if let Err(e) = stdin.flush().await {
            eprintln!("[transport] stdin flush failed: {e}");
            record(format!("stdin flush failed: {e}"));
            break;
        }
    }
    // Channel closed → drop stdin here → child receives EOF.
}

/// Forward the child's stderr to our log AND keep a bounded tail of it, so an
/// abnormal exit (auth failure, panic, MCP error) can surface its cause in the UI
/// instead of being lost to a Finder-launched bundle's invisible stderr.
async fn stderr_loop(stderr: ChildStderr, tail: StderrTail) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            eprintln!("[claude stderr] {line}");
            if let Ok(mut buf) = tail.lock() {
                if buf.len() == STDERR_TAIL_MAX {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Respect char boundaries.
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialises tests that mutate the process-wide `TOSSE_CLAUDE_BIN` env var, so they
    /// never race under the default parallel test runner.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_config_uses_path_binary() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("TOSSE_CLAUDE_BIN");
        let cfg = SpawnConfig::new("/tmp");
        assert_eq!(cfg.claude_bin, PathBuf::from("claude"));
        assert_eq!(cfg.cwd, PathBuf::from("/tmp"));
        // Local by default: no remote target, so `spawn` takes the local path.
        assert!(cfg.remote.is_none());
    }

    #[test]
    fn shell_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(shell_quote("simple"), "'simple'");
        assert_eq!(shell_quote("/work/demo"), "'/work/demo'");
        assert_eq!(shell_quote("a b"), "'a b'");
        // The classic POSIX single-quote escape: close, escaped quote, reopen.
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    /// The wire protocol MUST be identical local vs remote: the argv builder is the
    /// single source of truth, and it starts with the persistent bidirectional
    /// stream-json prefix, in order, then carries the optional per-session flags.
    #[test]
    fn build_claude_args_is_the_stream_json_protocol() {
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-opus-4-8".into());
        cfg.permission_mode = Some("auto".into());
        let a = build_claude_args(&cfg);
        assert_eq!(
            &a[0..6],
            &[
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
            ]
        );
        assert!(a.iter().any(|s| s == "--replay-user-messages"));
        assert!(a.iter().any(|s| s == "--forward-subagent-text"));
        // Optional flags flow through as adjacent (flag, value) pairs.
        let model_at = a.iter().position(|s| s == "--model").unwrap();
        assert_eq!(a[model_at + 1], "claude-opus-4-8");
    }

    /// The remote command hands the session to the server's daemon: `exec
    /// flightdeckd attach` with the reattach coordinates, then the claude argv
    /// after `--` (the daemon spawns claude with it when the session is cold).
    /// Everything shell-quoted.
    #[test]
    fn build_remote_command_execs_flightdeckd_attach() {
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-opus-4-8".into());
        cfg.resume = Some("sid-123".into());
        let remote = RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
        };
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.starts_with("exec 'flightdeckd' attach"), "cmd was: {cmd}");
        assert!(cmd.contains("--cwd '/work/demo'"));
        assert!(cmd.contains("--resume-session 'sid-123'"));
        assert!(cmd.contains("--cursor 0"));
        assert!(cmd.contains(" -- "));
        assert!(cmd.contains("'--output-format' 'stream-json'"));
        assert!(cmd.contains("'--model' 'claude-opus-4-8'"));

        // A reconnect carries the daemon conversation, epoch and cursor.
        cfg.attach = Some(AttachPoint {
            conversation: Some("conv-1".into()),
            epoch: Some("ep-1".into()),
            cursor: 42,
        });
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains("--conversation 'conv-1'"), "cmd was: {cmd}");
        assert!(cmd.contains("--epoch 'ep-1'"));
        assert!(cmd.contains("--cursor 42"));
    }

    /// The replay-cursor predicate — MUST mirror flightdeckd frames.rs
    /// `is_replayable_line` line-for-line (shared contract; drift = cursor bugs).
    #[test]
    fn replayable_line_predicate_matches_daemon_contract() {
        assert!(is_replayable_line(r#"{"type":"assistant","message":{}}"#));
        assert!(is_replayable_line(r#"{"type":"system","subtype":"init"}"#));
        assert!(is_replayable_line(r#"{"type":"stream_event","event":{}}"#));
        assert!(is_replayable_line(r#"{"type":"result","subtype":"success"}"#));
        assert!(!is_replayable_line(r#"{"type":"control_response","response":{}}"#));
        assert!(!is_replayable_line(r#"{"type":"control_request","request":{}}"#));
        assert!(!is_replayable_line(r#"{"type":"control_cancel_request"}"#));
        assert!(!is_replayable_line(r#"{"type":"keep_alive"}"#));
        assert!(!is_replayable_line(r#"{"type":"fd_attach"}"#));
        assert!(!is_replayable_line(r#"{"type":"fd_detach"}"#));
        assert!(!is_replayable_line("not json"));
        assert!(!is_replayable_line(r#"{"no_type":true}"#));
    }

    /// The `PATH` probe that `claude_available` (and `resolve_bin`) rely on: a real
    /// program on every unix `PATH` resolves; a nonsense name does not. Kept env-race
    /// free (no `TOSSE_CLAUDE_BIN` mutation) — the twin of the Codex backend's
    /// `resolves_on_path` test.
    #[test]
    fn find_on_path_resolves_real_binaries_and_rejects_fakes() {
        assert!(find_on_path(Path::new("sh")).is_some(), "sh should resolve on PATH");
        assert!(
            find_on_path(Path::new("tosse-definitely-not-a-real-binary-xyz")).is_none(),
            "a nonsense name must not resolve"
        );
    }

    /// `claude_available` honours an explicit `$TOSSE_CLAUDE_BIN` path: available iff the
    /// file exists. A path with separators is checked as-is (never searched on `PATH`).
    /// Serialised against `default_config_uses_path_binary` (both touch the shared env var)
    /// via a process-wide mutex so the two never race.
    #[test]
    fn claude_available_honours_explicit_bin_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_CLAUDE_BIN", "/bin/sh");
        assert!(claude_available(), "an existing explicit path is available");
        std::env::set_var("TOSSE_CLAUDE_BIN", "/tosse/nope/not/here/claude");
        assert!(!claude_available(), "a missing explicit path is not available");
        std::env::remove_var("TOSSE_CLAUDE_BIN");
    }

    #[test]
    fn plain_user_message_is_a_single_text_block() {
        let v = user_message("hi", "u3");
        assert_eq!(v["type"], "user");
        assert_eq!(v["uuid"], "u3");
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "hi");
    }

    #[test]
    fn user_message_with_images_puts_text_then_image_blocks() {
        let imgs = vec![ImageAttachment {
            media_type: "image/png".into(),
            data: "AAAA".into(),
        }];
        let v = user_message_with_images("hello", &imgs, "u1");
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "hello");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "AAAA");
    }

    #[test]
    fn images_only_turn_omits_the_empty_text_block() {
        let imgs = vec![ImageAttachment {
            media_type: "image/jpeg".into(),
            data: "BBBB".into(),
        }];
        let v = user_message_with_images("", &imgs, "u2");
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "an empty text block must not be sent");
        assert_eq!(content[0]["type"], "image");
    }

    /// A vanished cwd (e.g. a conversation whose worktree was deleted) must report
    /// `CwdMissing` — NOT the misleading "claude binary not found" — and must do so
    /// BEFORE spawning, so no real `claude` is needed for this test.
    #[test]
    fn spawn_on_missing_cwd_reports_cwd_not_binary() {
        let missing = PathBuf::from("/tosse/definitely/missing/worktree-gone");
        match Transport::spawn(SpawnConfig::new(missing.clone())) {
            Err(TransportError::CwdMissing(p)) => assert_eq!(p, missing),
            Err(other) => panic!("expected CwdMissing, got error: {other:?}"),
            Ok(_) => panic!("expected CwdMissing, but spawn succeeded"),
        }
    }

    /// ACCEPTANCE (zero orphans): a session's grandchild — the kind `claude`
    /// spawns for tools / MCP servers — must not survive teardown. A fake `claude`
    /// (shell script) backgrounds a long `sleep` (the "grandchild"), records its
    /// pid, then exits on stdin EOF (the graceful path) WITHOUT reaping it. After
    /// `shutdown`, the final process-group SIGKILL sweep must have reaped the
    /// grandchild anyway — exercising the real teardown, no live `claude` needed.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_reaps_orphaned_grandchildren() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-orphan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-claude.sh");
        // Ignores its (claude) args: background a grandchild, record its pid next
        // to the script, then read stdin until EOF and exit — leaving the
        // grandchild behind for the group sweep to clean up.
        fs::write(
            &script,
            "#!/bin/sh\nsleep 30 &\necho \"$!\" > \"$0.pid\"\ncat >/dev/null\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let mut cfg = SpawnConfig::new(dir.clone());
        cfg.claude_bin = script.clone();
        let (mut transport, _rx) = Transport::spawn(cfg).expect("fake claude should spawn");

        let grandchild = read_pid_when_ready(&dir.join("fake-claude.sh.pid"))
            .await
            .expect("grandchild pid should be recorded");
        assert!(is_alive(grandchild), "grandchild should run before shutdown");

        transport.shutdown(false).await;

        assert!(
            wait_until_dead(grandchild).await,
            "grandchild {grandchild} survived shutdown (orphaned)"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Poll for the pid sidecar file the fake claude writes, returning the pid.
    #[cfg(unix)]
    async fn read_pid_when_ready(path: &std::path::Path) -> Option<i32> {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if let Ok(pid) = s.trim().parse::<i32>() {
                    return Some(pid);
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        None
    }

    /// `kill(pid, 0)` probes existence without delivering a signal.
    #[cfg(unix)]
    fn is_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    async fn wait_until_dead(pid: i32) -> bool {
        for _ in 0..200 {
            if !is_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// Live end-to-end transport check. Spawns the real `claude` binary, sends a
    /// no-tool prompt, and asserts we stream an assistant reply and a successful
    /// `result` — all while stdin stays open (persistent mode).
    ///
    /// Ignored by default: needs the `claude` binary, network, auth and a tiny
    /// bit of quota. Run with:
    ///   cargo test -p tosse-code --lib -- --ignored transport_streams_a_real_text_turn --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth + quota)"]
    async fn transport_streams_a_real_text_turn() {
        let cwd = std::env::current_dir().unwrap();
        let (mut transport, mut rx) =
            Transport::spawn(SpawnConfig::new(cwd)).expect("claude should spawn");

        transport
            .send_user_text("Reply with exactly the two words: hello world. Do not use any tools.")
            .expect("send should queue");

        let mut saw_init = false;
        let mut saw_assistant_text = false;
        let mut result_ok: Option<bool> = None;

        // Drain until the turn's `result` arrives (session stays alive; result
        // marks end-of-turn, not end-of-session) or we time out.
        let deadline = Duration::from_secs(90);
        let drain = async {
            while let Some(msg) = rx.recv().await {
                match &msg {
                    CliMessage::System(crate::supervisor::protocol::SystemMsg::Init(_)) => {
                        saw_init = true;
                    }
                    CliMessage::Assistant(a) => {
                        let text = a.message.to_string().to_lowercase();
                        if text.contains("hello world") {
                            saw_assistant_text = true;
                        }
                    }
                    CliMessage::Result(r) => {
                        result_ok = Some(!r.is_error);
                        break;
                    }
                    CliMessage::Unknown => panic!("got an Unknown message: {msg:?}"),
                    _ => {}
                }
            }
        };

        tokio::time::timeout(deadline, drain)
            .await
            .expect("turn should complete within the deadline");

        transport.shutdown(false).await;

        assert!(saw_init, "expected a system/init message");
        assert!(saw_assistant_text, "expected the assistant to stream 'hello world'");
        assert_eq!(result_ok, Some(true), "expected a successful result");
    }

    /// Live end-to-end REMOTE transport check: the exact app code path for a remote
    /// conversation — `SpawnConfig.remote` → `Transport::spawn` launches `ssh` →
    /// `flightdeckd attach` on the server → the DAEMON-owned `claude` streams back →
    /// we parse the same `CliMessage`s. Proves the attach handshake (`fd_attach`),
    /// the streamed turn, AND the detach/reattach replay: after the turn we drop the
    /// transport (detach — the session survives server-side), reattach with the
    /// cursor, and expect NO duplicated stream (replay resumes exactly).
    ///
    /// Ignored by default: needs the `flightdeck-m1` container up with fresh creds
    /// (flightdeck-server: `m1-daemon/scripts/up.sh`). Run with:
    ///   cargo test -p tosse-code --lib -- --ignored remote_transport_streams_over_ssh --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container)"]
    async fn remote_transport_streams_over_ssh() {
        let remote = RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(
                std::env::var("TOSSE_M1_KEY").unwrap_or_else(|_| {
                    format!(
                        "{}/.ssh/flightdeck_m0_ed25519",
                        std::env::var("HOME").unwrap_or_default()
                    )
                }),
            ),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
        };
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.remote = Some(remote);

        let (mut transport, mut rx) =
            Transport::spawn(cfg.clone()).expect("remote (ssh) spawn should start");
        transport
            .send_user_text("Reply with exactly the two words: hello world. Do not use any tools.")
            .expect("send should queue");

        let mut saw_init = false;
        let mut saw_assistant_text = false;
        let mut result_ok: Option<bool> = None;
        let mut attach: Option<crate::supervisor::protocol::FdAttachMsg> = None;

        // Remote adds an SSH round-trip; give it comfortable headroom.
        let deadline = Duration::from_secs(120);
        let drain = async {
            while let Some(msg) = rx.recv().await {
                match &msg {
                    CliMessage::FdAttach(a) => attach = Some(a.clone()),
                    CliMessage::System(crate::supervisor::protocol::SystemMsg::Init(_)) => {
                        saw_init = true;
                    }
                    CliMessage::Assistant(a) => {
                        if a.message.to_string().to_lowercase().contains("hello world") {
                            saw_assistant_text = true;
                        }
                    }
                    CliMessage::Result(r) => {
                        result_ok = Some(!r.is_error);
                        break;
                    }
                    // Tolerate Unknown here (unlike the local test): the app NEVER
                    // panics on it — it's the logged protocol-drift canary — and a live
                    // persistent session can carry housekeeping lines this build doesn't
                    // model. We assert on the things that prove streaming works instead.
                    _ => {}
                }
            }
        };

        tokio::time::timeout(deadline, drain)
            .await
            .expect("remote turn should complete within the deadline");

        let attach = attach.expect("expected the daemon's fd_attach handshake");
        let cursor = attach.replay_from + transport.lines_seen();

        // DETACH without stopping (the app-quit path): the session must survive.
        transport.shutdown(false).await;

        // REATTACH with the cursor: the daemon must accept and NOT re-stream the
        // finished turn (no line with a seq we already counted).
        let mut cfg2 = cfg.clone();
        cfg2.attach = Some(AttachPoint {
            conversation: Some(attach.conversation.clone()),
            epoch: Some(attach.epoch.clone()),
            cursor,
        });
        let (mut transport2, mut rx2) =
            Transport::spawn(cfg2).expect("reattach spawn should start");
        let reattach = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(msg) = rx2.recv().await {
                if let CliMessage::FdAttach(a) = msg {
                    return Some(a);
                }
            }
            None
        })
        .await
        .expect("reattach should answer quickly")
        .expect("expected fd_attach on reattach");
        assert_eq!(reattach.epoch, attach.epoch, "same claude process across the detach");
        assert_eq!(
            reattach.replay_from, cursor,
            "replay must resume exactly at our cursor (no duplicates, no gaps)"
        );
        transport2.shutdown(false).await;

        assert!(saw_init, "expected a system/init message from the remote claude");
        assert!(saw_assistant_text, "expected the remote assistant to stream 'hello world'");
        assert_eq!(result_ok, Some(true), "expected a successful remote result");
    }
}
