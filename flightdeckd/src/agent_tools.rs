//! The `flightdeck` SDK MCP server for the conversations this daemon runs — the
//! tools a conversation of the Mac app has (list, read and message the other
//! conversations, create one, wait for one…), served to a claude on a server.
//!
//! Before 0.8.0 a server conversation had none: the Mac withheld the server from
//! every remote session, because a tool call reaching a server while no Mac is
//! attached would have hung there with nobody to answer it. So a conversation on
//! the Mac could see and message the server's, and never the other way round.
//!
//! ## Who answers a tool call
//!
//! The daemon is the endpoint of record. claude learns of the server from its
//! `initialize` — the daemon's own ([`frames::initialize_request`]), or the
//! attached client's, which gains it on the way in ([`with_sdk_server`]) when
//! that client hosts the tools. The daemon answers the MCP handshake itself
//! (`initialize`, `ping`, `tools/list`, notifications — [`step`]) with the very
//! catalogue the Mac serves (`flightdeck-agent-tools`), so what a conversation
//! sees does not depend on which Mac attached when it started. Each `tools/call`
//! is then routed:
//!
//!  - a Mac follows the conversation and hosts the tools (its attach said
//!    `supports_agent_tools`): the call is RELAYED to it, raw, and the Mac runs
//!    it exactly like a call from one of its own conversations — with everything
//!    the user sees (that Mac's conversations, every server's) and every setting
//!    of the app. Its `control_response` goes back to claude unchanged. If the
//!    Mac lets go before answering, the daemon answers the call itself with an
//!    error saying so (the call may or may not have run) — never a hang;
//!  - otherwise the daemon runs it ([`call`]) over the conversations of THIS
//!    server: the Mac may be off, asleep, or simply not showing this
//!    conversation. What only a Mac can do (its own conversations, its editor and
//!    views, a TOSSE link, the settings-gated actions) fails with a text saying
//!    why.
//!
//! `browse_folders` is always answered here: for a conversation on a server, the
//! folders of the machine it runs on are this server's.
//!
//! Every `mcp_message` is answered exactly once: claude awaits each one, and a
//! tool call left unanswered blocks its turn.

use crate::events::Event;
use crate::frames;
use crate::rpc;
use crate::session::{LiveStatus, SessionManager, SessionMsg};
use anyhow::{anyhow, bail, Result};
use flightdeck_agent_tools::{self as catalog, jsonrpc, Surface};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot};

/// The SDK MCP server's name, as claude (and permission rules —
/// `mcp__flightdeck__*`) know it. The Mac's `appmcp::SDK_SERVER_NAME`.
pub const SERVER_NAME: &str = "flightdeck";

/// The tools this daemon runs itself, for a conversation no Mac hosting the tools
/// follows (see [`call`]). Every other catalogue tool needs the Mac.
pub const NATIVE_TOOLS: &[&str] = &[
    "whoami",
    "list_conversations",
    "read_conversation",
    "send_message",
    "create_conversation",
    "rename_conversation",
    "interrupt_conversation",
    "stop_stream",
    "list_background_tasks",
    "stop_background_task",
    "get_pending_request",
    "answer_request",
    "acknowledge_conversation",
    "browse_folders",
    "wait_for_conversation",
];

/// Answered here even while a Mac hosts the tools: what they look at is this
/// server, not the Mac.
const SERVER_LOCAL_TOOLS: &[&str] = &["browse_folders"];

/// Whether a call to `tool` goes to the attached client when it hosts the tools.
pub fn relays_to_client(tool: &str) -> bool {
    !SERVER_LOCAL_TOOLS.contains(&tool)
}

/// The `tools/call` an `mcp_message` carries, or what to answer it with.
pub enum Step {
    /// Answer now: the handshake, a ping, a notification's ack, a protocol error.
    Reply(Value),
    /// A tool to run (here or on the Mac). `id` is the JSON-RPC id to answer.
    Call { id: Value, name: String, args: Value },
}

/// An inbound `control_request{subtype:"mcp_message"}` for [`SERVER_NAME`].
pub struct McpMessage {
    pub request_id: String,
    pub message: Value,
}

/// The `mcp_message` for our server `line` carries — `None` for any other line,
/// another server's message included (that one keeps the generic path: tracked
/// as pending and handed to the attached client).
pub fn parse(line: &str) -> Option<McpMessage> {
    // Cheap pre-filter: a `can_use_tool` line can carry a whole file.
    if !line.contains("\"mcp_message\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let req = &v["request"];
    if req["subtype"].as_str() != Some("mcp_message") || req["server_name"].as_str() != Some(SERVER_NAME) {
        return None;
    }
    Some(McpMessage { request_id: v["request_id"].as_str()?.to_string(), message: req["message"].clone() })
}

/// Read one JSON-RPC message from claude's MCP client (`label`: this server's
/// name, for the instructions). Mirrors the Mac's `appmcp::router::handle`, with
/// one difference: every message is answered — a notification with the ack the
/// control channel expects.
pub fn step(msg: &Value, label: &str) -> Step {
    let id = match msg.get("id") {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => None,
    };
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // A malformed REQUEST (an id, no usable method) is answered -32600; a stray
        // response, like a notification, gets the plain ack.
        return Step::Reply(match id {
            Some(id) if msg.get("result").is_none() && msg.get("error").is_none() => {
                jsonrpc::err(id, -32600, "Invalid Request: missing method".to_string())
            }
            _ => jsonrpc::notification_ack(),
        });
    };
    let Some(id) = id else { return Step::Reply(jsonrpc::notification_ack()) };
    match method {
        "initialize" => Step::Reply(jsonrpc::ok(id, initialize_result(msg.get("params"), label))),
        "ping" => Step::Reply(jsonrpc::ok(id, json!({}))),
        "tools/list" => Step::Reply(jsonrpc::ok(id, catalog::list_json(Surface::App))),
        "tools/call" => {
            let params = msg.get("params");
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return Step::Reply(jsonrpc::err(id, -32602, "tools/call: missing tool name".to_string()));
            };
            if catalog::find(Surface::App, name).is_none() {
                return Step::Reply(jsonrpc::err(id, -32602, format!("Unknown tool: {name}")));
            }
            let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or_else(|| json!({}));
            Step::Call { id, name: name.to_string(), args }
        }
        other => Step::Reply(jsonrpc::err(id, -32601, format!("Method not found: {other}"))),
    }
}

