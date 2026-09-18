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
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::{mpsc, Notify};

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
    /// The conversation's CURRENT title, threaded to a REMOTE daemon's `attach --title`
    /// (C9) so it has a real name from the very first spawn instead of sitting on
    /// `""`/its own placeholder until a rename explicitly pushes one (see
    /// `ipc::commands::push_remote_conversation_title`). Ignored locally (Claude has no
    /// daemon-side title to set) and ignored remotely too unless the paired machine's
    /// `flightdeckd` is new enough (gated in `ipc::commands::spawn_session`, exactly
    /// like [`AttachPoint::supports_skip`] — an older daemon's clap REJECTS the unknown
    /// `--title` flag outright, so this must never be guessed). Blank/`None` omits the
    /// flag entirely (see [`build_remote_command`]) — the daemon's own title (an earlier
    /// authoritative rename, or its ai-title backfill for a still-untitled one) is left
    /// alone rather than being overwritten with an empty string.
    pub conversation_title: Option<String>,
    /// WHICH Claude account this session runs on. The default slot contributes no
    /// environment at all, so a single-account setup spawns byte-for-byte as before.
    ///
    /// ⚠️ An account is chosen at SPAWN and cannot change under a live process: the CLI
    /// reads its credentials once at startup. Switching accounts therefore means stopping
    /// the session and re-spawning it with `--resume` — which is safe because the slot
    /// scopes ONLY the credential store, leaving the transcript this resumes from exactly
    /// where it was (see [`crate::accounts::slot`]).
    ///
    /// Ignored for REMOTE sessions: the daemon on the server owns its own `claude`
    /// process and its own credentials.
    pub claude_account: crate::accounts::AccountSlot,
}

/// Where to resume a remote attach stream: the daemon-side conversation, the
/// claude-process epoch, and the reattach cursor — the wire POSITION (not a
/// raw count) this client can prove it has fully received in that epoch, i.e.
/// every replayable line up to and including that point either parsed or was
/// explicitly given up on (see `session.rs::reattach_cursor_delta`, which
/// composes it; never a bare `lines_seen`). See flightdeckd `frames.rs` — the
/// replay-eligibility predicate ([`is_replayable_line`]) is a shared contract.
#[derive(Debug, Clone, Default)]
pub struct AttachPoint {
    pub conversation: Option<String>,
    pub epoch: Option<String>,
    pub cursor: u64,
    /// Opt into the daemon's reattach-replay compaction (D6): the client can prove it
    /// tracks `fd_skip{from,to}` frames instead of a literal replay of every line, so
    /// [`build_remote_command`] appends `--supports-skip`. Decided ONCE, before the
    /// FIRST spawn, from a cached per-machine version probe (`ipc::commands::
    /// supports_skip_for_machine`) — an older daemon's clap REJECTS the unknown flag
    /// outright, so this must never be guessed or flipped mid-session; every
    /// reconnect for the same session carries the SAME value forward (see
    /// `session.rs::run_actor`). Default `false`: the unchanged, pre-D6 wire.
    pub supports_skip: bool,
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
    /// Every candidate address for this server, `host` always FIRST (see
    /// `ipc::commands::remote_target_addresses`), that [`super::session::run_actor`]'s
    /// address-rotation policy (A6) rotates `host` through on a sustained reconnect
    /// failure. Never empty, even for a paired-before-A5 machine with no recorded
    /// candidates: that case falls back to the single known-good `host` (and A6's
    /// rotation never fires, since there is nothing else to try).
    pub addresses: Vec<String>,
    /// The [`super::super::store::MachineRecord::id`] this target was built from, so a
    /// SUCCESSFUL address rotation (A6) can report which machine's `host` to persist
    /// back to. `None` for every test/fixture `RemoteTarget` that names no real
    /// machine row — rotation still works (it only mutates `host` in memory for this
    /// session), it just never emits a persist signal with nothing to key it by.
    pub machine_id: Option<String>,
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
            conversation_title: None,
            // The CLI's own credential store, i.e. exactly the pre-multi-account behaviour.
            claude_account: crate::accounts::AccountSlot::default_slot(),
        }
    }
}

