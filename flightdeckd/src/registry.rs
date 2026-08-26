//! The daemon's conversation registry (SQLite).
//!
//! One row per conversation the daemon knows about, whichever client created it
//! (Mac attach or phone RPC). The claude transcript on disk stays the source of
//! the *messages*; this registry holds identity + lifecycle metadata so
//! `list_conversations` answers instantly and survives daemon restarts.

use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::Path;

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
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
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
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
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
    fn archive_hides_from_default_list() {
        let r = Registry::open_in_memory().unwrap();
        r.upsert(&mk("a", 1)).unwrap();
        r.set_archived("a", true).unwrap();
        assert!(r.list(false).unwrap().is_empty());
        assert_eq!(r.list(true).unwrap().len(), 1);
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
