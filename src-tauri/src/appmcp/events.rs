//! Fleet event journal — what the voice bridge's `wait_for_events` long-polls.
//!
//! The FRONT is the producer: it publishes from the same settled transition
//! point that fires OS notifications (`fireAgentNotification` in
//! `useGlobalSessionEvents.ts`, via the `publish_control_event` IPC command), so
//! the voice agent hears exactly what the human would have been pinged about —
//! after the settle window, minus no-op turns, minus "finished but background
//! work continues". Events are app-global (all conversations), cursor-ordered,
//! and kept in a small ring: a slow consumer loses the oldest entries, never
//! blocks the producer.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::Notify;

/// Ring capacity. Far above what a voice agent can lag by in practice; beyond
/// it, oldest events are dropped (the consumer resyncs from its next poll).
const CAPACITY: usize = 256;

/// Default / maximum long-poll durations for `wait_for_events`. The default sits
/// under common MCP client timeouts (~30 s); the cap keeps a forgotten call from
/// pinning a connection for minutes.
const DEFAULT_WAIT: Duration = Duration::from_secs(25);
const MAX_WAIT: Duration = Duration::from_secs(55);

/// Cap on events returned by one poll.
const MAX_BATCH: usize = 50;

/// One journal entry. `cursor` is monotonically increasing and never reused.
#[derive(Debug, Clone)]
pub struct ControlEvent {
    pub cursor: u64,
    pub at_ms: u64,
    pub kind: String,
    pub conversation_id: String,
    pub title: String,
    pub detail: Value,
}

impl ControlEvent {
    fn to_json(&self) -> Value {
        json!({
            "cursor": self.cursor,
            "at_ms": self.at_ms,
            "kind": self.kind,
            "conversation_id": self.conversation_id,
            "title": self.title,
            "detail": self.detail,
        })
    }
}

struct Journal {
    next_cursor: u64,
    buf: VecDeque<ControlEvent>,
}

/// The shared journal: a mutex-guarded ring plus a [`Notify`] that wakes every
/// waiting long-poll on each publish.
pub struct EventJournal {
    state: Mutex<Journal>,
    notify: Notify,
}

