//! The phone RPC catalogue (appmcp shapes, snake_case params). Result shapes
//! mirror what the PWA was built against: PROTOCOL.md §5 + tools/mock-mac.mjs.
//! Unimplemented methods return "unknown method: X" — the PWA degrades
//! gracefully (hides the model picker, etc.).

use crate::events::Event;
use crate::frames;
use crate::registry::ConversationRow;
use crate::session::{PendingPermission, SessionManager, SessionMsg, StatusSnapshot};
use crate::transcript;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::oneshot;

/// Bound on waiting for a session actor's ack — a wedged claude must fail the
/// one RPC, never hang the phone's relay task forever.
const RPC_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

async fn await_ack<T>(rx: oneshot::Receiver<T>) -> Result<T> {
    tokio::time::timeout(RPC_ACK_TIMEOUT, rx)
        .await
        .map_err(|_| anyhow!("the session did not answer in time"))?
        .map_err(|_| anyhow!("conversation just ended"))
}

fn conv_id_of(params: &Value) -> Result<String> {
    params
        .get("conversation_id")
        .or_else(|| params.get("conversationId"))
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| anyhow!("conversation_id is required"))
}

pub async fn handle(m: &Arc<SessionManager>, method: &str, params: &Value) -> Result<Value> {
    match method {
        "ping" => Ok(json!({"pong": true, "at": frames::now_ms()})),
        "list_conversations" => list_conversations(m).await,
        "read_conversation" => read_conversation(m, params).await,
        "send_message" => send_message(m, params).await,
        "create_conversation" => create_conversation(m, params).await,
        "interrupt_conversation" => {
            let id = conv_id_of(params)?;
            let (ack, rx) = oneshot::channel();
            m.route(&id, SessionMsg::Interrupt { ack }).await?;
            await_ack(rx).await?.map_err(|e| anyhow!(e))?;
            Ok(json!({"conversation_id": id, "interrupted": true}))
        }
        "stop_stream" => {
            let id = conv_id_of(params)?;
            let (ack, rx) = oneshot::channel();
            match m.route(&id, SessionMsg::Stop { ack }).await {
                Ok(()) => {
                    let _ = await_ack(rx).await;
                    Ok(json!({"conversation_id": id, "stopped": true}))
                }
                Err(_) => Ok(json!({"conversation_id": id, "stopped": false, "note": "it was not running"})),
            }
        }
        "get_pending_request" => {
            let id = conv_id_of(params)?;
            let requests: Vec<Value> = match m.status(&id).await {
                Some(st) => st.pending.iter().map(pending_to_request).collect(),
                None => Vec::new(),
            };
            Ok(json!({"conversation_id": id, "requests": requests}))
        }
        "answer_request" => answer_request(m, params).await,
        "acknowledge_conversation" => {
            let id = conv_id_of(params)?;
            let _ = m.events_tx.send(Event {
                conversation_id: id.clone(),
                kind: "attention_cleared".into(),
                title: None,
                text: None,
                detail: json!({"reason": "acknowledged"}),
                at_ms: frames::now_ms(),
            });
            Ok(json!({"conversation_id": id, "acknowledged": true}))
        }
        "remove_conversation" => {
            let id = conv_id_of(params)?;
            // stop it if live, then archive (reversible — the row and the
            // transcript stay on disk).
            let (ack, rx) = oneshot::channel();
            if m.route(&id, SessionMsg::Stop { ack }).await.is_ok() {
                let _ = await_ack(rx).await;
            }
            m.with_registry(|r| r.set_archived(&id, true))?;
            Ok(json!({"conversation_id": id, "removed": true}))
        }
        "browse_folders" => browse_folders(m, params),
        _ => bail!("unknown method: {method}"),
    }
}

fn pending_to_request(p: &PendingPermission) -> Value {
    let kind = match p.tool_name.as_str() {
        "AskUserQuestion" => "questions",
        "ExitPlanMode" => "plan",
        _ => "permission",
    };
    json!({
        "request_id": p.request_id,
        "kind": kind,
        "tool_name": p.tool_name,
        "title": p.title.clone().unwrap_or_else(|| p.tool_name.clone()),
        "description": p.description,
        "input": p.input,
    })
}

fn status_json(live: Option<&StatusSnapshot>) -> Value {
    match live {
        Some(st) if st.running => {
            if let Some(first) = st.pending.first() {
                json!({"kind": "needs_permission", "tool": first.tool_name})
            } else if st.busy {
                json!({"kind": "running"})
            } else {
                json!({"kind": "idle"})
            }
        }
        _ => json!({"kind": "off"}),
    }
}

