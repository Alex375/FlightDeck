//! SQLite persistence — the ONE service in the core that speaks SQL.
//!
//! Everything outside this file deals in domain records ([`super::model`]),
//! never in rows or queries. Swapping the storage engine, or reshaping the
//! schema, means rewriting this file and nothing else — callers and the IPC
//! contract are insulated from it.
//!
//! Schema changes go through a versioned migration runner ([`Store::migrate`]):
//! each entry in [`MIGRATIONS`] is applied once, in order, inside a transaction,
//! and bumps the database's `user_version`. Migrations preserve data — additive
//! `ALTER TABLE` / backfill, never a `DROP` that loses user rows on a schema
//! change. [`Store::wipe_all`] stays a MANUAL escape hatch only (the Settings
//! "drop all" button); it is never triggered by a schema change.
//!
//! SQLite itself is compiled into the binary (`rusqlite` `bundled` feature), so
//! there is nothing to install and no system dependency.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::model::{
    validate_address_value, validate_ssh_port, validate_ssh_user, AddressCandidate, ClaudeAccountRecord,
    ConversationRecord, MachineRecord, PersistedState, RepoRecord, RepoTosseLink, TosseProjectRepo,
};
// `AddressKind` itself is only named directly in this module's tests (production code
// here only ever moves `AddressCandidate` values around, never matches on their
// `kind`), so it's imported test-only to avoid an unused-import warning on a normal
// build.
#[cfg(test)]
use super::model::AddressKind;

/// The current schema version. Drives the versioned migration runner: on open, a
/// database is brought up to this version by applying every migration in
/// [`MIGRATIONS`] whose target exceeds its stored `user_version`. Always equal to
/// `MIGRATIONS.len()` (checked at compile time below).
const SCHEMA_VERSION: i64 = 16;
const ACTIVE_ID_KEY: &str = "active_id";

/// A single schema migration: a forward, data-preserving step. It receives the
/// open connection (already inside the runner's per-migration transaction) and
/// applies its DDL.
type Migration = fn(&Connection) -> rusqlite::Result<()>;

/// Ordered, APPEND-ONLY list of migrations. Index `i` migrates the schema from
/// version `i` to version `i + 1`; the runner ([`Store::migrate`]) applies every
/// migration whose target version exceeds the database's `user_version`, each in
/// its own transaction. NEVER reorder, delete, or edit a shipped entry — only
/// append. Editing the past would desync databases already migrated in the field.
///
/// Migration bodies must be ADDITIVE and idempotent: `CREATE TABLE IF NOT EXISTS`
/// and `add_column_if_absent` (guarded `ALTER TABLE ... ADD COLUMN`) / backfill —
/// never a `DROP` that loses user rows. A non-additive change (rename / retype /
/// drop) needs SQLite's table-rebuild dance, which requires `PRAGMA foreign_keys`
/// OFF — and that pragma is a NO-OP inside a transaction. Since the runner wraps
/// each migration in one, such a migration must toggle foreign-key enforcement
/// outside it; do not assume you can flip it from inside a `migrate_vN` body.
const MIGRATIONS: &[Migration] = &[
    migrate_v1,
    migrate_v2,
    migrate_v3,
    migrate_v4,
    migrate_v5,
    migrate_v6,
    migrate_v7,
    migrate_v8,
    migrate_v9,
    migrate_v10,
    migrate_v11,
    migrate_v12,
    migrate_v13,
    migrate_v14,
    migrate_v15,
    migrate_v16,
];

// SCHEMA_VERSION and the migration list must agree, or version bookkeeping drifts.
const _: () = assert!(MIGRATIONS.len() == SCHEMA_VERSION as usize);

/// Owns the single SQLite connection. Held behind a `Mutex` because `rusqlite`
/// is synchronous and writes are tiny and rare (create/rename/delete only), so a
/// short critical section never contends with the hot path.
pub struct Store {
    conn: Mutex<Connection>,
}

/// Whether `table` already has a column named `column` (via `PRAGMA table_info`).
/// Makes the additive `last_activity_at` migration idempotent across reopens.
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        // PRAGMA table_info columns: (cid, name, type, notnull, dflt_value, pk).
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Run `ddl` (an `ALTER TABLE ... ADD COLUMN`) only when `column` is absent. Keeps
/// each additive migration idempotent across reopens, and tolerant of the
/// pre-versioned-runner history where some columns shipped without a version bump
/// (so a database may already carry a column its recorded version predates).
fn add_column_if_absent(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> rusqlite::Result<()> {
    if !column_exists(conn, table, column)? {
        conn.execute(ddl, [])?;
    }
    Ok(())
}

/// Decode a `machines.addresses` column value into its `Vec<AddressCandidate>` (see
/// [`migrate_v12`]). `NULL` (every pre-migration row) decodes to an empty `Vec` —
/// exactly like a corrupt/unparseable value, since a row this app never wrote is
/// indistinguishable from one it wrote badly, and both must degrade the SAME way
/// (never an error: a machine must still load with just its `host`). A decode
/// failure is logged rather than silently dropped, so a real corruption is
/// diagnosable instead of just quietly vanishing.
fn decode_addresses(raw: Option<String>) -> Vec<AddressCandidate> {
    match raw {
        None => Vec::new(),
        Some(json) => serde_json::from_str(&json).unwrap_or_else(|e| {
            eprintln!("[store] failed to decode machines.addresses ({json:?}): {e}");
            Vec::new()
        }),
    }
}

/// Encode a machine's addresses for the `machines.addresses` column — the inverse of
/// [`decode_addresses`]. An empty `Vec` is stored as `NULL` rather than `"[]"`, so a
/// machine with no recorded candidates round-trips through the SAME `NULL` a
/// pre-migration row already has, instead of gaining a distinct-but-equivalent
/// on-disk representation.
fn encode_addresses(addresses: &[AddressCandidate]) -> Option<String> {
    if addresses.is_empty() {
        None
    } else {
        // A `Vec<AddressCandidate>` of plain strings/enums always serializes — no
        // fallible content (no maps with non-string keys, no NaN floats) — so this
        // can't realistically fail; `unwrap_or_default` keeps a write from panicking
        // over a theoretical serde bug rather than losing the whole machine record.
        Some(serde_json::to_string(addresses).unwrap_or_default())
    }
}

/// [`validate_address_value`] over `m.host` and every `m.addresses` value, plus
/// [`validate_ssh_user`] over `m.user` and [`validate_ssh_port`] over `m.port` — the
/// persistence-layer half of the ssh-option-injection guard (see
/// [`Store::upsert_machine`]). This is the LAST line of defense: even if every
/// upstream caller somehow forgot to check `user`/`port` (the CRM holistic-review
/// blocker this closes — `user` was validated NOWHERE before this), a write that
/// would let a future `ssh` invocation parse it as an option, or persist an
/// unconnectable port, never reaches the row.
fn validate_machine_addresses(m: &MachineRecord) -> Result<(), String> {
    validate_address_value(&m.host)?;
    for c in &m.addresses {
        validate_address_value(&c.value)?;
    }
    validate_ssh_user(&m.user)?;
    validate_ssh_port(m.port)?;
    Ok(())
}

/// v1 — the initial schema: a key/value `meta` table, `repos`, and the
/// `conversations` metadata. `IF NOT EXISTS` so it stays safe even if a legacy
/// database already has these tables but reports `user_version < 1`.
fn migrate_v1(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS repos (
             id       TEXT PRIMARY KEY,
             path     TEXT NOT NULL,
             added_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS conversations (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
             cwd        TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             session_id TEXT
         );",
    )
}

/// v2 — sidebar recency (`last_activity_at`) plus per-conversation controls
/// (`model` / `effort` / `ultracode` / `permission_mode`). Every `ADD COLUMN` is
/// guarded because `last_activity_at` originally shipped under v1 WITHOUT a version
/// bump, so a database marked v1 may already carry it.
fn migrate_v2(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "last_activity_at",
        "ALTER TABLE conversations ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "model",
        "ALTER TABLE conversations ADD COLUMN model TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "effort",
        "ALTER TABLE conversations ADD COLUMN effort TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "ultracode",
        "ALTER TABLE conversations ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "permission_mode",
        "ALTER TABLE conversations ADD COLUMN permission_mode TEXT",
    )?;
    Ok(())
}

/// v3 — a persisted, acknowledgeable status reminder (review / error /
/// open-question) so it re-surfaces after a restart even though the live process
/// is gone. Defaults to NULL (nothing pending).
fn migrate_v3(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "pending_reminder",
        "ALTER TABLE conversations ADD COLUMN pending_reminder TEXT",
    )
}

/// v4 — the per-conversation "clean output" display preference. NULLABLE with no
/// default (NULL, not 0): a NULL means "inherit the global default", so every
/// pre-existing conversation keeps following the app-level pref exactly as it did
/// when the flag was global — no behaviour change, no re-grant. `Some(true)` /
/// `Some(false)` is an explicit override the user sets per conversation.
fn migrate_v4(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "clean_output",
        "ALTER TABLE conversations ADD COLUMN clean_output INTEGER",
    )
}

/// v5 — the conversation's agent backend (`"claude"` or `"codex"`). NULLABLE with
/// no default: a NULL means `"claude"` (the loader COALESCEs it), so every
/// pre-existing conversation stays on Claude with no re-grant and no data change.
/// New conversations always write a concrete value. Chosen at creation, immutable
/// after — it is the discriminant the whole two-backend architecture keys off.
fn migrate_v5(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "backend",
        "ALTER TABLE conversations ADD COLUMN backend TEXT",
    )
}

/// v6 — the TOSSE repository a local folder is pinned to, when the user picked one
/// by hand. NULL (the default for every existing row) means "no manual choice": the
/// app then derives the link from the folder's git remote, so nothing changes for a
/// user who never opens the feature — or who never connects to TOSSE at all.
///
/// It lives in SQLite rather than in the `tosse:display` localStorage prefs because
/// it records a decision about a repository, not a display preference: it must
/// survive a settings reset and belongs next to the row it qualifies.
///
/// ⚠️ Deliberately NOT a foreign key: the id belongs to another system (the CRM's
/// database), so nothing local can enforce it, and a repository deleted server-side
/// must degrade to "the repository you picked is gone" rather than corrupt the row.
fn migrate_v6(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "repos",
        "tosse_repository_id",
        "ALTER TABLE repos ADD COLUMN tosse_repository_id TEXT",
    )
}

/// v7 — the TOSSE task a conversation was started on, plus that task's title and
/// status as they stood when the link was made. NULL (every existing row) means the
/// conversation was not started from the tasks view, which is the unchanged default.
///
/// The two denormalised columns are not a cache for speed: they are what keeps a
/// linked conversation legible with no network. The delete warning is a function of
/// the task's STATUS, so storing the id alone would make that warning quietly stop
/// warning while offline — see [`super::model::ConversationRecord::tosse_task_title`].
///
/// ⚠️ Deliberately NOT foreign keys: the ids belong to the CRM's database, so nothing
/// local can enforce them, and a task deleted server-side must degrade to a stale
/// title rather than corrupt the row.
fn migrate_v7(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "conversations",
        "tosse_task_id",
        "ALTER TABLE conversations ADD COLUMN tosse_task_id TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "tosse_task_title",
        "ALTER TABLE conversations ADD COLUMN tosse_task_title TEXT",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "tosse_task_status",
        "ALTER TABLE conversations ADD COLUMN tosse_task_status TEXT",
    )?;
    Ok(())
}

/// v8 — which local folder a TOSSE PROJECT's work happens in.
///
/// Its own table rather than a column, because the key is a CRM project id: there is
/// no local row it could hang off (a project may resolve to a folder the CRM knows
/// nothing about, and most of them — 15 of 26 measured on real data — resolve to
/// none at all until the user points at one).
///
/// Keyed by project, not by task: every task of a project is worked on in the same
/// folder, so the question is asked once. `ON DELETE CASCADE` on `repo_id` means
/// removing a folder from Flight Deck takes its project pins with it, instead of
/// leaving rows pointing at a repo that no longer exists.
fn migrate_v8(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tosse_project_repos (
             project_id TEXT PRIMARY KEY,
             repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE
         );",
    )
}

/// v9 — a repo that lives on a REMOTE host reached over SSH. `ssh_target` holds the
/// SSH destination (a `~/.ssh/config` alias or `user@host`) whose `claude` runs this
/// repo's conversations; the existing `path` column becomes the path ON THAT HOST.
/// NULL (every existing row, and every local folder) means "local", so nothing
/// changes for a user who never adds a remote server — the "machine boundary",
/// SSH-first (see `supervisor::transport`). Additive + guarded, like every column
/// migration above.
fn migrate_v9(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "repos",
        "ssh_target",
        "ALTER TABLE repos ADD COLUMN ssh_target TEXT",
    )
}

/// v10 — the "machine boundary": a `machines` table (paired remote servers) and a
/// `repos.machine_id` FK. A repo with a non-null `machine_id` lives on that server and
/// runs its conversations there over SSH (superseding the raw `ssh_target` string from
/// v9, now vestigial — additive discipline: we don't drop it). NULL machine_id = local
/// (every existing row), so nothing changes for a user with no remote server. The
/// machines row holds connection coordinates only — never key material.
fn migrate_v10(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS machines (
             id            TEXT PRIMARY KEY,
             label         TEXT NOT NULL,
             host          TEXT NOT NULL,
             port          INTEGER NOT NULL,
             user          TEXT NOT NULL,
             identity_file TEXT,
             added_at      INTEGER NOT NULL
         );",
    )?;
    // No inline REFERENCES on the added column: SQLite's ALTER TABLE ADD COLUMN is
    // fussy about FK clauses across versions, so the machine→repos cascade is enforced
    // in `delete_machine` instead (delete the machine's repos first). NULL = local.
    add_column_if_absent(
        conn,
        "repos",
        "machine_id",
        "ALTER TABLE repos ADD COLUMN machine_id TEXT",
    )
}

/// v11 — multiple Claude accounts. `claude_accounts` lists the accounts the user signed
/// into from the app, and `conversations.claude_account_id` records which one a
/// conversation runs on.
///
/// Deliberately NOT a foreign key (same discipline as the TOSSE ids in v6/v7): the row is
/// a label for a credential store the CLI owns, so an account removed out from under us
/// must DEGRADE the conversation (it falls back to the default account, visibly) rather
/// than cascade-delete it or wedge the insert. No secret is ever stored here — only the
/// non-sensitive identity metadata captured at login, which is what lets the Accounts
/// panel label a slot without trusting the CLI's shared profile cache (see
/// `accounts::status`). NULL `claude_account_id` = the default, un-scoped account, which
/// is every pre-existing row: a single-account user sees no change at all.
fn migrate_v11(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_accounts (
             id                 TEXT PRIMARY KEY,
             label              TEXT NOT NULL,
             email              TEXT,
             org_name           TEXT,
             subscription_type  TEXT,
             sort_index         INTEGER NOT NULL DEFAULT 0,
             added_at           INTEGER NOT NULL,
             -- 1 while the label is still the placeholder minted at creation, 0 once the
             -- user has named the account. Recorded as a FACT rather than re-derived from
             -- the text: guessing by prefix would silently overwrite a real name like
             -- \"Account manager\" the first time the identity is captured.
             label_is_generated INTEGER NOT NULL DEFAULT 1
         );",
    )?;
    // Idempotent for a database created by an earlier build of this same migration (this
    // schema version has never shipped, but a dev machine may already carry the v11 table).
    add_column_if_absent(
        conn,
        "claude_accounts",
        "label_is_generated",
        "ALTER TABLE claude_accounts ADD COLUMN label_is_generated INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_absent(
        conn,
        "conversations",
        "claude_account_id",
        "ALTER TABLE conversations ADD COLUMN claude_account_id TEXT",
    )
}

/// v12 — the full set of candidate addresses discovered (or typed) for a paired
/// server, alongside its single `host`. `addresses` holds a JSON-encoded
/// `Vec<AddressCandidate>` (see [`super::model::AddressCandidate`]) — a JSON blob
/// rather than its own table because it is small, always read/written as a whole
/// alongside its machine, and never queried by value. NULL (every pre-existing row)
/// decodes to an empty `Vec` everywhere it's read (never an error — see
/// [`decode_addresses`]), so a machine paired before this column existed keeps
/// working exactly as it did: `RemoteTarget.addresses` falls back to `[host]` at the
/// one construction site that needs a non-empty list (`spawn_session`).
fn migrate_v12(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(conn, "machines", "addresses", "ALTER TABLE machines ADD COLUMN addresses TEXT")
}

