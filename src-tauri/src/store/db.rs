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
    ConversationRecord, PersistedState, RepoRecord, RepoTosseLink, TosseProjectRepo,
};

/// The current schema version. Drives the versioned migration runner: on open, a
/// database is brought up to this version by applying every migration in
/// [`MIGRATIONS`] whose target exceeds its stored `user_version`. Always equal to
/// `MIGRATIONS.len()` (checked at compile time below).
const SCHEMA_VERSION: i64 = 9;
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

        let mut repos_stmt = conn
            .prepare("SELECT id, path, added_at, ssh_target FROM repos ORDER BY added_at ASC")?;
        let repos = repos_stmt
            .query_map([], |row| {
                Ok(RepoRecord {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    added_at: row.get(2)?,
                    // NULL (pre-v9 rows + every local folder) → None (local).
                    ssh_target: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut conv_stmt = conn.prepare(
            "SELECT id, name, repo_id, cwd, created_at, last_activity_at, session_id,
                    model, effort, ultracode, permission_mode, pending_reminder, clean_output,
                    COALESCE(backend, 'claude'),
                    tosse_task_id, tosse_task_title, tosse_task_status
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
            repos,
            conversations,
            active_id,
        })
    }

    /// Insert or update a repo (idempotent by id).
    ///
    /// `ssh_target` (a repo's remoteness) is written on insert but, on update, is
    /// PRESERVED when the incoming value is NULL: `COALESCE(excluded.ssh_target,
    /// repos.ssh_target)`. Callers that rewrite the record wholesale but know nothing
    /// about remoteness (rename, undo, add-a-folder) pass `None` and so can never
    /// blank a repo the user connected over SSH — mirroring the deliberate care around
    /// the TOSSE link. To CHANGE a target, pass the new one; to make it local again,
    /// delete and re-add (no un-remote path exists, by design).
    pub fn upsert_repo(&self, repo: &RepoRecord) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO repos (id, path, added_at, ssh_target) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 path = excluded.path,
                 added_at = excluded.added_at,
                 ssh_target = COALESCE(excluded.ssh_target, repos.ssh_target)",
            params![repo.id, repo.path, repo.added_at, repo.ssh_target],
        )?;
        Ok(())
    }

    /// The SSH destination for the repo whose `path` matches, when that repo is
    /// remote (`ssh_target` non-null); `None` for a local repo or no match. Called
    /// at spawn so a conversation opened in a remote repo launches its `claude` on
    /// that host (see the `spawn_session` command). Keyed by `path` because that is
    /// what the spawn command receives (the conversation's cwd == the repo path for a
    /// remote repo; remote worktrees are out of scope for the SSH-first alpha).
    pub fn repo_ssh_target_for_path(&self, path: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT ssh_target FROM repos
                 WHERE path = ?1 AND ssh_target IS NOT NULL LIMIT 1",
                params![path],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }

    /// Every repo with the TOSSE repository it is pinned to, if any. Feeds the
    /// association matcher, which also needs `path` to read each folder's git remote.
    pub fn repo_tosse_links(&self) -> rusqlite::Result<Vec<RepoTosseLink>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, path, tosse_repository_id FROM repos ORDER BY added_at ASC")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RepoTosseLink {
                    repo_id: row.get(0)?,
                    path: row.get(1)?,
                    tosse_repository_id: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
                  tosse_task_id, tosse_task_title, tosse_task_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
                c.tosse_task_status
            ],
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
            ssh_target: None,
        }
    }

    fn repo(id: &str) -> RepoRecord {
        repo_at(id, 1)
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
