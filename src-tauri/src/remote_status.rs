//! What each conversation on a paired server is doing right now, asked of its `flightdeckd`
//! WITHOUT attaching to any of them — the one interpreter of `flightdeckd status` rows for
//! conversations (the server panel's restart guard only counts them, see
//! [`crate::bootstrap::orchestrator::status_row_at_work`], whose rule this reuses).
//!
//! Why: a conversation on a server keeps running there while Flight Deck is closed or the Mac
//! sleeps. Back in the app, nothing on this Mac knows it — no session is attached (attaching is
//! lazy) — so a conversation still working showed as off until its stream was turned on by hand.
//! One `status` round trip per server tells the front which conversations to re-attach.
//!
//! Attaching is never done here: it is not read-only (it replaces whatever client was attached,
//! and cold-starts `claude --resume` for a conversation with no live process), so the front
//! decides, conversation by conversation, from these rows.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use specta::Type;

use crate::bootstrap::orchestrator::status_row_at_work;
use crate::store::RemoteConversationKey;

/// One of this Mac's conversations on a server, as its `flightdeckd` sees it right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct RemoteConversationState {
    /// The conversation's id on THIS Mac.
    pub conversation_id: String,
    /// A `claude` process is alive for it under the daemon.
    pub running: bool,
    /// A turn is running (from flightdeckd 0.4.0 derived from claude's own output; older daemons
    /// only knew the turns a client started).
    pub busy: bool,
    /// Requests waiting on a human (a permission prompt, a question, an MCP form).
    pub pending: u32,
    /// Background work still running (agents, workflows, background shells) — flightdeckd 0.4.0
    /// and later; 0 from an older daemon.
    pub background_tasks: u32,
    /// Busy, or a request waiting, or background work running — what a restart would cut short.
    /// Also a live session that did not answer the daemon's own status query in time
    /// (flightdeckd 0.6.0 `unanswered`): what it is doing is unknown, so it is never read as idle.
    /// And one holding session-only scheduled work (flightdeckd 0.6.0 `scheduled`: a `/loop`
    /// between two firings), which lives only in its claude.
    pub at_work: bool,
    /// The claude session the daemon's conversation runs now. It moves on the server while
    /// this Mac is away (a `/clear` sent from the phone): this Mac's copy is then stale, and its
    /// history read and its next attach must use this one.
    pub session_id: Option<String>,
}