/// v13 — daemon-relay metadata for a paired server: its `flightdeckd whoami` identity
/// (`daemon_mac_id` / `daemon_relay_url` / `daemon_label`, mirroring
/// [`crate::bootstrap::server_setup::ServerIdentity`]) and when the mobile relay was
/// last provisioned for it (`phone_provisioned_at`, Unix ms). All four NULLABLE with no
/// default: NULL (every pre-existing row, and every machine whose daemon round trip
/// hasn't run yet) means "not known yet", not "empty" — the same degrade-gracefully
/// discipline as `machines.addresses` in v12. Written only by the dedicated
/// [`Store::set_machine_daemon_identity`] / [`Store::set_machine_phone_provisioned_at`]
/// setters, never by the wholesale [`Store::upsert_machine`] (see that function's doc).
fn migrate_v13(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(conn, "machines", "daemon_mac_id", "ALTER TABLE machines ADD COLUMN daemon_mac_id TEXT")?;
    add_column_if_absent(
        conn,
        "machines",
        "daemon_relay_url",
        "ALTER TABLE machines ADD COLUMN daemon_relay_url TEXT",
    )?;
    add_column_if_absent(conn, "machines", "daemon_label", "ALTER TABLE machines ADD COLUMN daemon_label TEXT")?;
    add_column_if_absent(
        conn,
        "machines",
        "phone_provisioned_at",
        "ALTER TABLE machines ADD COLUMN phone_provisioned_at INTEGER",
    )
}

/// v14 — durable queues for a phone token revocation that could not be delivered
/// immediately (C10: provisioning/revoking the phone token on every paired daemon,
/// plus the relay connection this Mac itself dials). Both are small, append-mostly
/// queues, never joined against anything, so a dedicated table each (rather than a
/// JSON blob on `machines`) keeps `Store::queue_*`/`clear_*` simple UPSERT/DELETEs.
///
/// `pending_relay_phone_revocations` — a token [`Store::set_remote`]'s
/// regenerate-pairing path queued for `{type:"revoke_phone"}` on THIS Mac's own
/// outbound relay connection (see `appmcp::relay::post_connect_frames`) but that
/// hadn't gone out yet (remote access was off, or the socket wasn't up at the
/// moment of regeneration). One row per outstanding token; no `machine_id` — this
/// Mac's connection is the only "node" it applies to.
///
/// `pending_daemon_phone_revocations` — the same idea per PAIRED SERVER: a token
/// `Store::delete_machine`/regenerate-pairing tried to `flightdeckd remove-phone`
/// on a machine that was unreachable at that moment. Composite key
/// `(machine_id, token)` — several tokens can be queued for the same machine (a
/// user who regenerates twice while a server is down), and the same token can be
/// queued for several machines independently.
///
/// Neither table is a foreign key to `machines` (same discipline as every other
/// machine-adjacent table in this schema — see [`migrate_v10`]'s doc): a queued
/// daemon revocation is deleted by [`Store::delete_machine`] in code, not by a
/// cascade.
fn migrate_v14(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pending_relay_phone_revocations (
             token      TEXT PRIMARY KEY,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pending_daemon_phone_revocations (
             machine_id TEXT NOT NULL,
             token      TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (machine_id, token)
         );",
    )
}

/// v15 — the `origin` of a repo that lives on a paired server, read OVER THERE.
///
/// A folder on this Mac has its remote read on every call (a local `git` is instant);
/// a folder on a server costs an SSH round trip, on a path the sidebar calls at load.
/// So the answer is cached here and the probe runs in the background — matching is
/// then instant, and it still WORKS with the server switched off, which is the whole
/// point of persisting rather than memoising.
///
/// Two columns, not one: `remote_origin_probed_at` says whether we ever LOOKED, and
/// `remote_origin_url` what we found. A single nullable url would make "never asked"
/// and "asked, this repo has no origin" the same row — the distinction this feature's
/// every other surface is built to keep (see `tosse::resolve_links`). An empty string
/// as a sentinel would be the same collapse, spelled differently.
///
/// Only ever written for a repo with a `machine_id`. A local folder's url is not
/// cached: reading it is free, and a stale cache could only invent a wrong match.
fn migrate_v15(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "repos",
        "remote_origin_url",
        "ALTER TABLE repos ADD COLUMN remote_origin_url TEXT",
    )?;
    add_column_if_absent(
        conn,
        "repos",
        "remote_origin_probed_at",
        "ALTER TABLE repos ADD COLUMN remote_origin_probed_at INTEGER",
    )
}

/// v16 — WHAT the server answered, when it did not hand over a url.
///
/// v15 kept two states ("never looked" / "looked, here is the url or the absence of
/// one"), and the sweep threw away everything else: a folder that is not a repository
/// over there, one whose directory is gone, a server with no `git` at all. Those are
/// FIRM answers, and dropping them left `remote_origin_probed_at` NULL — the field that
/// means "we could not ask". The card then blamed the server's reachability for a
/// folder the server had answered about perfectly well, and offered "try again once the
/// server is reachable", advice that could never work.
///
/// So this column carries the answer itself, verbatim and small: `no-remote`,
/// `not-a-repository`, `gone`, `no-git`, or NULL when a url WAS read. `probed_at` is now
/// stamped for every one of them — it means "we asked", which is true in all these
/// cases — while `remote_origin_url` is left untouched by the non-url answers, so an
/// unmounted folder does not lose the url it had.
fn migrate_v16(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_absent(
        conn,
        "repos",
        "remote_origin_note",
        "ALTER TABLE repos ADD COLUMN remote_origin_note TEXT",
    )
}

/// Bridge databases created before the versioned runner. They tracked the schema
/// in `meta.schema_version` and left `user_version` at 0; seed `user_version` from
/// that marker ONCE so already-applied migrations are not re-run. A brand-new
/// database (no `meta` table yet) and a database already on the runner
/// (`user_version != 0`) are both left untouched. Safe even if the seed is wrong:
/// every migration body is idempotent.
fn bridge_legacy_version(conn: &Connection) -> rusqlite::Result<()> {
    let user_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != 0 {
        return Ok(());
    }
    let has_meta = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_meta {
        return Ok(());
    }
    let legacy: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse().ok());
    if let Some(version) = legacy {
        conn.execute_batch(&format!("PRAGMA user_version = {version};"))?;
    }
    Ok(())
}

impl Store {
    /// Open (creating if absent) the database at `path` and run migrations.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// In-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        // WAL: durable + lets a reader run concurrently with the (rare) writer.
        // foreign_keys ON so deleting a repo cascades to its conversations.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    /// Bring the database up to [`SCHEMA_VERSION`] by applying every migration in
    /// [`MIGRATIONS`] whose target version exceeds the stored `user_version`. Each
    /// migration runs in its own transaction and bumps `user_version` atomically
    /// with its DDL, so a crash mid-migration rolls back BOTH (no half-applied
    /// schema). Re-running on an up-to-date database is a no-op.
    fn migrate(&self) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();

        // Seed `user_version` from the legacy `meta.schema_version` marker once, so
        // databases created before the versioned runner skip already-applied steps.
        bridge_legacy_version(&conn)?;