fn initialize_result(params: Option<&Value>, label: &str) -> Value {
    json!({
        "protocolVersion": jsonrpc::negotiated_version(params),
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "title": "Flight Deck", "version": env!("CARGO_PKG_VERSION") },
        "instructions": format!(
            "Tools of Flight Deck, the app that manages the user's agent conversations. You run \
             on the server \"{label}\" (Flight Deck Server). While Flight Deck on the user's Mac \
             follows this conversation, these tools reach every conversation the user has — the \
             Mac's and every server's — and the app itself (editor, views, notifications). When \
             no Mac follows it, they reach the conversations of this server only, and a tool \
             that needs the Mac says so. Find a conversation with list_conversations before \
             reading or messaging it."
        ),
    })
}

/// The `tools/call` answer for a tool that ran (`Ok`) or failed (`Err`).
pub fn call_response(id: Value, outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(v) => jsonrpc::ok(id, jsonrpc::tool_success(v)),
        Err(message) => jsonrpc::ok(id, jsonrpc::tool_error(&message)),
    }
}

/// The `control_response` carrying an MCP reply back to claude (the Mac's
/// `control::mcp_control_response`: the JSON-RPC rides `{mcp_response}`).
pub fn control_response(request_id: &str, mcp_response: Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": { "mcp_response": mcp_response },
        },
    })
    .to_string()
}

/// A client's `initialize` with our server added to its `sdkMcpServers`, or
/// `None` for any other line (left as it is). Only for a client that hosts the
/// tools: the daemon announces them in its place — a Mac never announces them for
/// a server conversation itself, so an older daemon, which could not answer
/// them, never has them announced.
pub fn with_sdk_server(line: &str) -> Option<String> {
    if !line.contains("\"initialize\"") {
        return None;
    }
    let mut v: Value = serde_json::from_str(line).ok()?;
    let req = v.get_mut("request")?;
    if req["subtype"].as_str() != Some("initialize") {
        return None;
    }
    let mut servers: Vec<Value> = req["sdkMcpServers"].as_array().cloned().unwrap_or_default();
    if !servers.iter().any(|s| s.as_str() == Some(SERVER_NAME)) {
        servers.push(json!(SERVER_NAME));
    }
    req["sdkMcpServers"] = Value::Array(servers);
    Some(v.to_string())
}

/// What the daemon answers, itself, to a call the Mac took over and then let go
/// of (it detached, was replaced, or claude's line to it broke) — said, so the
/// agent can check before calling again.
pub fn relay_lost(tool: &str) -> String {
    format!(
        "{tool}: Flight Deck on the Mac stopped following this conversation while it ran this \
         call, so its answer never came back — the call may or may not have run. Check (for \
         instance with list_conversations or read_conversation) before calling it again; with \
         no Mac following, this server answers on its own, under its own conversation ids (a \
         conversation's session_id is the same on both)."
    )
}

/// How much longer than the Mac's own deadline for a call the daemon waits for its
/// answer: the Mac answers "did not answer in time" itself at its deadline, and
/// that answer should be the one claude reads.
const RELAY_MARGIN_SECS: u64 = 15;

/// How long a call relayed to the attached client may go unanswered before the
/// daemon answers it itself. A link can die without any end-of-stream reaching
/// the server (a laptop lid closed, a train tunnel): the client still reads as
/// attached, the few hundred bytes of the call sit in a socket buffer, and only
/// TCP's own give-up (~15 min) would end the wait — the turn hanging meanwhile.
pub fn relay_deadline(tool: &str, args: &Value) -> Duration {
    let mac = match catalog::find(Surface::App, tool).map(|t| t.kind) {
        Some(catalog::ToolKind::FrontWait) => catalog::wait_timeout_secs(args),
        _ => catalog::FRONT_TIMEOUT_SECS,
    };
    Duration::from_secs(mac + RELAY_MARGIN_SECS)
}

/// What the daemon answers when a relayed call outlived [`relay_deadline`].
pub fn relay_timed_out(tool: &str, after: Duration) -> String {
    format!(
        "{tool}: Flight Deck on the Mac did not answer this call within {} s — its link to this \
         server may be down. The call may or may not have run: check before calling it again.",
        after.as_secs()
    )
}

/// The answer to a `wait_for_conversation` whose own turn ended before it settled
/// (interrupted, or over with no background work left): the Mac's `cancelled`.
/// claude no longer awaits it — answered anyway, so it is never left open.
pub fn wait_cancelled(id: Value) -> Value {
    call_response(
        id,
        Ok(json!({
            "outcome": "cancelled",
            "note": "your own turn ended before the conversation settled — nothing was waited for",
        })),
    )
}

fn needs_a_mac(tool: &str) -> String {
    format!(
        "{tool} needs Flight Deck on the user's Mac, and no Mac is following this conversation \
         with its agent tools on right now (it is off, asleep, not showing this conversation, or \
         its \"Let in-app agents control the app\" setting is off). On its own, this server \
         answers: {}.",
        NATIVE_TOOLS.join(", ")
    )
}