/// Join a `flightdeckd status` answer to this Mac's conversations on that server. A conversation
/// the daemon does not list is not returned: no process of it exists there (the caller reads its
/// absence as `running: false`). Rows are matched by the daemon conversation a conversation
/// attached to (persisted at its attach), else by its session id — a conversation that never
/// attached from this build, or a row whose id moved (a phone `/clear` keeps the conversation
/// but changes the session). `Err` = the answer is not an `fd_status` (an older daemon, a login
/// script that printed first): unknown, never "nothing running".
pub fn states_from_status(stdout: &str, keys: &[RemoteConversationKey]) -> Result<Vec<RemoteConversationState>, String> {
    let rows = status_rows(stdout)?;
    let by_conversation: HashMap<&str, &Value> = rows
        .iter()
        .filter_map(|r| Some((r.get("conversation")?.as_str()?, r)))
        .collect();
    let mut by_session: HashMap<&str, &Value> = HashMap::new();
    for row in &rows {
        let Some(sid) = row.get("session_id").and_then(Value::as_str) else { continue };
        // Two daemon conversations on one session (a resume from another client): the one
        // with a live process is the one that can be at work.
        let keep = by_session.get(sid).is_some_and(|held| running(held) && !running(row));
        if !keep {
            by_session.insert(sid, row);
        }
    }
    Ok(keys
        .iter()
        .filter_map(|key| {
            let row = key
                .daemon_conversation
                .as_deref()
                .and_then(|id| by_conversation.get(id))
                .or_else(|| key.session_id.as_deref().and_then(|sid| by_session.get(sid)))?;
            let count = |k: &str| row.get(k).and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32;
            let alive = running(row);
            Some(RemoteConversationState {
                conversation_id: key.conversation_id.clone(),
                running: alive,
                busy: alive && row.get("busy").and_then(Value::as_bool) == Some(true),
                pending: if alive { count("pending") } else { 0 },
                background_tasks: if alive { count("background_tasks") } else { 0 },
                at_work: alive && status_row_at_work(row),
                session_id: row.get("session_id").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect())
}

fn running(row: &Value) -> bool {
    row.get("running").and_then(Value::as_bool) == Some(true)
}

/// The conversation rows of an `fd_status` answer: its LAST line that parses as one (anything a
/// login script printed before it is skipped).
fn status_rows(stdout: &str) -> Result<Vec<Value>, String> {
    stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("fd_status"))
        .and_then(|v| v.get("conversations").and_then(Value::as_array).cloned())
        .ok_or_else(|| "the server's flightdeckd did not answer its status".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str, sid: Option<&str>, daemon: Option<&str>) -> RemoteConversationKey {
        RemoteConversationKey {
            conversation_id: id.into(),
            session_id: sid.map(Into::into),
            daemon_conversation: daemon.map(Into::into),
        }
    }

    fn status(rows: Value) -> String {
        serde_json::json!({ "type": "fd_status", "version": "0.4.0", "label": "srv", "conversations": rows })
            .to_string()
    }

    #[test]
    fn rows_join_by_daemon_conversation_first_then_by_session() {
        let out = status(serde_json::json!([
            { "conversation": "d1", "session_id": "s-moved", "running": true, "busy": true, "pending": 0, "background_tasks": 0 },
            { "conversation": "d2", "session_id": "s2", "running": true, "busy": false, "pending": 1 },
            { "conversation": "d3", "session_id": "s3", "running": false, "busy": false, "pending": 0 },
        ]));
        let keys = [
            key("a", Some("s-old"), Some("d1")), // the session moved on the server: joined by daemon id
            key("b", Some("s2"), None),          // never attached from this build: joined by session
            key("c", Some("s3"), Some("d3")),
            key("d", Some("s-unknown"), None), // the daemon holds nothing of it
        ];
        let states = states_from_status(&out, &keys).unwrap();
        assert_eq!(
            states,
            vec![
                RemoteConversationState {
                    conversation_id: "a".into(),
                    running: true,
                    busy: true,
                    pending: 0,
                    background_tasks: 0,
                    at_work: true,
                    // the session it moved to on the server, not this Mac's stale one
                    session_id: Some("s-moved".into()),
                },
                RemoteConversationState {
                    conversation_id: "b".into(),
                    running: true,
                    busy: false,
                    pending: 1,
                    background_tasks: 0,
                    at_work: true,
                    session_id: Some("s2".into()),
                },
                RemoteConversationState {
                    conversation_id: "c".into(),
                    running: false,
                    busy: false,
                    pending: 0,
                    background_tasks: 0,
                    at_work: false,
                    session_id: Some("s3".into()),
                },
            ],
        );
    }

    #[test]
    fn background_work_alone_is_at_work_and_an_idle_process_is_not() {
        let out = status(serde_json::json!([
            { "conversation": "d1", "session_id": "s1", "running": true, "busy": false, "pending": 0, "background_tasks": 2 },
            { "conversation": "d2", "session_id": "s2", "running": true, "busy": false, "pending": 0, "background_tasks": 0 },
        ]));
        let states = states_from_status(&out, &[key("a", None, Some("d1")), key("b", None, Some("d2"))]).unwrap();
        assert!(states[0].at_work && states[0].background_tasks == 2);
        assert!(states[1].running && !states[1].at_work);
    }

    /// flightdeckd 0.6.0 flags a live session that did not answer its status query in time
    /// `unanswered`: its process is up and may be mid-turn — reattached, never moved to review.
    #[test]
    fn a_session_the_daemon_could_not_read_is_running_and_at_work() {
        let out = status(serde_json::json!([
            { "conversation": "d1", "session_id": "s1", "running": true, "busy": false, "pending": 0,
              "background_tasks": 0, "unanswered": true },
        ]));
        let states = states_from_status(&out, &[key("a", None, Some("d1"))]).unwrap();
        assert!(states[0].running && states[0].at_work, "{:?}", states[0]);
    }

    #[test]
    fn a_session_shared_by_two_daemon_conversations_joins_the_live_one() {
        let out = status(serde_json::json!([
            { "conversation": "old", "session_id": "s1", "running": true, "busy": true },
            { "conversation": "new", "session_id": "s1", "running": false, "busy": false },
        ]));
        let states = states_from_status(&out, &[key("a", Some("s1"), None)]).unwrap();
        assert!(states[0].running && states[0].busy);
    }

    #[test]
    fn a_login_banner_before_the_answer_is_skipped_and_no_answer_is_an_error() {
        let out = format!("Welcome to the server\n{}\n", status(serde_json::json!([])));
        assert_eq!(states_from_status(&out, &[key("a", Some("s"), None)]).unwrap(), vec![]);
        assert!(states_from_status("bash: flightdeckd: command not found\n", &[]).is_err());
        assert!(states_from_status("", &[]).is_err());
    }
}
