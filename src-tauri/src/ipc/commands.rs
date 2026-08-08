use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::ipc::events::TauriEmitter;
use crate::store::{ConversationRecord, PersistedState, RepoRecord, Store};
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

/// Tauri managed state: the registry of live sessions, keyed by our own id.
#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, SessionHandle>>,
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
        self.inner.lock().unwrap().get(id).cloned()
    }

    fn insert(&self, id: String, handle: SessionHandle) {
        self.inner.lock().unwrap().insert(id, handle);
    }

    fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.inner.lock().unwrap().remove(id)
    }

    /// Snapshot every live handle WITHOUT evicting them. Each session's actor
    /// evicts itself (via its `on_exit`) once it has fully torn down, so callers
    /// can request shutdown on this snapshot and then watch [`Sessions::is_empty`]
    /// to know when every process is actually reaped.
    pub fn handles(&self) -> Vec<SessionHandle> {
        self.inner.lock().unwrap().values().cloned().collect()
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
#[tauri::command]
#[specta::specta]
pub async fn spawn_session(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, Sessions>,
    repo_path: String,
    resume: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    ultracode: bool,
    backend: Backend,
    allow_bypass_permissions: bool,
) -> Result<String, String> {
    let id = sessions.next_id();
    let mut cfg = SpawnConfig::new(PathBuf::from(repo_path));
    cfg.resume = resume;
    cfg.allow_bypass_permissions = allow_bypass_permissions;
    // Product defaults when unset: Opus 5 + Extra (xhigh) effort + Auto (`auto`)
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
    cfg.model = Some(model.unwrap_or_else(|| "opus".into()));
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
        Backend::Claude => session::spawn_session(id.clone(), cfg, initial, emitter, on_exit),
    }
    .map_err(|e| e.to_string())?;
    sessions.insert(id.clone(), handle);
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

/// The signed-in Claude account (`claude auth status --json`), whitelisted.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_status() -> Result<crate::accounts::ClaudeAccountStatus, String> {
    crate::accounts::status().await
}

/// Start a Claude login: spawns `claude auth login`, returns the OAuth URL to open.
/// The flow completes when the user pastes the authorization code
/// ([`account_claude_login_code`]) — or is dropped by [`account_claude_login_cancel`].
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_start() -> Result<String, String> {
    crate::accounts::login_start().await
}

/// Submit the authorization code the user pasted; completes the in-flight Claude login.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_code(code: String) -> Result<(), String> {
    crate::accounts::login_submit_code(&code).await
}

/// Abort the in-flight Claude login (kills the CLI child). Safe when none is running.
#[tauri::command]
#[specta::specta]
pub async fn account_claude_login_cancel() -> Result<(), String> {
    crate::accounts::login_cancel().await;
    Ok(())
}

/// Log out of the Claude account (`claude auth logout`).
#[tauri::command]
#[specta::specta]
pub async fn account_claude_logout() -> Result<(), String> {
    crate::accounts::logout().await
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
pub async fn tosse_logout() -> Result<(), String> {
    crate::tosse::logout().await.map_err(|e| e.to_string())
}

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

/// The `Backlog` tasks, which the briefing deliberately leaves out. Fetched separately so
/// the view can offer them as a section of their own — see `tosse::backlog`.
#[tauri::command]
#[specta::specta]
pub async fn tosse_backlog() -> Result<Vec<crate::tosse::TosseBacklogTask>, String> {
    crate::tosse::backlog().await.map_err(|e| e.to_string())
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
        .send_line(control::initialize_request(request_id))
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

    transport.shutdown().await;
    Ok(commands)
}

/// Rebuild a resumed conversation's history from Claude's on-disk transcript.
///
/// `claude --resume` does not re-stream past messages, so the live event path
/// delivers nothing for an existing conversation. The UI calls this after
/// re-spawning a session to replay its history into the store. An absent
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

/// Fetch the real subscription usage percentages (5h + weekly windows). The stream
/// only carries a coarse rate-limit status, so this replicates the CLI's internal
/// `GET /api/oauth/usage` (OAuth token read from `~/.claude/.credentials.json` then
/// the macOS Keychain). Read-only — never refreshes/writes the token. Account-global
/// (not per-session); on error the UI degrades to the coarse `rate_limit` status. The
/// endpoint is itself rate-limited, so the caller throttles (poll + on-open + manual).
/// Errors are typed ([`UsageError`]) so the UI can show a tailored next step.
#[tauri::command]
#[specta::specta]
pub async fn get_plan_usage() -> Result<PlanUsage, UsageError> {
    crate::usage::fetch_plan_usage().await
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
) -> Result<(), String> {
    let handle = sessions.get(&session).ok_or_else(unknown_session)?;
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
        let _ = handle.shutdown_and_wait().await;
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
}