impl Default for EventJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl EventJournal {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(Journal { next_cursor: 1, buf: VecDeque::new() }),
            notify: Notify::new(),
        }
    }

    /// Append one event and wake every waiting poll.
    pub fn publish(&self, kind: &str, conversation_id: &str, title: &str, detail: Value) {
        {
            let mut j = self.state.lock().expect("journal lock");
            let cursor = j.next_cursor;
            j.next_cursor += 1;
            j.buf.push_back(ControlEvent {
                cursor,
                at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                kind: kind.to_string(),
                conversation_id: conversation_id.to_string(),
                title: title.to_string(),
                detail,
            });
            while j.buf.len() > CAPACITY {
                j.buf.pop_front();
            }
        }
        self.notify.notify_waiters();
    }

    /// The `wait_for_events` tool body: parse `{cursor?, timeout_seconds?}` and
    /// long-poll. Contract (documented in the tool description):
    /// - no `cursor` → return the current baseline cursor immediately, no wait;
    /// - with `cursor` → return every event after it (capped), waiting up to the
    ///   timeout when there is none yet.
    pub async fn wait_from_args(&self, args: &Value) -> Value {
        let cursor = args.get("cursor").and_then(Value::as_u64);
        let timeout = args
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .map(|s| Duration::from_secs(s).min(MAX_WAIT))
            .unwrap_or(DEFAULT_WAIT);
        let (cursor, events) = match cursor {
            None => (self.latest_cursor(), Vec::new()),
            Some(after) => self.wait(after, timeout).await,
        };
        json!({
            "cursor": cursor,
            "events": events.iter().map(ControlEvent::to_json).collect::<Vec<_>>(),
        })
    }

    /// Latest assigned cursor (0 when nothing was ever published) — the baseline
    /// a first poll starts from.
    pub fn latest_cursor(&self) -> u64 {
        self.state.lock().expect("journal lock").next_cursor - 1
    }

    /// Events strictly after `after` (up to [`MAX_BATCH`]), waiting up to
    /// `timeout` when none are available yet. Returns the new cursor to poll
    /// from: the last returned event's, or — on an EMPTY return — `after`
    /// UNCHANGED. Never a fresher cursor with an empty batch: that would tell
    /// the client to skip events it was never given (an event published in the
    /// deadline race would be silently lost forever — the one failure mode a
    /// delivery journal must not have).
    pub async fn wait(&self, after: u64, timeout: Duration) -> (u64, Vec<ControlEvent>) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Register interest BEFORE checking, so a publish landing between the
            // check and the await still wakes us (no lost-wakeup window).
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let j = self.state.lock().expect("journal lock");
                let events: Vec<ControlEvent> = j
                    .buf
                    .iter()
                    .filter(|e| e.cursor > after)
                    .take(MAX_BATCH)
                    .cloned()
                    .collect();
                if !events.is_empty() {
                    let cursor = events.last().expect("non-empty").cursor;
                    return (cursor, events);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return (after, Vec::new());
            }
            tokio::select! {
                _ = notified.as_mut() => {}
                // Deadline hit — but a publish may have landed between the check
                // above and now: fall through and loop ONCE more, so the re-check
                // under the lock runs before the empty return.
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// ACCEPTANCE: events published after a cursor are returned, with the new
    /// cursor advancing past them.
    #[tokio::test]
    async fn wait_returns_events_after_the_cursor() {
        let j = EventJournal::new();
        j.publish("turn_completed", "c1", "Conv 1", json!({}));
        j.publish("needs_attention", "c2", "Conv 2", json!({"tool": "Bash"}));
        let (cursor, events) = j.wait(0, Duration::from_millis(10)).await;
        assert_eq!(events.len(), 2);
        assert_eq!(cursor, 2);
        assert_eq!(events[0].kind, "turn_completed");
        assert_eq!(events[1].conversation_id, "c2");
        // Nothing new after the returned cursor: empty on timeout, cursor stable.
        let (cursor2, events2) = j.wait(cursor, Duration::from_millis(10)).await;
        assert!(events2.is_empty());
        assert_eq!(cursor2, 2);
    }

    /// A poll parked on an empty journal is woken by a publish (long-poll, not
    /// a sleep-then-check).
    #[tokio::test]
    async fn a_parked_wait_is_woken_by_publish() {
        let j = Arc::new(EventJournal::new());
        let j2 = j.clone();
        let waiter = tokio::spawn(async move { j2.wait(0, Duration::from_secs(5)).await });
        // Let the waiter park, then publish.
        tokio::time::sleep(Duration::from_millis(20)).await;
        j.publish("turn_completed", "c1", "Conv 1", Value::Null);
        let (cursor, events) = waiter.await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(cursor, 1);
    }

    /// The ring drops its oldest entries beyond capacity; a lagging consumer
    /// gets what remains instead of an error.
    #[tokio::test]
    async fn the_ring_caps_its_size() {
        let j = EventJournal::new();
        for i in 0..(CAPACITY + 10) {
            j.publish("turn_completed", &format!("c{i}"), "t", Value::Null);
        }
        let (_, events) = j.wait(0, Duration::from_millis(1)).await;
        // MAX_BATCH caps one poll; the oldest surviving cursor proves the drop.
        assert_eq!(events.len(), MAX_BATCH);
        assert_eq!(events[0].cursor, 11); // 266 published, ring keeps 11..=266
    }

    /// REGRESSION (event loss): an EMPTY return must echo the caller's cursor
    /// UNCHANGED — never the journal's latest. Returning a fresher cursor with
    /// no events would make the client skip whatever was published in the
    /// deadline race, losing it forever.
    #[tokio::test]
    async fn an_empty_timeout_never_advances_the_cursor() {
        let j = EventJournal::new();
        for _ in 0..6 {
            j.publish("turn_completed", "c1", "t", Value::Null);
        }
        // A caller already past the tail (e.g. cursor from a previous poll that
        // raced a prune) waits, gets nothing — and keeps ITS cursor.
        let (cursor, events) = j.wait(10, Duration::from_millis(5)).await;
        assert!(events.is_empty());
        assert_eq!(cursor, 10);
    }

    /// The tool-args wrapper: no cursor → immediate baseline, no events.
    #[tokio::test]
    async fn wait_from_args_without_cursor_returns_baseline() {
        let j = EventJournal::new();
        j.publish("turn_completed", "c1", "t", Value::Null);
        let out = j.wait_from_args(&json!({})).await;
        assert_eq!(out["cursor"], 1);
        assert_eq!(out["events"].as_array().unwrap().len(), 0);
    }
}