fn default_claude_bin() -> PathBuf {
    std::env::var_os("TOSSE_CLAUDE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("claude"))
}

/// The `ssh` binary a remote spawn execs. `$TOSSE_SSH_BIN` first — a test-only
/// escape hatch mirroring `$TOSSE_CLAUDE_BIN` (see [`default_claude_bin`]), so a
/// test can point a remote launch at a fake script (e.g. one that exits 127 to
/// simulate a missing `flightdeckd`) without mutating `$PATH` — else the bare
/// `"ssh"` resolved on `PATH`, exactly as before. Never set in production.
fn resolve_ssh_bin() -> String {
    std::env::var("TOSSE_SSH_BIN").unwrap_or_else(|_| "ssh".to_string())
}

/// Serialises EVERY test in the crate that mutates the process-wide `TOSSE_SSH_BIN`
/// env var [`resolve_ssh_bin`] reads — shared across `transport::tests` (which spawns
/// [`push_remote_title`]/[`run_remote_stop`] directly) AND `session::tests` (which
/// drives real reconnects through the SAME env var via `run_actor`'s remote spawns),
/// so their tests can never race each other's mutation of the ONE real process
/// environment, even though the default test runner runs different modules'
/// tests concurrently on different threads. A single, crate-visible lock — NOT two
/// independent per-module ones — is the only way two different modules' tests can
/// serialise against a variable neither of them owns exclusively; a std `Mutex`
/// that panics while held gets POISONED, and each module's fake-ssh scripts are
/// exercised often enough that two independent locks silently let one module's
/// `set_var` stomp the other's mid-test (a real bug this fixes, not a hypothetical
/// one — see the C9 task report).
#[cfg(test)]
pub(crate) static SSH_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

/// Resolve `daemon_bin` into the POSIX-sh fragment [`build_remote_command`] (and
/// [`run_remote_stop`]) `exec`s, searching the remote host in the SAME order
/// `commands::probe_remote`'s script checks it in — `PATH` (as a non-interactive ssh
/// shell sees it), then the two common non-PATH install spots, `~/.local/bin` and
/// `/usr/local/bin` — so a passing probe is a genuine guarantee the later `attach`
/// finds the same binary. Before this, the probe searched all three spots but the
/// actual attach bare-`exec`'d `daemon_bin` with NO fallback, relying purely on PATH:
/// a server with `flightdeckd` only under `~/.local/bin` (not on a non-interactive
/// ssh shell's default PATH on Debian/Ubuntu) would pass pairing and then fail on the
/// very first attach.
///
/// Applies ONLY to a bare name (the default `"flightdeckd"`, or any
/// `TOSSE_REMOTE_FLIGHTDECKD_BIN` override without a `/`): an explicit path is used
/// exactly as given, unsearched — mirroring [`resolve_bin`]'s local "an explicit path
/// wins outright" rule. The bare name itself is shell-quoted throughout, so an
/// unusual (but slash-free) override can't break the surrounding script.
fn resolve_remote_daemon_bin(daemon_bin: &str) -> String {
    if daemon_bin.contains('/') {
        return shell_quote(daemon_bin);
    }
    let name = shell_quote(daemon_bin);
    format!(
        "$(FLIGHTDECKD_NAME={name}; command -v \"$FLIGHTDECKD_NAME\" 2>/dev/null || \
         {{ [ -x \"$HOME/.local/bin/$FLIGHTDECKD_NAME\" ] && printf %s \"$HOME/.local/bin/$FLIGHTDECKD_NAME\"; }} || \
         {{ [ -x \"/usr/local/bin/$FLIGHTDECKD_NAME\" ] && printf %s \"/usr/local/bin/$FLIGHTDECKD_NAME\"; }} || \
         printf %s \"$FLIGHTDECKD_NAME\")"
    )
}

/// Build the single POSIX-sh command `ssh` runs on the remote host: `exec
/// flightdeckd attach …`. The DAEMON owns the `claude` process server-side
/// (spawning it with the argv passed after `--` if it isn't already running,
/// env included) and bridges this ssh channel to it — replaying everything the
/// client missed since [`AttachPoint::cursor`]. Every interpolated value is
/// single-quote-escaped, so remote paths/args with spaces or metacharacters are
/// safe. `daemon_bin` itself goes through [`resolve_remote_daemon_bin`] rather than a
/// bare `exec`, so this genuinely finds `flightdeckd` wherever `commands::probe_remote`
/// found it — see that function's doc comment.
fn build_remote_command(cfg: &SpawnConfig, remote: &RemoteTarget, args: &[String]) -> String {
    let attach = cfg.attach.clone().unwrap_or_default();
    let mut s = format!("exec {} attach", resolve_remote_daemon_bin(&remote.daemon_bin));
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
    // Opt into fd_skip reattach-replay compaction (D6) — ONLY when the gate in
    // `ipc::commands::supports_skip_for_machine` already confirmed the daemon's
    // version accepts it. An older daemon's clap REJECTS an unknown flag outright
    // (the whole attach fails), so this is never speculative.
    if attach.supports_skip {
        s.push_str(" --supports-skip");
    }
    // C9: the conversation's title, ONLY through `shell_quote` and joined with `=`
    // (never a separate token) — `--title '-foo'` would let clap parse `-foo` as a
    // new flag instead of the value; `--title='-foo'` cannot be misread that way
    // regardless of what the title starts with. Blank/`None` omits the flag so an
    // untitled conversation never overwrites the daemon's own title (its ai-title
    // backfill, or an earlier authoritative rename) with nothing.
    if let Some(title) = cfg.conversation_title.as_deref() {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            s.push_str(&format!(" --title={}", shell_quote(trimmed)));
        }
    }
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
    let mut cmd = Command::new(resolve_ssh_bin());
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
        resolve_remote_daemon_bin(&remote.daemon_bin),
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

/// Best-effort push of a conversation's CURRENT title to the daemon's authoritative
/// record (C9), for a rename that happens while this Mac is NOT the one driving the
/// conversation. There is no title-only verb on the wire — `flightdeckd` only knows
/// `--title` as an `attach` flag (see flightdeck-server `attach.rs`/`main.rs`,
/// `program/wave2`) — so this borrows `attach` itself for a bounded, ONE-SHOT ssh
/// round trip mirroring [`run_remote_stop`]'s shape (spawn, wait bounded, report
/// success/failure — never a persistent bridge like a real live session).
///
/// The title write happens SYNCHRONOUSLY on the daemon's side, in its connection
/// handler, strictly BEFORE it ever writes back the `fd_attach` acknowledgement (see
/// `attach.rs::handle_conn`) — but that acknowledgement itself is NOT a reliable
/// success signal to wait on: it is only queued once the daemon's actor reaches
/// `on_attach`, which for the ONLY case this function is ever used for — an IDLE
/// conversation — means cold-starting `claude --resume <id>` first, a spawn
/// LIVE-VERIFIED (m1 fixture, C9 task) to sometimes take many seconds or never
/// complete at all, while the title write itself never waits on it. See the grace
/// window's doc on the read below for exactly how this is handled. This never sends
/// `fd_stop` (that would ALSO stop the remote `claude` process, which a mere title
/// push has no business doing). `--cursor` is set to `u64::MAX` purely defensively
/// (see [`build_remote_command`]'s doc — without a matching `--epoch` it can never
/// actually be honoured, but there's no reason to send a false "start from nothing"
/// bound either).
///
/// ⚠️ SAFETY (caller contract): only call this when THIS Mac holds no live session for
/// the conversation — `on_attach` on the daemon UNCONDITIONALLY `detach_current
/// ("replaced", …)`s whoever is CURRENTLY attached, and `"replaced"` is a TERMINAL
/// [`super::session`]`::reconnect_policy_for_reason` here: stealing this Mac's own
/// live link out from under itself would kill it (until the conversation is reopened)
/// rather than merely rename it. A live session's own next reattach already carries
/// the current title forward (see [`SpawnConfig::conversation_title`]), so skipping
/// this while live loses nothing. That liveness check is front-end-only state
/// (`conv.handle` in `conversationsStore.ts`) and cannot be re-derived here.
///
/// ⚠️ KNOWN LIMITATION: a conversation the daemon has no RUNNING actor for right now
/// still triggers the daemon's normal cold-start (`--resume-session`) as a side effect
/// of merely attaching — a real, if mild, side effect (a resumed but message-less
/// `claude` process left running server-side) this helper does not eliminate. A
/// dedicated, title-only `set-title` verb (no session semantics at all) is the clean
/// fix; see the C9 task report for the precise ask.
pub async fn push_remote_title(remote: &RemoteTarget, session_id: &str, cwd: &str, title: &str) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    let mut cmd = Command::new(resolve_ssh_bin());
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
        "exec {} attach --resume-session {} --cwd {} --title={} --cursor {}",
        resolve_remote_daemon_bin(&remote.daemon_bin),
        shell_quote(session_id),
        shell_quote(cwd),
        shell_quote(title.trim()),
        u64::MAX,
    ));
    // ⚠️ LOAD-BEARING, live-verified: stdin must stay OPEN, never `Stdio::null()`. A
    // null stdin puts ssh's local side at EOF instantly, which it forwards to the
    // remote channel right away — `attach_client`'s stdin pump then closes its
    // write-half to the daemon's unix socket almost immediately, and against a real
    // daemon this consistently raced the daemon's own client-gone handling ahead of
    // it ever sending anything: the reply (built and queued correctly — the title
    // write itself, per the doc above, had ALREADY landed by then) was silently
    // never flushed, and our read saw a clean EOF with zero bytes. Piping stdin
    // instead and simply never writing to (or dropping) it keeps ssh's local side
    // from ever signalling EOF, so the daemon gets the normal amount of time a real
    // client would.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[transport] remote title push failed to launch ssh: {e}");
            return false;
        }
    };
    // Held for the rest of this function so its pipe write-end stays open (see the
    // doc above) — dropped only at the very end, alongside tearing the child down.
    let _stdin_open = child.stdin.take();
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return false;
    };
    let mut reader = BufReader::new(stdout);
    let mut first_line = String::new();
    // Race three outcomes:
    //  - a reply line arrives: an `fd_detach` is a real failure, anything else
    //    (normally `fd_attach`) a real success;
    //  - a CLEAN EOF (0 bytes, no error) with no line ever arriving: read as
    //    SUCCESS, not failure — see the load-bearing note below;
    //  - the ssh CHILD exits on its own before either: its own exit status is
    //    the verdict (a connection-level failure — daemon down, host
    //    unreachable, auth refused — makes `attach_client` return `Err` and the
    //    process exit non-zero);
    //  - none of the above within `ACK_GRACE`: the daemon's write is already
    //    durable by then regardless (see the doc above), so this is read as
    //    success too — never a timeout-as-failure the way a naive "wait for the
    //    ack" read would.
    // ⚠️ LOAD-BEARING, live-verified against a real daemon (m1 fixture, C9 task):
    // resuming an IDLE conversation — the ONLY case this function is ever used
    // for — cold-starts `claude --resume <id>` server-side. Against the real
    // daemon this consistently produced a clean, fast (well under `ACK_GRACE`)
    // EOF with ZERO bytes and no `fd_attach` ever sent — yet a `flightdeckd
    // status` check straight after showed the title HAD landed every single
    // time. The title write is a plain SQL statement run synchronously in the
    // connection handler the instant `manager.attach()` returns — it does not
    // wait on the daemon ever managing to reply, and neither does this. An
    // earlier version of this function read a clean EOF (and a timeout) as
    // failure — a false negative on a write that had, provably, already landed.
    const ACK_GRACE: Duration = Duration::from_secs(3);
    let ok = tokio::select! {
        res = reader.read_line(&mut first_line) => match res {
            Ok(0) => true,
            Ok(_) => !first_line.contains("\"type\":\"fd_detach\""),
            Err(_) => false,
        },
        status = child.wait() => matches!(status, Ok(s) if s.success()),
        _ = tokio::time::sleep(ACK_GRACE) => true,
    };
    // Tear the ssh process down explicitly (never `fd_stop`) rather than relying on
    // `kill_on_drop`'s best-effort background reap — same "no orphans" discipline as
    // every other process this crate spawns.
    let _ = child.kill().await;
    let _ = child.wait().await;
    ok
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
    /// Fired by `stderr_loop` right after it hits EOF (buffers one permit if
    /// nobody is waiting yet, so this can never be missed). Lets a caller that
    /// just reaped the child via [`Self::wait_status`] wait for the stderr
    /// pump to have actually drained the pipe before reading
    /// [`Self::stderr_tail`] — otherwise the two race (see
    /// [`Self::wait_stderr_drained`]).
    stderr_done: Arc<Notify>,
    /// Set if the stdout reader ended on an IO error (vs a clean EOF).
    reader_err: ErrSlot,
    /// Set if the stdin writer died on a write/flush/serialize failure.
    writer_err: ErrSlot,
    /// Count of REPLAYABLE stdout lines successfully parsed and forwarded (see
    /// [`is_replayable_line`]) — the reattach cursor for remote sessions. Always
    /// 0-based per transport. ⚠️ Deliberately excludes a replayable line that
    /// failed to parse (see [`Self::unparseable_replayable`]): counting it here
    /// would tell the daemon we received a message we actually dropped, so it
    /// would never be replayed again — permanently lost.
    lines_seen: Arc<AtomicU64>,
    /// Count of REPLAYABLE stdout lines that failed `serde_json` parsing this
    /// connection (excluded from [`Self::lines_seen`] on purpose — see there).
    /// The session actor watches this across reconnects to bound how long it
    /// keeps asking the daemon to replay something it can never parse.
    unparseable_replayable: Arc<AtomicU64>,
    /// `lines_seen`'s value at the moment the FIRST unparseable replayable line
    /// hit this connection — i.e. how many replayable lines were successfully
    /// parsed strictly BEFORE it. `u64::MAX` means no failure yet this
    /// connection. ⚠️ Load-bearing for the reattach cursor: `lines_seen()`
    /// alone is a raw success COUNT, not the daemon's wire POSITION, so it
    /// silently overtakes an earlier unparsed line whenever later lines in the
    /// SAME connection parse fine (session.rs's cursor math must roll back to
    /// this offset instead — see `run_actor`).
    first_unparseable_offset: Arc<AtomicU64>,
    /// Set once by `reader_loop` when an `fd_skip{from,to}` frame's `from` did not
    /// match this connection's recorded wire position (see [`apply_fd_skip`]) — a
    /// protocol violation the daemon should never produce. `None` once
    /// [`Self::take_skip_violation`] has consumed it (or nothing has gone wrong).
    /// Surfaced by the session actor as a single `protocol_error` notice — see
    /// `session.rs::run_actor`.
    skip_violation: Arc<Mutex<Option<String>>>,
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
            let mut cmd = Command::new(resolve_ssh_bin());
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
            // Scope the credential store to the chosen account. The default slot sets
            // nothing, so this is a no-op for a single-account user.
            cfg.claude_account.apply(&mut cmd);
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
        let stderr_done: Arc<Notify> = Arc::new(Notify::new());
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let writer_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable_replayable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable_offset: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let pumps = vec![
            tokio::spawn(reader_loop(
                stdout,
                msg_tx,
                reader_err.clone(),
                lines_seen.clone(),
                unparseable_replayable.clone(),
                first_unparseable_offset.clone(),
                skip_violation.clone(),
            )),
            tokio::spawn(writer_loop(stdin, writer_rx, writer_err.clone())),
            tokio::spawn(stderr_loop(stderr, stderr_tail.clone(), stderr_done.clone())),
        ];

        Ok((
            Transport {
                pid,
                writer_tx: Some(writer_tx),
                child,
                pumps,
                stderr_tail,
                stderr_done,
                reader_err,
                writer_err,
                lines_seen,
                unparseable_replayable,
                first_unparseable_offset,
                skip_violation,
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

    /// How many replayable stream lines this connection could NOT be parsed
    /// (and so are missing from [`Self::lines_seen`]). The session actor uses
    /// this to bound retrying a line it can never parse across reconnects —
    /// see `session.rs::malformed_replay_step`.
    pub fn unparseable_replayable(&self) -> u64 {
        self.unparseable_replayable.load(Ordering::Relaxed)
    }

    /// How many replayable lines this connection parsed successfully BEFORE
    /// the first one it could not — `None` if every replayable line so far
    /// has parsed. This is the true rollback point for a reattach: unlike
    /// [`Self::lines_seen`] (a raw success count), it does not creep forward
    /// when later lines in the same connection happen to parse fine, so the
    /// session actor can ask the daemon to replay starting right before the
    /// line it lost instead of skipping past it — see `session.rs::run_actor`.
    pub fn first_unparseable_offset(&self) -> Option<u64> {
        match self.first_unparseable_offset.load(Ordering::Relaxed) {
            u64::MAX => None,
            n => Some(n),
        }
    }

    /// Take (and clear) a one-time note that this connection received an `fd_skip`
    /// frame whose `from` did not match our recorded wire position — see
    /// [`apply_fd_skip`]. `None` on every call after the first (or when nothing has
    /// gone wrong this connection). The session actor polls this whenever it wakes up
    /// to process the next inbound message and, if `Some`, surfaces it as a single
    /// `protocol_error` notice — see `session.rs::run_actor`.
    pub fn take_skip_violation(&self) -> Option<String> {
        self.skip_violation.lock().ok().and_then(|mut g| g.take())
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

    /// Wait (bounded) for `stderr_loop` to have drained the pipe to EOF, so a
    /// [`Self::stderr_tail`] read right after this reflects EVERYTHING the
    /// process wrote before exiting. Without this, a caller that just reaped
    /// the child via [`Self::wait_status`] and immediately calls
    /// `stderr_tail()` races the independent pump task — in practice `wait`
    /// only resolves once the OS has already delivered SIGCHLD, which gives
    /// the pump (a much cheaper buffered read) ample opportunity to finish
    /// first, but nothing GUARANTEES it. Bounded so a stuck pump (should
    /// never happen — the pipe closes with the process) can never hang the
    /// caller; on the happy path this returns almost instantly.
    pub async fn wait_stderr_drained(&self) {
        let _ = tokio::time::timeout(Duration::from_millis(500), self.stderr_done.notified()).await;
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
///
/// Generic over the reader so this can be driven by a [`tokio::io::duplex`] half
/// in tests, not just a real [`ChildStdout`].
///
/// ⚠️ `lines_seen` is incremented ONLY on a successful parse — see its doc on
/// [`Transport`] for why counting an unparseable line there would silently and
/// permanently drop it. A replayable line that fails to parse instead bumps
/// `unparseable_replayable`, so the actor knows to ask the daemon to replay it
/// again on the next reattach (and to bound that across reconnects — see
/// `session.rs::malformed_replay_step`), and — the FIRST time only this
/// connection — stamps `first_unparseable_offset` with `lines_seen`'s value at
/// that moment, so a reattach can roll back to right before it even if MORE
/// replayable lines go on to parse fine afterward (see
/// `Transport::first_unparseable_offset`'s doc for why that distinction
/// matters).
///
/// D6: an `fd_skip{from,to}` frame is intercepted HERE, never forwarded through
/// `tx` — it folds `to-from+1` replayable lines straight into `lines_seen`
/// (see [`apply_fd_skip`]) instead of being individually re-parsed, and a
/// mismatch against the connection's recorded position is recorded once in
/// `skip_violation` for the session actor to surface.
///
/// ⚠️ `fd_skip{from,to}` is in the DAEMON's session-absolute seq space (the same
/// numbering as `fd_attach.replay_from`), while `lines_seen` is always 0-based
/// PER CONNECTION (reset by every `Transport::spawn`, including every
/// reconnect — see its doc). Reconciling the two requires this connection's own
/// `attach_base`: the `replay_from` carried by the `fd_attach` frame the daemon
/// always sends first on a remote attach stream (a local, non-remote session
/// never sees `fd_attach`/`fd_skip` at all, so `attach_base` simply stays `0`
/// and every check below degrades to the pre-D6, connection-relative-only math).
/// Captured HERE, from the live wire message, rather than threaded in from
/// `SpawnConfig` — the daemon's actual `replay_from` is the authoritative base,
/// not the cursor we merely asked to resume from.
async fn reader_loop<R: tokio::io::AsyncRead + Unpin>(
    stdout: R,
    tx: mpsc::UnboundedSender<CliMessage>,
    reader_err: ErrSlot,
    lines_seen: Arc<AtomicU64>,
    unparseable_replayable: Arc<AtomicU64>,
    first_unparseable_offset: Arc<AtomicU64>,
    skip_violation: Arc<Mutex<Option<String>>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    // This connection's absolute base (see the doc above) — learned from the
    // FIRST `fd_attach` frame it receives, `0` until then (and forever, for a
    // local session or a remote one that never gets one).
    let mut attach_base: u64 = 0;
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let replayable = is_replayable_line(trimmed);
                match serde_json::from_str::<CliMessage>(trimmed) {
                    Ok(CliMessage::FdSkip(skip)) => {
                        // D6: fold the skipped range directly into this connection's
                        // position counter — `fd_skip` itself is never replayable (the
                        // `fd_` prefix excludes it, like `fd_attach`/`fd_detach`) and is
                        // NEVER forwarded to the UI (there is nothing for the assembler
                        // to render). See `apply_fd_skip`'s doc for the invariant.
                        let current = lines_seen.load(Ordering::Relaxed);
                        let (new_position, violation) =
                            apply_fd_skip(attach_base, current, skip.from, skip.to);
                        lines_seen.store(new_position, Ordering::Relaxed);
                        if violation {
                            let expected = attach_base + current + 1;
                            let note = format!(
                                "server sent fd_skip{{from:{}, to:{}}} but this connection \
                                 expected the next replayable seq to be {expected} \
                                 (attach_base {attach_base} + position {current}) — \
                                 resyncing to relative position {new_position}",
                                skip.from, skip.to
                            );
                            eprintln!("[transport] {note}");
                            if let Ok(mut slot) = skip_violation.lock() {
                                if slot.is_none() {
                                    *slot = Some(note);
                                }
                            }
                        }
                    }
                    Ok(msg) => {
                        if let CliMessage::FdAttach(attach) = &msg {
                            // Learn this connection's absolute base from the daemon's
                            // own claim, BEFORE any `fd_skip` on this connection can
                            // arrive (the daemon always sends `fd_attach` first).
                            attach_base = attach.replay_from;
                        }
                        if replayable {
                            lines_seen.fetch_add(1, Ordering::Relaxed);
                        }
                        if tx.send(msg).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        if replayable {
                            unparseable_replayable.fetch_add(1, Ordering::Relaxed);
                            // Stamp the rollback point once, on the FIRST failure
                            // this connection: `lines_seen` right now is exactly
                            // "successes strictly before this line". A later
                            // success must not move this — that is the whole
                            // point of tracking it separately from `lines_seen`.
                            let _ = first_unparseable_offset.compare_exchange(
                                u64::MAX,
                                lines_seen.load(Ordering::Relaxed),
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            );
                        }
                        eprintln!(
                            "[transport] skipping unparseable {} stdout line: {e}: {}",
                            message_type_hint(trimmed),
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

/// Pure step function applying one `fd_skip{from,to}` frame (D6) to a connection's
/// replayable-line position counter (mirrors [`Transport::lines_seen`]) — kept
/// separate from [`reader_loop`] so the invariant is unit-testable without a live
/// transport.
///
/// `from`/`to` are in the DAEMON's session-absolute seq space (same numbering as
/// `fd_attach.replay_from` — see the flightdeckd sibling repo's `session.rs`/
/// `replay.rs`), while `current` (and the returned `new_position`) are this
/// connection's own 0-based [`Transport::lines_seen`]. `attach_base` — this
/// connection's own `fd_attach.replay_from`, `0` if none was ever seen — bridges
/// the two spaces: the absolute position this connection has actually reached is
/// `attach_base + current`, so the daemon's next skip is only valid when
/// `attach_base + current + 1 == from` (⚠️ NOT `current + 1 == from` — that bare
/// form is only correct by coincidence when `attach_base` happens to be `0`, i.e.
/// the very first attach of a session; every later reattach has a nonzero base,
/// which is precisely when a skip actually fires in practice).
///
/// The daemon is contractually supposed to only ever skip a well-formed range
/// (`to >= from`) starting exactly where our reported position left off. That
/// should never fail, but a client that blindly trusted it anyway would silently
/// corrupt its reattach cursor forever after a single dropped/reordered/malformed
/// frame, so this verifies it instead of assuming it:
///   - match (`attach_base + current + 1 == from` AND `to >= from`): the whole
///     range is absorbed — `new_position = to - attach_base` (back in this
///     connection's relative space; equivalently `current + (to - from + 1)`).
///   - mismatch (bad `from`, OR a matching `from` with an inverted `to < from`):
///     still resync to the daemon's own claim, converted into this connection's
///     relative space (`to.saturating_sub(attach_base)`), so a transient
///     disagreement cannot wedge the connection forever repeating the same
///     mismatch, but NEVER move backwards — `current.max(...)` — a stale,
///     reordered, or (for the inverted-range case) nonsensical `to` behind where
///     we already are must not un-count lines we already have.
///
/// Returns `(new_position, violation)`; the caller surfaces `violation` as a one-time
/// `protocol_error` notice (see [`Transport::take_skip_violation`]).
fn apply_fd_skip(attach_base: u64, current: u64, from: u64, to: u64) -> (u64, bool) {
    if attach_base + current + 1 == from && to >= from {
        (to - attach_base, false)
    } else {
        (current.max(to.saturating_sub(attach_base)), true)
    }
}

/// Best-effort `"type"` field of an unparseable line, for the skip log —
/// pulled with a generic `Value` parse (which tolerates a shape `CliMessage`
/// itself rejected) so the log names WHAT we dropped, not just that we did.
fn message_type_hint(line: &str) -> String {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_else(|| "?".to_string())
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
///
/// Notifies `done` once the pipe hits EOF, so [`Transport::wait_stderr_drained`]
/// can be sure the tail is complete before a caller reads it.
async fn stderr_loop(stderr: ChildStderr, tail: StderrTail, done: Arc<Notify>) {
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
    done.notify_one();
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
    /// $(… flightdeckd lookup …) attach` with the reattach coordinates, then the
    /// claude argv after `--` (the daemon spawns claude with it when the session is
    /// cold). Everything shell-quoted; the daemon binary itself is resolved via
    /// [`resolve_remote_daemon_bin`] (checked separately below), not a bare name.
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
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        };
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.starts_with("exec $(FLIGHTDECKD_NAME='flightdeckd'"), "cmd was: {cmd}");
        assert!(cmd.contains(") attach"), "the resolved-bin substitution feeds `attach`: {cmd}");
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
            supports_skip: false,
        });
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains("--conversation 'conv-1'"), "cmd was: {cmd}");
        assert!(cmd.contains("--epoch 'ep-1'"));
        assert!(cmd.contains("--cursor 42"));
        assert!(!cmd.contains("--supports-skip"), "must not opt in unless asked: {cmd}");

        // Asking opts in — the flag rides at the end of the reattach coordinates,
        // before the claude argv separator.
        cfg.attach = Some(AttachPoint {
            conversation: Some("conv-1".into()),
            epoch: Some("ep-1".into()),
            cursor: 42,
            supports_skip: true,
        });
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains("--supports-skip"), "cmd was: {cmd}");

        // C9: an unset/blank title omits the flag entirely (never overwrite the
        // daemon's own title with an empty string).
        assert!(!cmd.contains("--title"), "no title set: {cmd}");
        cfg.conversation_title = Some("   ".into());
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(!cmd.contains("--title"), "a blank title must still omit the flag: {cmd}");

        // A real title rides `=`-joined and shell-quoted, right after the reattach
        // coordinates and before the claude argv separator.
        cfg.conversation_title = Some("My Feature".into());
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains("--title='My Feature'"), "cmd was: {cmd}");
        assert!(cmd.find("--title=").unwrap() < cmd.find(" -- ").unwrap(), "title precedes claude argv: {cmd}");
    }

    /// C9 regression: `--title` MUST be `=`-joined (never a separate token) so a title
    /// starting with `-` can never be misparsed as a new flag by clap — and every
    /// interpolated value must survive a REAL POSIX shell's parsing of the whole
    /// composed command byte-for-byte, since that is exactly what `ssh` hands the
    /// remote shell. Runs the built command through a real local `sh -c`, with the
    /// resolved "daemon binary" replaced by a tiny script that just echoes back the
    /// `--title=` value verbatim (no trailing newline, so even a title that itself
    /// ends in whitespace round-trips exactly).
    #[cfg(unix)]
    #[test]
    fn build_remote_command_title_survives_a_real_shell_round_trip() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-quote-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let echo_title = dir.join("echo-title.sh");
        fs::write(
            &echo_title,
            r#"#!/bin/sh
for a; do
    case "$a" in
        --title=*) printf '%s' "${a#--title=}" ;;
    esac
done
"#,
        )
        .unwrap();
        fs::set_permissions(&echo_title, fs::Permissions::from_mode(0o755)).unwrap();

        let remote = RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            // An EXPLICIT path (contains '/') is used unsearched — see
            // `resolve_remote_daemon_bin`'s doc — so `attach` execs our script.
            daemon_bin: echo_title.to_string_lossy().into_owned(),
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        };

        let adversarial = [
            "simple",
            "embedded 'single' quotes",
            "embedded \"double\" quotes",
            "$(rm -rf /)",
            "`whoami`",
            "line one\nline two",
            "-looks-like-a-flag",
            &"x".repeat(4096),
        ];
        for title in adversarial {
            let mut cfg = SpawnConfig::new("/work/demo");
            cfg.conversation_title = Some(title.to_string());
            let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(&cmd)
                .output()
                .expect("sh should run");
            let got = String::from_utf8_lossy(&out.stdout);
            assert_eq!(got.as_ref(), title, "title round-trip broke for {title:?} — cmd was: {cmd}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// [`resolve_remote_daemon_bin`] must search the remote host the SAME way
    /// `commands::probe_remote`'s script does (`PATH`, then `~/.local/bin`, then
    /// `/usr/local/bin`) for a bare name — this is the fix for the gap where a passing
    /// probe (which DID search all three) didn't guarantee `attach` (which previously
    /// bare-`exec`'d the name, PATH-only) would find the same binary. An explicit path
    /// override is left completely unsearched, exactly as given.
    #[test]
    fn resolve_remote_daemon_bin_searches_path_then_local_then_usr_local_for_a_bare_name() {
        let resolved = resolve_remote_daemon_bin("flightdeckd");
        assert!(resolved.starts_with("$(FLIGHTDECKD_NAME='flightdeckd';"), "got: {resolved}");
        assert!(resolved.contains("command -v \"$FLIGHTDECKD_NAME\""), "checks PATH first: {resolved}");
        assert!(
            resolved.contains("$HOME/.local/bin/$FLIGHTDECKD_NAME"),
            "falls back to ~/.local/bin: {resolved}"
        );
        assert!(
            resolved.contains("/usr/local/bin/$FLIGHTDECKD_NAME"),
            "falls back to /usr/local/bin: {resolved}"
        );

        // An explicit path (e.g. TOSSE_REMOTE_FLIGHTDECKD_BIN set to a full path) is
        // used exactly as given, unsearched — mirrors `resolve_bin`'s local rule.
        let explicit = resolve_remote_daemon_bin("/opt/flightdeckd/bin/flightdeckd");
        assert_eq!(explicit, "'/opt/flightdeckd/bin/flightdeckd'", "no search for an explicit path");
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
        assert!(!is_replayable_line(r#"{"type":"fd_skip","from":1,"to":2}"#));
        assert!(!is_replayable_line("not json"));
        assert!(!is_replayable_line(r#"{"no_type":true}"#));
    }

    fn test_remote_target(daemon_bin: impl Into<String>) -> RemoteTarget {
        RemoteTarget {
            host: "example.invalid".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: daemon_bin.into(),
            addresses: vec!["example.invalid".into()],
            machine_id: None,
        }
    }

    /// A blank/whitespace-only title is rejected up front — no ssh is even spawned
    /// (nothing to prove: `TOSSE_SSH_BIN` is deliberately left unset/invalid).
    #[tokio::test]
    async fn push_remote_title_rejects_a_blank_title_without_touching_ssh() {
        let _guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", "/definitely/not/a/real/binary");
        let ok = push_remote_title(&test_remote_target("flightdeckd"), "sid-1", "/work/demo", "   ").await;
        std::env::remove_var("TOSSE_SSH_BIN");
        assert!(!ok, "a blank title must be rejected before ever spawning ssh");
    }

    /// A clean daemon-side `fd_attach` acknowledgement (title already written by the
    /// time it's sent — see the doc on [`push_remote_title`]) reads as success, and the
    /// ssh child is torn down rather than left attached (fake daemon sleeps forever
    /// after the ack; the test's own bounded timeout is the "no lingering" assertion).
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_returns_true_on_a_clean_ack() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-push-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"fd_attach\",\"conversation\":\"c1\",\"epoch\":\"e1\",\"replay_from\":0}'\nsleep 30\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let ok = tokio::time::timeout(
            Duration::from_secs(10),
            push_remote_title(&test_remote_target("flightdeckd"), "sid-1", "/work/demo", "My Feature"),
        )
        .await
        .expect("push_remote_title must not hang on a daemon that never closes its side");
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        let _ = fs::remove_dir_all(&dir);

        assert!(ok, "a clean fd_attach ack should read as success");
    }

    /// An error reply (`fd_detach`, e.g. the daemon rejecting the attach) reads as
    /// failure — never mistaken for a successful title push. Exits non-zero AFTER
    /// printing it (rather than just falling off the end at 0) so the assertion
    /// holds regardless of which side of the `tokio::select!` race wins — reading
    /// the `fd_detach` line, or observing the script's own exit status — both must
    /// agree this is a failure; a script that exited 0 would make the exit-status
    /// branch (mis)read as success if it happened to win.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_returns_false_on_an_error_reply() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-push-err-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"fd_detach\",\"reason\":\"error\",\"message\":\"no such conversation\"}'\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let ok = tokio::time::timeout(
            Duration::from_secs(10),
            push_remote_title(&test_remote_target("flightdeckd"), "sid-1", "/work/demo", "My Feature"),
        )
        .await
        .expect("push_remote_title must not hang");
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        let _ = fs::remove_dir_all(&dir);

        assert!(!ok, "an fd_detach error reply must not read as success");
    }

    /// The grace-window regression this whole redesign exists for (see
    /// `push_remote_title`'s doc): a daemon that stays connected but sends NOTHING
    /// back within the grace window (exactly what a slow/hung `claude --resume`
    /// cold-start looks like — live-verified against a real daemon, see the C9
    /// report) must read as SUCCESS, not a timeout-shaped failure. An earlier
    /// version of this function got this wrong.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_is_optimistic_when_the_daemon_stays_silent() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-push-silent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        // Connects (this process stays alive) but never writes a byte — exactly a
        // daemon that accepted the attach (and already wrote the title, per the
        // doc) but whose `claude --resume` cold-start hasn't reached `on_attach` yet.
        fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let started = std::time::Instant::now();
        let ok = tokio::time::timeout(
            Duration::from_secs(10),
            push_remote_title(&test_remote_target("flightdeckd"), "sid-1", "/work/demo", "My Feature"),
        )
        .await
        .expect("push_remote_title must not hang past its own grace window");
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        let _ = fs::remove_dir_all(&dir);

        assert!(ok, "silence within the grace window must read as success, not a timeout failure");
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "must return promptly once the grace window elapses, not hang for the outer test timeout",
        );
    }

    /// Live M1 acceptance check (C9): [`push_remote_title`] against a REAL daemon,
    /// end to end — spawn a throwaway conversation, fully STOP it (so the daemon has
    /// no live actor for it — the "idle rename" case this helper exists for), push a
    /// fresh title, and confirm `flightdeckd status` shows it.
    ///
    /// ALSO documents the KNOWN LIMITATION this helper's doc already calls out: since
    /// the daemon had no running actor, `attach()`'s cold-start path spawns a new
    /// `claude` process as an inherent side effect of merely attaching to set a
    /// title — this test asserts that is EXACTLY what happens (`running` flips to
    /// `true`), as evidence for the C9 report's request for a real title-only verb.
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (flightdeck-server: `m1-daemon/scripts/up.sh`), daemon >= 0.2.0. Run with:
    ///   cargo test -p tosse-code --lib -- --ignored push_remote_title_against_the_m1_daemon --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container, daemon >= 0.2.0)"]
    async fn push_remote_title_against_the_m1_daemon() {
        let identity = std::env::var("TOSSE_M1_KEY").unwrap_or_else(|_| {
            format!("{}/.ssh/flightdeck_m0_ed25519", std::env::var("HOME").unwrap_or_default())
        });
        let remote = RemoteTarget {
            host: "127.0.0.1".into(),
            port: 2224,
            user: "agent".into(),
            identity_file: Some(identity),
            known_hosts_file: Some("/dev/null".into()),
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
        };

        // 1. A throwaway live conversation, to learn a real session_id.
        let mut cfg = SpawnConfig::new("/work/demo");
        cfg.model = Some("claude-haiku-4-5-20251001".into());
        cfg.permission_mode = Some("auto".into());
        cfg.remote = Some(remote.clone());
        let (mut transport, mut rx) = Transport::spawn(cfg).expect("remote spawn should start");
        transport
            .send_user_text("Reply with exactly the two words: hello world. Do not use any tools.")
            .expect("send should queue");
        let mut attach: Option<crate::supervisor::protocol::FdAttachMsg> = None;
        let mut session_id: Option<String> = None;
        tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(msg) = rx.recv().await {
                match &msg {
                    CliMessage::FdAttach(a) => attach = Some(a.clone()),
                    CliMessage::System(crate::supervisor::protocol::SystemMsg::Init(i)) => {
                        session_id = i.session_id.clone();
                    }
                    CliMessage::Result(_) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("the throwaway turn should complete");
        let attach = attach.expect("expected fd_attach");
        let session_id = session_id.expect("expected a session_id from system/init");

        // 2. Fully STOP it (daemon-side too) — no live actor left for it.
        transport.shutdown(true).await;
        // `flightdeckd stop` inside `shutdown` races the daemon actually tearing the
        // claude process down; give it a moment before we check "not running".
        tokio::time::sleep(Duration::from_secs(2)).await;

        let status_line = |out: &str| -> serde_json::Value {
            serde_json::from_str(out.trim()).expect("status should be valid JSON")
        };
        let run_status = || {
            let remote = remote.clone();
            async move {
                let out = tokio::process::Command::new(resolve_ssh_bin())
                    .arg("-T")
                    .arg("-p")
                    .arg(remote.port.to_string())
                    .arg("-o")
                    .arg("BatchMode=yes")
                    .arg("-o")
                    .arg("ConnectTimeout=10")
                    .arg("-o")
                    .arg("StrictHostKeyChecking=accept-new")
                    .arg("-o")
                    .arg("UserKnownHostsFile=/dev/null")
                    .arg("-i")
                    .arg(remote.identity_file.as_deref().unwrap_or_default())
                    .arg("-o")
                    .arg("IdentitiesOnly=yes")
                    .arg(format!("{}@{}", remote.user, remote.host))
                    .arg("exec flightdeckd status")
                    .output()
                    .await
                    .expect("ssh status should run");
                String::from_utf8_lossy(&out.stdout).into_owned()
            }
        };
        let row_for = |status: &serde_json::Value, conv: &str| -> serde_json::Value {
            status["conversations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["conversation"] == conv)
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        };
        let before = status_line(&run_status().await);
        let row_before = row_for(&before, &attach.conversation);
        eprintln!("[live] before push_remote_title: {row_before}");
        assert_eq!(row_before["running"], false, "expected the stopped conversation to be idle");

        // 3. Push a fresh title while idle.
        let title = format!("tosse-c9-idle-push-{}", uuid::Uuid::new_v4());
        let ok = push_remote_title(&remote, &session_id, "/work/demo", &title).await;
        assert!(ok, "push_remote_title should report success against a real daemon");

        let after = status_line(&run_status().await);
        let row_after = row_for(&after, &attach.conversation);
        eprintln!("[live] after push_remote_title: {row_after}");
        assert_eq!(row_after["title"], title, "the daemon should now carry the pushed title");
        // KNOWN LIMITATION (documented on `push_remote_title`): attaching to set the
        // title, on a conversation with no live actor, cold-starts one as a side
        // effect — this is what a real title-only verb would avoid.
        assert_eq!(
            row_after["running"], true,
            "documents the known limitation: an idle push_remote_title cold-starts the claude process",
        );

        // Cleanup: stop the process this test's push incidentally started.
        run_remote_stop(&remote, &attach.conversation).await;
    }

    /// The bug this guards against: a replayable-typed line that fails to parse
    /// must NOT bump `lines_seen`, or the app tells the daemon "I got that" for a
    /// message it actually dropped — never replayed again, permanently lost. Feeds
    /// `reader_loop` directly over a `tokio::io::duplex` pipe (no process spawn
    /// needed): one well-formed replayable line, then one that has a replayable
    /// `"type"` but a body `CliMessage` cannot parse.
    #[tokio::test]
    async fn unparseable_replayable_line_is_not_counted_as_seen() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            Arc::new(Mutex::new(None)),
        ));

        // Well-formed and replayable: a bare `result` message parses with every
        // field defaulted.
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n")
            .await
            .unwrap();
        // Replayable-TYPED ("result") but malformed: missing the required
        // `subtype` field — `is_replayable_line` only probes `"type"`, so this
        // still counts as replayable, but `CliMessage`'s Deserialize rejects it
        // (a bad "type" tag would fall through to `Unknown` instead; this is a
        // parse failure on an otherwise-recognized type).
        writer.write_all(b"{\"type\":\"result\"}\n").await.unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(lines_seen.load(Ordering::Relaxed), 1, "only the parseable line counts");
        assert_eq!(
            unparseable.load(Ordering::Relaxed),
            1,
            "the malformed replayable line is tracked separately, not silently dropped"
        );
        assert_eq!(
            first_unparseable.load(Ordering::Relaxed),
            1,
            "the failure happened right after 1 successful parse"
        );
        // The good message still reached the consumer; the bad one did not (and
        // never will, under this name — see CliMessage's Deserialize impl).
        let msg = rx.recv().await.expect("the well-formed line should be forwarded");
        assert!(matches!(msg, CliMessage::Result(_)));
        assert!(rx.try_recv().is_err(), "the malformed line must not be forwarded");
    }

    /// The blocker this guards against: `lines_seen` is a raw success COUNT, not
    /// the daemon's wire POSITION — so if MORE replayable lines parse fine
    /// AFTER an unparseable one in the same connection, a cursor built from
    /// `lines_seen` alone creeps past the failure and the daemon judges it
    /// "already delivered", never replaying it again (permanently, silently
    /// lost — see `session.rs::run_actor`'s cursor math). Ordering here is
    /// OK, FAIL, OK, OK: `first_unparseable_offset` must freeze at the count
    /// BEFORE the failure (1) and not be dragged forward by the two later
    /// successes, even though `lines_seen` legitimately keeps counting them.
    #[tokio::test]
    async fn first_unparseable_offset_freezes_before_the_first_failure() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            Arc::new(Mutex::new(None)),
        ));

        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK (1)
            .await
            .unwrap();
        writer.write_all(b"{\"type\":\"result\"}\n").await.unwrap(); // FAIL
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK (2)
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK (3)
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(
            lines_seen.load(Ordering::Relaxed),
            3,
            "all 3 well-formed lines parse, including the two after the failure"
        );
        assert_eq!(unparseable.load(Ordering::Relaxed), 1);
        assert_eq!(
            first_unparseable.load(Ordering::Relaxed),
            1,
            "must stay at the count BEFORE the failure (1), not creep forward to 3 \
             just because later lines happened to parse fine"
        );
        assert_ne!(
            first_unparseable.load(Ordering::Relaxed),
            lines_seen.load(Ordering::Relaxed),
            "this is exactly the case where the two diverge — a cursor computed from \
             lines_seen alone would wrongly skip past the still-unrecovered failure"
        );

        for _ in 0..3 {
            rx.recv().await.expect("the 3 well-formed lines should be forwarded");
        }
        assert!(rx.try_recv().is_err(), "the malformed line must not be forwarded");
    }

    // --- D6: fd_skip reattach-replay compaction ---------------------------------

    /// [`apply_fd_skip`] on the happy path with `attach_base == 0` (this
    /// connection's very first attach — no prior backlog, `from`/`to` and
    /// `current`/`new_position` coincide numerically): the range starts exactly
    /// where our position left off, so it is fully absorbed and the position
    /// becomes `to`.
    #[test]
    fn apply_fd_skip_absorbs_a_matching_range() {
        assert_eq!(apply_fd_skip(0, 1, 2, 5), (5, false));
        // The degenerate single-line "range" (from == to) still just works.
        assert_eq!(apply_fd_skip(0, 0, 1, 1), (1, false));
    }

    /// The realistic, common case this whole function exists for (a reattach with
    /// backlog — every previous test in this module used an implicit
    /// `attach_base` of 0, i.e. a first-ever attach, which is the ONE case a skip
    /// essentially never fires in practice): a NONZERO `attach_base`, learned from
    /// this connection's own `fd_attach.replay_from`, composes with the
    /// connection-relative `current`/`new_position` exactly like the daemon's own
    /// `attach.rs` integration test (`flightdeck-server`, seeded from
    /// `replay_from`, not 0). `attach_base + new_position` must equal the
    /// daemon's absolute `to` — the true wire position this connection has
    /// reached — which is what `session.rs::run_actor` composes into the next
    /// reattach cursor.
    #[test]
    fn apply_fd_skip_composes_correctly_with_a_nonzero_attach_base() {
        let attach_base = 100u64;
        let current = 2u64; // 2 replayable lines already parsed on THIS connection
        // Absolute position so far: attach_base + current = 102. The daemon's next
        // skip must therefore start at 103 to be valid.
        let (new_position, violation) = apply_fd_skip(attach_base, current, 103, 110);
        assert!(!violation, "from == attach_base + current + 1 is a valid, matching skip");
        assert_eq!(
            new_position,
            current + (110 - 103 + 1),
            "relative position advances by the skipped range's size, not by the raw absolute `to`"
        );
        assert_eq!(attach_base + new_position, 110, "composed absolute position must equal the daemon's `to`");
    }

    /// Violation: `from` does not follow the recorded position by exactly one —
    /// checked in the SAME (attach_base-composed) space as the match branch, not
    /// against a bare `current`, or every reattach with backlog would misfire (see
    /// the nonzero-attach_base test above). Still resyncs to the daemon's claimed
    /// `to` (converted into this connection's relative space) so the connection
    /// doesn't wedge forever on the same mismatch, and flags it — the caller turns
    /// this into the one-time `protocol_error` notice.
    #[test]
    fn apply_fd_skip_flags_a_mismatched_from_and_resyncs_to_to() {
        let attach_base = 0u64;
        let cursor = 10u64;
        let (new_position, violation) = apply_fd_skip(attach_base, cursor, cursor + 3, cursor + 3 + 20);
        assert!(violation);
        assert_eq!(new_position, cursor + 3 + 20, "cursor must become `to` (attach_base is 0 here)");
    }

    /// Never regress: a violation whose claimed `to` is BEHIND our current position
    /// must not un-count lines we already have — `current.max(to)`.
    #[test]
    fn apply_fd_skip_never_moves_the_position_backwards() {
        let (new_position, violation) = apply_fd_skip(0, 10, 3, 4);
        assert!(violation);
        assert_eq!(new_position, 10, "a stale/behind `to` must not roll the position back");
    }

    /// Major finding: a matching `from` with an INVERTED `to < from` must still be
    /// flagged as a violation, not silently accepted — `from` alone is not enough
    /// to trust the frame. `apply_fd_skip(0, 5, 6, 3)`: `current=5` expects
    /// `from=6` (matches), but `to=3 < from` — this must resync-with-violation,
    /// never regress the position, and never report `violation: false`.
    #[test]
    fn apply_fd_skip_rejects_a_matching_from_with_an_inverted_to() {
        let (new_position, violation) = apply_fd_skip(0, 5, 6, 3);
        assert!(violation, "a matching `from` does not excuse a malformed to < from range");
        assert!(new_position >= 5, "must not regress below the current position");
    }

    /// End-to-end through `reader_loop` (D6 spec example): lines
    /// `[OK, fd_skip{2,5}, OK]` → the skip is folded into `lines_seen` (1 → 5),
    /// the trailing OK bumps it to 6, and the UI (the `tx`/`rx` channel) receives
    /// ONLY the two OK messages — the `fd_skip` frame itself is never forwarded.
    #[tokio::test]
    async fn reader_loop_folds_fd_skip_into_lines_seen_without_forwarding_it() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            skip_violation.clone(),
        ));

        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 0 -> 1
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"fd_skip\",\"from\":2,\"to\":5}\n") // absorbed: lines_seen -> 5
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 5 -> 6
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(lines_seen.load(Ordering::Relaxed), 6, "wire position after the skip + trailing OK");
        assert!(skip_violation.lock().unwrap().is_none(), "the range matched — no violation");

        let mut received = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            received.push(msg);
        }
        assert_eq!(received.len(), 2, "the UI must receive exactly the 2 OK messages, never the skip");
        assert!(received.iter().all(|m| matches!(m, CliMessage::Result(_))));
    }

    /// Blocker regression test: the realistic reattach case — a NONZERO
    /// `attach_base`, learned from a real `fd_attach` line at the top of the
    /// stream (mirroring flightdeckd's own `attach.rs` integration test, which
    /// seeds its cursor from `replay_from`, never 0). Before the fix, `reader_loop`
    /// checked a well-formed skip against the bare connection-relative `current`
    /// instead of `attach_base + current`, so this exact well-formed frame would
    /// have misfired as a "violation" and corrupted `lines_seen` into an
    /// already-absolute number — silently doubling `attach_base` on the NEXT
    /// reattach (see `session.rs::run_actor`'s `cursor = attach_base +
    /// reattach_cursor_delta(transport.lines_seen(), …)`). This is the case every
    /// OTHER `fd_skip` test in this module skips, by construction (none of them
    /// send an `fd_attach` first, so they all run with an implicit `attach_base`
    /// of 0 — the one case a skip essentially never fires in practice).
    #[tokio::test]
    async fn reader_loop_composes_fd_skip_with_a_nonzero_attach_base_from_fd_attach() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            skip_violation.clone(),
        ));

        // Always line 1 of a real remote attach stream: this connection resumes at
        // absolute position 100 (a reattach with backlog, NOT a first-ever attach).
        writer
            .write_all(
                b"{\"type\":\"fd_attach\",\"conversation\":\"c1\",\"epoch\":\"e1\",\"replay_from\":100}\n",
            )
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 0 -> 1 (absolute 101)
            .await
            .unwrap();
        // Valid, well-formed skip in the DAEMON's absolute space: after the OK above,
        // current == 1, so the next expected seq is attach_base(100) + current(1) + 1
        // == 102 — exactly this frame's `from`.
        writer
            .write_all(b"{\"type\":\"fd_skip\",\"from\":102,\"to\":105}\n") // absorbed: lines_seen -> 5
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 5 -> 6 (absolute 106)
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert!(
            skip_violation.lock().unwrap().is_none(),
            "a well-formed skip composed against the nonzero attach_base must not violate"
        );
        let relative = lines_seen.load(Ordering::Relaxed);
        assert_eq!(relative, 6, "connection-relative position: 1 (pre-skip) + 4 (skip) + 1 (post-skip)");
        let attach_base = 100u64;
        assert_eq!(
            attach_base + relative,
            106,
            "composed absolute position (what session.rs::run_actor adds attach_base to) must be exact"
        );

        let mut received = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            received.push(msg);
        }
        // fd_attach itself is never replayable and never forwarded past reader_loop
        // as anything OTHER than a normal CliMessage — it IS forwarded (session.rs
        // needs it to sync its own attach_base/busy/pending state), just not counted.
        assert_eq!(received.len(), 3, "fd_attach + the 2 OK messages; the fd_skip itself is never forwarded");
        assert!(matches!(received[0], CliMessage::FdAttach(_)));
        assert!(matches!(received[1], CliMessage::Result(_)));
        assert!(matches!(received[2], CliMessage::Result(_)));
    }

    /// Cursor composition: an `fd_skip` followed by a LATER unparseable line must
    /// still roll the reattach cursor back to the right offset — `lines_seen` has
    /// already absorbed the skip by the time the failure is recorded, so
    /// `first_unparseable_offset` freezes at the POST-skip count, not some stale
    /// pre-skip value.
    #[tokio::test]
    async fn fd_skip_then_a_later_unparseable_line_rolls_back_past_the_skip() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            skip_violation.clone(),
        ));

        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 0 -> 1
            .await
            .unwrap();
        writer
            .write_all(b"{\"type\":\"fd_skip\",\"from\":2,\"to\":9}\n") // absorbed: lines_seen -> 9
            .await
            .unwrap();
        writer.write_all(b"{\"type\":\"result\"}\n").await.unwrap(); // FAIL right after the skip
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — lines_seen: 9 -> 10
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(lines_seen.load(Ordering::Relaxed), 10);
        assert_eq!(
            first_unparseable.load(Ordering::Relaxed),
            9,
            "must freeze at the POST-skip count (9), the true position right before the failure"
        );

        let mut received = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            received.push(msg);
        }
        assert_eq!(received.len(), 2, "the 2 OK messages, never the skip or the malformed line");
    }

    /// A violated `fd_skip{from}` (not `current + 1`) resyncs the position AND
    /// records exactly one violation note — a SECOND violation in the same
    /// connection must not overwrite the first (the "once" in "one-time notice").
    #[tokio::test]
    async fn reader_loop_flags_a_skip_violation_once_and_resyncs() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, _rx) = mpsc::unbounded_channel::<CliMessage>();
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err,
            lines_seen.clone(),
            unparseable.clone(),
            first_unparseable.clone(),
            skip_violation.clone(),
        ));

        // Wildly out-of-range `from` (should be 1): current is 0, so the only
        // non-violating `from` would be 1.
        writer
            .write_all(b"{\"type\":\"fd_skip\",\"from\":9,\"to\":20}\n")
            .await
            .unwrap();
        // A second violation must not clobber the first note.
        writer
            .write_all(b"{\"type\":\"fd_skip\",\"from\":50,\"to\":60}\n")
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(lines_seen.load(Ordering::Relaxed), 60, "resynced to the second frame's `to`");
        let note = skip_violation.lock().unwrap().clone();
        assert!(
            note.as_deref().unwrap_or_default().contains("from:9"),
            "must record the FIRST violation's detail, not the second: {note:?}"
        );
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
            addresses: vec!["127.0.0.1".into()],
            machine_id: None,
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
            supports_skip: false,
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
