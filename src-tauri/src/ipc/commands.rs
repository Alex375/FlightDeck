use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::ipc::events::TauriEmitter;
use crate::remote_files::{self, FileReadError};
use crate::supervisor::subagents::{TaskOutputChunk, TaskOutputLocator};
use crate::store::{
    validate_address_value, validate_ssh_user, AddressCandidate, AddressKind, ConversationRecord, MachineRecord,
    PersistedState, RepoRecord, Store,
};
use crate::supervisor::codex::{self, CodexServer};
use crate::supervisor::control::{self, PermissionDecision, PermissionMode};
use crate::supervisor::history::{self, DiskConversation, IndexedConversation, SearchHit};
use crate::supervisor::model::{
    ContextFill, ConversationHistory, ConversationItem, GoalState, SessionUsage, SlashCommand,
    WorkflowJournal, WorkflowPhase, WorkflowRun,
};
use crate::supervisor::session::{self, InitialControls, SessionHandle};
use crate::supervisor::transport::{ImageAttachment, SpawnConfig};
use crate::usage::{PlanUsage, UsageError};

/// Typed return value of `ping`. Proves React -> Rust (typed command).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Pong {
    pub ok: bool,
    pub echo: String,
    pub at_ms: u64,
}

/// One registered session: its handle plus the backend it runs on. The handle itself is
/// backend-neutral by design (both actors are driven through the same command channel),
/// so the registry is the one place that still remembers WHICH backend answers — needed
/// by the rare capability that only one of them has (e.g. Claude's `get_usage`).
struct LiveSession {
    backend: Backend,
    handle: SessionHandle,
    /// Which Claude account this process authenticated as (`None` = the default,
    /// un-scoped account). Recorded at spawn because it can never change afterwards, and
    /// because a control request that reports *subscription* figures is only meaningful
    /// for the account that served it.
    claude_account_id: Option<String>,
    /// The process runs on a REMOTE (SSH) server. Its `claude` authenticates with the
    /// SERVER's own credential store, whatever account the Mac-side record says, so its
    /// `get_usage` answers for an account this Mac does not hold — never offer it for one.
    is_remote: bool,
}

/// Tauri managed state: the registry of live sessions, keyed by our own id.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, LiveSession>>,
    next: AtomicU64,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        format!("session-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Clone out a handle (never holds the lock across an `.await`).
    fn get(&self, id: &str) -> Option<SessionHandle> {
        self.inner.lock().unwrap().get(id).map(|s| s.handle.clone())
    }

    fn insert(
        &self,
        id: String,
        backend: Backend,
        handle: SessionHandle,
        claude_account_id: Option<String>,
        is_remote: bool,
    ) {
        self.inner.lock().unwrap().insert(
            id,
            LiveSession {
                backend,
                handle,
                claude_account_id,
                is_remote,
            },
        );
    }

    fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.inner.lock().unwrap().remove(id).map(|s| s.handle)
    }

    /// Snapshot every live handle WITHOUT evicting them. Each session's actor
    /// evicts itself (via its `on_exit`) once it has fully torn down, so callers
    /// can request shutdown on this snapshot and then watch [`Sessions::is_empty`]
    /// to know when every process is actually reaped.
    pub fn handles(&self) -> Vec<SessionHandle> {
        self.inner.lock().unwrap().values().map(|s| s.handle.clone()).collect()
    }

    /// Snapshot the live CLAUDE handles running on ONE account, in a DETERMINISTIC
    /// (session-id) order. A control request only the Claude CLI answers must never be
    /// aimed at whatever handle the `HashMap` happens to yield first: with a Codex
    /// conversation open too, the pick — and therefore the outcome — would change from one
    /// app run to the next.
    ///
    /// ⚠️ The account filter is load-bearing, not cosmetic. `get_usage` reports the
    /// SUBSCRIPTION figures of the account that served it, so with two accounts signed in,
    /// asking an arbitrary Claude session would answer the ring with another account's
    /// quota — a wrong number that looks entirely plausible, and one the auto-switch would
    /// then act on. Within one account the order is for reproducibility, not ranking:
    /// those sessions do all report the same answer.
    ///
    /// ⚠️ REMOTE (SSH) sessions are excluded for EVERY account, the default one included.
    /// They are recorded with no account (the launcher cannot carry one), so without this
    /// they would match `None` and the default account's ring would show the SERVER
    /// account's quota — the same plausible-but-wrong number the account filter prevents.
    fn claude_handles_for(&self, account_id: Option<&str>) -> Vec<SessionHandle> {
        let mut claude: Vec<SessionHandle> = self
            .inner
            .lock()
            .unwrap()
            .values()
            .filter(|s| matches!(s.backend, Backend::Claude))
            .filter(|s| !s.is_remote)
            .filter(|s| s.claude_account_id.as_deref() == account_id)
            .map(|s| s.handle.clone())
            .collect();
        claude.sort_by(|a, b| a.id.cmp(&b.id));
        claude
    }

    /// Snapshot the live REMOTE (SSH) handles — the only sessions with a link to lose.
    fn remote_handles(&self) -> Vec<SessionHandle> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.is_remote)
            .map(|s| s.handle.clone())
            .collect()
    }

    /// Whether any session is still registered (still tearing down or live).
    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().is_empty()
    }
}

/// Which agent backend a new conversation runs on — the IPC discriminant
/// [`spawn_session`] dispatches on. Serialized lowercase to match the front's
/// `conv.kind` (`"claude"` | `"codex"`). Defaults to Claude (the app's default backend
/// and what a conversation with no explicit kind resolves to).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Claude,
    Codex,
}

fn unknown_session() -> String {
    "unknown session".to_string()
}

/// Now, as Unix milliseconds. Used to stamp records the store persists.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Spawn-time choices that can only be applied when the process starts, bundled into one
/// argument. They travel together because they share that property — and because specta
/// caps a command at 10 parameters, which [`spawn_session`] had already reached.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpawnFlags {
    /// Ultracode (standing workflow orchestration, at any effort). Not a spawn flag of
    /// its own: the session re-enables it over the control channel after `initialize`.
    pub ultracode: bool,
    /// UNLOCKS `bypassPermissions` as a selectable mode for this process without turning
    /// it on (Settings → General → Permissions).
    pub allow_bypass_permissions: bool,
    /// Advertise the in-process "flightdeck" MCP server to this session (Settings →
    /// Control), giving its agent the app-piloting tools.
    pub app_control: bool,
    /// Which Claude account to authenticate as; `None` = the default, un-scoped store.
    pub claude_account_id: Option<String>,
    /// The conversation's CURRENT title (C9), so a REMOTE spawn's `attach --title`
    /// carries it from the very first attach — see
    /// [`crate::supervisor::transport::SpawnConfig::conversation_title`]. Ignored for
    /// a local conversation (Claude has no daemon-side title). The front omits this
    /// (or sends `None`) for a conversation that is still on its placeholder name, so
    /// an untitled conversation never stamps that placeholder as the daemon's
    /// authoritative title (see `spawn_session`'s wiring).
    pub conversation_title: Option<String>,
    /// This conversation's own overrides (MCP rules + plugin on/off), re-applied to the new
    /// process right after `initialize` (they live in its flag settings layer, which dies
    /// with the previous one). Claude only; `None`/empty = nothing of its own.
    #[serde(default)]
    pub session_overrides: Option<crate::supervisor::model::SessionOverrides>,
    /// Opt this process in to prompt suggestions (Settings → Conversation → Composer):
    /// after each turn the binary predicts the user's next message, shown as ghost text
    /// in the composer. Claude only; ignored for Codex, which has no equivalent.
    #[serde(default)]
    pub prompt_suggestions: bool,
    /// The paired server this conversation's FOLDER lives on (`Repo.machineId`); `None` =
    /// this Mac. A folder is the pair (machine, path), so the spawn takes both halves from
    /// the caller instead of guessing the machine from the path: two folders can share a
    /// path (a local clone and a server one, or two servers), and the path alone used to
    /// route a LOCAL conversation over SSH. An id naming no paired server is refused.
    #[serde(default)]
    pub machine_id: Option<String>,
    /// The conversation's STABLE id. A remote spawn uses it to re-join the flightdeckd
    /// conversation this conversation ran under last time (persisted per conversation — see
    /// `Store::remote_attach_conversation`), and to keep that record current when an attach
    /// lands elsewhere. `None` (an older caller) = a fresh daemon conversation id, the
    /// previous behaviour. Unused for a local conversation.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// The SSH target a remote spawn connects to, built from the server it must run on (see
/// [`remote_machine_for_spawn`]). Pure, so "the spawn reaches the machine it was given" is
/// unit-tested without an ssh round trip.
fn remote_target_for(
    machine: MachineRecord,
    known_hosts_file: Option<String>,
) -> crate::supervisor::transport::RemoteTarget {
    let addresses = remote_target_addresses(&machine.host, machine.addresses);
    crate::supervisor::transport::RemoteTarget {
        host: machine.host,
        port: machine.port,
        user: machine.user,
        identity_file: machine.identity_file,
        known_hosts_file,
        daemon_bin: std::env::var("TOSSE_REMOTE_FLIGHTDECKD_BIN")
            .unwrap_or_else(|_| "flightdeckd".to_string()),
        addresses,
        // Which machine row `host` came from, so a later successful address
        // rotation (A6) knows what to persist the winning address back to.
        machine_id: Some(machine.id),
    }
}

/// The paired server a spawn must run on: `None` for a local folder (no `machine_id`),
/// the server's record otherwise. An id the store cannot place (the server was removed
/// meanwhile) and a store read error are both REFUSED rather than read as "local" — that
/// fallback is exactly how a remote conversation would end up running on this Mac.
fn remote_machine_for_spawn(store: &Store, machine_id: Option<&str>) -> Result<Option<MachineRecord>, String> {
    let Some(id) = machine_id else { return Ok(None) };
    match store.machine_by_id(id) {
        Ok(Some(machine)) => Ok(Some(machine)),
        Ok(None) => Err("This conversation's server is no longer paired with Flight Deck.".to_string()),
        Err(e) => Err(format!("Couldn't read this conversation's server from the database: {e}")),
    }
}

/// The flightdeckd conversation a remote spawn asks to attach to: the one this conversation
/// ran under last time (`Store::remote_attach_conversation`), else a freshly minted id —
/// persisted at once, so a spawn whose attach never completes still re-asks for the same
/// one next time.
///
/// Why the persisted id matters: flightdeckd re-joins a running `claude` by conversation id
/// FIRST, by the session id we pass only second. With a fresh id every spawn, a re-join
/// rested on the session id alone — and when it changed while the Mac was away (a `/clear`
/// from the phone), the daemon cold-started a second `claude` on the old session next to
/// the one still running. Never fails the spawn: a store error is logged and falls back to
/// a fresh id, exactly the behaviour before this existed. No `conversation_id` (an older
/// caller) = a fresh id, unpersisted.
fn daemon_conversation_for_spawn(
    store: &Store,
    conversation_id: Option<&str>,
    mint: impl FnOnce() -> String,
) -> String {
    let Some(conv) = conversation_id else {
        return mint();
    };
    match store.remote_attach_conversation(conv) {
        Ok(Some(known)) => return known,
        Ok(None) => {}
        Err(e) => eprintln!("[ipc] couldn't read the daemon conversation of {conv}: {e}"),
    }
    let fresh = mint();
    match store.set_remote_attach_conversation(conv, &fresh) {
        Ok(0) => eprintln!(
            "[ipc] daemon conversation of {conv} not recorded yet: no conversation row (a send racing its \
             creation) — the session's first attach records it again"
        ),
        Ok(_) => {}
        Err(e) => eprintln!("[ipc] couldn't record the daemon conversation of {conv}: {e}"),
    }
    fresh
}

/// Start a new `claude` session rooted at `repo_path`, applying this conversation's
/// controls (model / effort / permission mode / ultracode) at spawn so the live
/// stream starts in EXACTLY the state the UI shows — never the old hardcoded
/// defaults. Returns our session id; conversation/state/permission events are
/// emitted on the Tauri event bus.
///
/// `allow_bypass_permissions` carries the user's app-wide opt-in (Settings → General →
/// Permissions): it UNLOCKS `bypassPermissions` as a selectable mode for this process
/// without turning it on. It can only be decided at spawn — a live session cannot gain
/// it — so the front end restarts, or greys out the choice, accordingly.
///
/// `app_control` (Settings → Control) exposes the in-process "flightdeck" MCP server
/// to THIS session: its agent gains the app-piloting tools (open files, create/message
/// conversations, …). Claude-only (Codex has no SDK-server channel) and, like the
/// bypass unlock, decided at spawn — the `initialize` handshake advertises it once.
///
/// `claude_account_id` (inside [`SpawnFlags`]) picks WHICH Claude account the process runs
/// on — `None` is the CLI's own, un-scoped credential store, i.e. the unchanged
/// single-account behaviour. Like the two flags above it can only be decided at spawn: the
/// CLI reads its credentials once at startup, so changing account means re-spawning with
/// `--resume` (safe — the account scopes only the credential store, never the transcript).
#[tauri::command]
#[specta::specta]
pub async fn spawn_session(
    app: tauri::AppHandle,
    repo_path: String,
    resume: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    backend: Backend,
    flags: SpawnFlags,
) -> Result<String, String> {
    let SpawnFlags {
        ultracode,
        allow_bypass_permissions,
        app_control,
        claude_account_id,
        conversation_title,
        session_overrides,
        prompt_suggestions,
        machine_id,
        conversation_id,
    } = flags;
    if let Some(o) = &session_overrides {
        o.validate()?;
    }
    // A conversation opened in a REMOTE folder launches its `claude` on that server over
    // SSH instead of locally. Resolved from the machine id the caller names (see
    // `SpawnFlags::machine_id`), never from the path. Both failures refuse the spawn: a
    // remote conversation that quietly started on this Mac would run in whatever folder
    // happens to sit at the same path here.
    let remote_machine = remote_machine_for_spawn(&app.state::<Store>(), machine_id.as_deref())?;
    // Resolved through the AppHandle rather than a `State` param: specta caps a
    // command at 10 parameters and `app_control` used the last slot.
    let sessions = app.state::<Sessions>();
    let id = sessions.next_id();
    let mut cfg = SpawnConfig::new(PathBuf::from(repo_path));
    cfg.resume = resume;
    cfg.allow_bypass_permissions = allow_bypass_permissions;
    // Held from resolving the account slot until the session is REGISTERED below, so a
    // concurrent account removal either runs before we resolve (→ "unknown account" here)
    // or sees this session in the registry and refuses. Nothing below awaits, so a queued
    // removal waits only for this synchronous spawn. See `accounts::ACCOUNT_LIFECYCLE`.
    let _account_use = crate::accounts::account_use_guard().await;
    // Which Claude account this process authenticates as. An id naming an account the
    // user has since removed must NOT silently fall back to another identity: resolving
    // is fallible and the error names the id, so the UI can say why the session refused
    // to start instead of quietly burning the wrong account's quota. The composer remedy
    // is added here, where it is the right advice (the helper stays context-neutral).
    cfg.claude_account = claude_slot(&app, claude_account_id.as_deref()).map_err(|e| {
        format!("{e} — this conversation is tied to an account that no longer exists; pick another one in the composer")
    })?;
    // Product defaults when unset: newest Opus + Extra (xhigh) effort + Auto (`auto`)
    // permission mode. The mode is ALWAYS passed explicitly (the binary's own default
    // without the flag has moved between releases — 2.1.293 reports `default`), and
    // `auto` matches the front-end seed `DEFAULT_PERMISSION_MODE` so a new conversation,
    // the persisted null fallback, and the live session all agree.
    // An unknown/invalid effort falls back to xhigh (the CLI would otherwise swallow
    // it silently). "ultracode" is NOT a spawn flag — the spawn carries the effort and
    // the session re-enables the ultracode flag after init (`InitialControls`).
    let effort = effort
        .filter(|e| control::is_valid_effort_level(e))
        .unwrap_or_else(|| "xhigh".into());
    // The `opus` alias, which the binary resolves to the LATEST Opus — the default
    // follows each release on its own. Mirrors the front-end seed `DEFAULT_MODEL`.
    cfg.model = Some(model.unwrap_or_else(|| "opus".into()));
    cfg.effort = Some(effort);
    // A persisted `bypassPermissions` is demoted to `default` when the unlock flag is
    // off (e.g. the user turned the Settings toggle back off while a conversation still
    // had bypass selected). Load-bearing: the CLI would otherwise RUN the spawn flag's
    // bypass without the unlock (see `permission_mode_for_spawn`). Local and remote
    // alike — a remote spawn sends this same argv to the server's daemon.
    cfg.permission_mode = Some(
        control::permission_mode_for_spawn(
            &permission_mode.unwrap_or_else(|| "auto".into()),
            allow_bypass_permissions,
        )
        .to_string(),
    );
    // Route this session to its remote server when the repo is remote. Claude-only for
    // now: the Codex backend has its own local-only transport, so a "remote" Codex
    // conversation would silently run on THIS Mac — refuse it loudly instead.
    let is_remote = remote_machine.is_some();
    if let Some(machine) = remote_machine {
        if matches!(backend, Backend::Codex) {
            return Err("Remote (SSH) conversations are Claude-only for now.".to_string());
        }
        // The slot is an environment variable on a LOCAL child; `build_remote_command`
        // exports nothing of the sort, so the daemon's `claude` authenticates with the
        // SERVER's own credential store. Accepting an account here would run the session
        // on one identity while the UI (and `claude_handles_for`, and the usage ring)
        // claimed another — refuse it instead of quietly lying about which plan is paying.
        if claude_account_id.is_some() {
            return Err(
                "Remote (SSH) conversations run on the server's own Claude account — \
                 set this conversation back to the default account."
                    .to_string(),
            );
        }
        // A `MachineRecord` on disk could predate `validate_ssh_user`/`validate_ssh_port`
        // (an older app version, or a manual DB edit) — refuse here, BEFORE this
        // `RemoteTarget` is built or any of the ssh round trips below run, with a clear,
        // typed, actionable error rather than letting an invalid value ride all the way
        // to `Transport::spawn`'s own (later, lazy) last-resort check. The machine row
        // itself is untouched and stays listed — see `crate::store::validate_ssh_user`'s
        // doc (CRM holistic-review blocker #3, chantier A `bd7ca709`). The error text
        // deliberately omits the underlying validator's message (which embeds the raw
        // offending value) — same discipline as `TransportError::InvalidRemoteTarget`'s
        // `Display` impl.
        if validate_ssh_user(&machine.user).is_err() {
            return Err("This server's saved user name is not valid — remove and re-add it.".to_string());
        }
        if validate_address_value(&machine.host).is_err() {
            return Err("This server's saved address is not valid — remove and re-add it.".to_string());
        }
        if crate::store::validate_ssh_port(machine.port).is_err() {
            return Err("This server's saved port is not valid — remove and re-add it.".to_string());
        }
        // A dedicated known_hosts under the app data dir, so pinning a server's host
        // key never touches the user's ~/.ssh/known_hosts.
        let known_hosts_file = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned());
        // D6: cheap, cached, best-effort gate for the reattach-replay compaction
        // (`--supports-skip`) — BEFORE `machine`'s fields are moved into
        // `RemoteTarget` below, since the probe needs the whole record (id + host +
        // port + user + identity_file). See `supports_skip_for_machine`'s doc for why
        // this can never block or fail the spawn.
        let supports_skip =
            supports_skip_for_machine(&machine, known_hosts_file.as_deref()).await;
        // C9: same discipline for `--title` — gated on the SAME cached probe (see
        // `daemon_version_for_machine`), never guessed. An untitled conversation
        // (the front omits `conversation_title` for its own placeholder name) sends
        // `None` either way, so `cfg.conversation_title` only ever carries a REAL
        // title through this gate.
        cfg.conversation_title = match &conversation_title {
            Some(title) if !title.trim().is_empty() => {
                if supports_title_for_machine(&machine, known_hosts_file.as_deref()).await {
                    Some(title.clone())
                } else {
                    None
                }
            }
            _ => None,
        };
        cfg.remote = Some(remote_target_for(machine, known_hosts_file));
        // The daemon-side conversation id: the one this conversation ran under last time,
        // else a pre-minted one (persisted at once). Either way retries are idempotent: if
        // the FIRST attach dies before its fd_attach handshake lands, the reconnect
        // presents the same id and re-joins the same daemon conversation instead of
        // cold-starting a duplicate (and leaking a claude process server-side). And a
        // re-join targets THAT conversation even when the server's session id changed
        // since (see `daemon_conversation_for_spawn`). Still `epoch: None, cursor: 0`:
        // the store holds no history to resume from, so the whole ring is wanted.
        let daemon_conversation = daemon_conversation_for_spawn(
            &app.state::<Store>(),
            conversation_id.as_deref(),
            || uuid::Uuid::new_v4().to_string(),
        );
        // What an earlier actor of this conversation already showed, in this app run: tells
        // the news in that whole-history replay apart, and whether the process it left running
        // is still the one (see `PriorView`).
        let prior = crate::supervisor::session::prior_view_for(&daemon_conversation);
        cfg.attach = Some(crate::supervisor::transport::AttachPoint {
            conversation: Some(daemon_conversation),
            epoch: None,
            cursor: 0,
            supports_skip,
            prior,
        });
    }
    let initial = InitialControls {
        model: cfg.model.clone(),
        effort: cfg.effort.clone(),
        permission_mode: cfg.permission_mode.clone(),
        ultracode,
        session_overrides,
        prompt_suggestions,
    };
    let emitter = Arc::new(TauriEmitter { app: app.clone(), conversation_id: conversation_id.clone() });
    // When the actor fully exits (process gone / stopped), evict the dead handle
    // from the registry so entries never leak.
    let on_exit = {
        let app = app.clone();
        let id = id.clone();
        Box::new(move || {
            app.state::<Sessions>().remove(&id);
        }) as Box<dyn FnOnce() + Send + 'static>
    };
    // The ONE backend-specific point: which actor to start. Everything above (config,
    // control defaults, emitter, on_exit) and everything downstream (send / interrupt /
    // stop / … resolve a `SessionHandle` and push a `SessionCommand`) is backend-neutral.
    let handle = match backend {
        Backend::Codex => {
            // The shared app-server is Tauri-managed as an Arc so the actor can hold it
            // beyond this command's lifetime.
            let server: Arc<CodexServer> = (*app.state::<Arc<CodexServer>>()).clone();
            codex::spawn_session(id.clone(), cfg, initial, emitter, on_exit, server)
        }
        Backend::Claude => {
            // Hand the app-control hub to sessions that expose the in-process MCP
            // server; `None` keeps the wire identical to the pre-MCP client.
            // Remote sessions never get it: their claude runs detached on the
            // server — an mcp_message arriving while no Mac is attached would
            // hang the tool call there with nobody to answer it.
            let appmcp = (app_control && cfg.remote.is_none())
                .then(|| (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone());
            session::spawn_session(id.clone(), cfg, initial, emitter, on_exit, appmcp)
        }
    }
    .map_err(|e| e.to_string())?;
    // Remember WHICH account this process authenticated as, so a later `get_usage` is only
    // ever aimed at a session that can answer for the account being asked about. Codex
    // sessions have no Claude account: record `None` and let the backend filter do the rest.
    // A remote session is flagged as such: it authenticates on the SERVER, so it answers for
    // no account of this Mac, the default one included (see `claude_handles_for`).
    sessions.insert(
        id.clone(),
        backend,
        handle,
        match backend {
            // A remote session is refused above unless its account is None.
            Backend::Claude if !is_remote => claude_account_id,
            _ => None,
        },
        is_remote,
    );
    Ok(id)
}

/// Whether a usable `codex` binary is installed on this machine. Gates the Codex
/// backend selector in the UI so "new Codex conversation" is only offered when the
/// CLI is present. Cheap: a `PATH` / well-known-location file check, never a spawn.
#[tauri::command]
#[specta::specta]
pub fn codex_available() -> bool {
    crate::supervisor::codex::codex_available()
}

/// This Mac's name as the user knows it — the "Computer Name" of System Settings → General →
/// Sharing (`scutil --get ComputerName`, e.g. « MacBook Pro d'Alexandre »), else the host name.
/// For the conversation side panel's Machine row, which says WHERE a local conversation runs.
/// Read once per app run (a machine is not renamed under a running app often enough to poll),
/// off the main thread. `None` only when neither can be read — the row then says « This Mac ».
#[tauri::command]
#[specta::specta]
pub async fn local_machine_name() -> Option<String> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    if let Some(name) = NAME.get() {
        return name.clone();
    }
    let name = tokio::task::spawn_blocking(read_local_machine_name).await.ok().flatten();
    NAME.get_or_init(|| name).clone()
}

/// The host names this Mac answers to, for telling a paired machine that IS this Mac (a loopback
/// pairing — see `store::db::is_this_mac_host`). `gethostname` only: a syscall, no process, so it
/// is cheap enough to ask at every launch. Empty when it can't be read (only the `localhost` /
/// loopback-address forms are then recognized).
pub(crate) fn this_mac_host_names() -> Vec<String> {
    let mut buf = [0u8; 256];
    // SAFETY: as in `read_local_machine_name` — the buffer outlives the call and its length is
    // passed; gethostname writes a NUL-terminated name within it (or truncates).
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return Vec::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    if name.is_empty() { Vec::new() } else { vec![name] }
}

/// The login this app runs under (`getpwuid(getuid())`), for telling a loopback pairing under
/// THIS login (its daemon's transcripts are in our `~/.claude`) from one under another login
/// (`deploy@localhost` — another home). `None` when it can't be read.
pub(crate) fn this_mac_login() -> Option<String> {
    // SAFETY: getuid cannot fail; getpwuid returns NULL or a pointer to a static record whose
    // `pw_name` is a NUL-terminated string — copied out at once, before any other passwd call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_name.is_null() {
            return None;
        }
        let name = std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().trim().to_string();
        (!name.is_empty()).then_some(name)
    }
}

fn read_local_machine_name() -> Option<String> {
    let clean = |s: &str| {
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    };
    let computer_name = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| clean(&String::from_utf8_lossy(&o.stdout)));
    computer_name.or_else(|| {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed; gethostname writes a
        // NUL-terminated name within it (or truncates) and reports failure through its return.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        // A host name reads better without its local-network suffix (« alex-mbp.local »).
        clean(String::from_utf8_lossy(&buf[..end]).trim_end_matches(".local"))
    })
}

/// Whether a usable `claude` binary is installed on this machine. Powers the proactive
/// "Claude CLI not found" surfaces (composer bar + Settings → Accounts) so the absence
/// is shown BEFORE the first message fails — the twin of [`codex_available`]. Cheap: a
/// `PATH` / well-known-location file check, never a spawn.
#[tauri::command]
#[specta::specta]
pub fn claude_available() -> bool {
    crate::supervisor::transport::claude_available()
}

/// List the Codex models the installed binary offers (`model/list`), for the composer's
/// unified picker (its Codex section) + the data-driven effort gauge. Runs against a
/// transient app-server (no conversation needed), so it works before any Codex chat.
#[tauri::command]
#[specta::specta]
pub async fn codex_list_models() -> Result<Vec<codex::CodexModel>, String> {
    codex::list_models().await.map_err(|e| e.to_string())
}

/// List the Codex skills for the given working directories (`skills/list`), for the
/// composer's `/` menu on a Codex conversation. `cwds` empty → the server default.
#[tauri::command]
#[specta::specta]
pub async fn codex_list_skills(cwds: Vec<String>) -> Result<Vec<codex::CodexSkill>, String> {
    codex::list_skills(cwds).await.map_err(|e| e.to_string())
}

/// Compact a live Codex conversation's context (`thread/compact/start`). The Claude
/// backend has no equivalent command — it compacts via the plain `/compact` text turn —
/// so the composer only calls this for a Codex conversation. Errors "unknown session"
/// when the conversation has no live app-server thread (the ring is only interactive
/// after the first turn, so in practice a thread exists).
#[tauri::command]
#[specta::specta]
pub async fn codex_compact(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.compact().await.map_err(|e| e.to_string())
}

// Native Codex rewind/fork/archive. `codex_fork` powers BOTH the "fork here" (a new branch
// conversation) and the "rewind here" (fork + swap the current conversation onto the branch)
// controls: Codex has no in-place history truncation, and `thread/rollback` was DEPRECATED in
// codex-cli 0.144.1, so both go through `thread/fork` cut at a `last_turn_id` turn boundary
// (inclusive). `codex_archive` cleans up a discarded thread. Each `Err` is mapped to a String
// so the caller always surfaces it (never a silent failure).

/// Fork a Codex conversation into a NEW branch (`thread/fork`, cut at `last_turn_id` —
/// forks THROUGH that turn, inclusive, so the branch ends AT the chosen boundary; `None`
/// forks the whole thread). Non-destructive: the source thread is left intact. Returns the
/// new thread id + resolved model, which the front materializes as a fresh Codex conversation
/// (a branch) or swaps the current conversation onto (an in-place rewind). No live session
/// needed (loaded from disk by id). Like the Claude rewind, it does NOT revert on-disk file
/// changes — history only.
#[tauri::command]
#[specta::specta]
pub async fn codex_fork(
    thread_id: String,
    cwd: String,
    model: Option<String>,
    last_turn_id: Option<String>,
) -> Result<codex::CodexForkResult, String> {
    codex::fork_thread(&thread_id, std::path::Path::new(&cwd), model.as_deref(), last_turn_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Archive a Codex conversation's thread (`thread/archive`) — the backend-native cleanup the
/// front WILL run when a Codex conversation is discarded (the Claude backend just leaves its
/// transcript on disk). NOT yet wired to the delete path (see the note above); when it is, a
/// failure will be surfaced by the caller, never silently dropped.
#[tauri::command]
#[specta::specta]
pub async fn codex_archive(thread_id: String, cwd: String) -> Result<(), String> {
    codex::archive_thread(&thread_id, std::path::Path::new(&cwd))
        .await
        .map_err(|e| e.to_string())
}

/// Rebuild a Codex conversation's history from its on-disk ROLLOUT — the Codex analogue
/// of [`load_session_history`]. Codex rendering is otherwise LIVE-only (a resumed thread
/// re-streams nothing), so a cold-opened Codex conversation would show a blank thread.
/// The front calls this (keyed on `conv.kind === "codex"`) after selecting a Codex
/// conversation to replay its full timeline — messages AND tool cards — with no
/// app-server spawned (the rollout has full tool fidelity; `thread/resume` omits tools).
/// `thread_id` is the conversation's persisted `sessionId`. An absent rollout yields an
/// empty list (not an error). File IO runs off the async runtime via `spawn_blocking`.
#[tauri::command]
#[specta::specta]
pub async fn codex_load_history(thread_id: String) -> Result<Vec<ConversationItem>, String> {
    tokio::task::spawn_blocking(move || codex::load_thread_history(&thread_id))
        .await
        .map_err(|e| e.to_string())
}

/// List the CONFIGURED Codex extensions (declared MCP servers + installed plugins +
/// on-disk skills), read from `~/.codex/config.toml` + `~/.codex/skills` — plus the
/// repository's own `<cwd>/.codex/skills` when `cwd` is given — as the SAME
/// `ExtensionsSnapshot` shape the Claude side uses so the Extensions view renders a Codex
/// segment with the shared primitives. Secret-bearing fields are never surfaced (whitelist
/// parse). Skill rows carry their `[[skills.config]]` toggle state; MCP rows their
/// `enabled` flag. Best-effort; the blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn codex_list_extensions(
    cwd: Option<String>,
) -> Result<crate::extensions::ExtensionsSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        codex::list_extensions(cwd.as_deref().map(std::path::Path::new))
    })
    .await
    .map_err(|e| e.to_string())
}

// ── Extensions v2 (Codex) — toggles + live inventories. Every mutation goes through
// the BINARY's own config writer (surgical TOML edit, secrets/comments preserved);
// every read is mapped through whitelisted structs (no raw wire Value crosses the IPC).

/// Enable/disable a Codex SKILL (`skills/config/write`). `path` is the skill's
/// `SKILL.md` (as carried by the snapshot rows); returns the server-resolved state.
#[tauri::command]
#[specta::specta]
pub async fn codex_set_skill_enabled(path: String, enabled: bool) -> Result<bool, String> {
    codex::extensions::set_skill_enabled(&path, enabled)
        .await
        .map_err(|e| e.to_string())
}

/// Enable/disable a Codex MCP server (`config/value/write` on
/// `mcp_servers.<name>.enabled`, then `config/mcpServer/reload`). Resolves to whether
/// the LIVE sessions picked the change up — `false` means the config was written but
/// the live reload failed (it applies on the next spawn); the front surfaces that as
/// a non-blocking warning instead of showing a state the live sessions don't have.
#[tauri::command]
#[specta::specta]
pub async fn codex_set_mcp_enabled(
    app: tauri::AppHandle,
    name: String,
    enabled: bool,
) -> Result<bool, String> {
    // The reload half must reach the SHARED server (the live conversations' process),
    // not just the transient writer — resolved from managed state like spawn_session.
    let shared: Arc<CodexServer> = (*app.state::<Arc<CodexServer>>()).clone();
    codex::extensions::set_mcp_enabled(&name, enabled, &shared)
        .await
        .map_err(|e| e.to_string())
}

/// Enable/disable a Codex PLUGIN (`config/value/write` on `plugins."<id>".enabled`).
#[tauri::command]
#[specta::specta]
pub async fn codex_set_plugin_enabled(plugin_id: String, enabled: bool) -> Result<(), String> {
    codex::extensions::set_plugin_enabled(&plugin_id, enabled)
        .await
        .map_err(|e| e.to_string())
}

/// The authoritative INSTALLED Codex plugin inventory (`plugin/installed`) — richer
/// than the config snapshot (bundled/runtime plugins, versions, display metadata,
/// marketplace grouping). `cwds` lets repo-scoped marketplaces be discovered.
#[tauri::command]
#[specta::specta]
pub async fn codex_list_plugins(cwds: Vec<String>) -> Result<codex::CodexPluginsLive, String> {
    codex::extensions::list_plugins_live(cwds)
        .await
        .map_err(|e| e.to_string())
}

/// Everything ONE Codex plugin provides (`plugin/read`), as the SAME `PluginContents`
/// shape the Claude explorer drills into. `marketplace_path` comes from the live
/// inventory row; `plugin_id` tags the provenance on the returned items.
#[tauri::command]
#[specta::specta]
pub async fn codex_plugin_contents(
    plugin_name: String,
    marketplace_path: Option<String>,
    plugin_id: String,
) -> Result<crate::extensions::PluginContents, String> {
    codex::extensions::plugin_contents(&plugin_name, marketplace_path, &plugin_id)
        .await
        .map_err(|e| e.to_string())
}

/// The Codex hooks visible from `cwds` (`hooks/list`) — read-only view (Codex exposes
/// no hook-toggle RPC); scan warnings/errors are surfaced alongside.
#[tauri::command]
#[specta::specta]
pub async fn codex_list_hooks(cwds: Vec<String>) -> Result<codex::CodexHooksSnapshot, String> {
    codex::extensions::list_hooks(cwds).await.map_err(|e| e.to_string())
}

/// Register a Codex marketplace (`marketplace/add` — git URL / owner-repo / local path).
#[tauri::command]
#[specta::specta]
pub async fn codex_marketplace_add(source: String) -> Result<(), String> {
    codex::extensions::marketplace_add(&source).await.map_err(|e| e.to_string())
}

/// Unregister a Codex marketplace by name (`marketplace/remove`).
#[tauri::command]
#[specta::specta]
pub async fn codex_marketplace_remove(name: String) -> Result<(), String> {
    codex::extensions::marketplace_remove(&name).await.map_err(|e| e.to_string())
}

/// Refresh a Codex marketplace's pinned content (`marketplace/upgrade`; `None` → all).
#[tauri::command]
#[specta::specta]
pub async fn codex_marketplace_upgrade(name: Option<String>) -> Result<(), String> {
    codex::extensions::marketplace_upgrade(name).await.map_err(|e| e.to_string())
}

// ── Accounts (Claude & Codex) — status / login / logout in-app. The credential stores
// stay OWNED by the CLIs (`claude auth`, `codex app-server account/*`): the app never
// reads/writes `~/.claude/.credentials.json`, the Keychain item, or `~/.codex/auth.json`.
//
// Claude supports SEVERAL accounts. Each one is a `crate::accounts::AccountSlot` — an
// isolated credential store, scoped by an environment variable on the `claude` child, that
// leaves the shared `~/.claude` (transcripts, settings, plugins, skills, MCP) untouched.
// `account_id: None` everywhere below means the CLI's own un-scoped store: the account the
// user already had, whose behaviour is unchanged.

/// Resolve an optional account id to the slot to drive. A `Some(id)` naming an account
/// that no longer exists is an ERROR, never a silent fall back to the default: quietly
/// switching identity would spend the wrong subscription's quota with nothing shown.
fn claude_slot(
    app: &tauri::AppHandle,
    account_id: Option<&str>,
) -> Result<crate::accounts::AccountSlot, String> {
    let Some(id) = account_id else {
        return Ok(crate::accounts::AccountSlot::default_slot());
    };
    if id == crate::accounts::DEFAULT_ACCOUNT_ID {
        return Ok(crate::accounts::AccountSlot::default_slot());
    }
    let known = app
        .state::<Store>()
        .list_claude_accounts()
        .map_err(|e| format!("could not read the Claude accounts: {e}"))?;
    if !known.iter().any(|a| a.id == id) {
        // Context-NEUTRAL and naming the id: this helper also backs the Settings-side
        // status / login / logout / capture commands, where composer wording would be
        // nonsense. Each caller appends its own remedy.
        return Err(format!("unknown Claude account {id}"));
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir available: {e}"))?;
    crate::accounts::AccountSlot::for_account(&data_dir, id)
}

/// The Claude accounts the user added, in display order. The default account is NOT in
/// this list — it always exists and the UI renders it from `account_claude_status(None)`.
#[tauri::command]
#[specta::specta]
pub async fn claude_accounts_list(
    store: tauri::State<'_, Store>,
) -> Result<Vec<crate::store::ClaudeAccountRecord>, String> {
    store
        .list_claude_accounts()
        .map_err(|e| format!("could not read the Claude accounts: {e}"))
}

/// Register a NEW Claude account: mints its id, creates its isolated credential store and
/// persists the row. Signing in is a separate step (`account_claude_login_start` with this
/// id) — an account exists as an empty, signed-out slot until then, which is exactly what
/// the UI shows.
#[tauri::command]
#[specta::specta]
pub async fn claude_account_create(
    app: tauri::AppHandle,
    label: String,
) -> Result<crate::store::ClaudeAccountRecord, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir available: {e}"))?;
    let store = app.state::<Store>();
    let existing = store
        .list_claude_accounts()
        .map_err(|e| format!("could not read the Claude accounts: {e}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let slot = crate::accounts::AccountSlot::for_account(&data_dir, &id)?;
    slot.ensure_dir()?;
    let label = label.trim();
    let record = crate::store::ClaudeAccountRecord {
        id,
        label: if label.is_empty() {
            // `+ 2`: the default account always exists and has no row, so the first ADDED
            // account is the user's second one ("Account 2").
            format!("Account {}", existing.len() + 2)
        } else {
            label.to_string()
        },
        email: None,
        org_name: None,
        subscription_type: None,
        sort_index: existing.iter().map(|a| a.sort_index).max().unwrap_or(0) + 1,
        added_at: now_ms(),
        // Only a placeholder may later be replaced by the captured email.
        label_is_generated: label.is_empty(),
    };
    store
        .upsert_claude_account(&record)
        .map_err(|e| format!("could not save the Claude account: {e}"))?;
    Ok(record)
}

/// Where the DEFAULT account's captured identity is stored. It has no row of its own (it is
/// the CLI's store, not one the app created), so it lives as one `meta` entry.
const DEFAULT_IDENTITY_KEY: &str = "claude_default_identity";

/// The non-sensitive identity of a Claude account — never a token.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeIdentity {
    pub email: Option<String>,
    pub org_name: Option<String>,
    pub subscription_type: Option<String>,
}

/// The DEFAULT account's identity as captured at ITS OWN sign-in, or `null` if it was never
/// captured (it was signed in outside the app, or before this existed).
///
/// ⚠️ It cannot be read live once a second account exists: `claude auth status` answers from
/// a profile cache every account SHARES, so it would name whichever account signed in last.
/// The UI shows this stored value instead of a plausible-looking wrong address.
#[tauri::command]
#[specta::specta]
pub async fn claude_default_identity(
    store: tauri::State<'_, Store>,
) -> Result<Option<ClaudeIdentity>, String> {
    let raw = store
        .get_config(DEFAULT_IDENTITY_KEY)
        .map_err(|e| format!("could not read the default account's identity: {e}"))?;
    // A stored value that no longer parses is a real failure, not "never captured": folding
    // it into `None` would silently drop the identity and relabel the account as unknown.
    raw.map(|s| {
        serde_json::from_str(&s).map_err(|e| {
            format!(
                "the default account's saved identity is corrupt ({e}) — sign the default \
                 account in again to capture it afresh"
            )
        })
    })
    .transpose()
}

/// One Claude account's identity — address, organization, plan — read with ITS OWN token
/// (see `usage::profile`). This is what the UI names every account by: unlike
/// `claude auth status`, whose profile cache all accounts share, it cannot answer with
/// another account's address. `account_id: None` = the default account.
#[tauri::command]
#[specta::specta]
pub async fn claude_account_identity(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<crate::usage::profile::AccountProfile, UsageError> {
    let slot = claude_slot(&app, account_id.as_deref()).map_err(|detail| {
        // Same typing as the usage command: a removed account is permanent, not a blip.
        match account_id.clone() {
            Some(id) if detail.starts_with("unknown Claude account") => {
                UsageError::UnknownAccount { account_id: id }
            }
            _ => UsageError::Network { detail },
        }
    })?;
    crate::usage::profile::fetch_profile_for(&slot).await
}

/// Capture an account's identity from the CLI RIGHT AFTER it signed in, and persist it as
/// non-sensitive metadata (never a token). `account_id: None` captures the DEFAULT account.
///
/// ⚠️ This is deliberately a separate, post-login step. `claude auth status` reads
/// `email`/`orgName` from a profile cache living in the CONFIG dir, which every account
/// SHARES — so the answer is only reliably about THIS account in the moment just after its
/// own login wrote that cache. Persisting it here is what lets the Accounts panel keep naming
/// each account by its address afterwards. Best-effort by design: a failure leaves the
/// previous identity in place rather than blocking a successful sign-in.
#[tauri::command]
#[specta::specta]
pub async fn claude_account_capture_identity(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<(), String> {
    // Held until the row is written: `upsert_claude_account` after a concurrent removal's
    // delete would RESURRECT the removed account. See `accounts::ACCOUNT_LIFECYCLE`.
    let _account_use = crate::accounts::account_use_guard().await;
    let slot = claude_slot(&app, account_id.as_deref())?;
    let status = crate::accounts::status(&slot).await?;
    let store = app.state::<Store>();

    // The default account keeps its identity in `meta`: it has no row, and creating one would
    // make it show up among the accounts the user added.
    let Some(account_id) = account_id.filter(|id| id != crate::accounts::DEFAULT_ACCOUNT_ID) else {
        let identity = ClaudeIdentity {
            email: status.email,
            org_name: status.org_name,
            subscription_type: status.subscription_type,
        };
        let json = serde_json::to_string(&identity)
            .map_err(|e| format!("could not encode the default account's identity: {e}"))?;
        return store
            .set_config(DEFAULT_IDENTITY_KEY, &json)
            .map_err(|e| format!("could not save the default account's identity: {e}"));
    };

    let mut accounts = store
        .list_claude_accounts()
        .map_err(|e| format!("could not read the Claude accounts: {e}"))?;
    let Some(record) = accounts.iter_mut().find(|a| a.id == account_id) else {
        return Err("this Claude account no longer exists".into());
    };
    // The label follows the captured address while it is still the generated placeholder (a
    // recorded fact, not a guess from its text) — see `apply_captured_identity`. The UI names
    // accounts by `email`; the label is only the fallback until one is captured.
    record.apply_captured_identity(status.email, status.org_name, status.subscription_type);
    let record = record.clone();
    store
        .upsert_claude_account(&record)
        .map_err(|e| format!("could not save the Claude account: {e}"))?;
    Ok(())
}

/// Remove an account: sign its credential store out through the CLI, drop its directory,
/// then delete the row (which detaches the conversations that used it, so they fall back to
/// the default account rather than pointing at nothing).
///
/// ⚠️ The sign-out is NOT best-effort, and the order matters. On macOS the credentials live
/// in a Keychain item whose name is derived from the slot's DIRECTORY PATH, and that path
/// contains the account id we are about to delete — so once the row and the directory are
/// gone, the item can no longer be addressed by us or by the CLI: the OAuth tokens would
/// stay in the Keychain, valid and unrevokable. A failed `claude auth logout` (an
/// unresolvable `claude` binary, a non-zero exit, the 15 s timeout) therefore ABORTS the
/// removal with the row intact, so the user can retry — rather than silently orphaning a
/// live credential.
///
/// `force` is the escape hatch for an account whose CLI sign-out can never succeed. It
/// proceeds anyway and RETURNS the exact Keychain item name, so the user can revoke it by
/// hand in Keychain Access instead of being left with no way at all.
#[tauri::command]
#[specta::specta]
pub async fn claude_account_remove(
    app: tauri::AppHandle,
    account_id: String,
    force: bool,
) -> Result<Option<String>, String> {
    // EXCLUSIVE for the whole check → sign-out → delete sequence. Every path that resolves a
    // slot and then uses it (spawn, sign-in start, identity capture) holds the shared side
    // until its use is visible — a registered session, an in-flight login, a written row — so
    // the checks below cannot be invalidated before the row is gone.
    // Lock order: ACCOUNT_LIFECYCLE (here) → ACTIVE_LOGIN → REDEEMING (in `sign_in_busy_for`);
    // the `Sessions` std mutex is only taken briefly, never across an await.
    let _removal = crate::accounts::account_removal_guard().await;
    let slot = claude_slot(&app, Some(&account_id))?;

    // A sign-in for this account — waiting for the pasted code, or redeeming it — would
    // write credentials into the directory we are about to delete (recreating it), under a
    // Keychain item nobody could address once the row is gone. Refuse; the user finishes or
    // cancels the sign-in first.
    if crate::accounts::sign_in_busy_for(Some(&account_id)).await {
        return Err(
            "a sign-in is in progress for this account — finish or cancel it before removing \
             the account"
                .into(),
        );
    }

    // A live session authenticated as this account would keep running against credentials
    // we are removing, and its handle records an id about to vanish. Refuse rather than
    // leave that inconsistency behind.
    if !app
        .state::<Sessions>()
        .claude_handles_for(Some(&account_id))
        .is_empty()
    {
        return Err(
            "a conversation is still running on this account — stop it before removing the \
             account"
                .into(),
        );
    }

    let mut warning = None;
    if let Err(e) = crate::accounts::logout(&slot).await {
        if !force {
            return Err(format!(
                "could not sign this account out ({e}). The account was kept so you can retry \
                 — removing it now would leave its credentials in the Keychain with no way to \
                 revoke them."
            ));
        }
        warning = Some(format!(
            "signed out failed ({e}) — its credentials may remain in the Keychain under the \
             item \"{}\"; remove it in Keychain Access to revoke them.",
            slot.keychain_service()
        ));
    }

    // Only now is it safe to drop the path the item name is derived from.
    if let Err(e) = slot.remove_dir() {
        warning = Some(match warning {
            Some(w) => format!("{w} · {e}"),
            None => e,
        });
    }
    app.state::<Store>()
        .delete_claude_account(&account_id)
        .map_err(|e| format!("could not remove the Claude account: {e}"))?;
    Ok(warning)
}

/// Point one conversation at a Claude account (`None` = the default account). Persisted, so
/// it survives a relaunch, a resume, a fork and a rewind. It takes effect at the
/// conversation's NEXT spawn — the caller is responsible for restarting the session if one
/// is live, and for telling the user so (a live process cannot change identity).
#[tauri::command]
#[specta::specta]
pub async fn set_conversation_claude_account(
    store: tauri::State<'_, Store>,
    conv_id: String,
    account_id: Option<String>,
) -> Result<(), String> {
    store
        .set_conversation_claude_account(&conv_id, account_id.as_deref())
        .map_err(|e| format!("could not save the conversation's Claude account: {e}"))
}

/// One Claude account's auth status (`claude auth status --json`), whitelisted.
/// `account_id: None` reads the default, un-scoped account.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_status(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<crate::accounts::ClaudeAccountStatus, String> {
    crate::accounts::status(&claude_slot(&app, account_id.as_deref())?).await
}

/// Start a Claude login for ONE account: spawns `claude auth login` scoped to its
/// credential store, returns the OAuth URL to open. The flow completes when the user pastes
/// the authorization code ([`account_claude_login_code`]) — or is dropped by
/// [`account_claude_login_cancel`].
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_start(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<String, String> {
    // Held until the login is registered (`login_start` returns only then), so a removal
    // either ran first (→ "unknown account") or sees this sign-in and refuses. The wait for
    // the pasted code happens AFTER this returns, guarded by `sign_in_busy_for` instead.
    let _account_use = crate::accounts::account_use_guard().await;
    let slot = claude_slot(&app, account_id.as_deref())?;
    crate::accounts::login_start(&slot, account_id).await
}

/// Submit the authorization code the user pasted; completes the in-flight Claude login.
///
/// `account_id` must name the account the flow was STARTED for. There is one global
/// in-flight login but one card per account, so a code pasted into a superseded card would
/// otherwise be redeemed into another account's credential store.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_code(
    account_id: Option<String>,
    code: String,
) -> Result<(), String> {
    crate::accounts::login_submit_code(account_id.as_deref(), &code).await
}

/// The Claude sign-in currently in flight. A struct rather than `Option<Option<String>>`:
/// serde flattens nested options, so "the DEFAULT account is signing in" (`Some(None)`) and
/// "nothing is signing in" (`None`) would both reach the front as `null` — exactly the
/// distinction a superseded card needs to close its code box.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginInFlight {
    /// The account the flow was started for; `null` = the default account.
    pub account_id: Option<String>,
}

/// Which account has a sign-in in flight (`null` = none). Lets a card whose flow was
/// superseded close its code box instead of offering an input that targets another
/// account's login.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_in_flight() -> Result<Option<ClaudeLoginInFlight>, String> {
    Ok(crate::accounts::login_in_flight()
        .await
        .map(|account_id| ClaudeLoginInFlight { account_id }))
}

/// Abort the in-flight Claude login (kills the CLI child). Safe when none is running.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_cancel() -> Result<(), String> {
    crate::accounts::login_cancel().await;
    Ok(())
}

/// Log ONE Claude account out (`claude auth logout`). The account row (if any) is kept, so
/// it stays listed as a signed-out slot the user can sign back into; removing it entirely
/// is [`claude_account_remove`].
#[tauri::command]
#[specta::specta]
pub async fn account_claude_logout(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<(), String> {
    crate::accounts::logout(&claude_slot(&app, account_id.as_deref())?).await
}

/// The signed-in Codex account (`account/read` on a transient app-server), whitelisted.
#[tauri::command]
#[specta::specta]
pub async fn account_codex_status() -> Result<codex::CodexAccountStatus, String> {
    codex::accounts::account_status().await.map_err(|e| e.to_string())
}

/// Start a Codex ChatGPT login (`account/login/start`): returns `{loginId, authUrl}`
/// immediately; the OAuth callback is served by the DEDICATED app-server kept alive by
/// the accounts module, and completion lands as an app-global [`AccountLoginEvent`]
/// (`backend: "codex"`) when `account/login/completed` arrives.
#[tauri::command]
#[specta::specta]
pub async fn account_codex_login_start(
    app: tauri::AppHandle,
) -> Result<codex::CodexLoginStart, String> {
    codex::accounts::login_start(move |success, error| {
        crate::ipc::events::emit_account_login(&app, "codex", success, error);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Abort the in-flight Codex login (`account/login/cancel` + teardown of its server).
#[tauri::command]
#[specta::specta]
pub async fn account_codex_login_cancel() -> Result<(), String> {
    codex::accounts::login_cancel().await;
    Ok(())
}

/// Log out of the Codex account (`account/logout`; the binary clears its own store).
#[tauri::command]
#[specta::specta]
pub async fn account_codex_logout() -> Result<(), String> {
    codex::accounts::logout().await.map_err(|e| e.to_string())
}

// ── TOSSE (the internal CRM) — a THIRD connection, unrelated to the two agent backends
// above: it authenticates the human to their CRM, not an agent to a model provider. Unlike
// those, no CLI owns the credentials — we run the OAuth flow and hold the tokens ourselves
// (see `crate::tosse`). The app is fully usable without it.

/// The TOSSE connection state (identity when reachable). Never fails on a network
/// outage — an offline machine still reports the session it holds.
#[tauri::command]
#[specta::specta]
pub async fn tosse_status() -> Result<crate::tosse::TosseAccountStatus, String> {
    Ok(crate::tosse::status().await)
}

/// Start a TOSSE sign-in: returns the authorization URL to open. The flow completes
/// ASYNCHRONOUSLY once the browser hits our loopback callback — the outcome lands as the
/// app-global [`AccountLoginEvent`] with `backend: "tosse"`, exactly like the Codex login.
#[tauri::command]
#[specta::specta]
pub async fn tosse_login_start(app: tauri::AppHandle) -> Result<String, String> {
    crate::tosse::login_start(move |success, error| {
        crate::ipc::events::emit_account_login(&app, "tosse", success, error);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Abort the in-flight TOSSE sign-in (drops the loopback listener). Safe when none runs.
#[tauri::command]
#[specta::specta]
pub async fn tosse_login_cancel() -> Result<(), String> {
    crate::tosse::login_cancel().await;
    Ok(())
}

/// Sign out of TOSSE: revokes the session server-side (best effort) and clears the local
/// tokens. Errs only when revocation failed — the local sign-out has happened either way.
#[tauri::command]
#[specta::specta]
pub async fn tosse_logout(app: tauri::AppHandle) -> Result<(), String> {
    // Close the live channel FIRST, and here rather than only in the front's reaction to the
    // status change: a stream left open on revoked credentials would spend its retry budget
    // collecting 401s from a session the user just ended.
    crate::tosse::sse::stop(&crate::ipc::events::TosseLiveEmitter { app }).await;
    crate::tosse::logout().await.map_err(|e| e.to_string())
}

/// Open the CRM's live change feed, so the Tasks view updates itself instead of waiting out
/// a `staleTime`. Idempotent: a second call re-publishes the current state rather than
/// opening a second socket (one connection for the whole app — see `crate::tosse::sse`).
///
/// Driven by the front on the ONE condition that gates it: a held TOSSE session. There is no
/// preference — live updates are how the Tasks view works, not a mode of it.
#[tauri::command]
#[specta::specta]
pub async fn tosse_live_start(app: tauri::AppHandle) -> Result<(), String> {
    crate::tosse::sse::start(std::sync::Arc::new(crate::ipc::events::TosseLiveEmitter { app })).await;
    Ok(())
}

/// Close the live channel (idempotent). Called on sign-out — "off" must mean no socket at
/// all, not a hidden one nobody reads.
#[tauri::command]
#[specta::specta]
pub async fn tosse_live_stop(app: tauri::AppHandle) -> Result<(), String> {
    crate::tosse::sse::stop(&crate::ipc::events::TosseLiveEmitter { app }).await;
    Ok(())
}

// NOTE: there is deliberately NO `tosse_live_status` command. The health of the channel
// reaches the front entirely through `TosseLiveStateEvent`: `TosseLiveHost` mounts once at
// the app root BEFORE the channel is started and receives every state event, including the
// one `tosse_live_start` re-publishes for an already-running channel. A pull-based initial
// read had no caller — it was an IPC command, a generated binding and a mock implementation
// kept compiling for nobody.

/// How each of Flight Deck's folders relates to TOSSE, in one call.
///
/// One payload rather than a command per repo: the CRM's repository list is a single
/// request, and matching needs all of it at once.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TosseRepoLinksPayload {
    /// False when no TOSSE session is held. The app is fully usable in that state, so the
    /// UI shows nothing at all — and this call costs nothing either (it returns before
    /// reading a single git remote).
    pub connected: bool,
    /// One entry per Flight Deck repo, in the order the store holds them.
    pub links: Vec<crate::tosse::TosseRepoLink>,
    /// Every repository the CRM knows, for the manual picker. Empty when `error` is set.
    pub repositories: Vec<crate::tosse::TosseRepository>,
    /// Set when we ARE connected but the list could not be read (offline, server error).
    /// The links then resolve to nothing, and the UI says why instead of showing a folder
    /// as un-associated — which would look like the association was lost.
    pub error: Option<String>,
}

/// Pair every Flight Deck folder with the TOSSE repository it belongs to.
///
/// A manual pin wins; otherwise the folder's `origin` remote is matched against the CRM's
/// urls (normalized — see [`crate::git::normalize_remote_url`]). Names are NEVER matched.
#[tauri::command]
#[specta::specta]
pub async fn tosse_repo_links(
    store: tauri::State<'_, Store>,
) -> Result<TosseRepoLinksPayload, String> {
    let rows = store.repo_tosse_links().map_err(|e| e.to_string())?;

    // Ask TOSSE FIRST: a signed-out user must not pay for a git spawn per folder just to
    // be told there is nothing to show.
    let listed = match crate::tosse::list_repositories().await {
        Ok(list) => Ok(list),
        Err(crate::tosse::TosseError::NotConnected) => {
            return Ok(TosseRepoLinksPayload {
                connected: false,
                links: Vec::new(),
                repositories: Vec::new(),
                error: None,
            })
        }
        // A refused grant means the stored session was just CLEARED (see `access_token`),
        // so we are signed out, not "connected but failing". Reporting `connected: true`
        // here would make the UI diagnose the CRM's data while the real answer is "sign in
        // again" — the reason travels in `error` so it can be said out loud.
        Err(e @ crate::tosse::TosseError::Denied(_)) => {
            return Ok(TosseRepoLinksPayload {
                connected: false,
                links: Vec::new(),
                repositories: Vec::new(),
                error: Some(e.to_string()),
            })
        }
        Err(e) => Err(e.to_string()),
    };

    // Reading remotes shells out to `git` once per folder — off the async runtime.
    let locals = tauri::async_runtime::spawn_blocking(move || {
        rows.into_iter()
            .map(|row| {
                use crate::git::RemoteLookup;
                use crate::tosse::RemoteProbe;
                // Three ordinary answers, one fault — and, before any of them, the question
                // of whether this Mac is even the right machine to ask. A folder that is not
                // a repository is COMMON here (Flight Deck opens folders, not only clones)
                // and must not be dressed up as a failure; a folder that vanished, or that
                // git cannot read, must SAY so rather than pass for "simply un-associated".
                let (remote_url, not_a_repository, remote_error, machine) =
                    match crate::tosse::remote_probe(
                        row.machine_id.as_deref(),
                        row.machine_label.as_deref(),
                        row.remote_origin_probed_at.is_some(),
                        row.remote_origin_note.as_deref(),
                    ) {
                        // Not a fault, and not a spawn either: the folder lives on a
                        // server, so the url comes from what that server last told us
                        // (`tosse_probe_remote_origins`, out of band) instead of from a
                        // `git` here. Cached rather than fetched on this path because
                        // the sidebar calls it at load — and because a cached answer
                        // still matches with the server switched off.
                        RemoteProbe::Skip(machine) => {
                            (row.remote_origin_url.clone(), false, None, Some(machine))
                        }
                        RemoteProbe::Locally => match crate::git::remote_url(&row.path) {
                            Ok(RemoteLookup::Url(url)) => (Some(url), false, None, None),
                            Ok(RemoteLookup::NoRemote) => (None, false, None, None),
                            Ok(RemoteLookup::NotARepository) => (None, true, None, None),
                            Err(e) => (None, false, Some(e.to_string()), None),
                        },
                    };
                (
                    crate::tosse::LocalRepo {
                        repo_id: row.repo_id,
                        remote_url,
                        manual_repository_id: row.tosse_repository_id,
                        machine,
                    },
                    (not_a_repository, remote_error),
                )
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("could not read the repositories' git remotes: {e}"))?;

    let (inputs, git_outcomes): (Vec<_>, Vec<_>) = locals.into_iter().unzip();
    // ⚠️ `None` (not an empty slice) when the list failed to load: matching must not RUN
    // against data we never received, or "we could not look" becomes indistinguishable
    // from "we looked and found nothing" — and the UI announces a deletion that never
    // happened, next to a button that destroys the association for good.
    let mut links = crate::tosse::resolve_links(&inputs, listed.as_deref().ok());
    let repositories = listed.as_ref().cloned().unwrap_or_default();
    for (link, (not_a_repository, err)) in links.iter_mut().zip(git_outcomes) {
        link.not_a_repository = not_a_repository;
        link.remote_error = err;
    }

    Ok(TosseRepoLinksPayload {
        connected: true,
        links,
        repositories,
        error: listed.err(),
    })
}

/// What one run of [`tosse_probe_remote_origins`] did.
///
/// Three facts, deliberately not collapsed into the single `bool` this used to be:
///  - `changed` — a folder's visible state moved (a url, an answer, or the first probe
///    ever), so the UI should refetch;
///  - `skipped` — the sweep never ran (another one held the lock). NOT the same as
///    "nothing changed", and the caller must not treat it as a verdict;
///  - `write_errors` — answers that were obtained and then LOST on the way to SQLite,
///    verbatim. Silence here would turn a broken database into "Refresh does nothing".
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOriginSweep {
    pub changed: bool,
    pub skipped: bool,
    pub write_errors: Vec<String>,
}

impl RemoteOriginSweep {
    fn skipped() -> Self {
        Self { changed: false, skipped: true, write_errors: Vec::new() }
    }
    fn ran(changed: bool, write_errors: Vec<String>) -> Self {
        Self { changed, skipped: false, write_errors }
    }
}

/// Refresh, over SSH, the `origin` of every folder that lives on a paired server, and
/// cache each answer in SQLite.
///
/// This is what makes the automatic TOSSE match work on a remote repository at all: a
/// folder over there has a perfectly good `origin`, it simply cannot be read by this
/// Mac's `git` (see [`crate::tosse::remote_probe`]). The read is deliberately NOT on
/// [`tosse_repo_links`]'s path — that one is called when the sidebar loads, and an SSH
/// round trip per server does not belong there. It runs beside it and, when something
/// actually changed, the front refetches.
///
/// Reports what the sweep did — see [`RemoteOriginSweep`]. Never returns `Err` for an
/// unreachable server: that is the server's state, not a failure of this call, and
/// turning it into one would resurrect exactly the false alarm the machine-aware probe
/// removed.
#[tauri::command]
#[specta::specta]
pub async fn tosse_probe_remote_origins(app: tauri::AppHandle) -> Result<RemoteOriginSweep, String> {
    // One sweep at a time. A second caller is told it was SKIPPED and made to wait for
    // nothing: the in-flight sweep will report its own result, and React Query already
    // de-duplicates concurrent fetches of the same key.
    //
    // ⚠️ Skipped is not "nothing moved". This used to answer `false`, which reads as a
    // verdict — "we looked, everything is where it was" — for a call that never looked
    // at all. A folder added while a sweep was in flight is not in that sweep, so it
    // would have waited for an unrelated trigger to ever be asked about.
    static SWEEPING: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
    {
        let mut busy = SWEEPING.lock().unwrap();
        if *busy {
            return Ok(RemoteOriginSweep::skipped());
        }
        *busy = true;
    }
    let done = ProbeGuard(&SWEEPING);

    let store = app.state::<Store>();
    let rows = store.repo_tosse_links().map_err(|e| e.to_string())?;
    // Group by server: the SSH handshake dwarfs the `git` calls, so ten folders on one
    // machine are one connection, not ten.
    let mut by_machine: std::collections::HashMap<
        String,
        Vec<crate::store::model::RepoTosseLink>,
    > = std::collections::HashMap::new();
    for row in rows {
        if let Some(id) = row.machine_id.clone() {
            by_machine.entry(id).or_default().push(row);
        }
    }
    if by_machine.is_empty() {
        return Ok(RemoteOriginSweep::ran(false, Vec::new()));
    }
    let known_hosts = remote_known_hosts_path(&app);
    let machines: Vec<_> = by_machine
        .into_iter()
        .filter_map(|(id, rows)| {
            // A row whose server was un-paired keeps its cached url (it was true when it
            // was read); there is simply nothing left to ask.
            match store.machine_by_id(&id) {
                Ok(Some(m)) => Some((m, rows)),
                _ => None,
            }
        })
        .collect();
    drop(store);

    let sweeps = machines.into_iter().map(|(machine, rows)| {
        let known_hosts = known_hosts.clone();
        async move {
            let paths: Vec<String> = rows.iter().map(|r| r.path.clone()).collect();
            let script = crate::git::remote_origin_script(&paths, |p| shq(p));
            // `ConnectTimeout` only bounds the handshake. A server that answers and then
            // stalls (a hung filesystem under one of the folders) would leave this future
            // pending forever, and with it the query the sidebar's refresh waits on. One
            // `git` per folder can take longer than the default round trip: 30 s.
            let probe = run_ssh_on_machine_within(
                &machine,
                known_hosts.as_deref(),
                &script,
                std::time::Duration::from_secs(30),
            )
            .await;
            let out = match probe {
                Ok(out) => out,
                Err(e) => {
                    // Said out loud in the log, but NOT to the user as a fault: a server
                    // that is off is not a broken repository. The card keeps saying the
                    // folder lives over there and offers the manual pin.
                    eprintln!("[tosse] could not read origins on {}: {e}", machine.label);
                    return Vec::new();
                }
            };
            let answers = crate::git::parse_remote_origin_script(&out);
            // `nogit` answers for the whole machine (empty path), so it cannot be paired
            // with a folder — but it IS an answer about every folder on it: the server
            // was reached and told us it has no git. Filed as such on each row, rather
            // than dropped, which used to leave them all looking like "we never managed
            // to ask" and had the card blame the server's reachability.
            if answers.iter().any(|(_, a)| *a == crate::git::RemoteOriginAnswer::NoGit) {
                eprintln!("[tosse] {} has no git, so no origin could be read", machine.label);
                return rows
                    .into_iter()
                    .map(|row| (row.repo_id, None, Some("no-git")))
                    .collect::<Vec<_>>();
            }
            rows.into_iter()
                .filter_map(|row| {
                    let answer = answers.iter().find(|(p, _)| *p == row.path).map(|(_, a)| a)?;
                    match answer {
                        crate::git::RemoteOriginAnswer::Local(crate::git::RemoteLookup::Url(u)) => {
                            // Redacted at the point of capture: this string is about to be
                            // persisted and shown, and a clone's remote can carry a token.
                            Some((row.repo_id, Some(crate::git::redact_remote_url(u)), None))
                        }
                        crate::git::RemoteOriginAnswer::Local(crate::git::RemoteLookup::NoRemote) => {
                            Some((row.repo_id, None, Some("no-remote")))
                        }
                        // ⚠️ These are FIRM answers, not silence. Dropping them left
                        // `remote_origin_probed_at` NULL — the field that means "we could
                        // not ask" — so the card told the user to "try again once the
                        // server is reachable" about a server that had just answered. The
                        // note is carried through to the UI instead; the cached url is
                        // left alone, so an unmounted folder keeps the origin it had.
                        crate::git::RemoteOriginAnswer::Local(crate::git::RemoteLookup::NotARepository) => {
                            Some((row.repo_id, None, Some("not-a-repository")))
                        }
                        crate::git::RemoteOriginAnswer::Gone => Some((row.repo_id, None, Some("gone"))),
                        crate::git::RemoteOriginAnswer::NoGit => Some((row.repo_id, None, Some("no-git"))),
                    }
                })
                .collect::<Vec<_>>()
        }
    });
    let results = futures_util::future::join_all(sweeps).await;

    let store = app.state::<Store>();
    let now = now_ms();
    let mut changed = false;
    let mut write_errors = Vec::new();
    for (repo_id, url, note) in results.into_iter().flatten() {
        match store.set_repo_remote_origin(&repo_id, url.as_deref(), note, now) {
            Ok(moved) => changed |= moved,
            // ⚠️ Carried back, not just logged. A failed write means the answer we paid
            // an SSH round trip for was LOST: the folder keeps reading as never-probed,
            // the next sweep asks again, and "Refresh" looks like it does nothing. A
            // line in a log nobody reads is how that becomes a permanent mystery.
            Err(e) => {
                eprintln!("[tosse] could not cache the origin of {repo_id}: {e}");
                write_errors.push(format!("{repo_id}: {e}"));
            }
        }
    }
    drop(done);
    Ok(RemoteOriginSweep::ran(changed, write_errors))
}

/// Releases [`tosse_probe_remote_origins`]'s one-sweep-at-a-time flag however the sweep
/// ends — an early `?` included. A bare `*busy = false` at the bottom would leave the
/// flag stuck on after the first error, and no origin would ever refresh again.
struct ProbeGuard(&'static std::sync::Mutex<bool>);

impl Drop for ProbeGuard {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = false;
    }
}

/// Pin a folder to a TOSSE repository by hand, or clear the pin with `None`.
///
/// Local only — the CRM has no field for a machine path, and this is never written back.
#[tauri::command]
#[specta::specta]
pub fn tosse_link_repository(
    store: tauri::State<'_, Store>,
    repo_id: String,
    repository_id: Option<String>,
) -> Result<(), String> {
    let touched = store
        .set_repo_tosse_link(&repo_id, repository_id.as_deref())
        .map_err(|e| e.to_string())?;
    if touched == 0 {
        // Reporting success here would leave the UI showing an association that was
        // never stored, and that quietly vanishes on the next load.
        return Err(format!("no repository with id {repo_id} is registered"));
    }
    Ok(())
}

/// A clone found on this Mac that matches one of the urls asked about.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepoMatch {
    pub path: String,
    /// The clone's own `origin`, so two same-named folders can be told apart.
    pub remote_url: String,
    /// The url FROM THE CRM that this clone matched, verbatim as it was passed in.
    ///
    /// Returned so the UI can name the repository ("matches « CRM_max »") by plain
    /// equality, instead of re-implementing url normalisation in TypeScript — that
    /// comparison has exactly one home, [`crate::git::normalize_remote_url`], and a second
    /// implementation would drift from it the first time either side gains a case.
    pub matched_url: String,
}

/// The answer to "is this project's repository already cloned here?", INCLUDING what the
/// scan could not do.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepoScan {
    pub matches: Vec<LocalRepoMatch>,
    /// The walk stopped on its budget rather than on running out of folders — so "no
    /// match" here means "not found in what we looked at", and the UI says so.
    pub truncated: bool,
    /// Folders macOS would not let us read (a privacy-guarded folder with no grant yet).
    /// Surfaced for the same reason: an empty result must never pass for a verdict.
    pub unreadable: Vec<String>,
    /// How much ground was actually covered. Reported so a truncated scan can say WHICH
    /// limit it hit — "stopped early" alone is a message neither the user nor we can act
    /// on, which is precisely how a blocked privacy prompt hid itself once.
    pub visited: u32,
    pub elapsed_ms: u32,
}

/// Find the clones already on this Mac whose `origin` matches one of `urls`.
///
/// The caller passes the CRM urls of the project's repositories — they are already in the
/// front's cached payload, so this needs no network of its own and stays a pure local
/// question. Only MATCHES come back: the app has no business shipping an inventory of
/// every repository on the disk to the webview.
///
/// Measured on a real home directory: ~130 ms for 49 repositories. Cheap because it reads
/// `.git/config` instead of spawning `git` per folder, and never descends into a
/// repository or a dependency tree. Runs off the async runtime all the same.
#[tauri::command]
#[specta::specta]
pub async fn scan_local_git_repos(
    store: tauri::State<'_, Store>,
    urls: Vec<String>,
) -> Result<LocalRepoScan, String> {
    // Nothing to match against — don't touch the disk at all.
    let wanted: std::collections::HashSet<String> = urls
        .iter()
        .filter_map(|u| crate::git::normalize_remote_url(u))
        .collect();
    if wanted.is_empty() {
        return Ok(LocalRepoScan {
            matches: Vec::new(),
            truncated: false,
            unreadable: Vec::new(),
            visited: 0,
            elapsed_ms: 0,
        });
    }

    // Where to look: the home directory covers the usual cases, plus the PARENT of every
    // folder already in Flight Deck — that is where this user demonstrably keeps clones,
    // including outside home (an external volume, /Volumes/…).
    // ⚠️ LOCAL folders only. A folder on a paired server has a path that means nothing
    // here (`/home/agent/projects/FlightDeck`): taken as a scan root it makes this Mac
    // look for clones in a directory that belongs to another machine, tells the user
    // macOS is blocking access to it, and — since `/home` is an autofs mount point —
    // can stall the scan's whole time budget waiting on a lookup that will never resolve.
    let known: Vec<_> = store
        .repo_tosse_links()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.machine_id.is_none())
        .collect();
    let scan = tauri::async_runtime::spawn_blocking(move || {
        let mut roots: Vec<PathBuf> = Vec::new();
        // `$HOME` directly, as every other module here resolves it — no new dependency
        // for one lookup.
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        if let Some(home) = home {
            roots.push(home.clone());
            for row in &known {
                let path = PathBuf::from(&row.path);
                if let Some(parent) = path.parent() {
                    if !parent.starts_with(&home) && !roots.iter().any(|r| r == parent) {
                        roots.push(parent.to_path_buf());
                    }
                }
            }
        } else {
            for row in &known {
                if let Some(parent) = PathBuf::from(&row.path).parent() {
                    roots.push(parent.to_path_buf());
                }
            }
        }
        // Depth 4 from home reaches `~/Repos/client/project` and the like; deeper is
        // where the cost is, and where clones essentially never are.
        crate::git::scan_repos(&roots, 4)
    })
    .await
    .map_err(|e| format!("could not scan for local repositories: {e}"))?;

    // Keyed by normalized url so a match can report WHICH CRM url it answered.
    let by_key: std::collections::HashMap<String, String> = urls
        .iter()
        .filter_map(|u| crate::git::normalize_remote_url(u).map(|k| (k, u.clone())))
        .collect();
    let matches = scan
        .repos
        .into_iter()
        .filter_map(|repo| {
            let key = crate::git::normalize_remote_url(&repo.remote_url)?;
            let matched_url = by_key.get(&key)?.clone();
            Some(LocalRepoMatch {
                path: repo.path,
                remote_url: repo.remote_url,
                matched_url,
            })
        })
        .collect();

    Ok(LocalRepoScan {
        matches,
        truncated: scan.truncated,
        unreadable: scan.unreadable,
        visited: scan.visited,
        elapsed_ms: scan.elapsed_ms,
    })
}

/// Which local folder each TOSSE project's work happens in, as the user pinned it.
///
/// Local only, and deliberately so: the CRM holds no field for a machine path, and a
/// path on this Mac would mean nothing on a colleague's. Read as a whole — there are a
/// handful of pins at most, and the tasks view needs all of them to resolve any task.
#[tauri::command]
#[specta::specta]
pub fn tosse_project_repos(
    store: tauri::State<'_, Store>,
) -> Result<Vec<crate::store::TosseProjectRepo>, String> {
    store.tosse_project_repos().map_err(|e| e.to_string())
}

/// Pin a TOSSE project to a local folder, or forget the pin with `None`.
///
/// Keyed by PROJECT, not by task: every task of a project is worked on in the same
/// folder, so the question is asked once and the answer reused. Always reversible from
/// the project's card.
#[tauri::command]
#[specta::specta]
pub fn tosse_link_project_repo(
    store: tauri::State<'_, Store>,
    project_id: String,
    repo_id: Option<String>,
) -> Result<(), String> {
    store
        .set_tosse_project_repo(&project_id, repo_id.as_deref())
        // The foreign key refuses a folder the app does not know. Surfaced rather than
        // swallowed: the view would otherwise offer to open a folder that is not there.
        .map_err(|e| format!("could not save the folder for this project: {e}"))?;
    Ok(())
}

/// Everything the TOSSE view reads, in one call (`GET /api/v1/briefing/morning`).
///
/// The CRM assembles this shape for its own Briefing page — active projects with their
/// client, their open tasks and their progress counts — so the view reads that instead of
/// stitching `/clients` + `/projects` + `/tasks` together and re-deriving it.
#[tauri::command]
#[specta::specta]
pub async fn tosse_briefing() -> Result<crate::tosse::TosseBriefing, String> {
    crate::tosse::briefing().await.map_err(|e| e.to_string())
}

/// The tasks of ONE status the briefing deliberately leaves out (`Backlog`, `En attente`).
///
/// One command for both rather than one per status: they differ only by the value in the
/// query, and the view renders them the same way — as a section of its own on the card of
/// the project that owns them. See `tosse::tasks_by_status`.
#[tauri::command]
#[specta::specta]
pub async fn tosse_tasks_by_status(
    status: String,
) -> Result<Vec<crate::tosse::TosseOffBoardTask>, String> {
    crate::tosse::tasks_by_status(&status)
        .await
        .map_err(|e| e.to_string())
}

/// Where TOSSE lives in a browser, so the tasks view can hand a task or a project over to
/// the CRM for everything it deliberately does not edit (title, priority, assignee, due
/// date, deletion). Discovered, not hard-coded — see `tosse::web_url`.
#[tauri::command]
#[specta::specta]
pub async fn tosse_web_url() -> Result<String, String> {
    crate::tosse::web_url().await.map_err(|e| e.to_string())
}

/// One task in full — the Markdown fields and relations the briefing leaves out. Fetched
/// when a row is actually opened, never for a list.
#[tauri::command]
#[specta::specta]
pub async fn tosse_task_detail(task_id: String) -> Result<crate::tosse::TosseTaskDetail, String> {
    crate::tosse::task_detail(&task_id)
        .await
        .map_err(|e| e.to_string())
}

/// Move a task to another status.
///
/// ⚠️ `"Fait"` is reachable from here, and that is deliberate: the repo's rule is that no
/// AGENT closes a task, and this command only ever runs because a human clicked a status in
/// the UI. Nothing in the agent surface calls it.
#[tauri::command]
#[specta::specta]
pub async fn tosse_set_task_status(task_id: String, status: String) -> Result<(), String> {
    crate::tosse::set_task_status(&task_id, &status)
        .await
        .map_err(|e| e.to_string())
}

/// Reassign a task (Alexandre / Armand / Les deux) — a human picking a person in the
/// conversation side panel's task card. Nothing in the agent surface calls it.
#[tauri::command]
#[specta::specta]
pub async fn tosse_set_task_assignee(task_id: String, assigned_to: String) -> Result<(), String> {
    crate::tosse::set_task_assignee(&task_id, &assigned_to)
        .await
        .map_err(|e| e.to_string())
}

/// Move a project to another status — the Start / Pause / Finish control on a project card.
#[tauri::command]
#[specta::specta]
pub async fn tosse_set_project_status(project_id: String, status: String) -> Result<(), String> {
    crate::tosse::set_project_status(&project_id, &status)
        .await
        .map_err(|e| e.to_string())
}

/// Create a task in a project, with the status of the group it was typed into.
#[tauri::command]
#[specta::specta]
pub async fn tosse_create_task(
    project_id: String,
    title: String,
    status: String,
    kind: Option<String>,
    priority: Option<String>,
    assigned_to: Option<String>,
) -> Result<crate::tosse::TosseTask, String> {
    crate::tosse::create_task(
        &project_id,
        &title,
        &status,
        kind.as_deref(),
        priority.as_deref(),
        assigned_to.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Fetch the slash commands available in `cwd` WITHOUT starting a persistent
/// session. Spawns a short-lived `claude`, performs the `initialize` handshake
/// (spec §4.4), reads the advertised commands from its `control_response`, and
/// tears the process down. This lets the composer populate its `/` autocomplete
/// before the lazy session spawn — so typing `/pickup` as the very first thing
/// works — without leaving a process alive. Returns an empty list if the
/// handshake does not complete within the deadline (the live session, spawned on
/// the first message, will still emit commands later via `SessionCommandsEvent`).
#[tauri::command]
#[specta::specta]
pub async fn fetch_slash_commands(cwd: String) -> Result<Vec<SlashCommand>, String> {
    use crate::supervisor::control;
    use crate::supervisor::protocol::CliMessage;
    use crate::supervisor::transport::Transport;

    let (mut transport, mut rx) =
        Transport::spawn(SpawnConfig::new(PathBuf::from(cwd))).map_err(|e| e.to_string())?;
    // This transport serves exactly one request, so a fixed id is fine.
    let request_id = "tosse-cmd-fetch";
    transport
        .send_line(control::initialize_request(request_id, &[]))
        .map_err(|e| e.to_string())?;

    let commands = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while let Some(msg) = rx.recv().await {
            if let CliMessage::ControlResponse(v) = msg {
                let echoed = v
                    .get("response")
                    .and_then(|r| r.get("request_id"))
                    .and_then(|x| x.as_str());
                if echoed == Some(request_id) {
                    return control::parse_initialize_commands(&v).unwrap_or_default();
                }
            }
        }
        Vec::new()
    })
    .await
    .unwrap_or_default();

    transport.shutdown(false).await;
    Ok(commands)
}

/// Rebuild a resumed conversation's history from Claude's on-disk transcript.
///
/// `claude --resume` does not re-stream past messages, so the live event path
/// delivers nothing for an existing conversation. The UI calls this after
/// re-spawning a session to replay its history into the store. An absent
// ---- Settings → Claude Code: sub-agent routing, spend, instructions --------------

/// The routing picture for one repository: every sub-agent we can name, the model it will
/// actually run on, where that setting lives, and the two scope hazards (a git-ignored
/// `.claude/agents/`, a worktree checkout). Disk-only and fast — the page renders from
/// this before any process is spawned.
#[tauri::command]
#[specta::specta]
pub async fn list_subagent_routing(
    repo_path: String,
) -> Result<crate::extensions::routing::SubagentRouting, String> {
    tokio::task::spawn_blocking(move || crate::extensions::routing::routing_for(&repo_path))
        .await
        .map_err(|e| e.to_string())
}

/// Rewrite an existing agent definition's `model:` / `effort:` and NOTHING else. The
/// system prompt in the file's body is preserved to the byte — see
/// [`crate::extensions::agent_edit`]. `None` removes the key.
#[tauri::command]
#[specta::specta]
pub async fn set_subagent_model(
    path: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::extensions::agent_edit::write_agent_frontmatter(
            std::path::Path::new(&path),
            &[("model", model), ("effort", effort)],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a NEW agent definition file. `body` is the agent's system prompt and is
/// required: a file named after a built-in replaces that agent ENTIRELY, so the caller has
/// to have shown the user what the replacement will run on. Refuses to overwrite.
/// Returns the path written.
#[tauri::command]
#[specta::specta]
pub async fn create_subagent_definition(
    dir: String,
    name: String,
    description: String,
    model: Option<String>,
    effort: Option<String>,
    body: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        // The file name carries the agent name; the frontmatter `name:` is what the CLI
        // dispatches on, and it is written verbatim (capitalisation included — verified:
        // `name: Explore` overrides the built-in).
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        if safe.is_empty() {
            return Err("an agent needs a name".to_string());
        }
        let path = std::path::Path::new(&dir).join(format!("{safe}.md"));
        crate::extensions::agent_edit::create_agent_file(
            &path,
            &name,
            &description,
            model.as_deref(),
            effort.as_deref(),
            &body,
        )?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set or clear the sub-agent model baseline (`CLAUDE_CODE_SUBAGENT_MODEL`) and its
/// forcing variant. `None` clears. ⚠️ The forcing variant overrides every per-agent choice
/// and every model a workflow asks for — the UI must never set it implicitly.
#[tauri::command]
#[specta::specta]
pub async fn set_subagent_baseline(
    model: Option<String>,
    forced_model: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::extensions::set_subagent_baseline(model.as_deref(), forced_model.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Aggregate every Claude turn on this machine — each conversation's main agent and its
/// helpers — into `(day, repo, thread, agent, model, workflow)` buckets. One scan; the UI
/// pivots it for every table, filter and chart, on both the usage overview and the
/// helpers page.
#[tauri::command]
#[specta::specta]
pub async fn claude_spend() -> Result<crate::agentspend::SpendReport, String> {
    tokio::task::spawn_blocking(crate::agentspend::scan).await.map_err(|e| e.to_string())
}

/// Read `~/.claude/CLAUDE.md` — the whole file for preview, plus whatever currently sits
/// inside the app's managed markers.
#[tauri::command]
#[specta::specta]
pub async fn read_claude_memory() -> Result<crate::memoryfile::ManagedMemory, String> {
    tokio::task::spawn_blocking(crate::memoryfile::read_managed)
        .await
        .map_err(|e| e.to_string())?
}

/// Write (or, with `None`, remove) the managed block in `~/.claude/CLAUDE.md`. Everything
/// outside the markers is preserved byte for byte; a file with damaged markers is refused
/// rather than repaired.
#[tauri::command]
#[specta::specta]
pub async fn write_claude_memory(text: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::memoryfile::write_managed(text.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The sub-agent names the CLI itself reports for this directory — the drift canary's
/// input. Same ephemeral-spawn shape as [`fetch_slash_commands`]: one `initialize`
/// handshake, then the process is dropped. An empty list means "we could not ask", which
/// the caller must NOT render as "the agent is gone".
#[tauri::command]
#[specta::specta]
pub async fn fetch_known_agents(cwd: String) -> Result<Vec<String>, String> {
    use crate::supervisor::control;
    use crate::supervisor::protocol::CliMessage;
    use crate::supervisor::transport::Transport;

    let (mut transport, mut rx) =
        Transport::spawn(SpawnConfig::new(PathBuf::from(cwd))).map_err(|e| e.to_string())?;
    let request_id = "tosse-agents-fetch";
    transport
        .send_line(control::initialize_request(request_id, &[]))
        .map_err(|e| e.to_string())?;

    let agents = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while let Some(msg) = rx.recv().await {
            if let CliMessage::ControlResponse(v) = msg {
                let echoed = v
                    .get("response")
                    .and_then(|r| r.get("request_id"))
                    .and_then(|x| x.as_str());
                if echoed == Some(request_id) {
                    return control::parse_initialize_agents(&v).unwrap_or_default();
                }
            }
        }
        Vec::new()
    })
    .await
    .unwrap_or_default();

    transport.shutdown(false).await;
    Ok(agents)
}

/// transcript yields an empty list (not an error). File IO runs off the async
/// runtime via `spawn_blocking` so a large transcript never stalls it.
#[tauri::command]
#[specta::specta]
pub async fn load_session_history(session_id: String) -> Result<Vec<ConversationItem>, String> {
    tokio::task::spawn_blocking(move || crate::supervisor::history::load_history(&session_id))
        .await
        .map_err(|e| e.to_string())
}

/// Read a resumed conversation's current context fill (used tokens + window) from
/// its on-disk transcript, so the UI can show the context ring as soon as the
/// conversation is opened / its stream turned on — before the first new turn streams
/// live usage. An absent transcript yields all-`None` (not an error). File IO runs
/// off the async runtime via `spawn_blocking`.
#[tauri::command]
#[specta::specta]
pub async fn load_session_context(session_id: String) -> Result<ContextFill, String> {
    tokio::task::spawn_blocking(move || crate::supervisor::history::load_context_fill(&session_id))
        .await
        .map_err(|e| e.to_string())
}

/// Read a conversation's cumulative token spend from disk — the seed of the side panel's
/// session total on open / stream (re)start, before the first live snapshot. Claude: the
/// transcript's last `cost-state` line (every agent, as of the process's last close). Codex: the
/// rollout's last `token_count` total (this thread only). `None` when disk holds no such record
/// (a killed process, a remote conversation whose transcript is on its server): unknown, which
/// the UI reads as unknown — never zero. A tail read, off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn load_session_usage(
    session_id: String,
    backend: Backend,
) -> Result<Option<SessionUsage>, String> {
    tokio::task::spawn_blocking(move || match backend {
        Backend::Claude => crate::supervisor::history::load_session_usage(&session_id),
        Backend::Codex => crate::supervisor::codex::load_thread_usage(&session_id),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Read a conversation's active `/goal` (Claude Code's native goal feature) from its transcript.
/// The CLI writes goal state as `attachment` lines that are DISK-ONLY (never on the live stream),
/// so the UI reads this at conversation load and on each turn edge to know whether a goal is
/// active and show its condition. `None` when no goal is active.
///
/// Reads the transcript in FULL, forward (a goal set early and never terminated is still active
/// at the end of the file, so no tail slice would do) — but a raw-substring pre-filter rejects
/// every line that can't carry goal state before it reaches the JSON parser, which is what keeps
/// a whole Flight Deck fleet seeding its goals affordable. Routed by conversation (see
/// [`files_location`]): this Mac's transcript off the async runtime, or — for a conversation on
/// a paired server — that server's, where the pre-filter runs so only the goal lines travel.
#[tauri::command]
#[specta::specta]
pub async fn load_session_goal(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
) -> Result<Option<GoalState>, FileReadError> {
    let at = files_location(&app.state::<Store>(), &conversation_id)?;
    load_session_goal_at(at, remote_known_hosts_path(&app).as_deref(), session_id).await
}

/// [`load_session_goal`] once the conversation is placed — the testable core.
async fn load_session_goal_at(
    at: FilesAt,
    known_hosts: Option<&str>,
    session_id: String,
) -> Result<Option<GoalState>, FileReadError> {
    match at {
        FilesAt::ThisMac => {
            tokio::task::spawn_blocking(move || crate::supervisor::history::load_active_goal(&session_id))
                .await
                .map_err(|e| FileReadError::local_io(e.to_string()))
        }
        FilesAt::Server(machine) => {
            let server = remote_files::Server { machine: &machine, known_hosts };
            remote_files::read_active_goal(&server, &session_id).await
        }
    }
}

/// Read a conversation's history and the context fill its transcript last recorded, routed by
/// conversation (see [`files_location`]): this Mac's transcript (what [`load_session_history`] +
/// [`load_session_context`] read), or — for a conversation on a paired server — that server's,
/// in one round trip. A conversation on a server used to open EMPTY with its stream off: its
/// transcript is not on this Mac, and only a re-attach's replay brought anything back. An absent
/// transcript is an empty history, never an error.
#[tauri::command]
#[specta::specta]
pub async fn load_conversation_history(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
) -> Result<ConversationHistory, FileReadError> {
    let at = files_location(&app.state::<Store>(), &conversation_id)?;
    load_conversation_history_at(at, remote_known_hosts_path(&app).as_deref(), session_id).await
}

/// What each of this Mac's conversations on server `machine_id` is doing right now, from ONE
/// `flightdeckd status` round trip — no conversation is attached (see [`crate::remote_status`]).
/// The front calls it when the app starts and when the Mac comes back (wake, network back), so a
/// conversation that kept working on its server while Flight Deck was closed is re-attached and
/// shows its real state instead of "off". A conversation the daemon does not list is absent (no
/// process of it there). `Err` = the server could not be asked (unknown, never "idle").
#[tauri::command]
#[specta::specta]
pub async fn remote_conversation_states(
    app: tauri::AppHandle,
    machine_id: String,
) -> Result<Vec<crate::remote_status::RemoteConversationState>, String> {
    let (machine, keys) = {
        let store = app.state::<Store>();
        let machine = store
            .machine_by_id(&machine_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "unknown server".to_string())?;
        (machine, store.conversations_on_machine(&machine_id).map_err(|e| e.to_string())?)
    };
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let known_hosts = remote_known_hosts_path(&app);
    let cmd = format!("{} status 2>/dev/null", resolve_daemon_bin_expr("flightdeckd"));
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        run_ssh_on_machine(&machine, known_hosts.as_deref(), &cmd),
    )
    .await
    .map_err(|_| format!("{} did not answer in time", remote_files::server_name(&machine)))??;
    crate::remote_status::states_from_status(&out, &keys)
}

/// [`load_conversation_history`] once the conversation is placed — the testable core.
async fn load_conversation_history_at(
    at: FilesAt,
    known_hosts: Option<&str>,
    session_id: String,
) -> Result<ConversationHistory, FileReadError> {
    match at {
        FilesAt::ThisMac => tokio::task::spawn_blocking(move || ConversationHistory {
            items: history::load_history(&session_id),
            context: history::load_context_fill(&session_id),
        })
        .await
        .map_err(|e| FileReadError::local_io(e.to_string())),
        FilesAt::Server(machine) => {
            let server = remote_files::Server { machine: &machine, known_hosts };
            remote_files::read_session_history(&server, &session_id).await
        }
    }
}

/// Can `target_id` be located for a rewind? READ-ONLY probe — truncates nothing, stops
/// nothing. The front calls this BEFORE killing the live session, so an unresolvable target
/// costs nothing instead of tearing the session down for a rewind that was always going to
/// fail. See [`history::check_rewind_target`].
#[tauri::command]
#[specta::specta]
pub async fn check_rewind_target(
    session_id: String,
    target_id: String,
    target_is_user: bool,
    target_text: Option<String>,
    occurrence: Option<u32>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        history::check_rewind_target(
            &session_id,
            &target_id,
            target_is_user,
            target_text.as_deref(),
            occurrence.map(|o| o as usize),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rewind a conversation IN PLACE by truncating its on-disk transcript at `target_id`,
/// dropping that message (USER target) or everything after its response (ASSISTANT
/// target). Destructive by design ("resume from here"): the removed turns are
/// gone from the transcript, so a `--resume` re-spawn reads the shortened history fresh
/// (VERIFIED: resume honours the truncation — see [`history::rewind_transcript`]).
///
/// The caller MUST stop the conversation's live session first (so no `claude` process
/// re-writes the transcript from its in-memory state), then reload history from the
/// truncated file. Pure file IO, run off the async runtime via `spawn_blocking`.
#[tauri::command]
#[specta::specta]
pub async fn rewind_conversation(
    session_id: String,
    target_id: String,
    target_is_user: bool,
    target_text: Option<String>,
    occurrence: Option<u32>,
) -> Result<history::RewindOutcome, String> {
    tokio::task::spawn_blocking(move || {
        history::rewind_transcript(
            &session_id,
            &target_id,
            target_is_user,
            target_text.as_deref(),
            occurrence.map(|o| o as usize),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fork a NEW conversation branched at `target_id`, NON-destructively (the original
/// transcript is left intact). Writes the kept history to a fresh transcript beside the
/// original and returns it as a [`history::DiskConversation`] (inside [`history::ForkOutcome`])
/// the front turns into a real conversation via `reactivateDiskConversation`. No live session
/// is touched — the branch is lazy like any other conversation. Pure file IO off the runtime.
#[tauri::command]
#[specta::specta]
pub async fn fork_conversation(
    session_id: String,
    target_id: String,
    target_is_user: bool,
    target_text: Option<String>,
    occurrence: Option<u32>,
) -> Result<history::ForkOutcome, String> {
    tokio::task::spawn_blocking(move || {
        history::fork_transcript(
            &session_id,
            &target_id,
            target_is_user,
            target_text.as_deref(),
            occurrence.map(|o| o as usize),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Background-task artifacts (reads routed by conversation) --------------
//
// The front's read-only boundary to a session's background-task artifacts: a sub-agent's
// full transcript, a workflow run's manifest, a background task's output, the `/goal`
// state. These complement the live `SessionTaskEvent` (which carries only the coarse
// lifecycle) with the rich detail for a drill-down.
//
// Every one takes the CONVERSATION id and is routed here, by where the conversation's
// files live ([`files_location`]): its folder on this Mac → this Mac's disk readers
// (`supervisor::subagents` / `history`, off the async runtime); its folder on a paired
// server → that server, through `remote_files` (the ONLY remote file reader). A remote
// conversation never reaches a local reader — its paths name files on the server, and an
// absent file here would read as "no output", "no transcript", "no goal" — and an
// unknown conversation is an error, never "local".

/// Where a conversation's files live.
#[derive(Debug, PartialEq)]
enum FilesAt {
    ThisMac,
    Server(MachineRecord),
}

/// Place a conversation for a routed read: its folder's `machine_id` → that server's record,
/// none → this Mac. An UNKNOWN conversation, a server that is no longer paired, and a store
/// read error are all errors, never "this Mac" — that fallback is exactly how a server's path
/// would be read on this Mac's disk.
fn files_location(store: &Store, conversation_id: &str) -> Result<FilesAt, FileReadError> {
    let db = |e: rusqlite::Error| FileReadError::local_io(format!("Couldn't read this conversation from the database: {e}"));
    match store.conversation_machine_id(conversation_id).map_err(db)? {
        None => Err(FileReadError::UnknownConversation { conversation_id: conversation_id.to_string() }),
        Some(None) => Ok(FilesAt::ThisMac),
        Some(Some(machine_id)) => match store.machine_by_id(&machine_id).map_err(db)? {
            Some(machine) => Ok(FilesAt::Server(machine)),
            None => Err(FileReadError::Refused {
                server: None,
                reason: "This conversation's server is no longer paired with Flight Deck.".to_string(),
            }),
        },
    }
}

/// Copy a file attached in the composer — a file on THIS Mac — to the paired server the
/// conversation runs on, and return its absolute path THERE: what the composer mentions instead
/// of the Mac path, which means nothing (or a different file) to the server's agent. Routed by
/// conversation like the reads ([`files_location`]); see `remote_files::upload` for where it
/// lands and the bounds. `Err` is a full sentence naming the file and the server, shown inline
/// by the composer as is.
#[tauri::command]
#[specta::specta]
pub async fn upload_attachment(
    app: tauri::AppHandle,
    conversation_id: String,
    local_path: String,
) -> Result<String, String> {
    let at = files_location(&app.state::<Store>(), &conversation_id).map_err(|e| upload_refusal(&e))?;
    upload_attachment_at(at, remote_known_hosts_path(&app).as_deref(), &conversation_id, &local_path, None).await
}

/// [`upload_attachment`] once the conversation is placed — the testable core. A conversation on
/// THIS Mac is refused: its attachment is mentioned where it is, and there is nowhere to copy to.
async fn upload_attachment_at(
    at: FilesAt,
    known_hosts: Option<&str>,
    conversation_id: &str,
    local_path: &str,
    ssh_bin_override: Option<&Path>,
) -> Result<String, String> {
    match at {
        FilesAt::ThisMac => Err(
            "This conversation runs on this Mac — an attached file is mentioned where it is, not copied.".to_string(),
        ),
        FilesAt::Server(machine) => {
            let server = remote_files::Server { machine: &machine, known_hosts };
            remote_files::upload::upload_attachment(&server, conversation_id, Path::new(local_path), ssh_bin_override)
                .await
        }
    }
}

/// Why an upload could not even be placed (unknown conversation, unpaired server, store error).
fn upload_refusal(e: &FileReadError) -> String {
    match e {
        FileReadError::UnknownConversation { .. } => {
            "This conversation is no longer known to Flight Deck, so the file can't be sent to its server.".to_string()
        }
        FileReadError::Unreachable { server, reason } => format!("Couldn't reach {server}: {reason}."),
        FileReadError::Refused { reason, .. } | FileReadError::Io { reason, .. } => reason.clone(),
    }
}

/// A read that has no server-side counterpart, asked for a conversation on a server: refused
/// in plain words (the front never asks — it reads that state from the session's stream). A
/// refusal on THIS Mac (`server: None`): the server was never asked, so it is not named as the
/// refuser — only as where the conversation runs, by the same name rule as every server read.
fn not_read_from_this_mac(machine: &MachineRecord, what: &str) -> FileReadError {
    FileReadError::Refused {
        server: None,
        reason: format!(
            "{what} of a conversation on {} is read from its session's stream, not from this Mac's disk",
            remote_files::server_name(machine)
        ),
    }
}

/// Load a sub-agent's (`Agent` tool, or a workflow agent) full transcript, normalized into the
/// same items the live conversation renders. Empty if absent (not written yet). For a
/// conversation on a paired server the read is incremental (`remote_files` keeps what it
/// fetched), and `hint` — a location the stream gave: the `Agent` task's `output_file`, or a
/// workflow's transcript dir — lets the server skip its search. Ignored on this Mac.
#[tauri::command]
#[specta::specta]
pub async fn load_subagent_transcript(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
    agent_id: String,
    hint: Option<String>,
) -> Result<Vec<ConversationItem>, FileReadError> {
    let at = files_location(&app.state::<Store>(), &conversation_id)?;
    load_subagent_transcript_at(
        at,
        remote_known_hosts_path(&app).as_deref(),
        &remote_files::TRANSCRIPT_CACHE,
        conversation_id,
        session_id,
        agent_id,
        hint,
    )
    .await
}

/// [`load_subagent_transcript`] once the conversation is placed — the testable core.
async fn load_subagent_transcript_at(
    at: FilesAt,
    known_hosts: Option<&str>,
    cache: &remote_files::TranscriptCache,
    conversation_id: String,
    session_id: String,
    agent_id: String,
    hint: Option<String>,
) -> Result<Vec<ConversationItem>, FileReadError> {
    match at {
        FilesAt::ThisMac => tokio::task::spawn_blocking(move || {
            crate::supervisor::subagents::load_subagent_transcript(&session_id, &agent_id)
        })
        .await
        .map_err(|e| FileReadError::local_io(e.to_string())),
        FilesAt::Server(machine) => {
            let server = remote_files::Server { machine: &machine, known_hosts };
            remote_files::read_subagent_transcript(
                &server,
                cache,
                &conversation_id,
                &session_id,
                &agent_id,
                hint.as_deref(),
            )
            .await
        }
    }
}

/// Tauri managed state: the cached full-text search index over on-disk conversations.
/// Built lazily and reused, so search is instant and the heavy full-read happens once,
/// off the panel-open path (Option A). The build is SINGLE-FLIGHT — the async mutex is
/// held across the (blocking) build, so concurrent callers (the panel's background
/// `prime` racing an early `search`, or two quick searches) share ONE disk scan instead
/// of each launching their own. Same encapsulation pattern as [`Sessions`].
#[derive(Default)]
pub struct HistoryIndex {
    cell: tokio::sync::Mutex<Option<Arc<Vec<IndexedConversation>>>>,
}

impl HistoryIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Force a fresh build and cache it (the panel calls this on open). Holding the
    /// async lock across the build is what makes the whole thing single-flight.
    async fn rebuild(&self) -> Result<Arc<Vec<IndexedConversation>>, String> {
        let mut guard = self.cell.lock().await;
        let built = tokio::task::spawn_blocking(history::build_search_index)
            .await
            .map_err(|e| e.to_string())?;
        let arc = Arc::new(built);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    /// Return the cached index, building it once if absent. A concurrent build (a
    /// still-running `rebuild`, or another `ensure`) is awaited, never duplicated.
    async fn ensure(&self) -> Result<Arc<Vec<IndexedConversation>>, String> {
        let mut guard = self.cell.lock().await;
        if let Some(idx) = guard.as_ref() {
            return Ok(idx.clone());
        }
        let built = tokio::task::spawn_blocking(history::build_search_index)
            .await
            .map_err(|e| e.to_string())?;
        let arc = Arc::new(built);
        *guard = Some(arc.clone());
        Ok(arc)
    }
}

/// List every conversation found on disk (incl. orphans the app has forgotten),
/// most-recent-first — the rows the history panel shows. Cheap head-read; the full
/// transcript is loaded only when a row is previewed (`load_session_history`).
#[tauri::command]
#[specta::specta]
pub async fn list_disk_conversations() -> Result<Vec<DiskConversation>, String> {
    tokio::task::spawn_blocking(history::list_disk_conversations)
        .await
        .map_err(|e| e.to_string())
}

/// Build (or rebuild) the search index in the background and cache it — called when
/// the history panel opens so search is armed a beat later (Option A). Returns the
/// number of conversations indexed.
#[tauri::command]
#[specta::specta]
pub async fn prime_history_index(index: tauri::State<'_, HistoryIndex>) -> Result<u32, String> {
    let idx = index.rebuild().await?;
    Ok(idx.len() as u32)
}

/// Search the on-disk conversations by `query` (accent/case-insensitive, multi-term
/// AND, light typo tolerance), best-first. Lazily builds + caches the index on the
/// first call so search works even before `prime_history_index` ran.
#[tauri::command]
#[specta::specta]
pub async fn search_conversations(
    index: tauri::State<'_, HistoryIndex>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let cached = index.ensure().await?;
    let hits = tokio::task::spawn_blocking(move || history::score_index(cached.as_slice(), &query))
        .await
        .map_err(|e| e.to_string())?;
    Ok(hits)
}

/// Global "search everything": file contents under the requested local folders and/or the
/// conversations whose cwd lies under them (see `crate::search`). Starting it supersedes any
/// search still in flight — that one comes back `cancelled: true`. `Err` only for an invalid
/// query (bad regular expression or include/exclude glob); every other failure (unreadable
/// root, unreadable file) is reported inside the result.
#[tauri::command]
#[specta::specta]
pub async fn global_search(
    search: tauri::State<'_, crate::search::GlobalSearch>,
    request: crate::search::GlobalSearchRequest,
) -> Result<crate::search::GlobalSearchResult, String> {
    // Claim the generation NOW (on the command's thread), so invocation order decides which
    // search supersedes which — not the blocking pool's scheduling.
    let ticket = search.begin();
    tokio::task::spawn_blocking(move || crate::search::run(&ticket, &request))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop the global search in flight (if any): it returns promptly with `cancelled: true`.
#[tauri::command]
#[specta::specta]
pub fn cancel_global_search(search: tauri::State<'_, crate::search::GlobalSearch>) {
    search.cancel();
}

/// Load a workflow run's manifest (`workflows/<run_id>.json`). `null` if absent (still running,
/// or never written). For a conversation on a paired server, read on that server — the full
/// end-of-run report (models, durations, the run's return value) the session's stream does not
/// carry in full.
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_run(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
    run_id: String,
) -> Result<Option<WorkflowRun>, FileReadError> {
    let at = files_location(&app.state::<Store>(), &conversation_id)?;
    match at {
        FilesAt::ThisMac => tokio::task::spawn_blocking(move || {
            crate::supervisor::subagents::load_workflow_run(&session_id, &run_id)
        })
        .await
        .map_err(|e| FileReadError::local_io(e.to_string()))?
        .map_err(FileReadError::local_io),
        FilesAt::Server(machine) => {
            let known_hosts = remote_known_hosts_path(&app);
            let server = remote_files::Server { machine: &machine, known_hosts: known_hosts.as_deref() };
            remote_files::read_workflow_run(&server, &session_id, &run_id).await
        }
    }
}

/// Live progress of a RUNNING workflow from its journal (`subagents/workflows/<run_id>/
/// journal.jsonl`): agents started vs done. The rich manifest is written only at the end, so
/// this is the mid-run "how far along" source. `null` if no journal yet. This Mac only: a run on
/// a paired server reports its per-agent progress on the session's stream (refused, not
/// "absent", if ever asked).
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_journal(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
    run_id: String,
) -> Result<Option<WorkflowJournal>, FileReadError> {
    if let FilesAt::Server(machine) = files_location(&app.state::<Store>(), &conversation_id)? {
        return Err(not_read_from_this_mac(&machine, "The workflow journal"));
    }
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_workflow_journal(&session_id, &run_id)
    })
    .await
    .map_err(|e| FileReadError::local_io(e.to_string()))?
    .map_err(FileReadError::local_io)
}

/// Start (or join) a live watch on a RUNNING workflow's journal. Each change pushes a
/// `WorkflowJournalEvent` carrying the run's fresh per-agent progress, so the pinned bar, the
/// inline card and the Flight Deck card stay live WITHOUT any of them polling. Ref-counted:
/// every call must be paired with [`unwatch_workflow_journal`].
#[tauri::command]
#[specta::specta]
pub fn watch_workflow_journal(
    app: tauri::AppHandle,
    watchers: tauri::State<'_, crate::supervisor::workflow_watch::WorkflowWatchers>,
    session_id: String,
    run_id: String,
) -> Result<(), String> {
    watchers.watch(app, session_id, run_id);
    Ok(())
}

/// Drop one reference to a run's journal watch (the last one stops it).
#[tauri::command]
#[specta::specta]
pub fn unwatch_workflow_journal(
    watchers: tauri::State<'_, crate::supervisor::workflow_watch::WorkflowWatchers>,
    session_id: String,
    run_id: String,
) -> Result<(), String> {
    watchers.unwatch(&session_id, &run_id);
    Ok(())
}

/// The workflow's declared phases (title + detail), parsed from its script's `meta.phases` —
/// the only source of the FULL phase list (incl. not-yet-reached phases) available DURING the
/// run. Empty if no script/phases. Lets the live overview show upcoming steps. This Mac only: a
/// run on a paired server declares its phases on the session's stream.
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_phases(
    app: tauri::AppHandle,
    conversation_id: String,
    session_id: String,
    run_id: String,
) -> Result<Vec<WorkflowPhase>, FileReadError> {
    if let FilesAt::Server(machine) = files_location(&app.state::<Store>(), &conversation_id)? {
        return Err(not_read_from_this_mac(&machine, "A workflow's declared phases"));
    }
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_workflow_phases(&session_id, &run_id)
    })
    .await
    .map_err(|e| FileReadError::local_io(e.to_string()))?
    .map_err(FileReadError::local_io)
}

/// Read a background task's output (a `Bash` run in the background, a `Monitor` watch) from the
/// ABSOLUTE path the CLI reported (`BackgroundTask.output_file`), INCREMENTALLY: from `offset`
/// (`null` = the caller holds nothing yet → the latest output), see [`TaskOutputChunk`]. `null`
/// if the file is absent. One read per call — the output popover layers the polling on top, and
/// only while it is open.
///
/// No path yet (`path: null`)? Then `locate` names the task by (session, task) and the file is
/// FOUND where the CLI writes it (see [`TaskOutputLocator`]) — a running `Monitor`'s path is only
/// reported once it ends, so without this its events were unreadable for its whole run. Neither
/// given → refused (there is nothing to read).
///
/// Routed by conversation: on this Mac the reader guards only the path's shape (a
/// `…/tasks/*.output` file); for a conversation on a paired server the path must be that
/// server's Claude Code temp dir (`/tmp/claude-<uid>/…`), re-checked on the server itself.
#[tauri::command]
#[specta::specta]
pub async fn read_task_output(
    app: tauri::AppHandle,
    conversation_id: String,
    path: Option<String>,
    locate: Option<TaskOutputLocator>,
    offset: Option<u64>,
) -> Result<Option<TaskOutputChunk>, FileReadError> {
    let at = files_location(&app.state::<Store>(), &conversation_id)?;
    read_task_output_at(at, remote_known_hosts_path(&app).as_deref(), path, locate, offset).await
}

/// [`read_task_output`] once the conversation is placed — the testable core.
async fn read_task_output_at(
    at: FilesAt,
    known_hosts: Option<&str>,
    path: Option<String>,
    locate: Option<TaskOutputLocator>,
    offset: Option<u64>,
) -> Result<Option<TaskOutputChunk>, FileReadError> {
    let nothing = || FileReadError::Refused {
        server: None,
        reason: "neither the output's path nor its task is known yet".to_string(),
    };
    match at {
        FilesAt::ThisMac => tokio::task::spawn_blocking(move || {
            use crate::supervisor::subagents::{locate_task_output, read_task_output_chunk, LOCAL_TASK_OUTPUT_MAX};
            let path = match (path, locate) {
                (Some(p), _) => p,
                (None, Some(l)) => match locate_task_output(&l.session_id, &l.task_id).map_err(FileReadError::local_io)? {
                    Some(p) => p,
                    None => return Ok(None), // not created yet (or cleaned up)
                },
                (None, None) => return Err(nothing()),
            };
            read_task_output_chunk(&path, offset, LOCAL_TASK_OUTPUT_MAX).map_err(FileReadError::local_io)
        })
        .await
        .map_err(|e| FileReadError::local_io(e.to_string()))?,
        FilesAt::Server(machine) => {
            let server = remote_files::Server { machine: &machine, known_hosts };
            let target = match (&path, &locate) {
                (Some(p), _) => remote_files::TaskOutputTarget::Path(p),
                (None, Some(l)) => remote_files::TaskOutputTarget::Locate(l),
                (None, None) => return Err(nothing()),
            };
            remote_files::read_task_output(&server, target, offset).await
        }
    }
}

/// Total time the live-session fast path of [`get_plan_usage`] may spend across ALL the
/// Claude sessions it asks — the same budget a single `get_usage` query already has, so
/// walking several handles never costs the UI more than asking one did.
const LIVE_USAGE_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

/// Fetch the real subscription usage percentages (5h + weekly windows). The stream
/// only carries a coarse rate-limit status, so this replicates the CLI's internal
/// `GET /api/oauth/usage` (OAuth token read from `~/.claude/.credentials.json` then
/// the macOS Keychain). Read-only — never refreshes/writes the token. Account-global
/// (not per-session); on error the UI degrades to the coarse `rate_limit` status. The
/// endpoint is itself rate-limited, so the caller throttles (poll + on-open + manual).
/// Errors are typed ([`UsageError`]) so the UI can show a tailored next step.
#[tauri::command]
#[specta::specta]
pub async fn get_plan_usage(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, Sessions>,
    account_id: Option<String>,
) -> Result<PlanUsage, UsageError> {
    // Prefer a LIVE session's `get_usage` control request: same numbers, but with no
    // OAuth token and no Keychain read — which is precisely what makes it immune to the
    // stale `~/.claude/.credentials.json` that shadows a fresh Keychain token and 401s
    // the HTTP path.
    //
    // Only CLAUDE sessions are asked: `get_usage` is a Claude control request that the
    // Codex actor cannot serve. Picking whatever handle the registry yielded first meant
    // that, with one Claude and one Codex conversation open, the Codex handle could win
    // the draw — the fast path failed and the stale-credentials account silently fell
    // through to the very HTTP 401 this path exists to avoid, differently on each run.
    // The whole fast path shares ONE deadline (matching a single query's own timeout):
    // trying the next Claude session costs nothing when a handle is dead, and an
    // unresponsive CLI still can't make the UI wait out a timeout per session.
    //
    // The HTTP path is deliberately KEPT rather than replaced: sessions spawn lazily, so
    // with no conversation running there is nobody to ask — and the binary marks
    // `get_usage` "Experimental — the response shape may change", so a drift there must
    // degrade to the endpoint instead of blanking the meter.
    let deadline = tokio::time::Instant::now() + LIVE_USAGE_BUDGET;
    // Only sessions running on THIS account can answer for it — see `claude_handles_for`.
    // An account with no live session simply has no fast path and goes straight to HTTP,
    // which is the normal case for every account other than the one being worked in.
    for handle in sessions.claude_handles_for(account_id.as_deref()) {
        // Err = the budget ran out, the session is gone, or the CLI refused/garbled the
        // query. None = a payload we can't read (the documented "experimental shape may
        // drift" case). Either way another live Claude session may still answer.
        if let Ok(Ok(line)) = tokio::time::timeout_at(deadline, handle.plan_usage_payload()).await {
            if let Some(usage) = crate::usage::plan_usage_from_control_response(&line) {
                return Ok(usage);
            }
        }
    }
    // HTTP fallback, scoped to the same account: it reads that slot's credentials file /
    // Keychain item, so it answers for the account asked about and never for another.
    let slot = claude_slot(&app, account_id.as_deref()).map_err(|detail| {
        // An unknown account is a permanent, local cause — never a network blip, which the
        // front would retry forever. The one other way `claude_slot` fails (the store could
        // not be read) stays a transient `Network`.
        match account_id.clone() {
            Some(id) if detail.starts_with("unknown Claude account") => {
                UsageError::UnknownAccount { account_id: id }
            }
            _ => UsageError::Network { detail },
        }
    })?;
    crate::usage::fetch_plan_usage_for(&slot).await
}

/// Edit › Undo / Redo the app cannot do from the page: the standard `undo:` / `redo:` up the
/// key window's responder chain. The front asks for it when the keyboard is in a frame of its
/// own (an artifact preview's sandboxed `<iframe>`), which `document.execCommand` cannot reach.
/// See [`crate::edit_menu`].
#[tauri::command]
#[specta::specta]
pub async fn edit_menu_native(
    app: tauri::AppHandle,
    action: crate::edit_menu::EditAction,
) -> Result<(), String> {
    crate::edit_menu::native(&app, action)
}

/// Hold or release the app-wide macOS keep-awake assertion. The FRONT owns the policy
/// (the Caffeinate on/off toggle + the Light/Hard mode + fleet activity) and pushes the
/// computed desired state here; the core just spawns/kills the single managed `caffeinate`
/// child. Idempotent. Returns `Err` when asked to hold and the spawn fails, so the front
/// can surface "the Mac may sleep" rather than the failure being an invisible core-side
/// log — otherwise the toggle would read "on" while the Mac quietly sleeps. See
/// [`crate::power`].
#[tauri::command]
#[specta::specta]
pub fn set_awake(
    power: tauri::State<'_, crate::power::Caffeinate>,
    awake: bool,
) -> Result<(), String> {
    power.set_awake(awake)
}

/// The real state of the closed-lid keep-awake (`pmset disablesleep`): whether the one-time
/// authorization is installed, whether sleep is disabled system-wide right now, whether
/// Flight Deck owns that. Shell-outs → off the async runtime. Never errors: a probe that
/// cannot run is reported inside the status. See [`crate::power::SleepLock`].
#[tauri::command]
#[specta::specta]
pub async fn sleep_lock_status(
    lock: tauri::State<'_, std::sync::Arc<crate::power::SleepLock>>,
) -> Result<crate::power::SleepLockStatus, String> {
    let lock = lock.inner().clone();
    tokio::task::spawn_blocking(move || lock.status())
        .await
        .map_err(|e| format!("status task failed: {e}"))
}

/// Converge the closed-lid flag to `on`. Same contract as `set_awake` (front-owned policy,
/// idempotent, pushed on every change + heartbeat), but it returns the REAL state after the
/// attempt and errors when the flag could not be set (authorization missing or revoked), so
/// the front falls back to `caffeinate` and tells the user. Releasing a flag we do not own
/// is a no-op.
#[tauri::command]
#[specta::specta]
pub async fn set_sleep_disabled(
    lock: tauri::State<'_, std::sync::Arc<crate::power::SleepLock>>,
    on: bool,
) -> Result<crate::power::SleepLockStatus, String> {
    let lock = lock.inner().clone();
    tokio::task::spawn_blocking(move || lock.set(on))
        .await
        .map_err(|e| format!("set task failed: {e}"))?
}

/// Install the one-time closed-lid authorization (the `/etc/sudoers.d/flightdeck` rule)
/// through the macOS administrator sheet. Blocks (off-thread) until the sheet is answered;
/// a cancelled sheet is an error. Returns the re-probed state.
#[tauri::command]
#[specta::specta]
pub async fn install_sleep_lock_grant(
    lock: tauri::State<'_, std::sync::Arc<crate::power::SleepLock>>,
) -> Result<crate::power::SleepLockStatus, String> {
    let lock = lock.inner().clone();
    tokio::task::spawn_blocking(move || lock.install_grant())
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

/// Remove the closed-lid authorization through the administrator sheet, re-enabling sleep
/// first if Flight Deck had disabled it.
#[tauri::command]
#[specta::specta]
pub async fn remove_sleep_lock_grant(
    lock: tauri::State<'_, std::sync::Arc<crate::power::SleepLock>>,
) -> Result<crate::power::SleepLockStatus, String> {
    let lock = lock.inner().clone();
    tokio::task::spawn_blocking(move || lock.remove_grant())
        .await
        .map_err(|e| format!("remove task failed: {e}"))?
}

/// Battery / power-source snapshot (`pmset -g batt`) for the closed-lid battery floor.
#[tauri::command]
#[specta::specta]
pub async fn power_source() -> Result<crate::power::PowerSource, String> {
    tokio::task::spawn_blocking(crate::power::SleepLock::power_source)
        .await
        .map_err(|e| format!("power source task failed: {e}"))?
}

/// Read the Claude CLI (`claude` binary) update status: installed + latest published version,
/// whether an update is available, and the auto-updater config. BEST-EFFORT (never errors): a
/// missing binary → `installed_version: None`, offline → `latest_version: None`, so the panel
/// always renders. Distinct from the app's own updater (`tauri-plugin-updater`) — this manages
/// the piloted `claude` binary. See [`crate::cli_update`].
#[tauri::command]
#[specta::specta]
pub async fn claude_cli_status() -> crate::cli_update::ClaudeCliStatus {
    crate::cli_update::status().await
}

/// Run `claude update` (check + install in one shot — the CLI has no check-only mode) and
/// report the outcome. Bounded so a wedged download can't hang. `Err` only when the process
/// couldn't run / timed out / exited non-zero.
#[tauri::command]
#[specta::specta]
pub async fn claude_cli_update() -> Result<crate::cli_update::ClaudeUpdateOutcome, String> {
    crate::cli_update::run_update().await
}

/// Flip the Claude CLI's background auto-updater (`enabled == true` → auto-update ON) by
/// writing `env.DISABLE_AUTOUPDATER` in `~/.claude/settings.json`, through the single
/// settings.json writer (`extensions`) so the atomic/anti-race discipline holds. Blocking file
/// IO is deported off the async runtime. While `auto_update_locked` is set (the `~/.claude.json`
/// gate, which we never write) only the DISABLE direction still bites — `enabled == true` writes
/// fine but cannot re-enable anything, so the UI disables the switch in that case.
#[tauri::command]
#[specta::specta]
pub async fn set_claude_cli_auto_update(enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::extensions::set_claude_auto_update(enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Send a user turn to a session: the typed `text` plus any joined `images`. For Claude
/// the images are inline `image` blocks; for Codex they become `localImage` file inputs.
/// `codex_controls` carries this conversation's composer controls (model / effort /
/// approval / sandbox / …) applied as per-turn overrides — `None`/ignored for Claude,
/// whose controls are pushed the moment they change.
#[tauri::command]
#[specta::specta]
pub async fn send_message(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    text: String,
    images: Vec<ImageAttachment>,
    codex_controls: Option<codex::CodexControls>,
) -> Result<String, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    // The returned uuid identifies THIS message on the wire. The UI keeps it on the
    // turn so a message still sitting in the binary's queue can be dropped individually
    // (`cancel_async_message`) — the only way to cancel one specific queued message
    // rather than "the last thing sent". Codex sessions return one too; it is unused
    // there, which keeps a single send path for both backends.
    handle
        .send_user(text, images, codex_controls)
        .await
        .map_err(|e| e.to_string())
}

/// Answer a pending `can_use_tool` permission prompt (allow / deny).
#[tauri::command]
#[specta::specta]
pub async fn answer_permission(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .answer_permission(request_id, decision)
        .await
        .map_err(|e| e.to_string())
}

/// Switch the session's permission mode at runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_permission_mode(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    mode: PermissionMode,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .set_permission_mode(mode)
        .await
        .map_err(|e| e.to_string())
}

/// Switch the session's active model at runtime (`set_model`).
#[tauri::command]
#[specta::specta]
pub async fn set_model(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    model: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.set_model(model).await.map_err(|e| e.to_string())
}

/// Enable or disable this session's Remote Control bridge — the native Claude Code
/// `/remote-control` — via a `remote_control` control request. On enable the binary
/// mirrors the session to claude.ai/code + the Claude mobile app and returns the
/// `session_url` (surfaced in the returned state so the UI can offer "open in
/// browser"); messages sent from those surfaces then arrive inline on this session's
/// normal stream. `name` optionally labels the session. Errors "unknown session" when
/// the conversation has no live `claude` process (the front spawns one first).
#[tauri::command]
#[specta::specta]
pub async fn set_remote_control(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    enabled: bool,
    name: Option<String>,
) -> Result<crate::supervisor::model::RemoteControlState, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .set_remote_control(enabled, name)
        .await
        .map_err(|e| e.to_string())
}

/// Set the session's reasoning effort level at runtime (`apply_flag_settings`).
/// Rejects an invalid level BEFORE sending: the CLI silently swallows anything
/// outside low/medium/high/xhigh/max, so an unvalidated value would no-op without
/// any error — exactly the silent failure we must avoid. (Per-model gating — e.g.
/// `max`/`xhigh` not on every model — is the front-end gauge's job; this guard only
/// rejects values the wire never accepts.)
#[tauri::command]
#[specta::specta]
pub async fn set_effort_level(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    level: String,
) -> Result<(), String> {
    if !control::is_valid_effort_level(&level) {
        return Err(format!(
            "invalid effort level \"{level}\" (expected: low, medium, high, xhigh, max)"
        ));
    }
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .set_effort_level(level)
        .await
        .map_err(|e| e.to_string())
}

/// Switch "ultracode" (standing dynamic-workflow orchestration) on or off at runtime.
/// Independent of the effort level since CLI 2.1.284: neither touches the other.
#[tauri::command]
#[specta::specta]
pub async fn set_ultracode(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    enabled: bool,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.set_ultracode(enabled).await.map_err(|e| e.to_string())
}

/// Ask the binary to generate a short conversation title from `description` (the
/// user's accumulated messages so far), like the official VS Code extension. `seq` is
/// a monotonic per-conversation tag echoed back in the `SessionTitleEvent` so the
/// front can drop an out-of-order (stale) response. Fire-and-forget: the title comes
/// back asynchronously as a `SessionTitleEvent`, which the front applies as the
/// conversation name (unless the user set a custom title meanwhile). A generation
/// failure is swallowed in the core — the front keeps its placeholder / last title.
#[tauri::command]
#[specta::specta]
pub async fn generate_conversation_title(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    description: String,
    seq: u32,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .generate_title(description, seq)
        .await
        .map_err(|e| e.to_string())
}

/// Ask the binary to summarize the user's LAST message in a few words (≤6) — a distinct
/// routing over the same `generate_session_title` wire as [`generate_conversation_title`],
/// but fed ONLY that one message (not the accumulated intent). `seq` is a monotonic
/// per-conversation tag echoed back in the `SessionSummaryEvent` so the front drops a
/// stale (superseded) response. Fire-and-forget: the summary comes back asynchronously
/// as a `SessionSummaryEvent`, shown on the Flight Deck card. A generation failure is
/// swallowed in the core — the front keeps its optimistic truncation of the message.
#[tauri::command]
#[specta::specta]
pub async fn generate_message_summary(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    text: String,
    seq: u32,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .generate_summary(text, seq)
        .await
        .map_err(|e| e.to_string())
}

/// Retry every REMOTE session's lost link NOW rather than at the end of its backoff —
/// fired by the front when the Mac's network comes back or the user returns to the app
/// (see `SessionCommand::ReconnectNow`). Cheap and idempotent: an attached session, which
/// is not waiting out a backoff, ignores it. A session that closed meanwhile is skipped.
#[tauri::command]
#[specta::specta]
pub async fn reconnect_remote_sessions(sessions: tauri::State<'_, Sessions>) -> Result<(), String> {
    for handle in sessions.remote_handles() {
        let _ = handle.reconnect_now().await;
    }
    Ok(())
}

/// Interrupt the current turn (without killing the process).
#[tauri::command]
#[specta::specta]
pub async fn interrupt_session(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.interrupt().await.map_err(|e| e.to_string())
}

/// Stop ONE background task (a `run_in_background` Bash / Monitor / sub-agent) by its
/// `task_id`, without ending the turn or the session. Sends a `stop_task` control
/// request; the task then settles to `stopped` via its normal `task_*` lifecycle
/// (surfaced to the UI through `session_task`). No-op if the session is no longer live.
#[tauri::command]
#[specta::specta]
pub async fn stop_task(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    task_id: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.stop_task(task_id).await.map_err(|e| e.to_string())
}

/// The live model catalogue of a running session (`list_models`): what the binary will
/// actually accept, after the provider, the settings cascade and the org enforcement
/// policy. Errors with "unknown session" when nothing is live.
///
/// ⚠️ NOT wired to the model picker, on purpose. It was, and the result was rejected on
/// sight: the binary returns a CLI-shaped menu — a "Default (recommended)" row, plus the
/// same model listed twice under its alias and its `[1m]` variant — which reads worse
/// than our four curated rows (see `modelsForPicker`). What stays valuable here is the
/// per-model data no static table can hold: `supported_effort_levels` (the effort ladder
/// is hard-coded today and drifts with each model launch) and `resolved_model`, whose
/// `[1m]` suffix is the only wire signal of the 1M context window.
#[tauri::command]
#[specta::specta]
pub async fn list_session_models(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<Vec<crate::supervisor::model::LiveModel>, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.list_models().await.map_err(|e| e.to_string())
}

/// Restore the files edited since a user message, from the binary's own checkpoints
/// (`rewind_files`). Call with `dry_run: true` FIRST to preview which files and how
/// many lines would change — the app never performs a destructive restore without
/// showing that preview. A refusal (checkpointing disabled, no checkpoint for this
/// message) comes back inside the result as `can_rewind: false` + `error`, never as a
/// silent no-op.
#[tauri::command]
#[specta::specta]
pub async fn rewind_files(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    user_message_id: String,
    dry_run: bool,
) -> Result<crate::supervisor::model::RewindFilesResult, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .rewind_files(user_message_id, dry_run)
        .await
        .map_err(|e| e.to_string())
}

/// Drop ONE specific still-queued user message from the binary's command queue, by the
/// uuid `send_message` returned for it. This is what backs "remove this pending message"
/// on a message queued behind a running turn.
///
/// ⚠️ ONLY for a message still WAITING behind another turn. Cancelling one whose own turn
/// has already started answers `cancelled:false` and WEDGES the session (verified on the
/// wire: the turn stops producing and never emits its `result`).
///
/// `false` = the binary did not remove it (already dequeued for execution, or never
/// queued). The caller must NOT take the bubble away on `false`: the message is on its
/// way to the model and will be answered.
#[tauri::command]
#[specta::specta]
pub async fn cancel_queued_message(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    message_uuid: String,
) -> Result<bool, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .cancel_async_message(message_uuid)
        .await
        .map_err(|e| e.to_string())
}

/// Query a running session's LIVE MCP server status (real connection state +
/// tools per server) via the `mcp_status` control request — the authoritative
/// source the conversation view uses (NOT the stale `system/init` snapshot).
/// Errors with "unknown session" when the conversation has no live `claude`
/// process; the UI then falls back to the configured view.
#[tauri::command]
#[specta::specta]
pub async fn mcp_status(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<Vec<crate::supervisor::model::McpServerLive>, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.mcp_status().await.map_err(|e| e.to_string())
}

/// Replace a RUNNING conversation's own overrides — MCP rules and plugin on/off, in its
/// flag settings layer (never a file, so no other conversation sees them). Rules bite from
/// its next tool call; `reload_plugins` hot-applies a plugin change. A CLI rejection is
/// returned, not swallowed.
#[tauri::command]
#[specta::specta]
pub async fn apply_session_overrides(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    overrides: crate::supervisor::model::SessionOverrides,
    reload_plugins: bool,
) -> Result<(), String> {
    overrides.validate()?;
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .apply_session_overrides(&overrides, reload_plugins)
        .await
        .map_err(|e| e.to_string())
}

/// The MCP servers (cloud connectors included) and their tools as a FRESH, conversation-
/// less `claude` sees them — what the global Settings page lists. A throwaway process in
/// the home directory, polled until the connectors settle (they connect asynchronously,
/// a few seconds after start) or ~15 s pass; no model turn, no tokens.
#[tauri::command]
#[specta::specta]
pub async fn fetch_global_mcp_status() -> Result<Vec<crate::supervisor::model::McpServerLive>, String> {
    use crate::supervisor::control;
    use crate::supervisor::protocol::CliMessage;
    use crate::supervisor::transport::Transport;

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("home directory ($HOME) not found")?;
    let (mut transport, mut rx) = Transport::spawn(SpawnConfig::new(home)).map_err(|e| e.to_string())?;
    transport
        .send_line(control::initialize_request("tosse-mcp-init", &[]))
        .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut latest: Option<Vec<crate::supervisor::model::McpServerLive>> = None;
    let mut round = 0u32;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        round += 1;
        let rid = format!("tosse-mcp-status-{round}");
        if transport.send_line(control::mcp_status_request(&rid)).is_err() {
            break;
        }
        let answer = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(msg) = rx.recv().await {
                if let CliMessage::ControlResponse(v) = msg {
                    if v.get("response").and_then(|r| r.get("request_id")).and_then(|x| x.as_str())
                        == Some(rid.as_str())
                    {
                        return Some(v);
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten();
        let Some(v) = answer else { break };
        let servers = control::parse_mcp_status(&v);
        let settled = !servers.is_empty() && servers.iter().all(|s| s.status != "pending");
        latest = Some(servers);
        if settled {
            break;
        }
    }
    transport.shutdown(false).await;
    latest.ok_or_else(|| "the Claude CLI did not report its MCP servers".to_string())
}

/// Enable/disable a live MCP server in a running session (`mcp_toggle`). Optimistic
/// — returns once sent; the UI re-polls `mcp_status` to reflect the new state, and a
/// CLI rejection surfaces as a timeline control error.
#[tauri::command]
#[specta::specta]
pub async fn mcp_toggle(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    server_name: String,
    enabled: bool,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.mcp_toggle(server_name, enabled).await.map_err(|e| e.to_string())
}

/// Reconnect a live MCP server (`mcp_reconnect`) — after a failure or once auth is
/// granted. Optimistic; the UI re-polls `mcp_status`.
#[tauri::command]
#[specta::specta]
pub async fn mcp_reconnect(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    server_name: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.mcp_reconnect(server_name).await.map_err(|e| e.to_string())
}

/// Forget a live MCP server's stored OAuth credentials (`mcp_clear_auth`).
#[tauri::command]
#[specta::specta]
pub async fn mcp_clear_auth(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    server_name: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.mcp_clear_auth(server_name).await.map_err(|e| e.to_string())
}

/// Start the OAuth flow for a live MCP server (`mcp_authenticate`). Returns the
/// `authUrl` to open in the browser (the front opens it) and whether the user must
/// finish a manual callback. Errors with "unknown session" when there's no live
/// process.
#[tauri::command]
#[specta::specta]
pub async fn mcp_authenticate(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    server_name: String,
) -> Result<crate::supervisor::model::McpAuthResult, String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.mcp_authenticate(server_name).await.map_err(|e| e.to_string())
}

/// Tear a session down and remove it from the registry.
#[tauri::command]
#[specta::specta]
pub async fn stop_session(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    if let Some(handle) = sessions.remove(&session) {
        // Wait for the process to be FULLY reaped (not just for the Shutdown command to be
        // enqueued): a rewind truncates the transcript right after stopping the session and
        // must not race a still-alive `claude` writer. Ignore a closed channel / timeout —
        // the actor may have already exited on its own, in which case it's stopped anyway.
        // The user's explicit Stop: a remote session's server-side claude is
        // stopped too (fd_stop), not merely detached.
        let _ = handle.shutdown_and_wait_stopping().await;
    }
    Ok(())
}

/// Open the OS terminal on this conversation: resume it as an interactive CLI session
/// in its working directory — `claude --resume <id>` for a Claude conversation,
/// `codex resume <id>` for a Codex one. Backend-aware because the two CLIs take a
/// DIFFERENT resume syntax and a Codex `<id>` handed to `claude` (or vice-versa) opens a
/// fresh empty session ("wrong id"). Both resume from the CLI's OWN on-disk history, so
/// no live process is needed.
///
/// This launches a *separate*, user-driven CLI outside the app — the same session/thread
/// id the supervisor drives. macOS only for now (drives Terminal.app via AppleScript);
/// other platforms return an error the UI can surface. The blocking `osascript` call runs
/// off the async runtime via `spawn_blocking`.
#[tauri::command]
#[specta::specta]
pub async fn open_in_terminal(
    cwd: String,
    session_id: String,
    backend: Backend,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_terminal_resume(&cwd, &session_id, backend))
        .await
        .map_err(|e| e.to_string())?
}

/// Build the CLI's OWN resume invocation for `backend`, resolving the SAME binary the
/// supervisor spawns (honouring the `$TOSSE_*_BIN` override). `claude --resume <id>` vs
/// `codex resume <id>` — the id is identical (Claude session id == Codex thread id), only
/// the CLI syntax differs, so a Codex id handed to `claude` (the old bug) opens a fresh
/// empty session. macOS-gated like the rest of the terminal-resume path (`sh_quote`), and
/// unit-tested there.
#[cfg(target_os = "macos")]
fn resume_invocation(backend: Backend, session_id: &str) -> String {
    match backend {
        Backend::Claude => {
            let bin = std::env::var("TOSSE_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
            format!("{} --resume {}", sh_quote(&bin), sh_quote(session_id))
        }
        Backend::Codex => {
            let bin = crate::supervisor::codex::default_codex_bin()
                .to_string_lossy()
                .into_owned();
            format!("{} resume {}", sh_quote(&bin), sh_quote(session_id))
        }
    }
}

#[cfg(target_os = "macos")]
fn open_terminal_resume(cwd: &str, session_id: &str, backend: Backend) -> Result<(), String> {
    let resume_cmd = resume_invocation(backend, session_id);
    // The resume is scoped to the current PROJECT, which the CLI derives from the working
    // directory. So the terminal must `cd` into the exact directory the session was
    // spawned in — otherwise resume finds nothing and opens a fresh, empty session. A
    // relative cwd (e.g. "." for the default local project) is resolved against the app
    // process's own working directory: the same base the supervisor passed to
    // `current_dir` at spawn, so the resumed project matches.
    let cwd_abs = resolve_cwd(cwd);
    // The command Terminal.app runs in a fresh login shell. No `exec`: when the CLI
    // exits the user is left at a usable prompt rather than a dead tab.
    let shell_cmd = format!("cd {} && {}", sh_quote(&cwd_abs), resume_cmd);
    let script = format!(
        "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
        applescript_escape(&shell_cmd),
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|e| format!("failed to launch osascript: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("osascript exited with {status}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_terminal_resume(_cwd: &str, _session_id: &str, _backend: Backend) -> Result<(), String> {
    Err(OPEN_IN_TERMINAL_UNAVAILABLE.unwrap_or("\"Open in terminal\" is unavailable").to_string())
}

/// Why "Open in terminal" is unavailable in this build, or `None` where it works (macOS,
/// through Terminal.app). Not on Linux yet: every terminal emulator takes its command
/// differently, and a launcher cannot be checked without a Linux desktop.
const OPEN_IN_TERMINAL_UNAVAILABLE: Option<&str> = if cfg!(target_os = "macos") {
    None
} else if cfg!(target_os = "linux") {
    Some(
        "Not available on Linux yet. The terminal in the side panel can resume the session \
         instead (claude --resume or codex resume).",
    )
} else {
    Some(
        "Not available on this platform yet. The terminal in the side panel can resume the \
         session instead (claude --resume or codex resume).",
    )
};

/// Features this build cannot offer on the OS it runs on, each with the reason shown beside
/// the greyed control — `None` where the feature works. Every field is `None` on macOS.
/// Constants of the build, read once by the front at launch.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PlatformLimits {
    /// Keep-awake (every Caffeinate mode). See [`crate::power::KEEP_AWAKE_UNAVAILABLE`].
    pub keep_awake: Option<String>,
    /// The title-bar "Open in terminal" action.
    pub open_in_terminal: Option<String>,
    /// Why a successful "open in the browser" proves nothing here. On Linux the opener hands
    /// the URL to a detached launcher (`gio`, `xdg-open`) and reports success before any
    /// browser opens — with no browser at all, the launcher fails afterwards, unseen. Sign-in
    /// flows then always show their link next to the code box instead of only on an error.
    pub browser_open_unconfirmed: Option<String>,
}

/// Linux's reason for [`PlatformLimits::browser_open_unconfirmed`]; `None` elsewhere, where
/// the opener's result is the browser's.
const BROWSER_OPEN_UNCONFIRMED: Option<&str> = if cfg!(target_os = "linux") {
    Some("Flight Deck can't tell whether a browser actually opened.")
} else {
    None
};

/// What this build cannot offer on this OS (see [`PlatformLimits`]).
#[tauri::command]
#[specta::specta]
pub fn platform_limits() -> PlatformLimits {
    PlatformLimits {
        keep_awake: crate::power::KEEP_AWAKE_UNAVAILABLE.map(str::to_string),
        open_in_terminal: OPEN_IN_TERMINAL_UNAVAILABLE.map(str::to_string),
        browser_open_unconfirmed: BROWSER_OPEN_UNCONFIRMED.map(str::to_string),
    }
}

/// Turn a possibly-relative conversation cwd into an absolute path. Relative
/// paths (notably "." for the default local project) are joined onto the app
/// process's current working directory — the exact base the supervisor used when
/// it spawned the session — so `claude --resume` lands in the matching project.
#[cfg(target_os = "macos")]
fn resolve_cwd(cwd: &str) -> String {
    let p = std::path::Path::new(cwd);
    if p.is_absolute() {
        return cwd.to_string();
    }
    match std::env::current_dir() {
        Ok(base) => base.join(p).to_string_lossy().into_owned(),
        Err(_) => cwd.to_string(),
    }
}

/// POSIX single-quote `s` for safe embedding in a `/bin/sh` command line: wrap
/// in `'…'`, and turn any inner `'` into `'\''`.
#[cfg(target_os = "macos")]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Escape `s` for embedding inside an AppleScript double-quoted string literal
/// (backslash, then double-quote).
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Bounce the app's Dock icon (macOS) / flash the taskbar (other platforms) to
/// get the user's attention when an agent finishes or needs input while the app
/// is in the background. `critical` bounces repeatedly until the app is focused
/// (a permission/question is waiting); otherwise it bounces once (a turn ended).
/// The OS clears the request automatically when the window regains focus, so the
/// front never has to cancel it. A no-op if the main window is gone.
#[tauri::command]
#[specta::specta]
pub fn request_user_attention(app: tauri::AppHandle, critical: bool) -> Result<(), String> {
    // ⚠️ `get_window`, NOT `get_webview_window`: once the artifact host adds its child webview,
    // the main window is multi-webview and `get_webview_window("main")` returns None — this would
    // silently stop bouncing the Dock. See `crate::artifact_host`.
    let Some(window) = app.get_window("main") else {
        return Ok(()); // window already closed — nothing to flash
    };
    let kind = if critical {
        tauri::UserAttentionType::Critical
    } else {
        tauri::UserAttentionType::Informational
    };
    window
        .request_user_attention(Some(kind))
        .map_err(|e| e.to_string())
}

/// The widest zoom factor the webview will be asked for — the front's ladder
/// (`src/ui/zoom.ts`) stays well inside this. These are a BACKSTOP, not the product
/// range: `setPageZoom(0)` (or a NaN) would leave the window unreadable with no way
/// back through the UI, so a nonsense factor is refused here rather than applied.
const MIN_UI_ZOOM: f64 = 0.25;
const MAX_UI_ZOOM: f64 = 4.0;

/// Scale the whole interface by `factor` (1.0 = 100 %), the way a browser's ⌘+ does:
/// this drives the OS webview's own page zoom (WKWebView `pageZoom` on macOS), so
/// every pixel of the UI — thread, Flight Deck, Monaco, xterm, PDF viewer, popovers —
/// scales together and each surface re-layouts from its own size observer.
///
/// The zoom is NOT persisted by the webview: the front holds it in its display prefs
/// and re-applies it on mount (see `ZoomHost`). A no-op if the main window is gone.
#[tauri::command]
#[specta::specta]
pub fn set_ui_zoom(app: tauri::AppHandle, factor: f64) -> Result<(), String> {
    if !factor.is_finite() || !(MIN_UI_ZOOM..=MAX_UI_ZOOM).contains(&factor) {
        return Err(format!("zoom factor out of range: {factor}"));
    }
    // ⚠️ `get_webview("main")`, NOT `get_webview_window`: once the artifact host adds its child
    // webview, `get_webview_window("main")` returns None and the zoom would silently stop
    // applying. Scaling the MAIN webview only — the host follows via `artifact_host_show`.
    let Some(webview) = app.get_webview("main") else {
        return Ok(()); // window already closed — nothing to scale
    };
    webview.set_zoom(factor).map_err(|e| e.to_string())
}

// ---- Git worktrees --------------------------------------------------------
//
// These commands are the front's single boundary to git worktree management.
// They forward to [`crate::git`] (the only service that speaks `git`) and run
// the blocking subprocess off the async runtime via `spawn_blocking`, so a slow
// disk never stalls the event loop.

/// List every worktree of the repository `repo_path` lives in (main first).
#[tauri::command]
#[specta::specta]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<crate::git::WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || crate::git::list_worktrees(&repo_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Working-tree status of one worktree (dirty / untracked / ahead-behind).
#[tauri::command]
#[specta::specta]
pub async fn worktree_status(worktree_path: String) -> Result<crate::git::WorktreeStatus, String> {
    tokio::task::spawn_blocking(move || crate::git::worktree_status(&worktree_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Create a worktree for `branch` (new branch off `base_ref` when `new_branch`,
/// else an existing branch). Returns the created worktree's info.
#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    repo_path: String,
    branch: String,
    base_ref: Option<String>,
    new_branch: bool,
) -> Result<crate::git::WorktreeInfo, String> {
    tokio::task::spawn_blocking(move || {
        crate::git::create_worktree(&repo_path, &branch, base_ref.as_deref(), new_branch)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Remove a worktree. `git` refuses a dirty or main worktree unless `force`,
/// which the UI only passes after an explicit, separate confirmation.
#[tauri::command]
#[specta::specta]
pub async fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::git::remove_worktree(&repo_path, &worktree_path, force)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Whether a filesystem path currently exists. Used to detect a conversation
/// whose worktree cwd was removed, so the UI can fall back to the repo's main
/// checkout instead of failing to spawn `claude` in a directory that is gone.
#[tauri::command]
#[specta::specta]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// ---- Git history / source control -----------------------------------------
//
// The front's single boundary to the repository's history and working-tree
// state. Like the worktree commands they forward to [`crate::git`] (the only
// service that speaks `git`) and run the blocking subprocess off the async
// runtime via `spawn_blocking`. `cwd` is the conversation's LIVE working
// directory (it follows EnterWorktree/ExitWorktree), so every op is scoped to
// the worktree the user is actually looking at.

/// Working-tree status: current branch, ahead/behind, and changed files.
#[tauri::command]
#[specta::specta]
pub async fn git_status(cwd: String) -> Result<crate::git::GitStatus, String> {
    tokio::task::spawn_blocking(move || crate::git::status(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Diff of one working-tree file against HEAD (old = HEAD, new = on-disk),
/// for the source-control view's diff editor.
#[tauri::command]
#[specta::specta]
pub async fn git_diff(
    cwd: String,
    path: String,
    orig_path: Option<String>,
) -> Result<crate::git::GitDiff, String> {
    tokio::task::spawn_blocking(move || crate::git::diff_worktree(&cwd, &path, orig_path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// A page of commit history across all refs (for the graph / git tree).
#[tauri::command]
#[specta::specta]
pub async fn git_log(
    cwd: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<crate::git::CommitInfo>, String> {
    tokio::task::spawn_blocking(move || crate::git::log(&cwd, limit, skip))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Local + remote-tracking branches with their upstream tracking counts.
#[tauri::command]
#[specta::specta]
pub async fn git_branches(cwd: String) -> Result<Vec<crate::git::BranchInfo>, String> {
    tokio::task::spawn_blocking(move || crate::git::branches(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Files changed by a single commit (name-status vs its first parent).
#[tauri::command]
#[specta::specta]
pub async fn git_commit_files(
    cwd: String,
    oid: String,
) -> Result<Vec<crate::git::CommitFile>, String> {
    tokio::task::spawn_blocking(move || crate::git::commit_files(&cwd, &oid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Diff of one file introduced by a commit (old = parent, new = commit).
#[tauri::command]
#[specta::specta]
pub async fn git_commit_file_diff(
    cwd: String,
    oid: String,
    path: String,
    orig_path: Option<String>,
) -> Result<crate::git::GitDiff, String> {
    tokio::task::spawn_blocking(move || {
        crate::git::commit_file_diff(&cwd, &oid, &path, orig_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Stage all changes and commit them with `message`. Returns the new short oid.
#[tauri::command]
#[specta::specta]
pub async fn git_commit(cwd: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::git::commit(&cwd, &message))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Push the current branch to its upstream.
#[tauri::command]
#[specta::specta]
pub async fn git_push(cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::git::push(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Pull the current branch (`--ff-only`).
#[tauri::command]
#[specta::specta]
pub async fn git_pull(cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::git::pull(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Fetch all remotes (with prune).
#[tauri::command]
#[specta::specta]
pub async fn git_fetch(cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::git::fetch(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// ---- Editor filesystem ----------------------------------------------------
//
// The front's single boundary to the editor's filesystem service. They forward
// to [`crate::fs`] (the only service that reads/writes files for the editor) and
// run the blocking IO off the async runtime via `spawn_blocking`. The tree is
// read one level at a time (lazy expansion), so even a huge repo only ever reads
// what the user actually opens.

/// List one directory level (dirs first, then files, alpha) for the file tree.
#[tauri::command]
#[specta::specta]
pub async fn read_dir(path: String) -> Result<Vec<crate::fs::FsEntry>, String> {
    tokio::task::spawn_blocking(move || crate::fs::read_dir(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Read a file into the editor (guards binary / oversize — see `fs::read_file`).
#[tauri::command]
#[specta::specta]
pub async fn read_file(path: String) -> Result<crate::fs::FileContent, String> {
    tokio::task::spawn_blocking(move || crate::fs::read_file(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Read an image file for the viewer, base64-encoded (see `fs::read_image`). The
/// front renders it as a `data:` URL instead of routing the file to Monaco.
#[tauri::command]
#[specta::specta]
pub async fn read_image(path: String) -> Result<crate::fs::ImageContent, String> {
    tokio::task::spawn_blocking(move || crate::fs::read_image(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Stat several paths at once (size + mtime, no bytes) so the editor can tell
/// which open tabs actually changed on disk before re-reading any of them.
#[tauri::command]
#[specta::specta]
pub async fn stat_files(paths: Vec<String>) -> Result<Vec<crate::fs::FileStat>, String> {
    tokio::task::spawn_blocking(move || crate::fs::stat_files(&paths))
        .await
        .map_err(|e| e.to_string())
}

/// Write the editor buffer back to disk (save).
#[tauri::command]
#[specta::specta]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::write_file(&path, &content))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Start (or replace) the live watch on `path` — the editor's current working
/// directory. Changes under it arrive as a debounced `FsChangeEvent`.
#[tauri::command]
#[specta::specta]
pub fn watch_dir(
    app: tauri::AppHandle,
    watcher: tauri::State<'_, crate::fs::FsWatcher>,
    path: String,
) -> Result<(), String> {
    watcher
        .watch(app, PathBuf::from(path))
        .map_err(|e| e.to_string())
}

/// Stop the live filesystem watch (editor panel closed / no conversation shown).
#[tauri::command]
#[specta::specta]
pub fn unwatch_dir(watcher: tauri::State<'_, crate::fs::FsWatcher>) -> Result<(), String> {
    watcher.unwatch();
    Ok(())
}

// ---- Editor filesystem: mutating tree ops (the explorer's context menu) -----
//
// New file / new folder / rename / copy / delete, all forwarding to [`crate::fs`]
// (the one filesystem service) off the async runtime. The live watcher echoes the
// change back as an `FsChangeEvent`, so the tree refreshes itself — these commands
// just perform the mutation. Create/rename/copy refuse to clobber; delete is the
// safe kind (moves to the OS trash, recoverable).

/// Create an empty file at `path` (explorer "New File"). Errors if the name exists.
#[tauri::command]
#[specta::specta]
pub async fn create_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::create_file(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Create a new directory at `path` (explorer "New Folder"). Errors if it exists.
#[tauri::command]
#[specta::specta]
pub async fn create_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::create_dir(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Rename / move `from` to `to` (explorer "Rename", and the move half of cut +
/// paste). Refuses to overwrite an existing destination.
#[tauri::command]
#[specta::specta]
pub async fn rename_entry(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::rename(&from, &to))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Recursively copy `from` to `to` (the copy half of copy + paste). Refuses to
/// overwrite an existing destination; the front resolves a non-colliding name.
#[tauri::command]
#[specta::specta]
pub async fn copy_entry(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::copy_path(&from, &to))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Move `path` to the OS trash (explorer "Delete" — recoverable from the Finder),
/// never an irreversible unlink.
#[tauri::command]
#[specta::specta]
pub async fn delete_to_trash(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::fs::delete_to_trash(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Reveal `path` in the OS file manager (macOS Finder), selecting the item — the
/// explorer's "Reveal in Finder". Forwards to the opener plugin's native reveal.
#[tauri::command]
#[specta::specta]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// ---- Integrated terminal (PTY) --------------------------------------------
//
// The front's boundary to `terminal::Terminals` (the single PTY-speaking service).
// One terminal per conversation; output/exit come back as Tauri events.

/// Open (or replace) the integrated terminal `id`: spawn the user's login shell
/// under a PTY rooted at `cwd`, sized `cols`×`rows`. Output streams as
/// `TerminalOutputEvent`; the shell exiting fires `TerminalExitEvent`.
#[tauri::command]
#[specta::specta]
pub fn terminal_open(
    app: tauri::AppHandle,
    terminals: tauri::State<'_, crate::terminal::Terminals>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.open(app, id, cwd, cols, rows)
}

/// Feed keystrokes / pasted text to a terminal's shell.
#[tauri::command]
#[specta::specta]
pub fn terminal_write(
    terminals: tauri::State<'_, crate::terminal::Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    terminals.write(&id, &data)
}

/// Report a terminal's new grid size (xterm fitted to the panel).
#[tauri::command]
#[specta::specta]
pub fn terminal_resize(
    terminals: tauri::State<'_, crate::terminal::Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(&id, cols, rows)
}

/// Kill a terminal's shell and forget it.
#[tauri::command]
#[specta::specta]
pub fn terminal_close(
    terminals: tauri::State<'_, crate::terminal::Terminals>,
    id: String,
) -> Result<(), String> {
    terminals.close(&id);
    Ok(())
}

// ---- Extensions (MCP / plugins / skills / sub-agents) ----------------------
//
// Single boundary to [`crate::extensions`] — the only service that reads Claude's
// on-disk config. Returns the *configured* picture for a repo across scopes; the
// UI merges in live connection status from the running session's `system/init`.

/// List the configured extensions visible to the repository (or worktree) at
/// `repo_path`: MCP servers (+ enabled state), plugins, skills, sub-agents,
/// each tagged with its scope. Best-effort — never errors on missing config; the
/// blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn list_extensions(
    repo_path: String,
) -> Result<crate::extensions::ExtensionsSnapshot, String> {
    tokio::task::spawn_blocking(move || crate::extensions::list_extensions(&repo_path))
        .await
        .map_err(|e| e.to_string())
}

/// Enable or disable a plugin (by id `<plugin>@<marketplace>`) in the user's
/// `~/.claude/settings.json`. USER-GLOBAL toggle (not per-repo); takes effect on
/// the next (re)start of a conversation. The write is atomic and preserves every
/// other key. The blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_plugin_enabled(plugin_id: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::extensions::set_plugin_enabled(&plugin_id, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Read the user's persisted output style from `~/.claude/settings.json` `outputStyle`
/// (USER-GLOBAL — the CLI has no per-session style). Absent → `"default"`; a broken
/// settings.json errors rather than silently defaulting. The blocking IO runs off the
/// async runtime. The live/active style (what the running binary uses) travels separately
/// on `SessionStatePayload.output_style` from `system/init`.
#[tauri::command]
#[specta::specta]
pub async fn get_output_style() -> Result<String, String> {
    tokio::task::spawn_blocking(crate::extensions::read_output_style)
        .await
        .map_err(|e| e.to_string())?
}

/// Claude Code's own MCP rules and plugin on/off, from the managed, local, project
/// (`repo_path`) and user settings files — the baseline Flight Deck's cascade starts from
/// ("Default"). Blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn mcp_permission_rules(
    repo_path: Option<String>,
) -> Result<crate::extensions::permissions::PermissionRulesView, String> {
    tokio::task::spawn_blocking(move || {
        crate::extensions::permissions::read_mcp_permission_rules(repo_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Set the user's global output style (writes `~/.claude/settings.json` `outputStyle`;
/// `"default"` removes the key). USER-GLOBAL, atomic, order-preserving write. A live
/// session reflects the change on its next turn's `system/init`; otherwise it lands on
/// the next spawn. The blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_output_style(style: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::extensions::set_output_style(&style))
        .await
        .map_err(|e| e.to_string())?
}

/// Everything a single plugin provides (skills / sub-agents / MCP servers) for the
/// per-plugin explorer — scanned regardless of the plugin's enabled state so a
/// disabled plugin stays browsable. `repo_path` selects the install relevant to the
/// repo. Best-effort; the blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn list_plugin_contents(
    repo_path: String,
    plugin_id: String,
) -> Result<crate::extensions::PluginContents, String> {
    tokio::task::spawn_blocking(move || crate::extensions::list_plugin_contents(&repo_path, &plugin_id))
        .await
        .map_err(|e| e.to_string())
}

// ---- Plugin updates (marketplaces + auto-update + on-demand update) ---------
//
// Reads (marketplace list, per-marketplace auto-update state) go through
// `crate::extensions` (the on-disk config authority). Mutations (refresh a
// marketplace, update a plugin) shell out to the `claude plugin …` CLI via
// `crate::plugins` — the officially supported path. A live conversation applies an
// update at once with `reload_plugins`; otherwise it lands on the next session spawn.

/// List every marketplace registered with Claude Code (user-global) with its resolved
/// auto-update state. Best-effort — the blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn list_marketplaces() -> Result<Vec<crate::extensions::MarketplaceInfo>, String> {
    tokio::task::spawn_blocking(crate::extensions::list_marketplaces)
        .await
        .map_err(|e| e.to_string())
}

/// Turn a marketplace's auto-update on/off (writes `~/.claude/settings.json`
/// `extraKnownMarketplaces[name].autoUpdate` — per-marketplace is the only granularity
/// Claude Code exposes). Atomic write; the blocking file IO runs off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_marketplace_auto_update(name: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::extensions::set_marketplace_auto_update(&name, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turn auto-update on/off for EVERY registered marketplace at once (the global master
/// toggle) — one atomic settings.json write. The blocking file IO runs off the runtime.
#[tauri::command]
#[specta::specta]
pub async fn set_all_marketplaces_auto_update(enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::extensions::set_all_marketplaces_auto_update(enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refresh marketplace(s) from upstream (`claude plugin marketplace update [name]`) —
/// the network "check for updates" step that makes on-disk pins current. With `name`
/// null, refreshes all. Shells out to the `claude` CLI off the async runtime; a
/// refresh can take a few seconds (git fetches).
#[tauri::command]
#[specta::specta]
pub async fn refresh_plugin_marketplaces(name: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::plugins::refresh_marketplaces(name.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Update ONE plugin to its marketplace's latest version (`claude plugin update
/// <plugin> [-s <scope>]`). `scope` is the install scope (`user`/`project`/`local`);
/// `path` is the repo/conversation cwd the command runs in — required so project/local
/// scope resolves the right project (the CLI selects it from the working directory). A
/// LIVE session should follow with `reload_plugins` to hot-apply; otherwise the new
/// version is picked up on the next session spawn. Shells out off the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn update_plugin(
    plugin_id: String,
    scope: Option<String>,
    path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        crate::plugins::update_plugin(&plugin_id, scope.as_deref(), &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pause (or resume) a running Claude session's prompt suggestions — the front pauses
/// every conversation whose composer is off screen. The CLI's refusal (an older binary
/// without the subtype) is returned, not swallowed; Codex refuses it as unsupported.
#[tauri::command]
#[specta::specta]
pub async fn set_prompt_suggestions_paused(
    sessions: tauri::State<'_, Sessions>,
    session: String,
    paused: bool,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle
        .set_prompt_suggestions_paused(paused)
        .await
        .map_err(|e| e.to_string())
}

/// Hot-reload a running session's plugins after an update (`reload_plugins` control
/// request) — applies the change without a restart. Errors with "unknown session" when
/// the conversation has no live `claude` process (then the update lands on next spawn).
#[tauri::command]
#[specta::specta]
pub async fn reload_plugins(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.reload_plugins().await.map_err(|e| e.to_string())
}

// ---- Persistence (conversation metadata) ----------------------------------
//
// These commands are the front's single boundary to the store. They forward to
// `Store` (the only SQL-speaking service) and return / accept domain records —
// never anything SQL-shaped. Each call is a sub-ms, rare write off the hot path.

/// Load the persisted repos + conversations + active selection (UI hydration at boot).
#[tauri::command]
#[specta::specta]
pub fn load_persisted_state(store: tauri::State<'_, Store>) -> Result<PersistedState, String> {
    store.load_state().map_err(|e| e.to_string())
}

/// The report of this launch's folder-routing repair, held until the front announces it
/// (see [`Store::reconcile_path_routed_conversations`]). `None` once taken, or when the
/// repair had already run on an earlier launch.
pub struct FolderRoutingReportSlot(pub Mutex<Option<crate::store::FolderRoutingReport>>);

/// Hand the front this launch's folder-routing repair report, ONCE — taking it, so a
/// reloaded webview does not announce the same repair twice.
#[tauri::command]
#[specta::specta]
pub fn take_folder_routing_report(
    slot: tauri::State<'_, FolderRoutingReportSlot>,
) -> Option<crate::store::FolderRoutingReport> {
    slot.0.lock().unwrap().take()
}

/// Insert or update a repo (idempotent by id).
#[tauri::command]
#[specta::specta]
pub fn upsert_repo(store: tauri::State<'_, Store>, repo: RepoRecord) -> Result<(), String> {
    store.upsert_repo(&repo).map_err(|e| e.to_string())
}

/// Delete a repo; its conversations cascade away.
#[tauri::command]
#[specta::specta]
pub fn delete_repo(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_repo(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Remote servers (the SSH "machine boundary" — pairing + connection)
// ---------------------------------------------------------------------------

/// A freshly generated dedicated SSH key for a server. The PRIVATE key stays on this
/// Mac at `identity_file`; `public_key` is the single line to authorize on the server.
#[derive(serde::Serialize, specta::Type)]
pub struct GeneratedKey {
    /// Absolute path to the private key on this Mac (goes on the MachineRecord).
    pub identity_file: String,
    /// The public key line to append to the server's `~/.ssh/authorized_keys`.
    pub public_key: String,
}

/// Fixed basename (under `ssh_keys/`) for the keypair a not-yet-paired server's
/// command line embeds. Fixed rather than `{slug}-{uuid}` per call so re-opening the
/// wizard (or a double click) reuses the SAME pending pair instead of minting a new
/// one every time — see [`generate_machine_key`].
const PENDING_KEY_BASENAME: &str = "pending";

/// The "Connect an existing server" form's OWN pending slot ([`generate_connect_key`]),
/// apart from the wizard's [`PENDING_KEY_BASENAME`]: a wizard pipeline still running
/// (its `InstallKey` step minted the shared pending key, its `AddMachine` step claims it
/// later) and the form must never hold the same key file — one would hand it to a
/// different server, and whichever claims second loses it.
const CONNECT_PENDING_KEY_BASENAME: &str = "pending-connect";

/// Every pending slot: claimable by [`claim_pending_key`], never swept by
/// [`orphan_keys_to_sweep`].
const PENDING_KEY_SLOTS: [&str; 2] = [PENDING_KEY_BASENAME, CONNECT_PENDING_KEY_BASENAME];

/// Serializes [`generate_machine_key`]/[`generate_connect_key`] end to end
/// (read-or-mint, then the `ssh-keygen` spawn) and every pending-key claim. The fixed
/// slot filenames they read/write mean two concurrent callers (e.g. a double click on
/// "+ Add a server") would otherwise race `ssh-keygen -f pending` — the loser hitting an
/// interactive "overwrite?" prompt on stdin nobody is reading, which hangs the command
/// forever.
static PENDING_KEY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Whether `file_name` is one of the [`PENDING_KEY_SLOTS`] key files (private or `.pub`).
fn is_pending_slot_file(file_name: &str) -> bool {
    let stem = file_name.strip_suffix(".pub").unwrap_or(file_name);
    PENDING_KEY_SLOTS.contains(&stem)
}

/// Generate (or, if one is already waiting to be claimed, REUSE) the dedicated
/// ed25519 keypair for a not-yet-paired remote server (Flight Deck's own access key),
/// under `ssh_keys_dir` (created if missing). Returns the private-key path and the
/// public key to paste on the server. The private key never leaves this Mac. Wraps
/// the system `ssh-keygen`, matching the repo's "drive CLIs as black boxes" idiom.
///
/// Writes to the FIXED `pending`(`.pub`) basename rather than minting a fresh
/// `{slug}-{uuid}` pair on every call — re-opening the "add a server" wizard (close
/// Settings, reopen, "+ Add a server" again) used to mint a brand-new key each time:
/// 7 keys generated pairing ONE server. If a pending pair already exists on disk it's
/// read back byte-identical instead of re-running `ssh-keygen` (`label` only feeds the
/// `-C` comment of a freshly minted key, so it can't affect a reused one) — the same
/// pairing command can be safely re-pasted until [`claim_pending_key`] (called from
/// [`add_machine`]) claims it, which is the whole point of re-entering the wizard.
/// Guarded by [`PENDING_KEY_LOCK`]; see its doc comment. Takes a plain path (not a
/// `tauri::AppHandle`) so it's testable without a running app — [`generate_machine_key`]
/// is the thin IPC wrapper that resolves the real app data dir.
///
/// `pub(crate)` so `bootstrap::connect::install_key` (B7) reuses this SAME
/// lookup-or-generate primitive for the app's dedicated per-server key, rather than
/// minting a second one.
pub(crate) async fn generate_or_reuse_pending_key(ssh_keys_dir: &Path, label: &str) -> Result<GeneratedKey, String> {
    generate_or_reuse_slot_key(ssh_keys_dir, PENDING_KEY_BASENAME, label).await
}

/// [`generate_or_reuse_pending_key`] for the "Connect an existing server" form's own
/// slot, [`CONNECT_PENDING_KEY_BASENAME`] — see that constant for why it isn't shared.
pub(crate) async fn generate_or_reuse_connect_key(ssh_keys_dir: &Path, label: &str) -> Result<GeneratedKey, String> {
    generate_or_reuse_slot_key(ssh_keys_dir, CONNECT_PENDING_KEY_BASENAME, label).await
}

/// Creates `dir` private to this user (0700) — with the mode given to the `mkdir`
/// itself, never created at the process umask and narrowed after (the same discipline
/// as `bootstrap::askpass::AskpassGuard`) — and narrows an existing one any other user
/// could list or enter (security review L17: `ssh_keys/` holds every server's private
/// key; the key files are 0600, but the directory itself was left at the umask's
/// default, typically 0755). Missing parents are created as usual.
pub(crate) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt as _;
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    tighten_private_dir(dir).map(|_| ())
}

/// Narrows an EXISTING directory to 0700 when any group/other bit is set; `Ok(true)`
/// when it changed something. A missing path is `Ok(false)`, and a symlink (or
/// anything but a directory) is left alone — never chmod'ed through. Run on
/// `ssh_keys/` at every launch (`lib.rs`), so a directory an older version created
/// at the umask's default is fixed on the next start (L17).
pub(crate) fn tighten_private_dir(dir: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt as _;
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_dir() || meta.permissions().mode() & 0o077 == 0 {
        return Ok(false);
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(true)
}

/// The shared read-or-mint of one pending slot (`slot` is one of [`PENDING_KEY_SLOTS`])
/// — see [`generate_or_reuse_pending_key`].
async fn generate_or_reuse_slot_key(ssh_keys_dir: &Path, slot: &str, label: &str) -> Result<GeneratedKey, String> {
    let _guard = PENDING_KEY_LOCK.lock().await;
    ensure_private_dir(ssh_keys_dir).map_err(|e| e.to_string())?;
    let key = ssh_keys_dir.join(slot);
    let pub_path = PathBuf::from(format!("{}.pub", key.display()));

    match (key.exists(), pub_path.exists()) {
        (true, true) => {
            let public_key = std::fs::read_to_string(&pub_path)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            return Ok(GeneratedKey { identity_file: key.to_string_lossy().into_owned(), public_key });
        }
        (false, false) => {}
        // Partial state from an interrupted previous run (crash mid-keygen): clear it
        // so `ssh-keygen -f` below doesn't hit an "overwrite?" prompt nobody can answer.
        _ => {
            let _ = std::fs::remove_file(&key);
            let _ = std::fs::remove_file(&pub_path);
        }
    }

    let slug: String =
        label.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let out = tokio::process::Command::new("ssh-keygen")
        .arg("-t")
        .arg("ed25519")
        .arg("-N")
        .arg("") // no passphrase (BatchMode auth)
        .arg("-C")
        .arg(format!("flightdeck-{slug}"))
        .arg("-f")
        .arg(&key)
        .output()
        .await
        .map_err(|e| format!("could not run ssh-keygen: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let public_key = std::fs::read_to_string(&pub_path)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    Ok(GeneratedKey {
        identity_file: key.to_string_lossy().into_owned(),
        public_key,
    })
}

/// See [`generate_or_reuse_pending_key`] — this is the IPC wrapper that resolves the
/// real app data dir.
#[tauri::command]
#[specta::specta]
pub async fn generate_machine_key(
    app: tauri::AppHandle,
    label: String,
) -> Result<GeneratedKey, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh_keys");
    generate_or_reuse_pending_key(&dir, &label).await
}

/// The "Connect an existing server" form's dedicated key ("A key for Flight Deck"):
/// [`generate_machine_key`], but in the form's own pending slot
/// ([`CONNECT_PENDING_KEY_BASENAME`]), so a wizard run still holding the shared pending
/// key can never be handed the same file. Claimed by [`add_machine`] like the wizard's.
#[tauri::command]
#[specta::specta]
pub async fn generate_connect_key(app: tauri::AppHandle, label: String) -> Result<GeneratedKey, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ssh_keys");
    generate_or_reuse_connect_key(&dir, &label).await
}

// ---- Orphaned pairing-key sweep (A7) --------------------------------------------
// Every abandoned pairing attempt before A3 (and, in principle, still possible today
// if a user closes the wizard mid-flight) left a keypair behind under `ssh_keys/`:
// pre-A3 it was named `server-<uuid>` / `{slug}-{uuid}`, one per attempt — 7+
// accumulated on Armand's machine alone. Swept automatically at app start (see
// `lib.rs::run`'s `setup`, the earliest point the store — and so the referenced set —
// is available) rather than gated behind a per-call flag: it naturally runs once per
// app launch with no extra state to track.

/// Grace window (ms) before an unreferenced key is considered safe to sweep — guards
/// against a mid-flight pairing/rename race: a brand-new pending key, or one
/// [`claim_pending_key`] just renamed to a machine id whose [`MachineRecord`] write
/// hasn't landed on disk yet. A file younger than this is left alone even when
/// nothing currently references it.
const ORPHAN_SWEEP_GRACE_MS: i64 = 60 * 60 * 1000;

/// One regular file the sweep's IO wrapper found directly under `ssh_keys/` — never a
/// symlink or a subdirectory (those are filtered out before reaching the pure
/// decision function below), with its last-modified time pre-read so
/// [`orphan_keys_to_sweep`] stays pure and filesystem-free.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SweepCandidate {
    path: PathBuf,
    mtime_ms: i64,
}

/// Decide which of `entries` are orphaned pairing keys safe to delete. A file is kept
/// (never swept) when its basename is one of the live pending keypairs
/// ([`PENDING_KEY_SLOTS`], private or `.pub`), or its path is in `referenced` (see
/// [`referenced_key_paths`]); otherwise it is swept once it is older than
/// [`ORPHAN_SWEEP_GRACE_MS`]. Pure — takes pre-enumerated entries and the referenced set
/// so it is unit-tested without touching a real filesystem; [`sweep_orphan_ssh_keys`]
/// is the (untestable) IO wrapper around it.
fn orphan_keys_to_sweep(
    entries: &[SweepCandidate],
    referenced: &std::collections::HashSet<PathBuf>,
    now_ms: i64,
) -> Vec<PathBuf> {
    entries
        .iter()
        .filter(|e| {
            let name = e.path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if is_pending_slot_file(name) {
                return false;
            }
            if referenced.contains(&e.path) {
                return false;
            }
            now_ms.saturating_sub(e.mtime_ms) > ORPHAN_SWEEP_GRACE_MS
        })
        .map(|e| e.path.clone())
        .collect()
}

/// Every path currently referenced by a machine's `identity_file` — the private key
/// itself, and its `.pub` twin — canonicalised where possible (falling back to the
/// raw path when canonicalisation fails, e.g. a dangling reference; that only WIDENS
/// what's protected, never narrows it, so a canonicalisation quirk can never cause a
/// referenced key to be swept). The set [`orphan_keys_to_sweep`] must never touch.
fn referenced_key_paths(machines: &[MachineRecord]) -> std::collections::HashSet<PathBuf> {
    let mut referenced = std::collections::HashSet::new();
    for m in machines {
        let Some(identity) = &m.identity_file else { continue };
        for candidate in [identity.clone(), format!("{identity}.pub")] {
            let path = PathBuf::from(&candidate);
            referenced.insert(path.canonicalize().unwrap_or(path));
        }
    }
    referenced
}

/// [`orphan_keys_to_sweep`]'s IO wrapper: enumerate `ssh_keys_dir` — never following a
/// symlink, never recursing into a subdirectory, never touching anything outside this
/// one directory — decide, then remove each doomed file. `machines` is the current
/// machine list; `None` means the store could not be read, and the WHOLE sweep is
/// skipped (fail-safe: never delete a key this run can't prove is unreferenced,
/// mirroring the `resolve_links`/`Option<&[…]>` "no verdict without a real look"
/// discipline used for the TOSSE repo association). Every removal (path only) and
/// every failure is logged; a failure to remove ONE file never stops the rest, and
/// this never returns an error the caller must handle — a sweep that stumbles must
/// never block pairing.
pub(crate) fn sweep_orphan_ssh_keys(ssh_keys_dir: &Path, machines: Option<&[MachineRecord]>) {
    let Some(machines) = machines else {
        eprintln!("[ssh_keys] orphan sweep skipped: could not read the machine list");
        return;
    };
    let referenced = referenced_key_paths(machines);
    let now = now_ms();

    let read_dir = match std::fs::read_dir(ssh_keys_dir) {
        Ok(rd) => rd,
        Err(e) => {
            // No `ssh_keys/` yet (no server ever paired) is the ordinary case on a
            // fresh install/first launch — not worth logging as a failure.
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[ssh_keys] orphan sweep skipped: could not read {}: {e}",
                    ssh_keys_dir.display()
                );
            }
            return;
        }
    };

    let mut candidates = Vec::new();
    for entry in read_dir.flatten() {
        // `DirEntry::file_type()` does not follow symlinks — a symlink entry reports
        // `is_file() == false` here, so it (and any subdirectory) is skipped without
        // ever being stat'd through.
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            // An unreadable mtime is treated as "now" — fail-safe toward NOT
            // sweeping this run, rather than risking a fresh key's grace window.
            .unwrap_or(now);
        // Canonicalise so this matches `referenced_key_paths`'s canonicalised set —
        // without this, a `ssh_keys_dir` reached through a symlinked ancestor (e.g.
        // macOS's `/var` -> `/private/var`) would never match a referenced
        // `identity_file` that WAS canonicalised, and a live key would be swept out
        // from under a paired machine. Falls back to the raw path when
        // canonicalisation fails, matching `referenced_key_paths`'s own fallback.
        let path = entry.path();
        let path = path.canonicalize().unwrap_or(path);
        candidates.push(SweepCandidate { path, mtime_ms });
    }

    for path in orphan_keys_to_sweep(&candidates, &referenced, now) {
        match std::fs::remove_file(&path) {
            Ok(()) => eprintln!("[ssh_keys] swept orphaned pairing key: {}", path.display()),
            Err(e) => eprintln!("[ssh_keys] failed to sweep {}: {e}", path.display()),
        }
    }
}

/// Minimum `flightdeckd` version pairing trusts — older ones hard-block pairing just
/// like a missing binary (unknown protocol/wire compatibility). Bump when a wire
/// change requires a specific daemon version.
const MIN_DAEMON_VERSION: &str = "0.1.0";

/// Whether `v` — typically raw `<name> <version>` `--version` output such as
/// `"flightdeckd 0.1.0"` — is at least `min` (a plain dotted version like
/// `"0.1.0"`). Compares the LAST whitespace-separated token of each input,
/// component-wise; any non-numeric component parses as `0` rather than panicking, so
/// a future `--version` format tweak degrades to "0.0.0 → outdated" instead of
/// crashing the probe. Pure and side-effect-free — the version text is all it needs.
///
/// `pub(crate)`: also the comparison [`crate::bootstrap::orchestrator::daemon_is_outdated`]
/// uses to compare a server's running `flightdeckd` against this Mac's BUNDLED one —
/// one version-comparison rule for the whole crate, never a second copy drifting apart.
pub(crate) fn version_at_least(v: &str, min: &str) -> bool {
    fn parts(s: &str) -> Vec<u32> {
        let token = s.split_whitespace().last().unwrap_or(s);
        token.split('.').map(|p| p.parse().unwrap_or(0)).collect()
    }
    let (vp, mp) = (parts(v), parts(min));
    for i in 0..vp.len().max(mp.len()) {
        let a = vp.get(i).copied().unwrap_or(0);
        let b = mp.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    true
}

/// Outcome of probing a remote server for the two binaries pairing needs, PLUS (B7)
/// the install-mode facts [`bootstrap::connect::probe`] needs to decide how (or
/// whether) to install `flightdeckd` on a server that has never been paired before.
/// `Ok` covers EVERY combination of present/missing/outdated — "missing" is data IN
/// the struct, never an ssh-level failure — so [`add_machine`] can name every blocker
/// at once instead of just whichever the remote shell happened to trip over first. An
/// `Err` means the ssh round-trip itself failed (unreachable host, auth refused, …),
/// before the probe script could report anything.
///
/// The install-mode fields (`conflict`/`os`/`arch`/`systemd`/`passwordless_sudo`/
/// `linger`/`kill_user_processes`) are ALWAYS `None` for a pairing probe
/// ([`probe_remote`]'s own script never emits their markers — see
/// [`parse_probe_output`]'s doc) — [`add_machine`] ignores them either way, exactly as
/// before this struct grew them. Only [`bootstrap::connect::probe`]'s own, EXTENDED
/// script populates them.
///
/// Never crosses the Tauri IPC boundary today (stale doc fix, residual defect A8/R3,
/// CRM `1abfc028`): [`bootstrap::connect::probe`] and [`probe_remote`] are both plain
/// internal `async fn`s, not `#[tauri::command]`s — called only from within
/// `bootstrap::orchestrator` (its pipeline's `step_probe` AND its `repair()` flow's
/// `ReuploadDaemon`/`InstallService` actions) and from [`add_machine`] respectively,
/// neither exposed to the frontend, and [`add_machine`] itself returns an
/// [`AddMachineOutcome`], never this struct directly. `Serialize`/`Deserialize`/`Type`
/// were dropped for exactly that reason (previously justified by a `bootstrap_probe`
/// Tauri command that was removed by the signin-and-hygiene merge, leaving this doc
/// pointing at a symbol that no longer exists) — nothing serializes or exports this
/// type today; re-add them (with a fresh justification) if a future command starts
/// returning it directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteProbeResult {
    pub claude_version: Option<String>,
    pub claude_missing: bool,
    pub flightdeckd_version: Option<String>,
    pub flightdeckd_missing: bool,
    pub flightdeckd_outdated: bool,
    /// One-line description of a pre-existing `flightdeckd` install this server
    /// already carries (a system unit, a binary outside `~/.local/bin`, or an existing
    /// `~/.flightdeckd/config.json`) — meaning "adopt it, don't reinstall", not a
    /// failure. `None` when the probe script found none of those (or never ran this
    /// check at all — a pairing probe, see the struct doc).
    pub conflict: Option<String>,
    /// `uname -s` (e.g. `"Linux"`).
    pub os: Option<String>,
    /// `uname -m` (e.g. `"x86_64"`/`"aarch64"`) — picks the daemon binary to install.
    pub arch: Option<String>,
    /// Whether systemd is PID 1 (`/run/systemd/system` exists).
    pub systemd: Option<bool>,
    /// Whether `sudo -n true` succeeds (passwordless sudo) — never prompts, so this is
    /// safe to run from a batch probe.
    pub passwordless_sudo: Option<bool>,
    /// `loginctl show-user $USER -p Linger` — whether the user can keep a `systemd
    /// --user` unit running after the SSH session that started it closes.
    pub linger: Option<bool>,
    /// logind's `KillUserProcesses` setting (best-effort, via `busctl` — `None` when
    /// `busctl` itself is unavailable, never an error): whether a detached process
    /// (the no-linger, no-sudo fallback) survives the session closing.
    pub kill_user_processes: Option<bool>,
}

/// Pulls the value after a `MARKER:` line out of the probe script's stdout. `None`
/// means the marker line never showed up at all (e.g. the connection died before the
/// script could run), as opposed to showing up with an empty value.
///
/// `pub(crate)` so `bootstrap::connect`'s own extended probe script (B7) reuses this
/// SAME marker-extraction primitive instead of growing a second one.
pub(crate) fn extract_marker(stdout: &str, marker: &str) -> Option<String> {
    stdout.lines().find_map(|l| l.strip_prefix(marker)).map(|v| v.trim().to_string())
}

/// Parses a `"yes"`/`"no"` marker value into a bool — anything else (missing, empty,
/// garbled) is `None`, never an error: a probe script's best-effort fact (e.g. `sudo`
/// or `busctl` behaving unexpectedly on some distro) must degrade silently, not fail
/// the whole probe.
pub(crate) fn parse_yes_no_marker(v: Option<String>) -> Option<bool> {
    match v.as_deref() {
        Some("yes") => Some(true),
        Some("no") => Some(false),
        _ => None,
    }
}

/// Test-only override for which `ssh` binary [`keyed_ssh_options`] spawns — an
/// ABSOLUTE PATH to a stand-in script, read ONCE per call. This exists so C10's
/// `appmcp::provision` tests can intercept every keyed ssh call end-to-end
/// (through the real, unmodified production functions) WITHOUT mutating the
/// process-wide `PATH` env var: an earlier version of that test harness did
/// exactly that and it redirected every OTHER concurrently-running test's own
/// `ssh`/`ssh-keygen` spawn too (caught by `bootstrap::askpass`'s
/// `run_with_password_reports_host_unreachable_against_a_real_closed_port`
/// starting to fail under full-suite `cargo test --lib`, not run in isolation).
/// Unset (the default) everywhere outside those guarded tests — a complete
/// no-op in production and in every other test in this crate.
///
/// The override is THREAD-LOCAL, not a process-wide env var: a process-wide
/// `TOSSE_TEST_SSH_BIN` leaked into every OTHER test family that happened to spawn
/// a keyed ssh at the same instant (they then ran provision's fake, whose
/// `cat > /dev/null` blocks forever on a caller that keeps stdin open — the whole
/// suite hung). `#[tokio::test]` runs on a current-thread runtime, so a guard set
/// on the test's own thread covers every ssh that test spawns and nothing else.
/// Also the program of the no-secret host-key scan
/// (`bootstrap::connect::host_key_scan_command`), so a test can drive a first contact.
pub(crate) fn ssh_binary() -> String {
    #[cfg(test)]
    if let Some(bin) = TEST_SSH_BIN.with(|b| b.borrow().clone()) {
        return bin;
    }
    "ssh".to_string()
}

// Test-only fake-`ssh` override read by `ssh_binary` — see its doc for why it is
// thread-local rather than a process-wide env var.
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_SSH_BIN: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

/// The shared option-only base of every SSH call this crate makes to an ALREADY-PAIRED
/// machine: batch (never prompts — the whole point of pairing first), its dedicated
/// `known_hosts` (never the user's real `~/.ssh/known_hosts`, TOFU-pinned once at
/// `add_machine` time), and its own identity file (or the default key/agent when
/// `None`). This is "the keyed ssh path" — [`probe_remote`] and [`run_ssh_on_machine`]
/// both build on it, and so does `bootstrap::server_setup` for the same already-paired
/// machine (see that module's doc: it deliberately does NOT invent a second ssh
/// invoker). Mirrors `bootstrap::askpass::bootstrap_ssh_options` in shape — that one is
/// the deliberate FIRST-contact, password-only exception (no key yet); this one is the
/// keyed norm every other ssh call in the crate uses.
///
/// Does not set `-T`/`-tt` (pty mode differs per caller: batch calls use `-T`, an
/// interactive drive needs neither since the remote CLI itself doesn't require a pty —
/// see `bootstrap::server_setup`'s doc) nor the destination/remote command (appended
/// last by the caller, exactly like `bootstrap_ssh_options`'s own doc explains for its
/// sibling — ssh's own argv grammar stops parsing options once it sees the
/// destination). ⚠️ Every caller MUST append the destination via [`push_ssh_destination`]
/// (`-l <user> -- <host>`), never a hand-built `format!("{{user}}@{{host}}")` — see that
/// function's doc for the ssh-option-injection class this closes (CRM holistic-review
/// blocker #3, chantier A `bd7ca709`).
///
/// `Err` (and no command) only when `known_hosts` is a path ssh cannot be given exactly
/// — see [`known_hosts_option`].
pub(crate) fn keyed_ssh_options(
    port: u16,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> Result<tokio::process::Command, String> {
    keyed_ssh_options_with_bin(&ssh_binary(), port, identity, known_hosts)
}

/// [`keyed_ssh_options`] with an explicit `ssh` program instead of [`ssh_binary`]'s
/// resolution. Only [`run_ssh_on_machine_stdin`]'s test seam passes something
/// other than [`ssh_binary`]: a test that hands it a fake-`ssh` directory must get
/// THAT fake, not whatever process-wide `TOSSE_TEST_SSH_BIN` another concurrently
/// running test family (appmcp::provision) happens to have set at that instant.
pub(crate) fn keyed_ssh_options_with_bin(
    ssh_bin: &str,
    port: u16,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> Result<tokio::process::Command, String> {
    let args = keyed_ssh_args(port, identity, known_hosts)?;
    let mut cmd = tokio::process::Command::new(ssh_bin);
    // Never inherit this process's stdin: tokio's `output()` does NOT null it, so a
    // plain keyed call (`run_ssh_on_machine`, `probe_remote`) let `ssh` — and the
    // remote command behind it — read from the app's own stdin (the terminal under
    // `tauri dev`; the test harness's socket under `cargo test`, where it hung the
    // suite). Callers that stream a payload re-set `.stdin(Stdio::piped())`.
    cmd.stdin(std::process::Stdio::null());
    // Callers bound the round trip with `tokio::time::timeout` (the health probe, the
    // diagnosis, the key check, the pairing probe…). On expiry the future — and the child
    // in it — is dropped, and tokio does NOT kill a dropped child by default: ssh would
    // keep running against a server that authenticated and never answered, one leaked
    // process per probe tick. Same reaping `cli_update` and `accounts` already do.
    cmd.kill_on_drop(true);
    cmd.args(args);
    Ok(cmd)
}

/// The options EVERY ssh this crate spawns passes first, whatever it authenticates with:
/// the keyed path ([`keyed_ssh_args`]), the first-contact password connection
/// (`bootstrap::askpass::bootstrap_ssh_options`) and the no-secret host-key scan
/// (`bootstrap::connect::host_key_scan_command`). Given on the command line, each one
/// wins over whatever `~/.ssh/config` or `/etc/ssh/ssh_config` says for the same option:
/// ssh keeps the FIRST value it obtains, and the command line is read first.
///
/// `ServerAliveInterval=10` × 3: `ConnectTimeout` only covers the handshake, and a link
/// that dies mid-command sends no FIN — ssh would then wait on the OS TCP keepalive
/// (about 2 h on macOS). The probes end it in ~30 s. ⚠️ Every live remote conversation
/// holds its OWN ssh, and each probe is an encrypted round trip that wakes the Wi-Fi
/// radio (and Tailscale's tunnel) even at rest: 5 s was twice the traffic for 15 s of
/// detection nobody needed (decided 28/09: ~30 s is the accepted time to notice a cut).
///
/// `LogLevel=INFO`, ssh's own default — what every classifier here (`crate::ssh_link`, the
/// bootstrap's `classify_output`, the scan, the pairing probe) was written and verified
/// against. A user's `LogLevel QUIET` (a common way to hide "Permanently added…" and login
/// banners) or `FATAL` silenced "Permission denied" and "Host key verification failed", and
/// a refused key or a changed host key then read as "could not reach the server" — the
/// live session reconnecting forever. ⚠️ Not ERROR: ssh logs most of the ways a link dies
/// at INFO (its `logdie`) — "Connection closed by …", "Connection reset by …", "Unable to
/// negotiate with …", "Timeout, server … not responding" — and printed nothing for them
/// under ERROR. A `DEBUG`/`VERBOSE` config is capped here too.
///
/// `RemoteCommand=none` + `RequestTTY=no`: every caller gives ssh its own command, and
/// a `RemoteCommand` in the user's `Host` block (the common dev-box `tmux new -A`, with
/// `RequestTTY yes`) made ssh refuse EVERY connection ("Cannot execute command-line and
/// remote command."). No PTY either way: the channel carries raw bytes.
///
/// `known_hosts` goes through [`known_hosts_option`], the one form ssh reads as a single
/// file. `Err` only when that path cannot be given to ssh exactly.
pub(crate) fn common_ssh_args(port: u16, known_hosts: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["-p".to_string(), port.to_string()];
    for option in [
        "ConnectTimeout=10", // fail fast if the host is unreachable
        "ServerAliveInterval=10",
        "ServerAliveCountMax=3",
        "LogLevel=INFO",
        "RemoteCommand=none",
        "RequestTTY=no",
    ] {
        args.push("-o".to_string());
        args.push(option.to_string());
    }
    if let Some(kh) = known_hosts {
        args.push("-o".to_string());
        args.push(known_hosts_option(kh)?);
    }
    Ok(args)
}

/// The option argv of [`keyed_ssh_options`] on its own — the ONE list every keyed ssh
/// this crate spawns passes, including the live session transport's three spawns
/// (`supervisor::transport`), which build their own `Command` (piped stdio, own process
/// group) and only take these options from here: [`common_ssh_args`], plus batch mode,
/// trust-on-first-use pinning and the dedicated identity.
pub(crate) fn keyed_ssh_args(
    port: u16,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = common_ssh_args(port, known_hosts)?;
    for option in [
        "BatchMode=yes",                    // never block a GUI app on a password prompt
        "StrictHostKeyChecking=accept-new", // TOFU: pin on first sight
    ] {
        args.push("-o".to_string());
        args.push(option.to_string());
    }
    if let Some(id) = identity {
        // IdentitiesOnly so ssh offers ONLY our dedicated key (avoids "too many
        // authentication failures" when the agent holds many keys).
        args.extend(["-i".to_string(), id.to_string(), "-o".to_string(), "IdentitiesOnly=yes".to_string()]);
    }
    Ok(args)
}

/// `UserKnownHostsFile=<path>` in the one form ssh reads as a SINGLE file — the ONLY
/// way any ssh this crate spawns names a known-hosts file.
///
/// ssh takes a whitespace-separated LIST of files in this option, so the app's own
/// `~/Library/Application Support/<id>/remote_known_hosts`, passed bare, was read as two
/// files: every connection checked and pinned (`accept-new`) into
/// `~/Library/Application`, while this app's own host-key code (`bootstrap::connect`,
/// through `ssh-keygen -f` and Rust fs) read and wrote the real path ssh never consulted
/// — the password gate pinned a key no connection checked, and a changed host key
/// could not be fixed from the app (`bootstrap::connect::migrate_split_known_hosts`
/// carries over the pins ssh wrote there). Quoted, the value is one file; `%` is
/// doubled because ssh expands `%` tokens in it.
///
/// `Err` for a path ssh cannot be given exactly: a double quote (no escape that every
/// OpenSSH version reads the same), a backslash (newer versions read it as an escape
/// inside quotes, older ones do not), `${` (ssh expands environment variables in it) or
/// a control character — never passed in a form ssh would read as some other file.
pub(crate) fn known_hosts_option(path: &str) -> Result<String, String> {
    if path.is_empty()
        || path.contains('"')
        || path.contains('\\')
        || path.contains("${")
        || path.chars().any(char::is_control)
    {
        return Err(format!(
            "Flight Deck's known-hosts file is at a path ssh cannot be given exactly ({path:?}): \
             it must not contain a double quote, a backslash, \"${{\" or a control character"
        ));
    }
    Ok(format!("UserKnownHostsFile=\"{}\"", path.replace('%', "%%")))
}

/// Appends this connection's login and destination to `cmd` the SAFE way, and is the
/// ONE place every ssh-argv builder in this crate funnels the (`user`, `host`) pair
/// through (CRM holistic-review blocker #3, chantier A `bd7ca709`: an unvalidated
/// `user` let `format!("{user}@{host}")` smuggle an ssh OPTION — e.g.
/// `-oProxyCommand=<cmd>` — past every caller that only ever validated `host`).
///
/// Two independent defenses, not one:
/// 1. `-l <user>` for the login, never concatenated into a single `user@host`
///    positional argument — a value starting with `-` can no longer be parsed as an
///    option just by riding along in that string.
/// 2. `--` (which OpenSSH honours as "end of options") immediately before `host`, so
///    even `host` itself starting with `-` can't be misread as a flag either.
///
/// ALSO re-validates both values itself, via [`crate::store::validate_ssh_user`] /
/// [`crate::store::validate_address_value`] — belt and suspenders: every caller listed
/// on those functions' own docs already validates before it gets here, but this is the
/// LAST line of defense inside the shared builder itself, so a future call site that
/// forgets to validate upstream still can't spawn anything built from an unchecked
/// value. Appends NOTHING to `cmd` and returns `Err` on failure — the caller must never
/// fall through to spawning `cmd` in that case.
pub(crate) fn push_ssh_destination(cmd: &mut tokio::process::Command, user: &str, host: &str) -> Result<(), String> {
    validate_ssh_user(user)?;
    validate_address_value(host)?;
    cmd.arg("-l").arg(user).arg("--").arg(host);
    Ok(())
}

/// Shell expression that resolves the `flightdeckd` binary on a remote host the SAME
/// way everywhere a non-interactive ssh call needs to run it: `PATH` (as that shell
/// sees it) first, then the two common non-PATH install spots, `~/.local/bin` and
/// `/usr/local/bin` — mirrors `bootstrap::connect::PROBE_SCRIPT`'s own search order.
/// Evaluates (via a `$(...)` command substitution) to the resolved path, or, when
/// nothing is found, the bare name itself — so a caller that runs it still gets ssh's
/// own "command not found" rather than an empty command line.
///
/// The ONE shared resolver behind what used to be FOUR independent copies of this same
/// search (`bootstrap::connect::PROBE_SCRIPT`, `bootstrap::install`'s
/// `DAEMON_STATUS_CMD`, `supervisor::transport::resolve_remote_daemon_bin`, and two
/// bare, unresolved `"flightdeckd ..."` calls in `bootstrap::server_setup::run_init` +
/// three more in `appmcp::provision`) — the bare ones broke on a user-level install
/// (the binary lands in `~/.local/bin`, which a non-interactive ssh shell never has on
/// `PATH`), VERIFIED live against `verify_daemon_running`'s own doc for the identical
/// trap on the upload side. Every call site now builds its remote command through
/// this.
///
/// `bin_name` is expected to be a bare command name (`"flightdeckd"` at every
/// production call site) — an explicit path (containing `/`) is returned unsearched,
/// shell-quoted, for any future override that already names a full path. `var_name` is
/// a disposable, cosmetic name for this expression's own inline subshell variable —
/// kept distinct per caller (see [`resolve_daemon_bin_expr`]/[`resolve_claude_bin_expr`])
/// only so a script built from more than one such expression can never have two of them
/// stomp the SAME shell variable.
fn resolve_bin_expr(bin_name: &str, var_name: &str) -> String {
    if bin_name.contains('/') {
        return shq(bin_name);
    }
    let name = shq(bin_name);
    format!(
        "$({var_name}={name}; command -v \"${var_name}\" 2>/dev/null || \
         {{ [ -x \"$HOME/.local/bin/${var_name}\" ] && printf %s \"$HOME/.local/bin/${var_name}\"; }} || \
         {{ [ -x \"/usr/local/bin/${var_name}\" ] && printf %s \"/usr/local/bin/${var_name}\"; }} || \
         printf %s \"${var_name}\")"
    )
}

pub(crate) fn resolve_daemon_bin_expr(bin_name: &str) -> String {
    resolve_bin_expr(bin_name, "FLIGHTDECKD_NAME")
}

/// The `claude` sibling of [`resolve_daemon_bin_expr`] — SAME search order, for the
/// SAME reason: the official native installer (`curl -fsSL https://claude.ai/install.sh
/// | bash`, see `bootstrap::server_setup::install_claude`'s own doc for the citation)
/// places `claude` at `~/.local/bin/claude` (a symlink into
/// `~/.local/share/claude/versions/`), which a non-interactive ssh shell's `PATH` never
/// includes (only a LOGIN shell sources `~/.profile`) — VERIFIED live: a server with
/// nothing but a hand-made `/usr/local/bin/claude` symlink "worked" only by accident,
/// while every genuinely fresh install (the official installer's own, default location)
/// made a bare `command -v claude`/`claude ...` report "not installed" even though it
/// plainly was. Every remote invocation of `claude` in this crate MUST go through this
/// — never a bare `claude`/`command -v claude`.
pub(crate) fn resolve_claude_bin_expr() -> String {
    resolve_bin_expr("claude", "FLIGHTDECK_CLAUDE_BIN")
}

/// Verify we can SSH into a server AND check the two binaries pairing needs —
/// `claude` and `flightdeckd` — with a single fast, batch (never-prompting) probe.
///
/// The remote script is an ACCUMULATING check: each binary is tested behind its own
/// `if`, and the script only `exit`s at the very end. The previous version ran `claude
/// --version || { …; exit 3; }` — that `exit` is NOT inside a subshell, so it killed
/// the WHOLE remote script, meaning a second check appended after it would never run
/// when `claude` was ALSO missing. Accumulating first means "neither present" reports
/// BOTH, not just whichever came first.
///
/// `flightdeckd` is looked for the same way the daemon-attach command resolves it
/// (`transport::resolve_remote_daemon_bin`, fed `daemon_bin` — default `"flightdeckd"`,
/// override `TOSSE_REMOTE_FLIGHTDECKD_BIN`): first on `PATH` (as a non-interactive ssh
/// shell sees it), then the two common non-PATH install spots, `~/.local/bin` and
/// `/usr/local/bin`. Genuinely the SAME search now (both live in this one script /
/// that one function) — previously this comment described an aspiration the attach
/// path didn't implement: it bare-`exec`'d `daemon_bin` with no fallback, so a probe
/// that passed via `~/.local/bin` could still fail on the very first attach.
///
/// `claude` is resolved through the SAME [`resolve_claude_bin_expr`] every other remote
/// `claude` invocation in this crate now uses — a bare `command -v claude` here used to
/// report a perfectly real, official-installer `claude` (which lands in
/// `~/.local/bin`, never on a non-interactive ssh shell's `PATH`) as "not installed".
const PROBE_SCRIPT_BODY: &str = r#"
MISSING=""
CLAUDE_VERSION=""
if [ -n "$CLAUDE_BIN" ] && (command -v "$CLAUDE_BIN" >/dev/null 2>&1 || [ -x "$CLAUDE_BIN" ]); then
    CLAUDE_VERSION=$("$CLAUDE_BIN" --version 2>/dev/null)
    # (review fix) A present-but-broken binary (wrong arch/libc, a truncated
    # download, a dangling `versions/` dir) must NOT be reported as "installed" —
    # only a ZERO exit AND non-empty output count as "claude actually works", the
    # same bar `install_claude`'s own post-install verification already holds
    # itself to (see `bootstrap::server_setup::install_claude`'s doc).
    if [ $? -ne 0 ] || [ -z "$CLAUDE_VERSION" ]; then
        CLAUDE_VERSION=""
        MISSING="$MISSING claude"
    fi
else
    MISSING="$MISSING claude"
fi
FLIGHTDECKD_BIN=""
if command -v flightdeckd >/dev/null 2>&1; then
    FLIGHTDECKD_BIN=flightdeckd
elif [ -x "$HOME/.local/bin/flightdeckd" ]; then
    FLIGHTDECKD_BIN="$HOME/.local/bin/flightdeckd"
elif [ -x /usr/local/bin/flightdeckd ]; then
    FLIGHTDECKD_BIN=/usr/local/bin/flightdeckd
fi
FLIGHTDECKD_VERSION=""
if [ -n "$FLIGHTDECKD_BIN" ]; then
    FLIGHTDECKD_VERSION=$("$FLIGHTDECKD_BIN" --version 2>/dev/null)
else
    MISSING="$MISSING flightdeckd"
fi
echo "FLIGHTDECK_CLAUDE_VERSION:$CLAUDE_VERSION"
echo "FLIGHTDECK_DAEMON_VERSION:$FLIGHTDECKD_VERSION"
case " $MISSING " in
    *" claude "*) echo FLIGHTDECK_NO_CLAUDE >&2 ;;
esac
case " $MISSING " in
    *" flightdeckd "*) echo FLIGHTDECK_NO_DAEMON >&2 ;;
esac
if [ -n "$MISSING" ]; then
    case "$MISSING" in
        *claude*) exit 3 ;;
        *) exit 4 ;;
    esac
fi
exit 0
"#;

/// [`PROBE_SCRIPT_BODY`] prefixed with the `CLAUDE_BIN` resolution line — same split as
/// `bootstrap::orchestrator::diagnose_script`'s own `FLIGHTDECKD_BIN` injection, kept as
/// a separate `format!` argument rather than inlined so the constant's own literal
/// `{`/`}` never needs escaping. `pub(crate)` so it can be exercised directly by the
/// crate-wide "no bare `command -v claude`" regression test in `bootstrap::orchestrator`.
pub(crate) fn probe_script() -> String {
    format!("CLAUDE_BIN={}\n{}", resolve_claude_bin_expr(), PROBE_SCRIPT_BODY)
}

/// (B14 fix round 3 — major) Bounded by
/// [`crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT`] — the same guard
/// `bootstrap::orchestrator::diagnose`/`bootstrap::connect::probe` already apply to
/// their own `cmd.output()`, previously missing here. This backs the "Add a server"
/// pairing flow's per-candidate probe loop (no outer timeout of its own) and
/// [`daemon_version_for_machine`]'s cached lookup (which layers its own, shorter 12s
/// timeout on top — both now stack harmlessly rather than the outer one being the
/// ONLY thing standing between a wedged remote shell and a caller that hangs forever).
async fn probe_remote(
    host: &str,
    port: u16,
    user: &str,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> Result<RemoteProbeResult, String> {
    let mut cmd = keyed_ssh_options(port, identity, known_hosts)?;
    cmd.arg("-T");
    push_ssh_destination(&mut cmd, user, host)?;
    // Findings ride on stdout as `MARKER:value` lines (parsed below via
    // `extract_marker`) PLUS human-readable stderr markers + a nonzero exit for parity
    // with the old single-tool probe and for anyone reading raw ssh output by hand.
    cmd.arg(probe_script());
    let out = output_within(&mut cmd, crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT)
        .await
        .map_err(|e| e.message("the server"))?
        .ok_or_else(|| "ssh command timed out".to_string())?;
    parse_probe_output(
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
        out.status.success(),
    )
}

/// The stderr line that says why ssh failed: its last one — except OpenSSH's own
/// `Disconnected from <host> port <n>` trailer after a `Received disconnect from …:
/// <reason>` line, where the reason is kept (`Too many authentication failures` is a
/// refused key, [`crate::ssh_link::is_key_refusal_text`]; the trailer says nothing).
fn ssh_failure_line(stderr: &str) -> &str {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    match lines.as_slice() {
        [.., reason, last] if last.starts_with("Disconnected from ") && reason.starts_with("Received disconnect from ") => {
            reason
        }
        [.., last] => last,
        [] => "unknown error",
    }
}

/// Turns the probe script's captured stdout/stderr/exit-success triple into a
/// [`RemoteProbeResult`], or an `Err` when the ssh round-trip itself failed before the
/// script could report anything (unreachable host, auth refused, …). Pure — this is
/// what makes every combination of present/missing/outdated unit-testable without a
/// real ssh round-trip; [`probe_remote`] is the (untestable) shell around it.
///
/// The install-mode markers ([`RemoteProbeResult`]'s new B7 fields) are parsed
/// UNCONDITIONALLY here too, via the same [`extract_marker`]/[`parse_yes_no_marker`]
/// primitives — but [`probe_remote`]'s own script (used by [`add_machine`] pairing)
/// never emits them, so they simply come back `None` for every pairing call, exactly
/// the "ignores the new fields" behavior the brief requires. `bootstrap::connect`'s
/// own EXTENDED script (which DOES emit them) is what actually populates them; this
/// one function serves both, so there is exactly one place that turns probe stdout
/// into a [`RemoteProbeResult`], never two structs or two parsers drifting apart.
pub(crate) fn parse_probe_output(stdout: &str, stderr: &str, ssh_succeeded: bool) -> Result<RemoteProbeResult, String> {
    let raw_claude = extract_marker(stdout, "FLIGHTDECK_CLAUDE_VERSION:");
    let raw_flightdeckd = extract_marker(stdout, "FLIGHTDECK_DAEMON_VERSION:");
    // Neither marker LINE ever showed up (not just "showed up empty"): the script
    // itself never ran — a connection-level failure (bad host/key/auth), not a "tool
    // missing" finding the script would otherwise have reported via an empty value.
    if raw_claude.is_none() && raw_flightdeckd.is_none() && !ssh_succeeded {
        return Err(format!("Could not connect over SSH: {}", ssh_failure_line(stderr)));
    }
    let claude_version = raw_claude.filter(|s| !s.is_empty());
    let flightdeckd_version = raw_flightdeckd.filter(|s| !s.is_empty());

    let claude_missing = stderr.contains("FLIGHTDECK_NO_CLAUDE");
    let flightdeckd_missing = stderr.contains("FLIGHTDECK_NO_DAEMON");
    let flightdeckd_outdated = !flightdeckd_missing
        && flightdeckd_version
            .as_deref()
            .map(|v| !version_at_least(v, MIN_DAEMON_VERSION))
            .unwrap_or(false);

    let conflict = extract_marker(stdout, "FLIGHTDECK_CONFLICT:").filter(|s| !s.is_empty());
    let os = extract_marker(stdout, "FLIGHTDECK_OS:").filter(|s| !s.is_empty());
    let arch = extract_marker(stdout, "FLIGHTDECK_ARCH:").filter(|s| !s.is_empty());
    let systemd = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_SYSTEMD:"));
    let passwordless_sudo = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_PASSWORDLESS_SUDO:"));
    let linger = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_LINGER:"));
    let kill_user_processes = parse_yes_no_marker(extract_marker(stdout, "FLIGHTDECK_KILL_USER_PROCESSES:"));

    Ok(RemoteProbeResult {
        claude_version,
        claude_missing,
        flightdeckd_version,
        flightdeckd_missing,
        flightdeckd_outdated,
        conflict,
        os,
        arch,
        systemd,
        passwordless_sudo,
        linger,
        kill_user_processes,
    })
}

/// Turns a probe result that failed pairing's minimum bar into ONE human-readable
/// error, naming every blocker at once — so a server missing both `claude` and
/// `flightdeckd` doesn't make the user fix one, retry, then learn about the other.
///
/// A1's own hard block on this legacy/manual "Add a server" path is a deliberate
/// decision (kept as-is by B14) — it stays a dead end for a server missing `claude`,
/// rather than growing its own install step — but the wording it dead-ends into was
/// wrong on two counts: the official installer's command pipes to `bash`, not `sh`
/// (see `bootstrap::server_setup::install_claude`'s own citation), and it never
/// mentioned that the OTHER "Add a server" flow (`bootstrap_server`, B14's own
/// [`crate::bootstrap::orchestrator::StepId::InstallClaude`] step) installs Claude Code
/// for the user instead of requiring a manual ssh session at all.
fn describe_probe_blockers(probe: &RemoteProbeResult) -> String {
    let mut blockers = Vec::new();
    if probe.claude_missing {
        blockers.push(
            "`claude` is not installed on the server. On the server run: \
             curl -fsSL https://claude.ai/install.sh | bash — then log Claude in there \
             (`claude`), and retry. Or use \"Add a server\", which installs it for you."
                .to_string(),
        );
    }
    if probe.flightdeckd_missing {
        blockers.push(
            "`flightdeckd` is not installed on the server (checked PATH, ~/.local/bin \
             and /usr/local/bin) — install it before pairing."
                .to_string(),
        );
    } else if probe.flightdeckd_outdated {
        blockers.push(format!(
            "The server's `flightdeckd` ({}) is older than the minimum supported \
             version ({MIN_DAEMON_VERSION}). Update it on the server, then retry.",
            probe.flightdeckd_version.as_deref().unwrap_or("unknown version")
        ));
    }
    format!("Connected over SSH, but pairing can't proceed: {}", blockers.join(" "))
}

/// Minimum `flightdeckd` version that understands `--supports-skip` — the D6
/// reattach-replay compaction (`fd_skip{from,to}` frames replace runs of
/// already-complete replayable lines during a reattach with one short frame instead
/// of re-streaming them verbatim; measured −49% bytes on a real turn). An older
/// daemon's clap REJECTS the unknown flag outright (the whole attach fails), so this
/// MUST gate whether it is ever passed — never guessed, and never assumed equal to
/// [`MIN_DAEMON_VERSION`] (a daemon can be new enough to pair but still predate this
/// feature).
const MIN_SKIP_DAEMON_VERSION: &str = "0.2.0";

/// Minimum `flightdeckd` version that understands `attach --title` (C9) — landed in
/// the SAME daemon release as `--supports-skip`, so it shares its floor. Kept as its
/// own named constant (never literally re-using [`MIN_SKIP_DAEMON_VERSION`]) so the
/// two features can diverge in a LATER daemon release without silently dragging each
/// other along.
const MIN_TITLE_DAEMON_VERSION: &str = "0.2.0";

/// Per-app-run cache of a paired machine's PROBED `flightdeckd --version` output —
/// `Some(raw version string)`, or `None` when the probe itself failed/timed out —
/// keyed by [`crate::store::MachineRecord::id`]. Generalises the D6-era
/// `SKIP_SUPPORT_CACHE` (which cached only ONE derived bool) so every version-gated
/// optional attach flag — `--supports-skip` (D6) and `--title` (C9), each with its
/// own minimum — derives from the SAME cached probe instead of paying a separate ssh
/// round trip per flag for what is fundamentally one fact about the machine. In-memory
/// only, exactly like its predecessor: never persisted (the daemon can be upgraded
/// between app runs, and the probe is cheap enough to redo once per run), so a fresh
/// launch always reprobes a machine's first spawn, and every spawn after that in the
/// SAME run reuses the answer instead of paying another ssh round trip on what is
/// otherwise a hot path. `pub(crate)` invalidation: [`invalidate_daemon_version_cache`].
static DAEMON_VERSION_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pure gate: does `probed_version` (raw `flightdeckd --version` output, `None` on a
/// probe failure/timeout) clear [`MIN_SKIP_DAEMON_VERSION`]? Kept separate from the
/// ssh/caching machinery in [`supports_skip_for_machine`] so the gate itself is
/// unit-testable without a live probe.
fn should_request_skip(probed_version: Option<&str>) -> bool {
    probed_version
        .map(|v| version_at_least(v, MIN_SKIP_DAEMON_VERSION))
        .unwrap_or(false)
}

/// Pure gate: the C9 sibling of [`should_request_skip`] — does `probed_version` clear
/// [`MIN_TITLE_DAEMON_VERSION`]?
fn should_request_title(probed_version: Option<&str>) -> bool {
    probed_version
        .map(|v| version_at_least(v, MIN_TITLE_DAEMON_VERSION))
        .unwrap_or(false)
}

/// The cached (or freshly probed) `flightdeckd --version` output for `machine`, or
/// `None` on a probe failure/timeout. Every version-gated optional flag
/// (`supports_skip_for_machine`, `supports_title_for_machine`) derives from this ONE
/// probe — reusing A1's pairing probe ([`probe_remote`]) for the version, the SAME
/// `--version` round trip pairing already trusts, wrapped in an outer timeout as a
/// second belt (the probe's own `ConnectTimeout` only bounds the CONNECT phase, not a
/// remote shell that hangs after connecting). A probe failure OR timeout is cached as
/// `None` — this must NEVER block or fail the session spawn that asked for it; every
/// gate built on top of `None` treats it as "assume the oldest behavior", the safe
/// default against a daemon that might not understand a newer flag at all.
async fn daemon_version_for_machine(
    machine: &crate::store::MachineRecord,
    known_hosts_file: Option<&str>,
) -> Option<String> {
    if let Some(cached) = DAEMON_VERSION_CACHE.lock().unwrap().get(&machine.id) {
        return cached.clone();
    }
    let probed_version = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        probe_remote(
            &machine.host,
            machine.port,
            &machine.user,
            machine.identity_file.as_deref(),
            known_hosts_file,
        ),
    )
    .await
    .ok() // outer timeout elapsed -> None
    .and_then(Result::ok) // the ssh round trip itself failed -> None
    .and_then(|r| r.flightdeckd_version);
    DAEMON_VERSION_CACHE.lock().unwrap().insert(machine.id.clone(), probed_version.clone());
    probed_version
}

/// D6/C9 follow-up (review finding): drop `machine_id`'s cached probe so the VERY NEXT
/// call to [`daemon_version_for_machine`] re-learns it for real instead of repeating a
/// now-stale answer. Callers: `session.rs::run_actor`, when a reconnect attempt dies with
/// clap's unknown-argument rejection of `--supports-skip`/`--title`
/// (`looks_like_clap_flag_rejection`) — proof the cached version was wrong because the
/// server's `flightdeckd` was DOWNGRADED since it was learned; and the two paths that
/// change it on purpose — a finished bootstrap run (`orchestrator::
/// run_pipeline_and_register`) and a successful daemon-changing repair, a re-upload
/// above all (`orchestrator::settle_daemon_version_cache_after_repair`, the macOS
/// LaunchAgent update included). A no-op for an unknown/already-absent `machine_id`
/// (nothing to invalidate).
pub(crate) fn invalidate_daemon_version_cache(machine_id: &str) {
    DAEMON_VERSION_CACHE.lock().unwrap().remove(machine_id);
}

/// Test-only peek at whether `machine_id` currently has ANY cached entry (hit or a
/// cached probe failure alike) — lets `session::tests` assert
/// [`invalidate_daemon_version_cache`] actually ran as a side effect of the clap-
/// rejection path, without exposing a real (non-test) reader of the cache's
/// contents anywhere else.
#[cfg(test)]
pub(crate) fn daemon_version_cache_contains(machine_id: &str) -> bool {
    DAEMON_VERSION_CACHE.lock().unwrap().contains_key(machine_id)
}

/// Test-only seed, the write-side twin of [`daemon_version_cache_contains`] — lets
/// `session::tests` arrange "this machine's version is already cached" WITHOUT a
/// real ssh probe, so it can then assert the clap-rejection path actually clears it.
#[cfg(test)]
pub(crate) fn seed_daemon_version_cache_for_test(machine_id: &str, version: Option<String>) {
    DAEMON_VERSION_CACHE.lock().unwrap().insert(machine_id.to_string(), version);
}

/// Whether `machine`'s paired `flightdeckd` accepts `--supports-skip` (D6) — a
/// CACHED (see [`DAEMON_VERSION_CACHE`]), bounded, best-effort lookup [`spawn_session`]
/// feeds straight into the new session's
/// [`crate::supervisor::transport::AttachPoint::supports_skip`].
async fn supports_skip_for_machine(
    machine: &crate::store::MachineRecord,
    known_hosts_file: Option<&str>,
) -> bool {
    should_request_skip(daemon_version_for_machine(machine, known_hosts_file).await.as_deref())
}

/// Whether `machine`'s paired `flightdeckd` accepts `attach --title` (C9) — the sibling
/// of [`supports_skip_for_machine`], sharing its cache and its caller discipline: feeds
/// straight into [`crate::supervisor::transport::SpawnConfig::conversation_title`], and
/// is what [`push_remote_conversation_title`] re-checks before its own ad hoc attach.
async fn supports_title_for_machine(
    machine: &crate::store::MachineRecord,
    known_hosts_file: Option<&str>,
) -> bool {
    should_request_title(daemon_version_for_machine(machine, known_hosts_file).await.as_deref())
}

/// The order candidate addresses are tried in: a Tailscale name survives NAT/IP churn
/// the way a LAN or public IP doesn't, and a LAN address is more likely to still be
/// reachable than a bare hostname a DNS lookup may not resolve from this Mac. `Manual`
/// (typed by hand, or a `host` edit that doesn't match any discovered candidate) is
/// tried last — it's the least informed guess of the four.
fn address_kind_priority(kind: &AddressKind) -> u8 {
    match kind {
        AddressKind::Tailscale => 0,
        AddressKind::Lan => 1,
        AddressKind::Public => 2,
        AddressKind::Manual => 3,
    }
}

/// Order `candidates` by [`address_kind_priority`] (stable — candidates of equal
/// priority keep their relative input order) and drop later duplicates BY VALUE
/// (keeping the first, and therefore highest-priority, occurrence of a repeated
/// address). Pure: used to decide the order [`add_machine`] probes addresses in AND
/// the order `spawn_session` carries them on [`crate::supervisor::transport::
/// RemoteTarget::addresses`] for a later reconnect task (A6) to rotate through.
/// Idempotent — re-running it on its own output is a no-op, since the output is
/// already sorted and duplicate-free.
fn address_probe_order(candidates: Vec<AddressCandidate>) -> Vec<AddressCandidate> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<AddressCandidate> =
        candidates.into_iter().filter(|c| seen.insert(c.value.clone())).collect();
    deduped.sort_by_key(|c| address_kind_priority(&c.kind));
    deduped
}

/// Build the [`crate::supervisor::transport::RemoteTarget::addresses`] a spawn
/// carries for a machine: `host` — the address that last actually worked, the one
/// `RemoteTarget` still dials today — always FIRST, followed by every other recorded
/// candidate in [`address_probe_order`] priority, deduplicated by value against
/// `host`. Never empty, even for a machine paired before A5 recorded any candidates
/// (`addresses == []`, e.g. a pre-migration row): that case falls back to the single
/// known-good `host`. Pure, so the non-empty invariant is unit-tested without a spawn.
fn remote_target_addresses(host: &str, addresses: Vec<AddressCandidate>) -> Vec<String> {
    if addresses.is_empty() {
        return vec![host.to_string()];
    }
    let mut values: Vec<String> = vec![host.to_string()];
    for c in address_probe_order(addresses) {
        if c.value != host {
            values.push(c.value);
        }
    }
    values
}

/// The specific message shown for an `identity_file` that turned out to belong to a
/// pairing command someone else already claimed — surfaced by both
/// [`stale_identity_file_error`] (the up-front, best-effort check before the SSH
/// probe) and [`claim_pending_key`] (the actual point a concurrent claim of the SAME
/// pending key can lose the race — see [`claim_pending_key_locked`]). Kept as ONE
/// constant so the two call sites can never drift apart in wording.
const PENDING_KEY_ALREADY_USED_MSG: &str =
    "This pairing command was already used — click + Add a server again for a fresh one.";

/// [`PENDING_KEY_ALREADY_USED_MSG`]'s twin for the "Connect an existing server" form's
/// slot ([`CONNECT_PENDING_KEY_BASENAME`]), naming the form's own way to a fresh key.
/// Never "for ANOTHER server": nothing records who claimed the slot, and it is often
/// the same one — an attempt the user cancelled keeps running and claims it when it
/// lands, or the claim went through and saving the server then failed.
const CONNECT_KEY_ALREADY_USED_MSG: &str = "This key has already been used to connect a server — if that server is now \
     listed, you're done; otherwise open \"Connect an existing server\" again for a fresh key.";

/// The "already used" message for a pending key at `identity_file`: the form's slot
/// gets its own wording, anything else the wizard's.
fn already_used_message(identity_file: &Path) -> &'static str {
    if identity_file.file_name().and_then(|n| n.to_str()) == Some(CONNECT_PENDING_KEY_BASENAME) {
        CONNECT_KEY_ALREADY_USED_MSG
    } else {
        PENDING_KEY_ALREADY_USED_MSG
    }
}

/// The "already used" guard `add_machine` runs BEFORE probing: an `identity_file`
/// that no longer exists on disk means this pairing command was already claimed (see
/// [`claim_pending_key`]'s rename) — most likely the same command pasted onto two
/// boxes before either was paired, or, for the connect form's key, an attempt the user
/// cancelled that went on and claimed it. Returns the specific error
/// to show, or `None` when the check passes (including "no identity_file to check" —
/// the "use my default SSH key/agent" case, which is never stale).
///
/// This is a fast, best-effort pre-flight check ONLY — it runs several seconds before
/// the SSH probe, so a concurrent claim can still land in between. The guarantee
/// against that race lives at the actual claim, in
/// [`claim_pending_key_locked`]/[`claim_pending_key`].
fn stale_identity_file_error(identity_file: &Option<String>) -> Option<String> {
    let id = identity_file.as_deref()?;
    if Path::new(id).exists() {
        return None;
    }
    Some(already_used_message(Path::new(id)).to_string())
}

/// On a successful pairing, claims a PENDING key — if `identity_file` actually IS one
/// of the [`PENDING_KEY_SLOTS`] under `ssh_keys_dir` (the wizard's, or the "Connect an
/// existing server" form's) — by renaming it to a per-machine filename, so a LATER
/// `generate_machine_key`/`generate_connect_key` call (for the NEXT server) mints a
/// fresh pending pair instead of silently handing out this one's already-claimed key.
/// A non-pending `identity_file` (a custom key, or a key already claimed by a machine)
/// or `None` (default SSH key/agent) is returned UNCHANGED. Takes plain paths so it's
/// testable without a `tauri::AppHandle`.
///
/// If the rename fails because the slot is already gone (`NotFound` — a concurrent
/// caller won the race and claimed it first), this reports the SAME friendly "already
/// used" message [`stale_identity_file_error`] uses ([`already_used_message`]), rather
/// than the raw OS error, so a losing racer gets an actionable message either way.
/// Callers SHOULD go through [`claim_pending_key_locked`] rather than this directly, so
/// the rename itself can't interleave with another claim of the same pending path.
fn claim_pending_key(
    ssh_keys_dir: &Path,
    identity_file: Option<String>,
    machine_id: &str,
) -> Result<Option<String>, String> {
    let slot = identity_file
        .as_deref()
        .and_then(|id| PENDING_KEY_SLOTS.iter().map(|s| ssh_keys_dir.join(s)).find(|p| Path::new(id) == p));
    let Some(pending) = slot else {
        return Ok(identity_file);
    };
    let used = already_used_message(&pending);
    let claimed = ssh_keys_dir.join(machine_id);
    std::fs::rename(&pending, &claimed).map_err(|e| rename_error_message(e, used))?;
    std::fs::rename(format!("{}.pub", pending.display()), format!("{}.pub", claimed.display()))
        .map_err(|e| rename_error_message(e, used))?;
    Ok(Some(claimed.to_string_lossy().into_owned()))
}

/// Maps a failed `claim_pending_key` rename onto the friendly "already used" message
/// (`already_used`) when the cause is the source file having vanished (a concurrent
/// claim won the race), or the raw OS error string otherwise (a genuine filesystem
/// failure, e.g. permissions).
fn rename_error_message(e: std::io::Error, already_used: &str) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        already_used.to_string()
    } else {
        e.to_string()
    }
}

/// [`claim_pending_key`], guarded by [`PENDING_KEY_LOCK`] — the SAME lock
/// [`generate_or_reuse_pending_key`] uses. Closes the race two concurrent
/// [`add_machine`] calls sharing the same not-yet-claimed pending key can hit on the
/// rename inside `claim_pending_key`: without a shared lock, both can pass
/// [`stale_identity_file_error`]'s up-front check, both run their SSH probes, and
/// whichever calls `claim_pending_key` first wins the rename while the second's
/// `rename` lands on a path that's already gone. The lock only ever wraps the
/// instant rename itself — `add_machine` calls this AFTER its (multi-second) SSH
/// probe, so unrelated pairings (different pending keys, or none at all) are never
/// serialized behind it. Takes plain paths, like `claim_pending_key`, so it's
/// testable without a `tauri::AppHandle`.
async fn claim_pending_key_locked(
    ssh_keys_dir: &Path,
    identity_file: Option<String>,
    machine_id: &str,
) -> Result<Option<String>, String> {
    let _guard = PENDING_KEY_LOCK.lock().await;
    claim_pending_key(ssh_keys_dir, identity_file, machine_id)
}

/// Order candidates for [`add_machine`] to probe: `host` — the address the confirm
/// screen actually holds, whether typed by hand or picked from the ticket's
/// "Discovered addresses — pick one" list — is ALWAYS tried FIRST, exactly as
/// `add_machine` dialed it before per-kind priority-ordering existed. This is
/// load-bearing: the confirm screen's "pick one" buttons only ever call `setHost`,
/// they don't touch the `addresses` list, so a user who explicitly clicks e.g. the
/// LAN candidate must have LAN probed (and, on success, persisted as `machine.host`)
/// first — never silently outranked by a Tailscale candidate the user did NOT pick,
/// which `address_probe_order`'s fixed Tailscale>LAN>Public>Manual order would
/// otherwise put ahead of it. The REST of the ticket-discovered candidates (if any)
/// follow in [`address_probe_order`] priority as a fallback for when the user's own
/// pick turns out unreachable, deduplicated by value against `host` and each other.
/// `host` keeps its discovered kind (e.g. `Lan`) when it matches one of `addresses`
/// by value, and is recorded as `Manual` otherwise (typed by hand, or edited away
/// from every discovered candidate). Pure.
pub(crate) fn probe_candidates(host: &str, addresses: Option<Vec<AddressCandidate>>) -> Vec<AddressCandidate> {
    let discovered = addresses.unwrap_or_default();
    let host_kind = discovered
        .iter()
        .find(|c| c.value == host)
        .map(|c| c.kind.clone())
        .unwrap_or(AddressKind::Manual);
    let mut candidates = vec![AddressCandidate { kind: host_kind, value: host.to_string() }];
    for c in address_probe_order(discovered) {
        if c.value != host {
            candidates.push(c);
        }
    }
    candidates
}

/// Merge a fresh pairing attempt's probed candidates with an already-paired machine's
/// previously recorded addresses (B_lifecycle-#1 review finding): naively overwriting
/// `addresses` with only what THIS attempt discovered would silently drop every other
/// address recorded on an earlier pairing — e.g. re-pairing the same server manually,
/// with no ticket this time, against a machine whose Tailscale/LAN candidates were
/// discovered on its original pairing. `new` keeps priority (its `host` stays first,
/// per [`probe_candidates`]'s own contract) — deduplicated by value against
/// `existing`, whose entries are appended, in their own recorded order, for whatever
/// `new` doesn't already cover. Pure.
fn merge_address_candidates(new: &[AddressCandidate], existing: &[AddressCandidate]) -> Vec<AddressCandidate> {
    let mut seen: std::collections::HashSet<&str> = new.iter().map(|c| c.value.as_str()).collect();
    let mut merged: Vec<AddressCandidate> = new.to_vec();
    for c in existing {
        if seen.insert(c.value.as_str()) {
            merged.push(c.clone());
        }
    }
    merged
}

/// The result of [`add_machine`]: the saved [`MachineRecord`], plus whether it
/// UPDATED an already-paired server (`matched_existing: true`) rather than adding a
/// brand-new one — see [`add_machine`]'s own doc (B_lifecycle-#1 review finding). The
/// UI uses this to say "Updated the existing server …" instead of implying a second
/// server was added.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AddMachineOutcome {
    pub machine: MachineRecord,
    pub matched_existing: bool,
    /// `true` only when the matched server had a key Flight Deck minted and the saved
    /// record no longer uses it — the old key no longer got in and the server was saved
    /// with this Mac's own SSH keys, or a newly given key replaced it. A new pending key
    /// is usually claimed onto the old key's own `ssh_keys/<machine id>` path, which
    /// overwrites it on the spot; any other dropped key file (this Mac's keys took over,
    /// or a legacy `{slug}-{uuid}` name) is left unreferenced, for a later launch's
    /// orphan sweep ([`sweep_orphan_ssh_keys`]). Without a Flight Deck key the repairs
    /// that need one ([`crate::bootstrap::orchestrator::KEY_ONLY_REPAIRS`]) are refused —
    /// so the UI says so.
    pub previous_key_dropped: bool,
}

/// Which identities [`add_machine`] probes with, in order (`None` = this Mac's own SSH
/// setup: `~/.ssh` keys, `~/.ssh/config`, ssh-agent). A key the caller passed is the
/// only one tried. Without one, a matched server's existing Flight Deck key
/// (`existing_app_key`, already confirmed to live in `ssh_keys/`) is tried FIRST, on
/// every candidate, and this Mac's own setup only where that key was refused
/// ([`first_working_login`]): re-connecting an already-listed server with "This Mac's
/// SSH keys" used to save `None` over its Flight Deck key, and the next launch's
/// orphan sweep then deleted the key file. Pure.
fn identities_to_try(requested: Option<&str>, existing_app_key: Option<&str>) -> Vec<Option<String>> {
    match (requested, existing_app_key) {
        (Some(key), _) => vec![Some(key.to_string())],
        (None, Some(existing)) => vec![Some(existing.to_string()), None],
        (None, None) => vec![None],
    }
}

/// A matched server's own Flight Deck key — its `identity_file` when that is a key file
/// Flight Deck minted ([`is_app_owned_key`], which also rules out a file that no longer
/// exists). A key of the user's own (`~/.ssh/...`) is not one: nothing sweeps it.
fn existing_flight_deck_key(existing: Option<&MachineRecord>, ssh_keys_dir: &Path) -> Option<String> {
    existing
        .and_then(|m| m.identity_file.clone())
        .filter(|key| is_app_owned_key(key, ssh_keys_dir))
}

/// [`AddMachineOutcome::previous_key_dropped`]: the matched server had a Flight Deck key
/// (`existing_app_key`) and the identity that worked (`used`, before any pending-key
/// claim) is not it. Pure.
fn previous_key_dropped(existing_app_key: Option<&str>, used: Option<&str>) -> bool {
    existing_app_key.is_some() && used != existing_app_key
}

/// The label [`add_machine`] saves: the typed one, trimmed; when it is blank, a
/// matched server keeps its own (a blank Name used to replace it with the raw address)
/// and a new one is named after the address that worked. Pure.
fn machine_label(requested: &str, existing_label: Option<&str>, working_host: &str) -> String {
    let requested = requested.trim();
    if !requested.is_empty() {
        requested.to_string()
    } else {
        existing_label.unwrap_or(working_host).to_string()
    }
}

/// [`add_machine`]'s probe loop: each identity in turn ([`identities_to_try`]), on the
/// candidates in order, until one gets in with `claude` and a current `flightdeckd`
/// present — returning that address and identity, or an error naming every attempt.
///
/// A later identity is only tried on the candidates where the one before it was
/// REFUSED ([`crate::ssh_link::is_key_refusal_text`] — the one failure another identity
/// can get past; unreachable, timed out, a changed host key or a server missing
/// `claude`/`flightdeckd` fail the same way whatever key is offered): this Mac's own
/// keys can't reach a server Flight Deck's saved key couldn't reach either, and trying
/// them anyway made an offline server take twice the ssh timeout to report. When that
/// skips them entirely, the error says so. `probe` stands in for [`probe_remote`]
/// (`(host, identity)`), so the loop is testable without ssh.
async fn first_working_login<F, Fut>(
    identities: &[Option<String>],
    candidates: &[AddressCandidate],
    mut probe: F,
) -> Result<(String, Option<String>), String>
where
    F: FnMut(String, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<RemoteProbeResult, String>>,
{
    let mut failures: Vec<String> = Vec::new();
    let mut eligible: Vec<&AddressCandidate> = candidates.iter().collect();
    let mut untried_identity = false;
    for (index, identity) in identities.iter().enumerate() {
        if eligible.is_empty() {
            untried_identity = index > 0;
            break;
        }
        let tried_with = match (identities.len() > 1, identity) {
            (false, _) => String::new(),
            (true, Some(_)) => " with Flight Deck's saved key".to_string(),
            (true, None) => " with this Mac's SSH keys".to_string(),
        };
        let mut refused: Vec<&AddressCandidate> = Vec::new();
        for c in eligible {
            match probe(c.value.clone(), identity.clone()).await {
                Ok(p) if !(p.claude_missing || p.flightdeckd_missing || p.flightdeckd_outdated) => {
                    return Ok((c.value.clone(), identity.clone()));
                }
                Ok(p) => failures.push(format!("{}{tried_with}: {}", c.value, describe_probe_blockers(&p))),
                Err(e) => {
                    if crate::ssh_link::is_key_refusal_text(&e) {
                        refused.push(c);
                    }
                    failures.push(format!("{}{tried_with}: {e}", c.value));
                }
            }
        }
        eligible = refused;
    }
    let mut message = format!("Could not pair — every address failed. {}", failures.join(" — "));
    if untried_identity {
        message.push_str(
            " (This Mac's SSH keys were not tried: they are only tried where the server refuses Flight Deck's saved \
             key, and it didn't.)",
        );
    }
    Err(message)
}

/// [`add_machine`]'s candidates after the host-key gate ([`gate_candidates`]).
#[derive(Debug, Default)]
struct GatedCandidates {
    /// Each candidate let through, with the fingerprint of the host key it presents.
    confirmed: Vec<(AddressCandidate, String)>,
    /// Each candidate refused, with why.
    refused: Vec<(String, String)>,
}

impl GatedCandidates {
    fn refusals(&self) -> String {
        self.refused.iter().map(|(host, e)| format!("{host}: {e}")).collect::<Vec<_>>().join(" — ")
    }

    fn fingerprints(&self) -> Vec<String> {
        self.confirmed.iter().map(|(_, fp)| fp.clone()).collect()
    }
}

/// ⚠️ Host key first (M12, audit sec-hostkey#4): [`add_machine`]'s keyed path pins
/// whatever answers (`accept-new`) and offers a key — every key of this Mac's agent,
/// with "This Mac's SSH keys" — and a paired server is later sent sudo passwords, a
/// Claude sign-in code and phone keys. So each candidate's key is read first with
/// nothing sent ([`crate::bootstrap::connect::ensure_confirmed_host_key`]): the saved key
/// of an address a paired server uses (`paired_machines`) goes on, any other only when
/// it is exactly `confirmed_host_key` (pinned then, as the only key saved for it). A
/// refused candidate is never probed ([`login_over_gated`]).
async fn gate_candidates(
    known_hosts: &str,
    port: u16,
    user: &str,
    candidates: &[AddressCandidate],
    confirmed_host_key: Option<&str>,
    paired_machines: &[MachineRecord],
) -> GatedCandidates {
    use crate::bootstrap::connect;
    let mut gated = GatedCandidates::default();
    for c in candidates {
        let target = connect::BootstrapTarget { host: c.value.clone(), port, user: user.to_string() };
        let paired = connect::host_is_paired(paired_machines, &c.value, port);
        match connect::ensure_confirmed_host_key(&target, known_hosts, confirmed_host_key, paired).await {
            Ok(key) => gated.confirmed.push((c.clone(), key.fingerprint)),
            Err(e) => gated.refused.push((c.value.clone(), e.to_string())),
        }
    }
    gated
}

/// [`add_machine`]'s probing: every candidate the gate let through, in order, with each
/// identity ([`first_working_login`]), over the keyed path ([`probe_remote`]) —
/// collecting every failure along the way so a total failure can name each address
/// tried (and, when more than one identity was tried, with which), refusals included.
/// With a single candidate refused, its refusal is returned as is, so the form can show
/// the fingerprint (`HostKeyUnconfirmed`) or the changed key.
async fn login_over_gated(
    known_hosts: &str,
    port: u16,
    user: &str,
    identities: &[Option<String>],
    gated: &GatedCandidates,
) -> Result<(String, Option<String>), String> {
    if gated.confirmed.is_empty() {
        return Err(match gated.refused.as_slice() {
            [(_, only)] => only.clone(),
            _ => format!("Could not pair — every address failed. {}", gated.refusals()),
        });
    }
    let confirmed: Vec<AddressCandidate> = gated.confirmed.iter().map(|(c, _)| c.clone()).collect();
    first_working_login(identities, &confirmed, |host, identity| async move {
        probe_remote(&host, port, user, identity.as_deref(), Some(known_hosts)).await
    })
    .await
    .map_err(|e| if gated.refused.is_empty() { e } else { format!("{e} — {}", gated.refusals()) })
}

/// The listed server a pairing may update (audit sec-trust-boundary#3): `existing` — the
/// one [`crate::store::Store::machine_by_any_address`] matched by a shared address
/// literal — only when the server reached is provably that one: every candidate the
/// gate let through presents a host key this Mac saved for `existing`'s own working
/// address. A private LAN address or a hostname another network reuses matched a
/// DIFFERENT server, and folding it in overwrote the listed server's record and Flight
/// Deck key and re-homed its conversations. `Ok(None)`: pair it as a new server.
async fn converge_on_existing(
    known_hosts: &str,
    existing: Option<MachineRecord>,
    gated: &GatedCandidates,
) -> Result<Option<MachineRecord>, String> {
    let Some(existing) = existing else { return Ok(None) };
    let saved = crate::bootstrap::connect::saved_host_key_fingerprints(known_hosts, &existing.host, existing.port)
        .await
        .map_err(|e| format!("could not tell whether this is the listed server “{}”: {e}", existing.label))?;
    Ok(same_server_by_host_key(&saved, &gated.fingerprints()).then_some(existing))
}

/// Whether every host key `reached` (one per candidate let through) is among those
/// `saved` for a listed server's own address — the proof [`converge_on_existing`] asks
/// for. Nothing reached proves nothing. Pure.
fn same_server_by_host_key(saved: &[String], reached: &[String]) -> bool {
    !reached.is_empty() && reached.iter().all(|fp| saved.contains(fp))
}

/// Pair a remote server: probe the confirmed `host` first, then fall back through the
/// rest of the ticket-discovered candidates in [`address_probe_order`] (Tailscale,
/// then LAN, then public, then manual — see [`probe_candidates`]), stopping at the
/// first that's SSH-reachable with `claude` and a current `flightdeckd` present, and
/// on success persist it as a [`MachineRecord`]. Returns the saved record so the UI
/// lists it. Probing runs FIRST so a bad host/key/paste or a missing/outdated tool
/// fails loudly here, not at the first message.
///
/// `addresses` is the full set of candidate hosts the pairing ticket discovered
/// (Tailscale name, LAN IP, bare hostname). The address that actually worked is
/// persisted as `host` — what every other part of the app dials — while the full
/// ordered, deduplicated candidate list (including `host` itself) is persisted as
/// `addresses`, carried for a later task (A6) to rotate through on a failed
/// reconnect; the transport itself still only ever dials `host` today. When every
/// candidate fails, the returned error names each one tried and why.
///
/// Converges on an already-paired server the SAME way the B11 bootstrap orchestrator
/// does (B_lifecycle-#1 review finding — this used to always mint a fresh id, so
/// pairing a server already paired by the wizard, or by an earlier legacy pairing of
/// the same host, minted a DUPLICATE [`MachineRecord`]): before persisting, every
/// candidate this attempt probed is checked against every OTHER machine's own
/// `host`/`addresses` via [`crate::store::Store::machine_by_any_address`] — a
/// different working address this time (a rotated Tailscale IP, or simply a different
/// candidate answering first) still converges on the same row, keyed by (port, user).
/// A different port or user is a different machine (a different login) and is never
/// folded together. A shared address is only a lead, never proof (audit
/// sec-trust-boundary#3): the matched server is updated only when the one reached
/// presents the host key saved for its own address ([`converge_on_existing`]) — decided
/// before its Flight Deck key is offered to anyone; otherwise this pairs a new server.
///
/// `confirmed_host_key` (M12, audit sec-hostkey#4): the `SHA256:` fingerprint the user
/// checked in the form (`bootstrap_check_host_key`) — nothing keyed runs against any
/// other key than a paired server's saved one or exactly this one
/// ([`gate_candidates`]).
///
/// Re-connecting a matched server keeps what the caller left out: without an
/// `identity_file`, its existing Flight Deck key is tried before this Mac's own SSH
/// setup ([`identities_to_try`], reported through
/// [`AddMachineOutcome::previous_key_dropped`]), and a blank `label` keeps its name
/// ([`machine_label`]; a new server is then named after the address that worked).
///
/// Claims this host's [`ServerLocks`] slot (B_lifecycle-#addmachinelock review
/// finding) BEFORE the first ssh round trip — `Err` with [`server_busy_error`] when a
/// `bootstrap_server`/`bootstrap_resume`/`machine_repair` already has one in flight
/// against the same server. Before this fix, this legacy/manual pairing command was
/// the ONE entry point of the four that never claimed the lock at all, so it could
/// still interleave ssh writes (key install, `AddMachine`'s pending-key rename) with
/// one of the other three targeting the exact same host — precisely the race
/// [`ServerLocks`] exists to prevent. Never blocks/waits; never pauses across separate
/// calls the way the bootstrap pipeline can, so the guard is simply allowed to drop at
/// the end of this call, the same as [`crate::bootstrap::orchestrator::machine_repair`].
#[tauri::command]
#[specta::specta]
pub async fn add_machine(
    app: tauri::AppHandle,
    locks: tauri::State<'_, Arc<crate::bootstrap::orchestrator::ServerLocks>>,
    label: String,
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    addresses: Option<Vec<AddressCandidate>>,
    confirmed_host_key: Option<String>,
) -> Result<AddMachineOutcome, String> {
    if let Some(err) = stale_identity_file_error(&identity_file) {
        return Err(err);
    }

    // Validated BEFORE any candidate is probed (CRM holistic-review blocker #3,
    // chantier A `bd7ca709`): `user` is shared by EVERY candidate probed below, and
    // — unlike `host` — was never validated at all before this fix, so a value
    // shaped like an ssh option (`-oProxyCommand=...`) reached `probe_remote` for
    // every one of them.
    validate_ssh_user(&user)?;
    crate::store::validate_ssh_port(port)?;

    let candidates = probe_candidates(host.trim(), addresses);
    for c in &candidates {
        validate_address_value(&c.value)?;
    }

    // Same convergence rule `bootstrap_server`/`bootstrap_resume` already run, applied
    // to every candidate this attempt is willing to accept as "this host" (not just
    // the one that happened to answer first this time) — see this function's own doc.
    // Computed BEFORE probing (it only needs the candidate list, not a live probe) so
    // the [`ServerLocks`] claim right below can use the SAME key those three other
    // entry points would use for this exact server.
    let candidate_values: Vec<String> = candidates.iter().map(|c| c.value.clone()).collect();
    let existing = app
        .state::<Store>()
        .machine_by_any_address(&candidate_values, port, &user)
        .map_err(|e| e.to_string())?;
    let lock_key = crate::bootstrap::orchestrator::server_lock_key(
        existing.as_ref().map(|m| m.id.as_str()),
        host.trim(),
        port,
        &user,
    );
    let guard = crate::bootstrap::orchestrator::ServerLockGuard::acquire(&locks, lock_key, "Add a server")
        .map_err(crate::bootstrap::orchestrator::server_busy_error)?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let known_hosts = app_data_dir.join("remote_known_hosts").to_string_lossy().into_owned();

    let paired = app.state::<Store>().all_machines().map_err(|e| e.to_string())?;
    let gated = gate_candidates(&known_hosts, port, &user, &candidates, confirmed_host_key.as_deref(), &paired).await;
    // Decided before any key is offered: a listed server's own Flight Deck key never goes
    // to another server that merely shares one of its addresses.
    let existing = converge_on_existing(&known_hosts, existing, &gated).await?;

    let existing_app_key = existing_flight_deck_key(existing.as_ref(), &app_data_dir.join("ssh_keys"));
    let identities = identities_to_try(identity_file.as_deref(), existing_app_key.as_deref());

    let (working_host, identity_file) = login_over_gated(&known_hosts, port, &user, &identities, &gated).await?;

    let matched_existing = existing.is_some();
    let previous_key_dropped = previous_key_dropped(existing_app_key.as_deref(), identity_file.as_deref());
    let label = machine_label(&label, existing.as_ref().map(|m| m.label.as_str()), &working_host);
    // Merge in the matched machine's own recorded addresses (see
    // `merge_address_candidates`'s own doc) BEFORE consuming `existing` for its id —
    // an already-paired server keeps every address it has ever answered on, not just
    // the ones this particular re-pairing attempt happened to (re)discover.
    let candidates = match &existing {
        Some(ex) => merge_address_candidates(&candidates, &ex.addresses),
        None => candidates,
    };
    let existing_id = existing.map(|m| m.id);

    let machine =
        persist_paired_machine(&app, existing_id, label, working_host, port, user, identity_file, candidates)
            .await?;
    drop(guard);
    Ok(AddMachineOutcome { machine, matched_existing, previous_key_dropped })
}

/// Persist an ALREADY-VERIFIED pairing (reachable, `identity_file` either already
/// accepted or about to be claimed) as a [`MachineRecord`] — the shared tail of
/// [`add_machine`]'s own probing loop AND
/// [`crate::bootstrap::orchestrator::step_add_machine`] (B11 review finding: the
/// orchestrator pipeline used to reuse [`add_machine`] VERBATIM, which routes every
/// pairing through [`probe_remote`]'s own `claude`/`flightdeckd`-gated probe — so the
/// WHOLE pipeline failed, rather than reaching `NeedsClaudeSignIn`, on every server
/// that doesn't have `claude` installed yet, i.e. every one of the brief's own
/// fixtures and the primary "bootstrap a fresh box" use case. The pipeline verifies
/// reachability itself, via its own `StepId::Probe`, and handles "claude missing" as
/// its own, later, non-blocking `StepId::ClaudeAuth` step, so it calls this directly
/// instead).
///
/// `existing_machine_id`: `Some` reuses that id — [`Store::update_machine`] then updates
/// the SAME row instead of inserting a second one, and refuses when that row is gone
/// (removed meanwhile — [`save_paired_machine`]). The orchestrator resolves this via a
/// [`crate::store::Store::machine_by_address`] match BEFORE running its pipeline;
/// `add_machine` resolves it via the broader
/// [`crate::store::Store::machine_by_any_address`] (B_lifecycle-#1 review finding —
/// it used to always pass `None` here, minting a fresh uuid on every call, which
/// duplicated the row for a server already paired). `None` when no existing machine
/// converged — a genuinely new server.
///
/// Claims the pending key (a no-op when `identity_file` is already a per-machine
/// path, e.g. the orchestrator reusing a PREVIOUSLY claimed key — see
/// [`claim_pending_key`]), builds/upserts the record, and fires the SAME C10
/// "provision this Mac's phone, if one is already configured" hook `add_machine`
/// always has.
pub(crate) async fn persist_paired_machine(
    app: &tauri::AppHandle,
    existing_machine_id: Option<String>,
    label: String,
    working_host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    addresses: Vec<AddressCandidate>,
) -> Result<MachineRecord, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let existing = existing_machine_id.is_some();
    let machine_id = existing_machine_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let identity_file =
        claim_pending_key_locked(&app_data_dir.join("ssh_keys"), identity_file, &machine_id).await?;

    let machine = MachineRecord {
        id: machine_id,
        label,
        host: working_host,
        port,
        user,
        identity_file,
        added_at: now_ms(),
        addresses,
        daemon_mac_id: None,
        daemon_relay_url: None,
        daemon_label: None,
        phone_provisioned_at: None,
    };
    save_paired_machine(&app.state::<Store>(), &machine, existing)?;

    // C10 hook (a): a freshly paired server should already answer this phone,
    // without a separate manual step — but only when there is a phone pairing to
    // extend in the first place (remote access enabled AND a token minted); a
    // fresh install with remote access off has neither, and this must stay a
    // silent no-op rather than mint a token/turn anything on by itself.
    // Backgrounded so pairing a server never waits on a THIRD ssh round trip on
    // top of the probe(s) already paid above.
    let cfg = load_remote_config(&app.state::<Store>());
    if cfg.enabled && !cfg.phone_token.is_empty() {
        let app2 = app.clone();
        let machine_id = machine.id.clone();
        tokio::spawn(async move {
            let store = app2.state::<Store>();
            let known_hosts = remote_known_hosts_path(&app2);
            let registry = (*app2.state::<Arc<crate::appmcp::provision::ProvisionRegistry>>()).clone();
            let state = crate::appmcp::provision::provision_phone_on_machine(&store, known_hosts.as_deref(), &machine_id)
                .await
                .unwrap_or_else(|e| crate::appmcp::provision::ProvisionState::Failed { reason: e });
            registry.record(&machine_id, state);
        });
    }
    // The sealed-channel phones get their keys on the new server too (a no-op
    // without any paired phone).
    if cfg.enabled {
        crate::ipc::remote_devices::spawn_device_sync(app);
    }

    Ok(machine)
}

/// [`persist_paired_machine`]'s write: a new server is inserted; one the pairing
/// converged on (`existing`) is only ever UPDATED (audit sec-keys#2) — when its row is
/// gone (removed meanwhile), the pairing is refused rather than re-creating it with a key
/// the removal deleted.
fn save_paired_machine(store: &Store, machine: &MachineRecord, existing: bool) -> Result<(), String> {
    if !existing {
        return store.upsert_machine(machine).map_err(|e| e.to_string());
    }
    match store.update_machine(machine) {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!(
            "“{}” was removed while it was being connected — add it again to pair it",
            machine.label
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// Core of [`delete_machine`], taking a plain `&Store` — pulled out so it's testable
/// without a `tauri::State` wrapper (unavailable outside a running app). Removes the
/// server and everything anchored to it, and best-effort deletes its dedicated SSH
/// keypair (`Store::delete_machine` is SQL-only — without this, every removed server
/// permanently leaked its key files on disk).
///
/// The removal is best-effort by design — the record must still go even if the key
/// files can't be cleaned up (e.g. already gone, or a permissions issue) — but a
/// failure OTHER than "already missing" is still logged (never just discarded), so a
/// stuck key file is diagnosable instead of leaking silently again under a different
/// cause than the one this function was written to fix.
///
/// ⚠️ Only a key Flight Deck minted is ever deleted — one that lives directly in
/// `ssh_keys_dir` ([`is_app_owned_key`]). `add_machine` accepts any `identity_file`, and
/// one that points at the user's own key (`~/.ssh/id_ed25519`) must survive removing
/// the server. `None` (no app data dir) deletes no file at all.
fn delete_machine_and_key(store: &Store, ssh_keys_dir: Option<&Path>, id: &str) -> Result<(), String> {
    // Read the record BEFORE deleting it — the row (and its identity_file path) is
    // gone from the store immediately after.
    let identity_file = store.machine_by_id(id).map_err(|e| e.to_string())?.and_then(|m| m.identity_file);
    store.delete_machine(id).map_err(|e| e.to_string())?;
    if let (Some(identity), Some(dir)) = (identity_file, ssh_keys_dir) {
        if is_app_owned_key(&identity, dir) {
            log_remove_file_failure(&identity);
            log_remove_file_failure(&format!("{identity}.pub"));
        }
    }
    Ok(())
}

/// Whether `identity` is a key file directly inside `ssh_keys_dir` (Flight Deck's own
/// keys), comparing canonical paths so a `..` or a symlinked parent can't slip a
/// foreign key past the check. A path that can't be resolved is not ours.
fn is_app_owned_key(identity: &str, ssh_keys_dir: &Path) -> bool {
    let (Ok(key), Ok(dir)) = (Path::new(identity).canonicalize(), ssh_keys_dir.canonicalize()) else {
        return false;
    };
    key.parent() == Some(dir.as_path())
}

/// What removing a server did about this Mac's phone access on it (security review
/// M10) — the front warns, and offers "Regenerate pairing", when it could not be
/// confirmed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MachineRemoval {
    /// The outcome for this Mac's CURRENT phone pairing on that server's daemon. `None`
    /// when the server never had it (never provisioned, or no pairing minted) — there
    /// was nothing to withdraw.
    pub phone_revoke: Option<crate::appmcp::provision::RevokeOutcome>,
    /// Some phone token on it is not confirmed gone: Flight Deck retries at each launch
    /// (`retry_removed_server_revocations`), keeping the server's own key until then.
    pub retry_pending: bool,
    /// Encrypted phones that server did not confirm forgetting (retried the same way).
    pub devices_unconfirmed: u32,
}

/// C10 hook (c), made durable (security review M10): `flightdeckd remove-phone` for
/// every phone token this Mac may have left on the machine — the current pairing when
/// it was provisioned there, plus any older one still queued for it — BEFORE it is
/// deleted locally. A token the daemon confirms gone is done. One it does not (off,
/// unreachable, refused, too old) is no longer queued-then-dropped with the machine row
/// in the same call: [`Store::retire_machine_with_revocations`] keeps a tombstone that
/// outlives the row, the server's Flight Deck key stays on disk to reach it, and the
/// next launches retry ([`retry_removed_server_revocations`]). The removal itself is
/// never blocked — the user asked to remove a server, not to be stuck because it is
/// offline — and the outcome is reported ([`MachineRemoval`]) instead of a bare success.
/// An unreachable daemon is dialed once, not once per token.
///
/// Testable core (plain `&Store` + `known_hosts`, mirrors
/// `appmcp::provision`'s own split) — the `#[tauri::command]` below is a thin
/// `AppHandle`-unwrapping shell around it.
async fn delete_machine_core(
    store: &Store,
    locks: &Arc<crate::bootstrap::orchestrator::ServerLocks>,
    known_hosts: Option<&str>,
    ssh_keys_dir: Option<&Path>,
    id: &str,
) -> Result<MachineRemoval, String> {
    // Held for the whole removal (audit sec-keys#2): `add_machine`, a bootstrap run and
    // `machine_repair` on this server claim the same key, so none of them can re-create
    // the row with a key this deletes, or see the server it just re-added vanish.
    let _guard = crate::bootstrap::orchestrator::ServerLockGuard::acquire(
        locks,
        crate::bootstrap::orchestrator::server_lock_key(Some(id), "", 0, ""),
        "Remove a server",
    )
    .map_err(crate::bootstrap::orchestrator::server_busy_error)?;
    let Some(machine) = store.machine_by_id(id).map_err(|e| e.to_string())? else {
        delete_machine_and_key(store, ssh_keys_dir, id)?;
        return Ok(MachineRemoval { phone_revoke: None, retry_pending: false, devices_unconfirmed: 0 });
    };
    let current = if machine.phone_provisioned_at.is_some() {
        Some(load_remote_config(store).phone_token).filter(|t| !t.is_empty())
    } else {
        None
    };
    let mut tokens: Vec<String> = current.iter().cloned().collect();
    for older in store.pending_daemon_phone_revocations(id).unwrap_or_default() {
        if !tokens.contains(&older) {
            tokens.push(older);
        }
    }

    let mut phone_revoke = None;
    let mut unconfirmed: Vec<String> = Vec::new();
    let mut reachable = true;
    for token in tokens {
        let outcome = if reachable {
            crate::appmcp::provision::remove_phone_from_daemon(known_hosts, &machine, &token).await
        } else {
            crate::appmcp::provision::RevokeOutcome::Queued
        };
        if outcome == crate::appmcp::provision::RevokeOutcome::Queued {
            reachable = false;
        }
        if outcome != crate::appmcp::provision::RevokeOutcome::Removed {
            unconfirmed.push(token.clone());
        }
        if current.as_deref() == Some(token.as_str()) {
            phone_revoke = Some(outcome);
        }
    }

    // Sealed-channel phones: the server forgets each one it may hold (provisioned, or a
    // revoked one whose removal it still owes). One it does not confirm gets the same
    // tombstone as a legacy token: a key left on a server this Mac no longer manages
    // would let that phone keep driving it, with nothing left to revoke it from.
    let held: Vec<String> = store
        .remote_device_servers()
        .map_err(|e| format!("could not read which phones this server holds: {e}"))?
        .into_iter()
        .filter(|s| s.machine_id == id && (s.generation.is_some() || s.remove_pending))
        .map(|s| s.device_id)
        .collect();
    let mut unconfirmed_devices: Vec<String> = Vec::new();
    for device_id in held {
        let removed = reachable
            && crate::appmcp::device_provision::remove_device_from_machine(store, known_hosts, &machine, &device_id).await
                == crate::appmcp::device_provision::DeviceServerOutcome::Removed;
        if !removed {
            unconfirmed_devices.push(device_id);
        }
    }

    if unconfirmed.is_empty() && unconfirmed_devices.is_empty() {
        delete_machine_and_key(store, ssh_keys_dir, id)?;
    } else {
        // The key file stays: it is the only way back to that daemon for the retry.
        store
            .retire_machine_with_removals(&machine, &unconfirmed, &unconfirmed_devices, now_ms())
            .map_err(|e| e.to_string())?;
    }
    Ok(MachineRemoval {
        phone_revoke,
        retry_pending: !unconfirmed.is_empty() || !unconfirmed_devices.is_empty(),
        devices_unconfirmed: unconfirmed_devices.len() as u32,
    })
}

/// The launch-time retry of M10's tombstones ([`delete_machine_core`]): asks each
/// removed server's daemon again (`appmcp::provision::retry_removed_server_revocations`)
/// and, for every removed server now fully settled, deletes the Flight Deck key kept to
/// reach it — only a key in `ssh_keys_dir` ([`is_app_owned_key`]) that no paired server
/// uses. Best-effort and silent towards the UI (the removal already warned); every
/// failure is logged.
pub(crate) async fn retry_removed_server_revocations(
    store: &Store,
    known_hosts: Option<&str>,
    ssh_keys_dir: Option<&Path>,
) {
    let settled = crate::appmcp::provision::retry_removed_server_revocations(store, known_hosts).await;
    if settled.is_empty() {
        return;
    }
    let Ok(live) = store.all_machines() else {
        eprintln!("[machines] kept removed servers' keys: could not read the machine list");
        return;
    };
    let referenced = referenced_key_paths(&live);
    for machine in settled {
        let (Some(identity), Some(dir)) = (machine.identity_file.as_deref(), ssh_keys_dir) else { continue };
        let in_use = Path::new(identity).canonicalize().map(|p| referenced.contains(&p)).unwrap_or(false);
        if !in_use && is_app_owned_key(identity, dir) {
            log_remove_file_failure(identity);
            log_remove_file_failure(&format!("{identity}.pub"));
        }
    }
}

/// Best-effort `std::fs::remove_file`, logging any failure that isn't "the file was
/// already gone" (an ordinary, expected case — e.g. only the `.pub` half was ever
/// written, or a previous delete already removed it) rather than discarding it via a
/// bare `let _ =`.
fn log_remove_file_failure(path: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[machines] failed to remove key file {path}: {e}");
        }
    }
}

/// Un-pair a remote server. See [`delete_machine_core`] (revoke-before-delete, and
/// what it reports) and [`delete_machine_and_key`] (the delete itself).
#[tauri::command]
#[specta::specta]
pub async fn delete_machine(
    app: tauri::AppHandle,
    locks: tauri::State<'_, Arc<crate::bootstrap::orchestrator::ServerLocks>>,
    id: String,
) -> Result<MachineRemoval, String> {
    let store = app.state::<Store>();
    let known_hosts = remote_known_hosts_path(&app);
    let ssh_keys_dir = app.path().app_data_dir().ok().map(|d| d.join("ssh_keys"));
    delete_machine_core(&store, &locks, known_hosts.as_deref(), ssh_keys_dir.as_deref(), &id).await
}

/// Run a command on a server over SSH (batch, never-prompting), returning stdout on
/// success or the last stderr line on failure. The connection coordinates come from
/// the [`MachineRecord`]; `known_hosts` is Flight Deck's own file (TOFU pinning).
///
/// Bounded by [`default_ssh_round_trip_deadline`] (the 20 s
/// `orchestrator::SSH_ROUND_TRIP_TIMEOUT` every short remote call shares): `ConnectTimeout`
/// only covers the handshake, and a server that connects and then never answers (a stale
/// NFS home under the login shell, a wedged `flightdeckd`) used to hang every caller that
/// did not wrap this itself — device sync while holding its lock, the install pipeline
/// while holding the server's claim, the folder picker. A caller whose remote command
/// legitimately takes longer uses [`run_ssh_on_machine_within`].
///
/// `pub(crate)` so `bootstrap::server_setup` reuses this SAME round-trip for its own
/// batch calls (`flightdeckd init` / `flightdeckd whoami`) instead of building a second
/// one — see that module's doc.
pub(crate) async fn run_ssh_on_machine(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
) -> Result<String, String> {
    run_ssh_on_machine_within(m, known_hosts, remote_cmd, default_ssh_round_trip_deadline()).await
}

/// The deadline [`run_ssh_on_machine`] applies: `orchestrator::SSH_ROUND_TRIP_TIMEOUT`, or
/// a test's shortened one (the thread-local [`TEST_SSH_DEADLINE`], scoped like
/// [`TEST_SSH_BIN`]).
fn default_ssh_round_trip_deadline() -> std::time::Duration {
    #[cfg(test)]
    if let Some(deadline) = TEST_SSH_DEADLINE.with(|d| d.get()) {
        return deadline;
    }
    crate::bootstrap::orchestrator::SSH_ROUND_TRIP_TIMEOUT
}

// Test-only override of `default_ssh_round_trip_deadline`, thread-local for the same
// reason as `TEST_SSH_BIN`.
#[cfg(test)]
thread_local! {
    pub(crate) static TEST_SSH_DEADLINE: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

/// [`run_ssh_on_machine`] with an explicit `deadline` covering the whole round trip,
/// handshake included — for a remote command that legitimately takes longer than the
/// default (Claude Code's installer, a repository search over a large home). On expiry
/// the ssh child is killed and the error names the server that did not answer.
pub(crate) async fn run_ssh_on_machine_within(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    deadline: std::time::Duration,
) -> Result<String, String> {
    let mut cmd = keyed_ssh_options(m.port, m.identity_file.as_deref(), known_hosts)?;
    cmd.arg("-T");
    push_ssh_destination(&mut cmd, &m.user, &m.host)?;
    cmd.arg(remote_cmd);
    // On the deadline the child is dropped, and killed with it (`kill_on_drop`, set by
    // the keyed builder): `ssh` and the remote command behind it would otherwise keep
    // running, holding the connection, with nobody left to read them.
    let collected = run_collecting(&mut cmd, None, deadline, SSH_ONE_SHOT_STDOUT_MAX)
        .await
        .map_err(|e| e.message(&remote_files::server_name(m)))?;
    let Some(status) = collected.status else {
        return Err(format!("{} did not answer in time", remote_files::server_name(m)));
    };
    let out = std::process::Output { status, stdout: collected.stdout, stderr: collected.stderr };
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        // Classify ssh's own exit-255 failures (key refused / host key changed /
        // unreachable — `crate::ssh_link`, shared with the live session's reconnect
        // loop) into a plain sentence BEFORE falling back to the raw last stderr
        // line — the same real incident that motivated this (`josty@…: Permission
        // denied (publickey,password).`) used to leak straight into this string.
        let stderr_lines: Vec<String> =
            String::from_utf8_lossy(&out.stderr).lines().map(str::to_string).collect();
        Err(crate::ssh_link::classify_transport_close(out.status.code(), &stderr_lines)
            .map(|issue| crate::ssh_link::describe_with_detail(issue, &stderr_lines))
            .unwrap_or_else(|| {
                stderr_lines
                    .iter()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .cloned()
                    .unwrap_or_else(|| "ssh command failed".to_string())
            }))
    }
}

/// What a spawned ssh child wrote, read while it ran — see [`collect_output`].
pub(crate) struct CollectedOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// The exit status, or `None` when the deadline fired first: the child is then
    /// dropped (killed — every keyed command sets `kill_on_drop`), and `stdout`/`stderr`
    /// hold what had arrived by then.
    pub status: Option<std::process::ExitStatus>,
}

/// Most stdout a one-shot keyed round trip ([`run_ssh_on_machine`], the stdin variants,
/// the probes) may send before it is stopped. Every remote command they run answers in
/// kilobytes; the bound exists for a server that does not play along — a hostile or
/// compromised account's login script can stream gigabytes, and an unbounded buffer
/// (worse behind `-C`, which multiplies what the wire carries) would take the app down.
pub(crate) const SSH_ONE_SHOT_STDOUT_MAX: usize = 4 * 1024 * 1024;

/// How much of a child's stderr is kept (the rest is read and discarded, so the child
/// never blocks on a full pipe): ssh's own diagnostics are a few lines.
const SSH_STDERR_KEPT: usize = 64 * 1024;

/// Why [`collect_output`] gave up.
#[derive(Debug)]
pub(crate) enum CollectError {
    /// Reading the child's output, or waiting for it, failed.
    Io(std::io::Error),
    /// stdout passed this many bytes: the child was killed without the rest being read.
    TooMuchOutput(usize),
}

impl From<std::io::Error> for CollectError {
    fn from(e: std::io::Error) -> Self {
        CollectError::Io(e)
    }
}

impl CollectError {
    /// The sentence for the user, `server` naming who sent too much.
    pub(crate) fn message(self, server: &str) -> String {
        match self {
            CollectError::TooMuchOutput(max) => too_much_output(server, max),
            CollectError::Io(e) => format!("could not run ssh: {e}"),
        }
    }
}

/// The sentence for [`CollectError::TooMuchOutput`] on `server`.
pub(crate) fn too_much_output(server: &str, max: usize) -> String {
    format!(
        "{server} sent more than {} MB in answer to a request that never produces that much — the answer was \
         not read",
        (max / (1024 * 1024)).max(1)
    )
}

/// [`run_collecting`] in `output()`'s shape, stdout bounded by
/// [`SSH_ONE_SHOT_STDOUT_MAX`] — for a probe that used to run `timeout(…, cmd.output())`.
/// `Ok(None)` when `deadline` fired first (the child is killed with it).
pub(crate) async fn output_within(
    cmd: &mut tokio::process::Command,
    deadline: std::time::Duration,
) -> Result<Option<std::process::Output>, CollectError> {
    let collected = run_collecting(cmd, None, deadline, SSH_ONE_SHOT_STDOUT_MAX).await?;
    Ok(collected.status.map(|status| std::process::Output {
        status,
        stdout: collected.stdout,
        stderr: collected.stderr,
    }))
}

/// Spawns `cmd` (stdout and stderr piped; stdin piped when `stdin_payload` is given)
/// and [`collect_output`]s it.
pub(crate) async fn run_collecting(
    cmd: &mut tokio::process::Command,
    stdin_payload: Option<&[u8]>,
    deadline: std::time::Duration,
    max_stdout: usize,
) -> Result<CollectedOutput, CollectError> {
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let child = cmd.spawn()?;
    collect_output(child, stdin_payload, deadline, max_stdout).await
}

/// `child`'s stdout and stderr, read while it runs until it exits or `deadline` passes,
/// with `stdin_payload` written to its stdin meanwhile (then closed: EOF).
///
/// Unlike `output()` under `tokio::time::timeout`, what the child already said survives
/// the deadline — a server that answered and then stalled is told apart from one that
/// never answered — and nothing is buffered without bound: past `max_stdout` bytes of
/// stdout the read stops and the child is dropped (killed: every keyed command sets
/// `kill_on_drop`), [`CollectError::TooMuchOutput`]; stderr keeps its first
/// [`SSH_STDERR_KEPT`] bytes. A payload write that fails (the far side, or the link,
/// died before taking it all) is not an error: the exit status and output say what went
/// wrong. The child must have been spawned with stdout and stderr piped (and stdin, for
/// a payload) — [`run_collecting`] does that.
pub(crate) async fn collect_output(
    mut child: tokio::process::Child,
    stdin_payload: Option<&[u8]>,
    deadline: std::time::Duration,
    max_stdout: usize,
) -> Result<CollectedOutput, CollectError> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let run = async {
        let feed = async {
            if let (Some(pipe), Some(payload)) = (stdin.as_mut(), stdin_payload) {
                let _ = pipe.write_all(payload).await;
            }
            drop(stdin.take()); // EOF
            Ok::<(), CollectError>(())
        };
        let read_out = async {
            if let Some(pipe) = stdout.as_mut() {
                pipe.take((max_stdout as u64).saturating_add(1)).read_to_end(&mut out).await?;
                if out.len() > max_stdout {
                    return Err(CollectError::TooMuchOutput(max_stdout));
                }
            }
            Ok(())
        };
        let read_err = async {
            if let Some(pipe) = stderr.as_mut() {
                (&mut *pipe).take(SSH_STDERR_KEPT as u64).read_to_end(&mut err).await?;
                tokio::io::copy(pipe, &mut tokio::io::sink()).await?;
            }
            Ok::<(), CollectError>(())
        };
        // The payload goes out WHILE the output is drained: a remote command that talks
        // before it reads can't wedge the pipes, and the deadline covers the write too.
        tokio::try_join!(feed, read_out, read_err)?;
        Ok::<_, CollectError>(child.wait().await?)
    };
    let status = match tokio::time::timeout(deadline, run).await {
        Ok(status) => Some(status?),
        Err(_elapsed) => None,
    };
    Ok(CollectedOutput { stdout: out, stderr: err, status })
}

/// The raw outcome of [`run_ssh_on_machine_stdin`] — stdout/stderr/exit-success,
/// all three, rather than collapsing to a single `Result<String, String>` like its
/// sibling [`run_ssh_on_machine`]. Both this crate's stdin-bearing remote calls need
/// this shape: `flightdeckd add-phone`/`remove-phone` (C10) can answer a well-formed
/// JSON verdict (including a business-logic refusal, e.g. "too many authorized
/// phones") on stdout regardless of the ssh command's own exit code — mirroring why
/// `bootstrap::server_setup::probe_auth_status` reads `claude auth status --json`'s
/// stdout "regardless of the ssh command's exit status" (see that function's doc for
/// the same trap this avoids) — and B8/B9's own upload/unit-install markers likewise
/// live in stdout/stderr on BOTH outcomes, not just a failure's last stderr line. The
/// caller decides what a non-zero exit with unparsable stdout means either way.
pub(crate) struct SshStdinOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    /// The raw exit code (`None` only if ssh was killed by a signal) — kept
    /// alongside `success` so a caller that needs to tell "ssh itself failed" (exit
    /// 255, OpenSSH's own convention) apart from "the remote command's own non-zero
    /// exit" can, via `crate::ssh_link::classify_transport_close`. `success` alone
    /// cannot make that distinction (CRM `c9bf1482`).
    pub exit_code: Option<i32>,
}

/// [`run_ssh_on_machine`]'s sibling for a remote command that reads bytes off its OWN
/// stdin — a systemd unit file, a daemon binary, a secret (`flightdeckd add-phone
/// --token -`) — rather than one that just runs and reports (see that function's doc
/// for the shared option base). `stdin_payload` is written to the spawned ssh
/// process's stdin and the pipe is then closed (EOF), giving the remote command a
/// clean signal that the payload is complete; mirrors
/// `bootstrap::askpass::run_with_password`'s own `stdin_payload` parameter for the
/// SAME reason, just over this crate's normal KEYED path instead of the first-contact
/// password relay.
///
/// This is the ONE unification point for what used to be two near-identical helpers
/// (`bootstrap::install`'s own `run_ssh_on_machine_with_stdin` and `appmcp::
/// provision`'s `run_ssh_on_machine_stdin`) — same option base, same stdin-then-EOF
/// shape, drifted apart only in incidental ways (a raw tuple vs. [`SshStdinOutput`], a
/// hardcoded 20s timeout vs. none, a write failure short-circuiting vs. tolerated).
/// Reunified here with BOTH callers' test seams intact (see `ssh_bin_override`'s doc)
/// and a caller-supplied `timeout` (B8's daemon upload can legitimately take longer
/// than C10's short phone-token round trip) — a write failure is tolerated rather than
/// an early return (the caller still wants whatever stdout/stderr/exit-status the
/// process produced, to classify exactly WHAT went wrong — a truncated transfer looks
/// different from a clean early exit — rather than a bare "could not write" that
/// discards that evidence), matching `bootstrap::install`'s prior, more informative
/// behavior for every caller.
///
/// `ssh_bin_override`, when `Some`, is prepended to the CHILD PROCESS's own `PATH` (via
/// `Command::env`, which only affects this one spawn — never the app's own process-wide
/// environment) — the seam `bootstrap::install`'s unit tests use to point `ssh` at a
/// throwaway fake script instead of a real connection, without a live server. `None`
/// falls through to [`keyed_ssh_options`], which itself honors `appmcp::provision`'s
/// OWN, independent test seam (the thread-local `TEST_SSH_BIN` — see [`ssh_binary`]'s
/// doc for why that one is thread-local rather than a `Command`-scoped override): both
/// seams keep working side by side, neither one able to leak into the other's tests.
///
/// `Err` only for a failure to even run the ssh process itself (couldn't spawn, or it
/// never exited within `timeout`) — never for a non-zero exit, which is carried in
/// [`SshStdinOutput::success`] instead so a caller that wants stdout regardless of exit
/// code (see that struct's doc) can still get it. Bounded by `timeout`, distinct from
/// ssh's own `ConnectTimeout` (that one only covers the TCP/SSH handshake, not the
/// remote command actually running) — a wedged remote `flightdeckd` must not hang the
/// caller forever. The bound covers the WHOLE exchange, sending `stdin_payload`
/// included: a caller shipping megabytes sizes `timeout` for the transfer.
pub(crate) async fn run_ssh_on_machine_stdin(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    stdin_payload: &[u8],
    ssh_bin_override: Option<&Path>,
    timeout: std::time::Duration,
) -> Result<SshStdinOutput, String> {
    let raw = run_ssh_on_machine_stdin_raw(m, known_hosts, remote_cmd, stdin_payload, ssh_bin_override, timeout).await?;
    Ok(SshStdinOutput {
        stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
        stderr: raw.stderr,
        success: raw.success,
        exit_code: raw.exit_code,
    })
}

/// [`SshStdinOutput`] with stdout kept as RAW BYTES — for a caller whose payload is a file's
/// bytes at known offsets (`remote_files`): a lossy UTF-8 decode would change their length and
/// break every offset after the first invalid byte.
pub(crate) struct SshRawOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub success: bool,
    pub exit_code: Option<i32>,
}

/// [`run_ssh_on_machine_stdin`]'s byte-preserving core (same option base, same stdin-then-EOF
/// shape, same test seams and timeout) — the one implementation behind both.
pub(crate) async fn run_ssh_on_machine_stdin_raw(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    stdin_payload: &[u8],
    ssh_bin_override: Option<&Path>,
    timeout: std::time::Duration,
) -> Result<SshRawOutput, String> {
    run_ssh_on_machine_stdin_raw_compressed(
        m,
        known_hosts,
        remote_cmd,
        stdin_payload,
        ssh_bin_override,
        timeout,
        false,
        SSH_ONE_SHOT_STDOUT_MAX,
    )
    .await
}

/// [`run_ssh_on_machine_stdin_raw`], with ssh's own stream compression (`-C`) when `compress` is
/// set — for a read whose answer is large and text (a whole session transcript: JSON lines
/// shrink several times over), where the bytes on the wire, not the handshake, are the cost —
/// and its own bound on the answer: past `max_stdout` bytes of stdout the read stops, ssh is
/// killed and the call fails. The server-side scripts cap what they send (`head -c`), but a
/// hostile or compromised account ignores them, and with `-C` a stream of zeros arrives at
/// gigabytes a second: the bound is applied while reading, never after collecting it all.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_ssh_on_machine_stdin_raw_compressed(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
    stdin_payload: &[u8],
    ssh_bin_override: Option<&Path>,
    timeout: std::time::Duration,
    compress: bool,
    max_stdout: usize,
) -> Result<SshRawOutput, String> {
    let mut cmd = match ssh_bin_override {
        // Test seam: run THIS fake `ssh` explicitly (and keep its dir first on the
        // child's PATH), so the process-wide `TOSSE_TEST_SSH_BIN` another test family
        // may be holding at that moment can never swap it for a different fake.
        Some(dir) => {
            let bin = dir.join("ssh");
            let mut c = keyed_ssh_options_with_bin(
                &bin.to_string_lossy(),
                m.port,
                m.identity_file.as_deref(),
                known_hosts,
            )?;
            let path = std::env::var("PATH").unwrap_or_default();
            c.env("PATH", format!("{}:{path}", dir.display()));
            c
        }
        None => keyed_ssh_options(m.port, m.identity_file.as_deref(), known_hosts)?,
    };
    cmd.arg("-T");
    if compress {
        cmd.arg("-C");
    }
    push_ssh_destination(&mut cmd, &m.user, &m.host)?;
    cmd.arg(remote_cmd);
    // The write and the wait run TOGETHER, under ONE `timeout` (see `collect_output`). Written
    // first and only then timed, a payload the far side stops reading (a `mkdir` blocked on a
    // stale NFS home, a link that blackholes mid-transfer) parked `write_all` forever once the
    // pipe and ssh's channel window filled — the bound never even started, and the ssh child
    // leaked with the call. On expiry the child is dropped: `kill_on_drop` ends ssh. A write
    // failure (broken pipe — the remote side, or the connection itself, died before consuming
    // everything) is deliberately NOT an error — see this function's own doc.
    let collected = run_collecting(&mut cmd, Some(stdin_payload), timeout, max_stdout)
        .await
        .map_err(|e| e.message("the server"))?;
    let status = collected.status.ok_or_else(|| "ssh command timed out".to_string())?;
    Ok(SshRawOutput {
        stdout: collected.stdout,
        stderr: String::from_utf8_lossy(&collected.stderr).into_owned(),
        success: status.success(),
        exit_code: status.code(),
    })
}

/// How long [`list_remote_repos`]'s `find` may walk a server's folders.
const REMOTE_REPO_SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Discover git repositories on a paired server (a bounded `find` for `.git` dirs
/// under `$HOME`), so the "new remote conversation" flow can offer a pick-list instead
/// of making the user recall a path. Returns repo folder paths, most-shallow first.
#[tauri::command]
#[specta::specta]
pub async fn list_remote_repos(
    app: tauri::AppHandle,
    machine_id: String,
) -> Result<Vec<String>, String> {
    let machine = app
        .state::<Store>()
        .machine_by_id(&machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())?;
    let known_hosts = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned());
    // Search $HOME plus a few common server roots (missing dirs are silently skipped),
    // so repos outside the home folder (e.g. /work, /srv) are still found. A walk over a
    // large home can outlast the default round trip, so it gets its own, longer bound.
    let out = run_ssh_on_machine_within(
        &machine,
        known_hosts.as_deref(),
        "find \"$HOME\" /work /srv /opt /var/www -maxdepth 4 -type d -name .git -prune \
         2>/dev/null | sed \"s#/.git$##\" | sort -u | head -100",
        REMOTE_REPO_SEARCH_TIMEOUT,
    )
    .await?;
    Ok(out
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect())
}

/// POSIX single-quote escaping so a user-supplied remote path can't break out of the
/// remote shell command (wrap in single quotes; rewrite each embedded quote as `'\''`).
///
/// `pub(crate)` so `bootstrap::templates` (a real shell-script generator, not just a
/// path-in-a-command helper like the call sites below) can reuse the one escaping
/// helper this crate already has instead of growing a second one.
pub(crate) fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// One level of a remote server's filesystem: the resolved absolute `path` and its
/// immediate SUB-directories (names only). Powers the remote folder browser.
#[derive(serde::Serialize, specta::Type)]
pub struct RemoteListing {
    pub path: String,
    pub dirs: Vec<String>,
}

/// List the sub-directories of `path` on a server (empty `path` → the user's `$HOME`),
/// so the "new remote conversation" flow can offer a click-to-descend folder browser —
/// the remote stand-in for the native folder picker. Hidden dirs are omitted.
#[tauri::command]
#[specta::specta]
pub async fn list_remote_dir(
    app: tauri::AppHandle,
    machine_id: String,
    path: String,
) -> Result<RemoteListing, String> {
    let machine = app
        .state::<Store>()
        .machine_by_id(&machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())?;
    let known_hosts = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned());
    // First stdout line = the resolved absolute dir (pwd -P); the rest = its sub-dirs.
    let script = format!(
        "P={p}; [ -n \"$P\" ] || P=\"$HOME\"; \
         if ! cd \"$P\" 2>/dev/null; then printf 'cannot open %s\\n' \"$P\" >&2; exit 4; fi; \
         pwd -P; ls -1p . 2>/dev/null | grep '/$' | sed 's#/$##'",
        p = shq(&path)
    );
    let out = run_ssh_on_machine(&machine, known_hosts.as_deref(), &script).await?;
    let mut lines = out.lines();
    let resolved = lines.next().unwrap_or("").trim().to_string();
    let dirs = lines
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect();
    Ok(RemoteListing { path: resolved, dirs })
}

/// Ensure `path` exists on a server, creating ONLY the final folder and ONLY when its
/// parent already exists — a remote `mkdir` (NOT `mkdir -p`). So a typo in the parent
/// chain fails loudly instead of silently materialising a wrong deep path. Idempotent
/// when the folder is already there. Called just before opening a remote conversation.
#[tauri::command]
#[specta::specta]
pub async fn prepare_remote_dir(
    app: tauri::AppHandle,
    machine_id: String,
    path: String,
) -> Result<(), String> {
    let machine = app
        .state::<Store>()
        .machine_by_id(&machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown server".to_string())?;
    let known_hosts = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned());
    let script = format!(
        "D={d}; if [ -d \"$D\" ]; then exit 0; fi; \
         PARENT=$(dirname \"$D\"); \
         if [ ! -d \"$PARENT\" ]; then printf 'parent-missing\\n' >&2; exit 6; fi; \
         mkdir \"$D\" 2>/dev/null || {{ printf 'mkdir-failed\\n' >&2; exit 5; }}",
        d = shq(&path)
    );
    match run_ssh_on_machine(&machine, known_hosts.as_deref(), &script).await {
        Ok(_) => Ok(()),
        Err(e) if e.contains("parent-missing") => Err(
            "The parent folder doesn't exist on the server — only the final folder is \
             created, so check the path."
                .to_string(),
        ),
        Err(e) if e.contains("mkdir-failed") => {
            Err("Couldn't create that folder on the server (permission?).".to_string())
        }
        Err(e) => Err(e),
    }
}

/// Insert or update a conversation's metadata (idempotent by stable id).
#[tauri::command]
#[specta::specta]
pub fn upsert_conversation(
    store: tauri::State<'_, Store>,
    conversation: ConversationRecord,
) -> Result<(), String> {
    store
        .upsert_conversation(&conversation)
        .map_err(|e| e.to_string())
}

/// Best-effort push of a REMOTE conversation's CURRENT title to its daemon's
/// authoritative record (C9) — the idle-rename path, for when the LOCAL rename
/// (`upsert_conversation`) happens while this Mac isn't the one driving the
/// conversation. `title` is passed explicitly rather than re-read from the store, so
/// this never races that same rename's own `upsertConversation` write landing first.
///
/// See [`crate::supervisor::transport::push_remote_title`] for the wire mechanics and
/// its SAFETY CONTRACT — most importantly: the caller (`renameConversation` in
/// `conversationsStore.ts`) MUST have already confirmed this Mac holds no live
/// session for `conversation_id` before ever calling this; that liveness
/// (`conv.handle`) is front-end-only state this command cannot see, let alone check
/// on its own.
///
/// Infallible from the caller's point of view (mirrors [`crate::supervisor::
/// transport::run_remote_stop`]'s `bool` shape): returns `false` — never an error —
/// whenever there's nothing useful to do (unknown conversation, local repo, no
/// daemon session yet, or a paired daemon that predates `--title` support) or the ssh
/// round trip itself fails. A `false` here changes nothing about the LOCAL rename,
/// which already landed — the next real spawn carries the title anyway (see
/// `spawn_session`'s `conversation_title` wiring).
#[tauri::command]
#[specta::specta]
pub async fn push_remote_conversation_title(
    app: tauri::AppHandle,
    conversation_id: String,
    title: String,
) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    let store = app.state::<Store>();
    let (cwd, session_id, machine) = match store.remote_session_for_conversation(&conversation_id) {
        Ok(Some(found)) => found,
        // Benign no-op: unknown conversation, local repo, or no daemon session yet —
        // exactly the documented "nothing useful to do" cases above.
        Ok(None) => return false,
        // A real DB-layer failure, unlike the benign cases above — worth surfacing
        // even though the command still degrades to `false` for the caller (mirrors
        // `push_remote_title`'s own `eprintln!` on a real ssh-spawn failure).
        Err(e) => {
            eprintln!("[commands] push_remote_conversation_title: store lookup failed: {e}");
            return false;
        }
    };
    // A `MachineRecord` on disk could predate `validate_ssh_user`/`validate_ssh_port`
    // (older app version, manual DB edit) — refuse here, BEFORE any ssh round trip
    // (including the capability probe below) runs, same discipline as `spawn_session`'s
    // own early check. `push_remote_title` re-validates internally too (belt and
    // suspenders), but every keyed helper should refuse up front rather than rely
    // solely on a deeper builder (CRM holistic-review blocker #3, chantier A
    // `bd7ca709`).
    if validate_ssh_user(&machine.user).is_err()
        || validate_address_value(&machine.host).is_err()
        || crate::store::validate_ssh_port(machine.port).is_err()
    {
        return false;
    }
    let known_hosts_file = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned());
    if !supports_title_for_machine(&machine, known_hosts_file.as_deref()).await {
        return false; // an older daemon's clap would reject --title outright
    }
    let addresses = remote_target_addresses(&machine.host, machine.addresses.clone());
    let remote = crate::supervisor::transport::RemoteTarget {
        host: machine.host,
        port: machine.port,
        user: machine.user,
        identity_file: machine.identity_file,
        known_hosts_file,
        daemon_bin: std::env::var("TOSSE_REMOTE_FLIGHTDECKD_BIN")
            .unwrap_or_else(|_| "flightdeckd".to_string()),
        addresses,
        machine_id: Some(machine.id),
    };
    crate::supervisor::transport::push_remote_title(&remote, &session_id, &cwd, &title).await
}

/// Forget a conversation's metadata.
#[tauri::command]
#[specta::specta]
pub fn delete_conversation(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_conversation(&id).map_err(|e| e.to_string())
}

/// Persist (or clear, with `null`) the active conversation's stable id.
#[tauri::command]
#[specta::specta]
pub fn set_active_conversation(
    store: tauri::State<'_, Store>,
    id: Option<String>,
) -> Result<(), String> {
    store.set_active(id.as_deref()).map_err(|e| e.to_string())
}

/// Drop ALL persisted data (dev escape hatch + Settings "drop all"). Claude's
/// on-disk transcripts are untouched.
#[tauri::command]
#[specta::specta]
pub fn wipe_all_data(store: tauri::State<'_, Store>) -> Result<(), String> {
    store.wipe_all().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App control (the app-hosted MCP servers — see `crate::appmcp`)
// ---------------------------------------------------------------------------

/// The front executor's answer to one bridged `app_control_request` event.
/// Exactly one of `result` / `error` is meaningful: `error` set → the tool call
/// failed with that message; otherwise `result` (or null) is the tool's value.
/// Errors out when the request id is unknown (already timed out / answered) so
/// a wiring bug in the executor can never be silent.
#[tauri::command]
#[specta::specta]
pub fn app_control_respond(
    hub: tauri::State<'_, Arc<crate::appmcp::ControlHub>>,
    request_id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let outcome = match error {
        Some(message) => Err(message),
        None => Ok(result.unwrap_or(serde_json::Value::Null)),
    };
    if hub.respond(&request_id, outcome) {
        Ok(())
    } else {
        Err(format!("no pending app-control request '{request_id}' (timed out or already answered)"))
    }
}

/// Publish one fleet event into the journal `wait_for_events` long-polls (the voice
/// bridge) AND the phone relay's push (`appmcp::relay`'s `events_task` — the SAME
/// journal feeds both). The FRONT calls this from its settled notification point
/// (`fireAgentNotification`), so the voice agent (and the phone) hear exactly what
/// the human would have been pinged about.
///
/// C9 gate: a conversation this Mac only RELAYS (its repo is remote — `machine_id`
/// set) has its OWN host `flightdeckd` daemon emitting these SAME phone-facing
/// events independently (it runs the actual session; the Mac here is just an SSH
/// spectator) — publishing them HERE too would double the phone's push per turn.
/// This is the SINGLE entry point every phone-facing journal event passes through
/// (`turn_completed` / `needs_attention` / `attention_cleared` / `task_finished`,
/// from every call site in `useGlobalSessionEvents.ts` / `appControl.ts` /
/// `conversationsStore.ts`), so gating it here covers all of them without touching
/// any of those call sites individually. The DESKTOP's own OS notifications and
/// in-app voice announcements are UNCHANGED — both are fed from a SEPARATE point in
/// `useGlobalSessionEvents.ts` that never goes through this journal at all, remote
/// conversation or not; only the phone-facing paths (voice bridge + relay) are
/// gated. `unwrap_or(false)` degrades toward PUBLISHING on a lookup error — a
/// missed suppression is, at worst, one duplicate push; a wrongly-swallowed event
/// for a conversation this couldn't even confirm as remote would be a silent loss.
#[tauri::command]
#[specta::specta]
pub fn publish_control_event(
    store: tauri::State<'_, Store>,
    hub: tauri::State<'_, Arc<crate::appmcp::ControlHub>>,
    kind: String,
    conversation_id: String,
    title: String,
    detail: serde_json::Value,
) {
    if store.conversation_repo_is_remote(&conversation_id).unwrap_or(false) {
        return;
    }
    hub.events.publish(&kind, &conversation_id, &title, detail);
}

/// Keys under which the voice bridge persists its config in the store's `meta`
/// table.
const VOICE_ENABLED_KEY: &str = "voice_bridge_enabled";
const VOICE_PORT_KEY: &str = "voice_bridge_port";
const VOICE_TOKEN_KEY: &str = "voice_bridge_token";

/// Load the voice bridge's persisted config, minting (and persisting) the
/// Bearer token on first use so the Settings page always has one to show.
/// Best-effort on read errors: the bridge then starts disabled with defaults.
pub fn load_voice_config(store: &Store) -> crate::appmcp::VoiceConfig {
    let read = |key: &str| store.get_config(key).ok().flatten();
    let token = match read(VOICE_TOKEN_KEY) {
        Some(t) if !t.is_empty() => t,
        _ => {
            let t = uuid::Uuid::new_v4().to_string();
            if let Err(e) = store.set_config(VOICE_TOKEN_KEY, &t) {
                eprintln!("[appmcp] failed to persist the voice-bridge token: {e}");
            }
            t
        }
    };
    crate::appmcp::VoiceConfig {
        enabled: read(VOICE_ENABLED_KEY).as_deref() == Some("1"),
        port: read(VOICE_PORT_KEY)
            .and_then(|p| p.parse().ok())
            .unwrap_or(crate::appmcp::DEFAULT_VOICE_PORT),
        token,
    }
}

/// The voice bridge's current status (Settings read-back: config + whether the
/// listener is actually up, with the error when it is not).
#[tauri::command]
#[specta::specta]
pub fn voice_bridge_status(
    hub: tauri::State<'_, Arc<crate::appmcp::ControlHub>>,
) -> crate::appmcp::VoiceBridgeStatus {
    hub.voice_status()
}

/// Change the voice bridge's config (any subset of enable/port/token-regen),
/// persist it, and (re)start or stop the listener accordingly. Returns the
/// honest post-apply status — a failed bind comes back as `running:false` +
/// `error`, never as a silently-lying switch.
#[tauri::command]
#[specta::specta]
pub async fn set_voice_bridge(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    port: Option<u16>,
    regenerate_token: bool,
) -> Result<crate::appmcp::VoiceBridgeStatus, String> {
    let hub = (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone();
    let mut cfg = {
        let store = app.state::<Store>();
        let mut cfg = load_voice_config(&store);
        if let Some(enabled) = enabled {
            cfg.enabled = enabled;
        }
        if let Some(port) = port {
            cfg.port = port;
        }
        if regenerate_token {
            cfg.token = uuid::Uuid::new_v4().to_string();
        }
        store
            .set_config(VOICE_ENABLED_KEY, if cfg.enabled { "1" } else { "0" })
            .and_then(|_| store.set_config(VOICE_PORT_KEY, &cfg.port.to_string()))
            .and_then(|_| store.set_config(VOICE_TOKEN_KEY, &cfg.token))
            .map_err(|e| e.to_string())?;
        cfg
    };
    // Never start a listener with an empty token (defence in depth; the loader
    // always mints one).
    if cfg.token.is_empty() {
        cfg.token = uuid::Uuid::new_v4().to_string();
    }
    hub.apply_voice(cfg).await;
    Ok(hub.voice_status())
}

// ---------------------------------------------------------------------------
// In-app voice agent (OpenAI Realtime — see `crate::voice`)
// ---------------------------------------------------------------------------

/// Whether an OpenAI key is stored (plus its masked hint). `configured: false`
/// is the NORMAL optional-feature state, never an error. Async + off-thread:
/// every one of these spawns `/usr/bin/security`, which must never run on the
/// main thread (a Keychain ACL prompt can block it for seconds).
#[tauri::command]
#[specta::specta]
pub async fn voice_agent_status() -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(crate::voice::status)
        .await
        .map_err(|e| format!("keychain task failed: {e}"))
}

/// Store the user's OpenAI API key in the macOS Keychain (verified by
/// read-back). Returns the fresh status.
#[tauri::command]
#[specta::specta]
pub async fn set_voice_agent_key(
    app: tauri::AppHandle,
    key: String,
) -> Result<crate::voice::VoiceAgentStatus, String> {
    let status = tokio::task::spawn_blocking(move || crate::voice::set_key(&key))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))??;
    reapply_wake_after_key_change(&app, status.configured).await;
    Ok(status)
}

/// Forget the stored OpenAI key (absent item = success).
#[tauri::command]
#[specta::specta]
pub async fn clear_voice_agent_key(
    app: tauri::AppHandle,
) -> Result<crate::voice::VoiceAgentStatus, String> {
    let status = tokio::task::spawn_blocking(crate::voice::clear_key)
        .await
        .map_err(|e| format!("keychain task failed: {e}"))??;
    reapply_wake_after_key_change(&app, status.configured).await;
    Ok(status)
}

/// The wake word is held off while no OpenAI key is stored
/// (`crate::wake::require_voice_key`), so a key change re-applies it: removing
/// the key stops an always-on microphone whose every detection would now be
/// dropped, adding one resumes a wake word the user left enabled. Best-effort —
/// the key change itself already succeeded, and the wake status carries its own
/// outcome for Settings to show.
async fn reapply_wake_after_key_change(app: &tauri::AppHandle, key_configured: bool) {
    let cfg = load_wake_config(app, &app.state::<Store>());
    let wake = (*app.state::<Arc<crate::wake::WakeController>>()).clone();
    // Nothing to pause or resume for a wake word the user never enabled, and a
    // detector already running with a key stored needs no restart.
    if !cfg.enabled || (key_configured && wake.status().running) {
        return;
    }
    let apply = move || wake.apply(crate::wake::require_voice_key(cfg, key_configured));
    if let Err(e) = tokio::task::spawn_blocking(apply).await {
        eprintln!("[wake] re-applying the wake word after a key change failed: {e}");
    }
}

/// Mint a short-lived Realtime client secret for ONE voice session — the only
/// shape of the credential the webview ever sees. `voice` is the user's picked
/// voice, sanitized against the Rust-side catalogue (unknown → the default), and
/// fixed for the whole session: OpenAI will not swap a voice mid-call.
#[tauri::command]
#[specta::specta]
pub async fn voice_agent_client_secret(
    voice: Option<String>,
) -> Result<crate::voice::ClientSecret, String> {
    crate::voice::mint_client_secret(voice).await
}

// ---------------------------------------------------------------------------
// Wake word — on-device "Alexa" / "Hey Jarvis" trigger (see `crate::wake`)
// ---------------------------------------------------------------------------

/// Keys under which the wake-word config persists in the store's `meta` table.
const WAKE_ENABLED_KEY: &str = "wake_word_enabled";
const WAKE_PHRASE_KEY: &str = "wake_word_phrase";
const WAKE_SENSITIVITY_KEY: &str = "wake_word_sensitivity";
const WAKE_DEBUG_CAPTURE_KEY: &str = "wake_word_debug_capture";

/// Where wake-word debug captures are written. The `wake` module deliberately
/// knows nothing of Tauri, so the app data dir is resolved here and handed to it
/// (same arrangement as the detection callback).
pub fn wake_debug_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("wake-debug"))
}

/// Load the persisted wake-word config (best-effort; unset/garbled → defaults),
/// sanitized so an unknown phrase or out-of-range sensitivity can never reach the
/// detector. Read at startup so the detector can arm with the app.
pub fn load_wake_config(app: &tauri::AppHandle, store: &Store) -> crate::wake::WakeConfig {
    let read = |key: &str| store.get_config(key).ok().flatten();
    let default = crate::wake::WakeConfig::default();
    let phrase = read(WAKE_PHRASE_KEY).unwrap_or(default.phrase);
    let sensitivity = read(WAKE_SENSITIVITY_KEY)
        .and_then(|s| s.parse().ok())
        .unwrap_or(default.sensitivity);
    let (phrase, sensitivity) = crate::wake::sanitize(&phrase, sensitivity);
    crate::wake::WakeConfig {
        enabled: read(WAKE_ENABLED_KEY).as_deref() == Some("1"),
        phrase,
        sensitivity,
        debug_capture: read(WAKE_DEBUG_CAPTURE_KEY).as_deref() == Some("1"),
        debug_dir: wake_debug_dir(app),
        paused: None, // decided at apply time (`crate::wake::require_voice_key`)
    }
}

/// Current honest wake-word status: the config plus whether the detector is really
/// capturing, with the reason when it is not.
#[tauri::command]
#[specta::specta]
pub fn wake_word_status(
    wake: tauri::State<'_, Arc<crate::wake::WakeController>>,
) -> crate::wake::WakeStatus {
    wake.status()
}

/// Change the wake-word config (any subset of enable/phrase/sensitivity), persist
/// it, and (re)start or stop the detector to match. Blocking (model load + mic
/// open), so run off the async thread. Returns the honest post-apply status — a
/// mic/model failure comes back as `running:false` + `error`, never a lying switch.
#[tauri::command]
#[specta::specta]
pub async fn set_wake_word_config(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    phrase: Option<String>,
    sensitivity: Option<f32>,
    debug_capture: Option<bool>,
) -> Result<crate::wake::WakeStatus, String> {
    // Scope the store guard so it is dropped before the `.await` (it is not Send).
    let cfg = {
        let store = app.state::<Store>();
        let mut cfg = load_wake_config(&app, &store);
        if let Some(enabled) = enabled {
            cfg.enabled = enabled;
        }
        if let Some(phrase) = phrase {
            cfg.phrase = phrase;
        }
        if let Some(sensitivity) = sensitivity {
            cfg.sensitivity = sensitivity;
        }
        if let Some(debug_capture) = debug_capture {
            cfg.debug_capture = debug_capture;
        }
        let (phrase, sensitivity) = crate::wake::sanitize(&cfg.phrase, cfg.sensitivity);
        cfg.phrase = phrase;
        cfg.sensitivity = sensitivity;
        store
            .set_config(WAKE_ENABLED_KEY, if cfg.enabled { "1" } else { "0" })
            .and_then(|_| store.set_config(WAKE_PHRASE_KEY, &cfg.phrase))
            .and_then(|_| store.set_config(WAKE_SENSITIVITY_KEY, &cfg.sensitivity.to_string()))
            .and_then(|_| {
                store.set_config(
                    WAKE_DEBUG_CAPTURE_KEY,
                    if cfg.debug_capture { "1" } else { "0" },
                )
            })
            .map_err(|e| e.to_string())?;
        cfg
    };
    let wake = (*app.state::<Arc<crate::wake::WakeController>>()).clone();
    tokio::task::spawn_blocking(move || {
        // No OpenAI key → held off, choice kept (`require_voice_key`). The Keychain
        // is only read when it can matter.
        let has_key = cfg.enabled && crate::voice::status().configured;
        wake.apply(crate::wake::require_voice_key(cfg, has_key))
    })
    .await
    .map_err(|e| format!("wake apply task failed: {e}"))
}

/// A compact, bounded directory tree for AGENT orientation (the `browse_folders`
/// app-control tool): where could I work on this Mac? `path: None` starts at the
/// user's home. Off-thread — a slow (cloud-synced) folder must not stall the app.
#[tauri::command]
#[specta::specta]
pub async fn folder_tree(
    path: Option<String>,
    depth: Option<u32>,
) -> Result<crate::fs::FolderTree, String> {
    tokio::task::spawn_blocking(move || {
        crate::fs::folder_tree(path.as_deref(), depth.unwrap_or(2) as usize)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("folder tree task failed: {e}"))?
}

/// The app-control tool catalogue for a surface ("app" | "voice"), as MCP tool
/// JSON. The in-app voice agent reads it to declare its Realtime function
/// tools from the SAME source the MCP servers serve — one catalogue, no drift.
#[tauri::command]
#[specta::specta]
pub fn app_control_tools(surface: String) -> Result<serde_json::Value, String> {
    let surface = match surface.as_str() {
        "app" => crate::appmcp::Surface::App,
        "voice" => crate::appmcp::Surface::Voice,
        other => return Err(format!("unknown surface '{other}' (app | voice)")),
    };
    Ok(crate::appmcp::tools::list_json(surface))
}

/// Keys under which the remote-access relay persists its config in `meta`.
const REMOTE_ENABLED_KEY: &str = "remote_enabled";
const REMOTE_URL_KEY: &str = "remote_relay_url";
const REMOTE_MAC_ID_KEY: &str = "remote_mac_id";
const REMOTE_MAC_TOKEN_KEY: &str = "remote_mac_token";
/// The token a rotation is moving to, until the relay confirms it (`rotate_remote_mac_token`).
const REMOTE_MAC_TOKEN_NEXT_KEY: &str = "remote_mac_token_next";
const REMOTE_PHONE_TOKEN_KEY: &str = "remote_phone_token";
/// C11: this Mac's node display name (`{type:"set_label"}`, PROTOCOL.md §4).
const REMOTE_MAC_LABEL_KEY: &str = "remote_mac_label";
/// "1" once the legacy shared phone token is retired (or was never minted: a
/// fresh install pairs phones on the sealed channel only). From then on
/// `remote_phone_token` stays empty and this Mac takes no cleartext phone frame
/// (`appmcp::relay::legacy_open`). Never set back to "0".
const REMOTE_LEGACY_RETIRED_KEY: &str = "remote_legacy_retired";

/// Load the remote-access config, minting (and persisting) the stable mac id, the
/// mac secret and the phone pairing token on first use so Settings always has a QR
/// to show. Best-effort on read errors (then it starts disabled with defaults).
///
/// The secrets (mac token, the next one a rotation is moving to, the legacy phone
/// token) are SEALED at rest (`crate::secret_vault`). One that exists but won't open —
/// the keychain key is unavailable — is NEVER replaced by a freshly minted one (that
/// would lose this Mac's identity on the relay for good): it reads as empty and
/// `secrets_error` says why, which keeps the relay from being dialed.
///
/// Also loads two things that never round-trip through the front: the node
/// label (C11, `remote_mac_label`, defaulting to
/// [`crate::appmcp::DEFAULT_MAC_LABEL`]) and every phone token still queued for
/// `{type:"revoke_phone"}` on this Mac's own relay connection
/// (`Store::pending_relay_phone_revocations`, C10's critical fix) — both feed
/// `appmcp::relay::post_connect_frames` on the next (re)connect.
pub fn load_remote_config(store: &Store) -> crate::appmcp::RemoteConfig {
    let read = |key: &str| store.get_config(key).ok().flatten();
    let mut secrets_error: Option<String> = None;
    let mut secret = |key: &str| -> Option<String> {
        match store.get_secret_config(key) {
            Ok(value) => value.filter(|v| !v.is_empty()),
            Err(e) => {
                secrets_error.get_or_insert_with(|| e.to_string());
                None
            }
        }
    };
    // A Mac that never had a remote identity nor a phone token is a fresh install:
    // it never gets a legacy shared token — its phones pair on the sealed channel only.
    let never_minted = |key: &str| read(key).is_none_or(|v| v.is_empty());
    if never_minted(REMOTE_MAC_ID_KEY) && never_minted(REMOTE_PHONE_TOKEN_KEY) && read(REMOTE_LEGACY_RETIRED_KEY).is_none() {
        if let Err(e) = store.set_config(REMOTE_LEGACY_RETIRED_KEY, "1") {
            eprintln!("[appmcp] failed to persist {REMOTE_LEGACY_RETIRED_KEY}: {e}");
        }
    }
    // Remote access never turned on (`remote_enabled` is written by `set_remote` only):
    // no phone was ever shown the legacy QR. Older builds minted the shared token at
    // every launch regardless, so its presence proves nothing — retire it (queued for
    // revocation everywhere, in case a server was handed it) before access is ever on.
    // A token that won't open is left for a launch where it does.
    if read(REMOTE_ENABLED_KEY).is_none() && read(REMOTE_LEGACY_RETIRED_KEY).as_deref() != Some("1") {
        let retired = match store.get_secret_config(REMOTE_PHONE_TOKEN_KEY) {
            Ok(token) => match token.unwrap_or_default() {
                token if token.is_empty() => store.set_config(REMOTE_LEGACY_RETIRED_KEY, "1"),
                token => store.retire_legacy_phone_token(&token, now_ms()),
            },
            Err(e) => Err(e),
        };
        if let Err(e) = retired {
            eprintln!("[appmcp] failed to retire the never-used legacy phone token: {e}");
        }
    }
    let legacy_retired = read(REMOTE_LEGACY_RETIRED_KEY).as_deref() == Some("1");
    let mac_id = match read(REMOTE_MAC_ID_KEY) {
        Some(v) if !v.is_empty() => v,
        _ => {
            let v = uuid::Uuid::new_v4().to_string();
            if let Err(e) = store.set_config(REMOTE_MAC_ID_KEY, &v) {
                eprintln!("[appmcp] failed to persist {REMOTE_MAC_ID_KEY}: {e}");
            }
            v
        }
    };
    // A secret never set is minted and sealed; one the store can't seal (no keychain
    // key) is not handed out unsaved — the next load would mint another.
    let mint = |key: &str, secrets_error: &mut Option<String>| -> String {
        let v = uuid::Uuid::new_v4().to_string();
        match store.set_secret_config(key, &v) {
            Ok(()) => v,
            Err(e) => {
                eprintln!("[appmcp] failed to persist {key}: {e}");
                secrets_error.get_or_insert_with(|| e.to_string());
                String::new()
            }
        }
    };
    let mac_token = secret(REMOTE_MAC_TOKEN_KEY);
    let mac_token_next = secret(REMOTE_MAC_TOKEN_NEXT_KEY);
    let phone_token = if legacy_retired { None } else { secret(REMOTE_PHONE_TOKEN_KEY) };
    // Mint only what is truly absent: a read error left `secrets_error` set.
    let unreadable = secrets_error.is_some();
    let mac_token = match mac_token {
        Some(t) => t,
        None if unreadable => String::new(),
        None => mint(REMOTE_MAC_TOKEN_KEY, &mut secrets_error),
    };
    let phone_token = match phone_token {
        Some(t) => t,
        None if legacy_retired || unreadable => String::new(),
        None => mint(REMOTE_PHONE_TOKEN_KEY, &mut secrets_error),
    };
    // The vault's own words (they say what to do) over a store error.
    let vault = store.vault_problem();
    let secrets_error = secrets_error.map(|e| vault.as_ref().map_or(e, |(reason, _)| reason.clone()));
    crate::appmcp::RemoteConfig {
        enabled: read(REMOTE_ENABLED_KEY).as_deref() == Some("1"),
        relay_url: read(REMOTE_URL_KEY)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| crate::appmcp::DEFAULT_RELAY_URL.to_string()),
        mac_id,
        mac_token,
        mac_token_next,
        phone_token,
        secrets_lost: vault.is_some_and(|(_, lost)| lost),
        secrets_error,
        mac_label: read(REMOTE_MAC_LABEL_KEY)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| crate::appmcp::DEFAULT_MAC_LABEL.to_string()),
        revoke_phone_tokens: store.pending_relay_phone_revocations().unwrap_or_default(),
    }
}

/// The remote-access relay's current status (Settings read-back: config + whether
/// the outbound connection is actually up, plus the pairing QR).
#[tauri::command]
#[specta::specta]
pub fn remote_status(
    hub: tauri::State<'_, Arc<crate::appmcp::ControlHub>>,
) -> crate::appmcp::RemoteStatus {
    hub.remote_status()
}

/// Change the remote-access config (enable, relay URL, this Mac's node label),
/// persist it, and (re)connect or disconnect accordingly. Returns the honest
/// post-apply status.
///
/// `regenerate_pairing` is refused: the legacy (unencrypted) QR is no longer shown
/// anywhere, so a regenerated shared token could reach no phone — it would only keep
/// the cleartext path open on this Mac and on every server. The way to cut the
/// legacy pairing off is to retire it (`retire_legacy_pairing`). Turning access on
/// while the legacy token is still in use re-provisions it on every paired daemon
/// (C10 hook (b)), in the background, every outcome recorded in `ProvisionRegistry`.
#[tauri::command]
#[specta::specta]
pub async fn set_remote(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    relay_url: Option<String>,
    regenerate_pairing: bool,
    mac_label: Option<String>,
) -> Result<crate::appmcp::RemoteStatus, String> {
    if regenerate_pairing {
        return Err(LEGACY_REGENERATE_REFUSED.into());
    }
    let hub = (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone();
    let (cfg, was_enabled) = {
        let store = app.state::<Store>();
        let mut cfg = load_remote_config(&store);
        let was_enabled = cfg.enabled;
        if let Some(enabled) = enabled {
            cfg.enabled = enabled;
        }
        if let Some(url) = relay_url {
            let url = url.trim().to_string();
            if !url.is_empty() {
                // I5: refuse an unencrypted relay on another host up front, with the
                // reason shown in Settings, rather than storing it.
                crate::appmcp::relay::check_relay_url(&url)?;
                cfg.relay_url = url;
            }
        }
        if let Some(label) = mac_label {
            // The relay strips control/format chars and caps at 64 code points
            // itself (PROTOCOL.md §4) — trim here too so an all-whitespace edit
            // reads as "leave it", not "clear the label".
            let label = label.trim().to_string();
            if !label.is_empty() {
                cfg.mac_label = label;
            }
        }
        store
            .set_config(REMOTE_ENABLED_KEY, if cfg.enabled { "1" } else { "0" })
            .and_then(|_| store.set_config(REMOTE_URL_KEY, &cfg.relay_url))
            // The secrets are minted and sealed by `load_remote_config` itself — never
            // written back from here (one that didn't open reads as empty).
            .and_then(|_| store.set_config(REMOTE_MAC_LABEL_KEY, &cfg.mac_label))
            .map_err(|e| e.to_string())?;
        // Reload: `apply_remote`, right below, hands this exact cfg (with every
        // revocation still queued) to the new connection.
        let cfg = load_remote_config(&store);
        (cfg, was_enabled)
    };
    hub.apply_remote(cfg.clone()).await;

    // C10 hook (b): remote access just turned on — every paired daemon needs to
    // hear about the legacy token too, not just the relay. Backgrounded for the same reason as the revoke above. Every
    // outcome is recorded into `ProvisionRegistry` — the SAME registry
    // `add_machine`'s hook (a) and `retry_phone_provisioning` write to — so a
    // server that's unreachable or refuses shows up in Settings instead of
    // leaving its row stuck at "not checked yet".
    // Only while the legacy token is in use: a retired one is never provisioned.
    if cfg.enabled && !cfg.phone_token.is_empty() && !was_enabled {
        let app2 = app.clone();
        tokio::spawn(async move {
            let store = app2.state::<Store>();
            let known_hosts = remote_known_hosts_path(&app2);
            let registry = (*app2.state::<Arc<crate::appmcp::provision::ProvisionRegistry>>()).clone();
            let results =
                crate::appmcp::provision::provision_phone_on_all_machines(&store, known_hosts.as_deref()).await;
            for m in results {
                registry.record(&m.machine_id, m.state);
            }
        });
    }
    // Remote access just turned on: bring every server up to date with the
    // sealed-channel devices too (keys provisioned, removals owed).
    if cfg.enabled && !was_enabled {
        crate::ipc::remote_devices::spawn_device_sync(&app);
    }

    Ok(hub.remote_status())
}

/// Settings → Rotate this Mac's relay token: a fresh secret replaces the one the relay
/// knows this Mac by — same mac id, so paired phones and servers are unaffected. The new
/// token is saved (sealed) as the NEXT one before it is sent: if the relay takes it and
/// its answer is lost, the next connect, refused with the old token, proves the new one
/// and settles it (`appmcp::relay::dial`). A rotation already under way goes on with ITS
/// token — the relay may hold it. Needs a live link to a relay that rotates.
#[tauri::command]
#[specta::specta]
pub async fn rotate_remote_mac_token(app: tauri::AppHandle) -> Result<crate::appmcp::RemoteStatus, String> {
    let hub = (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone();
    if !hub.remote_status().can_rotate {
        return Err("Rotate once this Mac is connected to a relay that supports it.".into());
    }
    let next = {
        let store = app.state::<Store>();
        let cfg = load_remote_config(&store);
        if let Some(e) = cfg.secrets_error {
            return Err(e);
        }
        let next = match cfg.mac_token_next {
            Some(next) => next,
            None => mint_mac_token()?,
        };
        store
            .set_secret_config(REMOTE_MAC_TOKEN_NEXT_KEY, &next)
            .map_err(|e| format!("Couldn't save the new token: {e}"))?;
        next
    };
    hub.rotate_mac_token(next).await?;
    Ok(hub.remote_status())
}

/// A fresh relay token: 32 random bytes, base64url — 43 visible ASCII characters, a valid
/// bearer header (PROTOCOL.md §4 asks 16–512).
fn mint_mac_token() -> Result<String, String> {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).map_err(|_| "the system random generator failed".to_string())?;
    Ok(tarmac_e2e::b64::encode(&bytes))
}

/// Save the relay tokens a rotation settled on (`next: None`) or is still moving to.
/// `current` first: a crash in between leaves `next` equal to it — harmless, the next
/// welcome re-sends it and settles.
pub(crate) fn persist_mac_tokens(store: &Store, current: &str, next: Option<&str>) -> Result<(), String> {
    store.set_secret_config(REMOTE_MAC_TOKEN_KEY, current).map_err(|e| e.to_string())?;
    match next {
        Some(next) => store.set_secret_config(REMOTE_MAC_TOKEN_NEXT_KEY, next),
        None => store.delete_secret_config(REMOTE_MAC_TOKEN_NEXT_KEY),
    }
    .map_err(|e| e.to_string())
}

/// Settings → Reset remote access — only when this Mac's remote-access secrets are sealed
/// with a keychain key that is GONE (`secret_vault`): nothing will open them again. Every
/// paired phone is revoked (on the relay and on each server, through the usual queues: their
/// relay tokens are not sealed), the unreadable tokens are dropped, the legacy pairing is
/// retired, a new keychain key is made, and this Mac takes a NEW relay identity — the old
/// one is held on the relay by a token nobody has any more. Phones are then paired again.
#[tauri::command]
#[specta::specta]
pub async fn reset_remote_secrets(app: tauri::AppHandle) -> Result<crate::appmcp::RemoteStatus, String> {
    let hub = (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone();
    let cfg = {
        let store = app.state::<Store>();
        if !store.vault_problem().is_some_and(|(_, lost)| lost) {
            return Err("Remote access only needs a reset when its keychain key is gone — it is not.".into());
        }
        let keys = crate::secret_vault::system_key_store(&app.config().identifier)
            .ok_or("This platform has no keychain to make a new key in.")?;
        for device in store.remote_device_records().map_err(|e| e.to_string())? {
            crate::ipc::remote_devices::revoke_device(&store, &hub, &device.device_id)?;
        }
        for key in crate::store::db::SECRET_META_KEYS {
            store.delete_secret_config(key).map_err(|e| e.to_string())?;
        }
        store
            .set_config(REMOTE_LEGACY_RETIRED_KEY, "1")
            .and_then(|_| store.set_config(REMOTE_MAC_ID_KEY, &uuid::Uuid::new_v4().to_string()))
            .map_err(|e| e.to_string())?;
        let has_sealed = store.has_sealed_secrets().map_err(|e| e.to_string())?;
        store.set_vault(crate::secret_vault::open_vault(keys.as_ref(), has_sealed));
        if let Some((reason, _)) = store.vault_problem() {
            return Err(reason);
        }
        load_remote_config(&store)
    };
    hub.apply_remote(cfg).await;
    crate::ipc::remote_devices::spawn_device_sync(&app);
    Ok(hub.remote_status())
}

/// Why `set_remote` refuses to regenerate the legacy pairing.
pub(crate) const LEGACY_REGENERATE_REFUSED: &str = "The unencrypted pairing can no longer be regenerated — \
     retire it (Settings → Phones) and pair your phones again on the encrypted channel.";

/// Where this Mac's TOFU `known_hosts` for paired servers lives — the same path
/// every other remote-server ssh call in this crate uses (e.g.
/// [`list_remote_repos`]), factored out for C10's background provisioning hooks.
pub(crate) fn remote_known_hosts_path(app: &tauri::AppHandle) -> Option<String> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("remote_known_hosts").to_string_lossy().into_owned())
}

/// Every paired server's last phone-provisioning outcome this app run knows about
/// (C10/C11) — Settings' per-server status row reads this back, joined against
/// its own machine list by `machine_id`. A machine absent from the result has
/// simply not been attempted yet this run (e.g. app just launched, remote access
/// is off) — not a failure.
#[tauri::command]
#[specta::specta]
pub fn phone_provisioning_status(
    registry: tauri::State<'_, Arc<crate::appmcp::provision::ProvisionRegistry>>,
) -> Vec<crate::appmcp::provision::MachineProvisionStatus> {
    registry.all()
}

/// Every paired server's last phone-REVOCATION outcome this app run knows about
/// — the revoke-side counterpart of [`phone_provisioning_status`], populated by
/// [`set_remote`]'s regenerate-pairing revoke sweep (C10's critical fix). A
/// machine absent from the result has simply never had a revoke attempted this
/// run (most machines, most of the time) — not evidence it still holds a stale
/// token. Settings reads this to flag a server that refused, was too old, or
/// is still unreachable (queued for automatic retry) rather than silently
/// assuming the old token is gone everywhere once `set_remote` returns.
#[tauri::command]
#[specta::specta]
pub fn phone_revocation_status(
    registry: tauri::State<'_, Arc<crate::appmcp::provision::RevokeRegistry>>,
) -> Vec<crate::appmcp::provision::MachineRevokeStatus> {
    registry.all()
}

/// Settings' "Retry" button: (re)attempt provisioning the current phone token on
/// one server, synchronously — unlike the background hooks in [`set_remote`] /
/// [`add_machine`], a manual retry click should show immediate feedback. Records
/// `Pending` the moment it starts (so the row updates right away even though the
/// ssh round trip itself takes a beat), then the real outcome.
#[tauri::command]
#[specta::specta]
pub async fn retry_phone_provisioning(
    app: tauri::AppHandle,
    machine_id: String,
) -> Result<crate::appmcp::provision::MachineProvisionStatus, String> {
    let registry = (*app.state::<Arc<crate::appmcp::provision::ProvisionRegistry>>()).clone();
    registry.record(&machine_id, crate::appmcp::provision::ProvisionState::Pending);
    let store = app.state::<Store>();
    let known_hosts = remote_known_hosts_path(&app);
    let state = crate::appmcp::provision::provision_phone_on_machine(&store, known_hosts.as_deref(), &machine_id)
        .await
        .map_err(|e| {
            // Even the "unrelated to the daemon" error path (unknown machine id, a
            // store error) must still leave a row behind, not a request that
            // silently never resolved — the honest-status principle every other
            // core-backed Settings card follows here too.
            registry.record(&machine_id, crate::appmcp::provision::ProvisionState::Failed { reason: e.clone() });
            e
        })?;
    Ok(registry.record(&machine_id, state))
}

#[tauri::command]
#[specta::specta]
pub fn ping(msg: String) -> Pong {
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // Proof of the inbound leg (React -> Rust) on Rust stdout.
    println!("[ipc] ping received: msg={msg:?} -> replying Pong@{at_ms}");

    Pong {
        ok: true,
        echo: msg,
        at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder is (machine, path), and the spawn is handed the machine half: no machine
    /// id = this Mac (no SSH target at all), a machine id = an SSH target aimed at THAT
    /// server — two servers stay apart. The resolution never looks at a path (the old one
    /// picked whichever remote folder at the cwd's path SQLite returned first).
    #[test]
    fn spawn_target_follows_the_machine_id_it_is_given() {
        let store = Store::open_in_memory().unwrap();
        for (id, host) in [("m1", "one.example"), ("m2", "two.example")] {
            let mut m = cache_test_machine(id);
            m.host = host.into();
            store.upsert_machine(&m).unwrap();
        }
        let target = |id: Option<&str>| {
            remote_machine_for_spawn(&store, id).unwrap().map(|m| remote_target_for(m, None))
        };

        assert!(target(None).is_none(), "a local folder spawns with no SSH target");
        let one = target(Some("m1")).unwrap();
        assert_eq!((one.host.as_str(), one.machine_id.as_deref()), ("one.example", Some("m1")));
        let two = target(Some("m2")).unwrap();
        assert_eq!((two.host.as_str(), two.machine_id.as_deref()), ("two.example", Some("m2")));
    }

    /// A server removed between the conversation's creation and its spawn must not
    /// degrade to a LOCAL spawn — the conversation would run in whatever sits at the same
    /// path on this Mac.
    #[test]
    fn spawn_refuses_an_unknown_machine_instead_of_running_locally() {
        let store = Store::open_in_memory().unwrap();
        let err = remote_machine_for_spawn(&store, Some("gone")).unwrap_err();
        assert!(err.contains("no longer paired"), "{err}");
    }

    fn store_with_conversation(session_id: Option<&str>) -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_repo(&crate::store::RepoRecord {
                id: "r1".into(),
                path: "/srv/app".into(),
                added_at: 1,
                machine_id: None,
            })
            .unwrap();
        store
            .upsert_conversation(&crate::store::ConversationRecord {
                id: "c1".into(),
                name: "remote work".into(),
                repo_id: "r1".into(),
                cwd: "/srv/app".into(),
                created_at: 1,
                last_activity_at: 1,
                session_id: session_id.map(str::to_string),
                backend: "claude".into(),
                model: None,
                effort: None,
                ultracode: false,
                permission_mode: None,
                clean_output: None,
                pending_reminder: None,
                tosse_task_id: None,
                tosse_task_title: None,
                tosse_task_status: None,
                claude_account_id: None,
            })
            .unwrap();
        store
    }

    // ---- reads routed by conversation ----

    fn paired_machine() -> MachineRecord {
        MachineRecord {
            id: "m1".into(),
            label: "Target".into(),
            host: "target.example".into(),
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

    /// `store_with_conversation`'s local `c1`, plus `c2` in a folder on server `m1`.
    fn store_with_local_and_remote() -> Store {
        let store = store_with_conversation(Some("sid-local"));
        store.upsert_machine(&paired_machine()).unwrap();
        store
            .upsert_repo(&crate::store::RepoRecord {
                id: "r2".into(),
                path: "/srv/remote".into(),
                added_at: 2,
                machine_id: Some("m1".into()),
            })
            .unwrap();
        let mut remote = store.load_state().unwrap().conversations.remove(0);
        remote.id = "c2".into();
        remote.repo_id = "r2".into();
        remote.session_id = Some("sid-remote".into());
        store.upsert_conversation(&remote).unwrap();
        store
    }

    /// A fake `ssh` that swallows the script and answers `answer` verbatim, standing in for the
    /// server; installed on this test thread only (the `TEST_SSH_BIN` seam).
    struct FakeServer(PathBuf);
    impl FakeServer {
        fn answering(name: &str, answer: &str) -> Self {
            use std::os::unix::fs::PermissionsExt as _;
            let dir = std::env::temp_dir().join(format!("fd-routed-read-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = dir.join("ssh");
            std::fs::write(&bin, format!("#!/bin/sh\ncat >/dev/null\nprintf '%s' {}\n", shq(answer))).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(bin.to_string_lossy().into_owned()));
            FakeServer(dir)
        }
    }
    impl Drop for FakeServer {
        fn drop(&mut self) {
            TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// A read is placed by its conversation: a local folder → this Mac, a server's folder →
    /// that server, an UNKNOWN conversation → an error (never "this Mac").
    #[test]
    fn routed_reads_place_local_remote_and_unknown_conversations() {
        let store = store_with_local_and_remote();
        assert_eq!(files_location(&store, "c1").unwrap(), FilesAt::ThisMac);
        assert_eq!(files_location(&store, "c2").unwrap(), FilesAt::Server(paired_machine()));
        assert_eq!(
            files_location(&store, "no-such-conv").unwrap_err(),
            FileReadError::UnknownConversation { conversation_id: "no-such-conv".into() }
        );
    }

    /// A composer attachment of a REMOTE conversation is copied to ITS server (routed by the
    /// conversation id) and the server's path comes back; a LOCAL conversation's is never
    /// copied anywhere; an unknown conversation is refused in words, never treated as local.
    #[tokio::test]
    async fn an_attachment_is_uploaded_to_the_remote_conversations_server_only() {
        let store = store_with_local_and_remote();
        let dir = std::env::temp_dir().join(format!("fd-upload-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.md");
        std::fs::write(&file, "hello").unwrap();
        let local_path = file.to_string_lossy().into_owned();
        let _server = FakeServer::answering("upload", "FDUP1 ok /home/agent/.cache/flightdeck/uploads/c2/notes.md\n");

        let remote = upload_attachment_at(files_location(&store, "c2").unwrap(), None, "c2", &local_path, None)
            .await
            .unwrap();
        assert_eq!(remote, "/home/agent/.cache/flightdeck/uploads/c2/notes.md");

        let local = upload_attachment_at(files_location(&store, "c1").unwrap(), None, "c1", &local_path, None)
            .await
            .unwrap_err();
        assert!(local.contains("runs on this Mac"), "{local}");

        let unknown = upload_refusal(&files_location(&store, "no-such-conv").unwrap_err());
        assert!(unknown.contains("no longer known"), "{unknown}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The same task-output path, read for a remote conversation, goes to the SERVER (the fake
    /// answers) — and never to this Mac's disk, where the file does not exist; read for a local
    /// conversation, this Mac's reader answers "absent" without any round trip.
    #[tokio::test]
    async fn a_remote_conversations_task_output_is_read_on_its_server_not_this_mac() {
        let store = store_with_local_and_remote();
        let path = "/tmp/claude-501/-srv-remote/0f1e2d3c-sid/tasks/b9fakeout.output".to_string();
        let _server = FakeServer::answering("taskout", "FDREAD1 found 13 0\nfrom server\n");

        let remote = read_task_output_at(files_location(&store, "c2").unwrap(), None, Some(path.clone()), None, None)
            .await
            .unwrap()
            .expect("the server has it");
        assert_eq!(remote.data, "from server\n");
        assert_eq!((remote.start, remote.next_offset, remote.size), (0, 12, 13));

        let local = read_task_output_at(files_location(&store, "c1").unwrap(), None, Some(path), None, None)
            .await
            .unwrap();
        assert_eq!(local, None, "this Mac has no such file — and was never asked about the server's");
    }

    /// A task with no reported path yet (a running `Monitor`) is located by (session, task) — on
    /// the server for a remote conversation (the fake answers), on this Mac for a local one; with
    /// neither a path nor a task there is nothing to read, refused in words on this Mac.
    #[tokio::test]
    async fn a_task_output_without_a_path_is_located_where_the_conversation_runs() {
        let store = store_with_local_and_remote();
        let locate = TaskOutputLocator { session_id: "sid-remote".into(), task_id: "bk5y3rqjw".into() };
        {
            let _server = FakeServer::answering("tasklocate", "FDREAD1 found 6 0
tick1
");
            let remote = read_task_output_at(files_location(&store, "c2").unwrap(), None, None, Some(locate.clone()), None)
                .await
                .unwrap()
                .expect("found on the server");
            assert_eq!(remote.data, "tick1
");
        }
        // This Mac has no task by that session: absent, without any round trip.
        let local = read_task_output_at(
            files_location(&store, "c1").unwrap(),
            None,
            None,
            Some(TaskOutputLocator { session_id: "fd-no-such-session-xyz".into(), task_id: "bk5y3rqjw".into() }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(local, None);
        for at in [FilesAt::ThisMac, files_location(&store, "c2").unwrap()] {
            let err = read_task_output_at(at, None, None, None, None).await.unwrap_err();
            assert!(matches!(err, FileReadError::Refused { server: None, .. }), "{err:?}");
        }
    }

    /// A local conversation's task output keeps reading this Mac's file, now incrementally.
    #[tokio::test]
    async fn a_local_conversations_task_output_reads_this_macs_file_incrementally() {
        let dir = std::env::temp_dir().join(format!("fd-local-taskout-{}", std::process::id()));
        let tasks = dir.join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        let file = tasks.join("b1.output");
        std::fs::write(&file, "one\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        let first = read_task_output_at(FilesAt::ThisMac, None, Some(path.clone()), None, None).await.unwrap().unwrap();
        assert_eq!((first.data.as_str(), first.next_offset), ("one\n", 4));
        std::fs::write(&file, "one\ntwo\n").unwrap();
        let next = read_task_output_at(FilesAt::ThisMac, None, Some(path.clone()), None, Some(4)).await.unwrap().unwrap();
        assert_eq!((next.data.as_str(), next.start, next.next_offset), ("two\n", 4, 8));
        // A path that isn't a task output is refused, as before.
        let err = read_task_output_at(FilesAt::ThisMac, None, Some("/etc/passwd".into()), None, None).await.unwrap_err();
        assert!(matches!(err, FileReadError::Io { server: None, .. }), "{err:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Transcript and goal reads for a remote conversation are answered by its server.
    #[tokio::test]
    async fn remote_transcript_and_goal_reads_go_to_the_server() {
        let store = store_with_local_and_remote();
        let line = r#"{"type":"assistant","uuid":"u1","isSidechain":true,"message":{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"done"}]}}"#;
        {
            let answer = format!(
                "FDREAD1 found {} 0 /home/agent/.claude/projects/-srv-remote/sid-remote/subagents/agent-a1.jsonl\n{line}\n",
                line.len() + 1
            );
            let _server = FakeServer::answering("transcript", &answer);
            let cache = remote_files::TranscriptCache::default();
            let items = load_subagent_transcript_at(
                files_location(&store, "c2").unwrap(),
                None,
                &cache,
                "c2".into(),
                "sid-remote".into(),
                "a1".into(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(items.len(), 1, "{items:?}");
        }
        {
            let answer = "FDREAD1 found 999 0 /home/agent/.claude/projects/-srv-remote/sid-remote.jsonl\n\
                {\"type\":\"attachment\",\"attachment\":{\"type\":\"goal_status\",\"met\":false,\"sentinel\":true,\"condition\":\"ship it\"}}\n";
            let _server = FakeServer::answering("goal", answer);
            let goal = load_session_goal_at(files_location(&store, "c2").unwrap(), None, "sid-remote".into())
                .await
                .unwrap();
            assert_eq!(goal, Some(GoalState { condition: "ship it".into(), reason: None }));
        }
    }

    /// A conversation's first remote spawn mints the daemon conversation id AND records it;
    /// every later spawn asks for that same one — the re-join key that survives the server's
    /// session id changing. A `/clear` from the phone while the Mac was away (simulated by
    /// a different session id on the record) leaves it untouched: it was never derived from
    /// the session id.
    #[test]
    fn a_remote_spawn_reuses_the_daemon_conversation_it_ran_under() {
        let store = store_with_conversation(Some("sid-before-clear"));
        let first = daemon_conversation_for_spawn(&store, Some("c1"), || "minted-1".into());
        assert_eq!(first, "minted-1");
        assert_eq!(store.remote_attach_conversation("c1").unwrap().as_deref(), Some("minted-1"));

        // The attach landed on another daemon conversation: the actor persists that one.
        store.set_remote_attach_conversation("c1", "daemon-live").unwrap();
        let mut record = store.load_state().unwrap().conversations.remove(0);
        record.session_id = Some("sid-after-clear".into());
        store.upsert_conversation(&record).unwrap();
        let again = daemon_conversation_for_spawn(&store, Some("c1"), || panic!("must not mint"));
        assert_eq!(again, "daemon-live");
    }

    /// An older caller that names no conversation keeps the previous behaviour: a fresh id,
    /// nothing recorded anywhere.
    #[test]
    fn a_spawn_without_a_conversation_id_mints_a_fresh_daemon_conversation() {
        let store = store_with_conversation(None);
        assert_eq!(daemon_conversation_for_spawn(&store, None, || "fresh".into()), "fresh");
        assert_eq!(store.remote_attach_conversation("c1").unwrap(), None);
    }

    #[test]
    fn ping_echoes_message_and_marks_ok() {
        let pong = ping("hello".to_string());
        assert!(pong.ok);
        assert_eq!(pong.echo, "hello");
        assert!(pong.at_ms > 0, "timestamp should be populated");
    }

    /// `get_usage` is a CLAUDE control request, so the live fast path of
    /// [`get_plan_usage`] must aim at a Claude session — never at whatever handle the
    /// registry's `HashMap` yields first. With a Codex conversation open too, that
    /// arbitrary pick asked an actor that cannot answer and dropped the account onto the
    /// HTTP/Keychain path the fast path exists to avoid, nondeterministically per run.
    #[test]
    fn claude_handles_skips_codex_and_is_deterministic() {
        fn handle(id: &str) -> SessionHandle {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            SessionHandle::from_channel(id.to_string(), tx)
        }
        let sessions = Sessions::new();
        sessions.insert("session-2".into(), Backend::Codex, handle("session-2"), None, false);
        sessions.insert("session-1".into(), Backend::Claude, handle("session-1"), None, false);
        sessions.insert("session-3".into(), Backend::Claude, handle("session-3"), None, false);

        let ids: Vec<String> =
            sessions.claude_handles_for(None).into_iter().map(|h| h.id).collect();
        assert_eq!(ids, ["session-1", "session-3"], "Claude sessions only, in a stable order");
        assert_eq!(sessions.handles().len(), 3, "the neutral snapshot still sees every session");
        assert!(sessions.get("session-2").is_some(), "lookup by id stays backend-blind");

        assert_eq!(sessions.remove("session-1").map(|h| h.id).as_deref(), Some("session-1"));
        let left: Vec<String> =
            sessions.claude_handles_for(None).into_iter().map(|h| h.id).collect();
        assert_eq!(left, ["session-3"], "an evicted session is no longer offered");

        sessions.remove("session-3");
        assert!(
            sessions.claude_handles_for(None).is_empty(),
            "a Codex-only fleet has nobody to ask — the HTTP fallback must stay reachable"
        );
    }

    /// A `get_usage` answer belongs to the ACCOUNT that served it. With two accounts
    /// signed in, aiming the fast path at any Claude session would report another
    /// account's subscription figures — a plausible-looking wrong number that the ring
    /// would show and the auto-switch would then act on. So the registry filters by
    /// account, and an account with no live session yields nothing (→ the HTTP path,
    /// which is scoped to that account's own credentials).
    #[test]
    fn claude_handles_are_scoped_to_one_account() {
        fn handle(id: &str) -> SessionHandle {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            SessionHandle::from_channel(id.to_string(), tx)
        }
        let sessions = Sessions::new();
        sessions.insert("session-1".into(), Backend::Claude, handle("session-1"), None, false);
        sessions.insert(
            "session-2".into(),
            Backend::Claude,
            handle("session-2"),
            Some("acct-b".into()),
            false,
        );

        let default: Vec<String> =
            sessions.claude_handles_for(None).into_iter().map(|h| h.id).collect();
        assert_eq!(default, ["session-1"], "the default account must not see acct-b's session");

        let b: Vec<String> = sessions
            .claude_handles_for(Some("acct-b"))
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(b, ["session-2"], "acct-b must not see the default account's session");

        assert!(
            sessions.claude_handles_for(Some("acct-c")).is_empty(),
            "an account with no live session has no fast path — never another account's"
        );
    }

    /// A REMOTE (SSH) session authenticates with the SERVER's credential store. It is
    /// recorded with no account, so without an explicit exclusion it matched `None` and the
    /// default account's usage ring asked it — showing the server account's quota as ours.
    #[test]
    fn remote_sessions_answer_for_no_local_account() {
        fn handle(id: &str) -> SessionHandle {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            SessionHandle::from_channel(id.to_string(), tx)
        }
        let sessions = Sessions::new();
        sessions.insert("session-1".into(), Backend::Claude, handle("session-1"), None, true);

        assert!(
            sessions.claude_handles_for(None).is_empty(),
            "a remote session must not answer for the default account"
        );
        assert!(sessions.get("session-1").is_some(), "it is still a live, addressable session");

        sessions.insert("session-2".into(), Backend::Claude, handle("session-2"), None, false);
        let default: Vec<String> =
            sessions.claude_handles_for(None).into_iter().map(|h| h.id).collect();
        assert_eq!(default, ["session-2"], "only the LOCAL default-account session is asked");
    }

    /// The resume invocation is BACKEND-AWARE: Claude uses `--resume`, Codex uses the
    /// `resume` subcommand. Handing a Codex thread id to `claude --resume` (the old,
    /// backend-blind behavior) opened a fresh empty session — the "wrong id" bug.
    #[cfg(target_os = "macos")]
    #[test]
    fn resume_invocation_is_backend_aware() {
        // Assert the SYNTAX (env-independent: the binary name varies with $TOSSE_*_BIN,
        // but the resume grammar is what matters — and mutating process env would race
        // the parallel bin-resolution tests).
        let claude = super::resume_invocation(super::Backend::Claude, "abc-123");
        assert!(claude.contains("--resume 'abc-123'"), "Claude uses --resume: {claude}");
        let codex = super::resume_invocation(super::Backend::Codex, "abc-123");
        assert!(codex.contains(" resume 'abc-123'"), "Codex uses the `resume` subcommand: {codex}");
        assert!(!codex.contains("--resume"), "Codex must NOT use --resume: {codex}");
    }

    /// A cwd with a space and a single quote must survive shell-quoting intact,
    /// so `cd` lands in the right directory (no command injection / breakage).
    #[cfg(target_os = "macos")]
    #[test]
    fn sh_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(super::sh_quote("/tmp/plain"), "'/tmp/plain'");
        assert_eq!(super::sh_quote("/a b/c"), "'/a b/c'");
        assert_eq!(super::sh_quote("/o'brien"), "'/o'\\''brien'");
    }

    /// `claude --resume` is project-scoped by cwd, so a relative path like "."
    /// must become absolute (against the app's cwd) or resume opens the wrong,
    /// empty project. Absolute paths pass through untouched.
    #[cfg(target_os = "macos")]
    #[test]
    fn resolve_cwd_makes_relative_paths_absolute() {
        assert_eq!(super::resolve_cwd("/Users/x/proj"), "/Users/x/proj");
        let resolved = super::resolve_cwd(".");
        assert!(
            std::path::Path::new(&resolved).is_absolute(),
            "'.' should resolve to an absolute path, got {resolved:?}"
        );
        assert!(!resolved.contains("/./"), "should not keep a literal '.' segment");
    }

    // ---- Remote pairing: version comparison (A1) ---------------------------------

    #[test]
    fn version_at_least_compares_dotted_versions() {
        assert!(super::version_at_least("0.1.0", "0.1.0"), "equal versions are 'at least'");
        assert!(!super::version_at_least("0.0.9", "0.1.0"), "0.0.9 is older than 0.1.0");
        assert!(super::version_at_least("0.2.0", "0.1.0"), "0.2.0 is newer than 0.1.0");
    }

    /// A future `--version` format tweak (extra field, unparseable suffix, …) must
    /// degrade to "outdated", never panic the probe.
    #[test]
    fn version_at_least_treats_malformed_components_as_zero() {
        assert!(!super::version_at_least("garbage", "0.1.0"), "unparseable version reads as 0.0.0");
        assert!(!super::version_at_least("", "0.1.0"), "empty version reads as 0.0.0");
        assert!(super::version_at_least("garbage", ""), "0.0.0 is still 'at least' an empty min");
    }

    #[test]
    fn version_at_least_reads_the_clap_name_version_shape() {
        // `<name> <version>` output (what `claude --version` / `flightdeckd --version`
        // actually print) — only the LAST whitespace token is the version.
        assert!(super::version_at_least("flightdeckd 0.1.0", "0.1.0"));
        assert!(!super::version_at_least("flightdeckd 0.0.9", "0.1.0"));
    }

    // ---- resolve_claude_bin_expr (B14) --------------------------------------------
    //
    // The generated `$(...)` expression is real shell — every case below actually runs
    // it through `sh -c`, with `PATH`/`HOME` overridden per-process (never the test
    // runner's own environment), rather than just asserting on the string's shape. The
    // one exception is the `/usr/local/bin` fallback, which cannot safely stage a fake
    // executable at a real, shared system path from a unit test — that case stays a
    // structural assertion, mirroring `supervisor::transport`'s own
    // `resolve_remote_daemon_bin_searches_path_then_local_then_usr_local_for_a_bare_name`
    // test for the identical dilemma on the `flightdeckd` resolver.
    mod resolve_claude_bin_expr_tests {
        use std::os::unix::fs::PermissionsExt;

        /// A scratch directory removed on drop — same discipline as
        /// `bootstrap::server_setup::tests::ScratchKnownHosts`.
        struct ScratchDir(std::path::PathBuf);
        impl ScratchDir {
            fn new(tag: &str) -> Self {
                let path = std::env::temp_dir().join(format!("flightdeck-claude-bin-{tag}-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).expect("scratch dir");
                Self(path)
            }
        }
        impl Drop for ScratchDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        /// Writes an executable (mode 755) no-op script at `path`.
        fn write_executable(path: &std::path::Path) {
            std::fs::write(path, "#!/bin/sh\nexit 0\n").expect("write fake claude");
            let mut perms = std::fs::metadata(path).expect("stat fake claude").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).expect("chmod fake claude");
        }

        /// Runs the resolver expression through a real `sh -c`, with `PATH`/`HOME`
        /// overridden for that ONE child process only, and returns its resolved stdout.
        fn resolve_with(path: &str, home: &str) -> String {
            let expr = super::super::resolve_claude_bin_expr();
            // `/bin/sh` (absolute, never searched via `PATH`) — `path` below overrides
            // the CHILD's own `PATH` env var (what the resolver's internal `command -v`
            // reads), which would otherwise ALSO break resolving `sh` itself if it were
            // spawned by bare name.
            // `expr` (a `$(...)` command substitution) is itself double-quoted here —
            // NOT how a production call site uses it (those need it UNQUOTED, in
            // COMMAND-NAME position — see `resolve_daemon_bin_expr`'s own doc) — purely
            // so THIS test's own `printf` sees the resolved path as ONE field even when
            // it contains a space, instead of the outer shell field-splitting it first.
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("printf %s \"{expr}\""))
                .env("PATH", path)
                .env("HOME", home)
                .output()
                .expect("/bin/sh must be available to exercise the resolver");
            assert!(out.status.success(), "resolver script failed: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        #[test]
        fn finds_it_on_path() {
            let dir = ScratchDir::new("path");
            let claude = dir.0.join("claude");
            write_executable(&claude);
            let home = ScratchDir::new("path-home"); // has no ~/.local/bin at all
            let resolved = resolve_with(&dir.0.to_string_lossy(), &home.0.to_string_lossy());
            assert_eq!(resolved, claude.to_string_lossy());
        }

        #[test]
        fn falls_back_to_local_bin_when_not_on_path() {
            // A PATH pointing at an empty, real directory — `command -v` must fail to
            // find anything there, never silently succeed on a stale absolute lookup.
            let empty_path = ScratchDir::new("local-bin-emptypath");
            let home = ScratchDir::new("local-bin-home");
            let local_bin = home.0.join(".local/bin");
            std::fs::create_dir_all(&local_bin).expect("mkdir ~/.local/bin");
            let claude = local_bin.join("claude");
            write_executable(&claude);
            let resolved = resolve_with(&empty_path.0.to_string_lossy(), &home.0.to_string_lossy());
            assert_eq!(resolved, claude.to_string_lossy());
        }

        /// (B14) A `HOME` containing a space must still resolve correctly — the
        /// resolver's own double-quoting (`"$HOME/.local/bin/$VAR"`) must survive it.
        #[test]
        fn falls_back_to_local_bin_with_a_space_in_home() {
            let empty_path = ScratchDir::new("space-emptypath");
            let home_parent = ScratchDir::new("space-home");
            let home = home_parent.0.join("has space");
            let local_bin = home.join(".local/bin");
            std::fs::create_dir_all(&local_bin).expect("mkdir ~/.local/bin");
            let claude = local_bin.join("claude");
            write_executable(&claude);
            let resolved = resolve_with(&empty_path.0.to_string_lossy(), &home.to_string_lossy());
            assert_eq!(resolved, claude.to_string_lossy());
        }

        #[test]
        fn falls_back_to_the_bare_name_when_absent_everywhere() {
            let empty_path = ScratchDir::new("absent-emptypath");
            let home = ScratchDir::new("absent-home"); // no ~/.local/bin either
            let resolved = resolve_with(&empty_path.0.to_string_lossy(), &home.0.to_string_lossy());
            assert_eq!(resolved, "claude", "with nothing found anywhere, ssh's own \"command not found\" must fire");
        }

        /// `/usr/local/bin` cannot be safely staged from a unit test (it's a real,
        /// shared system path) — structural assertion instead, same technique as
        /// `supervisor::transport`'s identical `flightdeckd` test.
        #[test]
        fn searches_usr_local_bin_as_the_last_fallback() {
            let expr = super::super::resolve_claude_bin_expr();
            assert!(expr.contains("command -v \"$FLIGHTDECK_CLAUDE_BIN\""), "checks PATH first: {expr}");
            assert!(expr.contains("$HOME/.local/bin/$FLIGHTDECK_CLAUDE_BIN"), "falls back to ~/.local/bin: {expr}");
            assert!(expr.contains("/usr/local/bin/$FLIGHTDECK_CLAUDE_BIN"), "falls back to /usr/local/bin: {expr}");
        }
    }

    // ---- Remote pairing: combined probe parsing (A1) ------------------------------
    //
    // No local sshd fixture exists in this suite, so these exercise the PURE parser
    // over captured stdout/stderr/exit-success triples — exactly what a real
    // `probe_remote` ssh round-trip would hand it.

    #[test]
    fn probe_parsing_reports_both_tools_missing_together() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:\nFLIGHTDECK_DAEMON_VERSION:\n";
        let stderr = "FLIGHTDECK_NO_CLAUDE\nFLIGHTDECK_NO_DAEMON\n";
        let result = super::parse_probe_output(stdout, stderr, false)
            .expect("the script ran (markers present) even though it exited nonzero");
        assert!(result.claude_missing, "claude must be reported missing");
        assert!(result.flightdeckd_missing, "flightdeckd must be reported missing TOO");
        assert!(result.claude_version.is_none());
        assert!(result.flightdeckd_version.is_none());

        // The user-facing error must name BOTH — this is the exact bug the old
        // script's mid-script `exit 3` caused (flightdeckd's check never ran).
        let msg = super::describe_probe_blockers(&result);
        assert!(msg.contains("claude"), "must mention claude: {msg}");
        assert!(msg.contains("flightdeckd"), "must mention flightdeckd: {msg}");
    }

    #[test]
    fn probe_parsing_names_flightdeckd_when_only_it_is_missing() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272 (Claude Code)\nFLIGHTDECK_DAEMON_VERSION:\n";
        let stderr = "FLIGHTDECK_NO_DAEMON\n";
        let result = super::parse_probe_output(stdout, stderr, false).unwrap();
        assert!(!result.claude_missing);
        assert!(result.flightdeckd_missing);
        assert_eq!(result.claude_version.as_deref(), Some("2.1.272 (Claude Code)"));

        let msg = super::describe_probe_blockers(&result);
        assert!(msg.contains("flightdeckd"), "must name flightdeckd specifically: {msg}");
        assert!(!msg.contains("`claude` is not installed"), "claude is fine, must not be blamed: {msg}");
    }

    #[test]
    fn probe_parsing_flags_an_outdated_daemon_distinctly_from_a_missing_one() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\nFLIGHTDECK_DAEMON_VERSION:flightdeckd 0.0.9\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert!(!result.flightdeckd_missing, "an outdated daemon is PRESENT, just too old");
        assert!(result.flightdeckd_outdated);

        let msg = super::describe_probe_blockers(&result);
        assert!(msg.contains("older than"), "must give a distinct, version-specific message: {msg}");
        assert!(!msg.contains("is not installed"), "must not conflate outdated with missing: {msg}");
    }

    #[test]
    fn probe_parsing_is_ok_when_both_tools_are_present_and_current() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\nFLIGHTDECK_DAEMON_VERSION:flightdeckd 0.1.0\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert!(!result.claude_missing);
        assert!(!result.flightdeckd_missing);
        assert!(!result.flightdeckd_outdated);
    }

    /// A genuine ssh-level failure (bad host/key/auth) never even reaches the probe
    /// script — neither marker line shows up at all, as opposed to showing up empty
    /// (the "both missing" case above).
    #[test]
    fn probe_parsing_reports_a_connection_failure_as_err_not_missing_tools() {
        let err = super::parse_probe_output("", "Permission denied (publickey).\n", false)
            .expect_err("no marker lines at all means the script never ran");
        assert!(err.contains("Permission denied"), "should surface the real ssh error: {err}");
    }

    // ---- Install-mode probe facts (B7) ----------------------------------------------
    // `add_machine`'s own pairing script (`probe_remote`, above) never emits any of
    // these markers — so every pairing call gets `None`/`None`/... here for free,
    // exactly the "ignores the new fields" behavior the brief requires. These tests
    // drive `parse_probe_output` directly with `bootstrap::connect::PROBE_SCRIPT`-shaped
    // marker lines, since that extended script is the only thing that ever emits them.

    /// A minimal pairing-style probe (only the two original markers) must leave every
    /// new B7 field `None` — proves pairing's own script truly is unaffected by the
    /// struct growing these fields.
    #[test]
    fn probe_parsing_leaves_install_mode_fields_none_when_their_markers_never_ran() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\nFLIGHTDECK_DAEMON_VERSION:flightdeckd 0.1.0\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert_eq!(result.conflict, None);
        assert_eq!(result.os, None);
        assert_eq!(result.arch, None);
        assert_eq!(result.systemd, None);
        assert_eq!(result.passwordless_sudo, None);
        assert_eq!(result.linger, None);
        assert_eq!(result.kill_user_processes, None);
    }

    #[test]
    fn probe_parsing_reads_every_install_mode_marker_when_present() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\n\
                       FLIGHTDECK_DAEMON_VERSION:\n\
                       FLIGHTDECK_OS:Linux\n\
                       FLIGHTDECK_ARCH:aarch64\n\
                       FLIGHTDECK_SYSTEMD:yes\n\
                       FLIGHTDECK_PASSWORDLESS_SUDO:no\n\
                       FLIGHTDECK_LINGER:no\n\
                       FLIGHTDECK_KILL_USER_PROCESSES:no\n\
                       FLIGHTDECK_CONFLICT:an existing system unit at /etc/systemd/system/flightdeckd.service\n";
        let result = super::parse_probe_output(stdout, "FLIGHTDECK_NO_DAEMON\n", false).unwrap();
        assert_eq!(result.os.as_deref(), Some("Linux"));
        assert_eq!(result.arch.as_deref(), Some("aarch64"));
        assert_eq!(result.systemd, Some(true));
        assert_eq!(result.passwordless_sudo, Some(false));
        assert_eq!(result.linger, Some(false));
        assert_eq!(result.kill_user_processes, Some(false));
        assert_eq!(
            result.conflict.as_deref(),
            Some("an existing system unit at /etc/systemd/system/flightdeckd.service")
        );
    }

    /// `FLIGHTDECK_KILL_USER_PROCESSES:` with an EMPTY value (the extended script's own
    /// shape when `busctl` is unavailable, or its output doesn't parse) must read back
    /// `None`, never a false `Some(false)` — a missing/garbled fact must degrade
    /// silently, never masquerade as a confident negative answer.
    #[test]
    fn probe_parsing_reads_an_empty_marker_value_as_none_not_a_false_negative() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\n\
                       FLIGHTDECK_DAEMON_VERSION:flightdeckd 0.1.0\n\
                       FLIGHTDECK_KILL_USER_PROCESSES:\n\
                       FLIGHTDECK_LINGER:\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert_eq!(result.kill_user_processes, None);
        assert_eq!(result.linger, None);
    }

    /// A garbled `yes`/`no` marker value (neither exact string) must also degrade to
    /// `None`, never panic or silently coerce to a boolean.
    #[test]
    fn probe_parsing_treats_a_garbled_yes_no_marker_as_none() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\n\
                       FLIGHTDECK_DAEMON_VERSION:flightdeckd 0.1.0\n\
                       FLIGHTDECK_SYSTEMD:maybe\n\
                       FLIGHTDECK_PASSWORDLESS_SUDO:Y\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert_eq!(result.systemd, None);
        assert_eq!(result.passwordless_sudo, None);
    }

    /// No conflict line at all (the ordinary, non-conflicting case) must read back
    /// `None`, never an empty string.
    #[test]
    fn probe_parsing_reads_no_conflict_marker_as_none() {
        let stdout = "FLIGHTDECK_CLAUDE_VERSION:2.1.272\nFLIGHTDECK_DAEMON_VERSION:flightdeckd 0.1.0\n";
        let result = super::parse_probe_output(stdout, "", true).unwrap();
        assert_eq!(result.conflict, None);
    }

    // ---- Remote pairing: candidate addresses (A5) ----------------------------------

    fn addr(kind: AddressKind, value: &str) -> AddressCandidate {
        AddressCandidate { kind, value: value.to_string() }
    }

    #[test]
    fn address_probe_order_sorts_tailscale_lan_public_manual() {
        let shuffled = vec![
            addr(AddressKind::Manual, "manual-host"),
            addr(AddressKind::Public, "1.2.3.4"),
            addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            addr(AddressKind::Lan, "192.168.1.5"),
        ];
        let ordered = super::address_probe_order(shuffled);
        let kinds: Vec<&AddressKind> = ordered.iter().map(|c| &c.kind).collect();
        assert_eq!(
            kinds,
            vec![&AddressKind::Tailscale, &AddressKind::Lan, &AddressKind::Public, &AddressKind::Manual],
        );
    }

    #[test]
    fn address_probe_order_is_stable_and_idempotent_on_a_partial_list() {
        // No Tailscale/Public candidates at all — just two Lan entries whose relative
        // order must survive the sort (a stable sort never reorders equal-priority
        // items), followed by one Manual.
        let partial = vec![
            addr(AddressKind::Lan, "192.168.1.5"),
            addr(AddressKind::Manual, "my-box"),
            addr(AddressKind::Lan, "10.0.0.9"),
        ];
        let once = super::address_probe_order(partial);
        assert_eq!(
            once.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(),
            vec!["192.168.1.5", "10.0.0.9", "my-box"],
            "Lan entries keep their relative order (stable sort), Manual sorts last",
        );

        let twice = super::address_probe_order(once.clone());
        assert_eq!(twice, once, "re-running on an already-sorted/deduped list is a no-op");
    }

    #[test]
    fn address_probe_order_deduplicates_by_value() {
        let candidates = vec![
            addr(AddressKind::Lan, "192.168.1.5"),
            addr(AddressKind::Tailscale, "192.168.1.5"), // same value, different kind
            addr(AddressKind::Manual, "192.168.1.5"),
            addr(AddressKind::Public, "1.2.3.4"),
        ];
        let ordered = super::address_probe_order(candidates);
        assert_eq!(
            ordered.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(),
            vec!["192.168.1.5", "1.2.3.4"],
            "only the FIRST occurrence of a repeated value survives",
        );
        assert_eq!(ordered[0].kind, AddressKind::Lan, "the first-seen kind for that value wins");
    }

    #[test]
    fn validate_address_value_rejects_ssh_option_injection_empty_and_whitespace() {
        assert!(super::validate_address_value("-oProxyCommand=evil").is_err());
        assert!(super::validate_address_value("").is_err());
        assert!(super::validate_address_value("has space").is_err());
        assert!(super::validate_address_value("has\ttab").is_err());
        assert!(super::validate_address_value("has\nnewline").is_err());
        assert!(super::validate_address_value("box.tailnet.ts.net").is_ok());
        assert!(super::validate_address_value("192.168.1.5").is_ok());
    }

    // ---- push_ssh_destination — the shared builder every ssh-argv call site in this
    // crate funnels the (user, host) pair through (CRM holistic-review blocker #3,
    // chantier A `bd7ca709`) ----

    #[test]
    fn push_ssh_destination_rejects_an_option_injection_user_and_appends_nothing() {
        let mut cmd = tokio::process::Command::new("ssh");
        let err = push_ssh_destination(&mut cmd, "-oProxyCommand=touch /tmp/pwned", "example.com")
            .expect_err("an ssh-option-shaped user must be refused");
        assert!(!err.is_empty());
        let args: Vec<String> =
            cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.is_empty(), "a rejected destination must append NOTHING to cmd: {args:?}");
    }

    #[test]
    fn push_ssh_destination_rejects_an_option_injection_host_and_appends_nothing() {
        let mut cmd = tokio::process::Command::new("ssh");
        let err = push_ssh_destination(&mut cmd, "deploy", "-oProxyCommand=touch /tmp/pwned")
            .expect_err("an ssh-option-shaped host must be refused");
        assert!(!err.is_empty());
        let args: Vec<String> =
            cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.is_empty(), "a rejected destination must append NOTHING to cmd: {args:?}");
    }

    /// The actual argv shape: `-l <user>` then `-- <host>`, host last — never a
    /// concatenated `user@host` positional argument.
    #[test]
    fn push_ssh_destination_appends_dash_l_then_dash_dash_host() {
        let mut cmd = tokio::process::Command::new("ssh");
        push_ssh_destination(&mut cmd, "deploy", "example.com").unwrap();
        let args: Vec<String> =
            cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["-l", "deploy", "--", "example.com"]);
    }

    /// Full exploit-string table from the CRM holistic review, run through the actual
    /// builder every ssh call in this crate funnels through — every one must be
    /// refused, none may ever reach a spawned argv.
    #[test]
    fn push_ssh_destination_rejects_every_known_exploit_user() {
        for bad_user in [
            "-oProxyCommand=touch /tmp/pwned",
            "-F/etc/x",
            " user",
            "a b",
            "root@evil",
            "",
        ] {
            let mut cmd = tokio::process::Command::new("ssh");
            assert!(
                push_ssh_destination(&mut cmd, bad_user, "example.com").is_err(),
                "{bad_user:?} must be rejected"
            );
        }
        let too_long = "a".repeat(65);
        let mut cmd = tokio::process::Command::new("ssh");
        assert!(push_ssh_destination(&mut cmd, &too_long, "example.com").is_err());
    }

    #[test]
    fn push_ssh_destination_accepts_legitimate_users() {
        for good_user in ["deploy", "josty", "first.last", "svc_build-2", "WORKGROUP$"] {
            let mut cmd = tokio::process::Command::new("ssh");
            assert!(
                push_ssh_destination(&mut cmd, good_user, "example.com").is_ok(),
                "{good_user:?} should be accepted"
            );
        }
    }

    // ---- run_ssh_on_machine / run_ssh_on_machine_stdin — given an exploit
    // user/host, they must return Err and NEVER actually spawn `ssh` (proven with a
    // fake `ssh` that would leave a marker file behind if it were ever invoked). ----

    fn machine_with_user_and_host(user: &str, host: &str) -> MachineRecord {
        let mut m = cache_test_machine("m-exploit");
        m.user = user.to_string();
        m.host = host.to_string();
        m
    }

    /// Writes a fake `ssh` that touches `marker` the instant it is invoked, in a
    /// fresh scratch dir — mirrors the fake-`ssh` seams used elsewhere in this crate
    /// (`appmcp::provision::FakeSsh`, `bootstrap::install`'s own fixtures).
    fn install_marker_fake_ssh(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "tosse-neverspawn-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("invoked.marker");
        let script = dir.join("ssh");
        std::fs::write(&script, format!("#!/bin/sh\ntouch {}\nexit 0\n", shq(&marker.to_string_lossy())))
            .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, marker)
    }

    #[tokio::test]
    async fn run_ssh_on_machine_rejects_an_exploit_user_without_ever_spawning_ssh() {
        let (dir, marker) = install_marker_fake_ssh("run-ssh-on-machine-user");
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(dir.join("ssh").to_string_lossy().into_owned()));
        let machine = machine_with_user_and_host("-oProxyCommand=touch /tmp/pwned", "example.com");
        let result = run_ssh_on_machine(&machine, None, "true").await;
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        assert!(result.is_err(), "an exploit user must be refused");
        assert!(!marker.exists(), "ssh must NEVER have been spawned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_ssh_on_machine_rejects_an_exploit_host_without_ever_spawning_ssh() {
        let (dir, marker) = install_marker_fake_ssh("run-ssh-on-machine-host");
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(dir.join("ssh").to_string_lossy().into_owned()));
        let machine = machine_with_user_and_host("deploy", "-oProxyCommand=touch /tmp/pwned");
        let result = run_ssh_on_machine(&machine, None, "true").await;
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        assert!(result.is_err(), "an exploit host must be refused");
        assert!(!marker.exists(), "ssh must NEVER have been spawned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real incident (CRM `c9bf1482`): this Mac's key was removed from a real
    /// server's `authorized_keys`, and ssh's raw stderr line
    /// (`josty@100.97.14.57: Permission denied (publickey,password).`) used to leak
    /// straight into this error string. Must now come back as `ssh_link::describe`'s
    /// classified sentence instead.
    #[tokio::test]
    async fn run_ssh_on_machine_classifies_a_key_refused_failure_instead_of_leaking_the_raw_line() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "tosse-keyrefused-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("ssh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'josty@100.97.14.57: Permission denied (publickey,password).' >&2\nexit 255\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(script.to_string_lossy().into_owned()));
        let machine = machine_with_user_and_host("josty", "example.com");
        let result = run_ssh_on_machine(&machine, None, "true").await;
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(result, Err("this Mac's saved key was refused by this server".to_string()));
    }

    /// A server that accepts the connection and then never answers (a dead link past the
    /// handshake, a login shell stuck on a stale NFS home, a wedged `flightdeckd`): the call
    /// must give up on its own deadline and say which server did not answer. It used to wait
    /// on `output()` forever, holding whatever lock its caller held (device sync, the install
    /// pipeline, the folder picker).
    #[tokio::test]
    async fn run_ssh_on_machine_gives_up_on_a_server_that_never_answers() {
        let dir = fake_ssh_dir("never-answers", "exec sleep 600");
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(dir.join("ssh").to_string_lossy().into_owned()));
        let mut machine = machine_with_user_and_host("deploy", "example.com");
        machine.label = "Base".into();
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            run_ssh_on_machine_within(&machine, None, "true", std::time::Duration::from_millis(300)),
        )
        .await;
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&dir);
        let result = result.expect("the call's own deadline must fire, not this outer guard");
        assert_eq!(result, Err("Base did not answer in time".to_string()));
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    }

    /// Every keyed one-shot detects a dead link itself (~30 s), even inside a call whose
    /// caller allows minutes: `ConnectTimeout` only covers the handshake.
    #[test]
    fn keyed_ssh_options_detect_a_dead_link_with_server_alive_probes() {
        let cmd = keyed_ssh_options_with_bin("ssh", 22, None, None).unwrap();
        let args: Vec<String> = cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let pairs: Vec<String> =
            args.windows(2).filter(|w| w[0] == "-o").map(|w| w[1].clone()).collect();
        assert!(pairs.contains(&"ServerAliveInterval=10".to_string()), "{args:?}");
        assert!(pairs.contains(&"ServerAliveCountMax=3".to_string()), "{args:?}");
    }

    /// Several callers bound a keyed round trip with their own `timeout(…, cmd.output())`
    /// (the 90 s health probe, the diagnosis, the key check, the pairing probe). When the
    /// deadline fires the future — and the child in it — is dropped; without
    /// `kill_on_drop` from the shared builder, ssh kept running against a server that
    /// authenticated and then never answered: one leaked process per probe tick.
    #[tokio::test]
    async fn keyed_ssh_command_is_reaped_when_a_timed_out_round_trip_is_dropped() {
        let dir = fake_ssh_dir("reaped", "echo $$ > \"$(dirname \"$0\")/pid\"\nexec sleep 600");
        let mut cmd =
            keyed_ssh_options_with_bin(&dir.join("ssh").to_string_lossy(), 22, None, None).unwrap();
        cmd.args(["-T", "-l", "u", "--", "h", "true"]);
        let timed_out = tokio::time::timeout(std::time::Duration::from_millis(300), cmd.output()).await;
        assert!(timed_out.is_err(), "the fake never answers");
        let pid = std::fs::read_to_string(dir.join("pid")).unwrap().trim().to_string();
        let mut state = String::new();
        for _ in 0..40 {
            let ps = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid]).output().unwrap();
            state = String::from_utf8_lossy(&ps.stdout).trim().to_string();
            if state.is_empty() || state.starts_with('Z') {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let _ = std::process::Command::new("kill").args(["-9", &pid]).status();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(state.is_empty() || state.starts_with('Z'), "ssh {pid} still running ({state})");
    }

    /// A known-hosts path shaped like the app's own (`~/Library/Application Support/<id>/…`),
    /// with more spaces than ssh accepts files in that option (32): unquoted, ssh read it
    /// as a LIST of files split on whitespace — pinning into `~/Library/Application` while
    /// the app's own host-key code read the real path. `ssh -G` only resolves the
    /// configuration; it never connects.
    #[test]
    fn keyed_ssh_options_known_hosts_path_with_spaces_is_one_file() {
        let kh = "/tmp/Application Support/a b c d e f g h i j k l m n o p q r s t u v w x y z A B C D E F G/remote_known_hosts";
        let cmd = keyed_ssh_options_with_bin("ssh", 22, Some("/tmp/id"), Some(kh)).unwrap();
        let out = std::process::Command::new("ssh")
            .arg("-F")
            .arg("/dev/null")
            .arg("-G")
            .args(cmd.as_std().get_args())
            .args(["-l", "u", "--", "nonexistent.invalid"])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("ssh -G runs");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "ssh rejected the option: {stderr}");
        assert!(!stderr.contains("too many userknownhostsfile entries"), "{stderr}");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.lines().any(|l| l == format!("userknownhostsfile {kh}")), "{stdout}");
    }

    /// What ssh resolves for `options` under a user config of `config` (`ssh -G`: it only
    /// reads the configuration, it never connects).
    fn ssh_resolved(config: &str, options: &[String]) -> String {
        let cfg = std::env::temp_dir().join(format!("fd-ssh-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::write(&cfg, config).unwrap();
        let out = std::process::Command::new("ssh")
            .arg("-F")
            .arg(&cfg)
            .arg("-G")
            .args(options)
            .args(["-l", "u", "--", "example.invalid"])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("ssh -G runs");
        let _ = std::fs::remove_file(&cfg);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// `LogLevel QUIET` (a common way to hide "Permanently added…" and login banners)
    /// silenced the very lines every classifier reads — "Permission denied", "Host key
    /// verification failed" — so a refused key or a changed host key read as "could not
    /// reach the server", and the live session reconnected forever. The command line
    /// wins over the user's config; every ssh this crate spawns starts from this base.
    #[test]
    fn ssh_options_pin_loglevel_over_a_quiet_user_config() {
        let quiet = "Host *\n  LogLevel QUIET\n";
        let keyed = keyed_ssh_args(22, Some("/k"), Some("/kh")).unwrap();
        assert!(ssh_resolved(quiet, &keyed).lines().any(|l| l == "loglevel INFO"));
        let common = common_ssh_args(22, None).unwrap();
        assert!(ssh_resolved(quiet, &common).lines().any(|l| l == "loglevel INFO"));
    }

    /// The real ssh's stderr, run with [`common_ssh_args`] under a user config that says
    /// `LogLevel QUIET`, against a one-connection server on this Mac's loopback that
    /// `serve` plays — nothing leaves the machine.
    #[cfg(unix)]
    fn ssh_stderr_against_loopback(serve: fn(std::net::TcpStream)) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                serve(stream);
            }
        });
        let dir = std::env::temp_dir().join(format!("fd-ssh-loopback-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config");
        std::fs::write(&cfg, "Host *\n  LogLevel QUIET\n").unwrap();
        let kh = dir.join("known_hosts");
        let args = common_ssh_args(port, Some(kh.to_str().unwrap())).unwrap();
        let out = std::process::Command::new("ssh")
            .arg("-F")
            .arg(&cfg)
            .args(&args)
            .args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-l", "u", "--", "127.0.0.1", "true"])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("ssh runs");
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(out.status.code(), Some(255), "{out:?}");
        String::from_utf8_lossy(&out.stderr).into_owned()
    }

    /// Most of the ways a link dies are logged by ssh at INFO, not ERROR (its `logdie`):
    /// "Connection closed by …", "Connection reset by …", "Unable to negotiate with … no
    /// matching key exchange method", "Timeout, server … not responding". Pinned at ERROR,
    /// ssh printed NOTHING for them — every one read as a bare "could not reach the server"
    /// (or "unknown error" at pairing), and a cipher the server does not share, which the
    /// user can fix, became indistinguishable from an outage. INFO is ssh's own default:
    /// what every classifier here was written against, whatever the user's config says.
    #[cfg(unix)]
    #[test]
    fn ssh_options_keep_the_failures_ssh_logs_at_info() {
        let closed = ssh_stderr_against_loopback(|stream| drop(stream));
        assert!(closed.contains("Connection closed by 127.0.0.1"), "{closed:?}");

        let no_shared_kex = ssh_stderr_against_loopback(|mut stream| {
            use std::io::Write;
            fn name_list(s: &str) -> Vec<u8> {
                let mut out = (s.len() as u32).to_be_bytes().to_vec();
                out.extend_from_slice(s.as_bytes());
                out
            }
            // KEXINIT offering only a key exchange method no ssh implements.
            let mut payload = vec![20u8];
            payload.extend_from_slice(&[7u8; 16]);
            for list in [
                "bogus-kex@example.invalid",
                "ssh-ed25519",
                "aes128-ctr",
                "aes128-ctr",
                "hmac-sha2-256",
                "hmac-sha2-256",
                "none",
                "none",
                "",
                "",
            ] {
                payload.extend(name_list(list));
            }
            payload.extend_from_slice(&[0, 0, 0, 0, 0]);
            let mut pad = 8 - (5 + payload.len()) % 8;
            if pad < 4 {
                pad += 8;
            }
            let mut packet = ((1 + payload.len() + pad) as u32).to_be_bytes().to_vec();
            packet.push(pad as u8);
            packet.extend(payload);
            packet.extend(std::iter::repeat_n(0u8, pad));
            let _ = stream.write_all(b"SSH-2.0-OpenSSH_fake\r\n");
            let _ = stream.write_all(&packet);
            // Hold the connection until ssh gives up on it.
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
            let _ = std::io::copy(&mut stream, &mut std::io::sink());
        });
        assert!(no_shared_kex.contains("Unable to negotiate with 127.0.0.1"), "{no_shared_kex:?}");
    }

    /// The dev-box pattern `RemoteCommand tmux new -A -s main` + `RequestTTY yes` in the
    /// user's `Host` block made ssh refuse every connection that also gives a command —
    /// all of ours ("Cannot execute command-line and remote command."), read as "could
    /// not reach the server". The command line neutralizes both.
    #[test]
    fn ssh_options_neutralize_a_remote_command_in_the_users_config() {
        let devbox = "Host *\n  RemoteCommand tmux new -A -s main\n  RequestTTY yes\n";
        for args in [keyed_ssh_args(22, Some("/k"), Some("/kh")).unwrap(), common_ssh_args(22, None).unwrap()] {
            let resolved = ssh_resolved(devbox, &args);
            assert!(!resolved.lines().any(|l| l.starts_with("remotecommand ")), "{resolved}");
            assert!(resolved.lines().any(|l| l == "requesttty false"), "{resolved}");
        }
    }

    /// An ssh failure the classifier has no name for is still "could not reach the
    /// server" — but no longer stripped of ssh's own reason, the one thing that tells the
    /// user the cause is a line in this Mac's ssh config.
    #[tokio::test]
    async fn run_ssh_on_machine_keeps_sshs_reason_for_an_unrecognized_failure() {
        let dir = fake_ssh_dir("unrecognized", "echo 'Cannot execute command-line and remote command.' >&2\nexit 255");
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(dir.join("ssh").to_string_lossy().into_owned()));
        let result = run_ssh_on_machine(&machine_with_user_and_host("deploy", "example.com"), None, "true").await;
        TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            result,
            Err("could not reach the server (ssh: Cannot execute command-line and remote command.)".to_string())
        );
    }

    /// The collector stops at its bound WHILE reading: an endless stdout is refused fast,
    /// and the child is killed rather than drained. Under the bound, both streams come
    /// back whole, and a stderr flood keeps only its head without blocking the child.
    #[tokio::test]
    async fn collect_output_refuses_a_stdout_past_its_bound_while_reading() {
        let started = std::time::Instant::now();
        let mut flood = tokio::process::Command::new("/usr/bin/yes");
        flood.kill_on_drop(true);
        let err = run_collecting(&mut flood, None, std::time::Duration::from_secs(20), 1024 * 1024).await.err();
        assert!(matches!(err, Some(CollectError::TooMuchOutput(n)) if n == 1024 * 1024), "{err:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());

        let mut fine = tokio::process::Command::new("/bin/sh");
        fine.args(["-c", "printf out; head -c 300000 /dev/zero >&2; cat"]).kill_on_drop(true);
        let got = run_collecting(&mut fine, Some(b" fed"), std::time::Duration::from_secs(20), 1024).await.unwrap();
        assert_eq!(got.stdout, b"out fed");
        assert_eq!(got.stderr.len(), SSH_STDERR_KEPT);
        assert!(got.status.is_some_and(|s| s.success()));
    }

    /// `%` is a token to ssh (doubled to stay literal), and a path it cannot be given
    /// exactly is refused, never passed in a form ssh would read as some other file.
    #[test]
    fn known_hosts_option_keeps_the_path_literal_or_refuses_it() {
        assert_eq!(known_hosts_option("/a b/100%/kh").unwrap(), "UserKnownHostsFile=\"/a b/100%%/kh\"");
        for bad in ["", "/a\"b/kh", "/a\\b/kh", "/${HOME}/kh", "/a\nb/kh"] {
            assert!(known_hosts_option(bad).is_err(), "{bad:?}");
            assert!(keyed_ssh_options_with_bin("ssh", 22, None, Some(bad)).is_err(), "{bad:?}");
        }
        let out = std::process::Command::new("ssh")
            .args(["-F", "/dev/null", "-G", "-o", &known_hosts_option("/tmp/100%/kh").unwrap()])
            .args(["-l", "u", "--", "nonexistent.invalid"])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("ssh -G runs");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.lines().any(|l| l == "userknownhostsfile /tmp/100%/kh"), "{stdout}");
    }

    #[tokio::test]
    async fn run_ssh_on_machine_stdin_rejects_an_exploit_user_without_ever_spawning_ssh() {
        let (dir, marker) = install_marker_fake_ssh("run-ssh-on-machine-stdin-user");
        let machine = machine_with_user_and_host("-oProxyCommand=touch /tmp/pwned", "example.com");
        let result = run_ssh_on_machine_stdin(
            &machine,
            None,
            "true",
            b"",
            Some(&dir),
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(result.is_err(), "an exploit user must be refused");
        assert!(!marker.exists(), "ssh must NEVER have been spawned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_ssh_on_machine_stdin_rejects_an_exploit_host_without_ever_spawning_ssh() {
        let (dir, marker) = install_marker_fake_ssh("run-ssh-on-machine-stdin-host");
        let machine = machine_with_user_and_host("deploy", "-oProxyCommand=touch /tmp/pwned");
        let result = run_ssh_on_machine_stdin(
            &machine,
            None,
            "true",
            b"",
            Some(&dir),
            std::time::Duration::from_secs(5),
        )
        .await;
        assert!(result.is_err(), "an exploit host must be refused");
        assert!(!marker.exists(), "ssh must NEVER have been spawned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scratch dir holding a fake `ssh` running `body` (the stdin helper's seam).
    fn fake_ssh_dir(tag: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("tosse-stdin-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("ssh");
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    /// The far side never reads its stdin (a `mkdir` stuck on a stale NFS home, a blackholed
    /// link): once the pipe fills, the payload write can't finish. The caller's `timeout` must
    /// still end the call — it used to start only AFTER the write, so this hung forever.
    #[tokio::test]
    async fn run_ssh_on_machine_stdin_times_out_while_the_payload_is_still_being_written() {
        let dir = fake_ssh_dir("never-reads", "exec sleep 30");
        let machine = machine_with_user_and_host("deploy", "example.com");
        let payload = vec![b'x'; 8 * 1024 * 1024];
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            run_ssh_on_machine_stdin(&machine, None, "true", &payload, Some(&dir), std::time::Duration::from_secs(1)),
        )
        .await
        .expect("the helper's own timeout must fire, not this outer guard");
        assert_eq!(result.err().as_deref(), Some("ssh command timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A remote command that prints a lot BEFORE reading its stdin: its output has to be drained
    /// while the payload is still going out, or both ends block on a full pipe.
    #[tokio::test]
    async fn run_ssh_on_machine_stdin_drains_output_while_writing_the_payload() {
        let dir = fake_ssh_dir("talks-first", "head -c 1048576 /dev/zero\nwc -c | tr -d ' ' >&2");
        let machine = machine_with_user_and_host("deploy", "example.com");
        let payload = vec![b'x'; 8 * 1024 * 1024];
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            run_ssh_on_machine_stdin_raw(&machine, None, "true", &payload, Some(&dir), std::time::Duration::from_secs(15)),
        )
        .await
        .expect("no deadlock between the payload write and the remote's output")
        .unwrap();
        assert_eq!(out.stdout.len(), 1_048_576);
        assert_eq!(out.stderr.trim(), (8 * 1024 * 1024).to_string(), "the whole payload arrived");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_candidates_folds_host_in_as_manual_when_not_already_discovered() {
        let discovered = vec![addr(AddressKind::Lan, "192.168.1.5")];
        let candidates = super::probe_candidates("my-typed-host", Some(discovered));
        assert!(
            candidates.iter().any(|c| c.value == "my-typed-host" && c.kind == AddressKind::Manual),
            "the confirmed host must always be tried even when it isn't a discovered candidate: {candidates:?}"
        );
        assert_eq!(candidates.len(), 2, "no duplicate entry for the same value");
    }

    #[test]
    fn probe_candidates_does_not_duplicate_a_host_already_among_the_discovered_ones() {
        let discovered = vec![addr(AddressKind::Tailscale, "box.tailnet.ts.net")];
        let candidates = super::probe_candidates("box.tailnet.ts.net", Some(discovered));
        assert_eq!(candidates.len(), 1, "host already present must not be duplicated as Manual");
    }

    #[test]
    fn probe_candidates_with_no_discovered_addresses_falls_back_to_the_typed_host() {
        let candidates = super::probe_candidates("my-typed-host", None);
        assert_eq!(candidates, vec![addr(AddressKind::Manual, "my-typed-host")]);
    }

    // ---- merge_address_candidates (B_lifecycle-#1) ----

    #[test]
    fn merge_address_candidates_keeps_new_first_and_appends_unseen_existing_ones() {
        let new = vec![addr(AddressKind::Manual, "1.2.3.4")];
        let existing = vec![
            addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            addr(AddressKind::Lan, "192.168.1.5"),
        ];
        let merged = super::merge_address_candidates(&new, &existing);
        assert_eq!(
            merged.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(),
            vec!["1.2.3.4", "box.tailnet.ts.net", "192.168.1.5"],
            "this attempt's own candidates lead; every OTHER address the machine has \
             ever recorded is still carried, not dropped",
        );
    }

    #[test]
    fn merge_address_candidates_does_not_duplicate_a_value_present_in_both() {
        let new = vec![addr(AddressKind::Manual, "1.2.3.4"), addr(AddressKind::Lan, "192.168.1.5")];
        let existing = vec![addr(AddressKind::Lan, "192.168.1.5")]; // same value, re-probed this time too
        let merged = super::merge_address_candidates(&new, &existing);
        assert_eq!(merged.len(), 2, "a value present in both lists must appear exactly once: {merged:?}");
    }

    #[test]
    fn merge_address_candidates_with_empty_existing_is_just_new() {
        let new = vec![addr(AddressKind::Manual, "1.2.3.4")];
        assert_eq!(super::merge_address_candidates(&new, &[]), new);
    }

    // ---- add_machine's ServerLocks claim (B_lifecycle review finding: `add_machine`
    // used to never claim the per-server lock at all, so the legacy/manual pairing
    // flow could interleave ssh writes with a `bootstrap_server`/`bootstrap_resume`/
    // `machine_repair` run already in flight against the exact same host) ----
    //
    // There is no Tauri mock-app test harness anywhere in this crate to invoke the
    // `#[tauri::command]` wrapper itself (the `tauri` dependency doesn't even enable
    // the `test` feature) — every other `ServerLocks`/`ServerLockGuard` test in
    // `bootstrap::orchestrator` exercises the same primitives directly rather than a
    // full command call, so this follows that same convention: it proves `add_machine`
    // computes the SAME lock key its three siblings do (see its body — this test
    // mirrors that exact call) and that a claim under that key collides as expected.
    #[test]
    fn add_machine_computes_the_same_lock_key_machine_repair_and_bootstrap_server_use() {
        use crate::bootstrap::orchestrator::{server_lock_key, ServerLockGuard, ServerLocks};

        let locks = Arc::new(ServerLocks::new());

        // machine_repair's own claim for an already-paired machine is keyed by its id.
        let repair_guard = ServerLockGuard::acquire(&locks, "m1".to_string(), "Repair: restart").unwrap();
        // add_machine converging on that SAME machine (an `existing` match) computes
        // the identical key — its own claim must collide, not silently proceed.
        let add_machine_key = server_lock_key(Some("m1"), "irrelevant-host", 22, "irrelevant-user");
        assert_eq!(add_machine_key, "m1");
        // Not `.unwrap_err()`: it requires the `Ok` side (`ServerLockGuard`) to
        // implement `Debug`, which it doesn't — same as every other test in
        // `orchestrator.rs` above that checks this via `.is_err()` instead.
        let err = ServerLockGuard::acquire(&locks, add_machine_key, "Add a server").err().unwrap();
        assert_eq!(err, "Repair: restart", "a concurrent add_machine must be told what's already running");
        drop(repair_guard);

        // A genuinely first-contact host: bootstrap_server's own claim is keyed by the
        // bare (host, port, user) triple — add_machine pairing the exact same triple
        // (no `existing` match yet) collides the same way.
        let bootstrap_key = server_lock_key(None, "fresh.example.com", 22, "deploy");
        let bootstrap_guard = ServerLockGuard::acquire(&locks, bootstrap_key, "Add a server").unwrap();
        let add_machine_key = server_lock_key(None, "fresh.example.com", 22, "deploy");
        assert!(
            ServerLockGuard::acquire(&locks, add_machine_key, "Add a server").is_err(),
            "add_machine pairing the exact same first-contact host bootstrap_server is already \
             installing onto must be refused, not race it",
        );
        drop(bootstrap_guard);
    }

    /// Regression for the confirm screen's "Discovered addresses — pick one" buttons
    /// (`ControlSection.tsx`, `onClick={() => setHost(a.value)}`): clicking a LOWER
    /// priority candidate (e.g. LAN) must not be silently outranked by a HIGHER
    /// priority one (Tailscale) the user did not pick. `host` must lead regardless of
    /// its kind's `address_probe_order` priority, and must keep its discovered kind.
    #[test]
    fn probe_candidates_confirmed_host_leads_over_a_higher_priority_candidate() {
        let discovered = vec![
            addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            addr(AddressKind::Lan, "192.168.1.5"),
        ];
        // The user clicked "LAN: 192.168.1.5" on the confirm screen.
        let candidates = super::probe_candidates("192.168.1.5", Some(discovered));
        assert_eq!(
            candidates,
            vec![
                addr(AddressKind::Lan, "192.168.1.5"),
                addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            ],
            "the user's explicit pick is probed (and, on success, persisted as machine.host) \
             first — the undiscovered-higher-priority Tailscale candidate only ever runs as \
             a fallback if the pick itself is unreachable",
        );
    }

    #[test]
    fn probe_candidates_puts_a_hand_typed_host_first_ahead_of_every_discovered_candidate() {
        let discovered = vec![
            addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            addr(AddressKind::Lan, "192.168.1.5"),
        ];
        let candidates = super::probe_candidates("my-typed-host", Some(discovered));
        assert_eq!(
            candidates,
            vec![
                addr(AddressKind::Manual, "my-typed-host"),
                addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
                addr(AddressKind::Lan, "192.168.1.5"),
            ],
        );
    }

    #[test]
    fn remote_target_addresses_is_never_empty_for_a_machine_with_zero_recorded_addresses() {
        let addresses = super::remote_target_addresses("h.example", Vec::new());
        assert_eq!(addresses, vec!["h.example".to_string()], "falls back to just the known-good host");
    }

    #[test]
    fn remote_target_addresses_keeps_host_first_and_dedupes() {
        let recorded = vec![
            addr(AddressKind::Tailscale, "box.tailnet.ts.net"),
            addr(AddressKind::Lan, "h.example"), // same value as `host`, different kind
            addr(AddressKind::Public, "1.2.3.4"),
        ];
        let addresses = super::remote_target_addresses("h.example", recorded);
        assert_eq!(
            addresses,
            vec!["h.example".to_string(), "box.tailnet.ts.net".to_string(), "1.2.3.4".to_string()],
            "host leads, the rest follow in probe-priority order, no duplicate of host",
        );
    }

    // ---- D6: fd_skip `--supports-skip` version gate --------------------------------

    #[test]
    fn should_request_skip_is_false_below_the_min_skip_version() {
        assert!(!super::should_request_skip(Some("flightdeckd 0.1.0")), "0.1.0 predates fd_skip");
    }

    #[test]
    fn should_request_skip_is_false_for_an_unparseable_version() {
        // Reads as 0.0.0 via `version_at_least`'s malformed-component fallback.
        assert!(!super::should_request_skip(Some("garbage")));
    }

    #[test]
    fn should_request_skip_is_false_on_a_probe_error() {
        // `None` is what `supports_skip_for_machine` passes on ANY probe
        // failure/timeout — must never speculatively opt in.
        assert!(!super::should_request_skip(None));
    }

    #[test]
    fn should_request_skip_is_true_at_and_above_the_min_skip_version() {
        assert!(super::should_request_skip(Some("flightdeckd 0.2.0")), "exactly the minimum");
        assert!(super::should_request_skip(Some("flightdeckd 0.3.1")), "newer than the minimum");
    }

    // ---- C9: `attach --title` version gate — shares D6's cached probe -------------

    #[test]
    fn should_request_title_is_false_below_the_min_title_version() {
        assert!(!super::should_request_title(Some("flightdeckd 0.1.9")), "0.1.9 predates --title");
    }

    #[test]
    fn should_request_title_is_false_on_a_probe_error() {
        assert!(!super::should_request_title(None), "must never speculatively opt in");
    }

    #[test]
    fn should_request_title_is_true_at_and_above_the_min_title_version() {
        assert!(super::should_request_title(Some("flightdeckd 0.2.0")), "exactly the minimum");
        assert!(super::should_request_title(Some("flightdeckd 0.3.1")), "newer than the minimum");
    }

    fn cache_test_machine(id: &str) -> MachineRecord {
        MachineRecord {
            id: id.into(),
            label: "t".into(),
            host: "example.invalid".into(),
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

    /// The generalised [`DAEMON_VERSION_CACHE`] serves BOTH gates from ONE cached
    /// probe (a cache HIT must never re-probe — seeded directly here rather than via
    /// a real ssh round trip, which this test has no network for anyway), and
    /// [`invalidate_daemon_version_cache`] genuinely removes the entry rather than,
    /// say, resetting it to a stale-but-present value.
    #[tokio::test]
    async fn daemon_version_cache_serves_both_gates_and_invalidate_clears_it() {
        let machine = cache_test_machine("m-cache-test-c9");
        DAEMON_VERSION_CACHE
            .lock()
            .unwrap()
            .insert(machine.id.clone(), Some("flightdeckd 0.2.0".to_string()));

        assert_eq!(
            daemon_version_for_machine(&machine, None).await.as_deref(),
            Some("flightdeckd 0.2.0"),
            "a cache hit must be served without a new probe",
        );
        assert!(supports_skip_for_machine(&machine, None).await);
        assert!(supports_title_for_machine(&machine, None).await);

        invalidate_daemon_version_cache(&machine.id);
        assert!(
            DAEMON_VERSION_CACHE.lock().unwrap().get(&machine.id).is_none(),
            "invalidate must remove the entry outright, not merely stale it",
        );

        // Cleanup: don't leak state into other tests sharing this process-wide cache.
        DAEMON_VERSION_CACHE.lock().unwrap().remove(&machine.id);
    }

    /// Invalidating a machine id the cache never held (or already forgot) is a
    /// harmless no-op — never panics.
    #[test]
    fn invalidate_daemon_version_cache_is_a_no_op_for_an_unknown_machine() {
        invalidate_daemon_version_cache("m-never-cached-c9");
    }

    /// The literal C9 gate scenario, end to end through the cache: a daemon below
    /// 0.2.0 (0.1.1) opts OUT of both `--supports-skip` and `--title`; exactly at
    /// 0.2.0 it opts INTO both — never one without the other, since they share the
    /// same cached probe and the same minimum version.
    #[tokio::test]
    async fn daemon_0_1_1_gates_both_flags_off_and_0_2_0_gates_both_on() {
        let old = cache_test_machine("m-gate-old-c9");
        DAEMON_VERSION_CACHE
            .lock()
            .unwrap()
            .insert(old.id.clone(), Some("flightdeckd 0.1.1".to_string()));
        assert!(!supports_skip_for_machine(&old, None).await);
        assert!(!supports_title_for_machine(&old, None).await);

        let new = cache_test_machine("m-gate-new-c9");
        DAEMON_VERSION_CACHE
            .lock()
            .unwrap()
            .insert(new.id.clone(), Some("flightdeckd 0.2.0".to_string()));
        assert!(supports_skip_for_machine(&new, None).await);
        assert!(supports_title_for_machine(&new, None).await);

        DAEMON_VERSION_CACHE.lock().unwrap().remove(&old.id);
        DAEMON_VERSION_CACHE.lock().unwrap().remove(&new.id);
    }

    // ---- Remote pairing: one dedicated key per server (A3) ------------------------

    /// A throwaway `ssh_keys/`-shaped dir, removed when dropped — lets tests spawn
    /// real `ssh-keygen` without touching the real app data dir.
    struct TempKeysDir(std::path::PathBuf);
    impl TempKeysDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("tosse-sshkeys-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempKeysDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// L17: the key directory is created owner-only — and a fresh mint inside an
    /// existing world-readable one narrows it too.
    #[tokio::test]
    async fn the_key_directory_is_created_and_kept_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let root = TempKeysDir::new("private-dir");
        let keys = root.path().join("ssh_keys");
        super::generate_or_reuse_pending_key(&keys, "server").await.unwrap();
        assert_eq!(mode(&keys), 0o700, "created owner-only");

        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o755)).unwrap();
        super::generate_or_reuse_pending_key(&keys, "server").await.unwrap();
        assert_eq!(mode(&keys), 0o700, "a looser existing directory is narrowed on the next use");
    }

    #[test]
    fn tightening_narrows_a_loose_directory_and_leaves_everything_else_alone() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
        let root = TempKeysDir::new("tighten");
        let dir = root.path().join("ssh_keys");
        assert!(!super::tighten_private_dir(&dir).unwrap(), "a missing directory is nothing to do");

        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(super::tighten_private_dir(&dir).unwrap());
        assert_eq!(mode(&dir), 0o700);
        assert!(!super::tighten_private_dir(&dir).unwrap(), "already private: unchanged");

        // A symlink is never chmod'ed through: its target keeps its own mode.
        let target = root.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.path().join("linked_keys");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(!super::tighten_private_dir(&link).unwrap());
        assert_eq!(mode(&target), 0o755);
    }

    #[tokio::test]
    async fn generate_machine_key_reuses_the_same_pending_pair() {
        let dir = TempKeysDir::new("reuse");
        let first = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();
        let second = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();
        assert_eq!(first.public_key, second.public_key, "the SAME pending pair must come back");
        assert_eq!(first.identity_file, second.identity_file);

        let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(entries.len(), 2, "exactly one key pair (private + .pub), not one per call");
    }

    /// Two concurrent callers (e.g. a double click on "+ Add a server") must not race
    /// `ssh-keygen -f pending` into an "overwrite?" prompt nobody answers (a hang) —
    /// `PENDING_KEY_LOCK` serializes them, and both still see the SAME result.
    #[tokio::test]
    async fn generate_machine_key_concurrent_calls_do_not_race() {
        let dir = TempKeysDir::new("concurrent");
        let (a, b) = tokio::join!(
            super::generate_or_reuse_pending_key(dir.path(), "server"),
            super::generate_or_reuse_pending_key(dir.path(), "server"),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.public_key, b.public_key, "both callers must see the same pending pair");
        assert_eq!(a.identity_file, b.identity_file);
    }

    #[tokio::test]
    async fn add_machine_success_claims_pending_and_frees_a_fresh_slot() {
        let dir = TempKeysDir::new("claim");
        let pending = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();

        let claimed = super::claim_pending_key(dir.path(), Some(pending.identity_file.clone()), "machine-1")
            .unwrap()
            .expect("a pending identity_file must be claimed, not passed through as None");
        assert!(claimed.ends_with("machine-1"), "renamed to the machine id: {claimed}");
        assert!(std::path::Path::new(&claimed).exists());
        assert!(std::path::Path::new(&format!("{claimed}.pub")).exists());
        assert!(!std::path::Path::new(&pending.identity_file).exists(), "pending must be GONE, not copied");

        // The next generate_machine_key call (for a SECOND server) must mint a FRESH
        // pending pair — not resurrect the one just claimed.
        let fresh = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();
        assert_eq!(fresh.identity_file, pending.identity_file, "same fixed pending path");
        assert_ne!(fresh.public_key, pending.public_key, "but a DIFFERENT (fresh) key");
    }

    /// Two `add_machine` calls that both won a race to reach the claim step with the
    /// SAME still-pending key (e.g. the same pairing command pasted onto two boxes and
    /// paired nearly simultaneously) must not surface a raw OS error to the loser —
    /// `claim_pending_key_locked` serializes the rename via `PENDING_KEY_LOCK` and maps
    /// a lost race onto the SAME friendly "already used" message
    /// `stale_identity_file_error` produces for a statically-stale path.
    #[tokio::test]
    async fn claim_pending_key_locked_concurrent_claims_the_loser_gets_the_friendly_message() {
        let dir = TempKeysDir::new("claim-race");
        let pending = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();

        let (a, b) = tokio::join!(
            super::claim_pending_key_locked(
                dir.path(),
                Some(pending.identity_file.clone()),
                "machine-a"
            ),
            super::claim_pending_key_locked(
                dir.path(),
                Some(pending.identity_file.clone()),
                "machine-b"
            ),
        );

        let oks = [&a, &b].into_iter().filter(|r| r.is_ok()).count();
        let errs: Vec<&String> = [&a, &b].into_iter().filter_map(|r| r.as_ref().err()).collect();
        assert_eq!(oks, 1, "exactly one of the two racing claims should win the rename");
        assert_eq!(errs.len(), 1, "the other must fail");
        assert_eq!(
            errs[0], super::PENDING_KEY_ALREADY_USED_MSG,
            "the loser must get the SAME friendly message as a statically-stale path, not a raw OS error"
        );
    }

    /// The "Connect an existing server" form and the installer wizard each have their
    /// own slot: a wizard still holding the shared pending key (InstallKey done,
    /// AddMachine not yet) can never be handed the same file by the form.
    #[tokio::test]
    async fn the_connect_form_and_the_wizard_hold_distinct_pending_keys() {
        let dir = TempKeysDir::new("slots");
        let wizard = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();
        let connect = super::generate_or_reuse_connect_key(dir.path(), "server").await.unwrap();
        assert_ne!(wizard.identity_file, connect.identity_file);
        assert_ne!(wizard.public_key, connect.public_key);
        assert!(connect.identity_file.ends_with("pending-connect"), "{}", connect.identity_file);

        let again = super::generate_or_reuse_connect_key(dir.path(), "server").await.unwrap();
        assert_eq!(again.public_key, connect.public_key, "the form's slot is reused until claimed, like the wizard's");
    }

    #[tokio::test]
    async fn both_pending_slots_are_claimable_and_nothing_else_is_renamed() {
        let dir = TempKeysDir::new("claim-slots");
        let wizard = super::generate_or_reuse_pending_key(dir.path(), "server").await.unwrap();
        let connect = super::generate_or_reuse_connect_key(dir.path(), "server").await.unwrap();

        let claimed_connect =
            super::claim_pending_key_locked(dir.path(), Some(connect.identity_file.clone()), "machine-c").await.unwrap();
        assert_eq!(claimed_connect.as_deref(), Some(dir.path().join("machine-c").to_str().unwrap()));
        assert!(!std::path::Path::new(&connect.identity_file).exists());
        assert!(dir.path().join("machine-c.pub").exists());
        assert!(std::path::Path::new(&wizard.identity_file).exists(), "the wizard's slot is untouched");

        let claimed_wizard =
            super::claim_pending_key_locked(dir.path(), Some(wizard.identity_file.clone()), "machine-w").await.unwrap();
        assert_eq!(claimed_wizard.as_deref(), Some(dir.path().join("machine-w").to_str().unwrap()));

        // A key already claimed by a machine is not a slot: passed through, never moved.
        let already = dir.path().join("machine-c").to_string_lossy().into_owned();
        assert_eq!(super::claim_pending_key(dir.path(), Some(already.clone()), "machine-x").unwrap(), Some(already));
        assert!(dir.path().join("machine-c").exists());
    }

    #[test]
    fn a_used_connect_key_names_the_forms_own_way_to_a_fresh_one() {
        let dir = TempKeysDir::new("stale-connect");
        let gone = dir.path().join("pending-connect").to_string_lossy().into_owned();
        let msg = super::stale_identity_file_error(&Some(gone)).expect("a claimed slot is stale");
        assert!(msg.contains("already been used") && msg.contains("Connect an existing server"), "{msg}");
        // Nothing records who claimed it, and it is often the SAME server (a cancelled
        // attempt that landed): never "another server", and say what to check first.
        assert!(!msg.contains("another server"), "{msg}");
        assert!(msg.contains("if that server is now listed, you're done"), "{msg}");
        let gone_wizard = dir.path().join("pending").to_string_lossy().into_owned();
        assert_eq!(super::stale_identity_file_error(&Some(gone_wizard)).as_deref(), Some(super::PENDING_KEY_ALREADY_USED_MSG));
    }

    // ---- add_machine: re-connecting a listed server keeps what the caller left out ----

    #[test]
    fn identities_to_try_puts_a_matched_servers_flight_deck_key_before_this_macs_keys() {
        assert_eq!(super::identities_to_try(None, None), vec![None], "a new server: this Mac's keys only");
        assert_eq!(
            super::identities_to_try(None, Some("/keys/m1")),
            vec![Some("/keys/m1".to_string()), None],
            "the existing Flight Deck key first, this Mac's keys only if it fails"
        );
        assert_eq!(
            super::identities_to_try(Some("/keys/pending-connect"), Some("/keys/m1")),
            vec![Some("/keys/pending-connect".to_string())],
            "a key the caller chose is the only one tried"
        );
    }

    #[test]
    fn existing_flight_deck_key_is_only_a_key_flight_deck_minted() {
        let dir = TempKeysDir::new("existing-key");
        let ours = dir.path().join("machine-1");
        std::fs::write(&ours, "priv").unwrap();
        let elsewhere = TempKeysDir::new("existing-key-user");
        let users_own = elsewhere.path().join("id_ed25519");
        std::fs::write(&users_own, "priv").unwrap();
        let machine = |identity: Option<&std::path::Path>| crate::store::MachineRecord {
            id: "machine-1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 22,
            user: "agent".into(),
            identity_file: identity.map(|p| p.to_string_lossy().into_owned()),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };

        let ours_str = ours.to_string_lossy().into_owned();
        assert_eq!(super::existing_flight_deck_key(Some(&machine(Some(&ours))), dir.path()), Some(ours_str));
        assert_eq!(super::existing_flight_deck_key(Some(&machine(Some(&users_own))), dir.path()), None, "the user's own key");
        assert_eq!(
            super::existing_flight_deck_key(Some(&machine(Some(&dir.path().join("gone")))), dir.path()),
            None,
            "a key file that no longer exists"
        );
        assert_eq!(super::existing_flight_deck_key(Some(&machine(None)), dir.path()), None);
        assert_eq!(super::existing_flight_deck_key(None, dir.path()), None, "a new server");
    }

    #[test]
    fn previous_key_dropped_only_when_a_flight_deck_key_is_no_longer_used() {
        assert!(!super::previous_key_dropped(Some("/keys/m1"), Some("/keys/m1")), "the old key still works");
        assert!(super::previous_key_dropped(Some("/keys/m1"), None), "saved with this Mac's keys instead");
        assert!(super::previous_key_dropped(Some("/keys/m1"), Some("/keys/pending-connect")), "replaced by a new key");
        assert!(!super::previous_key_dropped(None, None), "there was no Flight Deck key to drop");
        assert!(!super::previous_key_dropped(None, Some("/keys/pending-connect")));
    }

    #[test]
    fn machine_label_keeps_a_matched_servers_name_when_none_is_typed() {
        assert_eq!(super::machine_label("  Studio Mac ", Some("Old"), "100.1.2.3"), "Studio Mac");
        assert_eq!(super::machine_label("", Some("Studio Mac"), "100.1.2.3"), "Studio Mac");
        assert_eq!(super::machine_label("   ", Some("Studio Mac"), "100.1.2.3"), "Studio Mac");
        assert_eq!(super::machine_label("", None, "100.1.2.3"), "100.1.2.3", "a new server is named after its address");
    }

    /// Real OpenSSH_10.3 stderr for a key refused by a server's `MaxAuthTries` (2, with
    /// four keys offered): the reason, then a `Disconnected from` trailer.
    const TOO_MANY_AUTH_FAILURES_STDERR: &str = "Warning: Permanently added '[127.0.0.1]:22999' (ED25519) to the list of known hosts.\n\
         Received disconnect from 127.0.0.1 port 22999:2: Too many authentication failures\n\
         Disconnected from 127.0.0.1 port 22999\n";

    /// Regression: only ssh's LAST stderr line was kept — `Disconnected from …`, which
    /// says nothing — so a refusal by `MaxAuthTries` read as an unreachable server.
    #[test]
    fn a_probe_error_keeps_the_disconnect_reason_over_openssh_s_trailer() {
        let err = super::parse_probe_output("", TOO_MANY_AUTH_FAILURES_STDERR, false).expect_err("ssh failed");
        assert_eq!(
            err,
            "Could not connect over SSH: Received disconnect from 127.0.0.1 port 22999:2: Too many authentication failures"
        );
        assert!(crate::ssh_link::is_key_refusal_text(&err));

        // Any other last line is kept as it was.
        let err = super::parse_probe_output("", "ssh: connect to host h port 22: Operation timed out\n", false).unwrap_err();
        assert_eq!(err, "Could not connect over SSH: ssh: connect to host h port 22: Operation timed out");
        let err = super::parse_probe_output("", "Connection closed by 1.2.3.4 port 22\n", false).unwrap_err();
        assert_eq!(err, "Could not connect over SSH: Connection closed by 1.2.3.4 port 22");
    }

    /// A probe double for `first_working_login`: answers per `(host, identity)` from
    /// `answers` (unlisted pairs time out) and records every call it gets.
    fn scripted_probe<'a>(
        answers: Vec<((&'static str, Option<&'static str>), Result<super::RemoteProbeResult, String>)>,
        calls: &'a std::cell::RefCell<Vec<(String, Option<String>)>>,
    ) -> impl FnMut(String, Option<String>) -> std::future::Ready<Result<super::RemoteProbeResult, String>> + 'a {
        move |host, identity| {
            calls.borrow_mut().push((host.clone(), identity.clone()));
            let answer = answers
                .iter()
                .find(|((h, i), _)| *h == host && i.map(str::to_string) == identity)
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| Err("ssh command timed out".to_string()));
            std::future::ready(answer)
        }
    }

    fn ready_probe() -> super::RemoteProbeResult {
        super::parse_probe_output("FLIGHTDECK_CLAUDE_VERSION:2.1.0\nFLIGHTDECK_DAEMON_VERSION:flightdeckd 9.9.9\n", "", true)
            .expect("a healthy probe")
    }

    fn candidates(hosts: &[&str]) -> Vec<super::AddressCandidate> {
        hosts
            .iter()
            .map(|h| super::AddressCandidate { kind: super::AddressKind::Manual, value: h.to_string() })
            .collect()
    }

    const REFUSED: &str = "Could not connect over SSH: admin@h: Permission denied (publickey).";

    /// Regression: re-connecting an offline server that has a Flight Deck key used to
    /// wait one ssh timeout per address with that key, then another with this Mac's
    /// keys — which can't reach it either. They're only tried where the key was refused.
    #[tokio::test]
    async fn first_working_login_skips_this_macs_keys_when_the_saved_key_was_never_refused() {
        let calls = std::cell::RefCell::new(Vec::new());
        let identities = super::identities_to_try(None, Some("/keys/m1"));
        let err = super::first_working_login(&identities, &candidates(&["a", "b"]), scripted_probe(vec![], &calls))
            .await
            .expect_err("an offline server");
        assert_eq!(
            *calls.borrow(),
            vec![("a".to_string(), Some("/keys/m1".to_string())), ("b".to_string(), Some("/keys/m1".to_string()))],
            "one probe per address, with the saved key only"
        );
        assert!(err.contains("a with Flight Deck's saved key: ssh command timed out"), "{err}");
        assert!(err.contains("This Mac's SSH keys were not tried"), "the skipped fallback is said: {err}");
    }

    #[tokio::test]
    async fn first_working_login_falls_back_to_this_macs_keys_only_where_the_saved_key_was_refused() {
        let calls = std::cell::RefCell::new(Vec::new());
        let identities = super::identities_to_try(None, Some("/keys/m1"));
        let probe = scripted_probe(
            vec![(("b", Some("/keys/m1")), Err(REFUSED.to_string())), (("b", None), Ok(ready_probe()))],
            &calls,
        );
        let working = super::first_working_login(&identities, &candidates(&["a", "b"]), probe).await;
        assert_eq!(working, Ok(("b".to_string(), None)));
        assert_eq!(
            *calls.borrow(),
            vec![
                ("a".to_string(), Some("/keys/m1".to_string())),
                ("b".to_string(), Some("/keys/m1".to_string())),
                ("b".to_string(), None),
            ],
            "the unreachable address is never re-probed with this Mac's keys"
        );
    }

    /// Regression: a saved key refused by the server's `MaxAuthTries` (ssh's real
    /// two-line output, ending on `Disconnected from …`) used to read as "not refused",
    /// so this Mac's keys were never tried — and the error claimed it didn't refuse.
    #[tokio::test]
    async fn first_working_login_falls_back_after_too_many_authentication_failures() {
        let calls = std::cell::RefCell::new(Vec::new());
        let identities = super::identities_to_try(None, Some("/keys/m1"));
        let refused = super::parse_probe_output("", TOO_MANY_AUTH_FAILURES_STDERR, false).unwrap_err();
        let probe =
            scripted_probe(vec![(("a", Some("/keys/m1")), Err(refused)), (("a", None), Ok(ready_probe()))], &calls);
        let working = super::first_working_login(&identities, &candidates(&["a"]), probe).await;
        assert_eq!(working, Ok(("a".to_string(), None)));
    }

    #[tokio::test]
    async fn first_working_login_names_both_identities_when_both_were_refused() {
        let calls = std::cell::RefCell::new(Vec::new());
        let identities = super::identities_to_try(None, Some("/keys/m1"));
        let probe = scripted_probe(
            vec![(("a", Some("/keys/m1")), Err(REFUSED.to_string())), (("a", None), Err(REFUSED.to_string()))],
            &calls,
        );
        let err = super::first_working_login(&identities, &candidates(&["a"]), probe).await.expect_err("refused twice");
        assert!(err.contains("a with Flight Deck's saved key: ") && err.contains("a with this Mac's SSH keys: "), "{err}");
        assert!(!err.contains("were not tried"), "{err}");
    }

    #[tokio::test]
    async fn first_working_login_with_one_identity_keeps_the_untagged_error() {
        let calls = std::cell::RefCell::new(Vec::new());
        let err = super::first_working_login(&[None], &candidates(&["a"]), scripted_probe(vec![], &calls))
            .await
            .expect_err("offline");
        assert_eq!(err, "Could not pair — every address failed. a: ssh command timed out");
        assert_eq!(calls.borrow().len(), 1);
    }

    // ---- add_machine checks the host key before any keyed connection (audit
    // sec-hostkey#4) ----

    /// [`add_machine`]'s gate then probe, as it runs them.
    async fn confirmed_working_login(
        known_hosts: &str,
        port: u16,
        user: &str,
        identities: &[Option<String>],
        candidates: &[super::AddressCandidate],
        confirmed_host_key: Option<&str>,
        paired_machines: &[MachineRecord],
    ) -> Result<(String, Option<String>), String> {
        let gated =
            super::gate_candidates(known_hosts, port, user, candidates, confirmed_host_key, paired_machines).await;
        super::login_over_gated(known_hosts, port, user, identities, &gated).await
    }

    // ---- add_machine folds onto a listed server only when the server reached is that
    // one (audit sec-trust-boundary#3) ----

    /// "studio" was paired at studio.ts.net and also recorded a LAN address
    /// (203.0.113.9 here — what the fake answers on). On another network, "lab" answers
    /// at that address (same user): the shared address literal matched studio, and the
    /// pairing overwrote studio's record and Flight Deck key and re-homed its
    /// conversations onto lab. A server is updated only when it presents the host key
    /// saved for that server's own address.
    #[tokio::test]
    async fn add_machine_does_not_fold_a_different_server_sharing_an_address() {
        use crate::bootstrap::connect::first_contact_fake::{FirstContactSsh, FIRST_CONTACT_FP};
        let fake = FirstContactSsh::install();
        // studio's own key, saved under its working address.
        const STUDIO_BLOB: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIGQn4iO0v6TSOXZ4/XheXm1CKcHaPA3KWoEBFM/Q1GKt";
        std::fs::write(fake.known_hosts(), format!("studio.ts.net ssh-ed25519 {STUDIO_BLOB}\n")).unwrap();
        let studio = MachineRecord {
            host: "studio.ts.net".into(),
            addresses: vec![super::AddressCandidate { kind: super::AddressKind::Lan, value: "203.0.113.9".into() }],
            ..cache_test_machine("studio")
        };

        // lab, confirmed by the user at 192.168.1.20 (the fake presents its key).
        let gated = super::gate_candidates(
            &fake.known_hosts(),
            22,
            "u",
            &candidates(&["203.0.113.9"]),
            Some(FIRST_CONTACT_FP),
            &[studio.clone()],
        )
        .await;
        assert_eq!(gated.fingerprints(), vec![FIRST_CONTACT_FP.to_string()]);
        let folded = super::converge_on_existing(&fake.known_hosts(), Some(studio.clone()), &gated).await.unwrap();
        assert!(folded.is_none(), "another server sharing an address is paired as a new one");

        // studio itself, reached at its own address: still converges.
        let mut at_home = studio.clone();
        at_home.host = "203.0.113.9".into();
        let folded = super::converge_on_existing(&fake.known_hosts(), Some(at_home.clone()), &gated).await.unwrap();
        assert_eq!(folded.map(|m| m.id), Some("studio".to_string()), "the key saved for its own address proves it");
    }

    #[test]
    fn same_server_by_host_key_needs_every_reached_key_saved_for_it() {
        let saved = vec!["SHA256:a".to_string(), "SHA256:b".to_string()];
        assert!(super::same_server_by_host_key(&saved, &["SHA256:a".to_string()]));
        assert!(super::same_server_by_host_key(&saved, &["SHA256:a".to_string(), "SHA256:b".to_string()]));
        assert!(!super::same_server_by_host_key(&saved, &["SHA256:a".to_string(), "SHA256:c".to_string()]));
        assert!(!super::same_server_by_host_key(&saved, &[]), "nothing reached proves nothing");
        assert!(!super::same_server_by_host_key(&[], &["SHA256:a".to_string()]));
    }

    /// "Connect an existing server" probed over `accept-new` with no check, so the first
    /// keyed connection pinned whatever answered — offering every key of this Mac's
    /// agent on the way — and the sudo passwords, sign-in codes and phone keys sent to
    /// that server later all went to a key the user never saw. Now the key is read with
    /// nothing sent, and nothing keyed runs until its fingerprint is confirmed.
    #[tokio::test]
    async fn add_machine_refuses_an_unconfirmed_first_contact_before_any_keyed_probe() {
        use crate::bootstrap::connect::first_contact_fake::{FirstContactSsh, FIRST_CONTACT_FP};
        let fake = FirstContactSsh::install();
        let err = confirmed_working_login(
            &fake.known_hosts(),
            22,
            "u",
            &[None],
            &candidates(&["203.0.113.9"]),
            None,
            &[],
        )
        .await
        .expect_err("an unconfirmed first contact must not be paired");
        assert!(err.contains(FIRST_CONTACT_FP), "the fingerprint to check is named: {err}");
        assert!(err.contains("has not been confirmed"), "{err}");
        assert_eq!(fake.calls(), vec!["SCAN".to_string()], "no keyed connection before the user confirms");
        assert!(!Path::new(&fake.known_hosts()).exists(), "nothing pinned");
    }

    /// Confirmed: pinned first, then probed strictly against it. A paired server's own
    /// address goes straight on, and a fingerprint other than the one presented refuses.
    #[tokio::test]
    async fn add_machine_pins_the_confirmed_key_and_trusts_a_paired_servers_own() {
        use crate::bootstrap::connect::first_contact_fake::{FirstContactSsh, FIRST_CONTACT_BLOB, FIRST_CONTACT_FP};
        let fake = FirstContactSsh::install();
        let err = confirmed_working_login(
            &fake.known_hosts(),
            22,
            "u",
            &[None],
            &candidates(&["203.0.113.9"]),
            Some(FIRST_CONTACT_FP),
            &[],
        )
        .await
        .expect_err("the fake refuses every key");
        assert!(err.contains("Permission denied"), "{err}");
        assert_eq!(fake.calls(), vec!["SCAN".to_string(), "KEYED".to_string()]);
        assert!(std::fs::read_to_string(fake.known_hosts()).unwrap().contains(FIRST_CONTACT_BLOB));

        let paired = vec![MachineRecord { host: "203.0.113.9".into(), ..cache_test_machine("m1") }];
        confirmed_working_login(&fake.known_hosts(), 22, "u", &[None], &candidates(&["203.0.113.9"]), None, &paired)
            .await
            .expect_err("the fake refuses every key");
        assert_eq!(fake.calls().last().map(String::as_str), Some("KEYED"), "a paired server's key needs no check");

        let other = confirmed_working_login(
            &fake.known_hosts(),
            22,
            "u",
            &[None],
            &candidates(&["203.0.113.9"]),
            Some("SHA256:someOtherKey"),
            &[],
        )
        .await
        .expect_err("another key than the one presented");
        assert!(other.contains("not the SHA256:someOtherKey you confirmed"), "{other}");
    }

    #[test]
    fn claim_pending_key_passes_through_a_non_pending_identity_file_unchanged() {
        let dir = TempKeysDir::new("passthrough");
        let custom = dir.path().join("my-custom-key");
        std::fs::write(&custom, "not a real key, just a marker").unwrap();

        let custom_str = custom.to_string_lossy().into_owned();
        let out = super::claim_pending_key(dir.path(), Some(custom_str.clone()), "machine-1").unwrap();
        assert_eq!(out, Some(custom_str), "a non-pending identity_file must not be touched");
        assert!(custom.exists(), "and certainly not moved");

        let none_out = super::claim_pending_key(dir.path(), None, "machine-1").unwrap();
        assert_eq!(none_out, None, "no identity_file (default SSH key/agent) stays None");
    }

    #[test]
    fn stale_identity_file_error_only_fires_on_a_missing_path() {
        assert!(
            super::stale_identity_file_error(&None).is_none(),
            "no identity_file (default key/agent) is never stale"
        );

        let dir = TempKeysDir::new("stale");
        let real = dir.path().join("real-key");
        std::fs::write(&real, "x").unwrap();
        assert!(
            super::stale_identity_file_error(&Some(real.to_string_lossy().into_owned())).is_none(),
            "an existing identity_file passes"
        );

        let gone = dir.path().join("already-claimed-by-someone-else");
        let msg = super::stale_identity_file_error(&Some(gone.to_string_lossy().into_owned()))
            .expect("a nonexistent identity_file must be flagged");
        assert!(msg.contains("already used"), "must name the specific cause: {msg}");
    }

    #[test]
    fn delete_machine_and_key_removes_both_key_files() {
        let dir = TempKeysDir::new("delete");
        let key = dir.path().join("machine-1");
        std::fs::write(&key, "priv").unwrap();
        std::fs::write(format!("{}.pub", key.display()), "pub").unwrap();

        let store = Store::open_in_memory().unwrap();
        store
            .upsert_machine(&crate::store::MachineRecord {
                id: "machine-1".into(),
                label: "vps".into(),
                host: "h.example".into(),
                port: 22,
                user: "agent".into(),
                identity_file: Some(key.to_string_lossy().into_owned()),
                added_at: 1,
                addresses: Vec::new(),
                daemon_mac_id: None,
                daemon_relay_url: None,
                daemon_label: None,
                phone_provisioned_at: None,
            })
            .unwrap();

        super::delete_machine_and_key(&store, Some(dir.path()), "machine-1").unwrap();
        assert!(!key.exists(), "private key removed");
        assert!(!std::path::Path::new(&format!("{}.pub", key.display())).exists(), "public key removed");
        assert!(store.machine_by_id("machine-1").unwrap().is_none(), "record gone too");
    }

    /// A server added with the user's OWN key file (any path outside Flight Deck's
    /// `ssh_keys` dir) must never take that key with it when it is removed.
    #[test]
    fn delete_machine_and_key_never_deletes_a_key_outside_the_apps_key_dir() {
        let app_keys = TempKeysDir::new("delete-owned");
        let users_ssh = TempKeysDir::new("delete-foreign");
        let key = users_ssh.path().join("id_ed25519");
        std::fs::write(&key, "priv").unwrap();
        std::fs::write(format!("{}.pub", key.display()), "pub").unwrap();
        // Also a `..` path that only LOOKS like it is inside the app's dir.
        let sneaky = format!("{}/../{}/id_ed25519", app_keys.path().display(), users_ssh.path().file_name().unwrap().to_string_lossy());

        let store = Store::open_in_memory().unwrap();
        for (id, identity) in [("own-key", key.to_string_lossy().into_owned()), ("sneaky", sneaky)] {
            store
                .upsert_machine(&crate::store::MachineRecord {
                    id: id.into(),
                    label: "mac".into(),
                    host: format!("{id}.example"),
                    port: 22,
                    user: "admin".into(),
                    identity_file: Some(identity),
                    added_at: 1,
                    addresses: Vec::new(),
                    daemon_mac_id: None,
                    daemon_relay_url: None,
                    daemon_label: None,
                    phone_provisioned_at: None,
                })
                .unwrap();
            super::delete_machine_and_key(&store, Some(app_keys.path()), id).unwrap();
            assert!(store.machine_by_id(id).unwrap().is_none(), "the record still goes");
        }
        assert!(key.exists(), "the user's private key survives");
        assert!(std::path::Path::new(&format!("{}.pub", key.display())).exists(), "and its .pub");
    }

    #[test]
    fn delete_machine_and_key_is_a_harmless_noop_without_an_identity_file() {
        let store = Store::open_in_memory().unwrap();
        store
            .upsert_machine(&crate::store::MachineRecord {
                id: "machine-2".into(),
                label: "vps".into(),
                host: "h.example".into(),
                port: 22,
                user: "agent".into(),
                identity_file: None,
                added_at: 1,
                addresses: Vec::new(),
                daemon_mac_id: None,
                daemon_relay_url: None,
                daemon_label: None,
                phone_provisioned_at: None,
            })
            .unwrap();
        // Must not panic when there is no key to clean up.
        super::delete_machine_and_key(&store, None, "machine-2").unwrap();

        // Nor when the record doesn't even exist (already-deleted / bad id).
        super::delete_machine_and_key(&store, None, "no-such-machine").unwrap();
    }

    // ---- delete_machine_core: revoke-before-delete (C10 hook (c)) -------------

    fn provisioned_machine(id: &str) -> crate::store::MachineRecord {
        crate::store::MachineRecord {
            id: id.into(),
            label: id.into(),
            host: "127.0.0.1".into(),
            port: 22,
            user: "tester".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: Some(1),
        }
    }

    /// The ordering half of C10 hook (c): `flightdeckd remove-phone` runs with
    /// the machine's own connection details BEFORE the local row is deleted —
    /// provable because `delete_machine_core` only reaches the revoke round trip
    /// through `store.machine_by_id(id)`, which is impossible once
    /// `delete_machine_and_key` has already removed that row. The token rides on
    /// stdin only, never argv.
    fn test_locks() -> Arc<crate::bootstrap::orchestrator::ServerLocks> {
        Arc::new(crate::bootstrap::orchestrator::ServerLocks::default())
    }

    /// Audit sec-keys#2: removing a server while a re-connect, a bootstrap re-run or a
    /// repair of it runs used to go ahead (it claimed no lock), deleting the row and the
    /// key under the other operation — which then re-created the row with a key file
    /// that no longer existed, or saw the server it just re-added vanish. The removal is
    /// refused instead, with nothing touched.
    #[tokio::test]
    async fn delete_machine_core_refuses_while_the_server_lock_is_held() {
        let keys = TempKeysDir::new("delete-locked");
        let key = keys.path().join("m1");
        std::fs::write(&key, "private").unwrap();
        std::fs::write(keys.path().join("m1.pub"), "public").unwrap();
        let store = Store::open_in_memory().unwrap();
        let mut machine = provisioned_machine("m1");
        machine.identity_file = Some(key.to_string_lossy().into_owned());
        store.upsert_machine(&machine).unwrap();

        let locks = test_locks();
        let held = crate::bootstrap::orchestrator::ServerLockGuard::acquire(&locks, "m1".into(), "Add a server").unwrap();
        let err = super::delete_machine_core(&store, &locks, None, Some(keys.path()), "m1")
            .await
            .expect_err("a server another operation is working on is not removed under it");
        assert!(err.contains("already running on this server") && err.contains("Add a server"), "{err}");
        assert!(store.machine_by_id("m1").unwrap().is_some(), "the row stays");
        assert!(key.exists(), "the key stays");

        // Once that operation is over, the removal goes through — and holds the lock
        // while it does, so nothing else can start on the server meanwhile.
        drop(held);
        super::delete_machine_core(&store, &locks, None, Some(keys.path()), "m1").await.unwrap();
        assert!(store.machine_by_id("m1").unwrap().is_none());
        assert!(
            crate::bootstrap::orchestrator::ServerLockGuard::acquire(&locks, "m1".into(), "Add a server").is_ok(),
            "released at the end"
        );
    }

    /// The other interleave of sec-keys#2: a pairing that converged on a listed server
    /// which was removed before it saved is refused, not re-created; a new one inserts.
    #[test]
    fn save_paired_machine_refuses_a_server_removed_meanwhile() {
        let store = Store::open_in_memory().unwrap();
        let machine = provisioned_machine("m1");
        let err = super::save_paired_machine(&store, &machine, true).expect_err("removed meanwhile");
        assert!(err.contains("was removed while it was being connected"), "{err}");
        assert!(store.machine_by_id("m1").unwrap().is_none(), "not re-created");
        super::save_paired_machine(&store, &machine, false).unwrap();
        assert!(store.machine_by_id("m1").unwrap().is_some());
        super::save_paired_machine(&store, &machine, true).unwrap();
    }

    #[tokio::test]
    async fn delete_machine_core_revokes_before_deleting_and_never_leaks_the_token_to_argv() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("delete-ok");
        let argv_log = std::env::temp_dir().join(format!("fakessh-argv-{}", uuid::Uuid::new_v4()));
        let stdin_log = std::env::temp_dir().join(format!("fakessh-stdin-{}", uuid::Uuid::new_v4()));
        std::env::set_var("FAKE_SSH_ARGV_LOG", &argv_log);
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&provisioned_machine("m1")).unwrap();
        store.set_config("remote_phone_token", "super-secret-phone-token").unwrap();
        store.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use

        let removal = super::delete_machine_core(&store, &test_locks(), None, None, "m1").await.unwrap();
        assert_eq!(
            removal,
            super::MachineRemoval {
                phone_revoke: Some(crate::appmcp::provision::RevokeOutcome::Removed),
                retry_pending: false,
                devices_unconfirmed: 0
            }
        );

        assert!(store.machine_by_id("m1").unwrap().is_none(), "the local row must be gone");
        assert!(store.removed_server_revocations().unwrap().is_empty(), "confirmed: nothing left to retry");
        let stdin = std::fs::read_to_string(&stdin_log).unwrap();
        assert_eq!(stdin, "super-secret-phone-token", "the token must have been delivered on stdin");
        let argv = std::fs::read_to_string(&argv_log).unwrap();
        assert!(
            !argv.contains("super-secret-phone-token"),
            "the token must NEVER appear in argv: {argv}"
        );
        assert!(argv.contains("remove-phone --token -"), "argv: {argv}");

        std::fs::remove_file(&argv_log).ok();
        std::fs::remove_file(&stdin_log).ok();
    }

    /// The independent-failure half of C10 hook (c), made durable (M10): an
    /// unreachable daemon at delete time must NOT block the local delete — but the
    /// revocation is no longer queued and dropped with the row in the same call: it is
    /// reported, kept as a tombstone with the removed record (older queued tokens
    /// too), and the server's own key file stays on disk to reach it again.
    #[tokio::test]
    async fn delete_machine_core_reports_and_keeps_an_unconfirmed_revocation() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("delete-unreachable");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "255");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", "");
        let keys = TempKeysDir::new("delete-unreachable");
        let key = keys.path().join("m1");
        std::fs::write(&key, "private").unwrap();
        std::fs::write(keys.path().join("m1.pub"), "public").unwrap();

        let store = Store::open_in_memory().unwrap();
        let mut machine = provisioned_machine("m1");
        machine.identity_file = Some(key.to_string_lossy().into_owned());
        store.upsert_machine(&machine).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();
        store.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use
        store.queue_daemon_phone_revocation("m1", "older", 1).unwrap();

        let removal = super::delete_machine_core(&store, &test_locks(), None, Some(keys.path()), "m1").await.unwrap();
        assert_eq!(
            removal,
            super::MachineRemoval {
                phone_revoke: Some(crate::appmcp::provision::RevokeOutcome::Queued),
                retry_pending: true,
                devices_unconfirmed: 0
            }
        );
        assert!(store.machine_by_id("m1").unwrap().is_none(), "delete must proceed regardless");
        let tombstones = store.removed_server_revocations().unwrap();
        assert_eq!(tombstones.iter().map(|t| t.token.as_str()).collect::<Vec<_>>(), vec!["tok", "older"]);
        assert!(key.exists(), "the key that reaches it is kept for the retry");

        // A later launch reaches it: the tokens go, and so does the key kept for them.
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "0");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);
        super::retry_removed_server_revocations(&store, None, Some(keys.path())).await;
        assert!(store.removed_server_revocations().unwrap().is_empty());
        assert!(!key.exists() && !keys.path().join("m1.pub").exists(), "settled: its key is deleted");
    }

    /// A daemon that answers but refuses (or is too old) is not confirmed either.
    #[tokio::test]
    async fn delete_machine_core_reports_a_refusal_as_unconfirmed() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("delete-refused");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"ok":false,"error":"disk full"}"#);
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&provisioned_machine("m1")).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();
        store.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use

        let removal = super::delete_machine_core(&store, &test_locks(), None, None, "m1").await.unwrap();
        assert_eq!(
            removal.phone_revoke,
            Some(crate::appmcp::provision::RevokeOutcome::Failed { reason: "disk full".into() })
        );
        assert!(removal.retry_pending);
        assert_eq!(store.removed_server_revocations().unwrap().len(), 1);
    }

    /// The retry never deletes a key a paired server still uses.
    #[tokio::test]
    async fn the_retry_keeps_a_settled_servers_key_when_a_paired_server_uses_it() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("retry-key-in-use");
        std::env::set_var("FAKE_SSH_REMOVEPHONE_OUT", r#"{"type":"fd_phone_removed","ok":true,"removed":true}"#);
        let keys = TempKeysDir::new("retry-key-in-use");
        let key = keys.path().join("shared");
        std::fs::write(&key, "private").unwrap();
        let store = Store::open_in_memory().unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();
        store.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use
        let mut gone = provisioned_machine("gone");
        gone.identity_file = Some(key.to_string_lossy().into_owned());
        gone.host = "10.0.0.9".into();
        store.upsert_machine(&gone).unwrap();
        store.retire_machine_with_revocations(&gone, &["older".to_string()], 1).unwrap();
        let mut live = provisioned_machine("live");
        live.identity_file = gone.identity_file.clone();
        store.upsert_machine(&live).unwrap();

        super::retry_removed_server_revocations(&store, None, Some(keys.path())).await;
        assert!(store.removed_server_revocations().unwrap().is_empty());
        assert!(key.exists(), "still in use by a paired server");
    }

    /// A machine that was never provisioned (no phone token ever authorized on
    /// it) has nothing to revoke — `delete_machine_core` must not pay an ssh
    /// round trip for it, and the delete still happens.
    #[tokio::test]
    async fn delete_machine_core_skips_revoke_for_a_never_provisioned_machine() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("delete-skip");
        // No FAKE_SSH_REMOVEPHONE_* set: if the fake script's `remove-phone`
        // branch were hit, the default `{}` (parsed as neither ok:true nor
        // ok:false — see `parse_daemon_reply`) would be a harmless no-op here,
        // so absence of a crash alone wouldn't prove skip. Force a hard ssh
        // failure instead — the test then fails loudly if revoke ran at all.
        std::env::set_var("FAKE_SSH_REMOVEPHONE_EXIT", "1");

        let mut machine = provisioned_machine("m1");
        machine.phone_provisioned_at = None;
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine).unwrap();
        store.set_config("remote_phone_token", "tok").unwrap();
        store.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use

        // Had revoke run against the forced-failing fake ssh above, it would report an
        // outcome and leave a tombstone to retry.
        let removal = super::delete_machine_core(&store, &test_locks(), None, None, "m1").await.unwrap();
        assert!(store.machine_by_id("m1").unwrap().is_none());
        assert_eq!(
            removal,
            super::MachineRemoval { phone_revoke: None, retry_pending: false, devices_unconfirmed: 0 },
            "revoke must have been skipped entirely — never provisioned, nothing to revoke"
        );
        assert!(store.removed_server_revocations().unwrap().is_empty());
    }

    /// A server removed while it still holds an encrypted phone it cannot be told to
    /// forget keeps a tombstone (and its key file), like a legacy token.
    #[tokio::test]
    async fn delete_machine_core_tombstones_a_phone_the_server_did_not_forget() {
        let _guard = crate::appmcp::provision::test_support::PathGuard::install("delete-device");
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_EXIT", "255");
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_ERR", "ssh: connect to host vps: Connection refused");
        let mut machine = provisioned_machine("m1");
        machine.phone_provisioned_at = None;
        let store = Store::open_in_memory().unwrap();
        store.upsert_machine(&machine).unwrap();
        let (device, _) = crate::ipc::remote_devices::mint_device(&store, "iPhone", 1).unwrap();
        store.set_remote_device_server_generation(&device.device_id, "m1", 1, 2).unwrap();

        let removal = super::delete_machine_core(&store, &test_locks(), None, None, "m1").await.unwrap();
        assert_eq!(removal, super::MachineRemoval { phone_revoke: None, retry_pending: true, devices_unconfirmed: 1 });
        assert!(store.machine_by_id("m1").unwrap().is_none(), "the removal itself still happens");
        let owed = store.removed_server_device_removals().unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!((owed[0].0.id.as_str(), owed[0].1.as_str()), ("m1", device.device_id.as_str()));
    }

    /// A mac token that exists but won't open (the keychain key is unavailable) is NEVER
    /// replaced by a fresh one — that would lose this Mac's identity on the relay for good.
    /// The config says why instead, and holds no token to dial with.
    #[test]
    fn an_unreadable_mac_token_is_never_replaced() {
        use crate::secret_vault::{tests::test_vault, SecretVault};
        let store = Store::open_in_memory().unwrap();
        store.set_vault(test_vault());
        let first = super::load_remote_config(&store);
        let sealed = store.get_config("remote_mac_token").unwrap().unwrap();
        assert!(crate::secret_vault::is_sealed(&sealed), "minted sealed");
        assert!(first.secrets_error.is_none() && !first.mac_token.is_empty());

        store.set_vault(SecretVault::Unavailable { reason: "the keychain is locked".into(), lost: false });
        let cfg = super::load_remote_config(&store);
        assert!(cfg.mac_token.is_empty());
        assert_eq!(cfg.secrets_error.as_deref(), Some("the keychain is locked"));
        assert!(!cfg.secrets_lost);
        assert_eq!(store.get_config("remote_mac_token").unwrap(), Some(sealed), "the stored token is untouched");

        store.set_vault(test_vault());
        assert_eq!(super::load_remote_config(&store).mac_token, first.mac_token, "the key back: the same token");
    }

    /// A rotation's tokens: the next one kept until settled, then gone.
    #[test]
    fn mac_tokens_are_saved_sealed_and_a_settled_rotation_leaves_no_next_token() {
        let store = Store::open_in_memory().unwrap();
        store.set_vault(crate::secret_vault::tests::test_vault());
        super::persist_mac_tokens(&store, "old", Some("new")).unwrap();
        let cfg = super::load_remote_config(&store);
        assert_eq!((cfg.mac_token.as_str(), cfg.mac_token_next.as_deref()), ("old", Some("new")));
        super::persist_mac_tokens(&store, "new", None).unwrap();
        let cfg = super::load_remote_config(&store);
        assert_eq!((cfg.mac_token.as_str(), cfg.mac_token_next), ("new", None));
        assert!(store.get_config("remote_mac_token_next").unwrap().is_none());
        let minted = super::mint_mac_token().unwrap();
        assert_eq!(minted.len(), 43);
        assert!(minted.bytes().all(|b| (0x21..=0x7e).contains(&b)), "a valid bearer token: {minted}");
    }

    /// A fresh install never mints the legacy shared token; a Mac that already had a
    /// remote identity keeps its token until it is retired.
    #[test]
    fn a_fresh_install_never_mints_the_legacy_phone_token() {
        let fresh = Store::open_in_memory().unwrap();
        let cfg = super::load_remote_config(&fresh);
        assert!(cfg.phone_token.is_empty());
        assert!(!cfg.mac_id.is_empty());
        assert!(super::load_remote_config(&fresh).phone_token.is_empty(), "and never later");

        // An older build minted the token at every launch, access never turned on: no
        // phone ever saw it — retired, and queued for revocation everywhere.
        let never_enabled = Store::open_in_memory().unwrap();
        never_enabled.upsert_machine(&crate::appmcp::provision::test_support::machine("m1")).unwrap();
        never_enabled.set_config("remote_mac_id", "mac-1").unwrap();
        never_enabled.set_config("remote_phone_token", "tok").unwrap();
        let cfg = super::load_remote_config(&never_enabled);
        assert!(cfg.phone_token.is_empty());
        assert_eq!(cfg.revoke_phone_tokens, vec!["tok".to_string()]);
        assert_eq!(never_enabled.pending_daemon_phone_revocations("m1").unwrap(), vec!["tok".to_string()]);

        let existing = Store::open_in_memory().unwrap();
        existing.set_config("remote_mac_id", "mac-1").unwrap();
        existing.set_config("remote_phone_token", "tok").unwrap();
        existing.set_config("remote_enabled", "0").unwrap(); // access was on once, so the legacy token is in use
        existing.set_config("remote_enabled", "0").unwrap();
        assert_eq!(super::load_remote_config(&existing).phone_token, "tok", "access was on once: kept until retired");
        existing.retire_legacy_phone_token("tok", 5).unwrap();
        let cfg = super::load_remote_config(&existing);
        assert!(cfg.phone_token.is_empty());
        assert_eq!(cfg.revoke_phone_tokens, vec!["tok".to_string()]);
    }

    // ---- Orphaned pairing-key sweep (A7) --------------------------------------

    fn sweep_candidate(path: &str, mtime_ms: i64) -> super::SweepCandidate {
        super::SweepCandidate { path: PathBuf::from(path), mtime_ms }
    }

    #[test]
    fn orphan_keys_to_sweep_only_removes_old_unreferenced_non_pending_files() {
        let now = 10_000_000_000i64;
        let grace = super::ORPHAN_SWEEP_GRACE_MS;
        let old_unreferenced = sweep_candidate("/ssh_keys/server-old-uuid", now - grace - 1);
        let entries = vec![
            old_unreferenced.clone(),
            sweep_candidate("/ssh_keys/server-young-uuid", now - grace + 1), // too young
            sweep_candidate("/ssh_keys/pending", now - grace - 1),          // pending, any age
            sweep_candidate("/ssh_keys/pending.pub", now - grace - 1),      // pending, any age
            sweep_candidate("/ssh_keys/machine-1", now - grace - 1),        // referenced, any age
            sweep_candidate("/ssh_keys/machine-1.pub", now - grace - 1),    // referenced, any age
        ];
        let mut referenced = std::collections::HashSet::new();
        referenced.insert(PathBuf::from("/ssh_keys/machine-1"));
        referenced.insert(PathBuf::from("/ssh_keys/machine-1.pub"));

        let doomed = super::orphan_keys_to_sweep(&entries, &referenced, now);
        assert_eq!(
            doomed,
            vec![old_unreferenced.path],
            "only the old, unreferenced, non-pending file is swept"
        );
    }

    #[test]
    fn orphan_keys_to_sweep_exactly_at_the_grace_boundary_is_not_swept() {
        let now = 10_000_000_000i64;
        let grace = super::ORPHAN_SWEEP_GRACE_MS;
        // Age == grace exactly — `>` (not `>=`) in the decision function means this is
        // NOT yet old enough, a deliberately conservative boundary.
        let entries = vec![sweep_candidate("/ssh_keys/server-uuid", now - grace)];
        let doomed = super::orphan_keys_to_sweep(&entries, &std::collections::HashSet::new(), now);
        assert!(doomed.is_empty(), "exactly at the grace window is not yet swept");
    }

    /// Backdate `path`'s mtime well past the sweep's grace window (2h), so a real-file
    /// IO-wrapper test can exercise the "old enough to sweep" branch without waiting.
    fn set_old_mtime(path: &std::path::Path) {
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::File::open(path).unwrap().set_modified(old).unwrap();
    }

    #[test]
    fn sweep_orphan_ssh_keys_removes_an_old_unreferenced_file() {
        let dir = TempKeysDir::new("sweep-basic");
        let doomed = dir.path().join("server-old-uuid");
        std::fs::write(&doomed, "key").unwrap();
        set_old_mtime(&doomed);

        super::sweep_orphan_ssh_keys(dir.path(), Some(&[]));

        assert!(!doomed.exists(), "an old, unreferenced key must be swept");
    }

    #[test]
    fn sweep_orphan_ssh_keys_respects_the_grace_window() {
        let dir = TempKeysDir::new("sweep-grace");
        // Freshly written — well under the 1h grace window.
        let young = dir.path().join("server-young-uuid");
        std::fs::write(&young, "key").unwrap();

        super::sweep_orphan_ssh_keys(dir.path(), Some(&[]));

        assert!(young.exists(), "a file younger than the grace window must not be swept");
    }

    #[test]
    fn orphan_keys_to_sweep_never_removes_either_pending_slot() {
        let now = 10_000_000_000i64;
        let old = now - super::ORPHAN_SWEEP_GRACE_MS - 1;
        let entries: Vec<_> = ["pending", "pending.pub", "pending-connect", "pending-connect.pub", "pending-other"]
            .iter()
            .map(|n| sweep_candidate(&format!("/ssh_keys/{n}"), old))
            .collect();
        let doomed = super::orphan_keys_to_sweep(&entries, &std::collections::HashSet::new(), now);
        assert_eq!(doomed, vec![PathBuf::from("/ssh_keys/pending-other")], "only the two slots are protected");
    }

    #[test]
    fn sweep_orphan_ssh_keys_never_touches_pending_or_referenced_regardless_of_age() {
        let dir = TempKeysDir::new("sweep-protected");
        let pending = dir.path().join("pending");
        let pending_pub = dir.path().join("pending.pub");
        let connect = dir.path().join("pending-connect");
        let connect_pub = dir.path().join("pending-connect.pub");
        let referenced = dir.path().join("machine-1");
        let referenced_pub = dir.path().join("machine-1.pub");
        for p in [&pending, &pending_pub, &connect, &connect_pub, &referenced, &referenced_pub] {
            std::fs::write(p, "key").unwrap();
            set_old_mtime(p);
        }

        let machines = [crate::store::MachineRecord {
            id: "machine-1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 22,
            user: "agent".into(),
            identity_file: Some(referenced.to_string_lossy().into_owned()),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }];

        super::sweep_orphan_ssh_keys(dir.path(), Some(&machines));

        for p in [&pending, &pending_pub, &connect, &connect_pub, &referenced, &referenced_pub] {
            assert!(p.exists(), "{p:?} must never be swept regardless of age");
        }
    }

    #[test]
    fn sweep_orphan_ssh_keys_ignores_symlinks_and_subdirectories() {
        let dir = TempKeysDir::new("sweep-symlink");

        let doomed = dir.path().join("server-old-uuid");
        std::fs::write(&doomed, "key").unwrap();
        set_old_mtime(&doomed);

        // An old, dangling symlink must never be followed or removed.
        let link = dir.path().join("a-symlink");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &link).unwrap();

        // A subdirectory — even one containing an old file of its own — must never be
        // recursed into.
        let subdir = dir.path().join("a-subdir");
        std::fs::create_dir(&subdir).unwrap();
        let nested = subdir.join("nested-old-file");
        std::fs::write(&nested, "x").unwrap();
        set_old_mtime(&nested);

        super::sweep_orphan_ssh_keys(dir.path(), Some(&[]));

        assert!(!doomed.exists(), "the old, unreferenced regular file must still be swept");
        assert!(link.symlink_metadata().is_ok(), "the symlink itself must survive, never followed");
        assert!(subdir.exists(), "the subdirectory must survive, never recursed into");
        assert!(nested.exists(), "nothing inside a subdirectory is ever touched");
    }

    #[test]
    fn sweep_orphan_ssh_keys_skips_entirely_when_the_store_could_not_be_read() {
        let dir = TempKeysDir::new("sweep-store-error");
        let old_unreferenced = dir.path().join("server-old-uuid");
        std::fs::write(&old_unreferenced, "key").unwrap();
        set_old_mtime(&old_unreferenced);

        super::sweep_orphan_ssh_keys(dir.path(), None);

        assert!(
            old_unreferenced.exists(),
            "None (store unreadable) must skip the sweep entirely — fail safe"
        );
    }

    #[test]
    fn sweep_orphan_ssh_keys_missing_directory_is_a_harmless_noop() {
        let dir = TempKeysDir::new("sweep-missing-dir");
        let missing = dir.path().join("does-not-exist");
        // Must not panic — a fresh install with no server ever paired has no ssh_keys/.
        super::sweep_orphan_ssh_keys(&missing, Some(&[]));
    }
}

// ---- In-app claude.ai artifact host -------------------------------------------------------
//
// The front's single boundary to the native webview that shows an artifact's hosted page over
// the side region. All forward to [`crate::artifact_host::ArtifactHost`]. ASYNC on purpose:
// creating a child webview (`Window::add_child`) blocks until the main thread has built it, and
// a sync command RUNS on the main thread — it would wait on itself.

/// Show the hosted artifact `url` at `bounds` (main-window logical px), scaled by `zoom`, creating
/// the host on first use. Same URL again = no reload. Refuses any URL that is not a claude.ai
/// artifact. Returns whether it NAVIGATED — the front waits for page-load events only then.
/// See [`crate::artifact_host`].
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_show(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
    url: String,
    bounds: crate::artifact_host::HostBounds,
    zoom: f64,
) -> Result<bool, String> {
    host.show(&app, &url, bounds, zoom)
}

/// Move/resize the artifact host (no-op when it doesn't exist).
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_set_bounds(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
    bounds: crate::artifact_host::HostBounds,
) -> Result<(), String> {
    host.set_bounds(&app, bounds)
}

/// Hide the artifact host, keeping its page alive (no-op when it doesn't exist).
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_hide(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
) -> Result<(), String> {
    host.hide(&app)
}

/// Re-open the requested artifact in the host (refresh / back to the artifact).
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_reload(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
) -> Result<(), String> {
    host.reload(&app)
}

/// Point the artifact host at a claude.ai sign-in link the user pasted (an emailed link opened in
/// the browser would sign in a session this webview never sees). claude.ai URLs only.
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_open_claude_url(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
    url: String,
) -> Result<(), String> {
    host.open_claude_url(&app, &url)
}

/// Destroy the artifact host and free its web content process (no-op when it doesn't exist).
#[tauri::command]
#[specta::specta]
pub async fn artifact_host_close(
    app: tauri::AppHandle,
    host: tauri::State<'_, crate::artifact_host::ArtifactHost>,
) -> Result<(), String> {
    host.close(&app)
}
