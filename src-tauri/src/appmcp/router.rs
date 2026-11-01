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

// The JSON-RPC pieces live with the catalogue, shared with `flightdeckd` (which
// answers the same server for the conversations it runs): one wire, two hosts.
use tools::jsonrpc::{err, negotiated_version, ok, tool_error, tool_success};
pub use tools::jsonrpc::{notification_ack, PROTOCOL_VERSION};

/// Handle one JSON-RPC message. `None` = nothing goes on the wire (a
/// notification, or a stray response — we never send server-initiated requests,
/// so any inbound response is dropped).
pub async fn handle(
    hub: &Arc<ControlHub>,
    surface: Surface,
    caller: &Caller,
    msg: &Value,
) -> Option<Value> {
    // Per JSON-RPC, a request has a non-null id; anything else is a notification
    // (or a stray response — we never send server-initiated requests, so those
    // are dropped).
    let id = match msg.get("id") {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => None,
    };
    let method = match msg.get("method").and_then(Value::as_str) {
        Some(m) => m,
        None => {
            // A RESPONSE (it has result/error) is dropped silently — answering
            // it would send the peer an error it never asked for. Anything else
            // carrying an id is a malformed REQUEST and must still be answered:
            // swallowing it would leave the caller's pending id hanging until
            // its own timeout, with no diagnostic (-32600 per JSON-RPC).
            if msg.get("result").is_some() || msg.get("error").is_some() {
                return None;
            }
            return id.map(|id| err(id, -32600, "Invalid Request: missing method".to_string()));
        }
    };
    let Some(id) = id else { return None };
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
    let version = negotiated_version(params);
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
        Ok(value) => ok(id, tool_success(value)),
        Err(message) => ok(id, tool_error(&message)),
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

    /// Notifications produce no wire response; a stray RESPONSE is dropped; a
    /// malformed REQUEST (id but no usable method) is answered -32600 rather
    /// than swallowed (the caller's pending id must resolve).
    #[tokio::test]
    async fn notifications_yield_none() {
        let h = hub();
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&h, Surface::App, &Caller::External, &msg).await.is_none());
        // A stray response (no method, has result) is dropped.
        let msg = json!({ "jsonrpc": "2.0", "id": 4, "result": {} });
        assert!(handle(&h, Surface::App, &Caller::External, &msg).await.is_none());
        // A request with a non-string method gets -32600, not silence.
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": 42 });
        let resp = handle(&h, Surface::App, &Caller::External, &msg).await.unwrap();
        assert_eq!(resp["error"]["code"], -32600);
        assert_eq!(resp["id"], 7);
        // The same shape WITHOUT an id is a malformed notification: no reply.
        let msg = json!({ "jsonrpc": "2.0", "method": 42 });
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

    /// REGRESSION: `structuredContent` must be an object (MCP spec; Claude
    /// Code rejects the whole call otherwise). A bare array — what
    /// `list_conversations` returns — travels as text only, unchanged.
    #[test]
    fn structured_content_is_only_ever_an_object() {
        let list = json!([{ "id": "c1", "title": "Conv" }]);
        let result = tool_success(list.clone());
        assert!(result.get("structuredContent").is_none());
        let text = result["content"][0]["text"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), list);

        let object = json!({ "cursor": 3, "events": [] });
        let result = tool_success(object.clone());
        assert_eq!(result["structuredContent"], object);

        let result = tool_success(json!("done"));
        assert!(result.get("structuredContent").is_none());
        assert_eq!(result["content"][0]["text"], "done");
    }
}