// ---------------------------------------------------------------------------
// The tools this daemon runs itself

/// Run `tool` for the conversation `caller` over this server's conversations.
/// `Err` is the text the model reads (an `isError` result).
pub async fn call(m: &Arc<SessionManager>, caller: &str, tool: &str, args: &Value) -> Result<Value, String> {
    let out = match tool {
        "whoami" => whoami(m, caller).await,
        "list_conversations" => list_conversations(m, caller).await,
        "send_message" => send_message(m, caller, args).await,
        "create_conversation" => create_conversation(m, caller, args).await,
        "rename_conversation" => rename_conversation(m, caller, args),
        "answer_request" => answer_request(m, caller, args).await,
        "wait_for_conversation" => wait_for_conversation(m, caller, args).await,
        "browse_folders" => rpc::handle(m, "browse_folders", args).await,
        "stop_stream" => match target(m, caller, args) {
            Ok(id) if id == caller => Err(anyhow!(
                "a conversation cannot power its own process off — that would end the very turn calling this tool"
            )),
            Ok(id) => rpc::handle(m, tool, &with_id(args, &id)).await,
            Err(e) => Err(e),
        },
        "read_conversation"
        | "interrupt_conversation"
        | "list_background_tasks"
        | "stop_background_task"
        | "get_pending_request"
        | "acknowledge_conversation" => match target(m, caller, args) {
            Ok(id) => rpc::handle(m, tool, &with_id(args, &id)).await,
            Err(e) => Err(e),
        },
        _ => return Err(needs_a_mac(tool)),
    };
    out.map_err(|e| format!("{tool}: {e:#}"))
}

