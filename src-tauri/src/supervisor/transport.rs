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
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};

use super::protocol::CliMessage;

/// How many trailing stderr lines from the `claude` process to keep buffered, so an
/// abnormal exit can surface the tail (auth failure, panic, MCP error) in the UI
/// without streaming every line into the conversation.
const STDERR_TAIL_MAX: usize = 80;

/// Longest single stdout line the reader accepts: 64 MiB. Without a bound, a stdout
/// that never sends a newline grows the read buffer until the app runs out of memory —
/// and on a remote session that stdout is a server's attach stream, not our own child.
/// Generous on purpose: stream-json lines legitimately reach several MB (base64 image
/// blocks, large tool results), and a single turn is already capped well below this by
/// the Messages API's request-size limit. It also equals flightdeckd's whole replay
/// ring (`RING_BYTES_MAX`): a longer line is evicted from the ring the moment it lands,
/// so the daemon could never replay it either.
pub(crate) const MAX_STDOUT_LINE_BYTES: usize = 64 * 1024 * 1024;
/// stderr lines only feed the bounded display tail, so they are cut far shorter (the
/// tail of an over-long line is dropped, its head kept).
const MAX_STDERR_LINE_BYTES: usize = 64 * 1024;
/// How much of an oversized stdout line is kept to classify it (its top-level `type`,
/// which `claude` and flightdeckd always write first) for the replay cursor.
const OVERSIZED_PREFIX_BYTES: usize = 4096;
/// Bytes of parsed-but-not-yet-consumed inbound messages one transport may queue
/// (charged by what a line costs once parsed — see [`inbound_charge`]). Once spent, the
/// reader waits for the session actor to catch up, which backpressures the pipe instead
/// of growing memory without bound. Two maximal lines, so a maximal line can always be
/// queued behind another.
const INBOUND_BUDGET_BYTES: usize = 2 * MAX_STDOUT_LINE_BYTES;
/// Minimum charge per queued message, so a flood of tiny lines is bounded too (the
/// parsed form of a small line costs more than its text).
const INBOUND_MIN_CHARGE_BYTES: usize = 1024;
/// What one JSON value (or object key) of a line costs once parsed, as an upper estimate:
/// a `serde_json::Value` is 80 bytes with `preserve_order` (its object is an `IndexMap`),
/// a key adds its `String` and its map entry. A line of tiny values (`[0,0,0,…]`) is
/// therefore some 40× its text once parsed — budgeted by its text, a queue "full" at
/// 128 MiB held gigabytes.
const PARSED_BYTES_PER_VALUE: usize = 96;
/// Most JSON values one stdout line may hold; a denser line is dropped unparsed, like an
/// over-long one. Parsing builds serde's own buffered copy of the line before the
/// `Value`s (`CliMessage` is an internally tagged enum), so the PEAK of parsing a dense
/// line is larger still than what it leaves queued — the cap bounds both, at a few dozen
/// MiB. Two maximal lines still fit [`INBOUND_BUDGET_BYTES`]. Far beyond any line
/// `claude` writes: its large payloads (tool results, file contents, images) are strings,
/// one value each.
pub(crate) const MAX_LINE_VALUES: usize = 512 * 1024;

/// Shared, bounded ring of the process's most recent stderr lines.
type StderrTail = Arc<Mutex<VecDeque<String>>>;
/// Shared slot for a pump task's terminal error (reader IO / writer IO), so the
/// session actor can explain WHY the process went away instead of treating every
/// disappearance as a clean exit.
type ErrSlot = Arc<Mutex<Option<String>>>;

/// One message on its way from the stdout reader to the session actor, holding the
/// share of [`INBOUND_BUDGET_BYTES`] it was charged until the actor takes it.
type Inbound = (CliMessage, OwnedSemaphorePermit);

/// Receiving half of a transport's inbound queue (see [`Transport::spawn`]).
///
/// The queue is bounded in BYTES ([`INBOUND_BUDGET_BYTES`]), not in messages: the
/// reader waits for budget before queueing, and a message returns its budget the
/// moment [`Self::recv`] hands it over. No deadlock is possible with the session
/// actor (`session.rs::run_actor`), the only production consumer: while a transport
/// is live the actor's loop awaits nothing but this queue and its command channel —
/// every handler is synchronous (a bridged MCP call runs on its own task) — so it
/// always comes back to `recv` and frees budget. During teardown it keeps draining
/// (see the end of `run_actor`), so the reader never wedges the child's exit either.
pub struct InboundReceiver {
    rx: mpsc::UnboundedReceiver<Inbound>,
    budget: Arc<Semaphore>,
}

impl InboundReceiver {
    /// The next inbound message, or `None` once the reader has ended and every queued
    /// message was taken. Cancel-safe (usable as a `tokio::select!` branch), like the
    /// `mpsc` receive it wraps.
    pub async fn recv(&mut self) -> Option<CliMessage> {
        self.rx.recv().await.map(|(msg, _budget)| msg)
    }

    /// Non-blocking [`Self::recv`].
    #[cfg(test)]
    pub fn try_recv(&mut self) -> Result<CliMessage, mpsc::error::TryRecvError> {
        self.rx.try_recv().map(|(msg, _budget)| msg)
    }
}

impl Drop for InboundReceiver {
    /// The consumer is gone: fail a reader that is waiting for budget, so it ends
    /// exactly like a reader whose send hits a dropped receiver.
    fn drop(&mut self) {
        self.budget.close();
    }
}

/// Sending half of the inbound queue, owned by [`reader_loop`].
struct InboundSender {
    tx: mpsc::UnboundedSender<Inbound>,
    budget: Arc<Semaphore>,
    /// The whole budget: no single message may be charged more, or it would wait forever.
    max_charge: usize,
}

impl InboundSender {
    /// Queue `msg`, charged `weight` bytes (what its line costs — see [`inbound_charge`]),
    /// after waiting for that much budget. `Err` means the consumer is gone.
    async fn send(&self, msg: CliMessage, weight: usize) -> Result<(), ()> {
        let charge = weight.clamp(INBOUND_MIN_CHARGE_BYTES.min(self.max_charge), self.max_charge);
        let charge = u32::try_from(charge).unwrap_or(u32::MAX);
        let permit = self.budget.clone().acquire_many_owned(charge).await.map_err(|_| ())?;
        self.tx.send((msg, permit)).map_err(|_| ())
    }
}

/// A fresh inbound queue holding at most `budget_bytes` of queued messages.
fn inbound_channel(budget_bytes: usize) -> (InboundSender, InboundReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let budget = Arc::new(Semaphore::new(budget_bytes));
    (
        InboundSender { tx, budget: budget.clone(), max_charge: budget_bytes },
        InboundReceiver { rx, budget },
    )
}

/// Oversized stdout lines the reader dropped and the session actor has not reported
/// yet, plus a wake-up so the report does not wait for the next message (a dropped
/// line may be the last thing a turn sends).
#[derive(Default)]
struct OversizedLines {
    count: AtomicU64,
    largest_bytes: AtomicU64,
    /// Of `count`, the lines dropped for holding too many values ([`MAX_LINE_VALUES`]).
    too_dense: AtomicU64,
    wake: Notify,
}

/// What the reader dropped since the last [`Transport::take_oversized_lines`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OversizedReport {
    /// How many lines were dropped.
    pub count: u64,
    /// The size of the largest one, in bytes.
    pub largest_bytes: u64,
    /// How many of them were dropped for holding too many JSON values rather than for
    /// their length (see [`MAX_LINE_VALUES`]) — a line well under the size limit.
    pub too_dense: u64,
}

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
    /// lets the CLI use its own default. NOTE: callers pass it through
    /// `control::permission_mode_for_spawn`, which keeps `bypassPermissions` only when
    /// [`Self::allow_bypass_permissions`] is set — the CLI itself would RUN a spawn-flag
    /// bypass without the unlock (verified 2.1.293).
    pub permission_mode: Option<String>,
    /// Pass `--allow-dangerously-skip-permissions`, which UNLOCKS `bypassPermissions`
    /// as a selectable mode without turning it on. Verified against the CLI's own help
    /// (2.1.220): "Enable bypassing all permission checks *as an option, without it
    /// being enabled by default*". Without it (and without a spawn in bypass) the CLI
    /// REFUSES a runtime `set_permission_mode` to bypass — "…was not launched with
    /// --dangerously-skip-permissions" (2.1.293; see `control::is_bypass_unlock_refusal`).
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
    /// How long a REMOTE connection attempt may stay up without the daemon's `fd_attach`
    /// before the session actor gives up on it and retries (see `session.rs::run_actor`):
    /// ssh's own timeouts bound the TCP connect and its keepalives prove the link alive, not
    /// that the daemon answered — a login shell stuck before `exec flightdeckd`, a wedged
    /// daemon or a silent server held the conversation "Reconnecting…" for good.
    /// [`ATTACH_DEADLINE`] in production; shortened by tests.
    pub attach_deadline: Duration,
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
    /// What an EARLIER actor of this same daemon conversation, in this app run, already
    /// showed the front (see [`PriorView`]) — `None` for the first actor since launch, and
    /// on every reattach of an actor after its first `fd_attach` (its own epoch and cursor
    /// then say it all).
    pub prior: Option<PriorView>,
    /// Join a RUNNING `claude` only, never start one (`attach --existing-only`, cap
    /// `existing-only` of the RUNNING daemon — the caller read it from that daemon's own
    /// `fd_status`): the remote resume pass decides to attach on a status snapshot, and the
    /// process may have ended (stopped from the phone, removed) by the time its history read
    /// is done. With none running, the daemon answers `fd_detach{not_running}` and starts,
    /// un-archives and records nothing. Only until this actor's first `fd_attach`: a reconnect
    /// after it presents its epoch, and the daemon's own reattach rules apply (see
    /// `session.rs::run_actor`). Default `false`: an attach that may cold-start.
    pub existing_only: bool,
}