        let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        for (i, migration) in MIGRATIONS.iter().enumerate() {
            let target = i as i64 + 1;
            if current >= target {
                continue;
            }
            let tx = conn.transaction()?;
            migration(&tx)?;
            // `user_version` lives in the db header and commits with the DDL.
            // `target` is a trusted i64, so the format! interpolation is injection-safe
            // (pragma values cannot be bound parameters).
            tx.execute_batch(&format!("PRAGMA user_version = {target};"))?;
            tx.commit()?;
        }
        Ok(())
    }

    /// The full snapshot the UI hydrates from at boot. Repos are ordered by when
    /// they were added, conversations by creation time. Display order is the
    /// front's concern: the sidebar re-sorts conversations by `last_activity_at`
    /// (most recent first) — this is just a stable initial array.
    pub fn load_state(&self) -> rusqlite::Result<PersistedState> {
        let conn = self.conn.lock().unwrap();

        let mut machines_stmt = conn.prepare(
            "SELECT id, label, host, port, user, identity_file, added_at, addresses,
                    daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at
             FROM machines ORDER BY added_at ASC",
        )?;
        let machines = machines_stmt
            .query_map([], |row| {
                Ok(MachineRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    user: row.get(4)?,
                    identity_file: row.get(5)?,
                    added_at: row.get(6)?,
                    // NULL (pre-v12 rows) / a corrupt value both decode to `[]` — see
                    // `decode_addresses`.
                    addresses: decode_addresses(row.get(7)?),
                    // NULL (pre-v13 rows, or a machine whose daemon round trip hasn't
                    // run yet) → None everywhere below.
                    daemon_mac_id: row.get(8)?,
                    daemon_relay_url: row.get(9)?,
                    daemon_label: row.get(10)?,
                    phone_provisioned_at: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut repos_stmt = conn
            .prepare("SELECT id, path, added_at, machine_id FROM repos ORDER BY added_at ASC")?;
        let repos = repos_stmt
            .query_map([], |row| {
                Ok(RepoRecord {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    added_at: row.get(2)?,
                    // NULL (pre-v10 rows + every local folder) → None (local).
                    machine_id: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut conv_stmt = conn.prepare(
            "SELECT id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                    model, effort, ultracode, permission_mode, pending_reminder, clean_output,
                    COALESCE(backend, 'claude'),
                    tosse_task_id, tosse_task_title, tosse_task_status, claude_account_id
             FROM conversations ORDER BY created_at ASC",
        )?;
        let conversations = conv_stmt
            .query_map([], |row| {
                Ok(ConversationRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    repo_id: row.get(2)?,
                    cwd: row.get(3)?,
                    created_at: row.get(4)?,
                    last_activity_at: row.get(5)?,
                    session_id: row.get(6)?,
                    model: row.get(7)?,
                    effort: row.get(8)?,
                    ultracode: row.get(9)?,
                    permission_mode: row.get(10)?,
                    pending_reminder: row.get(11)?,
                    clean_output: row.get(12)?,
                    // NULL (pre-v5 rows) is COALESCEd to "claude" in SQL above.
                    backend: row.get(13)?,
                    tosse_task_id: row.get(14)?,
                    tosse_task_title: row.get(15)?,
                    tosse_task_status: row.get(16)?,
                    // NULL (pre-v11 rows + every single-account setup) → the default account.
                    claude_account_id: row.get(17)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut acc_stmt = conn.prepare(
            "SELECT id, label, email, org_name, subscription_type, sort_index, added_at,
                    label_is_generated
             FROM claude_accounts ORDER BY sort_index ASC, added_at ASC",
        )?;
        let claude_accounts = acc_stmt
            .query_map([], |row| {
                Ok(ClaudeAccountRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    email: row.get(2)?,
                    org_name: row.get(3)?,
                    subscription_type: row.get(4)?,
                    sort_index: row.get(5)?,
                    added_at: row.get(6)?,
                    label_is_generated: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let active_id = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![ACTIVE_ID_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        Ok(PersistedState {
            machines,
            claude_accounts,
            repos,
            conversations,
            active_id,
        })
    }

    /// Insert or update a repo (idempotent by id).
    ///
    /// `machine_id` (a repo's remoteness) is written on insert but, on update, is
    /// PRESERVED when the incoming value is NULL: `COALESCE(excluded.machine_id,
    /// repos.machine_id)`. Callers that rewrite the record wholesale but know nothing
    /// about remoteness (rename, undo, add-a-folder) pass `None` and so can never
    /// blank a repo the user connected to a server — mirroring the deliberate care
    /// around the TOSSE link. To move a repo to another server, pass the new id; to
    /// make it local again, delete and re-add (no un-remote path exists, by design).
    pub fn upsert_repo(&self, repo: &RepoRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO repos (id, path, added_at, machine_id) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 path = excluded.path,
                 added_at = excluded.added_at,
                 machine_id = COALESCE(excluded.machine_id, repos.machine_id)",
            params![repo.id, repo.path, repo.added_at, repo.machine_id],
        )?;
        Ok(())
    }

    /// The remote server the repo at `path` lives on, when that repo is remote
    /// (`machine_id` set); `None` for a local repo or no match. Called at spawn so a
    /// conversation opened in a remote repo launches its `claude` on that server (see
    /// the `spawn_session` command). Keyed by `path` because that is what the spawn
    /// command receives (the conversation's cwd == the repo path for a remote repo;
    /// remote worktrees are out of scope for the SSH-first alpha).
    pub fn machine_for_repo_path(&self, path: &str) -> rusqlite::Result<Option<MachineRecord>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT m.id, m.label, m.host, m.port, m.user, m.identity_file, m.added_at, m.addresses,
                        m.daemon_mac_id, m.daemon_relay_url, m.daemon_label, m.phone_provisioned_at
                 FROM repos r JOIN machines m ON m.id = r.machine_id
                 WHERE r.path = ?1 AND r.machine_id IS NOT NULL LIMIT 1",
                params![path],
                |row| {
                    Ok(MachineRecord {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get(3)?,
                        user: row.get(4)?,
                        identity_file: row.get(5)?,
                        added_at: row.get(6)?,
                        addresses: decode_addresses(row.get(7)?),
                        daemon_mac_id: row.get(8)?,
                        daemon_relay_url: row.get(9)?,
                        daemon_label: row.get(10)?,
                        phone_provisioned_at: row.get(11)?,
                    })
                },
            )
            .optional()
    }

    /// For a conversation whose repo is REMOTE and which has already run there at
    /// least once: its `cwd`, its Claude `session_id` (the daemon's resume key), and
    /// the machine it runs on — everything [`crate::ipc::commands::
    /// push_remote_conversation_title`] (C9) needs to reach that daemon over SSH.
    /// `None` when the conversation is unknown, its repo isn't remote, or it has no
    /// `session_id` yet (never spawned there — nothing for the daemon to `--resume`).
    /// Mirrors [`Self::machine_for_repo_path`]'s shape, joined one hop further.
    pub fn remote_session_for_conversation(
        &self,
        conversation_id: &str,
    ) -> rusqlite::Result<Option<(String, String, MachineRecord)>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT c.cwd, c.session_id,
                        m.id, m.label, m.host, m.port, m.user, m.identity_file, m.added_at, m.addresses,
                        m.daemon_mac_id, m.daemon_relay_url, m.daemon_label, m.phone_provisioned_at
                 FROM conversations c
                 JOIN repos r ON r.id = c.repo_id
                 JOIN machines m ON m.id = r.machine_id
                 WHERE c.id = ?1 AND r.machine_id IS NOT NULL AND c.session_id IS NOT NULL
                 LIMIT 1",
                params![conversation_id],
                |row| {
                    let cwd: String = row.get(0)?;
                    let session_id: String = row.get(1)?;
                    let machine = MachineRecord {
                        id: row.get(2)?,
                        label: row.get(3)?,
                        host: row.get(4)?,
                        port: row.get(5)?,
                        user: row.get(6)?,
                        identity_file: row.get(7)?,
                        added_at: row.get(8)?,
                        addresses: decode_addresses(row.get(9)?),
                        daemon_mac_id: row.get(10)?,
                        daemon_relay_url: row.get(11)?,
                        daemon_label: row.get(12)?,
                        phone_provisioned_at: row.get(13)?,
                    };
                    Ok((cwd, session_id, machine))
                },
            )
            .optional()
    }

    /// Whether `conversation_id`'s repo is REMOTE (`machine_id` set) — cheaper and
    /// looser than [`Self::remote_session_for_conversation`] (no `session_id`
    /// requirement): used by [`crate::ipc::commands::publish_control_event`] (C9) to
    /// gate the app-control journal, which must never double-publish a phone-facing
    /// event for a conversation this Mac only RELAYS (its host `flightdeckd` daemon
    /// emits the same event on its own). `false` for an unknown conversation id —
    /// never silently drop an event for a conversation this call can't even place;
    /// only a CONFIRMED-remote one is gated.
    pub fn conversation_repo_is_remote(&self, conversation_id: &str) -> rusqlite::Result<bool> {
        let hit: Option<i64> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT 1
                 FROM conversations c
                 JOIN repos r ON r.id = c.repo_id
                 WHERE c.id = ?1 AND r.machine_id IS NOT NULL
                 LIMIT 1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(hit.is_some())
    }

    /// One remote server by id, or `None`.
    pub fn machine_by_id(&self, id: &str) -> rusqlite::Result<Option<MachineRecord>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, label, host, port, user, identity_file, added_at, addresses,
                        daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at
                 FROM machines WHERE id = ?1",
                params![id],
                |row| {
                    Ok(MachineRecord {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get(3)?,
                        user: row.get(4)?,
                        identity_file: row.get(5)?,
                        added_at: row.get(6)?,
                        addresses: decode_addresses(row.get(7)?),
                        daemon_mac_id: row.get(8)?,
                        daemon_relay_url: row.get(9)?,
                        daemon_label: row.get(10)?,
                        phone_provisioned_at: row.get(11)?,
                    })
                },
            )
            .optional()
    }

    /// One remote server whose (`host`, `port`, `user`) triple matches exactly, or
    /// `None` — the idempotency lookup [`crate::bootstrap::orchestrator::bootstrap_server`]
    /// runs BEFORE minting a fresh session/key, so re-running the bootstrap pipeline
    /// against an ALREADY-paired server updates that same row (reusing its `id` and
    /// `identity_file`) instead of duplicating it under a brand-new uuid every time
    /// (B11 review finding). Matches `host` literally (no DNS/IP normalization,
    /// exactly the string `add_machine`/the pipeline persisted it as) and returns the
    /// most recently added match when more than one somehow exists. See
    /// [`Self::machine_by_any_address`] for the broader lookup `add_machine`'s own
    /// legacy pairing flow uses, which also matches a machine's recorded `addresses`.
    pub fn machine_by_address(&self, host: &str, port: u16, user: &str) -> rusqlite::Result<Option<MachineRecord>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, label, host, port, user, identity_file, added_at, addresses,
                        daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at
                 FROM machines WHERE host = ?1 AND port = ?2 AND user = ?3
                 ORDER BY added_at DESC LIMIT 1",
                params![host, port, user],
                |row| {
                    Ok(MachineRecord {
                        id: row.get(0)?,
                        label: row.get(1)?,
                        host: row.get(2)?,
                        port: row.get(3)?,
                        user: row.get(4)?,
                        identity_file: row.get(5)?,
                        added_at: row.get(6)?,
                        addresses: decode_addresses(row.get(7)?),
                        daemon_mac_id: row.get(8)?,
                        daemon_relay_url: row.get(9)?,
                        daemon_label: row.get(10)?,
                        phone_provisioned_at: row.get(11)?,
                    })
                },
            )
            .optional()
    }

    /// The broader convergence lookup `add_machine`'s legacy ticket/manual pairing
    /// flow uses (B_lifecycle-#1 review finding): unlike [`Self::machine_by_address`],
    /// which only matches a machine's CURRENT `host` column, this also matches every
    /// value in a machine's recorded `addresses` (Tailscale name / LAN IP / hostname —
    /// see [`crate::ipc::commands::probe_candidates`]). Pairing the same physical
    /// server twice can legitimately resolve to a DIFFERENT working address the
    /// second time (candidates are tried in priority order and the first reachable
    /// one wins; a Tailscale name that answered before might time out while the LAN
    /// IP now does), so matching on `host` alone would still mint a duplicate row for
    /// a server that is, in fact, already paired.
    ///
    /// `candidates` is every address value THIS pairing attempt is willing to accept
    /// as "this host" (every candidate `add_machine` probed, not just the one that
    /// worked) — a match against ANY of an existing machine's own `host`/`addresses`
    /// converges. Matches literally, same discipline as `machine_by_address` (no DNS/IP
    /// normalization). `port`/`user` must still match exactly: a different port or a
    /// different login user is a different machine, never folded together. Returns the
    /// most recently added match when more than one somehow qualifies.
    pub fn machine_by_any_address(
        &self,
        candidates: &[String],
        port: u16,
        user: &str,
    ) -> rusqlite::Result<Option<MachineRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, host, port, user, identity_file, added_at, addresses,
                    daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at
             FROM machines WHERE port = ?1 AND user = ?2 ORDER BY added_at DESC",
        )?;
        let rows = stmt
            .query_map(params![port, user], |row| {
                Ok(MachineRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    user: row.get(4)?,
                    identity_file: row.get(5)?,
                    added_at: row.get(6)?,
                    addresses: decode_addresses(row.get(7)?),
                    daemon_mac_id: row.get(8)?,
                    daemon_relay_url: row.get(9)?,
                    daemon_label: row.get(10)?,
                    phone_provisioned_at: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for m in rows {
            let known_to_this_machine =
                std::iter::once(m.host.as_str()).chain(m.addresses.iter().map(|a| a.value.as_str()));
            if known_to_this_machine.into_iter().any(|known| candidates.iter().any(|c| c == known)) {
                return Ok(Some(m));
            }
        }
        Ok(None)
    }

    /// Insert or update a remote server (idempotent by id). Connection coordinates
    /// only — never key material (see [`MachineRecord`]). `addresses` round-trips
    /// through [`encode_addresses`]/[`decode_addresses`] as a JSON blob (see
    /// [`migrate_v12`]). Re-checks `host`/every `addresses` value/`user`/`port` through
    /// [`validate_machine_addresses`] before writing — the SAME ssh-option-injection
    /// guard `ipc::commands::add_machine` runs before ever probing, enforced again here
    /// so this invariant belongs to the boundary that actually owns it, not just to
    /// today's one caller.
    ///
    /// The four daemon-metadata fields (`daemon_mac_id`/`daemon_relay_url`/
    /// `daemon_label`/`phone_provisioned_at`) are PRESERVED on update when the incoming
    /// value is `None`: `COALESCE(excluded.x, machines.x)`, mirroring how
    /// [`Self::upsert_repo`] preserves `machine_id`. Every existing caller of this
    /// method (adding a server, a probe re-save) knows nothing about the daemon and
    /// always passes `None` for these — without the COALESCE, that wholesale rewrite
    /// would silently erase metadata the dedicated setters wrote. `addresses` is
    /// deliberately NOT preserved this way (see [`upsert_machine_round_trips_addresses`]
    /// in the test module): a full re-pairing OWNS the whole address list, unlike the
    /// daemon identity, which is populated by a separate, later step.
    pub fn upsert_machine(&self, m: &MachineRecord) -> rusqlite::Result<()> {
        validate_machine_addresses(m).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                e,
            )))
        })?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO machines (id, label, host, port, user, identity_file, added_at, addresses,
                                    daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                 label = excluded.label, host = excluded.host, port = excluded.port,
                 user = excluded.user, identity_file = excluded.identity_file,
                 addresses = excluded.addresses,
                 daemon_mac_id = COALESCE(excluded.daemon_mac_id, machines.daemon_mac_id),
                 daemon_relay_url = COALESCE(excluded.daemon_relay_url, machines.daemon_relay_url),
                 daemon_label = COALESCE(excluded.daemon_label, machines.daemon_label),
                 phone_provisioned_at = COALESCE(excluded.phone_provisioned_at, machines.phone_provisioned_at)",
            params![
                m.id,
                m.label,
                m.host,
                m.port,
                m.user,
                m.identity_file,
                m.added_at,
                encode_addresses(&m.addresses),
                m.daemon_mac_id,
                m.daemon_relay_url,
                m.daemon_label,
                m.phone_provisioned_at,
            ],
        )?;
        Ok(())
    }

    /// A6: persist the address a live session's reconnect loop just rotated onto and
    /// proved working (`fd_attach` confirmed) as this machine's new preferred `host` —
    /// so the NEXT spawn (a fresh conversation, a Mac restart, …) dials it FIRST
    /// instead of re-trying the dead one and re-paying the backoff every single time.
    /// A simple `UPDATE`, not the full `upsert_machine` (the caller — the session
    /// actor, via the IPC-layer emitter that owns the `Store` — has no other machine
    /// fields to hand and must not clobber them with stale/absent data).
    ///
    /// Re-validated through [`validate_address_value`] — the SAME ssh-option-injection
    /// guard every other write of `host`/`addresses` goes through (see
    /// [`Self::upsert_machine`]) — even though this value only ever comes from a
    /// machine's OWN already-validated `addresses` list, never fresh user input: a
    /// persistence-layer invariant should not depend on every caller upholding it.
    /// Returns the number of rows touched (0 if the machine was deleted concurrently),
    /// mirroring [`Self::set_repo_tosse_link`] — never an error for "nothing to update".
    pub fn set_machine_preferred_host(&self, id: &str, host: &str) -> rusqlite::Result<usize> {
        validate_address_value(host).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                e,
            )))
        })?;
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE machines SET host = ?2 WHERE id = ?1", params![id, host])
    }

    /// Store this machine's `flightdeckd whoami` identity — by convention the only
    /// writer of the three `daemon_*` columns ([`Self::upsert_machine`]'s COALESCE
    /// only keeps an incoming `None` from erasing what this sets; it does not stop a
    /// caller from setting these columns directly through `upsert_machine`, since
    /// every existing caller just happens to pass `None` for them). A focused UPDATE
    /// (not a re-upsert of the whole record) so a later caller (the C9 daemon-init
    /// flow) never needs to round-trip the rest of the [`MachineRecord`] just to
    /// attach the identity it just learned.
    /// Returns the number of rows touched, so the caller can tell "saved" from
    /// "that machine id doesn't exist" instead of reporting success either way.
    pub fn set_machine_daemon_identity(
        &self,
        id: &str,
        mac_id: &str,
        relay_url: &str,
        label: &str,
    ) -> rusqlite::Result<usize> {
        self.conn.lock().unwrap().execute(
            "UPDATE machines SET daemon_mac_id = ?2, daemon_relay_url = ?3, daemon_label = ?4
             WHERE id = ?1",
            params![id, mac_id, relay_url, label],
        )
    }

    /// Record when the mobile relay was (re)provisioned for this machine — by
    /// convention the only writer of `phone_provisioned_at` (same caveat as
    /// [`Self::set_machine_daemon_identity`]: the COALESCE in `upsert_machine`
    /// prevents erasure, not direct writes). Same focused-UPDATE discipline as
    /// [`Self::set_machine_daemon_identity`].
    pub fn set_machine_phone_provisioned_at(&self, id: &str, ts_ms: i64) -> rusqlite::Result<usize> {
        self.conn.lock().unwrap().execute(
            "UPDATE machines SET phone_provisioned_at = ?2 WHERE id = ?1",
            params![id, ts_ms],
        )
    }

    /// Remove a remote server and everything anchored to it. Deletes its repos first
    /// (which cascades to their conversations via the repos→conversations FK), then
    /// the machine row — the machine→repos cascade enforced in code (see
    /// [`migrate_v10`], which omits the column-level FK for ALTER-TABLE portability).
    pub fn delete_machine(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM repos WHERE machine_id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM pending_daemon_phone_revocations WHERE machine_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM machines WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Every paired remote server, oldest first — the same rows [`Self::load_state`]
    /// embeds in [`PersistedState`], as a standalone call for a caller (C10's
    /// `appmcp::provision`) that needs to iterate every machine without pulling in
    /// repos/conversations/accounts too.
    pub fn all_machines(&self) -> rusqlite::Result<Vec<MachineRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, host, port, user, identity_file, added_at, addresses,
                    daemon_mac_id, daemon_relay_url, daemon_label, phone_provisioned_at
             FROM machines ORDER BY added_at ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MachineRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    user: row.get(4)?,
                    identity_file: row.get(5)?,
                    added_at: row.get(6)?,
                    addresses: decode_addresses(row.get(7)?),
                    daemon_mac_id: row.get(8)?,
                    daemon_relay_url: row.get(9)?,
                    daemon_label: row.get(10)?,
                    phone_provisioned_at: row.get(11)?,
                })
            })?
            .collect();
        rows
    }

    /// Queue a phone token for `{type:"revoke_phone"}` on THIS Mac's own relay
    /// connection (see [`migrate_v14`]'s doc) — idempotent by token (re-queuing the
    /// same token just refreshes `created_at`), so a user who mashes "Regenerate"
    /// while offline never accumulates duplicate rows for the same secret.
    pub fn queue_relay_phone_revocation(&self, token: &str, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO pending_relay_phone_revocations (token, created_at) VALUES (?1, ?2)
             ON CONFLICT(token) DO UPDATE SET created_at = excluded.created_at",
            params![token, now_ms],
        )?;
        Ok(())
    }

    /// Every phone token still awaiting `revoke_phone` on this Mac's own relay
    /// connection — drained (best-effort, no delivery ack exists on the wire; see
    /// `appmcp::relay`'s module doc) on every reconnect via `RemoteConfig`.
    pub fn pending_relay_phone_revocations(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT token FROM pending_relay_phone_revocations ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?.collect();
        rows
    }

    /// Forget a token queued via [`Self::queue_relay_phone_revocation`] — called once
    /// it has actually been handed to a live relay connection to send.
    pub fn clear_relay_phone_revocation(&self, token: &str) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM pending_relay_phone_revocations WHERE token = ?1", params![token])?;
        Ok(())
    }

    /// Queue a phone token for `flightdeckd remove-phone` on one paired server,
    /// because it was unreachable when the revoke was first attempted (see
    /// [`migrate_v14`]'s doc and `appmcp::provision::revoke_phone_on_machine`).
    /// Idempotent by `(machine_id, token)`.
    pub fn queue_daemon_phone_revocation(&self, machine_id: &str, token: &str, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO pending_daemon_phone_revocations (machine_id, token, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(machine_id, token) DO UPDATE SET created_at = excluded.created_at",
            params![machine_id, token, now_ms],
        )?;
        Ok(())
    }

    /// Every phone token still awaiting `remove-phone` on this one machine —
    /// retried the next time that machine is successfully contacted (see
    /// `appmcp::provision::provision_phone_on_machine`).
    pub fn pending_daemon_phone_revocations(&self, machine_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT token FROM pending_daemon_phone_revocations WHERE machine_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![machine_id], |row| row.get::<_, String>(0))?.collect();
        rows
    }

    /// Forget a token queued via [`Self::queue_daemon_phone_revocation`] — called
    /// once that machine has confirmed the removal.
    pub fn clear_daemon_phone_revocation(&self, machine_id: &str, token: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM pending_daemon_phone_revocations WHERE machine_id = ?1 AND token = ?2",
            params![machine_id, token],
        )?;
        Ok(())
    }

    /// Every repo with the TOSSE repository it is pinned to, if any. Feeds the
    /// association matcher, which also needs `path` to read each folder's git remote.
    ///
    /// ⚠️ `machine_id` is part of the answer, not a detail: without it the caller reads
    /// every row as a folder on this Mac and probes a remote path with the local `git`
    /// — which fails indistinguishably from a deleted folder. The `LEFT JOIN` is what
    /// keeps a repo whose server was unpaired in the list (still remote, just unnamed)
    /// instead of dropping it from the association view entirely.
    pub fn repo_tosse_links(&self) -> rusqlite::Result<Vec<RepoTosseLink>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.path, r.tosse_repository_id, r.machine_id, m.label,
                    r.remote_origin_url, r.remote_origin_probed_at, r.remote_origin_note
             FROM repos r LEFT JOIN machines m ON m.id = r.machine_id
             ORDER BY r.added_at ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RepoTosseLink {
                    repo_id: row.get(0)?,
                    path: row.get(1)?,
                    tosse_repository_id: row.get(2)?,
                    machine_id: row.get(3)?,
                    machine_label: row.get(4)?,
                    remote_origin_url: row.get(5)?,
                    remote_origin_probed_at: row.get(6)?,
                    remote_origin_note: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Record what a SERVER answered for one repo's `origin`, and when we asked.
    ///
    /// `url: None` means the probe RAN and the repo has no origin — which is why the
    /// timestamp is written on both outcomes: it is the field that says we looked, and
    /// without it a repo with no origin would be re-probed on every single load.
    ///
    /// `note` carries a firm answer that is not a url (`no-remote`, `not-a-repository`,
    /// `gone`, `no-git`) so the UI can name the real situation instead of inferring one;
    /// `None` alongside a `Some(url)` means the url IS the answer. See [`migrate_v16`].
    ///
    /// Returns whether the folder's VISIBLE state changed — a moved url, a different
    /// answer, or the very first time this folder was ever probed. Not just "the url
    /// moved": a first sweep that finds no origin leaves the url at `None` while flipping
    /// `origin_read` from false to true, which is precisely the transition that takes
    /// "the server could not be reached" off the card. Reporting that as "nothing
    /// changed" left the wrong sentence on screen until something else happened to
    /// refetch.
    ///
    /// ⚠️ Like [`Self::set_repo_tosse_link`], the only writer of these columns, and kept
    /// out of `RepoRecord`: `upsert_repo` rewrites that record wholesale from callers
    /// (add a folder, rename, undo) that know nothing about a remote origin, and would
    /// blank a perfectly good cached answer.
    pub fn set_repo_remote_origin(
        &self,
        repo_id: &str,
        url: Option<&str>,
        note: Option<&str>,
        now_ms: i64,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let before: Option<(Option<String>, Option<i64>, Option<String>)> = conn
            .query_row(
                "SELECT remote_origin_url, remote_origin_probed_at, remote_origin_note
                   FROM repos WHERE id = ?1",
                params![repo_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (before_url, before_probed, before_note) = before.unwrap_or((None, None, None));
        // A non-url answer leaves the cached url ALONE: a folder that is unmounted right
        // now still has the origin it had, and blanking it would un-match a repository
        // for a reason that has nothing to do with its remote.
        match url {
            Some(_) => conn.execute(
                "UPDATE repos SET remote_origin_url = ?2, remote_origin_probed_at = ?3,
                                  remote_origin_note = ?4
                   WHERE id = ?1",
                params![repo_id, url, now_ms, note],
            )?,
            None if note.is_some() => conn.execute(
                "UPDATE repos SET remote_origin_probed_at = ?2, remote_origin_note = ?3
                   WHERE id = ?1",
                params![repo_id, now_ms, note],
            )?,
            // "The server answered, and this folder genuinely has no origin" — the one
            // case that clears a cached url, because it IS a statement about the remote.
            None => conn.execute(
                "UPDATE repos SET remote_origin_url = NULL, remote_origin_probed_at = ?2,
                                  remote_origin_note = ?3
                   WHERE id = ?1",
                params![repo_id, now_ms, note],
            )?,
        };
        let url_moved = url.is_some() && before_url.as_deref() != url;
        let cleared = url.is_none() && note.is_none() && before_url.is_some();
        Ok(url_moved || cleared || before_probed.is_none() || before_note.as_deref() != note)
    }

    /// Pin a repo to a TOSSE repository, or clear the pin with `None`.
    ///
    /// The ONLY writer of that column — see [`RepoTosseLink`] for why it is not part of
    /// the record `upsert_repo` writes. Returns the number of rows touched so the caller
    /// can tell "cleared" from "that repo does not exist" instead of reporting success.
    pub fn set_repo_tosse_link(
        &self,
        repo_id: &str,
        repository_id: Option<&str>,
    ) -> rusqlite::Result<usize> {
        self.conn.lock().unwrap().execute(
            "UPDATE repos SET tosse_repository_id = ?2 WHERE id = ?1",
            params![repo_id, repository_id],
        )
    }

    /// Every TOSSE project pinned to a local folder. The whole table in one read —
    /// there are a handful of rows at most, and the resolver needs all of them to
    /// answer "where does this task's project live" without a round-trip per task.
    pub fn tosse_project_repos(&self) -> rusqlite::Result<Vec<TosseProjectRepo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT project_id, repo_id FROM tosse_project_repos")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TosseProjectRepo {
                    project_id: row.get(0)?,
                    repo_id: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Pin a TOSSE project to a local folder, or forget the pin with `None`.
    ///
    /// Returns whether a row now exists for the project, so the caller can tell a
    /// stored pin from a write the database refused instead of reporting success.
    /// A pin to a repo that does not exist is rejected by the foreign key.
    pub fn set_tosse_project_repo(
        &self,
        project_id: &str,
        repo_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        match repo_id {
            Some(repo_id) => {
                conn.execute(
                    "INSERT INTO tosse_project_repos (project_id, repo_id) VALUES (?1, ?2)
                     ON CONFLICT(project_id) DO UPDATE SET repo_id = excluded.repo_id",
                    params![project_id, repo_id],
                )?;
                Ok(true)
            }
            None => {
                conn.execute(
                    "DELETE FROM tosse_project_repos WHERE project_id = ?1",
                    params![project_id],
                )?;
                Ok(false)
            }
        }
    }

    /// Delete a repo; its conversations cascade away via the FK.
    pub fn delete_repo(&self, id: &str) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM repos WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Insert or update a conversation (idempotent by id).
    pub fn upsert_conversation(&self, c: &ConversationRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO conversations
                 (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                  model, effort, ultracode, permission_mode, pending_reminder, clean_output, backend,
                  tosse_task_id, tosse_task_title, tosse_task_status, claude_account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
                 name              = excluded.name,
                 repo_id           = excluded.repo_id,
                 cwd               = excluded.cwd,
                 created_at        = excluded.created_at,
                 last_activity_at  = excluded.last_activity_at,
                 session_id        = excluded.session_id,
                 model             = excluded.model,
                 effort            = excluded.effort,
                 ultracode         = excluded.ultracode,
                 permission_mode   = excluded.permission_mode,
                 pending_reminder  = excluded.pending_reminder,
                 clean_output      = excluded.clean_output,
                 backend           = excluded.backend,
                 tosse_task_id     = excluded.tosse_task_id,
                 tosse_task_title  = excluded.tosse_task_title,
                 tosse_task_status = excluded.tosse_task_status",
            // ⚠️ `claude_account_id` is written on INSERT only, never in the UPDATE above:
            // `set_conversation_claude_account` is its SOLE updater (the same discipline as
            // `repos.tosse_repository_id`). The front re-upserts whole records on every
            // activity bump / rename / model change from an in-memory copy; were the column
            // in this SET list, a stale copy would silently write back an account id that
            // `delete_claude_account` had just detached — resurrecting a dangling reference
            // the spawner then refuses.
            params![
                c.id,
                c.name,
                c.repo_id,
                c.cwd,
                c.created_at,
                c.last_activity_at,
                c.session_id,
                c.model,
                c.effort,
                c.ultracode,
                c.permission_mode,
                c.pending_reminder,
                c.clean_output,
                c.backend,
                c.tosse_task_id,
                c.tosse_task_title,
                c.tosse_task_status,
                c.claude_account_id
            ],
        )?;
        Ok(())
    }

    /// List the Claude accounts, in display order. The default (un-scoped) account is NOT
    /// a row here — it always exists and needs no record; only accounts the user explicitly
    /// added get one.
    pub fn list_claude_accounts(&self) -> rusqlite::Result<Vec<ClaudeAccountRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, label, email, org_name, subscription_type, sort_index, added_at,
                    label_is_generated
             FROM claude_accounts ORDER BY sort_index ASC, added_at ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ClaudeAccountRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    email: row.get(2)?,
                    org_name: row.get(3)?,
                    subscription_type: row.get(4)?,
                    sort_index: row.get(5)?,
                    added_at: row.get(6)?,
                    label_is_generated: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Insert or update a Claude account (idempotent by id). Carries no secret — see
    /// [`ClaudeAccountRecord`].
    pub fn upsert_claude_account(&self, a: &ClaudeAccountRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO claude_accounts
                 (id, label, email, org_name, subscription_type, sort_index, added_at,
                  label_is_generated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 label              = excluded.label,
                 email              = excluded.email,
                 org_name           = excluded.org_name,
                 subscription_type  = excluded.subscription_type,
                 sort_index         = excluded.sort_index,
                 label_is_generated = excluded.label_is_generated",
            params![
                a.id,
                a.label,
                a.email,
                a.org_name,
                a.subscription_type,
                a.sort_index,
                a.added_at,
                a.label_is_generated
            ],
        )?;
        Ok(())
    }

    /// Remove a Claude account row and DETACH the conversations that referenced it, so
    /// they fall back to the default account instead of pointing at a store that no longer
    /// exists. Done in one transaction: a half-applied removal would leave conversations
    /// naming a vanished account, which the spawner could not honour and the UI could not
    /// explain. The credential store itself is cleared by `claude auth logout` before this
    /// is called — the CLI stays its sole owner.
    pub fn delete_claude_account(&self, id: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE conversations SET claude_account_id = NULL WHERE claude_account_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM claude_accounts WHERE id = ?1", params![id])?;
        tx.commit()
    }

    /// Point one conversation at a Claude account (`None` = the default account).
    pub fn set_conversation_claude_account(
        &self,
        conv_id: &str,
        account_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE conversations SET claude_account_id = ?2 WHERE id = ?1",
            params![conv_id, account_id],
        )?;
        Ok(())
    }

    /// Give every conversation that predates the `last_activity_at` column
    /// (sentinel value 0) a real timestamp, so historical conversations sort by
    /// true recency on the first run after the migration. `mtime` resolves a
    /// session id to its transcript file's mtime (Unix ms) — the best proxy for
    /// "time of the last message", since Claude rewrites the transcript on every
    /// message. Conversations with no transcript (or that never sent a message)
    /// fall back to `created_at`. A no-op on every later boot: new conversations
    /// always carry a real timestamp, so no row stays at the sentinel.
    ///
    /// The filesystem lookups run WITHOUT the connection lock held (read the
    /// sentinel rows, drop the guard, resolve mtimes, then re-lock to write).
    pub fn backfill_last_activity(
        &self,
        mtime: impl Fn(&str) -> Option<i64>,
    ) -> rusqlite::Result<()> {
        let pending: Vec<(String, Option<String>, i64)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, session_id, created_at FROM conversations WHERE last_activity_at = 0",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if pending.is_empty() {
            return Ok(());
        }
        let resolved: Vec<(String, i64)> = pending
            .into_iter()
            .map(|(id, session_id, created_at)| {
                let ts = session_id
                    .as_deref()
                    .and_then(|s| mtime(s))
                    .unwrap_or(created_at);
                (id, ts)
            })
            .collect();
        let conn = self.conn.lock().unwrap();
        for (id, ts) in resolved {
            conn.execute(
                "UPDATE conversations SET last_activity_at = ?1 WHERE id = ?2",
                params![ts, id],
            )?;
        }
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> rusqlite::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Persist (or clear) the active conversation's stable id.
    pub fn set_active(&self, id: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        match id {
            Some(id) => conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![ACTIVE_ID_KEY, id],
            )?,
            None => conn.execute("DELETE FROM meta WHERE key = ?1", params![ACTIVE_ID_KEY])?,
        };
        Ok(())
    }

    /// Read one app-level config value from the `meta` table (e.g. the voice
    /// bridge's `voice_bridge_*` keys). `None` when the key was never set.
    pub fn get_config(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        Ok(match rows.next()? {
            Some(row) => Some(row.get(0)?),
            None => None,
        })
    }

    /// Upsert one app-level config value into the `meta` table.
    pub fn set_config(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Wipe all user data: every repo, conversation, and the active selection.
    /// The schema and `schema_version` are kept. Dev escape hatch + the Settings
    /// "drop all" button.
    pub fn wipe_all(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch(
            "DELETE FROM conversations;
             DELETE FROM tosse_project_repos;
             DELETE FROM repos;
             DELETE FROM meta WHERE key = 'active_id';",
        )?;
        Ok(())
    }

    /// The database's on-disk schema version (`PRAGMA user_version`). The runner
    /// leaves it equal to [`SCHEMA_VERSION`] after a successful open.
    #[cfg(test)]
    fn schema_version(&self) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_at(id: &str, added_at: i64) -> RepoRecord {
        RepoRecord {
            id: id.into(),
            path: format!("/tmp/{id}"),
            added_at,
            machine_id: None,
        }
    }

    fn repo(id: &str) -> RepoRecord {
        repo_at(id, 1)
    }

    /// The v10 "machine boundary": pair a server, mark a repo remote, resolve it by
    /// path, keep the COALESCE guard, and cascade repos away when the server is removed.
    #[test]
    fn machines_pair_repos_resolve_and_cascade() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 2222,
            user: "agent".into(),
            identity_file: Some("/keys/id".into()),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();

        // A remote repo ON that server, and a plain local repo.
        let mut remote = repo_at("r-remote", 1);
        remote.path = "/work/demo".into();
        remote.machine_id = Some("m1".into());
        s.upsert_repo(&remote).unwrap();
        s.upsert_repo(&repo_at("r-local", 2)).unwrap();

        // Resolve remoteness by the path the spawn command receives.
        let got = s.machine_for_repo_path("/work/demo").unwrap().unwrap();
        assert_eq!((got.host.as_str(), got.port, got.user.as_str()), ("h.example", 2222, "agent"));
        assert!(s.machine_for_repo_path("/tmp/r-local").unwrap().is_none(), "local repo has no machine");

        // Machines hydrate into PersistedState.
        assert_eq!(s.load_state().unwrap().machines.len(), 1);

        // A wholesale re-upsert with machine_id=None must NOT blank the remoteness.
        let mut touch = repo_at("r-remote", 1);
        touch.path = "/work/demo".into();
        touch.machine_id = None;
        s.upsert_repo(&touch).unwrap();
        assert!(
            s.machine_for_repo_path("/work/demo").unwrap().is_some(),
            "None machine_id must be COALESCEd to the existing value"
        );

        // Un-pairing the server removes it AND its repos; local repos survive.
        s.delete_machine("m1").unwrap();
        assert!(s.machine_for_repo_path("/work/demo").unwrap().is_none());
        let after = s.load_state().unwrap();
        assert!(after.machines.is_empty());
        assert!(after.repos.iter().all(|r| r.id != "r-remote"), "remote repo gone with its server");
        assert!(after.repos.iter().any(|r| r.id == "r-local"), "local repo stays");
    }

    /// C9: [`Store::remote_session_for_conversation`] resolves a conversation's
    /// (cwd, session_id, machine) triple ONLY when all three conditions hold — remote
    /// repo, known session_id, conversation exists — and stays `None` for every other
    /// combination (local repo, never-spawned conversation, unknown id).
    #[test]
    fn remote_session_for_conversation_requires_a_remote_repo_and_a_known_session() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 2222,
            user: "agent".into(),
            identity_file: Some("/keys/id".into()),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();

        let mut remote = repo_at("r-remote", 1);
        remote.path = "/work/demo".into();
        remote.machine_id = Some("m1".into());
        s.upsert_repo(&remote).unwrap();
        s.upsert_repo(&repo_at("r-local", 2)).unwrap();

        // Remote repo, but no session_id yet (never spawned there): None.
        s.upsert_conversation(&conv("c-fresh", "r-remote", None)).unwrap();
        assert!(s.remote_session_for_conversation("c-fresh").unwrap().is_none());

        // Remote repo AND a session_id: resolves.
        s.upsert_conversation(&conv("c-live", "r-remote", Some("sid-1"))).unwrap();
        let (cwd, sid, machine) = s.remote_session_for_conversation("c-live").unwrap().unwrap();
        assert_eq!(cwd, "/tmp/r-remote");
        assert_eq!(sid, "sid-1");
        assert_eq!(machine.id, "m1");
        assert_eq!(machine.host, "h.example");

        // Local repo, even WITH a session_id: None (nothing remote to push to).
        s.upsert_conversation(&conv("c-local", "r-local", Some("sid-2"))).unwrap();
        assert!(s.remote_session_for_conversation("c-local").unwrap().is_none());

        // Unknown conversation id: None, no error.
        assert!(s.remote_session_for_conversation("no-such-conv").unwrap().is_none());
    }

    /// C9 journal gate: [`Store::conversation_repo_is_remote`] is looser than
    /// [`Store::remote_session_for_conversation`] — no `session_id` required, since
    /// even a conversation that hasn't produced one yet must still be gated the
    /// moment it's remote. Unknown ids read as `false` (never silently drop an
    /// event for a conversation this can't even place).
    #[test]
    fn conversation_repo_is_remote_needs_no_session_id() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
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
        };
        s.upsert_machine(&m).unwrap();
        let mut remote = repo_at("r-remote", 1);
        remote.machine_id = Some("m1".into());
        s.upsert_repo(&remote).unwrap();
        s.upsert_repo(&repo_at("r-local", 2)).unwrap();

        s.upsert_conversation(&conv("c-fresh", "r-remote", None)).unwrap();
        assert!(
            s.conversation_repo_is_remote("c-fresh").unwrap(),
            "remote even with no session_id yet",
        );

        s.upsert_conversation(&conv("c-local", "r-local", Some("sid-2"))).unwrap();
        assert!(!s.conversation_repo_is_remote("c-local").unwrap());

        assert!(!s.conversation_repo_is_remote("no-such-conv").unwrap());
    }

    /// v12 — a machine's full candidate address list round-trips through every reader
    /// (`machine_by_id`, `machine_for_repo_path`, `load_state`), not just the one that
    /// happens to be queried by whichever call site exercises it.
    #[test]
    fn upsert_machine_round_trips_addresses() {
        let s = Store::open_in_memory().unwrap();
        let addresses = vec![
            AddressCandidate { kind: AddressKind::Tailscale, value: "box.tailnet.ts.net".into() },
            AddressCandidate { kind: AddressKind::Lan, value: "192.168.1.5".into() },
        ];
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "box.tailnet.ts.net".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: addresses.clone(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();
        assert_eq!(s.machine_by_id("m1").unwrap().unwrap().addresses, addresses);

        let mut remote = repo_at("r1", 1);
        remote.path = "/work/demo".into();
        remote.machine_id = Some("m1".into());
        s.upsert_repo(&remote).unwrap();
        assert_eq!(s.machine_for_repo_path("/work/demo").unwrap().unwrap().addresses, addresses);

        assert_eq!(s.load_state().unwrap().machines[0].addresses, addresses);

        // Re-upserting with a DIFFERENT list must replace it, not merge/append —
        // ON CONFLICT sets `addresses = excluded.addresses` like every other column.
        let mut updated = m.clone();
        updated.addresses = vec![AddressCandidate { kind: AddressKind::Manual, value: "10.0.0.1".into() }];
        s.upsert_machine(&updated).unwrap();
        assert_eq!(s.machine_by_id("m1").unwrap().unwrap().addresses, updated.addresses);

        // And an empty list round-trips too (stored as NULL — see `encode_addresses`).
        let mut cleared = updated.clone();
        cleared.addresses = Vec::new();
        s.upsert_machine(&cleared).unwrap();
        assert!(s.machine_by_id("m1").unwrap().unwrap().addresses.is_empty());
    }

    /// [`Store::machine_by_address`] — the B11 orchestrator idempotency lookup —
    /// matches the exact (host, port, user) triple, ignores an unrelated machine, and
    /// reports `None` for a host never paired.
    #[test]
    fn machine_by_address_matches_the_exact_triple() {
        let s = Store::open_in_memory().unwrap();
        let m1 = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "1.2.3.4".into(),
            port: 22,
            user: "deploy".into(),
            identity_file: Some("/keys/m1".into()),
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        let mut m2 = m1.clone();
        m2.id = "m2".into();
        m2.port = 2222; // same host, different port — must NOT match.
        s.upsert_machine(&m1).unwrap();
        s.upsert_machine(&m2).unwrap();

        let found = s.machine_by_address("1.2.3.4", 22, "deploy").unwrap().expect("must find m1");
        assert_eq!(found.id, "m1");
        assert_eq!(found.identity_file.as_deref(), Some("/keys/m1"));

        assert!(s.machine_by_address("1.2.3.4", 2222, "deploy").unwrap().is_some());
        assert!(s.machine_by_address("1.2.3.4", 22, "someone-else").unwrap().is_none());
        assert!(s.machine_by_address("never-paired.example", 22, "deploy").unwrap().is_none());
    }

    /// [`Store::machine_by_any_address`] — the B_lifecycle-#1 review finding's
    /// convergence lookup for `add_machine`'s own legacy pairing flow — matches a
    /// candidate against a machine's RECORDED `addresses`, not just its current `host`.
    #[test]
    fn machine_by_any_address_matches_on_a_recorded_address_not_just_the_current_host() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "box.tailnet.ts.net".into(), // the address that answered LAST time
            port: 22,
            user: "deploy".into(),
            identity_file: Some("/keys/m1".into()),
            added_at: 1,
            addresses: vec![
                AddressCandidate { kind: AddressKind::Tailscale, value: "box.tailnet.ts.net".into() },
                AddressCandidate { kind: AddressKind::Lan, value: "192.168.1.5".into() },
            ],
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();

        // THIS attempt's working address is the LAN one, never tried as `host` before —
        // still converges on the same machine because it's in its recorded `addresses`.
        let found = s
            .machine_by_any_address(&["192.168.1.5".to_string()], 22, "deploy")
            .unwrap()
            .expect("must find m1 via its recorded LAN address");
        assert_eq!(found.id, "m1");

        // A candidate list with SEVERAL values, only one of which matches, still finds it.
        assert!(s
            .machine_by_any_address(&["unrelated.example".to_string(), "192.168.1.5".to_string()], 22, "deploy")
            .unwrap()
            .is_some());
    }

    /// Same (host, port) but a DIFFERENT user is a genuinely different login — never
    /// folded together, even though the address matches.
    #[test]
    fn machine_by_any_address_same_host_different_user_stays_separate() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "1.2.3.4".into(),
            port: 22,
            user: "root".into(),
            identity_file: None,
            added_at: 1,
            addresses: vec![AddressCandidate { kind: AddressKind::Manual, value: "1.2.3.4".into() }],
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();

        assert!(
            s.machine_by_any_address(&["1.2.3.4".to_string()], 22, "deploy").unwrap().is_none(),
            "a different SSH user must never converge on someone else's machine row",
        );
        // Same reasoning for a different port.
        assert!(s.machine_by_any_address(&["1.2.3.4".to_string()], 2222, "root").unwrap().is_none());
        // The real (host, port, user) still matches.
        assert!(s.machine_by_any_address(&["1.2.3.4".to_string()], 22, "root").unwrap().is_some());
    }

    #[test]
    fn machine_by_any_address_no_match_is_none_not_an_error() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.machine_by_any_address(&["never-paired.example".to_string()], 22, "deploy").unwrap().is_none());
    }

    /// The ssh-option-injection guard belongs to the persistence boundary, not just
    /// to `ipc::commands::add_machine` — a future write path (an "edit server" or
    /// "import machines" command) must not be able to reintroduce it just by skipping
    /// the IPC-layer check. `upsert_machine` re-validates `host` AND every
    /// `addresses` value before ever reaching SQLite.
    #[test]
    fn upsert_machine_rejects_an_unsafe_address_value() {
        let s = Store::open_in_memory().unwrap();
        let mut m = MachineRecord {
            id: "m1".into(),
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
        };

        m.host = "-oProxyCommand=evil".into();
        assert!(s.upsert_machine(&m).is_err(), "an unsafe host must be rejected before writing");
        assert!(
            s.machine_by_id("m1").unwrap().is_none(),
            "the rejected row must not land in the db"
        );

        m.host = "h.example".into();
        m.addresses = vec![AddressCandidate { kind: AddressKind::Lan, value: "has space".into() }];
        assert!(
            s.upsert_machine(&m).is_err(),
            "an unsafe value inside `addresses` must be rejected too, not just `host`"
        );
        assert!(s.machine_by_id("m1").unwrap().is_none());
    }

    /// CRM holistic-review blocker #3 (chantier A `bd7ca709`): `user` gets the SAME
    /// persistence-layer guard `host`/`addresses` already had — this is the last
    /// line of defense, so a future write path (an "edit server" command, an
    /// import) can't reintroduce the injection class just by skipping every
    /// upstream check.
    #[test]
    fn upsert_machine_rejects_an_unsafe_user_value() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 22,
            user: "-oProxyCommand=touch /tmp/pwned".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        assert!(s.upsert_machine(&m).is_err(), "an unsafe user must be rejected before writing");
        assert!(s.machine_by_id("m1").unwrap().is_none(), "the rejected row must not land in the db");
    }

    /// `port` gets the SAME persistence-layer guard `host`/`addresses`/`user` already
    /// have (review completeness finding on the ssh-injection fix): `port: 0` is never
    /// a real listener, so it must not be persisted undetected.
    #[test]
    fn upsert_machine_rejects_an_invalid_port() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 0,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        assert!(s.upsert_machine(&m).is_err(), "port 0 must be rejected before writing");
        assert!(s.machine_by_id("m1").unwrap().is_none(), "the rejected row must not land in the db");
    }

    /// A machines row that fails `validate_ssh_user` on READ (an older app version
    /// that never had the check, or a manual DB edit) must NOT crash or vanish — the
    /// row is written directly via raw SQL here, bypassing `upsert_machine`'s own
    /// guard, to simulate exactly that legacy state. `machine_by_id`/`all_machines`
    /// never validate on read (by design — see their own docs), so both must still
    /// return the row intact; it is up to a CONNECT attempt (`Transport::spawn`,
    /// `ipc::commands::spawn_session`, `bootstrap::orchestrator::diagnose`, …) to
    /// surface the typed, actionable error instead — proven at those call sites'
    /// own test suites (`supervisor::transport`'s
    /// `spawn_refuses_a_legacy_row_with_an_invalid_user_without_spawning_ssh`).
    #[test]
    fn a_legacy_row_with_an_invalid_user_loads_intact_never_vanishes_or_panics() {
        let s = Store::open_in_memory().unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO machines (id, label, host, port, user, identity_file, added_at, addresses)
                 VALUES ('legacy1', 'old box', 'h.example', 22, '-oProxyCommand=touch /tmp/pwned', NULL, 1, NULL)",
                [],
            )
            .unwrap();

        let loaded = s.machine_by_id("legacy1").unwrap();
        assert!(loaded.is_some(), "a legacy row with an invalid user must still load, not vanish");
        assert_eq!(loaded.unwrap().user, "-oProxyCommand=touch /tmp/pwned");

        let all = s.all_machines().unwrap();
        assert_eq!(all.len(), 1, "the row must still be listed");
    }

    /// A6: a rotation that wins persists the new `host`, round-tripping through
    /// `machine_by_id` — and other fields (`label`, `port`, `addresses`, …) are left
    /// untouched, since this is a targeted `UPDATE`, not a full `upsert_machine`.
    #[test]
    fn set_machine_preferred_host_round_trips_through_machine_by_id() {
        let s = Store::open_in_memory().unwrap();
        let addresses = vec![
            AddressCandidate { kind: AddressKind::Manual, value: "203.0.113.1".into() },
            AddressCandidate { kind: AddressKind::Lan, value: "192.168.1.5".into() },
        ];
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "203.0.113.1".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: addresses.clone(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&m).unwrap();

        let touched = s.set_machine_preferred_host("m1", "192.168.1.5").unwrap();
        assert_eq!(touched, 1);
        let after = s.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(after.host, "192.168.1.5");
        // Untouched: label/port/addresses survive the targeted UPDATE.
        assert_eq!(after.label, "vps");
        assert_eq!(after.port, 22);
        assert_eq!(after.addresses, addresses);

        // A machine that no longer exists: 0 rows touched, never an error.
        assert_eq!(s.set_machine_preferred_host("gone", "10.0.0.1").unwrap(), 0);
    }

    /// A6: the same ssh-option-injection guard `upsert_machine` enforces on `host`
    /// applies to this narrower write too — a targeted `UPDATE` is still a write path
    /// that could otherwise reintroduce the injection class [`validate_address_value`]
    /// closes.
    #[test]
    fn set_machine_preferred_host_rejects_an_unsafe_value() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
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
        };
        s.upsert_machine(&m).unwrap();

        assert!(s.set_machine_preferred_host("m1", "-oProxyCommand=evil").is_err());
        assert_eq!(
            s.machine_by_id("m1").unwrap().unwrap().host,
            "h.example",
            "the rejected value must not land in the db"
        );
    }

    /// v12 — a row from BEFORE the `addresses` column existed (`ALTER TABLE ADD
    /// COLUMN` leaves every pre-existing row NULL) must load with an empty `Vec`, not
    /// an error — the whole point of [`decode_addresses`] treating NULL as "no
    /// candidates recorded yet" rather than a decode failure.
    #[test]
    fn pre_migration_machines_row_reads_addresses_as_empty_vec() {
        let tmp = TempDb::new("machines-v12-premigration");
        // The v10 `machines` shape, pre-dating the v12 `addresses` column. With the
        // marker bridged to 11, the runner skips every migration up to and including
        // v11 (already applied) and runs the later ones — v12/v13 on `machines`, and
        // v15 on `repos`, which is why that table is seeded too: a real database left
        // by an older app has always had it (v1 creates it), so leaving it out made
        // the fixture describe a state that cannot exist.
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (
                id       TEXT PRIMARY KEY,
                path     TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE machines (
                id            TEXT PRIMARY KEY,
                label         TEXT NOT NULL,
                host          TEXT NOT NULL,
                port          INTEGER NOT NULL,
                user          TEXT NOT NULL,
                identity_file TEXT,
                added_at      INTEGER NOT NULL
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '11');
            INSERT INTO machines (id, label, host, port, user, identity_file, added_at)
                VALUES ('m1', 'vps', 'h.example', 22, 'agent', NULL, 1);
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "marker 11 bridged, v12 applied");
        let m = store.machine_by_id("m1").unwrap().expect("pre-migration row still loads");
        assert!(m.addresses.is_empty(), "NULL addresses decodes to empty, never an error");
        assert_eq!(m.host, "h.example", "every pre-existing column is untouched");
    }

    /// v12's `ALTER TABLE ... ADD COLUMN` is guarded by `add_column_if_absent` like
    /// every other additive migration — reopening an already-migrated db (a second app
    /// launch) must not error, re-add the column, or disturb the row.
    #[test]
    fn migrate_v12_reopen_is_idempotent() {
        let tmp = TempDb::new("machines-v12-idempotent");
        let addresses =
            vec![AddressCandidate { kind: AddressKind::Lan, value: "192.168.1.9".into() }];
        {
            let store = tmp.open();
            store
                .upsert_machine(&MachineRecord {
                    id: "m1".into(),
                    label: "vps".into(),
                    host: "192.168.1.9".into(),
                    port: 22,
                    user: "agent".into(),
                    identity_file: None,
                    added_at: 1,
                    addresses: addresses.clone(),
                    daemon_mac_id: None,
                    daemon_relay_url: None,
                    daemon_label: None,
                    phone_provisioned_at: None,
                })
                .unwrap();
        }
        let store = tmp.open(); // second open over an already-migrated db
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        assert_eq!(store.machine_by_id("m1").unwrap().unwrap().addresses, addresses);
    }

    /// v13 — a machine's daemon-relay metadata (identity + phone-provisioning
    /// timestamp) round-trips through every reader (`machine_by_id`,
    /// `machine_for_repo_path`, `load_state`), mirroring `upsert_machine_round_trips_addresses`.
    #[test]
    fn machine_daemon_metadata_round_trips() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
            label: "vps".into(),
            host: "h.example".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: Some("mac-abc".into()),
            daemon_relay_url: Some("https://relay.example/".into()),
            daemon_label: Some("josty-cc".into()),
            phone_provisioned_at: Some(12_345),
        };
        s.upsert_machine(&m).unwrap();
        let got = s.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(got.daemon_mac_id, m.daemon_mac_id);
        assert_eq!(got.daemon_relay_url, m.daemon_relay_url);
        assert_eq!(got.daemon_label, m.daemon_label);
        assert_eq!(got.phone_provisioned_at, m.phone_provisioned_at);

        let mut remote = repo_at("r1", 1);
        remote.path = "/work/demo".into();
        remote.machine_id = Some("m1".into());
        s.upsert_repo(&remote).unwrap();
        let via_repo = s.machine_for_repo_path("/work/demo").unwrap().unwrap();
        assert_eq!(via_repo.daemon_mac_id, m.daemon_mac_id);
        assert_eq!(via_repo.daemon_relay_url, m.daemon_relay_url);
        assert_eq!(via_repo.daemon_label, m.daemon_label);
        assert_eq!(via_repo.phone_provisioned_at, m.phone_provisioned_at);

        let loaded = s.load_state().unwrap();
        assert_eq!(loaded.machines[0].daemon_mac_id, m.daemon_mac_id);
        assert_eq!(loaded.machines[0].daemon_relay_url, m.daemon_relay_url);
        assert_eq!(loaded.machines[0].daemon_label, m.daemon_label);
        assert_eq!(loaded.machines[0].phone_provisioned_at, m.phone_provisioned_at);
    }

    /// v13 — a row from BEFORE the daemon-metadata columns existed (`ALTER TABLE ADD
    /// COLUMN` leaves every pre-existing row NULL) must load with `None` for all four
    /// fields, never an error — the same degrade-gracefully discipline as v12's
    /// `addresses` (see `pre_migration_machines_row_reads_addresses_as_empty_vec`).
    #[test]
    fn pre_migration_machines_row_reads_daemon_metadata_as_none() {
        let tmp = TempDb::new("machines-v13-premigration");
        // The v12 `machines` shape (addresses column present), pre-dating v13. Marker
        // bridged to 12 so the runner skips every migration up to and including v12
        // (already applied) and runs the later ones — v13 on `machines`, and v15 on
        // `repos`, seeded here for the same reason as the v12 fixture above.
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (
                id       TEXT PRIMARY KEY,
                path     TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE machines (
                id            TEXT PRIMARY KEY,
                label         TEXT NOT NULL,
                host          TEXT NOT NULL,
                port          INTEGER NOT NULL,
                user          TEXT NOT NULL,
                identity_file TEXT,
                added_at      INTEGER NOT NULL,
                addresses     TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '12');
            INSERT INTO machines (id, label, host, port, user, identity_file, added_at, addresses)
                VALUES ('m1', 'vps', 'h.example', 22, 'agent', NULL, 1, NULL);
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "marker 12 bridged, v13 applied");
        let m = store.machine_by_id("m1").unwrap().expect("pre-migration row still loads");
        assert_eq!(m.daemon_mac_id, None);
        assert_eq!(m.daemon_relay_url, None);
        assert_eq!(m.daemon_label, None);
        assert_eq!(m.phone_provisioned_at, None);
        assert_eq!(m.host, "h.example", "every pre-existing column is untouched");
    }

    /// v13's `ALTER TABLE ... ADD COLUMN` ×4 is guarded by `add_column_if_absent` like
    /// every other additive migration — reopening an already-migrated db (a second app
    /// launch) must not error, re-add a column, or disturb the row.
    #[test]
    fn migrate_v13_reopen_is_idempotent() {
        let tmp = TempDb::new("machines-v13-idempotent");
        {
            let store = tmp.open();
            store
                .upsert_machine(&MachineRecord {
                    id: "m1".into(),
                    label: "vps".into(),
                    host: "h.example".into(),
                    port: 22,
                    user: "agent".into(),
                    identity_file: None,
                    added_at: 1,
                    addresses: Vec::new(),
                    daemon_mac_id: Some("mac-abc".into()),
                    daemon_relay_url: Some("https://relay.example/".into()),
                    daemon_label: Some("josty-cc".into()),
                    phone_provisioned_at: Some(99),
                })
                .unwrap();
        }
        let store = tmp.open(); // second open over an already-migrated db
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let m = store.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(m.daemon_mac_id.as_deref(), Some("mac-abc"));
        assert_eq!(m.daemon_relay_url.as_deref(), Some("https://relay.example/"));
        assert_eq!(m.daemon_label.as_deref(), Some("josty-cc"));
        assert_eq!(m.phone_provisioned_at, Some(99));
    }

    /// A wholesale `upsert_machine` with all four daemon fields `None` — exactly what
    /// every existing caller (`add_machine`, the demo seed, a probe re-save) passes,
    /// since none of them know about the daemon — must NOT erase metadata a dedicated
    /// setter already wrote. Mirrors `repos.machine_id`'s COALESCE guard
    /// (`machines_pair_repos_resolve_and_cascade`).
    #[test]
    fn upsert_machine_with_none_daemon_fields_preserves_existing_metadata() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
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
        };
        s.upsert_machine(&m).unwrap();
        s.set_machine_daemon_identity("m1", "mac-abc", "https://relay.example/", "josty-cc").unwrap();
        s.set_machine_phone_provisioned_at("m1", 555).unwrap();

        // A caller that knows nothing about the daemon re-upserts the whole record,
        // e.g. renaming the machine — every daemon field stays `None` on its end.
        let mut renamed = m.clone();
        renamed.label = "vps (renamed)".into();
        s.upsert_machine(&renamed).unwrap();

        let got = s.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(got.label, "vps (renamed)");
        assert_eq!(got.daemon_mac_id.as_deref(), Some("mac-abc"), "daemon identity must survive a None-field upsert");
        assert_eq!(got.daemon_relay_url.as_deref(), Some("https://relay.example/"));
        assert_eq!(got.daemon_label.as_deref(), Some("josty-cc"));
        assert_eq!(got.phone_provisioned_at, Some(555), "phone-provisioned timestamp must survive too");
    }

    /// The two focused setters (`set_machine_daemon_identity` /
    /// `set_machine_phone_provisioned_at`) round-trip independently of each other and
    /// of a full `upsert_machine`, and report "no such machine" via their row count
    /// rather than erroring.
    #[test]
    fn machine_daemon_setters_round_trip_and_report_missing_rows() {
        let s = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
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
        };
        s.upsert_machine(&m).unwrap();

        let touched = s
            .set_machine_daemon_identity("m1", "mac-abc", "https://relay.example/", "josty-cc")
            .unwrap();
        assert_eq!(touched, 1);
        let got = s.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(got.daemon_mac_id.as_deref(), Some("mac-abc"));
        assert_eq!(got.daemon_relay_url.as_deref(), Some("https://relay.example/"));
        assert_eq!(got.daemon_label.as_deref(), Some("josty-cc"));
        assert_eq!(got.phone_provisioned_at, None, "identity setter must not touch the phone timestamp");

        let touched = s.set_machine_phone_provisioned_at("m1", 42).unwrap();
        assert_eq!(touched, 1);
        let got = s.machine_by_id("m1").unwrap().unwrap();
        assert_eq!(got.phone_provisioned_at, Some(42));
        assert_eq!(got.daemon_mac_id.as_deref(), Some("mac-abc"), "phone setter must not touch the identity");

        // Neither setter errors against an unknown machine id — it just touches 0 rows.
        assert_eq!(
            s.set_machine_daemon_identity("no-such-machine", "x", "y", "z").unwrap(),
            0
        );
        assert_eq!(s.set_machine_phone_provisioned_at("no-such-machine", 1).unwrap(), 0);
    }

    /// `all_machines` mirrors `load_state().machines` — same columns, same order —
    /// as a standalone call `appmcp::provision` can iterate without paying for
    /// repos/conversations/accounts too.
    #[test]
    fn all_machines_lists_every_paired_server_oldest_first() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.all_machines().unwrap(), Vec::new(), "no machines paired yet");

        let m1 = MachineRecord {
            id: "m1".into(),
            label: "first".into(),
            host: "h1".into(),
            port: 22,
            user: "u".into(),
            identity_file: None,
            added_at: 10,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        let mut m2 = m1.clone();
        m2.id = "m2".into();
        m2.label = "second".into();
        m2.added_at = 20;
        // Insert out of order — the query must still come back oldest-first.
        s.upsert_machine(&m2).unwrap();
        s.upsert_machine(&m1).unwrap();

        let got = s.all_machines().unwrap();
        assert_eq!(got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["m1", "m2"]);
    }

    /// C10: the relay-side pending-revocation queue round-trips (queue → list →
    /// clear) and re-queuing the SAME token is a no-op on the row count, not a
    /// duplicate (the regenerate-pairing path may retry this if the app restarts
    /// before the token is ever actually sent).
    #[test]
    fn relay_phone_revocation_queue_round_trips_and_dedupes_by_token() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.pending_relay_phone_revocations().unwrap(), Vec::<String>::new());

        s.queue_relay_phone_revocation("old-token-1", 100).unwrap();
        s.queue_relay_phone_revocation("old-token-2", 200).unwrap();
        assert_eq!(
            s.pending_relay_phone_revocations().unwrap(),
            vec!["old-token-1".to_string(), "old-token-2".to_string()],
            "oldest created_at first"
        );

        // Re-queuing the first token again (e.g. a second regenerate before the
        // first one was ever delivered) must not duplicate the row — it REFRESHES
        // created_at instead, which also moves it to the back of the oldest-first
        // order (it is, after all, now the most recently queued one).
        s.queue_relay_phone_revocation("old-token-1", 300).unwrap();
        assert_eq!(
            s.pending_relay_phone_revocations().unwrap(),
            vec!["old-token-2".to_string(), "old-token-1".to_string()],
            "still exactly 2 rows (no duplicate), reordered by the refreshed created_at"
        );

        s.clear_relay_phone_revocation("old-token-1").unwrap();
        assert_eq!(s.pending_relay_phone_revocations().unwrap(), vec!["old-token-2".to_string()]);

        // Clearing a token that was never queued (or already cleared) is a silent
        // no-op, never an error — mirrors every other "forget this row" store method.
        s.clear_relay_phone_revocation("never-queued").unwrap();
    }

    /// C10: the per-daemon pending-revocation queue is scoped by `machine_id` — the
    /// same token queued for two different (unreachable) machines is tracked
    /// independently, and `delete_machine` sweeps a machine's own queue (there is no
    /// FK to cascade it, per this table's own doc in `migrate_v14`).
    #[test]
    fn daemon_phone_revocation_queue_is_scoped_per_machine_and_swept_on_delete() {
        let s = Store::open_in_memory().unwrap();
        let machine = |id: &str| MachineRecord {
            id: id.into(),
            label: id.into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        };
        s.upsert_machine(&machine("m1")).unwrap();
        s.upsert_machine(&machine("m2")).unwrap();

        s.queue_daemon_phone_revocation("m1", "tok", 100).unwrap();
        s.queue_daemon_phone_revocation("m2", "tok", 100).unwrap();
        assert_eq!(s.pending_daemon_phone_revocations("m1").unwrap(), vec!["tok".to_string()]);
        assert_eq!(s.pending_daemon_phone_revocations("m2").unwrap(), vec!["tok".to_string()]);

        s.clear_daemon_phone_revocation("m1", "tok").unwrap();
        assert_eq!(s.pending_daemon_phone_revocations("m1").unwrap(), Vec::<String>::new());
        assert_eq!(
            s.pending_daemon_phone_revocations("m2").unwrap(),
            vec!["tok".to_string()],
            "clearing m1's queue must not touch m2's"
        );

        s.delete_machine("m2").unwrap();
        assert_eq!(
            s.pending_daemon_phone_revocations("m2").unwrap(),
            Vec::<String>::new(),
            "delete_machine must sweep its own pending revocations (no FK cascade exists)"
        );
    }

    fn conv_at(
        id: &str,
        repo_id: &str,
        created_at: i64,
        session_id: Option<&str>,
    ) -> ConversationRecord {
        ConversationRecord {
            id: id.into(),
            name: "Nouvelle conversation".into(),
            repo_id: repo_id.into(),
            cwd: format!("/tmp/{repo_id}"),
            created_at,
            // Default to created_at: a freshly created conversation is active "now".
            last_activity_at: created_at,
            session_id: session_id.map(str::to_string),
            // Default helper conversations are Claude — the app's default backend and
            // the value pre-v5 rows decode to, so existing round-trip/reopen assertions
            // (which compare against this helper) keep holding unchanged.
            backend: "claude".into(),
            model: None,
            effort: None,
            ultracode: false,
            permission_mode: None,
            pending_reminder: None,
            clean_output: None,
            // Default helper conversations were not started from the TOSSE tasks view
            // — the state every conversation is in unless the user starts one there.
            tosse_task_id: None,
            tosse_task_title: None,
            tosse_task_status: None,
            // Default helper conversations run on the default Claude account — the state
            // every pre-v11 row decodes to, and the whole of a single-account setup.
            claude_account_id: None,
        }
    }

    fn conv(id: &str, repo_id: &str, session_id: Option<&str>) -> ConversationRecord {
        conv_at(id, repo_id, 2, session_id)
    }

    /// A throwaway on-disk db dir, removed when dropped. Lets us reopen the db
    /// (a fresh `Store` over the same file) to simulate an app restart — the
    /// in-memory db can't exercise that.
    struct TempDb {
        dir: std::path::PathBuf,
    }
    impl TempDb {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tosse-store-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }
        fn open(&self) -> Store {
            Store::open(&self.dir.join("tosse.db")).unwrap()
        }
        /// Hand-build a legacy on-disk schema on a bare connection (no `Store`, so
        /// no migration runs and `user_version` stays 0), then close it — exactly
        /// the state a database left behind by an older app version is in.
        fn seed_raw(&self, sql: &str) {
            let conn = rusqlite::Connection::open(self.dir.join("tosse.db")).unwrap();
            conn.execute_batch(sql).unwrap();
        }
    }
    impl Drop for TempDb {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn empty_db_loads_default_state() {
        let state = Store::open_in_memory().unwrap().load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }

    #[test]
    fn round_trips_repos_conversations_and_active() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", Some("sess-uuid"))).unwrap();
        store.set_active(Some("c1")).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.repos, vec![repo("r1")]);
        assert_eq!(state.conversations, vec![conv("c1", "r1", Some("sess-uuid"))]);
        assert_eq!(state.active_id.as_deref(), Some("c1"));
    }

    #[test]
    fn session_id_null_round_trips() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].session_id, None);
    }

    #[test]
    fn upsert_updates_in_place_no_duplicate() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        store.upsert_conversation(&c).unwrap();
        // Rename + assign a session id (the two real mutations after creation).
        c.name = "Renamed".into();
        c.session_id = Some("sess".into());
        store.upsert_conversation(&c).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.conversations.len(), 1);
        assert_eq!(state.conversations[0].name, "Renamed");
        assert_eq!(state.conversations[0].session_id.as_deref(), Some("sess"));
    }

    #[test]
    fn per_conversation_controls_round_trip() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.model = Some("sonnet".into());
        c.effort = Some("xhigh".into());
        c.ultracode = true;
        c.permission_mode = Some("plan".into());
        store.upsert_conversation(&c).unwrap();

        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.model.as_deref(), Some("sonnet"));
        assert_eq!(got.effort.as_deref(), Some("xhigh"));
        assert!(got.ultracode);
        assert_eq!(got.permission_mode.as_deref(), Some("plan"));
    }

    #[test]
    fn controls_default_to_none_when_unset() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.model, None);
        assert_eq!(got.effort, None);
        assert!(!got.ultracode);
        assert_eq!(got.permission_mode, None);
        assert_eq!(got.clean_output, None, "unset clean_output means 'inherit global default'");
    }

    #[test]
    fn clean_output_round_trips_tristate() {
        // clean_output is a genuine tristate: None (inherit global default) is
        // distinct from Some(false) (explicit off) and Some(true) (explicit on). All
        // three must survive the SQLite round-trip so a per-conversation choice is
        // never silently coerced back to "inherit".
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        // Default: inherit.
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].clean_output, None);
        // Explicit ON.
        c.clean_output = Some(true);
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].clean_output, Some(true));
        // Explicit OFF — must NOT be conflated with None.
        c.clean_output = Some(false);
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].clean_output, Some(false));
        // Back to inherit.
        c.clean_output = None;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].clean_output, None);
    }

    fn account(id: &str, sort_index: i64) -> ClaudeAccountRecord {
        ClaudeAccountRecord {
            id: id.into(),
            label: format!("Account {id}"),
            email: Some(format!("{id}@example.com")),
            org_name: None,
            subscription_type: Some("max".into()),
            sort_index,
            added_at: 7,
            label_is_generated: true,
        }
    }

    /// Accounts round-trip in display order, and a conversation's link to one survives an
    /// ordinary re-upsert of that conversation (the trap the TOSSE link had to be shaped
    /// around: a wholesale rewrite blanking a field the caller knows nothing about).
    #[test]
    fn claude_accounts_round_trip_and_survive_a_conversation_upsert() {
        let store = Store::open_in_memory().unwrap();
        // A single-account setup has NO rows and no linked conversation: the default
        // account needs no record, so nothing changes for a user who never adds one.
        assert!(store.list_claude_accounts().unwrap().is_empty());

        store.upsert_claude_account(&account("b", 2)).unwrap();
        store.upsert_claude_account(&account("a", 1)).unwrap();
        let listed = store.list_claude_accounts().unwrap();
        assert_eq!(
            listed.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"],
            "accounts come back in display order, not insertion order"
        );
        assert_eq!(listed[0].email.as_deref(), Some("a@example.com"));

        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.claude_account_id = Some("b".into());
        store.upsert_conversation(&c).unwrap();
        let loaded = || store.load_state().unwrap().conversations.remove(0);
        assert_eq!(loaded().claude_account_id.as_deref(), Some("b"));

        // A rename must not disturb the link (or the other way round) — and the rename
        // itself must actually land: every updatable field is re-read, and the creation
        // timestamp is NOT rewritten by the conflict clause.
        let mut renamed = account("b", 5);
        renamed.label = "Work".into();
        renamed.label_is_generated = false;
        store.upsert_claude_account(&renamed).unwrap();
        assert_eq!(loaded().claude_account_id.as_deref(), Some("b"));
        let b = store
            .list_claude_accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.id == "b")
            .unwrap();
        assert_eq!(b.label, "Work");
        assert_eq!(b.sort_index, 5);
        assert!(!b.label_is_generated, "the user-named flag must persist");
        assert_eq!(b.added_at, 7, "added_at is not rewritten on update");
    }

    /// Removing an account DETACHES the conversations that referenced it rather than
    /// leaving them pointing at a credential store that no longer exists — which the
    /// spawner would refuse, stranding the conversation with no way back.
    #[test]
    fn removing_an_account_detaches_its_conversations() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_claude_account(&account("b", 1)).unwrap();

        let mut linked = conv("c1", "r1", None);
        linked.claude_account_id = Some("b".into());
        store.upsert_conversation(&linked).unwrap();
        let mut other = conv("c2", "r1", None);
        other.claude_account_id = Some("kept".into());
        store.upsert_conversation(&other).unwrap();

        store.delete_claude_account("b").unwrap();

        assert!(store.list_claude_accounts().unwrap().is_empty());
        let convs = store.load_state().unwrap().conversations;
        let by_id = |id: &str| {
            convs
                .iter()
                .find(|c| c.id == id)
                .unwrap()
                .claude_account_id
                .clone()
        };
        assert_eq!(by_id("c1"), None, "the conversation falls back to the default account");
        assert_eq!(
            by_id("c2").as_deref(),
            Some("kept"),
            "a conversation on ANOTHER account must not be detached too"
        );
    }

    /// The regression the sole-writer rule prevents: after an account is removed (its
    /// conversations detached), a STALE in-memory copy of a conversation re-upserted by the
    /// front must not write the dead account id back.
    #[test]
    fn a_stale_conversation_upsert_cannot_resurrect_a_removed_account() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_claude_account(&account("b", 1)).unwrap();
        let mut c = conv("c1", "r1", None);
        c.claude_account_id = Some("b".into());
        store.upsert_conversation(&c).unwrap(); // INSERT carries the account

        store.delete_claude_account("b").unwrap();
        // The front's copy still says "b" and is re-upserted on an unrelated change.
        c.name = "renamed".into();
        store.upsert_conversation(&c).unwrap();

        let loaded = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(loaded.name, "renamed", "the unrelated change landed");
        assert_eq!(loaded.claude_account_id, None, "the detach survived the stale upsert");
    }

    /// Pointing a conversation at an account (and back to the default) is its own call, so
    /// no other write path can change it by accident.
    #[test]
    fn set_conversation_claude_account_sets_and_clears() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        let loaded = || store.load_state().unwrap().conversations.remove(0);
        assert_eq!(loaded().claude_account_id, None);

        store.set_conversation_claude_account("c1", Some("b")).unwrap();
        assert_eq!(loaded().claude_account_id.as_deref(), Some("b"));

        store.set_conversation_claude_account("c1", None).unwrap();
        assert_eq!(loaded().claude_account_id, None);
    }

    #[test]
    fn tosse_link_round_trips_and_survives_a_repo_upsert() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        // Unset by default — a user who never touches the feature has no association.
        assert_eq!(store.repo_tosse_links().unwrap()[0].tosse_repository_id, None);

        assert_eq!(store.set_repo_tosse_link("r1", Some("crm-abc")).unwrap(), 1);
        assert_eq!(
            store.repo_tosse_links().unwrap()[0].tosse_repository_id.as_deref(),
            Some("crm-abc")
        );

        // The regression this column is shaped to avoid: re-upserting the repo (adding
        // the same folder again, an undo, a path fix) must NOT blank the association.
        store.upsert_repo(&repo("r1")).unwrap();
        assert_eq!(
            store.repo_tosse_links().unwrap()[0].tosse_repository_id.as_deref(),
            Some("crm-abc"),
            "upsert_repo must not clear a link it knows nothing about"
        );

        // Clearing is explicit, and only ever via its own call.
        assert_eq!(store.set_repo_tosse_link("r1", None).unwrap(), 1);
        assert_eq!(store.repo_tosse_links().unwrap()[0].tosse_repository_id, None);

        // A repo that does not exist reports zero rows rather than a silent success.
        assert_eq!(store.set_repo_tosse_link("ghost", Some("x")).unwrap(), 0);
    }

    /// The association view must be able to tell a folder on this Mac from one on a server:
    /// their paths look alike, and probing a remote one with the local `git` fails exactly
    /// like a deleted folder — which is how a healthy repository came to be flagged broken.
    #[test]
    fn tosse_links_say_which_machine_each_folder_lives_on() {
        let store = Store::open_in_memory().unwrap();
        let m = MachineRecord {
            id: "m1".into(),
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
        };
        store.upsert_machine(&m).unwrap();
        store.upsert_repo(&repo_at("r-local", 1)).unwrap();
        let mut remote = repo_at("r-remote", 2);
        remote.path = "/home/agent/FlightDeck".into();
        remote.machine_id = Some("m1".into());
        store.upsert_repo(&remote).unwrap();

        let links = store.repo_tosse_links().unwrap();
        assert_eq!(links.len(), 2, "the LEFT JOIN must not drop either kind of folder");
        assert_eq!(links[0].machine_id, None);
        assert_eq!(links[0].machine_label, None);
        assert_eq!(links[1].machine_id.as_deref(), Some("m1"));
        // Named, so the card can say WHERE the folder is rather than only that it is away.
        assert_eq!(links[1].machine_label.as_deref(), Some("vps"));
    }

    /// The cached `origin` of a folder that lives on a server — what makes the automatic
    /// TOSSE match work over there at all, since this Mac's `git` cannot read that path.
    #[test]
    fn a_remote_origin_is_cached_and_says_whether_it_was_ever_read() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();

        // Never asked: BOTH columns null. Distinct from "asked, no origin" below — the
        // whole reason the timestamp exists.
        let never = &store.repo_tosse_links().unwrap()[0];
        assert_eq!(never.remote_origin_url, None);
        assert_eq!(never.remote_origin_probed_at, None);

        let url = "https://github.com/Alex375/FlightDeck.git";
        assert!(
            store.set_repo_remote_origin("r1", Some(url), None, 1_000).unwrap(),
            "first read moved it"
        );
        let got = &store.repo_tosse_links().unwrap()[0];
        assert_eq!(got.remote_origin_url.as_deref(), Some(url));
        assert_eq!(got.remote_origin_probed_at, Some(1_000));

        // The common case: the server confirms what we already knew. Reporting "changed"
        // here would make the UI refetch on every single sweep, forever.
        assert!(!store.set_repo_remote_origin("r1", Some(url), None, 2_000).unwrap());

        // Asked, and this repo has no origin: url null, timestamp SET. Reading only the
        // url would send us back to the server on every load for a settled answer.
        assert!(store.set_repo_remote_origin("r1", None, None, 3_000).unwrap());
        let cleared = &store.repo_tosse_links().unwrap()[0];
        assert_eq!(cleared.remote_origin_url, None);
        assert_eq!(cleared.remote_origin_probed_at, Some(3_000));

        // ⚠️ The regression the column shape is chosen to avoid: re-upserting the repo
        // (rename, undo, a path fix) knows nothing about origins and must not blank one.
        store.set_repo_remote_origin("r1", Some(url), None, 4_000).unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        assert_eq!(
            store.repo_tosse_links().unwrap()[0].remote_origin_url.as_deref(),
            Some(url),
            "upsert_repo must not clear a cache it knows nothing about"
        );
    }

    /// ⚠️ A first probe that finds no origin leaves the url at `None` on both sides —
    /// but it flips `origin_read` false → true, which is exactly what takes "the server
    /// could not be reached" off the card. Reporting "nothing changed" for it left that
    /// wrong sentence on screen until something unrelated happened to refetch.
    #[test]
    fn a_first_probe_reports_a_change_even_when_it_finds_no_origin() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        assert!(
            store.set_repo_remote_origin("r1", None, None, 1_000).unwrap(),
            "the very first answer is always a change: the folder stops being 'never asked'"
        );
        // The second identical answer genuinely changes nothing.
        assert!(!store.set_repo_remote_origin("r1", None, None, 2_000).unwrap());
    }

    /// The three firm answers that are NOT a url. They must stamp "we asked" — otherwise
    /// the UI reads them as "we could not ask" and blames the server — while leaving the
    /// cached url alone, so a folder that is merely unmounted keeps the origin it had.
    #[test]
    fn a_firm_non_url_answer_is_recorded_without_losing_the_cached_url() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        let url = "https://github.com/Alex375/FlightDeck.git";
        store.set_repo_remote_origin("r1", Some(url), None, 1_000).unwrap();

        assert!(store.set_repo_remote_origin("r1", None, Some("gone"), 2_000).unwrap());
        let row = &store.repo_tosse_links().unwrap()[0];
        assert_eq!(row.remote_origin_note.as_deref(), Some("gone"));
        assert_eq!(row.remote_origin_probed_at, Some(2_000), "we DID ask, and got an answer");
        assert_eq!(
            row.remote_origin_url.as_deref(),
            Some(url),
            "an unmounted folder keeps the origin it had — it has not moved, it is absent"
        );

        // Same answer twice in a row is not a change.
        assert!(!store.set_repo_remote_origin("r1", None, Some("gone"), 3_000).unwrap());
        // A different answer is.
        assert!(store.set_repo_remote_origin("r1", None, Some("not-a-repository"), 4_000).unwrap());

        // Back to a url: the note clears, so nothing keeps saying the folder is gone.
        assert!(store.set_repo_remote_origin("r1", Some(url), None, 5_000).unwrap());
        assert_eq!(store.repo_tosse_links().unwrap()[0].remote_origin_note, None);
    }

    #[test]
    fn tosse_task_link_round_trips_with_its_denormalised_title_and_status() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        // Unlinked by default — a conversation started any other way carries nothing.
        store.upsert_conversation(&c).unwrap();
        let loaded = &store.load_state().unwrap().conversations[0];
        assert_eq!(loaded.tosse_task_id, None);
        assert_eq!(loaded.tosse_task_title, None);
        assert_eq!(loaded.tosse_task_status, None);

        c.tosse_task_id = Some("task-42".into());
        c.tosse_task_title = Some("Fix the login bug".into());
        c.tosse_task_status = Some("En cours".into());
        store.upsert_conversation(&c).unwrap();
        let loaded = &store.load_state().unwrap().conversations[0];
        assert_eq!(loaded.tosse_task_id.as_deref(), Some("task-42"));
        // The title and status are what keep the link legible — and the delete warning
        // working — with no network, so they must survive the round-trip too.
        assert_eq!(loaded.tosse_task_title.as_deref(), Some("Fix the login bug"));
        assert_eq!(loaded.tosse_task_status.as_deref(), Some("En cours"));

        // Unlinking is a plain write of the same record: the CRM is never consulted.
        c.tosse_task_id = None;
        c.tosse_task_title = None;
        c.tosse_task_status = None;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].tosse_task_id, None);
    }

    #[test]
    fn tosse_project_repo_pins_round_trip_and_cascade_with_their_folder() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        assert!(store.tosse_project_repos().unwrap().is_empty());

        assert!(store.set_tosse_project_repo("proj-1", Some("r1")).unwrap());
        let pins = store.tosse_project_repos().unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].project_id, "proj-1");
        assert_eq!(pins[0].repo_id, "r1");

        // Re-pinning the same project MOVES it rather than adding a second row: a
        // project is worked on in one folder, and two rows would make "which one?"
        // unanswerable.
        store.upsert_repo(&repo("r2")).unwrap();
        assert!(store.set_tosse_project_repo("proj-1", Some("r2")).unwrap());
        let pins = store.tosse_project_repos().unwrap();
        assert_eq!(pins.len(), 1, "one pin per project");
        assert_eq!(pins[0].repo_id, "r2");

        // Clearing is explicit and reports that no pin remains.
        assert!(!store.set_tosse_project_repo("proj-1", None).unwrap());
        assert!(store.tosse_project_repos().unwrap().is_empty());

        // A folder removed from Flight Deck takes its project pins with it, instead of
        // leaving rows pointing at a repo that is gone.
        store.set_tosse_project_repo("proj-2", Some("r2")).unwrap();
        store.delete_repo("r2").unwrap();
        assert!(store.tosse_project_repos().unwrap().is_empty());
    }

    #[test]
    fn pinning_a_project_to_an_unknown_folder_is_refused() {
        // The foreign key is the guard: reporting success here would store a pin that
        // resolves to nothing, and the view would then offer to open a folder that does
        // not exist.
        let store = Store::open_in_memory().unwrap();
        assert!(store.set_tosse_project_repo("proj-1", Some("ghost")).is_err());
    }

    #[test]
    fn backend_round_trips_and_defaults_to_claude() {
        // The conversation's backend must survive the round-trip, and default to
        // "claude" when unset (the helper's default) — the discriminant the whole
        // two-backend architecture reads.
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        assert_eq!(c.backend, "claude", "default backend is claude");
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].backend, "claude");
        // A Codex conversation persists its backend distinctly.
        c.backend = "codex".into();
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].backend, "codex");
    }

    #[test]
    fn legacy_v4_db_gains_backend_defaulting_to_claude() {
        // A db left by the v4-era shipped code (full v4 schema incl. clean_output, no
        // `backend`): the v5 migration adds the column; existing rows have NULL, which
        // the loader COALESCEs to "claude" — so every pre-existing conversation stays
        // on Claude with no re-grant. Every prior value survives untouched.
        let tmp = TempDb::new("legacy-v4-backend");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT,
                model            TEXT,
                effort           TEXT,
                ultracode        INTEGER NOT NULL DEFAULT 0,
                permission_mode  TEXT,
                pending_reminder TEXT,
                clean_output     INTEGER
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '4');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id, model, permission_mode)
                VALUES ('c1', 'Legacy v4', 'r1', '/tmp/r1', 5, 9, 'sess-1', 'opus', 'plan');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "marker '4' bridged, v5 applied");
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.name, "Legacy v4");
        assert_eq!(c.backend, "claude", "pre-v5 rows decode as claude (COALESCE), no re-grant");
        // Prior values survive.
        assert_eq!(c.model.as_deref(), Some("opus"));
        assert_eq!(c.permission_mode.as_deref(), Some("plan"));
        // And the new column is fully usable after the in-place upgrade.
        let mut c = c.clone();
        c.backend = "codex".into();
        store.upsert_conversation(&c).unwrap();
        assert_eq!(store.load_state().unwrap().conversations[0].backend, "codex");
    }

    #[test]
    fn pending_reminder_round_trips_and_clears() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.pending_reminder = Some("review".into());
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder.as_deref(),
            Some("review")
        );
        // Acknowledging ("Vu") clears it back to NULL, durably.
        c.pending_reminder = None;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder,
            None
        );
    }

    #[test]
    fn pending_reminder_defaults_to_none() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder,
            None
        );
    }

    #[test]
    fn last_activity_at_round_trips() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv("c1", "r1", None);
        c.last_activity_at = 4242;
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].last_activity_at,
            4242
        );
    }

    #[test]
    fn backfill_fills_sentinel_rows_from_resolver_else_created_at() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        // Two rows forced to the sentinel (0), as if they predate the column.
        let mut c1 = conv_at("c1", "r1", 100, Some("sess-c1"));
        c1.last_activity_at = 0;
        let mut c2 = conv_at("c2", "r1", 200, None);
        c2.last_activity_at = 0;
        store.upsert_conversation(&c1).unwrap();
        store.upsert_conversation(&c2).unwrap();

        // Resolver knows a mtime only for c1's session; c2 must fall back to created_at.
        store
            .backfill_last_activity(|sid| if sid == "sess-c1" { Some(999) } else { None })
            .unwrap();

        let convs = store.load_state().unwrap().conversations; // created_at ASC -> [c1, c2]
        assert_eq!(convs[0].last_activity_at, 999, "resolver mtime wins");
        assert_eq!(convs[1].last_activity_at, 200, "no transcript -> created_at");
    }

    #[test]
    fn backfill_leaves_already_filled_rows_untouched() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        let mut c = conv_at("c1", "r1", 100, Some("sess"));
        c.last_activity_at = 555; // already has a real timestamp
        store.upsert_conversation(&c).unwrap();

        // A resolver that would overwrite everything must NOT touch a filled row.
        store.backfill_last_activity(|_| Some(1)).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].last_activity_at,
            555
        );
    }

    #[test]
    fn upsert_repo_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        store.upsert_repo(&repo_at("r1", 9)).unwrap();
        let state = store.load_state().unwrap();
        assert_eq!(state.repos.len(), 1);
        assert_eq!(state.repos[0].added_at, 9);
    }

    #[test]
    fn load_orders_repos_and_conversations_by_timestamp() {
        let store = Store::open_in_memory().unwrap();
        // Insert out of order; load must return added_at / created_at ascending.
        store.upsert_repo(&repo_at("r2", 5)).unwrap();
        store.upsert_repo(&repo_at("r1", 1)).unwrap();
        store.upsert_conversation(&conv_at("c2", "r1", 9, None)).unwrap();
        store.upsert_conversation(&conv_at("c1", "r1", 3, None)).unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(
            state.repos.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["r1", "r2"]
        );
        assert_eq!(
            state.conversations.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2"]
        );
    }

    #[test]
    fn set_active_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        store.set_active(Some("a")).unwrap();
        store.set_active(Some("b")).unwrap();
        assert_eq!(store.load_state().unwrap().active_id.as_deref(), Some("b"));
    }

    #[test]
    fn clearing_active_removes_it() {
        let store = Store::open_in_memory().unwrap();
        store.set_active(Some("c1")).unwrap();
        store.set_active(None).unwrap();
        assert_eq!(store.load_state().unwrap().active_id, None);
    }

    #[test]
    fn delete_conversation_removes_only_its_target() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv_at("c1", "r1", 1, None)).unwrap();
        store.upsert_conversation(&conv_at("c2", "r1", 2, None)).unwrap();

        store.delete_conversation("c1").unwrap();

        let state = store.load_state().unwrap();
        assert_eq!(state.repos.len(), 1, "deleting a conversation keeps its repo");
        assert_eq!(
            state.conversations.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["c2"]
        );
    }

    #[test]
    fn deleting_repo_cascades_conversations() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        store.delete_repo("r1").unwrap();

        let state = store.load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(
            state.conversations.is_empty(),
            "conversations should cascade with their repo"
        );
    }

    #[test]
    fn conversation_referencing_unknown_repo_is_rejected() {
        // foreign_keys = ON must reject a conversation pointing at a missing repo.
        let store = Store::open_in_memory().unwrap();
        assert!(
            store.upsert_conversation(&conv("c1", "ghost", None)).is_err(),
            "FK should reject an orphan conversation"
        );
    }

    #[test]
    fn wipe_all_empties_everything() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_repo(&repo("r1")).unwrap();
        store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
        store.set_active(Some("c1")).unwrap();

        store.wipe_all().unwrap();

        let state = store.load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }

    #[test]
    fn data_survives_reopen() {
        // The headline guarantee: metadata persists across a restart. Write with
        // one Store, drop it (closing the connection), then read with a fresh one
        // over the same file.
        let tmp = TempDb::new("reopen");
        {
            let store = tmp.open();
            store.upsert_repo(&repo("r1")).unwrap();
            store.upsert_conversation(&conv("c1", "r1", Some("sess"))).unwrap();
            store.set_active(Some("c1")).unwrap();
        }
        let state = tmp.open().load_state().unwrap();
        assert_eq!(state.repos, vec![repo("r1")]);
        assert_eq!(state.conversations, vec![conv("c1", "r1", Some("sess"))]);
        assert_eq!(state.active_id.as_deref(), Some("c1"));
    }

    #[test]
    fn additive_migration_adds_pending_reminder_to_a_pre_v3_db() {
        // The feature's core promise is the ADDITIVE migration: a DB created before
        // `pending_reminder` (a pre-v3 schema) must gain the column on reopen, with
        // existing rows defaulting to NULL and surviving intact. Every other test
        // starts from the full current CREATE TABLE, so the `ALTER TABLE ... ADD
        // COLUMN pending_reminder` branch never runs there — exercise it for real.
        let tmp = TempDb::new("pre-v3-migration");
        {
            // Hand-build a v2 conversations table (everything EXCEPT pending_reminder)
            // with one row, via a raw connection — bypassing Store so no migration runs.
            let conn = rusqlite::Connection::open(tmp.dir.join("tosse.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE repos (
                     id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL
                 );
                 CREATE TABLE conversations (
                     id               TEXT PRIMARY KEY,
                     name             TEXT NOT NULL,
                     repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                     cwd              TEXT NOT NULL,
                     created_at       INTEGER NOT NULL,
                     last_activity_at INTEGER NOT NULL DEFAULT 0,
                     session_id       TEXT,
                     model            TEXT,
                     effort           TEXT,
                     ultracode        INTEGER NOT NULL DEFAULT 0,
                     permission_mode  TEXT
                 );
                 INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
                 INSERT INTO conversations (id, name, repo_id, cwd, created_at, last_activity_at)
                     VALUES ('c1', 'Legacy', 'r1', '/tmp/r1', 5, 5);",
            )
            .unwrap();
        }

        // Reopen through Store → the additive migration adds the missing column.
        let state = tmp.open().load_state().unwrap();
        assert_eq!(state.conversations.len(), 1, "the pre-v3 row must survive");
        assert_eq!(state.conversations[0].id, "c1");
        assert_eq!(
            state.conversations[0].pending_reminder, None,
            "an upgraded row defaults to NULL (nothing pending)"
        );

        // And the new column is fully usable after the in-place upgrade.
        let store = tmp.open();
        let mut c = state.conversations[0].clone();
        c.pending_reminder = Some("error".into());
        store.upsert_conversation(&c).unwrap();
        assert_eq!(
            store.load_state().unwrap().conversations[0].pending_reminder.as_deref(),
            Some("error")
        );
    }

    #[test]
    fn reopening_runs_migrations_idempotently() {
        // Opening an existing db must not error (CREATE TABLE IF NOT EXISTS /
        // INSERT OR IGNORE) and must preserve its rows.
        let tmp = TempDb::new("idempotent");
        tmp.open().upsert_repo(&repo("r1")).unwrap();
        let store = tmp.open(); // second open over a populated db
        assert_eq!(store.load_state().unwrap().repos, vec![repo("r1")]);
    }

    #[test]
    fn wipe_all_then_reopen_stays_empty() {
        let tmp = TempDb::new("wipe-reopen");
        {
            let store = tmp.open();
            store.upsert_repo(&repo("r1")).unwrap();
            store.upsert_conversation(&conv("c1", "r1", None)).unwrap();
            store.wipe_all().unwrap();
        }
        let state = tmp.open().load_state().unwrap();
        assert!(state.repos.is_empty());
        assert!(state.conversations.is_empty());
        assert_eq!(state.active_id, None);
    }

    // ---- Versioned migration runner ----------------------------------------

    #[test]
    fn migration_count_matches_schema_version() {
        // The compile-time `const _: () = assert!(...)` guards this too; the runtime
        // mirror makes the invariant visible in the test suite when one is bumped
        // without the other.
        assert_eq!(MIGRATIONS.len() as i64, SCHEMA_VERSION);
    }

    #[test]
    fn fresh_db_ends_at_current_schema_version() {
        // A brand-new database (no meta table) runs every migration in order and
        // lands exactly on SCHEMA_VERSION.
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
    }

    #[test]
    fn reopen_does_not_re_run_or_regress_version() {
        // Second open over a migrated db: version stays put, data intact, no error.
        let tmp = TempDb::new("reopen-version");
        tmp.open().upsert_repo(&repo("r1")).unwrap();
        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        assert_eq!(store.load_state().unwrap().repos, vec![repo("r1")]);
    }

    /// The original v1 schema (commit 9316e0b): base columns only — no
    /// `last_activity_at`, no controls, no `pending_reminder`. The legacy marker
    /// lived in `meta.schema_version`, with `user_version` left at 0.
    const LEGACY_V1_BASE: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
        CREATE TABLE conversations (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
            cwd        TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            session_id TEXT
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '1');
        INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
        INSERT INTO conversations (id, name, repo_id, cwd, created_at, session_id)
            VALUES ('c1', 'Legacy v1', 'r1', '/tmp/r1', 5, 'sess-1');
    ";

    #[test]
    fn legacy_v1_base_db_migrates_preserving_data() {
        let tmp = TempDb::new("legacy-v1-base");
        tmp.seed_raw(LEGACY_V1_BASE);

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "bridged then migrated to current");

        let convs = store.load_state().unwrap().conversations;
        assert_eq!(convs.len(), 1, "the pre-versioned row must survive");
        let c = &convs[0];
        assert_eq!(c.id, "c1");
        assert_eq!(c.name, "Legacy v1");
        assert_eq!(c.session_id.as_deref(), Some("sess-1"));
        // Columns added by the migrations default cleanly on the upgraded row.
        assert_eq!(c.last_activity_at, 0, "added by v2, backfillable at boot");
        assert_eq!(c.model, None);
        assert_eq!(c.effort, None);
        assert!(!c.ultracode);
        assert_eq!(c.permission_mode, None);
        assert_eq!(c.pending_reminder, None);

        // And every new column is fully usable after the in-place upgrade.
        let mut c = c.clone();
        c.pending_reminder = Some("error".into());
        c.model = Some("sonnet".into());
        store.upsert_conversation(&c).unwrap();
        let got = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(got.pending_reminder.as_deref(), Some("error"));
        assert_eq!(got.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn legacy_v1_with_last_activity_preserves_its_value() {
        // Commit 6e388d1 added `last_activity_at` WITHOUT bumping SCHEMA_VERSION, so a
        // db still marked v1 may already carry it with a real value. The guarded v2
        // migration must NOT clobber that value back to the default.
        let tmp = TempDb::new("legacy-v1-activity");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '1');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations (id, name, repo_id, cwd, created_at, last_activity_at, session_id)
                VALUES ('c1', 'Legacy v1.5', 'r1', '/tmp/r1', 5, 777, 'sess-1');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.last_activity_at, 777, "guarded ADD COLUMN must not reset it");
        assert_eq!(c.model, None, "controls were still added");
        assert_eq!(c.pending_reminder, None, "pending_reminder was still added");
    }

    #[test]
    fn legacy_v2_db_gains_reminder_and_clean_output() {
        // Commit d921d8f (v2): controls present, no `pending_reminder` and no
        // `clean_output`. The v3 AND v4 migrations should run; controls and rows must
        // be preserved untouched, and the two newly added columns default to NULL.
        let tmp = TempDb::new("legacy-v2");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT,
                model            TEXT,
                effort           TEXT,
                ultracode        INTEGER NOT NULL DEFAULT 0,
                permission_mode  TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '2');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                 model, effort, ultracode, permission_mode)
                VALUES ('c1', 'Legacy v2', 'r1', '/tmp/r1', 5, 42, 'sess-1',
                        'sonnet', 'xhigh', 1, 'plan');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.model.as_deref(), Some("sonnet"), "controls preserved");
        assert_eq!(c.effort.as_deref(), Some("xhigh"));
        assert!(c.ultracode);
        assert_eq!(c.permission_mode.as_deref(), Some("plan"));
        assert_eq!(c.last_activity_at, 42);
        assert_eq!(c.pending_reminder, None, "newly added by v3");
        assert_eq!(c.clean_output, None, "newly added by v4");
    }

    #[test]
    fn legacy_v3_db_gains_clean_output_only() {
        // A db left by the v3-era shipped code (full v3 schema, marker '3', but
        // user_version still 0): the bridge seeds user_version=3, then ONLY the v4
        // migration runs (adding a NULL `clean_output`). Every prior value — including
        // pending_reminder — survives untouched.
        let tmp = TempDb::new("legacy-v3");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT,
                model            TEXT,
                effort           TEXT,
                ultracode        INTEGER NOT NULL DEFAULT 0,
                permission_mode  TEXT,
                pending_reminder TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '3');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id, pending_reminder)
                VALUES ('c1', 'Legacy v3', 'r1', '/tmp/r1', 5, 9, 'sess-1', 'review');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION);
        let c = store.load_state().unwrap().conversations.remove(0);
        assert_eq!(c.name, "Legacy v3");
        assert_eq!(c.pending_reminder.as_deref(), Some("review"), "untouched");
        assert_eq!(c.last_activity_at, 9);
        assert_eq!(c.clean_output, None, "newly added by v4, defaults to inherit");
    }

    #[test]
    fn frozen_marker_with_full_schema_preserves_real_values_and_active_id() {
        // The DOMINANT real-world legacy shape. The pre-runner builds wrote
        // `meta.schema_version` with INSERT OR IGNORE, so the marker FROZE at the
        // value first written and never advanced — yet every later app version kept
        // adding columns to the on-disk schema. So a database can sit at marker '1'
        // while already carrying the FULL v3 schema WITH real user values. The
        // bridge seeds user_version=1 and the runner re-runs the guarded v2/v3
        // migrations — which must be exact no-ops that DO NOT reset those values —
        // then runs v4 (adding a NULL `clean_output`), all without disturbing the
        // active selection.
        let tmp = TempDb::new("frozen-marker-full");
        tmp.seed_raw(
            "
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at INTEGER NOT NULL);
            CREATE TABLE conversations (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                cwd              TEXT NOT NULL,
                created_at       INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL DEFAULT 0,
                session_id       TEXT,
                model            TEXT,
                effort           TEXT,
                ultracode        INTEGER NOT NULL DEFAULT 0,
                permission_mode  TEXT,
                pending_reminder TEXT
            );
            INSERT INTO meta (key, value) VALUES ('schema_version', '1');
            INSERT INTO meta (key, value) VALUES ('active_id', 'c1');
            INSERT INTO repos (id, path, added_at) VALUES ('r1', '/tmp/r1', 1);
            INSERT INTO conversations
                (id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                 model, effort, ultracode, permission_mode, pending_reminder)
                VALUES ('c1', 'Frozen', 'r1', '/tmp/r1', 5, 1234, 'sess-1',
                        'opus', 'xhigh', 1, 'plan', 'review');
            ",
        );

        let store = tmp.open();
        assert_eq!(store.schema_version(), SCHEMA_VERSION, "marker '1' bridged, runner advanced to current");
        let state = store.load_state().unwrap();
        assert_eq!(state.active_id.as_deref(), Some("c1"), "active selection survives migration");
        let c = &state.conversations[0];
        // Every real value must survive the re-run of the guarded v2/v3 migrations.
        assert_eq!(c.last_activity_at, 1234, "guarded ADD must not reset to DEFAULT 0");
        assert_eq!(c.model.as_deref(), Some("opus"));
        assert_eq!(c.effort.as_deref(), Some("xhigh"));
        assert!(c.ultracode);
        assert_eq!(c.permission_mode.as_deref(), Some("plan"));
        assert_eq!(c.pending_reminder.as_deref(), Some("review"), "guarded ADD must not reset to NULL");
        assert_eq!(c.clean_output, None, "v4 adds clean_output as NULL (inherit)");
    }
}