/// The claude session id — the join key between a client's own conversation
/// ids and this daemon's (they legitimately differ). The live actor's value
/// (fresh from claude's init frame) wins over the registry's, which can lag
/// on a brand-new conversation.
fn session_id_of(row: &ConversationRow, live: Option<&StatusSnapshot>) -> Option<String> {
    live.and_then(|s| s.session_id.clone()).or_else(|| row.session_id.clone())
}

async fn list_conversations(m: &Arc<SessionManager>) -> Result<Value> {
    let rows = m.with_registry(|r| r.list(false))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let live = m.status(&row.id).await;
        let status = status_json(live.as_ref());
        let name = row
            .repo_path
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("server")
            .to_string();
        let title = if row.title.is_empty() { "New conversation".to_string() } else { row.title.clone() };
        out.push(json!({
            "conversation_id": row.id,
            "session_id": session_id_of(&row, live.as_ref()),
            "title": title,
            "repository": {"name": name, "path": row.repo_path},
            "backend": "claude",
            "status": status,
            "last_activity_at": row.last_activity_at,
        }));
    }
    Ok(Value::Array(out))
}

async fn read_conversation(m: &Arc<SessionManager>, params: &Value) -> Result<Value> {
    let id = conv_id_of(params)?;
    let max_turns = params
        .get("max_turns")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 40) as usize;
    let row = m
        .with_registry(|r| r.get(&id))?
        .ok_or_else(|| anyhow!("no such conversation"))?;
    // The claude session id may only be known live (registry write races the
    // read on a brand-new conversation) — prefer the live one.
    let live = m.status(&id).await;
    let sid = session_id_of(&row, live.as_ref());
    let mut title = row.title.clone();
    let mut turns: Vec<Value> = Vec::new();
    if let Some(sid) = &sid {
        let t = transcript::load(sid);
        if title.is_empty() {
            if let Some(ai) = &t.title {
                title = ai.clone();
                let _ = m.with_registry(|r| r.set_title(&id, ai));
            }
        }
        let tail = t.turns.len().saturating_sub(max_turns);
        turns = t.turns[tail..]
            .iter()
            .map(|x| json!({"role": x.role, "text": x.text}))
            .collect();
    }
    let status = status_json(live.as_ref());
    // Frame budget: the relay closes the socket on frames over 256 KB
    // (maxPayload). 40 turns × 4000 chars can get there — drop the OLDEST
    // turns until the serialized result fits comfortably.
    const RESULT_BYTES_MAX: usize = 200_000;
    let mut result = json!({
        "conversation_id": id,
        "session_id": sid,
        "title": if title.is_empty() { "New conversation".to_string() } else { title },
        "status": status,
        "turns": turns,
    });
    while result.to_string().len() > RESULT_BYTES_MAX {
        let arr = result["turns"].as_array_mut().expect("turns array");
        if arr.is_empty() {
            break;
        }
        arr.remove(0);
    }
    Ok(result)
}

async fn send_message(m: &Arc<SessionManager>, params: &Value) -> Result<Value> {
    let id = conv_id_of(params)?;
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| anyhow!("text is required"))?;
    m.ensure_running(&id).await?;
    let (ack, rx) = oneshot::channel();
    m.route(&id, SessionMsg::Send { text: text.to_string(), ack }).await?;
    await_ack(rx).await?.map_err(|e| anyhow!(e))?;
    Ok(json!({"conversation_id": id, "delivered": true}))
}

async fn create_conversation(m: &Arc<SessionManager>, params: &Value) -> Result<Value> {
    if params.get("backend").and_then(Value::as_str) == Some("codex") {
        bail!("Codex is not available on this server yet");
    }
    let repo_path = params
        .get("repo_path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("repo_path is required"))?;
    let first = params.get("first_message").and_then(Value::as_str);
    let title = first.map(|f| f.chars().take(60).collect::<String>()).unwrap_or_default();
    let conv_id = m.create_conversation(repo_path, &title).await?;
    if let Some(text) = first {
        let (ack, rx) = oneshot::channel();
        m.route(&conv_id, SessionMsg::Send { text: text.to_string(), ack }).await?;
        let _ = await_ack(rx).await;
    }
    Ok(json!({
        "conversation_id": conv_id,
        "repo_path": repo_path,
        "backend": "claude",
        "started": true,
    }))
}

async fn answer_request(m: &Arc<SessionManager>, params: &Value) -> Result<Value> {
    let id = conv_id_of(params)?;
    let request_id = params
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("request_id is required"))?
        .to_string();
    let behavior = params
        .get("behavior")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("behavior must be allow or deny"))?
        .to_string();
    if behavior != "allow" && behavior != "deny" {
        bail!("behavior must be allow or deny");
    }
    let message = params.get("message").and_then(Value::as_str).map(String::from);
    let updated_input = params.get("updated_input").cloned().filter(|v| !v.is_null());
    let (ack, rx) = oneshot::channel();
    m.route(
        &id,
        SessionMsg::AnswerPermission {
            request_id: request_id.clone(),
            behavior: behavior.clone(),
            message,
            updated_input,
            ack,
        },
    )
    .await?;
    await_ack(rx).await?.map_err(|e| anyhow!(e))?;
    Ok(json!({"conversation_id": id, "request_id": request_id, "behavior": behavior}))
}

