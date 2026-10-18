//! The daemon's conversation registry (SQLite).
//!
//! One row per conversation the daemon knows about, whichever client created it
//! (Mac attach or phone RPC). The claude transcript on disk stays the source of
//! the *messages*; this registry holds identity + lifecycle metadata so
//! `list_conversations` answers instantly and survives daemon restarts.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The session controls a conversation's claude process last CONFIRMED (its
/// per-turn `system/init` / `system/status` `permissionMode`, or claude's success
/// ack of a client's `set_permission_mode` / `set_model` / effort change). They
/// are newer than the argv a client recorded at attach time — a client's argv is
/// spawn-time intent, and a mid-session switch reaches claude over the control
/// channel without ever touching it — so a spawn the daemon makes itself lays
/// them over that argv (`session::daemon_argv`). `None` = not observed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveControls {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl LiveControls {
    pub fn is_empty(&self) -> bool {
        self.permission_mode.is_none() && self.model.is_none() && self.effort.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct ConversationRow {
    pub id: String,
    /// claude session id (uuid) — known once the first init frame arrives.
    pub session_id: Option<String>,
    pub title: String,
    pub repo_path: String,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub archived: bool,
}

pub struct Registry {
    conn: Connection,
}

impl Registry {
    /// Open (or create) the registry. The database and its `-wal`/`-shm`
    /// companions are owner-only (0600): they hold every conversation's title
    /// and repo path. SQLite creates the companions with the database's mode;
    /// companions left wider by an older daemon are narrowed here.
    pub fn open(path: &Path) -> Result<Self> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            crate::config::create_private_dir(parent)?;
        }
        std::fs::OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(path)?;
        for suffix in ["", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            let file = std::path::PathBuf::from(name);
            if file.exists() {
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        init_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn upsert(&self, row: &ConversationRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversations (id, session_id, title, repo_path, created_at, last_activity_at, archived)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               session_id       = COALESCE(excluded.session_id, conversations.session_id),
               title            = CASE WHEN excluded.title != '' THEN excluded.title ELSE conversations.title END,
               repo_path        = excluded.repo_path,
               last_activity_at = excluded.last_activity_at,
               archived         = excluded.archived",
            params![
                row.id,
                row.session_id,
                row.title,
                row.repo_path,
                row.created_at,
                row.last_activity_at,
                row.archived as i64
            ],
        )?;
        Ok(())
    }

    pub fn touch(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET last_activity_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    pub fn set_session_id(&self, id: &str, session_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET session_id = ?2 WHERE id = ?1",
            params![id, session_id],
        )?;
        Ok(())
    }

    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET title = ?2 WHERE id = ?1 AND (title = '' OR title IS NULL)",
            params![id, title],
        )?;
        Ok(())
    }

    /// The CLIENT's title wins: overwrite unconditionally (a placeholder or
    /// an earlier title alike). Blank/whitespace input is a no-op. Distinct
    /// from [`Registry::set_title`], the fill-only-if-empty ai-title backfill.
    pub fn set_title_authoritative(&self, id: &str, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            return Ok(());
        }
        self.conn.execute("UPDATE conversations SET title = ?2 WHERE id = ?1", params![id, title])?;
        Ok(())
    }

    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET archived = ?2 WHERE id = ?1",
            params![id, archived as i64],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<ConversationRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, title, repo_path, created_at, last_activity_at, archived
             FROM conversations WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_from)?;
        Ok(rows.next().transpose()?)
    }

    /// Remember the claude argv a CLIENT last attached this conversation with
    /// (the session flags already stripped — see `session::strip_session_args`),
    /// so a claude the daemon spawns itself later runs with that conversation's
    /// own intent (model, effort, tools…) instead of bare defaults — never with
    /// its bypass, which the daemon cannot vouch for (see `session::daemon_argv`).
    /// `at` orders the rows for [`Registry::latest_claude_args`].
    pub fn set_claude_args(&self, id: &str, args: &[String], at: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET claude_args = ?2, claude_args_at = ?3 WHERE id = ?1",
            params![id, serde_json::to_string(args)?, at],
        )?;
        Ok(())
    }

    /// The argv recorded for this conversation, if a client ever attached it.
    /// A value that no longer parses is an error, not "none" — the caller
    /// logs it and falls back, it never silently spawns with garbage.
    pub fn claude_args(&self, id: &str) -> Result<Option<Vec<String>>> {
        let raw: Option<Option<String>> = self
            .conn
            .query_row("SELECT claude_args FROM conversations WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        parse_args(raw.flatten())
    }

    /// The most recently recorded client argv, preferring a conversation in
    /// `repo_path`. A conversation the daemon creates itself (phone
    /// `create_conversation`, or one no client ever attached) takes ONLY its
    /// model and effort from it — "the model the user works with lately" — never
    /// its permission mode, tools or bypass, which are that other conversation's
    /// own (see `session::daemon_argv`).
    pub fn latest_claude_args(&self, repo_path: &str) -> Result<Option<Vec<String>>> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT claude_args FROM conversations WHERE claude_args IS NOT NULL
                 ORDER BY (repo_path = ?1) DESC, claude_args_at DESC LIMIT 1",
                params![repo_path],
                |r| r.get(0),
            )
            .optional()?;
        parse_args(raw)
    }

    /// Record what this conversation's claude last confirmed (see
    /// [`LiveControls`]); an empty value clears the record — done when a client
    /// cold-starts a new process from its own argv, which is then the newer
    /// statement of intent.
    pub fn set_live_controls(&self, id: &str, live: &LiveControls) -> Result<()> {
        let json = if live.is_empty() { None } else { Some(serde_json::to_string(live)?) };
        self.conn.execute("UPDATE conversations SET live_controls = ?2 WHERE id = ?1", params![id, json])?;
        Ok(())
    }

    /// The controls last confirmed for this conversation (empty when none). A
    /// value that no longer parses is an error — the caller logs it.
    pub fn live_controls(&self, id: &str) -> Result<LiveControls> {
        let raw: Option<Option<String>> = self
            .conn
            .query_row("SELECT live_controls FROM conversations WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        match raw.flatten() {
            None => Ok(LiveControls::default()),
            Some(json) => Ok(serde_json::from_str(&json)?),
        }
    }

    /// Record (`Some(at)`) or clear (`None`) that someone STOPPED this conversation
    /// on purpose — the phone's stop or remove, a client's `fd_stop`, `flightdeckd
    /// stop` — never a daemon shutdown. A client re-attaching with the epoch of the
    /// process that stop ended missed it (its link was down): the daemon must not
    /// start claude again for it (see `SessionManager::attach`). Cleared by the next
    /// start a user asks for.
    pub fn set_stop_requested(&self, id: &str, at: Option<i64>) -> Result<()> {
        self.conn.execute("UPDATE conversations SET stop_requested_at = ?2 WHERE id = ?1", params![id, at])?;
        Ok(())
    }

    /// When this conversation was last stopped on purpose, if it was not started
    /// again since (see [`Registry::set_stop_requested`]).
    pub fn stop_requested_at(&self, id: &str) -> Result<Option<i64>> {
        let at: Option<Option<i64>> = self
            .conn
            .query_row("SELECT stop_requested_at FROM conversations WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        Ok(at.flatten())
    }

    pub fn list(&self, include_archived: bool) -> Result<Vec<ConversationRow>> {
        let sql = if include_archived {
            "SELECT id, session_id, title, repo_path, created_at, last_activity_at, archived
             FROM conversations ORDER BY last_activity_at DESC"
        } else {
            "SELECT id, session_id, title, repo_path, created_at, last_activity_at, archived
             FROM conversations WHERE archived = 0 ORDER BY last_activity_at DESC"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], row_from)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

/// Create the table, then add the columns later versions introduced (an
/// existing registry from an older daemon is upgraded in place; idempotent).
fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversations (
            id               TEXT PRIMARY KEY,
            session_id       TEXT,
            title            TEXT NOT NULL DEFAULT '',
            repo_path        TEXT NOT NULL,
            created_at       INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            archived         INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    // 0.4.0: the client argv of the last attach (JSON array) and when.
    add_column_if_absent(conn, "claude_args", "TEXT")?;
    add_column_if_absent(conn, "claude_args_at", "INTEGER")?;
    // 0.4.0: what the conversation's claude last confirmed (`LiveControls`, JSON).
    add_column_if_absent(conn, "live_controls", "TEXT")?;
    // 0.6.0: when it was last stopped on purpose (ms), NULL once started again.
    add_column_if_absent(conn, "stop_requested_at", "INTEGER")?;
    Ok(())
}

fn add_column_if_absent(conn: &Connection, column: &str, decl: &str) -> Result<()> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('conversations')")?;
    let present = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|c| c == column);
    if !present {
        conn.execute_batch(&format!("ALTER TABLE conversations ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

fn parse_args(raw: Option<String>) -> Result<Option<Vec<String>>> {
    match raw {
        None => Ok(None),
        Some(json) => Ok(Some(serde_json::from_str(&json)?)),
    }
}

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationRow> {
    Ok(ConversationRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        title: row.get(2)?,
        repo_path: row.get(3)?,
        created_at: row.get(4)?,
        last_activity_at: row.get(5)?,
        archived: row.get::<_, i64>(6)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, at: i64) -> ConversationRow {
        ConversationRow {
            id: id.into(),
            session_id: None,
            title: String::new(),
            repo_path: "/work/demo".into(),
            created_at: at,
            last_activity_at: at,
            archived: false,
        }
    }

    #[test]
    fn upsert_get_list_roundtrip() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        r.upsert(&mk("b", 2)).unwrap();
        r.set_session_id("a", "sess-1").unwrap();
        r.set_title("a", "First title").unwrap();
        r.set_title("a", "Second title should not overwrite").unwrap();
        let a = r.get("a").unwrap().unwrap();
        assert_eq!(a.session_id.as_deref(), Some("sess-1"));
        assert_eq!(a.title, "First title");
        let list = r.list(false).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "b"); // most recent first
    }

    #[test]
    fn authoritative_title_overwrites_and_ignores_blank() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("placeholder", 1)).unwrap(); // title ''
        r.set_title_authoritative("placeholder", "My Feature").unwrap();
        assert_eq!(r.get("placeholder").unwrap().unwrap().title, "My Feature");
        r.set_title_authoritative("placeholder", "Renamed").unwrap();
        assert_eq!(r.get("placeholder").unwrap().unwrap().title, "Renamed");
        r.set_title_authoritative("placeholder", "   ").unwrap();
        r.set_title_authoritative("placeholder", "").unwrap();
        assert_eq!(r.get("placeholder").unwrap().unwrap().title, "Renamed");
        // and the ai-title backfill still never overwrites it
        r.set_title("placeholder", "ai title").unwrap();
        assert_eq!(r.get("placeholder").unwrap().unwrap().title, "Renamed");
    }

    #[test]
    fn the_registry_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state/registry.sqlite");
        let mode = |suffix: &str| {
            let p = format!("{}{suffix}", path.display());
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        let r = Registry::open(&path).unwrap();
        r.upsert(&mk("a", 1)).unwrap(); // makes SQLite create -wal / -shm
        assert_eq!(mode(""), 0o600);
        assert_eq!(mode("-wal"), 0o600);
        assert_eq!(mode("-shm"), 0o600);
        assert_eq!(std::fs::metadata(dir.path().join("state")).unwrap().permissions().mode() & 0o777, 0o700);
        drop(r);
        // files an older daemon left world-readable are narrowed on open
        for s in ["", "-wal", "-shm"] {
            let p = format!("{}{s}", path.display());
            if std::path::Path::new(&p).exists() {
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        let _r = Registry::open(&path).unwrap();
        assert_eq!(mode(""), 0o600);
    }

    #[test]
    fn archive_hides_from_default_list() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        r.set_archived("a", true).unwrap();
        assert!(r.list(false).unwrap().is_empty());
        assert_eq!(r.list(true).unwrap().len(), 1);
    }

    #[test]
    fn client_args_round_trip_and_the_latest_prefers_the_same_repo() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        let mut b = mk("b", 1);
        b.repo_path = "/work/other".into();
        r.upsert(&b).unwrap();
        r.upsert(&mk("never", 1)).unwrap();
        assert_eq!(r.claude_args("a").unwrap(), None);
        assert_eq!(r.claude_args("no-such-row").unwrap(), None);
        assert_eq!(r.latest_claude_args("/work/demo").unwrap(), None);

        let args_a = vec!["--model".to_string(), "opus".to_string()];
        let args_b = vec!["--model".to_string(), "sonnet".to_string()];
        r.set_claude_args("a", &args_a, 10).unwrap();
        r.set_claude_args("b", &args_b, 20).unwrap(); // newer, but another repo
        assert_eq!(r.claude_args("a").unwrap(), Some(args_a.clone()));
        assert_eq!(r.latest_claude_args("/work/demo").unwrap(), Some(args_a.clone()));
        assert_eq!(r.latest_claude_args("/work/other").unwrap(), Some(args_b.clone()));
        assert_eq!(r.latest_claude_args("/elsewhere").unwrap(), Some(args_b), "no row in that repo: the newest anywhere");
        // an upsert (attach, phone create) never wipes them
        r.upsert(&mk("a", 30)).unwrap();
        assert_eq!(r.claude_args("a").unwrap(), Some(args_a));
    }

    #[test]
    fn live_controls_round_trip_and_clear() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        assert_eq!(r.live_controls("a").unwrap(), LiveControls::default());
        assert_eq!(r.live_controls("no-such-row").unwrap(), LiveControls::default());
        let live = LiveControls { permission_mode: Some("plan".into()), model: None, effort: Some("high".into()) };
        r.set_live_controls("a", &live).unwrap();
        assert_eq!(r.live_controls("a").unwrap(), live);
        // independent of the recorded argv, and an upsert keeps it
        r.set_claude_args("a", &["--model".to_string(), "x".to_string()], 2).unwrap();
        r.upsert(&mk("a", 3)).unwrap();
        assert_eq!(r.live_controls("a").unwrap(), live);
        r.set_live_controls("a", &LiveControls::default()).unwrap();
        assert_eq!(r.live_controls("a").unwrap(), LiveControls::default());
    }

    #[test]
    fn an_older_registry_is_upgraded_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.sqlite");
        {
            // the 0.2.0 schema, with a row in it
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, session_id TEXT, title TEXT NOT NULL DEFAULT '',
                 repo_path TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
                 archived INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO conversations (id, repo_path, created_at, last_activity_at) VALUES ('old', '/w', 1, 1);",
            )
            .unwrap();
        }
        let r = Registry::open(&path).unwrap();
        assert_eq!(r.get("old").unwrap().unwrap().repo_path, "/w");
        r.set_claude_args("old", &["--effort".to_string(), "high".to_string()], 2).unwrap();
        r.set_live_controls("old", &LiveControls { permission_mode: Some("default".into()), ..Default::default() })
            .unwrap();
        drop(r);
        let r = Registry::open(&path).unwrap(); // idempotent second open
        assert_eq!(r.claude_args("old").unwrap().unwrap()[1], "high");
        assert_eq!(r.live_controls("old").unwrap().permission_mode.as_deref(), Some("default"));
    }

    #[test]
    fn upsert_preserves_session_id_when_none() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        r.set_session_id("a", "sess-1").unwrap();
        let mut again = mk("a", 5);
        again.session_id = None;
        r.upsert(&again).unwrap();
        let a = r.get("a").unwrap().unwrap();
        assert_eq!(a.session_id.as_deref(), Some("sess-1"));
        assert_eq!(a.last_activity_at, 5);
    }
}