/// What an earlier actor of a daemon conversation left of its view when it ended, kept for
/// the next one in this app run (`session.rs` keeps the registry). A new actor asks the
/// daemon for its WHOLE history (its own state starts empty) — so, without this, nothing in
/// that replay could be told apart from what the front already knew, and nothing could tell
/// it that the server-side process it left running was gone.
#[derive(Debug, Clone, Default)]
pub struct PriorView {
    /// The epoch of the process that actor was attached to.
    pub epoch: String,
    /// How many replayable lines of that epoch it had received (its reattach cursor): lines
    /// past it, in a replay of the same epoch, happened after the front's view — news.
    pub cursor: u64,
    /// Its session ended with that process presumed alive (another client took over, this
    /// Mac let go, the link failed for good) — the front then kept its background tasks
    /// running and its Remote Control bridge up.
    pub outlived: bool,
    /// The background tasks it left running, as last shown (when `outlived`).
    pub running: Vec<super::model::BackgroundTask>,
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

/// The default [`SpawnConfig::attach_deadline`]: past ssh's 10 s connect timeout, a remote
/// login and the daemon's cold start of the conversation's `claude` (a process spawn — its
/// `fd_attach` does not wait for the CLI to be ready), with ample margin.
pub const ATTACH_DEADLINE: Duration = Duration::from_secs(60);

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
            attach_deadline: ATTACH_DEADLINE,
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
    // Delegates to the crate's ONE shared resolver (`ipc::commands::
    // resolve_daemon_bin_expr`, B11's unification of what used to be four
    // independent copies of this same search) — kept as a thin, locally-named
    // wrapper so every existing call site / test in this module stays unchanged.
    crate::ipc::commands::resolve_daemon_bin_expr(daemon_bin)
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
    // Join a running `claude` only (the resume pass): set ONLY when the RUNNING daemon
    // advertised `existing-only` in its own `fd_status` — see `AttachPoint::existing_only`.
    if attach.existing_only {
        s.push_str(" --existing-only");
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

/// How long [`run_remote_stop`] waits for its ssh round trip (connect included) before it
/// gives up on it. Shared with the session actor, whose Stop acknowledgement must outlast it
/// (see `session.rs::STOP_ACK_TIMEOUT`).
pub const REMOTE_STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// How much of a failed remote stop's stderr is read back, for the notice saying it failed.
const REMOTE_STOP_STDERR_MAX_BYTES: u64 = 16 * 1024;

/// Remote stop over a fresh ssh: `ssh <dest> 'exec flightdeckd stop --conversation X'`.
/// The deterministic tail of the user's explicit Stop for a remote session —
/// the in-band `fd_stop` only reaches the daemon while the attach link is
/// alive, and an explicit Stop must work precisely when it is not. Idempotent
/// server-side (stopping a stopped session is a no-op). `Ok` once the command ran
/// and exited 0; otherwise `Err` with why (no answer within [`REMOTE_STOP_TIMEOUT`],
/// the exit code and what it wrote to stderr — server-written text, sanitized), for the
/// caller to tell the user their Stop may not have reached the server.
pub async fn run_remote_stop(remote: &RemoteTarget, conversation: &str) -> Result<(), String> {
    let mut cmd = Command::new(resolve_ssh_bin());
    // The crate's ONE keyed option list (`ipc::commands::keyed_ssh_args`).
    let options = crate::ipc::commands::keyed_ssh_args(
        remote.port,
        remote.identity_file.as_deref(),
        remote.known_hosts_file.as_deref(),
    );
    match options {
        Ok(options) => cmd.arg("-T").args(options),
        Err(e) => {
            eprintln!("[transport] remote stop not attempted: {e}");
            return false;
        }
    };
    // A saved `MachineRecord` that predates `validate_ssh_user` (older app version,
    // manual DB edit) must not reach a real ssh spawn here — degrade to the SAME
    // "failed" outcome an unreachable host already reports, never a crash or a spawn
    // built from it (CRM holistic-review blocker #3, chantier A `bd7ca709`). The `Err`
    // is deliberately discarded (never interpolated into the log line): it is
    // `validate_ssh_user`/`validate_address_value`'s own message, which embeds the raw
    // offending value verbatim — printing it into this process's stderr would reopen a
    // terminal-escape-injection surface on the very value this validator exists to
    // neutralize (a hostile pairing ticket can carry ANSI/OSC bytes in `user`/`host`).
    // Same discipline as `TransportError::InvalidRemoteTarget`'s own `Display` impl.
    if crate::ipc::commands::push_ssh_destination(&mut cmd, &remote.user, &remote.host).is_err() {
        eprintln!(
            "[transport] remote stop refused an invalid user/host — this server's saved \
             connection details failed validation; remove and re-add it."
        );
        return Err("This server's saved connection details are not valid — remove and re-add it.".to_string());
    }
    cmd.arg(format!(
        "exec {} stop --conversation {}",
        resolve_remote_daemon_bin(&remote.daemon_bin),
        shell_quote(conversation),
    ));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("[transport] remote stop failed to launch ssh: {e}");
            return Err(format!("ssh could not be started: {e}"));
        }
    };
    let stderr = child.stderr.take();
    let outcome = tokio::time::timeout(REMOTE_STOP_TIMEOUT, async {
        // Bounded: a server can write any amount there. What is past the cap is never read —
        // the pipe closes with the handle, and the wait below still ends.
        let mut text = Vec::new();
        if let Some(stderr) = stderr {
            use tokio::io::AsyncReadExt;
            let _ = stderr.take(REMOTE_STOP_STDERR_MAX_BYTES).read_to_end(&mut text).await;
        }
        (child.wait().await, text)
    })
    .await;
    let failure = match outcome {
        Ok((Ok(status), _)) if status.success() => return Ok(()),
        Ok((Ok(status), stderr)) => {
            let lines: Vec<String> = String::from_utf8_lossy(&stderr).lines().map(str::to_string).collect();
            let code = status.code().map_or_else(|| "a signal".to_string(), |c| format!("code {c}"));
            match crate::ssh_link::sanitize_stderr_detail(&lines) {
                Some(said) => format!("ssh exited with {code}:\n{said}"),
                None => format!("ssh exited with {code}."),
            }
        }
        Ok((Err(e), _)) => format!("ssh could not be waited on: {e}"),
        Err(_) => format!("No answer within {} s.", REMOTE_STOP_TIMEOUT.as_secs()),
    };
    eprintln!("[transport] remote stop of conversation {conversation} failed: {failure}");
    Err(failure)
}

/// The remote command of [`push_remote_title`]. Pure.
///
/// It names the flightdeckd conversation this one ran under when one was recorded — never
/// together with the Claude session: a phone `/clear` moves that conversation to another
/// session while this Mac is away, and the daemon takes a session it is given over the
/// conversation's own (it would resume the stale one there). Pushed by that stale session
/// instead, the daemon found no conversation holding it and created a second one, with an
/// idle `claude` on the old transcript, which a later spawn could even re-home this
/// conversation onto. A conversation that never recorded its daemon id is still pushed by
/// session, as before.
fn remote_title_command(
    daemon_bin: &str,
    daemon_conversation: Option<&str>,
    session_id: &str,
    cwd: &str,
    title: &str,
) -> String {
    let target = match daemon_conversation {
        Some(conversation) => format!("--conversation {}", shell_quote(conversation)),
        None => format!("--resume-session {}", shell_quote(session_id)),
    };
    format!(
        "exec {} attach {target} --cwd {} --title={} --cursor {}",
        daemon_bin,
        shell_quote(cwd),
        shell_quote(title.trim()),
        u64::MAX,
    )
}

/// Best-effort push of a conversation's CURRENT title to the daemon's authoritative
/// record (C9), for a rename that happens while this Mac is NOT the one driving the
/// conversation. One bounded ssh round trip of `flightdeckd set-title` (cap `set-title`,
/// flightdeckd >= 0.6.0): it renames and does NOTHING else — no `claude` cold-started for
/// an idle conversation, no other client (another Mac, the dev build) replaced on a live
/// one. `daemon_conversation` is the daemon's id for it when this Mac knows it (persisted
/// at its attach); the daemon falls back to the conversation running `session_id`.
///
/// `set_title_available`: the server's `flightdeckd` binary is new enough to HAVE the verb
/// (its probed version). Whether the RUNNING daemon understands it is that daemon's own
/// answer — an older one replies `fd_detach` to an unknown verb, which the binary reports
/// (see [`set_title_outcome`]). Only then, or for an older binary, is the conversation
/// renamed the old way, [`push_title_by_attach`], with its side effects. A refusal (no such
/// conversation there, a blank title) or a failed round trip is `false`, its reason logged
/// — never retried as an attach, which would start a conversation under that session.
pub async fn push_remote_title(
    remote: &RemoteTarget,
    daemon_conversation: Option<&str>,
    session_id: &str,
    cwd: &str,
    title: &str,
    set_title_available: bool,
) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    if set_title_available {
        match run_set_title(remote, daemon_conversation, session_id, title.trim()).await {
            SetTitleOutcome::Set => return true,
            SetTitleOutcome::Unsupported => eprintln!(
                "[transport] remote title push: the server's running flightdeckd has no set-title verb \
                 (restart it on its updated binary) — renaming through an attach instead"
            ),
            SetTitleOutcome::Failed(why) => {
                eprintln!("[transport] remote title push failed: {why}");
                return false;
            }
        }
    }
    push_title_by_attach(remote, daemon_conversation, session_id, cwd, title).await
}

/// How long a `flightdeckd set-title` round trip may take, connection included.
const SET_TITLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Run `flightdeckd set-title` on `remote` (one bounded ssh round trip) and read its answer.
async fn run_set_title(
    remote: &RemoteTarget,
    daemon_conversation: Option<&str>,
    session_id: &str,
    title: &str,
) -> SetTitleOutcome {
    let Some(mut cmd) = one_shot_ssh(remote, "remote title push") else {
        return SetTitleOutcome::Failed("this server's saved connection details failed validation".into());
    };
    let conversation = daemon_conversation
        .map(|c| format!(" --conversation {}", shell_quote(c)))
        .unwrap_or_default();
    cmd.arg(format!(
        "exec {} set-title{conversation} --resume-session {} --title={}",
        resolve_remote_daemon_bin(&remote.daemon_bin),
        shell_quote(session_id),
        shell_quote(title),
    ));
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return SetTitleOutcome::Failed(format!("couldn't launch ssh: {e}")),
    };
    match tokio::time::timeout(SET_TITLE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => set_title_outcome(
            &String::from_utf8_lossy(&out.stdout),
            out.status.code(),
            &String::from_utf8_lossy(&out.stderr),
        ),
        Ok(Err(e)) => SetTitleOutcome::Failed(format!("ssh failed: {e}")),
        Err(_) => SetTitleOutcome::Failed(format!("no answer from the server within {SET_TITLE_TIMEOUT:?}")),
    }
}

/// The `ssh` command of a one-shot remote call (its remote command is the caller's to add),
/// or `None` — logged — for a target whose user/host fail validation.
fn one_shot_ssh(remote: &RemoteTarget, what: &str) -> Option<Command> {
    let mut cmd = Command::new(resolve_ssh_bin());
    let options = crate::ipc::commands::keyed_ssh_args(
        remote.port,
        remote.identity_file.as_deref(),
        remote.known_hosts_file.as_deref(),
    );
    match options {
        Ok(options) => cmd.arg("-T").args(options),
        Err(e) => {
            eprintln!("[transport] {what} not attempted: {e}");
            return None;
        }
    };
    // See `run_remote_stop`'s own doc for why this can't be skipped even though every
    // caller SHOULD already have a validated `remote.user`/`.host` — and for why the
    // `Err` is discarded rather than logged (it embeds the raw offending value).
    if crate::ipc::commands::push_ssh_destination(&mut cmd, &remote.user, &remote.host).is_err() {
        eprintln!(
            "[transport] {what} refused an invalid user/host — this server's saved connection \
             details failed validation; remove and re-add it."
        );
        return None;
    }
    Some(cmd)
}

/// How a `flightdeckd set-title` round trip ended (see [`set_title_outcome`]).
#[derive(Debug, Clone, PartialEq, Eq)]
enum SetTitleOutcome {
    /// `fd_title_set{ok:true}`: renamed, nothing else touched.
    Set,
    /// The server cannot rename this way: its binary has no `set-title` subcommand, or the
    /// RUNNING daemon predates the verb (the binary on disk was updated, the daemon not yet
    /// restarted). The rename falls back to the `attach --title` push.
    Unsupported,
    /// Refused by the daemon, or the round trip failed: why.
    Failed(String),
}

