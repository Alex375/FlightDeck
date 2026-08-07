use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::supervisor::model::{
    BackgroundTask, ConversationItem, PermissionRequestPayload, PermissionResolvedPayload,
    RemoteControlState, SessionEmitter, SessionStatePayload, SlashCommand,
};
use crate::usage::PlanUsage;

/// Emitted periodically by a Rust timer. Proves Rust -> React (typed event).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TickEvent {
    pub seq: u32,
    pub message: String,
}

/// A session's lifecycle / identity changed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionStateEvent {
    pub session: String,
    pub state: SessionStatePayload,
}

/// A normalized conversation item to render (text delta, assistant message,
/// tool result, turn result, …).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionMessageEvent {
    pub session: String,
    pub item: ConversationItem,
}

/// A `can_use_tool` permission prompt awaiting a decision.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionPermissionEvent {
    pub session: String,
    pub request: PermissionRequestPayload,
}

/// A pending permission prompt was withdrawn by the CLI and can no longer be
/// answered. The UI drops the card: it otherwise prunes only on a user answer,
/// leaving a dead prompt on screen that silently swallows the next click.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionPermissionResolvedEvent {
    pub session: String,
    pub request_id: String,
}

/// The session's available slash commands (one-shot, at `initialize`). Drives the
/// composer's `/` autocomplete menu.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionCommandsEvent {
    pub session: String,
    pub commands: Vec<SlashCommand>,
}

/// A background task (sub-agent / workflow / Monitor / background Bash) was created
/// or changed state. Emitted on every `task_*` transition, keyed (inside the
/// payload) by `task_id`, so the UI tracks the live fleet of background tasks.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionTaskEvent {
    pub session: String,
    pub task: BackgroundTask,
}

/// A model-generated conversation title arrived (from a `generate_session_title`
/// control response). The UI maps `session` (handle) → conversation and applies the
/// title as the name UNLESS the user set a custom title in the meantime. `seq` is the
/// monotonic per-conversation tag the UI sent: it applies a title only if `seq` is
/// newer than the last applied, so an out-of-order (stale) response can't overwrite a
/// fresher title.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionTitleEvent {
    pub session: String,
    pub title: String,
    pub seq: u32,
}

/// A model-generated few-word summary of the user's LAST message arrived (from a
/// `generate_session_title` control response — same wire as the title, a distinct
/// routing). The UI maps `session` (handle) → conversation and shows it on the Flight
/// Deck card. `seq` is the monotonic per-conversation tag the UI sent: it applies the
/// summary only if `seq` still matches the latest message, so a stale (superseded)
/// response can't overwrite a fresher one.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionSummaryEvent {
    pub session: String,
    pub summary: String,
    pub seq: u32,
}

/// This session's Remote Control ("bridge") state changed — the ack of a
/// `remote_control` request, or an async `system/bridge_state` health downgrade. The
/// UI maps `session` (handle) → conversation and updates its Remote Control chip
/// (connected + `session_url`, connecting, disconnected, or error).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionRemoteControlEvent {
    pub session: String,
    pub state: RemoteControlState,
}

/// The Codex backend's subscription rate-limit % (5h + weekly windows) changed. Codex
/// pushes this over the live app-server (`account/rateLimits/updated`) — there is no
/// HTTP/Keychain pull as for Claude — normalized to the SAME `PlanUsage` shape the
/// popover renders. Account-global: the UI keeps ONE Codex plan store (never merged
/// with Claude's Anthropic one) and the `session` here only tags which conversation
/// surfaced it. Windows are sparse (a push may carry only the one that moved), so the
/// front merges onto the last snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionCodexPlanUsageEvent {
    pub session: String,
    pub usage: PlanUsage,
}

/// An extension-inventory invalidation push from a live Codex session — the server
/// noticed its skills / MCP startup status / account changed (`skills/changed`,
/// `mcpServer/startupStatus/updated`, `account/updated`). Carries NO inventory data:
/// the front just invalidates the matching cached queries and refetches through the
/// normal read commands. `area` = `"skills"` | `"mcp"` | `"accounts"`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionExtensionsChangedEvent {
    pub session: String,
    pub area: String,
}

/// Terminal outcome of an in-app account login flow (today: the Codex OAuth flow,
/// whose completion arrives asynchronously as `account/login/completed` on the
/// dedicated login server — the Claude flow completes synchronously on its command).
/// NOT session-keyed: accounts are app-global. `error` is present when `success` is
/// false and a reason is known.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct AccountLoginEvent {
    pub backend: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Coalesced filesystem change notification for the editor panel: the (de-noised,
/// debounced) set of paths that changed under the watched working directory. The
/// UI reloads any open file in this set and refreshes any expanded tree dirs it
/// touches. Not session-keyed: there is a single active watch (the shown cwd).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct FsChangeEvent {
    pub paths: Vec<String>,
}

