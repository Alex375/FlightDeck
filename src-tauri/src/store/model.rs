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

/// One discovered candidate address for a paired server — as printed in the pairing
/// ticket's `addresses` array (see the "1 · Run this once on your server" command in
/// `RemoteServersGroup`, `ControlSection.tsx`) or typed by hand. `Public` is reserved
/// for a future discovery step (e.g. a public IP behind NAT) — nothing populates it
/// yet, but the wire shape carries it so a later change is additive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    Tailscale,
    Lan,
    Public,
    Manual,
}

/// See [`AddressKind`]. One entry of [`MachineRecord::addresses`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AddressCandidate {
    pub kind: AddressKind,
    pub value: String,
}

/// A remote host (a "server") reached over SSH, on which repos can live and their
/// conversations run their `claude`. The alpha "machine boundary": Flight Deck owns
/// the connection coordinates so a user adds a server from the UI without editing any
/// SSH config by hand. Deliberately holds NO secret — only a pointer to a key file on
/// this Mac (`identity_file`), never the key material itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MachineRecord {
    pub id: String,
    /// Human label shown in the UI (e.g. "my-vps").
    pub label: String,
    /// Hostname or IP reachable from this Mac. The address pairing (or the user)
    /// confirmed as WORKING — the one [`super::db::Store::upsert_machine`] persists
    /// after a successful probe, and what `RemoteTarget` connects with today (see
    /// `supervisor::transport`).
    pub host: String,
    /// SSH port (usually 22).
    pub port: u16,
    /// SSH user to log in as.
    pub user: String,
    /// Absolute path to the PRIVATE key file (on this Mac) Flight Deck authenticates
    /// with — typically the dedicated key it generated for this server. `None` falls
    /// back to the user's default SSH keys / agent.
    pub identity_file: Option<String>,
    /// Unix ms timestamp the server was added.
    pub added_at: i64,
    /// Every address candidate pairing discovered (or the user typed) for this server
    /// — Tailscale name, LAN IP, hostname, … — including `host` itself. Carried for a
    /// later task (A6) to rotate through on a failed reconnect; today only `host` is
    /// actually dialed. Defaults to an empty `Vec` for a pre-migration row or one whose
    /// stored JSON fails to decode — never an error, since a missing/corrupt address
    /// list must degrade to "just `host`", not break the machine (see
    /// [`super::db::Store::machine_by_id`]).
    #[serde(default)]
    pub addresses: Vec<AddressCandidate>,
}

/// A working folder a conversation can be opened in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoRecord {
    pub id: String,
    /// Absolute path of the folder. For a remote repo (`machine_id` set) this is the
    /// path ON THAT SERVER.
    pub path: String,
    /// Unix ms timestamp the repo was first added.
    pub added_at: i64,
    /// When set, this repo lives on a REMOTE server (FK to [`MachineRecord::id`]): its
    /// conversations spawn `claude` on that machine over SSH, and `path` is a path on
    /// it. `None` (every pre-existing row and every local folder) is the unchanged
    /// local case — the whole app treats a NULL `machine_id` exactly as before. See
    /// the SSH transport in `supervisor::transport`. NB `upsert_repo` PRESERVES an
    /// existing non-null value when a caller passes `None`, so a rename/undo can never
    /// blank a repo's remoteness.
    pub machine_id: Option<String>,
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

/// A TOSSE project pinned to one of the app's local folders.
///
/// The CRM has no field for a machine path (and a path on this Mac would be
/// meaningless on a colleague's), so the association only ever lives here. Keyed by
/// the PROJECT rather than by the task: every task of a project resolves to the same
/// working folder, so the question is asked once and answered for all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TosseProjectRepo {
    /// The CRM project id. Deliberately NOT a foreign key — it belongs to another
    /// system, so nothing local can enforce it.
    pub project_id: String,
    /// FK to [`RepoRecord::id`] — the local folder. Cascades away with the repo.
    pub repo_id: String,
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
    /// The TOSSE task this conversation was opened on, when it was started from the
    /// tasks view ("Start" / "Discuss"). `None` for every conversation created any
    /// other way — which is most of them, and stays the unchanged default.
    ///
    /// It is what makes a second click REOPEN the conversation instead of starting a
    /// second agent on the same task.
    pub tosse_task_id: Option<String>,
    /// The task's title and status AS THEY WERE when the link was made, refreshed
    /// whenever the CRM is reachable.
    ///
    /// ⚠️ Denormalised on purpose. The id ALONE leaves a linked conversation mute
    /// offline — no title to name the task, and no status at all — while the delete
    /// warning is a function of precisely that status. Storing the id only would mean
    /// the warning silently stops warning the moment the network is down.
    pub tosse_task_title: Option<String>,
    pub tosse_task_status: Option<String>,
    /// Which Claude account this conversation runs on — a [`ClaudeAccountRecord::id`],
    /// or `None` for the default (un-scoped) account. `None` is every pre-existing row and
    /// stays the default for a single-account user, so nothing changes for them.
    ///
    /// Deliberately not a foreign key: the id names a credential store the CLI owns, so an
    /// account signed out or removed behind our back must leave the conversation usable
    /// (it degrades to the default account, visibly) rather than break the row. Codex
    /// conversations ignore it entirely — accounts are a Claude-side concept.
    pub claude_account_id: Option<String>,
}