/// Classify a `flightdeckd set-title` run over ssh from its stdout, exit code and stderr
/// (`None` exit: killed). Renamed only on the daemon's own `fd_title_set{ok:true}` — its last
/// line that parses as one, past anything a login script printed. "Unsupported" on clap's
/// rejection of the subcommand (a binary older than 0.6.0) and on the binary's report that the
/// RUNNING daemon answered the verb with `fd_detach` (`attach::set_title_client`): both are
/// the running daemon not knowing the verb, never a refusal of THIS rename. Anything else is a
/// failure, worded from the server's stderr (terminal escapes stripped) when it said why.
fn set_title_outcome(stdout: &str, exit: Option<i32>, stderr: &str) -> SetTitleOutcome {
    let reply = stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|v| v.get("type").and_then(serde_json::Value::as_str) == Some("fd_title_set"));
    if exit == Some(0) {
        return match reply {
            Some(v) if v.get("ok") == Some(&serde_json::Value::Bool(true)) => SetTitleOutcome::Set,
            Some(v) => SetTitleOutcome::Failed(format!(
                "the server refused the rename: {}",
                v.get("error").and_then(serde_json::Value::as_str).unwrap_or("no reason given")
            )),
            None => SetTitleOutcome::Failed("the server's flightdeckd gave no answer to set-title".into()),
        };
    }
    if stderr.contains("unrecognized subcommand") || stderr.contains("predates `set-title`") {
        return SetTitleOutcome::Unsupported;
    }
    let said = crate::bootstrap::server_setup::strip_ansi(stderr);
    let said = said.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or_default().to_string();
    SetTitleOutcome::Failed(match (said.is_empty(), exit) {
        (false, _) => said,
        (true, Some(code)) => format!("set-title exited with code {code}"),
        (true, None) => "set-title was killed".to_string(),
    })
}