/// The filesystem watcher backend hit an error and live updates may have stopped.
/// Surfaced so the editor panel can show a discreet "file watching interrupted"
/// hint instead of silently going stale. Not session-keyed (single active watch).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct FsWatchErrorEvent {
    pub message: String,
}

/// A chunk of output from an integrated terminal's PTY, base64-encoded. Base64
/// (not a `number[]` or a per-chunk lossy string) keeps the byte stream exact and
/// compact — xterm's own decoder reassembles UTF-8 sequences split across chunks.
/// Keyed by the terminal `id` so the front routes it to the right xterm instance.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TerminalOutputEvent {
    pub id: String,
    pub data: String,
}

/// An integrated terminal's shell exited (EOF on the PTY). One-shot, keyed by id;
/// the front marks that terminal done and offers to restart it on re-open.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TerminalExitEvent {
    pub id: String,
}

/// Bridges a session's [`SessionEmitter`] sink onto the Tauri event bus: each
/// session event becomes the matching tauri-specta event on the `AppHandle`.
pub struct TauriEmitter {
    pub app: tauri::AppHandle,
}

/// Emit a tauri-specta event, logging (never swallowing) a failed emit. `emit` only
/// errors if the event bus / window is gone — but a DROPPED error item (a
/// `control_error` / `is_error` / `process_exited` notice rides `emit_item`) would
/// be a silent loss, so it must at least leave a trace.
fn emit_logged<E: Event + Clone + Serialize>(app: &tauri::AppHandle, name: &str, ev: E) {
    if let Err(e) = ev.emit(app) {
        eprintln!("[ipc] failed to emit {name} event: {e}");
    }
}

impl SessionEmitter for TauriEmitter {
    fn emit_state(&self, session: &str, state: &SessionStatePayload) {
        emit_logged(&self.app, "session_state", SessionStateEvent {
            session: session.to_string(),
            state: state.clone(),
        });
    }

    fn emit_item(&self, session: &str, item: &ConversationItem) {
        emit_logged(&self.app, "session_message", SessionMessageEvent {
            session: session.to_string(),
            item: item.clone(),
        });
    }

    fn emit_permission(&self, session: &str, request: &PermissionRequestPayload) {
        emit_logged(&self.app, "session_permission", SessionPermissionEvent {
            session: session.to_string(),
            request: request.clone(),
        });
    }

    fn emit_permission_resolved(&self, session: &str, resolved: &PermissionResolvedPayload) {
        emit_logged(&self.app, "session_permission_resolved", SessionPermissionResolvedEvent {
            session: session.to_string(),
            request_id: resolved.request_id.clone(),
        });
    }

    fn emit_commands(&self, session: &str, commands: &[SlashCommand]) {
        emit_logged(&self.app, "session_commands", SessionCommandsEvent {
            session: session.to_string(),
            commands: commands.to_vec(),
        });
    }

    fn emit_task(&self, session: &str, task: &BackgroundTask) {
        emit_logged(&self.app, "session_task", SessionTaskEvent {
            session: session.to_string(),
            task: task.clone(),
        });
    }

    fn emit_title(&self, session: &str, title: &str, seq: u32) {
        emit_logged(&self.app, "session_title", SessionTitleEvent {
            session: session.to_string(),
            title: title.to_string(),
            seq,
        });
    }

    fn emit_summary(&self, session: &str, summary: &str, seq: u32) {
        emit_logged(&self.app, "session_summary", SessionSummaryEvent {
            session: session.to_string(),
            summary: summary.to_string(),
            seq,
        });
    }

    fn emit_remote_control(&self, session: &str, state: &RemoteControlState) {
        emit_logged(&self.app, "session_remote_control", SessionRemoteControlEvent {
            session: session.to_string(),
            state: state.clone(),
        });
    }

    fn emit_codex_plan_usage(&self, session: &str, usage: &PlanUsage) {
        emit_logged(&self.app, "session_codex_plan_usage", SessionCodexPlanUsageEvent {
            session: session.to_string(),
            usage: usage.clone(),
        });
    }

    fn emit_extensions_changed(&self, session: &str, area: &str) {
        emit_logged(&self.app, "session_extensions_changed", SessionExtensionsChangedEvent {
            session: session.to_string(),
            area: area.to_string(),
        });
    }
}

/// Emit the app-global [`AccountLoginEvent`] — used by the account commands (the Codex
/// login completes asynchronously in a watcher task holding only an `AppHandle`).
pub fn emit_account_login(
    app: &tauri::AppHandle,
    backend: &str,
    success: bool,
    error: Option<String>,
) {
    emit_logged(app, "account_login", AccountLoginEvent {
        backend: backend.to_string(),
        success,
        error,
    });
}