fn browse_folders(m: &Arc<SessionManager>, params: &Value) -> Result<Value> {
    let home = dirs::home_dir().unwrap_or_else(|| "/".into());
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .or_else(|| m.cfg.default_workdir.clone())
        .unwrap_or_else(|| home.to_string_lossy().to_string());
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        bail!("no such folder on the server: {path}");
    }
    let mut folders: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        for n in names {
            folders.push(json!({"name": n, "path": format!("{}/{}", path.trim_end_matches('/'), n)}));
        }
    }
    let parent = dir.parent().map(|p| p.to_string_lossy().to_string());
    let repos: Vec<Value> = m
        .with_registry(|r| r.list(false))?
        .into_iter()
        .map(|r| {
            let name = r.repo_path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("repo").to_string();
            json!({"name": name, "path": r.repo_path})
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    let registered: Vec<Value> = repos
        .into_iter()
        .filter(|r| seen.insert(r["path"].as_str().unwrap_or_default().to_string()))
        .collect();
    Ok(json!({
        "path": path,
        "parent": parent,
        "registered_repos": registered,
        "folders": folders,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;

    fn row(id: &str, session_id: Option<&str>, repo: &str) -> ConversationRow {
        ConversationRow {
            id: id.into(),
            session_id: session_id.map(String::from),
            title: "t".into(),
            repo_path: repo.into(),
            created_at: 1,
            last_activity_at: 1,
            archived: false,
        }
    }

    fn listed<'a>(list: &'a Value, id: &str) -> &'a Value {
        list.as_array().unwrap().iter().find(|c| c["conversation_id"] == id).unwrap()
    }

    #[tokio::test]
    async fn phone_results_carry_the_registry_session_id_when_cold() {
        let m = testutil::test_manager(testutil::test_cfg());
        m.with_registry(|r| r.upsert(&row("cold", Some("row-sid"), "/tmp"))).unwrap();
        m.with_registry(|r| r.upsert(&row("fresh", None, "/tmp"))).unwrap();
        let list = handle(&m, "list_conversations", &json!({})).await.unwrap();
        assert_eq!(listed(&list, "cold")["session_id"], "row-sid");
        assert_eq!(listed(&list, "fresh")["session_id"], Value::Null);
        let read = handle(&m, "read_conversation", &json!({"conversation_id": "cold"})).await.unwrap();
        assert_eq!(read["session_id"], "row-sid");
        let read = handle(&m, "read_conversation", &json!({"conversation_id": "fresh"})).await.unwrap();
        assert_eq!(read["session_id"], Value::Null);
    }

    #[tokio::test]
    async fn phone_results_prefer_the_live_session_id() {
        let dir = testutil::short_tempdir();
        let mut cfg = testutil::test_cfg();
        cfg.claude_bin = testutil::fake_claude(dir.path(), "live-sid").to_string_lossy().into();
        let m = testutil::test_manager(cfg);
        let repo = dir.path().to_string_lossy().to_string();
        m.with_registry(|r| r.upsert(&row("c1", Some("row-sid"), &repo))).unwrap();
        m.ensure_running("c1").await.unwrap();
        testutil::wait_for_session_id(&m, "c1", "live-sid").await;
        let list = handle(&m, "list_conversations", &json!({})).await.unwrap();
        assert_eq!(listed(&list, "c1")["session_id"], "live-sid");
        let read = handle(&m, "read_conversation", &json!({"conversation_id": "c1"})).await.unwrap();
        assert_eq!(read["session_id"], "live-sid");
        // and the snapshot beats a registry row that still lags behind it
        let lagging = row("c1", Some("row-sid"), &repo);
        let live = m.status("c1").await;
        assert_eq!(session_id_of(&lagging, live.as_ref()).as_deref(), Some("live-sid"));
        assert_eq!(session_id_of(&lagging, None).as_deref(), Some("row-sid"));
    }
}