/// The pre-0.6.0 way of pushing a title ([`push_remote_title`] falls back to it for a
/// server whose running daemon has no `set-title` verb): there `flightdeckd` only knows
/// `--title` as an `attach` flag, so this borrows `attach` itself for a bounded, ONE-SHOT
/// ssh round trip mirroring [`run_remote_stop`]'s shape (spawn, wait bounded, report
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
/// (`conv.handle` in `conversationsStore.ts`) and cannot be re-derived here. The same
/// eviction hits ANOTHER client attached to it (another Mac, the dev build) — which the
/// `set-title` verb avoids.
///
/// It reaches the conversation by `daemon_conversation` — the flightdeckd conversation it
/// last ran under, when one was recorded — else by `session_id` (see
/// [`remote_title_command`] for why never both). A push by a session no conversation holds
/// any more is refused by the daemon (it used to start a second one).
///
/// ⚠️ KNOWN LIMITATION (older daemons only): a conversation the daemon has no RUNNING
/// actor for right now still triggers the daemon's normal cold-start (resuming the session
/// the conversation holds) as a side effect of merely attaching — a resumed but
/// message-less `claude` process left running server-side. The `set-title` verb
/// (flightdeckd >= 0.6.0) is the fix.
async fn push_title_by_attach(
    remote: &RemoteTarget,
    daemon_conversation: Option<&str>,
    session_id: &str,
    cwd: &str,
    title: &str,
) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    let Some(mut cmd) = one_shot_ssh(remote, "remote title push") else {
        return false;
    };
    cmd.arg(remote_title_command(
        &resolve_remote_daemon_bin(&remote.daemon_bin),
        daemon_conversation,
        session_id,
        cwd,
        title,
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
    //    SUCCESS, not failure, PROVIDED the child hasn't already exited non-zero
    //    — see the load-bearing note below AND the `Ok(0)` arm's own comment
    //    (a same-instant ssh connection failure closes its stdout pipe at
    //    essentially the same instant it exits non-zero, so a bare EOF cannot
    //    be trusted on its own without checking the child's exit status first);
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
    // How long to wait, right after observing a clean EOF, for the child's exit
    // status to become available before falling back to the optimistic "still
    // alive" reading. This is NOT a general grace window (see `ACK_GRACE` above)
    // — it exists purely to disambiguate a same-instant EOF from a same-instant
    // process exit; see the `Ok(0)` arm below.
    const EOF_REAP_GRACE: Duration = Duration::from_millis(200);
    let ok = tokio::select! {
        res = reader.read_line(&mut first_line) => match res {
            Ok(0) => {
                // A clean EOF with zero bytes does NOT by itself mean success: a
                // real connection failure (bad host/port/key, daemon down) makes
                // ssh exit non-zero writing nothing to stdout (stderr is
                // `Stdio::null()`), and closing a process's stdout pipe happens
                // essentially AT process exit — so this branch and the sibling
                // `child.wait()` branch below can become ready at the same
                // instant, and `tokio::select!` would otherwise pick one at
                // random (verified: ~50% false-positive "success" on a child
                // that exits 1 with no output). Disambiguate by checking whether
                // the child has ALREADY exited: if it has, its exit status is
                // authoritative (mirrors the `child.wait()` branch's verdict,
                // just reached from the other future); only when the child is
                // still alive — the genuine "daemon accepted the attach, wrote
                // the title, but `claude --resume` hasn't replied yet" case this
                // redesign targets — does EOF read as the documented optimistic
                // success.
                match tokio::time::timeout(EOF_REAP_GRACE, child.wait()).await {
                    Ok(status) => matches!(status, Ok(s) if s.success()),
                    Err(_) => true,
                }
            }
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

/// How many JSON values (object keys included) parsing `line` builds, near enough: one per
/// `{` `[` `,` `:` outside strings, plus the first. A single pass over the bytes, with no
/// allocation — cheap next to the parse it prices (see [`PARSED_BYTES_PER_VALUE`]).
fn json_values(line: &[u8]) -> usize {
    let mut values = 1;
    let mut in_string = false;
    let mut escaped = false;
    for &b in line {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else {
            match b {
                b'"' => in_string = true,
                b'{' | b'[' | b',' | b':' => values += 1,
                _ => {}
            }
        }
    }
    values
}

/// What a parsed line of `len` bytes holding `values` JSON values is charged against the
/// inbound budget: its text, or its parsed form when that is larger (see
/// [`PARSED_BYTES_PER_VALUE`]).
fn inbound_charge(len: usize, values: usize) -> usize {
    len.max(values.saturating_mul(PARSED_BYTES_PER_VALUE))
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
        Ok(Probe { kind: Some(k) }) => is_replayable_type(&k),
        _ => false,
    }
}

/// The `type` half of [`is_replayable_line`]'s contract, shared with the oversized-line
/// path (which only has the line's head to go on — see [`type_from_prefix`]).
fn is_replayable_type(kind: &str) -> bool {
    !matches!(
        kind,
        "control_response" | "control_request" | "control_cancel_request" | "keep_alive"
    ) && !kind.starts_with("fd_")
}

/// The top-level `"type"` string of a JSON object whose text may be TRUNCATED — the
/// head of a line too long to parse whole. Walks the object's entries with the real
/// JSON tokenizer (so keys inside nested values or strings never match) and stops at
/// `type`; `None` if the head ends before it, or it is not a string. `claude` and
/// flightdeckd write `type` first, so a few KiB of head always suffice in practice.
fn type_from_prefix(prefix: &[u8]) -> Option<String> {
    use serde::de::{Deserializer as _, IgnoredAny, MapAccess, Visitor};

    struct FindType<'a>(&'a mut Option<String>);
    impl<'de> Visitor<'de> for FindType<'_> {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            while let Some(key) = map.next_key::<String>()? {
                if key == "type" {
                    *self.0 = map.next_value::<Option<String>>()?;
                    return Ok(());
                }
                map.next_value::<IgnoredAny>()?;
            }
            Ok(())
        }
    }

    let mut found = None;
    // The parse as a whole fails on the truncated tail by design; only what the
    // visitor captured before that point matters.
    let _ = serde_json::Deserializer::from_slice(prefix).deserialize_map(FindType(&mut found));
    found
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
    /// A remote (SSH) spawn's [`RemoteTarget::user`]/`.host` failed
    /// [`crate::store::validate_ssh_user`]/[`crate::store::validate_address_value`] —
    /// a `MachineRecord` on disk that predates that validator (an older app version,
    /// or a manual DB edit), surfaced here so it never silently vanishes or crashes:
    /// the machine stays listed, and any attempt to connect gets this clear, typed,
    /// actionable error instead (CRM holistic-review blocker #3, chantier A
    /// `bd7ca709`).
    InvalidRemoteTarget(String),
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
            TransportError::InvalidRemoteTarget(_) => write!(
                f,
                "This server's saved user name is not valid — remove and re-add it.",
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
    /// Oversized stdout lines dropped by `reader_loop` and not yet reported — see
    /// [`Self::take_oversized_lines`].
    oversized: Arc<OversizedLines>,
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
    ) -> Result<(Transport, InboundReceiver), TransportError> {
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
            // A REAL network cut (wifi off, cable pulled) sends no FIN: the shared
            // option list's keepalives (`ServerAliveInterval=10` × 3, see
            // `ipc::commands::common_ssh_args`) detect a dead link in ~30s, so the actor
            // sees the EOF that triggers its auto-reconnect and the reattach/replay path
            // takes over.
            let options = crate::ipc::commands::keyed_ssh_args(
                remote.port,
                remote.identity_file.as_deref(),
                remote.known_hosts_file.as_deref(),
            )
            .map_err(|e| TransportError::Spawn(std::io::Error::new(std::io::ErrorKind::InvalidInput, e)))?;
            cmd.arg("-T") // no PTY: the channel carries raw JSON lines both ways
                .args(options);
            // The live session spawn itself — the MOST load-bearing entry point (CRM
            // holistic-review blocker #3, chantier A `bd7ca709`): a `MachineRecord`
            // that predates `validate_ssh_user` (older app version, manual DB edit)
            // must never reach an actual ssh spawn built from its raw `user`/`host`.
            if let Err(e) = crate::ipc::commands::push_ssh_destination(&mut cmd, &remote.user, &remote.host) {
                return Err(TransportError::InvalidRemoteTarget(e));
            }
            cmd.arg(remote_cmd);
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

        let (msg_tx, msg_rx) = inbound_channel(INBOUND_BUDGET_BYTES);
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Value>();

        let stderr_tail: StderrTail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_MAX)));
        let stderr_done: Arc<Notify> = Arc::new(Notify::new());
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let writer_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable_replayable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let first_unparseable_offset: Arc<AtomicU64> = Arc::new(AtomicU64::new(u64::MAX));
        let skip_violation: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let oversized: Arc<OversizedLines> = Arc::default();

        // Where, in a replay of the same process, the earlier actor's view ends (see
        // `ReplayWindow::news_at`).
        let seen = cfg
            .attach
            .as_ref()
            .and_then(|a| a.prior.as_ref())
            .map(|p| (p.epoch.clone(), p.cursor));
        let pumps = vec![
            tokio::spawn(reader_loop(
                stdout,
                msg_tx,
                reader_err.clone(),
                lines_seen.clone(),
                unparseable_replayable.clone(),
                first_unparseable_offset.clone(),
                skip_violation.clone(),
                oversized.clone(),
                MAX_STDOUT_LINE_BYTES,
                seen,
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
                oversized,
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

    /// Take (and reset) the count of stdout lines dropped for exceeding
    /// [`MAX_STDOUT_LINE_BYTES`] since the last call — `None` when there were none.
    /// The session stays alive across a drop; the actor surfaces each report as one
    /// `protocol_error` notice (see `session.rs::run_actor`).
    pub fn take_oversized_lines(&self) -> Option<OversizedReport> {
        let count = self.oversized.count.swap(0, Ordering::Relaxed);
        let largest_bytes = self.oversized.largest_bytes.swap(0, Ordering::Relaxed);
        let too_dense = self.oversized.too_dense.swap(0, Ordering::Relaxed);
        (count > 0).then_some(OversizedReport { count, largest_bytes, too_dense })
    }

    /// Resolves once `reader_loop` has dropped an oversized line since the last wake —
    /// lets the session actor report it right away instead of at the next message.
    /// Cancel-safe: a wake that lands while nobody waits is kept for the next call.
    pub async fn oversized_line_dropped(&self) {
        self.oversized.wake.notified().await
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
///
/// M3: a line is read with a hard length cap (`max_line`, [`MAX_STDOUT_LINE_BYTES`] in
/// production — see there for the number). A longer line is discarded up to its
/// newline without ever being buffered whole, counted in `oversized` for the session
/// actor to surface as a `protocol_error` notice, and the stream carries on: one bad
/// line never ends the session. Unlike a line that fails to PARSE, a replayable
/// oversized line DOES advance `lines_seen` — it is just as oversized on every replay
/// (and too big for the daemon's replay ring anyway), so asking for it again could only
/// loop; counting it keeps the cursor aligned with the daemon's seq — and, inside a
/// reattach replay, it counts toward the [`ReplayWindow`] too (there even when its kept head
/// names no type: the daemon replays nothing but ring entries). Parsed messages
/// go out through the byte-bounded [`InboundSender`], so a stdout that outpaces the
/// actor is backpressured instead of queued without limit.
#[allow(clippy::too_many_arguments)]
async fn reader_loop<R: tokio::io::AsyncRead + Unpin>(
    stdout: R,
    tx: InboundSender,
    reader_err: ErrSlot,
    lines_seen: Arc<AtomicU64>,
    unparseable_replayable: Arc<AtomicU64>,
    first_unparseable_offset: Arc<AtomicU64>,
    skip_violation: Arc<Mutex<Option<String>>>,
    oversized: Arc<OversizedLines>,
    max_line: usize,
    // An earlier actor's view of this conversation: its epoch and cursor (see `PriorView`).
    seen: Option<(String, u64)>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    // This connection's absolute base (see the doc above) — learned from the
    // FIRST `fd_attach` frame it receives, `0` until then (and forever, for a
    // local session or a remote one that never gets one).
    let mut attach_base: u64 = 0;
    // The reattach replay still to come on this connection (see `ReplayWindow`): its end
    // is marked in-band with `CliMessage::FdReplayEnd`, right behind its last line.
    let mut replay: Option<ReplayWindow> = None;
    loop {
        match read_bounded_line(&mut reader, &mut buf, max_line, OVERSIZED_PREFIX_BYTES).await {
            Ok(BoundedLine::Oversized { bytes }) => {
                let kind = type_from_prefix(&buf);
                buf.clear();
                // Inside a replay window every line is one of the daemon's ring entries —
                // replayable by construction — even one whose head is too short to name its
                // type. It took its seq like any other: uncounted, the window would close late
                // (live lines passing for history) and the cursor would lag the daemon's seq.
                let replayable = kind.as_deref().map_or(replay.is_some(), is_replayable_type);
                eprintln!(
                    "[transport] dropping a {} stdout line of {bytes} bytes (limit {max_line})",
                    kind.as_deref().unwrap_or("?"),
                );
                let marker = drop_unread_line(replayable, bytes, false, &lines_seen, &oversized, &mut replay);
                if let Some(marker) = marker {
                    if tx.send(marker, 0).await.is_err() {
                        break;
                    }
                }
            }
            Ok(BoundedLine::Line) => {
                // `mem::take`: each line owns a fresh allocation (as with `Lines`), so a
                // single multi-MB line is not retained by the reader after it is parsed.
                let line = match String::from_utf8(std::mem::take(&mut buf)) {
                    Ok(line) => line,
                    // Not UTF-8 — a server's login banner in Latin-1 before `exec flightdeckd`,
                    // a stray byte in a replayed line: decoded lossily and handled like any
                    // other line (shown with replacement characters, or skipped if it does not
                    // parse). Never the end of the stream: that left a remote actor waiting on
                    // an ssh that stayed up, or re-asking for the same line in a loop.
                    Err(e) => {
                        eprintln!("[transport] a stdout line is not valid UTF-8 — decoded lossily");
                        String::from_utf8_lossy(&e.into_bytes()).into_owned()
                    }
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let replayable = is_replayable_line(trimmed);
                // Priced before it is parsed: a line of a few MiB can hold millions of tiny
                // values, each one a `Value` of its own once parsed (see `MAX_LINE_VALUES`).
                let values = json_values(trimmed.as_bytes());
                if values > MAX_LINE_VALUES {
                    eprintln!(
                        "[transport] dropping a {} stdout line of {} bytes holding {values} JSON values \
                         (limit {MAX_LINE_VALUES})",
                        type_from_prefix(trimmed.as_bytes()).as_deref().unwrap_or("?"),
                        line.len(),
                    );
                    let marker =
                        drop_unread_line(replayable, line.len() as u64, true, &lines_seen, &oversized, &mut replay);
                    if let Some(marker) = marker {
                        if tx.send(marker, 0).await.is_err() {
                            break;
                        }
                    }
                    continue;
                }
                match serde_json::from_str::<CliMessage>(trimmed) {
                    Ok(CliMessage::FdSkip(skip)) => {
                        // D6: fold the skipped range directly into this connection's
                        // position counter — `fd_skip` itself is never replayable (the
                        // `fd_` prefix excludes it, like `fd_attach`/`fd_detach`) and is
                        // NEVER forwarded to the UI (there is nothing for the assembler
                        // to render). See `apply_fd_skip`'s doc for the invariant.
                        //
                        // Matched against the WIRE position: the replayable lines this
                        // connection could not parse took their seq too, yet `lines_seen`
                        // leaves them out (the reattach cursor rolls back to the first of
                        // them). Without them a skip right behind such a line read as a
                        // violation, and the resync then counted that line twice. The
                        // position folded back into `lines_seen` keeps them out again.
                        let failed = unparseable_replayable.load(Ordering::Relaxed);
                        let current = lines_seen.load(Ordering::Relaxed) + failed;
                        let (new_position, violation) =
                            apply_fd_skip(attach_base, current, skip.from, skip.to);
                        // `apply_fd_skip` never moves back: `new_position >= current >= failed`.
                        let new_position = new_position - failed;
                        lines_seen.store(new_position, Ordering::Relaxed);
                        if violation {
                            let expected = attach_base + current + 1;
                            let note = format!(
                                "server sent fd_skip{{from:{}, to:{}}} but this connection \
                                 expected the next replayable seq to be {expected} \
                                 (attach_base {attach_base} + position {current}) — \
                                 resyncing to relative position {}",
                                skip.from,
                                skip.to,
                                new_position + failed,
                            );
                            eprintln!("[transport] {note}");
                            if let Ok(mut slot) = skip_violation.lock() {
                                if slot.is_none() {
                                    *slot = Some(note);
                                }
                            }
                        }
                        // The skipped range is part of the replay too: it may be what
                        // completes it (a replay that ENDS on compacted deltas).
                        if replay.as_mut().is_some_and(|w| w.skip_to(skip.to)) {
                            replay = None;
                            if tx.send(CliMessage::FdReplayEnd, 0).await.is_err() {
                                break;
                            }
                        } else if replay.as_mut().is_some_and(ReplayWindow::news_due) {
                            if tx.send(CliMessage::FdReplayNews, 0).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(msg) => {
                        if let CliMessage::FdAttach(attach) = &msg {
                            // Learn this connection's absolute base from the daemon's
                            // own claim, BEFORE any `fd_skip` on this connection can
                            // arrive (the daemon always sends `fd_attach` first).
                            attach_base = attach.replay_from;
                            replay = ReplayWindow::open(attach, seen.as_ref());
                        }
                        let ends_replay = replayable && replay.as_mut().is_some_and(ReplayWindow::line);
                        if replayable {
                            lines_seen.fetch_add(1, Ordering::Relaxed);
                        }
                        if tx.send(msg, inbound_charge(line.len(), values)).await.is_err() {
                            break; // consumer gone
                        }
                        // Behind the line it closes, never before: the actor must have
                        // applied the last historical line when it learns the replay ended.
                        if ends_replay {
                            replay = None;
                            if tx.send(CliMessage::FdReplayEnd, 0).await.is_err() {
                                break;
                            }
                        } else if replay.as_mut().is_some_and(ReplayWindow::news_due) {
                            // Behind the line that reached the earlier actor's view (or the
                            // `fd_attach` itself, when the replay starts past it).
                            if tx.send(CliMessage::FdReplayNews, 0).await.is_err() {
                                break;
                            }
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
                            // A line we could not read still took its place in the
                            // replay: without counting it, a replay holding one would
                            // never end and everything after it would pass for history.
                            if replay.as_mut().is_some_and(ReplayWindow::line) {
                                replay = None;
                                if tx.send(CliMessage::FdReplayEnd, 0).await.is_err() {
                                    break;
                                }
                            } else if replay.as_mut().is_some_and(ReplayWindow::news_due) {
                                if tx.send(CliMessage::FdReplayNews, 0).await.is_err() {
                                    break;
                                }
                            }
                        }
                        eprintln!(
                            "[transport] skipping unparseable {} stdout line: {e}: {}",
                            message_type_hint(trimmed),
                            truncate(trimmed, 160)
                        );
                    }
                }
            }
            Ok(BoundedLine::Eof) => break, // EOF: process closed stdout (clean — no reader_err)
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

/// A stdout line [`reader_loop`] drops unread — longer than its cap, or holding more JSON
/// values than [`MAX_LINE_VALUES`] (`too_dense`) — reported through `oversized` with a
/// wake-up, so the actor says so at once. A `replayable` one took its seq like any line:
/// counted in `lines_seen` (it can never be replayed whole either), and its place in the
/// replay is behind it — the replay marker now due, if any, is returned for the caller to
/// send.
fn drop_unread_line(
    replayable: bool,
    bytes: u64,
    too_dense: bool,
    lines_seen: &AtomicU64,
    oversized: &OversizedLines,
    replay: &mut Option<ReplayWindow>,
) -> Option<CliMessage> {
    if replayable {
        lines_seen.fetch_add(1, Ordering::Relaxed);
    }
    oversized.count.fetch_add(1, Ordering::Relaxed);
    oversized.largest_bytes.fetch_max(bytes, Ordering::Relaxed);
    if too_dense {
        oversized.too_dense.fetch_add(1, Ordering::Relaxed);
    }
    oversized.wake.notify_one();
    if !replayable {
        None
    } else if replay.as_mut().is_some_and(ReplayWindow::line) {
        *replay = None;
        Some(CliMessage::FdReplayEnd)
    } else if replay.as_mut().is_some_and(ReplayWindow::news_due) {
        Some(CliMessage::FdReplayNews)
    } else {
        None
    }
}

/// Outcome of one [`read_bounded_line`].
#[derive(Debug, PartialEq, Eq)]
enum BoundedLine {
    /// A whole line (newline excluded) is in the buffer. The last line of a stream may
    /// lack its newline, as with `Lines`.
    Line,
    /// The line was longer than the cap: it was consumed up to and including its
    /// newline (or EOF) and only its head — up to the `keep_head` bytes passed in — is
    /// left in the buffer. `bytes` is its full length, newline excluded.
    Oversized { bytes: u64 },
    /// The stream ended with no further bytes.
    Eof,
}

/// Read one `\n`-terminated line into `buf` (cleared first), holding at most `max`
/// bytes of it in memory: past that, the rest of the line is consumed and discarded
/// chunk by chunk, so a peer that never sends a newline costs at most `max` bytes plus
/// the reader's own buffer — never an unbounded allocation.
async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
    keep_head: usize,
) -> std::io::Result<BoundedLine> {
    buf.clear();
    let mut total: u64 = 0;
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if oversized {
                BoundedLine::Oversized { bytes: total }
            } else if buf.is_empty() && total == 0 {
                BoundedLine::Eof
            } else {
                BoundedLine::Line
            });
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let content = &available[..newline.unwrap_or(available.len())];
        total += content.len() as u64;
        if !oversized {
            if buf.len() + content.len() > max {
                oversized = true;
                // Keep only the head, and give the rest of the allocation back now.
                let room = keep_head.saturating_sub(buf.len());
                buf.extend_from_slice(&content[..room.min(content.len())]);
                buf.truncate(keep_head);
                buf.shrink_to_fit();
            } else {
                buf.extend_from_slice(content);
            }
        }
        let used = newline.map_or(available.len(), |i| i + 1);
        reader.consume(used);
        if newline.is_some() {
            if oversized {
                return Ok(BoundedLine::Oversized { bytes: total });
            }
            // A CRLF ending loses its `\r` too, exactly like `Lines::next_line`.
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(BoundedLine::Line);
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

/// The reattach REPLAY of one connection: the history the daemon re-delivers between its
/// `fd_attach` and the live tail, tracked in the daemon's absolute seq space so it can be
/// closed in-band ([`CliMessage::FdReplayEnd`]) right behind its last line.
///
/// Why the reader and not the session actor: only the reader sees all four things a replay
/// is made of — lines that parse, lines that do NOT (they still took their seq), lines too
/// long to read at all (dropped, but they took their seq too — see [`reader_loop`]'s M3
/// note), and `fd_skip` ranges (folded here, never forwarded). The actor cannot count what it never
/// receives; and reading [`Transport::lines_seen`] from the actor would race the reader,
/// which is always ahead of what the actor has applied. An in-band marker has neither
/// problem: everything the actor reads before it is history, everything after is live.
///
/// `reached` follows an `fd_skip`'s absolute `to` rather than adding its length, and never
/// moves back — the same "trust the daemon's own position, never un-count" rule as
/// [`apply_fd_skip`], so a mismatched frame cannot keep a replay open forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReplayWindow {
    /// Absolute seq of the replay's last line (`fd_attach.seq`).
    end: u64,
    /// Absolute seq reached so far (starts at `fd_attach.replay_from`).
    reached: u64,
    /// Absolute seq past which the replay is NEWS to the front, though history to the actor:
    /// an earlier actor of this conversation already showed everything up to it (see
    /// [`PriorView`]) — only for a replay of that same process. Marked in-band
    /// ([`CliMessage::FdReplayNews`]), once, right behind the line that reaches it; `None`
    /// once marked, or when there is nothing to mark.
    news_at: Option<u64>,
}

impl ReplayWindow {
    /// The window an `fd_attach` opens — `None` for an empty replay (nothing to mark: the
    /// session actor resolves it at the `FdAttach` itself, with the same
    /// [`FdAttachMsg::replay_len`](super::protocol::FdAttachMsg::replay_len)). `seen`: an
    /// earlier actor's `(epoch, cursor)`, which places [`Self::news_at`] when the daemon
    /// attached us to that same process (another process's lines are all news, which the
    /// session actor sees from the epoch alone).
    fn open(attach: &super::protocol::FdAttachMsg, seen: Option<&(String, u64)>) -> Option<Self> {
        let news_at = seen.filter(|(epoch, _)| *epoch == attach.epoch).map(|(_, cursor)| *cursor);
        (attach.replay_len() > 0).then_some(Self { end: attach.seq, reached: attach.replay_from, news_at })
    }

    /// Has the replay just reached the earlier actor's view, with lines still to come? `true`
    /// once — the caller then marks it in-band.
    fn news_due(&mut self) -> bool {
        match self.news_at {
            Some(at) if self.reached >= at && self.reached < self.end => {
                self.news_at = None;
                true
            }
            _ => false,
        }
    }

    /// One replayable line went by, parsed or not. `true` when it was the replay's last.
    fn line(&mut self) -> bool {
        self.reached += 1;
        self.reached >= self.end
    }

    /// An `fd_skip` covered the replay up to absolute seq `to`. `true` when that ends it.
    fn skip_to(&mut self, to: u64) -> bool {
        self.reached = self.reached.max(to);
        self.reached >= self.end
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
///
/// Lines are read bounded ([`MAX_STDERR_LINE_BYTES`], the head of a longer one kept):
/// on a remote session this is the server's stderr, which must not be able to grow
/// our memory without limit any more than its stdout can.
async fn stderr_loop(stderr: ChildStderr, tail: StderrTail, done: Arc<Notify>) {
    let mut reader = BufReader::new(stderr);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let read = read_bounded_line(&mut reader, &mut buf, MAX_STDERR_LINE_BYTES, MAX_STDERR_LINE_BYTES);
        let line = match read.await {
            Ok(BoundedLine::Line) => String::from_utf8_lossy(&buf).into_owned(),
            Ok(BoundedLine::Oversized { .. }) => format!("{}…", String::from_utf8_lossy(&buf)),
            Ok(BoundedLine::Eof) | Err(_) => break,
        };
        if !line.trim().is_empty() {
            eprintln!("[claude stderr] {line}");
            if let Ok(mut ring) = tail.lock() {
                if ring.len() == STDERR_TAIL_MAX {
                    ring.pop_front();
                }
                ring.push_back(line);
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
            prior: None,
            existing_only: false,
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
            prior: None,
            existing_only: false,
        });
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains("--supports-skip"), "cmd was: {cmd}");
        assert!(!cmd.contains("--existing-only"), "an attach may start claude unless told not to: {cmd}");

        // The resume pass's attach joins a running claude only.
        cfg.attach.as_mut().unwrap().existing_only = true;
        let cmd = build_remote_command(&cfg, &remote, &build_claude_args(&cfg));
        assert!(cmd.contains(" --existing-only"), "cmd was: {cmd}");
        assert!(cmd.find("--existing-only").unwrap() < cmd.find(" -- ").unwrap(), "before the claude argv: {cmd}");
        cfg.attach.as_mut().unwrap().existing_only = false;

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

    /// The push names the daemon conversation this one ran under, and NOT its Claude session:
    /// a phone `/clear` moves that conversation to another session while this Mac is away, and
    /// a push by the stale session found no conversation holding it — the daemon then created
    /// a second one, with an idle `claude` on the old transcript, which the next spawn could
    /// even re-home the Mac conversation onto. (Named together, the stale session would win
    /// over the conversation's own.) Only a conversation that never recorded its daemon id
    /// is still pushed by session.
    #[test]
    fn the_title_push_names_the_daemon_conversation_it_ran_under() {
        let cmd = remote_title_command("flightdeckd", Some("d1"), "sid-1", "/work/demo", " New ");
        assert!(cmd.contains("--conversation 'd1'"), "{cmd}");
        assert!(!cmd.contains("--resume-session"), "{cmd}");
        assert!(cmd.contains("--title='New'") && cmd.contains("--cwd '/work/demo'"), "{cmd}");
        let cmd = remote_title_command("flightdeckd", None, "sid-1", "/work/demo", "New");
        assert!(cmd.contains("--resume-session 'sid-1'") && !cmd.contains("--conversation"), "{cmd}");
    }

    /// A blank/whitespace-only title is rejected up front — no ssh is even spawned
    /// (nothing to prove: `TOSSE_SSH_BIN` is deliberately left unset/invalid).
    #[tokio::test]
    async fn push_remote_title_rejects_a_blank_title_without_touching_ssh() {
        let _guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", "/definitely/not/a/real/binary");
        let ok = push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "   ", false).await;
        std::env::remove_var("TOSSE_SSH_BIN");
        assert!(!ok, "a blank title must be rejected before ever spawning ssh");
    }

    /// The race this whole EOF-disambiguation exists for: an ssh process that fails
    /// IMMEDIATELY (connection refused, auth rejected, daemon down — nothing written
    /// to stdout, since stderr is `Stdio::null()`) and exits non-zero at essentially
    /// the same instant its stdout pipe closes. Before the fix, `tokio::select!`
    /// raced a bare `Ok(0)` EOF (read as unconditional success) against
    /// `child.wait()` (correctly `false`) and picked the winner at random —
    /// reproduced standalone at a ~50% false-positive rate. Run several iterations
    /// so a reintroduced race shows up as a flake rather than being masked by
    /// getting lucky once.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_returns_false_when_ssh_exits_immediately_with_no_output() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-push-failfast-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-ssh.sh");
        // Exits non-zero writing NOTHING to stdout — the exact shape of a real ssh
        // connection-level failure.
        fs::write(&script, "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        for i in 0..50 {
            let ok = tokio::time::timeout(
                Duration::from_secs(10),
                push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "My Feature", false),
            )
            .await
            .expect("push_remote_title must not hang");
            assert!(!ok, "iteration {i}: an ssh that exits non-zero with no output must never read as success");
        }
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The app's known-hosts file lives under `~/Library/Application Support/…`: passed
    /// bare, ssh read it as a whitespace-separated LIST of files and pinned into
    /// `~/Library/Application`. The remote spawns take the crate's one keyed option list,
    /// which quotes it (`ipc::commands::known_hosts_option`, proven against `ssh -G` there).
    #[cfg(unix)]
    #[tokio::test]
    async fn remote_spawns_name_a_spaced_known_hosts_file_as_one_file() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-remote-kh-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("argv");
        let script = dir.join("fake-ssh.sh");
        fs::write(&script, format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{}'\n", log.display()))
            .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut remote = test_remote_target("flightdeckd");
        remote.known_hosts_file = Some("/Users/u/Library/Application Support/com.tosse.desktop/remote_known_hosts".into());

        let guard = SSH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let stopped = tokio::time::timeout(Duration::from_secs(10), run_remote_stop(&remote, "c1")).await;
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        assert_eq!(stopped.ok(), Some(true));
        let argv = fs::read_to_string(&log).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(
            argv.lines().any(|a| a
                == "UserKnownHostsFile=\"/Users/u/Library/Application Support/com.tosse.desktop/remote_known_hosts\""),
            "{argv}"
        );
    }

    /// A title containing an embedded NUL byte can never survive to the remote shell
    /// at all: `std::process::Command::spawn()` rejects any argument containing an
    /// interior NUL byte before the process is even spawned (verified independently:
    /// `Command::new("echo").arg("hello\0world").spawn()` errors with
    /// `InvalidInput`/"nul byte found in provided data"). This proves the already-safe
    /// behavior — graceful `false`, no panic, no hang — rather than a shell-injection
    /// risk, since `push_remote_title`'s own `cmd.arg(format!(...))` construction hits
    /// the same guard.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_returns_false_for_a_title_containing_a_nul_byte() {
        let _guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", "/definitely/not/a/real/binary");
        let ok = tokio::time::timeout(
            Duration::from_secs(10),
            push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "bad\0title", false),
        )
        .await
        .expect("push_remote_title must not hang on a NUL-containing title");
        std::env::remove_var("TOSSE_SSH_BIN");
        assert!(!ok, "a NUL-containing title must fail gracefully (Command::spawn rejects it), never panic or hang");
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
            push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "My Feature", false),
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
            push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "My Feature", false),
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
            push_remote_title(&test_remote_target("flightdeckd"), None, "sid-1", "/work/demo", "My Feature", false),
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

    /// What `flightdeckd set-title` answers, read from its stdout, exit code and stderr: the
    /// daemon's `fd_title_set{ok:true}` (behind whatever a login script printed) renames; a
    /// binary without the subcommand (clap) or a RUNNING daemon that predates the verb (the
    /// binary reports its `fd_detach`) is "unsupported" — the old push is then used; anything
    /// else — a refusal, a dead ssh, an exit 0 with no reply — is a failure with its reason.
    #[test]
    fn set_title_outcome_reads_the_daemons_answer() {
        assert_eq!(
            set_title_outcome("motd\n{\"type\":\"fd_title_set\",\"ok\":true,\"conversation\":\"d1\"}\n", Some(0), ""),
            SetTitleOutcome::Set
        );
        assert_eq!(
            set_title_outcome("", Some(2), "error: unrecognized subcommand 'set-title'\n\nUsage: flightdeckd <COMMAND>\n"),
            SetTitleOutcome::Unsupported
        );
        assert_eq!(
            set_title_outcome(
                "",
                Some(1),
                "Error: the running flightdeckd predates `set-title` — restart it on this binary (missing attach, status)\n"
            ),
            SetTitleOutcome::Unsupported
        );
        assert_eq!(
            set_title_outcome("", Some(1), "Error: no conversation on this server is d1 or runs claude session s1\n"),
            SetTitleOutcome::Failed("Error: no conversation on this server is d1 or runs claude session s1".into())
        );
        assert!(matches!(
            set_title_outcome("{\"type\":\"fd_title_set\",\"ok\":false,\"error\":\"blank\"}\n", Some(0), ""),
            SetTitleOutcome::Failed(_)
        ));
        assert!(matches!(set_title_outcome("", Some(0), ""), SetTitleOutcome::Failed(_)), "no reply is no rename");
        assert!(matches!(
            set_title_outcome("", Some(255), "ssh: connect to host h port 22: Connection refused\n"),
            SetTitleOutcome::Failed(r) if r.contains("Connection refused")
        ));
        assert!(matches!(set_title_outcome("", None, ""), SetTitleOutcome::Failed(_)), "killed / timed out");
    }

    /// Run [`push_remote_title`] (verb available, daemon conversation `d1`) against a fake ssh
    /// whose `set-title` run executes `set_title_body` and whose `attach` run acks and stays up;
    /// returns its verdict and the remote command of every ssh run, in order.
    #[cfg(unix)]
    async fn push_title_with_fake_ssh(tag: &str, set_title_body: &str) -> (bool, Vec<String>) {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("tosse-title-verb-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("commands.log");
        let script = dir.join("fake-ssh.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nfor a; do last=\"$a\"; done\nprintf '%s\\n' \"$last\" >> '{}'\ncase \"$last\" in\n*set-title*) {set_title_body} ;;\n*) printf '%s\\n' '{{\"type\":\"fd_attach\",\"conversation\":\"d1\",\"epoch\":\"e1\",\"replay_from\":0}}'; sleep 30 ;;\nesac\n",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let guard = SSH_ENV_LOCK.lock().unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);
        let ok = tokio::time::timeout(
            Duration::from_secs(20),
            push_remote_title(&test_remote_target("flightdeckd"), Some("d1"), "sid-1", "/work/demo", "My Feature", true),
        )
        .await
        .expect("push_remote_title must not hang");
        std::env::remove_var("TOSSE_SSH_BIN");
        drop(guard);
        let commands: Vec<String> = fs::read_to_string(&log).unwrap_or_default().lines().map(str::to_string).collect();
        let _ = fs::remove_dir_all(&dir);
        (ok, commands)
    }

    /// With the verb available, a rename is ONE `flightdeckd set-title` naming the daemon's
    /// conversation and the session — never an `attach`, which cold-started an idle
    /// conversation's claude and replaced whichever client was attached to a live one.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_renames_with_the_set_title_verb_and_never_attaches() {
        let (ok, commands) = push_title_with_fake_ssh(
            "set",
            "printf '%s\\n' '{\"type\":\"fd_title_set\",\"ok\":true,\"conversation\":\"d1\"}'",
        )
        .await;
        assert!(ok);
        assert_eq!(commands.len(), 1, "{commands:?}");
        let cmd = &commands[0];
        assert!(cmd.contains(" set-title "), "{cmd}");
        assert!(cmd.contains("--conversation 'd1'"), "{cmd}");
        assert!(cmd.contains("--resume-session 'sid-1'"), "{cmd}");
        assert!(cmd.contains("--title='My Feature'"), "{cmd}");
        assert!(!cmd.contains(" attach "), "{cmd}");
    }

    /// A RUNNING daemon older than the verb (its binary already updated, the daemon not yet
    /// restarted) answers it `fd_detach` — reported by the binary: the rename then takes the
    /// old `attach --title` push, which that daemon knows.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_falls_back_to_the_attach_push_when_the_running_daemon_predates_the_verb() {
        let (ok, commands) = push_title_with_fake_ssh(
            "predates",
            "printf '%s\\n' 'Error: the running flightdeckd predates `set-title` — restart it on this binary (missing attach)' >&2; exit 1",
        )
        .await;
        assert!(ok);
        assert_eq!(commands.len(), 2, "{commands:?}");
        assert!(commands[0].contains(" set-title "));
        assert!(commands[1].contains(" attach "), "{commands:?}");
    }

    /// A daemon that REFUSES the rename (no such conversation there) is a failure — never
    /// retried as an attach, which would cold-start a new conversation under that session.
    #[cfg(unix)]
    #[tokio::test]
    async fn push_remote_title_reports_a_refused_rename_without_attaching() {
        let (ok, commands) = push_title_with_fake_ssh(
            "refused",
            "printf '%s\\n' 'Error: no conversation on this server is d1 or runs claude session sid-1' >&2; exit 1",
        )
        .await;
        assert!(!ok);
        assert_eq!(commands.len(), 1, "{commands:?}");
    }

    /// Live M1 acceptance check (C9): [`push_remote_title`] against a REAL daemon,
    /// end to end — spawn a throwaway conversation, fully STOP it (so the daemon has
    /// no live actor for it — the "idle rename" case this helper exists for), push a
    /// fresh title, and confirm `flightdeckd status` shows it.
    ///
    /// Also checks the rename starts nothing: with the `set-title` verb the idle
    /// conversation stays idle (the older `attach --title` push cold-started its claude).
    ///
    /// Ignored by default: needs the flightdeck-m1 container up with fresh creds
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`), daemon >= 0.6.0. Run with:
    ///   cargo test -p tosse-code --lib -- --ignored push_remote_title_against_the_m1_daemon --nocapture
    #[tokio::test]
    #[ignore = "spawns real ssh + flightdeckd + remote claude (needs the flightdeck-m1 container, daemon >= 0.6.0)"]
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
                let mut cmd = tokio::process::Command::new(resolve_ssh_bin());
                cmd.arg("-T")
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
                    .arg("IdentitiesOnly=yes");
                crate::ipc::commands::push_ssh_destination(&mut cmd, &remote.user, &remote.host)
                    .expect("a fixed literal test user/host must always validate");
                let out = cmd
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
        let ok = push_remote_title(&remote, Some(&attach.conversation), &session_id, "/work/demo", &title, true).await;
        assert!(ok, "push_remote_title should report success against a real daemon");

        let after = status_line(&run_status().await);
        let row_after = row_for(&after, &attach.conversation);
        eprintln!("[live] after push_remote_title: {row_after}");
        assert_eq!(row_after["title"], title, "the daemon should now carry the pushed title");
        // The `set-title` verb (daemon >= 0.6.0) renames and does nothing else: the idle
        // conversation stays idle (the `attach --title` push cold-started its claude).
        assert_eq!(row_after["running"], false, "an idle rename must not start the claude process");
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
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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
    /// `attach.rs` integration test (`flightdeckd/src/attach.rs`, seeded from
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
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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

    /// The reverse order: an unparseable line BEFORE an `fd_skip` (the reattach after it
    /// rolls back to that line, so every such replay starts with it). It took its seq on
    /// the wire, so the daemon's skip starts one past it — no violation. `lines_seen` keeps
    /// counting successes and folded ranges only, so `lines_seen + unparseable` is the
    /// exact wire position (never the failed line counted twice, which overshot the forced
    /// cursor of a give-up and lost that many new lines), and the rollback point stays the
    /// failed line's own.
    #[tokio::test]
    async fn reader_loop_an_unparseable_line_before_a_skip_is_no_violation() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
        ));

        writer
            .write_all(b"{\"type\":\"fd_attach\",\"conversation\":\"c\",\"epoch\":\"e\",\"replay_from\":0,\"seq\":6}\n")
            .await
            .unwrap();
        writer.write_all(b"{\"type\":\"result\"}\n").await.unwrap(); // FAIL — seq 1
        writer.write_all(b"{\"type\":\"fd_skip\",\"from\":2,\"to\":5}\n").await.unwrap(); // seqs 2..=5
        writer
            .write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n") // OK — seq 6
            .await
            .unwrap();
        drop(writer); // EOF: ends reader_loop

        task.await.expect("reader_loop should not panic");

        assert_eq!(*skip_violation.lock().unwrap(), None, "the skip starts right after the failed line");
        assert_eq!(unparseable.load(Ordering::Relaxed), 1);
        assert_eq!(
            lines_seen.load(Ordering::Relaxed) + unparseable.load(Ordering::Relaxed),
            6,
            "the exact wire position: the failed line counted once"
        );
        assert_eq!(first_unparseable.load(Ordering::Relaxed), 0, "the rollback point is the failed line's");

        let mut received = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            received.push(msg);
        }
        assert!(matches!(received.first(), Some(CliMessage::FdAttach(_))), "{received:?}");
        assert!(
            matches!(received[received.len() - 2..], [CliMessage::Result(_), CliMessage::FdReplayEnd]),
            "the replay ends right behind its last line: {received:?}"
        );
    }

    /// A violated `fd_skip{from}` (not `current + 1`) resyncs the position AND
    /// records exactly one violation note — a SECOND violation in the same
    /// connection must not overwrite the first (the "once" in "one-time notice").
    #[tokio::test]
    async fn reader_loop_flags_a_skip_violation_once_and_resyncs() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, _rx) = inbound_channel(INBOUND_BUDGET_BYTES);
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
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
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

    // --- M3: bounded stdout lines + byte-bounded inbound queue ------------------

    /// Drive [`read_bounded_line`] over an in-memory stream with a small BufReader, so
    /// lines span several `fill_buf` chunks like a real pipe.
    async fn bounded_lines(input: &[u8], max: usize, keep_head: usize) -> Vec<(BoundedLine, Vec<u8>)> {
        let mut reader = BufReader::with_capacity(4, input);
        let mut buf = Vec::new();
        let mut out = Vec::new();
        loop {
            let got = read_bounded_line(&mut reader, &mut buf, max, keep_head).await.unwrap();
            if got == BoundedLine::Eof {
                return out;
            }
            out.push((got, buf.clone()));
        }
    }

    #[tokio::test]
    async fn read_bounded_line_drops_an_over_long_line_and_resumes_at_the_next() {
        let got = bounded_lines(b"short\n0123456789abcdef\r\nok\r\n\nlast", 10, 3).await;
        assert_eq!(
            got,
            vec![
                (BoundedLine::Line, b"short".to_vec()),
                // 16 bytes > 10: consumed through its newline, only the 3-byte head kept.
                (BoundedLine::Oversized { bytes: 17 }, b"012".to_vec()),
                // CRLF loses its `\r`, an empty line stays a line, the unterminated
                // tail still comes out — all exactly like `Lines::next_line`.
                (BoundedLine::Line, b"ok".to_vec()),
                (BoundedLine::Line, Vec::new()),
                (BoundedLine::Line, b"last".to_vec()),
            ]
        );
    }

    #[tokio::test]
    async fn read_bounded_line_accepts_a_line_of_exactly_the_cap_and_reports_an_oversized_tail_at_eof() {
        let got = bounded_lines(b"0123456789\n0123456789X", 10, 4).await;
        assert_eq!(
            got,
            vec![
                (BoundedLine::Line, b"0123456789".to_vec()),
                (BoundedLine::Oversized { bytes: 11 }, b"0123".to_vec()),
            ]
        );
    }

    #[test]
    fn type_from_prefix_reads_the_top_level_type_of_a_truncated_object() {
        assert_eq!(type_from_prefix(br#"{"type":"user","message":{"content":"aaaa"#).as_deref(), Some("user"));
        // Not first, and preceded by a nested value that has its own `type` key.
        assert_eq!(
            type_from_prefix(br#"{"meta":{"type":"control_request"},"type":"assistant","x":"#).as_deref(),
            Some("assistant")
        );
        // A `"type"` inside a string value is not a key.
        assert_eq!(type_from_prefix(br#"{"text":"\"type\":\"result\"","#), None);
        // Cut before the value is complete, or never reached.
        assert_eq!(type_from_prefix(br#"{"type":"assis"#), None);
        assert_eq!(type_from_prefix(br#"{"message":{"content":"aaaa"#), None);
        assert_eq!(type_from_prefix(b"not json"), None);
    }

    /// The core of M3: an over-long line is dropped (never forwarded, never buffered
    /// whole), reported once through `oversized` with a wake-up, and the stream goes on.
    /// A replayable one advances `lines_seen` (it can never be replayed); a control-plane
    /// one does not (the daemon never counts those either).
    #[tokio::test]
    async fn reader_loop_drops_an_oversized_line_reports_it_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let unparseable: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let oversized: Arc<OversizedLines> = Arc::default();

        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err.clone(),
            lines_seen.clone(),
            unparseable.clone(),
            Arc::new(AtomicU64::new(u64::MAX)),
            Arc::new(Mutex::new(None)),
            oversized.clone(),
            256,
            None,
        ));

        let big = format!(r#"{{"type":"user","message":{{"content":"{}"}}}}"#, "a".repeat(1000));
        let big_control = format!(r#"{{"type":"control_request","request":{{"x":"{}"}}}}"#, "b".repeat(1000));
        writer.write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n").await.unwrap();
        writer.write_all(format!("{big}\n").as_bytes()).await.unwrap();
        writer.write_all(format!("{big_control}\n").as_bytes()).await.unwrap();
        writer.write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n").await.unwrap();
        drop(writer);
        task.await.expect("reader_loop should not panic");

        assert!(reader_err.lock().unwrap().is_none(), "an oversized line is not a stream failure");
        assert_eq!(
            lines_seen.load(Ordering::Relaxed),
            3,
            "2 parsed results + the replayable oversized `user` line; not the control_request"
        );
        assert_eq!(unparseable.load(Ordering::Relaxed), 0, "dropped for size, not a parse failure");
        assert_eq!(oversized.count.load(Ordering::Relaxed), 2);
        assert_eq!(oversized.largest_bytes.load(Ordering::Relaxed), big.len().max(big_control.len()) as u64);
        tokio::time::timeout(Duration::from_secs(1), oversized.wake.notified())
            .await
            .expect("a drop must wake the actor");

        for _ in 0..2 {
            let msg = rx.recv().await.expect("both well-formed lines still reach the consumer");
            assert!(matches!(msg, CliMessage::Result(_)));
        }
        assert!(rx.recv().await.is_none(), "nothing else was forwarded");
    }

    /// Feed `lines` to a `reader_loop` over an inbound queue of `budget` bytes, and wait for
    /// it to read them all (they stay queued: nothing consumes them).
    async fn read_into_queue(
        lines: &[String],
        budget: usize,
    ) -> (InboundReceiver, Arc<AtomicU64>, Arc<OversizedLines>) {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let (tx, rx) = inbound_channel(budget);
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let oversized: Arc<OversizedLines> = Arc::default();
        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            Arc::new(Mutex::new(None)),
            lines_seen.clone(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(u64::MAX)),
            Arc::new(Mutex::new(None)),
            oversized.clone(),
            MAX_STDOUT_LINE_BYTES,
            None,
        ));
        for line in lines {
            writer.write_all(format!("{line}\n").as_bytes()).await.unwrap();
        }
        drop(writer);
        task.await.expect("reader_loop should not panic");
        (rx, lines_seen, oversized)
    }

    /// A line is budgeted by what it costs once PARSED, not by its text: a dense array of
    /// tiny values is tens of times its text once each value is a `serde_json::Value`, so
    /// charged its length, the queue held gigabytes within its "128 MiB". A line holding
    /// one long string still costs about its length.
    #[tokio::test]
    async fn inbound_budget_charges_a_dense_array_line_for_its_parsed_size() {
        let budget = 64 * 1024 * 1024;
        let zeros = vec!["0"; 256 * 1024].join(",");
        let dense = format!(r#"{{"type":"control_request","request":[{zeros}]}}"#);
        let (mut rx, _, oversized) = read_into_queue(&[dense.clone()], budget).await;
        let charged = budget - rx.budget.available_permits();
        assert!(charged >= 16 * 1024 * 1024, "a {} byte dense line was charged only {charged}", dense.len());
        assert_eq!(oversized.count.load(Ordering::Relaxed), 0, "under the cap: delivered");
        assert!(matches!(rx.recv().await, Some(CliMessage::ControlRequest(_))));

        let text = format!(r#"{{"type":"result","subtype":"success","result":"{}"}}"#, "a".repeat(1024 * 1024));
        let (rx, _, _) = read_into_queue(&[text.clone()], budget).await;
        let charged = budget - rx.budget.available_permits();
        assert!(charged >= text.len() && charged < 2 * text.len(), "{charged} for {}", text.len());
    }

    /// A line too dense to parse within the budget is dropped like an over-long one — never
    /// parsed (its peak while parsing was the larger cost), reported through `oversized`,
    /// its place in the replay counted — and the stream goes on.
    #[tokio::test]
    async fn reader_loop_drops_a_line_with_too_many_values_like_an_oversized_one() {
        let zeros = vec!["0"; MAX_LINE_VALUES + 1].join(",");
        let dense = format!(r#"{{"type":"user","message":{{"content":[{zeros}]}}}}"#);
        let lines = [dense.clone(), r#"{"type":"result","subtype":"success"}"#.to_string()];
        let (mut rx, lines_seen, oversized) = read_into_queue(&lines, INBOUND_BUDGET_BYTES).await;
        assert_eq!(oversized.count.load(Ordering::Relaxed), 1);
        assert_eq!(oversized.too_dense.load(Ordering::Relaxed), 1);
        assert_eq!(oversized.largest_bytes.load(Ordering::Relaxed), dense.len() as u64);
        assert_eq!(lines_seen.load(Ordering::Relaxed), 2, "the dropped `user` line took its seq");
        assert!(matches!(rx.recv().await, Some(CliMessage::Result(_))), "only the result is forwarded");
        assert!(rx.recv().await.is_none());
    }

    #[test]
    fn json_values_counts_structure_outside_strings_only() {
        assert_eq!(json_values(br#"[0,0,0]"#), 4);
        assert_eq!(json_values(br#"{"a":1,"b":[2,3]}"#), 7, "keys count: each is a string once parsed");
        // Brackets, commas and colons inside strings, escaped quotes included, are text.
        assert_eq!(json_values(br#"{"a":"[,{:\"],"}"#), 3);
        assert_eq!(json_values(b"\"plain\""), 1);
        // The per-value price covers at least a `Value` itself.
        assert!(std::mem::size_of::<Value>() < PARSED_BYTES_PER_VALUE, "{}", std::mem::size_of::<Value>());
    }

    /// A line that is not UTF-8 (a server's Latin-1 login banner, a stray byte) is read
    /// lossily like any other: skipped when it does not parse, shown when it does — never
    /// the end of the stream.
    #[tokio::test]
    async fn reader_loop_skips_an_invalid_utf8_line_and_keeps_reading() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
        let reader_err: ErrSlot = Arc::new(Mutex::new(None));
        let lines_seen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            reader_err.clone(),
            lines_seen.clone(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(u64::MAX)),
            Arc::new(Mutex::new(None)),
            Arc::default(),
            MAX_STDOUT_LINE_BYTES,
            None,
        ));
        writer.write_all(b"\xffbanner\n").await.unwrap();
        writer.write_all(b"{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"caf\xe9\"}\n").await.unwrap();
        writer.write_all(b"{\"type\":\"result\",\"subtype\":\"success\"}\n").await.unwrap();
        drop(writer);
        task.await.expect("reader_loop should not panic");

        assert!(reader_err.lock().unwrap().is_none(), "not a stream failure");
        for _ in 0..2 {
            let msg = rx.recv().await.expect("the lines after the bad one still arrive");
            assert!(matches!(msg, CliMessage::Result(_)));
        }
        assert!(rx.recv().await.is_none());
        assert_eq!(lines_seen.load(Ordering::Relaxed), 2, "both results counted, the banner not");
    }

    /// The inbound queue is bounded in bytes: once the budget is spent the next send
    /// waits (backpressure, not growth), and it proceeds as soon as the consumer takes
    /// a message — nothing is lost and nothing deadlocks.
    #[tokio::test]
    async fn inbound_queue_backpressures_once_its_byte_budget_is_spent() {
        let msg = || serde_json::from_str::<CliMessage>(r#"{"type":"result","subtype":"success"}"#).unwrap();
        let (tx, mut rx) = inbound_channel(3 * INBOUND_MIN_CHARGE_BYTES);
        tx.send(msg(), 10).await.unwrap(); // charged the 1 KiB floor
        tx.send(msg(), 2 * INBOUND_MIN_CHARGE_BYTES).await.unwrap(); // budget now spent

        let tx = Arc::new(tx);
        let blocked = {
            let tx = tx.clone();
            tokio::spawn(async move { tx.send(msg(), 10).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!blocked.is_finished(), "a send past the budget must wait");

        rx.recv().await.expect("first message");
        tokio::time::timeout(Duration::from_secs(1), blocked)
            .await
            .expect("taking a message frees budget for the waiting send")
            .unwrap()
            .unwrap();
        assert!(rx.recv().await.is_some() && rx.recv().await.is_some(), "all three delivered");

        // A message larger than the whole budget is charged the whole budget, not
        // refused or left waiting forever.
        tokio::time::timeout(Duration::from_secs(1), tx.send(msg(), usize::MAX))
            .await
            .expect("an over-budget message still fits once the queue is empty")
            .unwrap();
    }

    /// Dropping the receiver fails a send that is waiting for budget, so the reader
    /// ends just as it does when its consumer is gone.
    #[tokio::test]
    async fn dropping_the_inbound_receiver_releases_a_reader_waiting_for_budget() {
        let msg = || serde_json::from_str::<CliMessage>(r#"{"type":"result","subtype":"success"}"#).unwrap();
        let (tx, rx) = inbound_channel(INBOUND_MIN_CHARGE_BYTES);
        tx.send(msg(), 1).await.unwrap();
        let waiting = tokio::spawn(async move { tx.send(msg(), 1).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(rx);
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("the waiting send must be released")
            .unwrap();
        assert!(result.is_err(), "consumer gone");
    }

    /// Drive `reader_loop` over `input` (one JSON line per entry, EOF after the last) and
    /// return the kinds it forwarded, in order.
    async fn forwarded_kinds(input: &[&str]) -> Vec<&'static str> {
        forwarded_kinds_seen(input, None).await
    }

    /// [`forwarded_kinds`], for a connection that knows an earlier actor's `(epoch, cursor)`.
    async fn forwarded_kinds_seen(input: &[&str], seen: Option<(&str, u64)>) -> Vec<&'static str> {
        forwarded_kinds_capped(input, seen, MAX_STDOUT_LINE_BYTES).await.0
    }

    /// [`forwarded_kinds_seen`] with a `max_line` cap of its own; also returns `lines_seen`.
    async fn forwarded_kinds_capped(
        input: &[&str],
        seen: Option<(&str, u64)>,
        max_line: usize,
    ) -> (Vec<&'static str>, u64) {
        let (mut writer, reader) = tokio::io::duplex(1 << 16);
        let (tx, mut rx) = inbound_channel(INBOUND_BUDGET_BYTES);
        let lines_seen = Arc::new(AtomicU64::new(0));
        let task = tokio::spawn(reader_loop(
            reader,
            tx,
            Arc::new(Mutex::new(None)),
            lines_seen.clone(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(u64::MAX)),
            Arc::new(Mutex::new(None)),
            Arc::default(),
            max_line,
            seen.map(|(epoch, cursor)| (epoch.to_string(), cursor)),
        ));
        let feed = tokio::spawn({
            let input: Vec<String> = input.iter().map(|l| l.to_string()).collect();
            async move {
                for line in input {
                    writer.write_all(line.as_bytes()).await.unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
            }
        });
        feed.await.unwrap();
        task.await.expect("reader_loop should not panic");
        let mut kinds = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            kinds.push(msg.kind());
        }
        (kinds, lines_seen.load(Ordering::Relaxed))
    }

    /// M3 × replay window: a replayed line too long to read is dropped, but it took its seq
    /// — the window counts it, so the end marker lands right behind it, before the live tail.
    #[tokio::test]
    async fn an_oversized_replayed_line_still_ends_the_replay_on_time() {
        let big = format!(r#"{{"type":"user","message":{{"content":"{}"}}}}"#, "a".repeat(1000));
        let (kinds, seen) = forwarded_kinds_capped(
            &[
                r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":0,"seq":2}"#,
                r#"{"type":"result","subtype":"success"}"#,
                &big,
                r#"{"type":"result","subtype":"success"}"#,
            ],
            None,
            256,
        )
        .await;
        assert_eq!(kinds, vec!["fd_attach", "result", "fd_replay_end", "result"]);
        assert_eq!(seen, 3, "the dropped line keeps the cursor on the daemon's seq");
    }

    /// The news mark of an earlier actor's view lands behind a dropped line that reaches it.
    #[tokio::test]
    async fn the_news_mark_lands_behind_an_oversized_line() {
        let big = format!(r#"{{"type":"assistant","message":{{"content":"{}"}}}}"#, "a".repeat(1000));
        let (kinds, _) = forwarded_kinds_capped(
            &[
                r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":0,"seq":3}"#,
                &big,
                r#"{"type":"result","subtype":"success"}"#,
                r#"{"type":"result","subtype":"success"}"#,
                r#"{"type":"result","subtype":"success"}"#,
            ],
            Some(("e", 1)),
            256,
        )
        .await;
        assert_eq!(
            kinds,
            vec!["fd_attach", "fd_replay_news", "result", "result", "fd_replay_end", "result"]
        );
    }

    /// A line whose `type` lies beyond the kept head: inside a replay window it is a ring
    /// entry all the same and counts; outside one, nothing says it is replayable.
    #[tokio::test]
    async fn an_oversized_line_with_its_type_out_of_reach_counts_only_inside_a_replay() {
        let blind = format!(r#"{{"pad":"{}","type":"user"}}"#, "a".repeat(OVERSIZED_PREFIX_BYTES + 100));
        let (kinds, seen) = forwarded_kinds_capped(
            &[
                r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":0,"seq":1}"#,
                &blind,
                r#"{"type":"result","subtype":"success"}"#,
            ],
            None,
            256,
        )
        .await;
        assert_eq!(kinds, vec!["fd_attach", "fd_replay_end", "result"]);
        assert_eq!(seen, 2);
        let (kinds, seen) = forwarded_kinds_capped(&[&blind, r#"{"type":"result","subtype":"success"}"#], None, 256).await;
        assert_eq!(kinds, vec!["result"]);
        assert_eq!(seen, 1, "outside a replay an unnamed dropped line is not counted");
    }

    /// The replay a reattach gets is `seq − replay_from` replayable lines, and an `fd_skip`
    /// range counts for every line it stands for: here 11 (a line), 12-13 (skipped), 14 (a
    /// line) — so the end marker lands right behind line 14, BEFORE the live line 15.
    #[tokio::test]
    async fn the_replay_ends_behind_its_last_line_counting_skipped_ranges() {
        let kinds = forwarded_kinds(&[
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":10,"seq":14}"#,
            r#"{"type":"system","subtype":"status","status":null}"#,
            r#"{"type":"fd_skip","from":12,"to":13}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ])
        .await;
        assert_eq!(kinds, vec!["fd_attach", "system", "result", "fd_replay_end", "result"]);
    }

    /// A replay that ENDS on a skipped range is closed by that range, and the control
    /// plane (a re-sent permission prompt) never counts toward it.
    #[tokio::test]
    async fn a_replay_ending_on_a_skip_is_closed_by_the_skip() {
        let kinds = forwarded_kinds(&[
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":0,"seq":3}"#,
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool"}}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"fd_skip","from":2,"to":3}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ])
        .await;
        assert_eq!(
            kinds,
            vec!["fd_attach", "control_request", "result", "fd_replay_end", "result"]
        );
    }

    /// A replayed line this build cannot read still took its place: the replay must end
    /// on time, or every live line after it would pass for history.
    #[tokio::test]
    async fn an_unreadable_replayed_line_still_counts_toward_the_replay() {
        let kinds = forwarded_kinds(&[
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":5,"seq":7}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":42}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ])
        .await;
        assert_eq!(kinds, vec!["fd_attach", "result", "fd_replay_end", "result"]);
    }

    /// Nothing to replay (`seq == replay_from`), and an older daemon that sends no `seq`:
    /// no marker at all — the actor resolves an empty replay at the attach itself.
    #[tokio::test]
    async fn an_empty_replay_sends_no_marker() {
        for attach in [
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":9,"seq":9}"#,
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":0}"#,
        ] {
            let kinds = forwarded_kinds(&[attach, r#"{"type":"result","subtype":"success"}"#]).await;
            assert_eq!(kinds, vec!["fd_attach", "result"], "{attach}");
        }
    }

    /// A replay of the SAME process an earlier actor watched up to seq 12: its lines past 12
    /// are news to the front — marked right behind line 12, once, and never past the end.
    #[tokio::test]
    async fn a_replay_marks_where_an_earlier_actors_view_ended() {
        let replay = [
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":10,"seq":14}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":"success"}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ];
        assert_eq!(
            forwarded_kinds_seen(&replay, Some(("e", 12))).await,
            vec!["fd_attach", "result", "result", "fd_replay_news", "result", "result", "fd_replay_end", "result"]
        );
        // Another process: no position of the earlier one means anything here (the actor
        // reads that from the epoch) — no marker.
        assert!(!forwarded_kinds_seen(&replay, Some(("old", 12))).await.contains(&"fd_replay_news"));
        // The earlier view ended before this replay starts (its ring evicted the lines in
        // between): everything replayed is news, from the attach on.
        assert_eq!(
            forwarded_kinds_seen(&replay, Some(("e", 3))).await[..2],
            ["fd_attach", "fd_replay_news"]
        );
        // It saw everything this replay holds: nothing is news, no marker.
        assert!(!forwarded_kinds_seen(&replay, Some(("e", 14))).await.contains(&"fd_replay_news"));
        // A skipped range can carry the replay past the view: marked behind the skip.
        let skipped = [
            r#"{"type":"fd_attach","conversation":"c","epoch":"e","replay_from":10,"seq":14}"#,
            r#"{"type":"fd_skip","from":11,"to":13}"#,
            r#"{"type":"result","subtype":"success"}"#,
        ];
        assert_eq!(
            forwarded_kinds_seen(&skipped, Some(("e", 12))).await,
            vec!["fd_attach", "fd_replay_news", "result", "fd_replay_end"]
        );
    }

    #[test]
    fn a_mismatched_skip_never_reopens_or_rewinds_the_window() {
        let attach: super::super::protocol::FdAttachMsg = serde_json::from_str(
            r#"{"conversation":"c","epoch":"e","replay_from":10,"seq":20}"#,
        )
        .unwrap();
        let mut w = ReplayWindow::open(&attach, None).expect("a 10-line replay");
        assert!(!w.skip_to(15));
        assert!(!w.skip_to(12), "a stale `to` behind us is not a step back");
        assert_eq!(w.reached, 15);
        assert!(w.skip_to(40), "a `to` past the end closes it, it never strands it open");
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

    /// The MOST load-bearing entry point (CRM holistic-review blocker #3, chantier A
    /// `bd7ca709`): a `RemoteTarget` built from a legacy `MachineRecord` row that
    /// predates `validate_ssh_user` (older app version, manual DB edit — see
    /// `store::db`'s own `a_legacy_row_with_an_invalid_user_loads_intact_never_
    /// vanishes_or_panics` test for that half of the story) must NEVER reach an
    /// actual ssh spawn: `Transport::spawn` itself refuses it with the clear, typed
    /// `InvalidRemoteTarget` error the brief asks for, proven here with a fake `ssh`
    /// that would leave a marker file behind if it were EVER invoked.
    #[test]
    fn spawn_refuses_a_legacy_row_with_an_invalid_user_without_spawning_ssh() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = SSH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "tosse-spawn-invalid-user-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("invoked.marker");
        let script = dir.join("fake-ssh.sh");
        std::fs::write(&script, format!("#!/bin/sh\ntouch {}\nexit 0\n", shell_quote(&marker.to_string_lossy())))
            .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("TOSSE_SSH_BIN", &script);

        let mut cfg = SpawnConfig::new(std::env::temp_dir());
        cfg.remote = Some(RemoteTarget {
            host: "example.com".into(),
            port: 22,
            user: "-oProxyCommand=touch /tmp/pwned".into(),
            identity_file: None,
            known_hosts_file: None,
            daemon_bin: "flightdeckd".into(),
            addresses: vec!["example.com".into()],
            machine_id: Some("legacy1".into()),
        });
        let result = Transport::spawn(cfg);
        std::env::remove_var("TOSSE_SSH_BIN");

        match result {
            Err(TransportError::InvalidRemoteTarget(_)) => {}
            Err(other) => panic!("expected InvalidRemoteTarget, got: {other}"),
            Ok(_) => panic!("expected InvalidRemoteTarget, but spawn succeeded"),
        }
        assert!(!marker.exists(), "ssh must NEVER have been spawned");
        let _ = std::fs::remove_dir_all(&dir);
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
    /// (this repo's `flightdeckd/live/m1/scripts/up.sh`). Run with:
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
            prior: None,
            existing_only: false,
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
