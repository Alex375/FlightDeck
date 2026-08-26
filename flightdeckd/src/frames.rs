//! Wire-line inspection and the fd_* framing the daemon adds around claude's
//! stream-json.
//!
//! The daemon is a *transparent pipe* between claude and an attached client,
//! plus a seq-numbered replay ring. Which lines enter the ring (and therefore
//! count toward the replay cursor) is a CONTRACT shared with the tosse-code
//! transport (`supervisor/transport.rs`, `is_replayable_line`): a line is
//! replayable iff it parses as a JSON object whose `type` is a string outside
//! the control plane. Both sides must agree line-for-line or cursors drift.

use serde::Deserialize;
use serde_json::{json, Value};

/// Minimal probe of a stream-json line: just enough to route it.
#[derive(Debug, Default, Deserialize)]
pub struct LineProbe {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub subtype: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
}

pub fn probe(line: &str) -> Option<LineProbe> {
    serde_json::from_str::<LineProbe>(line).ok()
}

/// Control-plane types: correlation-scoped to ONE client/process lifetime,
/// never replayed (a fresh client re-issues its own `tosse-N` requests, and a
/// stale `control_response` could collide with them). `fd_*` frames are the
/// daemon's own and are likewise never ringed.
pub fn is_replayable_type(kind: &str) -> bool {
    !matches!(
        kind,
        "control_response" | "control_request" | "control_cancel_request" | "keep_alive"
    ) && !kind.starts_with("fd_")
}

/// Replay eligibility of a raw stdout line (see module doc: shared contract).
pub fn is_replayable_line(line: &str) -> bool {
    match probe(line) {
        Some(p) => p.kind.as_deref().map(is_replayable_type).unwrap_or(false),
        None => false,
    }
}

/// First line the daemon sends on a (re)attach: identifies the conversation,
/// the claude-process epoch, and where the replay starts.
pub fn fd_attach(conversation: &str, epoch: &str, replay_from: u64, seq_now: u64) -> String {
    json!({
        "type": "fd_attach",
        "conversation": conversation,
        "epoch": epoch,
        "replay_from": replay_from,
        "seq": seq_now,
    })
    .to_string()
}

/// Last line before the daemon closes an attach stream. `reason` ∈
/// "replaced" (a newer client took over — do NOT auto-reconnect),
/// "stopped" (explicit fd_stop — do not reconnect),
/// "exited" (the claude process ended — do not reconnect, session is over).
pub fn fd_detach(reason: &str, exit_code: Option<i32>) -> String {
    let mut v = json!({ "type": "fd_detach", "reason": reason });
    if let Some(c) = exit_code {
        v["exit_code"] = json!(c);
    }
    v.to_string()
}

/// A user message line the daemon writes on claude's stdin for phone sends
/// (same shape as tosse-code `transport::user_message`).
pub fn user_message(text: &str, uuid: &str) -> String {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": { "role": "user", "content": [ { "type": "text", "text": text } ] }
    })
    .to_string()
}

/// `control_request` envelope (daemon-issued ids use the `fdd-` prefix so they
/// can never collide with a client's `tosse-N` correlation space).
pub fn control_request(request_id: &str, request: Value) -> String {
    json!({ "request_id": request_id, "type": "control_request", "request": request }).to_string()
}

pub fn interrupt_request(request_id: &str) -> String {
    control_request(request_id, json!({ "subtype": "interrupt" }))
}

/// Permission answers (mirrors tosse-code `control.rs` — doubly-nested,
/// camelCase result fields).
pub fn permission_allow_response(request_id: &str, tool_use_id: &str, updated_input: Value) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": { "behavior": "allow", "updatedInput": updated_input, "toolUseID": tool_use_id }
        }
    })
    .to_string()
}

pub fn permission_deny_response(request_id: &str, tool_use_id: &str, message: &str) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": { "behavior": "deny", "message": message, "toolUseID": tool_use_id }
        }
    })
    .to_string()
}

/// Milliseconds since the epoch (the wire's timestamp unit).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replayable_excludes_control_plane_and_fd() {
        assert!(is_replayable_line(r#"{"type":"assistant","message":{}}"#));
        assert!(is_replayable_line(r#"{"type":"system","subtype":"init"}"#));
        assert!(is_replayable_line(r#"{"type":"stream_event","event":{}}"#));
        assert!(is_replayable_line(r#"{"type":"result","subtype":"success"}"#));
        assert!(!is_replayable_line(r#"{"type":"control_response","response":{}}"#));
        assert!(!is_replayable_line(r#"{"type":"control_request","request":{}}"#));
        assert!(!is_replayable_line(r#"{"type":"control_cancel_request"}"#));
        assert!(!is_replayable_line(r#"{"type":"keep_alive"}"#));
        assert!(!is_replayable_line(r#"{"type":"fd_attach"}"#));
        assert!(!is_replayable_line("not json"));
        assert!(!is_replayable_line(r#"{"no_type":true}"#));
    }

    #[test]
    fn fd_frames_shape() {
        let a = fd_attach("conv-1", "ep", 3, 10);
        let v: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v["type"], "fd_attach");
        assert_eq!(v["replay_from"], 3);
        assert_eq!(v["seq"], 10);
        let d = fd_detach("exited", Some(1));
        let v: Value = serde_json::from_str(&d).unwrap();
        assert_eq!(v["reason"], "exited");
        assert_eq!(v["exit_code"], 1);
    }

    #[test]
    fn probe_reads_request_id() {
        let p = probe(r#"{"type":"control_request","request_id":"x","request":{"subtype":"can_use_tool"}}"#).unwrap();
        assert_eq!(p.kind.as_deref(), Some("control_request"));
        assert_eq!(p.request_id.as_deref(), Some("x"));
    }
}
