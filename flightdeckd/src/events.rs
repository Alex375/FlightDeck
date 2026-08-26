//! Events pushed to phones through the relay (broadcast, no `_cid`).
//! Wire shape mirrors the Mac app (tosse-code appmcp/relay.rs): camelCase
//! `conversationId` — the one exception to the snake_case params convention.

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Event {
    pub conversation_id: String,
    /// "turn_completed" | "needs_attention" | "attention_cleared" | "task_finished"
    pub kind: String,
    pub title: Option<String>,
    pub text: Option<String>,
    pub detail: Value,
    pub at_ms: i64,
}

impl Event {
    pub fn to_frame(&self) -> String {
        json!({
            "type": "event",
            "event": {
                "conversationId": self.conversation_id,
                "kind": self.kind,
                "title": self.title,
                "text": self.text,
                "at": self.at_ms,
                "detail": self.detail,
            }
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_shape() {
        let e = Event {
            conversation_id: "c1".into(),
            kind: "turn_completed".into(),
            title: None,
            text: Some("done".into()),
            detail: json!({"outcome": "success"}),
            at_ms: 42,
        };
        let v: Value = serde_json::from_str(&e.to_frame()).unwrap();
        assert_eq!(v["type"], "event");
        assert_eq!(v["event"]["conversationId"], "c1");
        assert_eq!(v["event"]["kind"], "turn_completed");
        assert_eq!(v["event"]["at"], 42);
    }
}