/// A tool's target: the `conversation_id` it names, else the calling one — the
/// Mac's `resolveTarget`.
fn target(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<String> {
    match args.get("conversation_id").and_then(Value::as_str).map(str::trim) {
        Some(id) if !id.is_empty() => known(m, id),
        _ => known(m, caller),
    }
}

/// The server conversation `id` names: this server's id, or — the join key a Mac's
/// list and this server's share — the claude `session_id` of one (a conversation's
/// id differs between the two lists, and which one answers depends on whether a Mac
/// follows the caller right now). One neither knows is refused, saying so.
fn known(m: &Arc<SessionManager>, id: &str) -> Result<String> {
    if m.with_registry(|r| r.get(id))?.is_some() {
        return Ok(id.to_string());
    }
    let by_session = m.with_registry(|r| r.list(true))?.into_iter().find(|row| row.session_id.as_deref() == Some(id));
    if let Some(row) = by_session {
        return Ok(row.id);
    }
    bail!(
        "no conversation with id '{id}' on this server — see list_conversations. While no Mac \
         follows this conversation, only this server's conversations are reachable; an id from \
         a Mac's list is the Mac's (pass that row's session_id instead: it is the same on both)"
    )
}

fn with_id(args: &Value, id: &str) -> Value {
    let mut a = if args.is_object() { args.clone() } else { json!({}) };
    a["conversation_id"] = json!(id);
    a
}

fn label(m: &Arc<SessionManager>) -> String {
    m.cfg.label.clone()
}

fn base_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// What the agent is told about its reach, on every answer that lists or names
/// conversations: never let it believe it saw "everything".
fn reach_note(m: &Arc<SessionManager>) -> String {
    format!(
        "These are the conversations of the server \"{}\" only: no Flight Deck on a Mac is \
         following this conversation with its agent tools on right now, so the Mac's own \
         conversations (and other servers') are out of reach until it does.",
        label(m)
    )
}

async fn whoami(m: &Arc<SessionManager>, caller: &str) -> Result<Value> {
    let row = m.with_registry(|r| r.get(caller))?.ok_or_else(|| anyhow!("this conversation is not registered on the server"))?;
    let live = m.status(caller).await;
    Ok(json!({
        "conversation_id": row.id,
        "session_id": rpc::session_id_of(&row, live.snapshot()),
        "title": if row.title.is_empty() { "New conversation".to_string() } else { row.title.clone() },
        "repository": { "name": base_name(&row.repo_path), "path": row.repo_path },
        "cwd": row.repo_path,
        "backend": "claude",
        "status": rpc::status_json(&live),
        "hosted_on": label(m),
        "note": reach_note(m),
    }))
}

async fn list_conversations(m: &Arc<SessionManager>, caller: &str) -> Result<Value> {
    let mut rows = rpc::handle(m, "list_conversations", &json!({})).await?;
    if let Some(rows) = rows.as_array_mut() {
        for row in rows.iter_mut() {
            if row["conversation_id"].as_str() == Some(caller) {
                row["is_caller"] = json!(true);
            }
        }
    }
    Ok(json!({ "conversations": rows, "server": label(m), "note": reach_note(m) }))
}

/// Who sent an agent message: the calling conversation, as its envelope names it.
struct Sender {
    conversation_id: String,
    title: String,
    repo: Option<String>,
}

fn sender_of(m: &Arc<SessionManager>, caller: &str) -> Result<Sender> {
    let row = m.with_registry(|r| r.get(caller))?.ok_or_else(|| anyhow!("this conversation is not registered on the server"))?;
    Ok(Sender {
        conversation_id: row.id,
        title: row.title,
        repo: Some(base_name(&row.repo_path)).filter(|r| !r.is_empty()),
    })
}

/// Read by the RECIPIENT model: it must know the prompt did not come from its
/// user. The Mac's `NOTE` (`src/features/conversation/agentMessage.ts`), word for
/// word — a test keeps the two equal.
const ENVELOPE_NOTE: &str = "This message was sent by another agent conversation (named above) through the Flight Deck \
send_message tool. It was not typed by the user.";

/// A header value on one line with no angle brackets (the Mac's `headerValue`).
fn header_value(v: &str) -> String {
    v.replace(['<', '>'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A message wrapped in its attribution envelope — the Mac's
/// `buildAgentMessageEnvelope`, so the recipient (model, Mac thread, phone)
/// reads a server conversation's message exactly like a Mac conversation's.
fn envelope(sender: &Sender, message_id: &str, body: &str) -> String {
    let title = header_value(&sender.title);
    let mut lines = vec![
        "<flightdeck-message>".to_string(),
        format!("<from>{}</from>", if title.is_empty() { "Untitled conversation" } else { title.as_str() }),
    ];
    if let Some(repo) = sender.repo.as_deref().map(header_value).filter(|r| !r.is_empty()) {
        lines.push(format!("<from-repo>{repo}</from-repo>"));
    }
    lines.extend([
        "<from-backend>claude</from-backend>".to_string(),
        format!("<from-conversation-id>{}</from-conversation-id>", header_value(&sender.conversation_id)),
        format!("<message-id>{}</message-id>", header_value(message_id)),
        format!("<note>{ENVELOPE_NOTE}</note>"),
        "<body>".to_string(),
        body.to_string(),
        "</body>".to_string(),
        "</flightdeck-message>".to_string(),
    ]);
    lines.join("\n")
}

/// Refused BEFORE anything is sent: a watch subscription needs the Mac, which
/// delivers its notifications.
fn refuse_watch(tool: &str, args: &Value) -> Result<()> {
    if args.get("watch").and_then(Value::as_bool) == Some(true) {
        bail!(
            "'watch' needs Flight Deck on a Mac following this conversation — call {tool} without \
             it, then wait_for_conversation to hear when the other conversation settles"
        );
    }
    Ok(())
}

/// Deliver `text` (already enveloped) to the conversation `to`, starting its
/// claude when it is not running. Returns whether it was mid-turn.
async fn deliver(m: &Arc<SessionManager>, to: &str, text: String) -> Result<bool> {
    let busy = m.status(to).await.snapshot().map(|s| s.running && s.busy).unwrap_or(false);
    m.ensure_running(to).await?;
    let (ack, rx) = oneshot::channel();
    m.route(to, SessionMsg::Send { text, ack }).await?;
    rpc::await_ack(rx).await?.map_err(|e| anyhow!(e))?;
    Ok(busy)
}

async fn send_message(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<Value> {
    let named = args
        .get("conversation_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("'conversation_id' is required (see list_conversations)"))?;
    let text = args.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if text.is_empty() {
        bail!("'text' is required");
    }
    refuse_watch("send_message", args)?;
    let id = known(m, named)?;
    if id == caller {
        bail!("a conversation cannot message itself (that's your own thread)");
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let wire = envelope(&sender_of(m, caller)?, &message_id, text);
    let busy = deliver(m, &id, wire).await?;
    m.agent_book.note_sent(caller, &id);
    let mut out = json!({ "conversation_id": id, "delivered": true, "message_id": message_id });
    if busy {
        out["note"] = json!("the agent was mid-turn; the message was queued/injected");
    }
    Ok(out)
}

/// An agent-supplied ABSOLUTE folder path, lexically canonical (the Mac's
/// `normalizeFolderPath`): `/x/y/`, `/x//y` and `/x/z/../y` are the same folder.
fn normalize_folder(raw: &str) -> Result<String> {
    if !raw.starts_with('/') {
        bail!("the path must be absolute");
    }
    let mut out: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    Ok(format!("/{}", out.join("/")))
}

async fn create_conversation(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<Value> {
    let raw = args.get("repo_path").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if raw.is_empty() {
        bail!("'repo_path' is required");
    }
    if args.get("backend").and_then(Value::as_str) == Some("codex") {
        bail!("Codex is not available on this server yet");
    }
    refuse_watch("create_conversation", args)?;
    let repo_path = normalize_folder(raw)?;
    if !std::path::Path::new(&repo_path).is_dir() {
        bail!("'{repo_path}' is not an existing folder on the server \"{}\"", label(m));
    }
    let first = args.get("first_message").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
    let title = match args.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => first.map(|f| f.chars().take(60).collect()).unwrap_or_default(),
    };
    // The envelope names the caller: read it before anything is created.
    let sender = sender_of(m, caller)?;
    let conv_id = m.create_conversation(&repo_path, &title).await?;
    let mut out = json!({
        "conversation_id": conv_id,
        "repo_path": repo_path,
        "backend": "claude",
        "started": first.is_some(),
        "hosted_on": label(m),
    });
    if let Some(text) = first {
        let message_id = uuid::Uuid::new_v4().to_string();
        deliver(m, &conv_id, envelope(&sender, &message_id, text))
            .await
            .map_err(|e| anyhow!("the conversation {conv_id} was created, but its first message was not delivered: {e:#}"))?;
        m.agent_book.note_sent(caller, &conv_id);
        out["message_id"] = json!(message_id);
    }
    Ok(out)
}

fn rename_conversation(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<Value> {
    let name = args.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if name.is_empty() {
        bail!("'name' is required");
    }
    let id = target(m, caller, args)?;
    let id = m.set_title(Some(&id), None, name)?;
    Ok(json!({ "conversation_id": id, "title": name }))
}

/// A question's answer only. A permission prompt or a plan approval decides what
/// RUNS, and the Mac keeps that behind an explicit opt-in this server cannot see
/// ("Answer permission requests remotely") — so it is refused here, not guessed.
async fn answer_request(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<Value> {
    let id = target(m, caller, args)?;
    let request_id = args
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("'request_id' is required (see get_pending_request)"))?
        .to_string();
    let behavior = args.get("behavior").and_then(Value::as_str).unwrap_or_default();
    if behavior != "allow" && behavior != "deny" {
        bail!("'behavior' must be 'allow' or 'deny'");
    }
    let pending = match m.status(&id).await {
        LiveStatus::Live(st) => st.pending.into_iter().find(|p| p.request_id == request_id),
        LiveStatus::NotRunning => None,
        LiveStatus::Unanswered => bail!("the conversation did not answer in time — try again"),
    };
    let Some(pending) = pending else {
        bail!("no pending request '{request_id}' — it may have been answered or withdrawn (see get_pending_request)");
    };
    if !pending.is_question() {
        bail!(
            "answering a permission prompt or a plan approval needs Flight Deck on the Mac, where \
             it is behind an explicit setting — only questions (kind 'questions') can be answered \
             from this server"
        );
    }
    let updated_input = if behavior == "deny" {
        None
    } else if let Some(full) = args
        .get("updated_input")
        .filter(|v| v.get("answers").and_then(Value::as_object).is_some_and(|a| !a.is_empty()))
    {
        Some(full.clone())
    } else {
        let (answers, unmatched) = questionnaire_answers(&pending.input, args.get("answers").unwrap_or(&Value::Null));
        if answers.is_empty() {
            bail!(if unmatched.is_empty() {
                "provide 'answers' for the question (see get_pending_request) — keyed by the question \
                 text or its header, or a bare answer for a single question"
                    .to_string()
            } else {
                format!(
                    "none of your answers matched this question ({}) — key them by the question text \
                     or its header (see get_pending_request)",
                    unmatched.join("; ")
                )
            });
        }
        let mut input = if pending.input.is_object() { pending.input.clone() } else { json!({}) };
        input["answers"] = Value::Object(answers);
        Some(input)
    };
    let message = args.get("message").and_then(Value::as_str).map(String::from);
    let (ack, rx) = oneshot::channel();
    m.route(
        &id,
        SessionMsg::AnswerPermission {
            request_id: request_id.clone(),
            behavior: behavior.to_string(),
            message,
            updated_input,
            ack,
        },
    )
    .await?;
    rpc::await_ack(rx).await?.map_err(|e| anyhow!(e))?;
    Ok(json!({ "conversation_id": id, "request_id": request_id, "behavior": behavior }))
}

/// A caller's answers to an `AskUserQuestion`, resolved onto its REAL questions —
/// the Mac's `buildQuestionnaireAnswers` (`src/features/conversation/questionnaire.ts`):
/// the CLI reads `{ "<question text>": "<answer>" }` and silently ignores any other
/// key, so a model keying by header (or answering a lone question bare) must land
/// on the right one, and an answer that lands nowhere is reported, never dropped.
/// Each entry matches, in order: the question text, its `header`, or — one question,
/// one entry — that question. An array becomes its labels joined by ", " (the
/// multi-select shape). Returns the answers and the keys that matched nothing.
fn questionnaire_answers(input: &Value, provided: &Value) -> (serde_json::Map<String, Value>, Vec<String>) {
    fn norm(s: &str) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
    }
    fn text(v: &Value) -> String {
        match v {
            Value::Array(items) => items
                .iter()
                .map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            Value::String(s) => s.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string(),
        }
    }
    let questions: Vec<(String, String)> = input["questions"]
        .as_array()
        .map(|qs| {
            qs.iter()
                .filter_map(|q| {
                    let question = q["question"].as_str()?.to_string();
                    Some((question, q["header"].as_str().unwrap_or_default().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut answers = serde_json::Map::new();
    let mut unmatched = Vec::new();
    match provided {
        Value::String(_) | Value::Number(_) => {
            let t = text(provided);
            if questions.len() == 1 && !t.is_empty() {
                answers.insert(questions[0].0.clone(), json!(t));
            } else if !t.is_empty() {
                unmatched.push(t);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                let t = text(value);
                if t.is_empty() {
                    continue; // an empty value leaves the question unanswered
                }
                let k = norm(key);
                let target = questions
                    .iter()
                    .find(|(q, _)| norm(q) == k)
                    .or_else(|| questions.iter().find(|(_, h)| !h.is_empty() && norm(h) == k))
                    .or_else(|| (questions.len() == 1 && map.len() == 1).then(|| &questions[0]));
                match target {
                    Some((q, _)) => {
                        answers.insert(q.clone(), json!(t));
                    }
                    None => unmatched.push(key.clone()),
                }
            }
        }
        _ => {}
    }
    (answers, unmatched)
}

// ---------------------------------------------------------------------------
// wait_for_conversation

/// What the native `wait_for_conversation` needs to know between calls, for the
/// whole daemon: when each conversation last settled, and when a conversation
/// last messaged another through these tools. A message's answer that lands
/// BEFORE the sender starts waiting is still its answer (the Mac's
/// `noteMessageSent` semantics: "an event that happened after your last message
/// to it is returned at once").
#[derive(Default)]
pub struct Book(StdMutex<BookInner>);

#[derive(Default)]
struct BookInner {
    /// (caller, target) → when the caller last messaged the target and has not
    /// heard its answer yet.
    sent: HashMap<(String, String), i64>,
    /// target → its last [`SETTLES_KEPT`] settles (the fields a wait returns, and
    /// when), oldest first. Several, not one: the answer to a message is the FIRST
    /// settle after it — an `ended` that follows (a stop, a recycle at rest) must
    /// not hide the reply that came before.
    settled: HashMap<String, VecDeque<(Value, i64)>>,
}

const SETTLES_KEPT: usize = 8;

/// How much of a turn's last reply a wait quotes (the Mac's `QUOTE_MAX` order).
const REPLY_CLIP: usize = 4000;

/// What a wait returns for a daemon event that settles a conversation (the Mac's
/// `eventFields`) — `None` for any other event.
fn settle_fields(ev: &Event) -> Option<Value> {
    match ev.kind.as_str() {
        "turn_completed" => Some(json!({
            "outcome": "completed",
            "turn_outcome": ev.detail["outcome"],
            "open_question": ev.detail["open_question"],
            "last_assistant_text": ev.text.as_deref().map(|t| clip(t, REPLY_CLIP)),
        })),
        "needs_attention" => {
            let mut f = json!({ "outcome": "needs_attention", "reason": ev.detail["reason"] });
            if let Some(tool) = ev.detail["tool"].as_str() {
                f["tool"] = json!(tool);
            }
            f["prompt"] = ev.detail["prompt"].clone();
            Some(f)
        }
        _ => None,
    }
}

impl Book {
    /// The book itself. A panic while it was held (it does nothing that can) must
    /// not take every later wait down with it: the data stays usable.
    fn lock(&self) -> std::sync::MutexGuard<'_, BookInner> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn note_settle(&self, conv: &str, fields: Value, at_ms: i64) {
        let mut b = self.lock();
        let settles = b.settled.entry(conv.to_string()).or_default();
        settles.push_back((fields, at_ms));
        while settles.len() > SETTLES_KEPT {
            settles.pop_front();
        }
    }

    /// A daemon event (`SessionManager::emit`): a conversation settling.
    pub fn note_event(&self, ev: &Event) {
        if let Some(fields) = settle_fields(ev) {
            self.note_settle(&ev.conversation_id, fields, ev.at_ms);
        }
    }

    /// A conversation's claude is gone (its actor finished).
    pub fn note_ended(&self, conv: &str) {
        self.note_settle(conv, json!({ "outcome": "ended", "reason": "exited", "may_still_run": false }), frames::now_ms());
    }

    pub fn note_sent(&self, caller: &str, target: &str) {
        self.lock().sent.insert((caller.to_string(), target.to_string()), frames::now_ms());
    }

    /// The first settle of `target` since `caller` last messaged it, which
    /// `caller` has not heard yet — consumed: the next wait does not return it.
    fn take_unheard(&self, caller: &str, target: &str) -> Option<Value> {
        let mut b = self.lock();
        let key = (caller.to_string(), target.to_string());
        let sent_at = *b.sent.get(&key)?;
        let fields = b.settled.get(target)?.iter().find(|(_, at)| *at >= sent_at)?.0.clone();
        b.sent.remove(&key);
        Some(fields)
    }

    /// `caller` heard `target` settle (a wait returned it).
    fn heard(&self, caller: &str, target: &str) {
        self.lock().sent.remove(&(caller.to_string(), target.to_string()));
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// How often a wait checks that the awaited claude is still there (no event
/// marks its end).
const WAIT_LIVENESS_EVERY: Duration = Duration::from_secs(2);

async fn wait_for_conversation(m: &Arc<SessionManager>, caller: &str, args: &Value) -> Result<Value> {
    let named = args
        .get("conversation_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("'conversation_id' is required"))?;
    let id = known(m, named)?;
    if id == caller {
        bail!("a conversation cannot wait for itself");
    }
    // The wait the call asked for, clamped exactly as the Mac clamps it (the
    // catalogue's bridge margin taken off again).
    let wait = Duration::from_secs(catalog::wait_timeout_secs(args).saturating_sub(30));
    let started = tokio::time::Instant::now();
    // Subscribed BEFORE looking: a settle landing between the look and the
    // subscription would otherwise be missed.
    let mut events = m.events_tx.subscribe();
    let title = m.with_registry(|r| r.get(&id))?.map(|r| r.title).unwrap_or_default();
    let answer = |fields: Value| -> Value {
        let mut out = json!({
            "conversation_id": id,
            "title": if title.is_empty() { "New conversation".to_string() } else { title.clone() },
            "waited_seconds": started.elapsed().as_secs(),
        });
        if let (Some(o), Some(f)) = (out.as_object_mut(), fields.as_object()) {
            for (k, v) in f {
                o.insert(k.clone(), v.clone());
            }
        }
        out
    };

    if let Some(fields) = m.agent_book.take_unheard(caller, &id) {
        return Ok(answer(fields));
    }
    match m.status(&id).await {
        LiveStatus::Live(st) if st.running => {
            if let Some(p) = st.pending.iter().find(|p| p.awaits_human()) {
                m.agent_book.heard(caller, &id);
                let reason = if p.is_permission() && !p.is_question() { "permission" } else { "question" };
                let mut f = json!({ "outcome": "needs_attention", "reason": reason, "prompt": p.prompt });
                if reason == "permission" {
                    f["tool"] = json!(p.tool_name);
                }
                return Ok(answer(f));
            }
            if !st.busy && st.background_running == 0 {
                return Ok(answer(idle()));
            }
        }
        LiveStatus::Live(_) | LiveStatus::NotRunning => return Ok(answer(idle())),
        // Up, and maybe at work: wait.
        LiveStatus::Unanswered => {}
    }

    let deadline = started + wait;
    let mut liveness = tokio::time::interval(WAIT_LIVENESS_EVERY);
    liveness.tick().await; // the first tick is immediate
    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(ev) if ev.conversation_id == id => {
                    if let Some(fields) = settle_fields(&ev) {
                        // The book holds the same event (`SessionManager::emit` notes it first).
                        m.agent_book.heard(caller, &id);
                        return Ok(answer(fields));
                    }
                }
                Ok(_) => {}
                // Fell behind the event bus: what it missed is in the book.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(fields) = m.agent_book.take_unheard(caller, &id) {
                        return Ok(answer(fields));
                    }
                }
                Err(broadcast::error::RecvError::Closed) => bail!("the server is shutting down"),
            },
            _ = liveness.tick() => {
                if matches!(m.status(&id).await, LiveStatus::NotRunning) {
                    m.agent_book.heard(caller, &id);
                    return Ok(answer(json!({ "outcome": "ended", "reason": "exited", "may_still_run": false })));
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Ok(answer(json!({
                    "outcome": "timeout",
                    "note": "still working when the wait ran out — call wait_for_conversation again",
                })));
            }
        }
    }
}

fn idle() -> Value {
    json!({
        "outcome": "idle",
        "note": "nothing to wait for: it is not working, and you sent it nothing since it last settled",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mcp(rid: &str, server: &str, message: Value) -> String {
        json!({"type": "control_request", "request_id": rid,
               "request": {"subtype": "mcp_message", "server_name": server, "message": message}})
        .to_string()
    }

    #[test]
    fn only_our_servers_messages_are_taken() {
        let m = parse(&mcp("r1", "flightdeck", json!({"id": 1, "method": "ping"}))).expect("ours");
        assert_eq!(m.request_id, "r1");
        assert_eq!(m.message["method"], "ping");
        assert!(parse(&mcp("r2", "elsewhere", json!({"id": 1, "method": "ping"}))).is_none());
        let perm = json!({"type": "control_request", "request_id": "r3",
                          "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "echo mcp_message"}}});
        assert!(parse(&perm.to_string()).is_none(), "a permission naming the word is not an mcp_message");
    }

    /// The handshake is the daemon's own, with the Mac's catalogue; a call to a
    /// listed tool is handed back to be run; protocol errors are protocol errors.
    #[test]
    fn the_handshake_is_answered_here_and_calls_are_handed_back() {
        let Step::Reply(r) = step(&json!({"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}), "box")
        else {
            panic!("initialize is answered")
        };
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "flightdeck");
        assert!(r["result"]["instructions"].as_str().unwrap().contains("\"box\""));

        let Step::Reply(r) = step(&json!({"id": 2, "method": "tools/list"}), "box") else { panic!() };
        assert_eq!(r["result"], catalog::list_json(Surface::App), "the very catalogue the Mac serves");

        let Step::Call { id, name, args } =
            step(&json!({"id": 3, "method": "tools/call", "params": {"name": "send_message", "arguments": {"text": "hi"}}}), "box")
        else {
            panic!("a call is handed back")
        };
        assert_eq!((id, name.as_str(), args), (json!(3), "send_message", json!({"text": "hi"})));

        let Step::Reply(r) = step(&json!({"id": 4, "method": "tools/call", "params": {"name": "nope"}}), "box") else { panic!() };
        assert_eq!(r["error"]["code"], -32602);
        let Step::Reply(r) = step(&json!({"id": 5, "method": "resources/list"}), "box") else { panic!() };
        assert_eq!(r["error"]["code"], -32601);
        let Step::Reply(r) = step(&json!({"id": 6, "method": 42}), "box") else { panic!() };
        assert_eq!(r["error"]["code"], -32600);
    }

    /// EVERY message is answered — claude awaits each one, a notification included.
    #[test]
    fn a_notification_and_a_stray_response_get_the_ack() {
        for msg in [json!({"method": "notifications/initialized"}), json!({"id": 7, "result": {}})] {
            let Step::Reply(r) = step(&msg, "box") else { panic!("{msg} is answered") };
            assert_eq!(r, jsonrpc::notification_ack());
        }
    }

    #[test]
    fn a_client_initialize_gains_the_server_once_and_nothing_else_changes() {
        let init = json!({"type": "control_request", "request_id": "tosse-1",
                          "request": {"subtype": "initialize", "perTaskStopAffordance": true}});
        let v: Value = serde_json::from_str(&with_sdk_server(&init.to_string()).unwrap()).unwrap();
        assert_eq!(v["request"]["sdkMcpServers"], json!(["flightdeck"]));
        assert_eq!(v["request"]["perTaskStopAffordance"], true);
        assert_eq!(v["request_id"], "tosse-1");
        // Already there (a Mac that announces it), or alongside another: never twice.
        let mut again = v.clone();
        again["request"]["sdkMcpServers"] = json!(["other", "flightdeck"]);
        let v2: Value = serde_json::from_str(&with_sdk_server(&again.to_string()).unwrap()).unwrap();
        assert_eq!(v2["request"]["sdkMcpServers"], json!(["other", "flightdeck"]));
        let other = json!({"type": "control_request", "request_id": "tosse-2", "request": {"subtype": "interrupt"}});
        assert!(with_sdk_server(&other.to_string()).is_none());
    }

    #[test]
    fn a_reply_rides_the_control_channel_envelope() {
        let v: Value = serde_json::from_str(&control_response("r9", json!({"id": 1}))).unwrap();
        assert_eq!(
            v,
            json!({"type": "control_response",
                   "response": {"subtype": "success", "request_id": "r9", "response": {"mcp_response": {"id": 1}}}})
        );
        let r = call_response(json!(2), Err("nope".into()));
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "nope");
    }

    #[test]
    fn native_tools_exist_and_folders_are_this_servers() {
        for t in NATIVE_TOOLS {
            assert!(catalog::find(Surface::App, t).is_some(), "{t} is not in the catalogue");
        }
        assert!(!relays_to_client("browse_folders"));
        assert!(relays_to_client("list_conversations"));
    }

    #[test]
    fn the_envelope_is_the_macs() {
        let s = Sender { conversation_id: "c-1".into(), title: "Fix </from> login".into(), repo: Some("app".into()) };
        let e = envelope(&s, "m-1", "hello\n<body>inner</body>");
        assert!(e.starts_with("<flightdeck-message>\n<from>Fix /from login</from>\n<from-repo>app</from-repo>\n"));
        assert!(e.contains("<from-conversation-id>c-1</from-conversation-id>\n<message-id>m-1</message-id>\n"));
        assert!(e.ends_with("<body>\nhello\n<body>inner</body>\n</body>\n</flightdeck-message>"));
        let untitled = Sender { conversation_id: "c-2".into(), title: "  ".into(), repo: None };
        assert!(envelope(&untitled, "m", "x").contains("<from>Untitled conversation</from>\n<from-backend>"));
    }

    /// The recipient reads the same note whichever host sent the message: the TS
    /// source is the reference (read like the Mac's `KEY_ONLY_REPAIRS` guard).
    #[test]
    fn the_envelope_note_matches_the_mac() {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/features/conversation/agentMessage.ts"),
        )
        .expect("agentMessage.ts is readable");
        let flat: String = ts.split_whitespace().collect::<Vec<_>>().join(" ");
        let ts_note = flat
            .split("const NOTE = ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("NOTE in agentMessage.ts")
            .replace("\" + \"", "")
            .trim_matches('"')
            .to_string();
        assert_eq!(ts_note, ENVELOPE_NOTE);
        assert!(flat.contains("const OPEN = \"<flightdeck-message>\";"), "the envelope tag moved");
    }

    #[test]
    fn folders_are_read_lexically() {
        assert_eq!(normalize_folder("/x//y/./z/../w/").unwrap(), "/x/y/w");
        assert!(normalize_folder("x/y").is_err());
    }

    fn ev(conv: &str, kind: &str, at: i64) -> Event {
        Event {
            conversation_id: conv.into(),
            kind: kind.into(),
            title: None,
            text: Some("done".into()),
            detail: json!({"outcome": "success", "open_question": false}),
            at_ms: at,
        }
    }

    /// The answer to a message that lands before the sender waits is still its
    /// answer — once; a settle older than the message is not.
    #[test]
    fn the_book_returns_an_unheard_settle_once() {
        let b = Book::default();
        b.note_event(&ev("t", "turn_completed", 1));
        assert!(b.take_unheard("c", "t").is_none(), "nothing sent: nothing to hear");
        b.note_sent("c", "t");
        assert!(b.take_unheard("c", "t").is_none(), "that settle predates the message");
        b.note_event(&ev("t", "turn_completed", frames::now_ms() + 1));
        let f = b.take_unheard("c", "t").expect("the answer");
        assert_eq!((f["outcome"].as_str(), f["last_assistant_text"].as_str()), (Some("completed"), Some("done")));
        assert!(b.take_unheard("c", "t").is_none(), "heard once");
        // An event that settles nothing is no answer; the process ending is one.
        let b = Book::default();
        b.note_sent("c", "t");
        b.note_event(&ev("t", "attention_cleared", frames::now_ms() + 2));
        assert!(b.take_unheard("c", "t").is_none());
        b.note_ended("t");
        assert_eq!(b.take_unheard("c", "t").unwrap()["outcome"], "ended");
    }

    /// A stop (or a recycle at rest) right after the answer does not hide it: the
    /// answer to a message is the FIRST settle after it.
    #[test]
    fn an_end_after_the_reply_does_not_hide_it() {
        let b = Book::default();
        b.note_sent("c", "t");
        b.note_event(&ev("t", "turn_completed", frames::now_ms() + 1));
        b.note_ended("t");
        assert_eq!(b.take_unheard("c", "t").unwrap()["outcome"], "completed");
    }

    /// The Mac's matching: by question text, then header, then the lone question;
    /// an answer that lands nowhere is reported, never written under a key the CLI
    /// would ignore.
    #[test]
    fn answers_land_on_the_real_questions() {
        let input = json!({"questions": [
            {"question": "Which database?", "header": "DB", "options": [{"label": "Postgres"}]},
            {"question": "Deploy now?", "header": "Deploy", "options": [{"label": "Yes"}]},
        ]});
        let (a, miss) = questionnaire_answers(&input, &json!({"which  DATABASE?": "Postgres", "deploy": ["Yes", "Later"], "nope": "x"}));
        assert_eq!(Value::Object(a), json!({"Which database?": "Postgres", "Deploy now?": "Yes, Later"}));
        assert_eq!(miss, vec!["nope".to_string()]);
        let one = json!({"questions": [{"question": "Name?", "header": "N"}]});
        let (a, _) = questionnaire_answers(&one, &json!("Ada"));
        assert_eq!(Value::Object(a), json!({"Name?": "Ada"}));
        let (a, _) = questionnaire_answers(&one, &json!({"whatever": "Ada"}));
        assert_eq!(Value::Object(a), json!({"Name?": "Ada"}), "one question, one entry");
        let (a, miss) = questionnaire_answers(&input, &json!("bare"));
        assert!(a.is_empty() && miss == ["bare"], "a bare answer is ambiguous with two questions");
    }

    #[test]
    fn a_relayed_call_waits_a_little_longer_than_the_macs_own_deadline() {
        assert_eq!(relay_deadline("list_conversations", &json!({})), Duration::from_secs(catalog::FRONT_TIMEOUT_SECS + 15));
        let wait = relay_deadline("wait_for_conversation", &json!({"timeout_seconds": 60}));
        assert_eq!(wait, Duration::from_secs(catalog::wait_timeout_secs(&json!({"timeout_seconds": 60})) + 15));
    }
}
