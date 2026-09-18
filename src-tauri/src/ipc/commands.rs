use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::ipc::events::TauriEmitter;
use crate::store::{
    validate_address_value, AddressCandidate, AddressKind, ConversationRecord, MachineRecord,
    PersistedState, RepoRecord, Store,
};
use crate::supervisor::codex::{self, CodexServer};
use crate::supervisor::control::{self, PermissionDecision, PermissionMode};
use crate::supervisor::history::{self, DiskConversation, IndexedConversation, SearchHit};
use crate::supervisor::model::{
    ContextFill, ConversationItem, GoalState, SlashCommand, WorkflowJournal, WorkflowPhase,
    WorkflowRun,
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
    /// The xhigh + orchestration tier. Not a spawn flag of its own: the session
    /// re-enables it over the control channel right after `initialize`.
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
    } = flags;
    // Resolved through the AppHandle rather than a `State` param: specta caps a
    // command at 10 parameters and `app_control` used the last slot.
    let sessions = app.state::<Sessions>();
    let id = sessions.next_id();
    // A conversation opened in a REMOTE repo (one whose repo carries a machine_id)
    // launches its `claude` on that server over SSH instead of locally. Resolved from
    // the repo by path here — no new IPC param (spawn_session is at specta's 10-arg
    // cap) and no change to the front's hot path. No machine = the unchanged local case.
    let remote_machine = app
        .state::<Store>()
        .machine_for_repo_path(&repo_path)
        .ok()
        .flatten();
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
    // Product defaults when unset: Opus 4.8 + Extra (xhigh) effort + Auto (`auto`)
    // permission mode. `auto` is the binary's OWN native default (verified: spawning
    // with no --permission-mode reports permissionMode "auto"; --permission-mode auto
    // reports "auto"), and it matches the front-end seed `DEFAULT_PERMISSION_MODE` so
    // a new conversation, the persisted null fallback, and the live session all agree.
    // An unknown/invalid effort falls back to xhigh (the CLI would otherwise swallow
    // it silently). "ultracode" is NOT a spawn flag — the spawn carries effort=xhigh
    // and the session re-enables the ultracode flag after init (`InitialControls`).
    let effort = effort
        .filter(|e| control::is_valid_effort_level(e))
        .unwrap_or_else(|| "xhigh".into());
    // Full model name, not the `opus` alias — that alias tracks the LATEST Opus, so
    // pinning 4.8 means naming it. Mirrors the front-end seed `DEFAULT_MODEL`.
    cfg.model = Some(model.unwrap_or_else(|| "claude-opus-4-8".into()));
    cfg.effort = Some(effort);
    // A persisted `bypassPermissions` is demoted to `default` when the unlock flag is
    // off (e.g. the user turned the Settings toggle back off while a conversation still
    // had bypass selected) — the CLI would demote it anyway, silently. Doing it here
    // keeps the spawn flag, the post-init re-assert and the CLI's own view in agreement.
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
        let addresses = remote_target_addresses(&machine.host, machine.addresses);
        cfg.remote = Some(crate::supervisor::transport::RemoteTarget {
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
        });
        // Pre-mint the daemon-side conversation id so retries are idempotent: if
        // the FIRST attach dies before its fd_attach handshake lands, the
        // reconnect presents the same id and re-joins the same daemon
        // conversation instead of cold-starting a duplicate (and leaking a
        // claude process server-side). The daemon prefers a LIVE session
        // matching `resume` over this id, so resumes still re-join correctly.
        cfg.attach = Some(crate::supervisor::transport::AttachPoint {
            conversation: Some(uuid::Uuid::new_v4().to_string()),
            epoch: None,
            cursor: 0,
            supports_skip,
        });
    }
    let initial = InitialControls {
        model: cfg.model.clone(),
        effort: cfg.effort.clone(),
        permission_mode: cfg.permission_mode.clone(),
        ultracode,
    };
    let emitter = Arc::new(TauriEmitter { app: app.clone() });
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
                // Three ordinary answers, one fault. A folder that is not a repository is
                // COMMON here (Flight Deck opens folders, not only clones) and must not be
                // dressed up as a failure; a folder that vanished, or that git cannot read,
                // must SAY so rather than pass for "simply un-associated".
                let (remote_url, not_a_repository, remote_error) =
                    match crate::git::remote_url(&row.path) {
                        Ok(RemoteLookup::Url(url)) => (Some(url), false, None),
                        Ok(RemoteLookup::NoRemote) => (None, false, None),
                        Ok(RemoteLookup::NotARepository) => (None, true, None),
                        Err(e) => (None, false, Some(e.to_string())),
                    };
                (
                    crate::tosse::LocalRepo {
                        repo_id: row.repo_id,
                        remote_url,
                        manual_repository_id: row.tosse_repository_id,
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
    let known = store.repo_tosse_links().map_err(|e| e.to_string())?;
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

/// Aggregate every sub-agent turn on this machine into `(day, repo, agent, model,
/// workflow)` buckets. One scan; the UI pivots it for every table, filter and chart.
#[tauri::command]
#[specta::specta]
pub async fn subagent_spend() -> Result<crate::agentspend::SpendReport, String> {
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

/// Read a conversation's active `/goal` (Claude Code's native goal feature) from its on-disk
/// transcript. The CLI writes goal state as `attachment` lines that are DISK-ONLY (never on the
/// live stream), so the UI polls this at conversation load and on each turn edge to know whether a
/// goal is active and show its condition. `None` when no goal is active.
///
/// Reads the transcript in FULL, forward (a goal set early and never terminated is still active
/// at the end of the file, so no tail slice would do) — but a raw-substring pre-filter rejects
/// every line that can't carry goal state before it reaches the JSON parser, which is what keeps
/// a whole Flight Deck fleet seeding its goals affordable. Pure file IO, off the async runtime
/// via `spawn_blocking`.
#[tauri::command]
#[specta::specta]
pub async fn load_session_goal(session_id: String) -> Result<Option<GoalState>, String> {
    tokio::task::spawn_blocking(move || crate::supervisor::history::load_active_goal(&session_id))
        .await
        .map_err(|e| e.to_string())
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

// ---- Background-task artifacts (disk readers) -----------------------------
//
// The front's read-only boundary to a session's on-disk background-task artifacts:
// a sub-agent's full transcript, a workflow run's manifest, and a background
// task's output file. These complement the live `SessionTaskEvent` (which carries
// only the coarse lifecycle) with the rich detail for a drill-down. Pure I/O run
// off the async runtime via `spawn_blocking`, like `load_session_history`.

/// Load a sub-agent's (`Agent` tool, or a workflow agent) full transcript,
/// normalized into the same items the live conversation renders. Empty if absent.
#[tauri::command]
#[specta::specta]
pub async fn load_subagent_transcript(
    session_id: String,
    agent_id: String,
) -> Result<Vec<ConversationItem>, String> {
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_subagent_transcript(&session_id, &agent_id)
    })
    .await
    .map_err(|e| e.to_string())
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

/// Load a workflow run's manifest (`workflows/<run_id>.json`). `null` if absent.
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_run(
    session_id: String,
    run_id: String,
) -> Result<Option<WorkflowRun>, String> {
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_workflow_run(&session_id, &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Live progress of a RUNNING workflow from its journal (`subagents/workflows/<run_id>/
/// journal.jsonl`): agents started vs done. The rich manifest is written only at the end, so
/// this is the mid-run "how far along" source. `null` if no journal yet.
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_journal(
    session_id: String,
    run_id: String,
) -> Result<Option<WorkflowJournal>, String> {
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_workflow_journal(&session_id, &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
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
/// run. Empty if no script/phases. Lets the live overview show upcoming steps.
#[tauri::command]
#[specta::specta]
pub async fn load_workflow_phases(
    session_id: String,
    run_id: String,
) -> Result<Vec<WorkflowPhase>, String> {
    tokio::task::spawn_blocking(move || {
        crate::supervisor::subagents::load_workflow_phases(&session_id, &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a background task's output from the ABSOLUTE path the CLI reported
/// (`BackgroundTask.output_file`). The CLI writes Bash-bg / Monitor output to a temp dir
/// the app can't reconstruct, so the live tail reads this path directly. `null` if
/// absent. One-shot read — the display task layers the polling on top. The reader guards
/// the path (must be a `…/tasks/*.output` file) against an arbitrary-file read.
#[tauri::command]
#[specta::specta]
pub async fn read_task_output_file(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || crate::supervisor::subagents::read_task_output_file(&path))
        .await
        .map_err(|e| e.to_string())
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

/// Enable "ultracode" (xhigh effort + standing dynamic-workflow orchestration) at
/// runtime. Disabling is done by selecting any plain effort level via
/// [`set_effort_level`], which clears the flag.
#[tauri::command]
#[specta::specta]
pub async fn set_ultracode(
    sessions: tauri::State<'_, Sessions>,
    session: String,
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
    handle.enable_ultracode().await.map_err(|e| e.to_string())
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
    Err("\"Open in terminal\" is only supported on macOS for now.".to_string())
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
    let Some(window) = app.get_webview_window("main") else {
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
    let Some(window) = app.get_webview_window("main") else {
        return Ok(()); // window already closed — nothing to scale
    };
    window.set_zoom(factor).map_err(|e| e.to_string())
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

/// Serializes [`generate_machine_key`] end to end (read-or-mint, then the
/// `ssh-keygen` spawn). The fixed `pending` filename it reads/writes means two
/// concurrent callers (e.g. a double click on "+ Add a server") would otherwise race
/// `ssh-keygen -f pending` — the loser hitting an interactive "overwrite?" prompt on
/// stdin nobody is reading, which hangs the command forever.
static PENDING_KEY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Absolute path of the not-yet-claimed pairing key `generate_machine_key` writes to
/// (no `.pub` suffix — callers append it themselves as needed), under an app's
/// `ssh_keys/` directory.
fn pending_key_path(ssh_keys_dir: &Path) -> PathBuf {
    ssh_keys_dir.join(PENDING_KEY_BASENAME)
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
    let _guard = PENDING_KEY_LOCK.lock().await;
    std::fs::create_dir_all(ssh_keys_dir).map_err(|e| e.to_string())?;
    let key = pending_key_path(ssh_keys_dir);
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
/// (never swept) when its basename is the live `pending`/`pending.pub` keypair, or its
/// path is in `referenced` (see [`referenced_key_paths`]); otherwise it is swept once
/// it is older than [`ORPHAN_SWEEP_GRACE_MS`]. Pure — takes pre-enumerated entries and
/// the referenced set so it is unit-tested without touching a real filesystem;
/// [`sweep_orphan_ssh_keys`] is the (untestable) IO wrapper around it.
fn orphan_keys_to_sweep(
    entries: &[SweepCandidate],
    referenced: &std::collections::HashSet<PathBuf>,
    now_ms: i64,
) -> Vec<PathBuf> {
    entries
        .iter()
        .filter(|e| {
            let name = e.path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name == PENDING_KEY_BASENAME || name == format!("{PENDING_KEY_BASENAME}.pub") {
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
fn version_at_least(v: &str, min: &str) -> bool {
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
/// `Serialize`/`Type` (B7): [`bootstrap::connect::bootstrap_probe`] returns this
/// directly across the Tauri IPC boundary — [`add_machine`]'s own use never needed
/// this before, since it only ever consumed a `RemoteProbeResult` internally and
/// returned a [`MachineRecord`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
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
/// destination).
pub(crate) fn keyed_ssh_options(
    port: u16,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-p")
        .arg(port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    if let Some(kh) = known_hosts {
        cmd.arg("-o").arg(format!("UserKnownHostsFile={kh}"));
    }
    if let Some(id) = identity {
        cmd.arg("-i").arg(id).arg("-o").arg("IdentitiesOnly=yes");
    }
    cmd
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
async fn probe_remote(
    host: &str,
    port: u16,
    user: &str,
    identity: Option<&str>,
    known_hosts: Option<&str>,
) -> Result<RemoteProbeResult, String> {
    let mut cmd = keyed_ssh_options(port, identity, known_hosts);
    cmd.arg("-T");
    // Findings ride on stdout as `MARKER:value` lines (parsed below via
    // `extract_marker`) PLUS human-readable stderr markers + a nonzero exit for parity
    // with the old single-tool probe and for anyone reading raw ssh output by hand.
    let script = r#"
MISSING=""
CLAUDE_VERSION=""
if command -v claude >/dev/null 2>&1; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null)
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
    cmd.arg(format!("{user}@{host}")).arg(script);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("could not run ssh: {e}"))?;
    parse_probe_output(
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
        out.status.success(),
    )
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
        return Err(format!(
            "Could not connect over SSH: {}",
            stderr.trim().lines().last().unwrap_or("unknown error")
        ));
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
fn describe_probe_blockers(probe: &RemoteProbeResult) -> String {
    let mut blockers = Vec::new();
    if probe.claude_missing {
        blockers.push(
            "`claude` is not installed on the server. On the server run: \
             curl -fsSL https://claude.ai/install.sh | sh — then log Claude in there \
             (`claude`), and retry."
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
/// now-stale answer. The only caller today is `session.rs::run_actor`, when a reconnect
/// attempt dies with clap's unknown-argument rejection of `--supports-skip`/`--title`
/// (`looks_like_clap_flag_rejection`) — proof the cached version was wrong because the
/// server's `flightdeckd` was DOWNGRADED since it was learned. A no-op for an
/// unknown/already-absent `machine_id` (nothing to invalidate).
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

/// The "already used" guard `add_machine` runs BEFORE probing: an `identity_file`
/// that no longer exists on disk means this pairing command was already claimed by a
/// DIFFERENT server (see [`claim_pending_key`]'s rename) — most likely the same
/// command pasted onto two boxes before either was paired. Returns the specific error
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
    Some(PENDING_KEY_ALREADY_USED_MSG.to_string())
}

/// On a successful pairing, claims the PENDING key — if `identity_file` actually IS
/// the pending one under `ssh_keys_dir` — by renaming it to a per-machine filename, so
/// a LATER `generate_machine_key` call (for the NEXT server) mints a fresh pending
/// pair instead of silently handing out this one's already-claimed key. A
/// non-pending `identity_file` (a custom key) or `None` (default SSH key/agent) is
/// returned UNCHANGED. Takes plain paths so it's testable without a `tauri::AppHandle`.
///
/// If the rename fails because `pending` is already gone (`NotFound` — a concurrent
/// caller won the race and claimed it first), this reports the SAME friendly
/// [`PENDING_KEY_ALREADY_USED_MSG`] [`stale_identity_file_error`] uses, rather than the
/// raw OS error, so a losing racer gets an actionable message either way. Callers
/// SHOULD go through [`claim_pending_key_locked`] rather than this directly, so the
/// rename itself can't interleave with another claim of the same pending path.
fn claim_pending_key(
    ssh_keys_dir: &Path,
    identity_file: Option<String>,
    machine_id: &str,
) -> Result<Option<String>, String> {
    let pending = pending_key_path(ssh_keys_dir);
    match &identity_file {
        Some(id) if Path::new(id) == pending => {
            let claimed = ssh_keys_dir.join(machine_id);
            std::fs::rename(&pending, &claimed).map_err(rename_error_message)?;
            std::fs::rename(format!("{}.pub", pending.display()), format!("{}.pub", claimed.display()))
                .map_err(rename_error_message)?;
            Ok(Some(claimed.to_string_lossy().into_owned()))
        }
        _ => Ok(identity_file),
    }
}

/// Maps a failed `claim_pending_key` rename onto the friendly "already used" message
/// when the cause is the source file having vanished (a concurrent claim won the
/// race), or the raw OS error string otherwise (a genuine filesystem failure, e.g.
/// permissions).
fn rename_error_message(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        PENDING_KEY_ALREADY_USED_MSG.to_string()
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
fn probe_candidates(host: &str, addresses: Option<Vec<AddressCandidate>>) -> Vec<AddressCandidate> {
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
#[tauri::command]
#[specta::specta]
pub async fn add_machine(
    app: tauri::AppHandle,
    label: String,
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    addresses: Option<Vec<AddressCandidate>>,
) -> Result<MachineRecord, String> {
    if let Some(err) = stale_identity_file_error(&identity_file) {
        return Err(err);
    }

    let candidates = probe_candidates(host.trim(), addresses);
    for c in &candidates {
        validate_address_value(&c.value)?;
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let known_hosts = app_data_dir.join("remote_known_hosts").to_string_lossy().into_owned();

    // Probe every candidate, in order, stopping at the first success — collecting
    // every failure along the way so a total failure can name each address tried.
    let mut failures: Vec<String> = Vec::new();
    let mut working_host: Option<String> = None;
    for c in &candidates {
        match probe_remote(&c.value, port, &user, identity_file.as_deref(), Some(&known_hosts)).await {
            Ok(probe)
                if !(probe.claude_missing || probe.flightdeckd_missing || probe.flightdeckd_outdated) =>
            {
                working_host = Some(c.value.clone());
                break;
            }
            Ok(probe) => failures.push(format!("{}: {}", c.value, describe_probe_blockers(&probe))),
            Err(e) => failures.push(format!("{}: {e}", c.value)),
        }
    }
    let working_host = working_host.ok_or_else(|| {
        format!("Could not pair — every address failed. {}", failures.join(" — "))
    })?;

    let machine_id = uuid::Uuid::new_v4().to_string();
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
        addresses: candidates,
        daemon_mac_id: None,
        daemon_relay_url: None,
        daemon_label: None,
        phone_provisioned_at: None,
    };
    app.state::<Store>()
        .upsert_machine(&machine)
        .map_err(|e| e.to_string())?;
    Ok(machine)
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
fn delete_machine_and_key(store: &Store, id: &str) -> Result<(), String> {
    // Read the record BEFORE deleting it — the row (and its identity_file path) is
    // gone from the store immediately after.
    let identity_file = store.machine_by_id(id).map_err(|e| e.to_string())?.and_then(|m| m.identity_file);
    store.delete_machine(id).map_err(|e| e.to_string())?;
    if let Some(identity) = identity_file {
        log_remove_file_failure(&identity);
        log_remove_file_failure(&format!("{identity}.pub"));
    }
    Ok(())
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

/// Un-pair a remote server. See [`delete_machine_and_key`].
#[tauri::command]
#[specta::specta]
pub fn delete_machine(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    delete_machine_and_key(&store, &id)
}

/// Run a command on a server over SSH (batch, never-prompting), returning stdout on
/// success or the last stderr line on failure. The connection coordinates come from
/// the [`MachineRecord`]; `known_hosts` is Flight Deck's own file (TOFU pinning).
///
/// `pub(crate)` so `bootstrap::server_setup` reuses this SAME round-trip for its own
/// batch calls (`flightdeckd init` / `flightdeckd whoami`) instead of building a second
/// one — see that module's doc.
pub(crate) async fn run_ssh_on_machine(
    m: &crate::store::MachineRecord,
    known_hosts: Option<&str>,
    remote_cmd: &str,
) -> Result<String, String> {
    let mut cmd = keyed_ssh_options(m.port, m.identity_file.as_deref(), known_hosts);
    cmd.arg("-T");
    cmd.arg(format!("{}@{}", m.user, m.host)).arg(remote_cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("could not run ssh: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("ssh command failed")
            .to_string())
    }
}

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
    // so repos outside the home folder (e.g. /work, /srv) are still found.
    let out = run_ssh_on_machine(
        &machine,
        known_hosts.as_deref(),
        "find \"$HOME\" /work /srv /opt /var/www -maxdepth 4 -type d -name .git -prune \
         2>/dev/null | sed \"s#/.git$##\" | sort -u | head -100",
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
    let Ok(Some((cwd, session_id, machine))) = store.remote_session_for_conversation(&conversation_id)
    else {
        return false;
    };
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
pub async fn set_voice_agent_key(key: String) -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(move || crate::voice::set_key(&key))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

/// Forget the stored OpenAI key (absent item = success).
#[tauri::command]
#[specta::specta]
pub async fn clear_voice_agent_key() -> Result<crate::voice::VoiceAgentStatus, String> {
    tokio::task::spawn_blocking(crate::voice::clear_key)
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
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
    tokio::task::spawn_blocking(move || wake.apply(cfg))
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
const REMOTE_PHONE_TOKEN_KEY: &str = "remote_phone_token";

/// Load the remote-access config, minting (and persisting) the stable mac id, the
/// mac secret and the phone pairing token on first use so Settings always has a QR
/// to show. Best-effort on read errors (then it starts disabled with defaults).
pub fn load_remote_config(store: &Store) -> crate::appmcp::RemoteConfig {
    let read = |key: &str| store.get_config(key).ok().flatten();
    let mint = |key: &str| -> String {
        match read(key) {
            Some(v) if !v.is_empty() => v,
            _ => {
                let v = uuid::Uuid::new_v4().to_string();
                if let Err(e) = store.set_config(key, &v) {
                    eprintln!("[appmcp] failed to persist {key}: {e}");
                }
                v
            }
        }
    };
    crate::appmcp::RemoteConfig {
        enabled: read(REMOTE_ENABLED_KEY).as_deref() == Some("1"),
        relay_url: read(REMOTE_URL_KEY)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| crate::appmcp::DEFAULT_RELAY_URL.to_string()),
        mac_id: mint(REMOTE_MAC_ID_KEY),
        mac_token: mint(REMOTE_MAC_TOKEN_KEY),
        phone_token: mint(REMOTE_PHONE_TOKEN_KEY),
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

/// Change the remote-access config (enable, relay URL, regenerate the pairing
/// token), persist it, and (re)connect or disconnect accordingly. Regenerating
/// the pairing token revokes every previously-paired phone. Returns the honest
/// post-apply status.
#[tauri::command]
#[specta::specta]
pub async fn set_remote(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    relay_url: Option<String>,
    regenerate_pairing: bool,
) -> Result<crate::appmcp::RemoteStatus, String> {
    let hub = (*app.state::<Arc<crate::appmcp::ControlHub>>()).clone();
    let cfg = {
        let store = app.state::<Store>();
        let mut cfg = load_remote_config(&store);
        if let Some(enabled) = enabled {
            cfg.enabled = enabled;
        }
        if let Some(url) = relay_url {
            let url = url.trim().to_string();
            if !url.is_empty() {
                cfg.relay_url = url;
            }
        }
        if regenerate_pairing {
            cfg.phone_token = uuid::Uuid::new_v4().to_string();
        }
        store
            .set_config(REMOTE_ENABLED_KEY, if cfg.enabled { "1" } else { "0" })
            .and_then(|_| store.set_config(REMOTE_URL_KEY, &cfg.relay_url))
            .and_then(|_| store.set_config(REMOTE_MAC_ID_KEY, &cfg.mac_id))
            .and_then(|_| store.set_config(REMOTE_MAC_TOKEN_KEY, &cfg.mac_token))
            .and_then(|_| store.set_config(REMOTE_PHONE_TOKEN_KEY, &cfg.phone_token))
            .map_err(|e| e.to_string())?;
        cfg
    };
    hub.apply_remote(cfg).await;
    Ok(hub.remote_status())
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

        super::delete_machine_and_key(&store, "machine-1").unwrap();
        assert!(!key.exists(), "private key removed");
        assert!(!std::path::Path::new(&format!("{}.pub", key.display())).exists(), "public key removed");
        assert!(store.machine_by_id("machine-1").unwrap().is_none(), "record gone too");
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
        super::delete_machine_and_key(&store, "machine-2").unwrap();

        // Nor when the record doesn't even exist (already-deleted / bad id).
        super::delete_machine_and_key(&store, "no-such-machine").unwrap();
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
    fn sweep_orphan_ssh_keys_never_touches_pending_or_referenced_regardless_of_age() {
        let dir = TempKeysDir::new("sweep-protected");
        let pending = dir.path().join("pending");
        let pending_pub = dir.path().join("pending.pub");
        let referenced = dir.path().join("machine-1");
        let referenced_pub = dir.path().join("machine-1.pub");
        for p in [&pending, &pending_pub, &referenced, &referenced_pub] {
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

        for p in [&pending, &pending_pub, &referenced, &referenced_pub] {
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
