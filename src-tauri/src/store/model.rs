//! Domain records for persisted conversation metadata.
//!
//! These are the types the rest of the core and the IPC layer speak — plain
//! data, no SQL. [`super::db::Store`] is the ONLY place that maps them to and
//! from SQLite rows, so the storage schema can change (or the engine be swapped)
//! without touching a single caller. Field names are snake_case so they mirror
//! the SQL columns and the existing IPC payloads (`SessionStatePayload`); the
//! front maps them to its camelCase domain model at the one persistence boundary.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A working folder a conversation can be opened in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoRecord {
    pub id: String,
    pub path: String,
    /// Unix ms timestamp the repo was first added.
    pub added_at: i64,
}

/// A repo together with the TOSSE repository the user pinned it to, if any.
///
/// ⚠️ Kept OUT of [`RepoRecord`] deliberately. `upsert_repo` rewrites that record
/// wholesale, and every caller of it (adding a folder, renaming, restoring an undo)
/// knows nothing about TOSSE — carrying the field there would let any of them blank
/// a link the user set. The association is written only by its own dedicated call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoTosseLink {
    pub repo_id: String,
    pub path: String,
    /// The CRM repository id, or `None` when the user never pinned one.
    pub tosse_repository_id: Option<String>,
}

/// A conversation's persisted metadata.
///
/// The stable `id` is the identity the whole app keys off. It is deliberately
/// distinct from the ephemeral live session handle (`session-N`), which is
/// in-memory only and never persisted — so other services can reference a
/// conversation by an id that survives restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConversationRecord {
    pub id: String,
    pub name: String,
    /// FK to [`RepoRecord::id`].
    pub repo_id: String,
    /// Absolute path the session was spawned in.
    pub cwd: String,
    /// Unix ms timestamp the conversation was created.
    pub created_at: i64,
    /// Unix ms timestamp of the conversation's last activity — the last message
    /// sent OR received. Drives the sidebar's most-recent-first ordering. Bumped
    /// by the UI on each user send and turn result; pre-existing rows (created
    /// before this column) are backfilled from the transcript mtime at boot (see
    /// [`super::db::Store::backfill_last_activity`]).
    pub last_activity_at: i64,
    /// Claude's own session UUID (from system/init) — used for `--resume`.
    pub session_id: Option<String>,
    /// Which agent backend drives this conversation: `"claude"` (default) or
    /// `"codex"`. Chosen at creation and immutable after — the whole app keys its
    /// per-conversation behaviour (transport, message normalisation, composer
    /// controls, usage ring) off it. Pre-existing rows (created before this column)
    /// decode as `"claude"` via a `COALESCE` in the loader, so no conversation ever
    /// silently changes backend. A non-optional `String` because every conversation
    /// always has exactly one backend (unlike the optional controls below).
    pub backend: String,
    /// Per-conversation controls, persisted so they survive a restart and are
    /// re-applied at the next (lazy) spawn. While a session is LIVE its own state
    /// (get_settings / system/init) is the source of truth; these hold the
    /// last-known values to restore from. `None`/`false` fall back to the product
    /// defaults at spawn (opus / xhigh / default).
    ///
    /// `model` is the CLI alias chosen in the UI (e.g. "opus"); `effort` is one of
    /// low/medium/high/xhigh; `ultracode` is the separate xhigh+orchestration tier;
    /// `permission_mode` is one of the CLI modes (default/plan/acceptEdits/auto/…).
    pub model: Option<String>,
    pub effort: Option<String>,
    pub ultracode: bool,
    pub permission_mode: Option<String>,
    /// Per-conversation "clean output" display preference (fold each response's
    /// intermediate work behind one "Travail de Claude" block, keep only the
    /// concluding message in clear). Deliberately a TRISTATE: `None` means "inherit
    /// the global default" (the app-level display pref), while `Some(true)`/
    /// `Some(false)` is an explicit per-conversation override the user set from the
    /// composer chip. This is the one display pref that is per-conversation rather
    /// than global, so it lives with the other persisted controls above. Pre-existing
    /// rows (created before this column) are NULL → they follow the global default,
    /// preserving the prior single-flag behaviour with no re-grant.
    pub clean_output: Option<bool>,
    /// An unacknowledged, non-blocking status reminder to re-surface across
    /// restarts: `"review"` (a turn finished and was never seen), `"error"` (the
    /// last turn ended in error), or `"openQuestion"` (the heuristic flagged the
    /// last turn as a question awaiting a reply). `None` once acknowledged ("Vu")
    /// or superseded by the next message. Blocking states (a pending permission or
    /// questionnaire) are deliberately NOT persisted — they only exist while the
    /// process is live and must be answered in the thread. Mirrors the dismissable
    /// part of the derived `AgentStatus` (see the front's `agent/status.ts`), the
    /// single thing that, when off, can't be re-derived from the on-disk transcript.
    pub pending_reminder: Option<String>,
}

/// The full persisted snapshot the UI hydrates from at boot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PersistedState {
    pub repos: Vec<RepoRecord>,
    pub conversations: Vec<ConversationRecord>,
    /// Stable id of the conversation that was active when last persisted.
    pub active_id: Option<String>,
}
