//! Minimal MCP server-side JSON-RPC router, shared by both transports.
//!
//! Implements exactly what an MCP client needs from a tools-only server:
//! `initialize`, `ping`, `tools/list`, `tools/call`, plus notification intake.
//! No resources / prompts / sampling — the capabilities object advertises tools
//! only, so a compliant client won't ask for the rest (and gets a clean
//! -32601 if it does).
//!
//! Error split, per the MCP spec: an unknown METHOD or unknown TOOL is a
//! JSON-RPC protocol error; a tool that runs and fails returns a RESULT with
//! `isError: true` so the model can read the failure text and react.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{tools, Caller, ControlHub, Surface};

/// Latest protocol revision we implement. We echo the client's requested
/// version when we know it; otherwise we answer with this one (per spec, the
/// client then decides whether it can live with it).
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const KNOWN_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The ack payload the control channel expects for a NOTIFICATION delivered via
/// `mcp_message` — dissected from the CLI (2.1.233): the SDK client answers
/// `{jsonrpc:"2.0", result:{}, id:0}` when the message had no id.
pub fn notification_ack() -> Value {
    json!({ "jsonrpc": "2.0", "result": {}, "id": 0 })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Handle one JSON-RPC message. `None` = nothing goes on the wire (a
/// notification, or a stray response — we never send server-initiated requests,
/// so any inbound response is dropped).
pub async fn handle(
    hub: &Arc<ControlHub>,
    surface: Surface,
    caller: &Caller,
    msg: &Value,
) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str)?;
    // Per JSON-RPC, a request has a non-null id; anything else is a notification.
    let id = match msg.get("id") {
        Some(v) if !v.is_null() => v.clone(),
        _ => return None,
    };
    Some(match method {
        "initialize" => ok(id, initialize_result(surface, msg.get("params"))),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, tools::list_json(surface)),
        "tools/call" => tools_call(hub, surface, caller, msg.get("params"), id).await,
        other => err(id, -32601, format!("Method not found: {other}")),
    })
}

/// The `initialize` result: version negotiation + a tools-only capability set.
fn initialize_result(surface: Surface, params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(PROTOCOL_VERSION);
    let version = if KNOWN_VERSIONS.contains(&requested) { requested } else { PROTOCOL_VERSION };
    let (name, instructions) = match surface {
        Surface::App => (
            super::SDK_SERVER_NAME,
            "Tools that control the Flight Deck desktop app you are running in: open files in \
             its editor, switch views/panels, and create, read, message or focus the other \
             agent conversations it manages. Prefer open_file over asking the user to open \
             something themselves.",
        ),
        Surface::Voice => (
            "flightdeck-voice",
            "Conversation bridge to the Flight Deck desktop app: list the agent conversations, \
             read their latest exchanges, send them prompts, and long-poll wait_for_events to \
             hear when a conversation finishes its turn or needs input.",
        ),
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": name,
            "title": "Flight Deck",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": instructions,
    })
}

/// `tools/call`: resolve the tool on this surface, execute, wrap the outcome.
async fn tools_call(
    hub: &Arc<ControlHub>,
    surface: Surface,
    caller: &Caller,
    params: Option<&Value>,
    id: Value,
) -> Value {
    let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
    let Some(name) = name else {
        return err(id, -32602, "tools/call: missing tool name".to_string());
    };
    let Some(def) = tools::find(surface, name) else {
        return err(id, -32602, format!("Unknown tool: {name}"));
    };
    let empty = json!({});
    let args = params.and_then(|p| p.get("arguments")).unwrap_or(&empty);
    match hub.execute_tool(&def, caller, args).await {
        Ok(value) => {
            // Text for every client; the structured value alongside when it is
            // structured (objects/arrays), so richer clients skip the re-parse.
            let text = match &value {
                Value::String(s) => s.clone(),
                v => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
            };
            let mut result = json!({ "content": [{ "type": "text", "text": text }] });
            if value.is_object() || value.is_array() {
                result["structuredContent"] = value;
            }
            ok(id, result)
        }
        Err(message) => ok(
            id,
            json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> Arc<ControlHub> {
        Arc::new(ControlHub::new())
    }

    /// ACCEPTANCE: the full client handshake — initialize echoes a known
    /// version, advertises tools, and identifies the surface's server.
    #[tokio::test]
    async fn initialize_negotiates_and_identifies() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {} } });
        let resp = handle(&h, Surface::App, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(resp["result"]["serverInfo"]["name"], "flightdeck");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        // Unknown requested version → we answer with ours instead of failing.
        let msg = json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize",
            "params": { "protocolVersion": "2099-01-01" } });
        let resp = handle(&h, Surface::Voice, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(resp["result"]["serverInfo"]["name"], "flightdeck-voice");
    }

    /// Notifications produce no wire response.
    #[tokio::test]
    async fn notifications_yield_none() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&h, Surface::App, &Caller::External, &msg).await.is_none());
        // A stray response (no method) is dropped too.
        let msg = json!({ "jsonrpc": "2.0", "id": 4, "result": {} });
        assert!(handle(&h, Surface::App, &Caller::External, &msg).await.is_none());
    }

    /// tools/list serves the surface's catalogue; unknown methods -32601.
    #[tokio::test]
    async fn tools_list_and_unknown_method() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" });
        let resp = handle(&h, Surface::Voice, &Caller::External, &msg).await.unwrap();
        let names: Vec<&str> = resp["result"]["tools"].as_array().unwrap()
            .iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"wait_for_events"));
        assert!(!names.contains(&"open_file"));
        let msg = json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" });
        let resp = handle(&h, Surface::App, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    /// An unknown TOOL is a protocol error (-32602), per spec — not an isError
    /// result the model would try to reason about.
    #[tokio::test]
    async fn unknown_tool_is_a_protocol_error() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "no_such_tool", "arguments": {} } });
        let resp = handle(&h, Surface::App, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["error"]["code"], -32602);
    }

    /// A tool that EXECUTES and fails comes back as an isError RESULT carrying
    /// the failure text (here: no front sink installed).
    #[tokio::test]
    async fn failing_tool_execution_is_an_is_error_result() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": { "name": "list_conversations" } });
        let resp = handle(&h, Surface::App, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["result"]["isError"], true);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("not ready"));
    }

    /// wait_for_events runs Rust-side (no front bridge): a cursorless call
    /// returns a baseline immediately, wrapped with structuredContent.
    #[tokio::test]
    async fn wait_for_events_serves_from_the_journal() {
        let h = hub();
        h.events.publish("turn_completed", "c1", "Conv", json!({}));
        let msg = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "wait_for_events", "arguments": {} } });
        let resp = handle(&h, Surface::Voice, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["result"]["structuredContent"]["cursor"], 1);
        assert!(resp["result"]["isError"].is_null());
    }
}
