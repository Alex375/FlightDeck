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

/// Cap on the pushed `text` so an event frame stays far under the relay's
/// 256 KB `maxPayload` (an oversize frame closes the mac socket).
const EVENT_TEXT_CLIP: usize = 1500;

impl Event {
    pub fn to_frame(&self) -> String {
        // PROTOCOL §5 declares detail fields like `attention_cleared.reason` /
        // `.request_id` and `task_finished.task_id` as fields OF THE EVENT (the
        // PWA reads e.request_id top-level, never e.detail.request_id) — so the
        // detail object is flattened onto the event, and also kept under
        // `detail` for parity with the Mac app's frames.
        let mut event = json!({
            "conversationId": self.conversation_id,
            "kind": self.kind,
            "title": self.title,
            "text": self.text.as_deref().map(clip),
            "at": self.at_ms,
            "detail": self.detail,
        });
        if let (Some(obj), Some(detail)) = (event.as_object_mut(), self.detail.as_object()) {
            for (k, v) in detail {
                obj.entry(k.clone()).or_insert_with(|| match v.as_str() {
                    Some(s) => json!(clip(s)),
                    None => v.clone(),
                });
            }
        }
        json!({ "type": "event", "event": event }).to_string()
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() <= EVENT_TEXT_CLIP {
        s.to_string()
    } else {
        let c: String = s.chars().take(EVENT_TEXT_CLIP).collect();
        format!("{c}…")
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
        // detail fields are flattened top-level (the PWA reads them there)…
        assert_eq!(v["event"]["outcome"], "success");
        // …without clobbering the core fields.
        assert_eq!(v["event"]["text"], "done");
    }

    #[test]
    fn detail_cannot_clobber_core_fields_and_text_is_clipped() {
        let e = Event {
            conversation_id: "c1".into(),
            kind: "attention_cleared".into(),
            title: None,
            text: Some("y".repeat(10_000)),
            detail: json!({"reason": "answered", "request_id": "rq-1", "kind": "EVIL"}),
            at_ms: 1,
        };
        let v: Value = serde_json::from_str(&e.to_frame()).unwrap();
        assert_eq!(v["event"]["reason"], "answered");
        assert_eq!(v["event"]["request_id"], "rq-1");
        assert_eq!(v["event"]["kind"], "attention_cleared"); // not clobbered
        assert!(v["event"]["text"].as_str().unwrap().chars().count() <= 1501);
    }
}