/// One Claude account the user signed into from the app. Holds NO secret: the credentials
/// live in the CLI's own store, isolated per account by
/// [`crate::accounts::AccountSlot`]. What is persisted here is the non-sensitive identity
/// captured at login, which is what lets the Accounts panel label each account reliably —
/// the CLI's own `auth status` reads its email from a profile cache our accounts SHARE, so
/// it cannot be trusted to name a specific one (see `accounts::status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ClaudeAccountRecord {
    /// Stable app-minted id (a uuid), also the directory name of the account's isolated
    /// credential store. The reserved value `"default"` is the CLI's own un-scoped store.
    pub id: String,
    /// What the user sees. Defaults to the email captured at login, and is editable so two
    /// accounts on the same address (personal / org) stay tellable apart.
    pub label: String,
    pub email: Option<String>,
    pub org_name: Option<String>,
    /// `max` | `pro` | … as the CLI reported it at login.
    pub subscription_type: Option<String>,
    /// Manual display order (ascending). Also the tie-break the auto-switch policy uses
    /// when two accounts have equal capacity, so the choice is deterministic.
    pub sort_index: i64,
    /// Unix ms timestamp the account was added.
    pub added_at: i64,
    /// `true` while `label` is still the placeholder minted at creation, `false` once the
    /// user has named the account. Recorded as a FACT so the identity captured after
    /// sign-in replaces only a placeholder — guessing from the text ("starts with
    /// `Account `") would silently overwrite a real name like "Account manager".
    pub label_is_generated: bool,
}

impl ClaudeAccountRecord {
    /// Fold an identity read from `claude auth status` right after THIS account signed in
    /// into the record. The email replaces the label only while the label is still the
    /// generated placeholder; a name the user chose is theirs to keep. Pure, so the rule is
    /// unit-tested rather than living inside an IPC command.
    pub fn apply_captured_identity(
        &mut self,
        email: Option<String>,
        org_name: Option<String>,
        subscription_type: Option<String>,
    ) {
        if self.label_is_generated {
            if let Some(e) = email.as_deref().filter(|e| !e.trim().is_empty()) {
                self.label = e.to_string();
                // Still not something the user typed — a later capture (another sign-in)
                // may refresh it again.
            }
        }
        self.email = email;
        self.org_name = org_name;
        self.subscription_type = subscription_type;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(label: &str, generated: bool) -> ClaudeAccountRecord {
        ClaudeAccountRecord {
            id: "a".into(),
            label: label.into(),
            email: None,
            org_name: None,
            subscription_type: None,
            sort_index: 1,
            added_at: 0,
            label_is_generated: generated,
        }
    }

    #[test]
    fn a_generated_label_is_replaced_by_the_captured_email() {
        let mut r = record("Account 2", true);
        r.apply_captured_identity(Some("a@b.c".into()), Some("Org".into()), Some("max".into()));
        assert_eq!(r.label, "a@b.c");
        assert_eq!(r.email.as_deref(), Some("a@b.c"));
        assert_eq!(r.subscription_type.as_deref(), Some("max"));
    }

    /// The regression the flag exists for: a user-chosen name that merely LOOKS like a
    /// placeholder must survive a sign-in.
    #[test]
    fn a_user_chosen_label_is_kept_even_if_it_looks_generated() {
        let mut r = record("Account manager", false);
        r.apply_captured_identity(Some("a@b.c".into()), None, None);
        assert_eq!(r.label, "Account manager");
        assert_eq!(r.email.as_deref(), Some("a@b.c"), "the identity is still recorded");
    }

    #[test]
    fn no_email_leaves_a_generated_label_in_place() {
        let mut r = record("Account 2", true);
        r.apply_captured_identity(None, None, None);
        assert_eq!(r.label, "Account 2");
        r.apply_captured_identity(Some("   ".into()), None, None);
        assert_eq!(r.label, "Account 2", "a blank email is not an identity");
    }
}

/// The full persisted snapshot the UI hydrates from at boot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PersistedState {
    /// Remote servers the user has paired, so the UI can list them and mark which
    /// repos are remote at boot.
    #[serde(default)]
    pub machines: Vec<MachineRecord>,
    /// Claude accounts the user signed into, so the composer's account control and the
    /// Accounts panel are populated at boot without a round-trip.
    #[serde(default)]
    pub claude_accounts: Vec<ClaudeAccountRecord>,
    pub repos: Vec<RepoRecord>,
    pub conversations: Vec<ConversationRecord>,
    /// Stable id of the conversation that was active when last persisted.
    pub active_id: Option<String>,
}
