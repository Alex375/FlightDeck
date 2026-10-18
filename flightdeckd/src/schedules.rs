//! Per-session record of the work claude scheduled to wake ITSELF later: a
//! session-only cron job (`CronCreate` — what `/loop` sets up) or a
//! `ScheduleWakeup`. Such a schedule lives only inside that claude process ("the
//! job is gone when Claude exits"): between two firings the conversation is idle
//! — no turn, no background task, nothing pending — so nothing else tells a
//! daemon restart (which stops every claude) that it would silently drop it.
//! The status rows report the count (`scheduled`), which the Mac's restart
//! guard counts as work.
//!
//! The record is read off the tool calls claude makes and their results
//! (verified against the 2.1.302 binary's wording):
//!  - `CronCreate` answers `Scheduled recurring job <id> (…)… Auto-expires after
//!    <N> days…` or `Scheduled one-shot task <id> (…)…`, saying `Session-only (not
//!    written to disk, dies when Claude exits)` or `Persisted to
//!    .claude/scheduled_tasks.json` — a persisted job survives a restart and is
//!    not counted;
//!  - `CronDelete {id}` answers `Cancelled job <id>`;
//!  - `ScheduleWakeup {delaySeconds}` arms ONE pending wakeup (the runtime clamps
//!    the delay to [60, 3600] s), `{stop: true}` ends it; a dynamic `/loop` re-arms
//!    it every turn.
//!
//! It errs toward COUNTING: a refused restart is explicit and can be done by hand
//! once the user knows, a dropped schedule is silent. A one-shot job's firing is
//! not visible on the stream, so it counts until it is deleted or claude exits;
//! a wakeup counts until its delay (plus a grace) has passed; a recurring job
//! until it expires. A result whose job id cannot be read still counts (under
//! its call's id).
//!
//! Pure (no I/O; the caller passes the clock) so it is tested line by line.

use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How many schedule tool calls awaiting their result are remembered.
const CALLS_MAX: usize = 256;
/// The runtime's clamp on a `ScheduleWakeup` delay (s).
const WAKEUP_DELAY_RANGE: (u64, u64) = (60, 3600);
/// After its delay, how long a wakeup still counts (the firing turn starting,
/// and re-arming a `/loop`'s next one).
const WAKEUP_GRACE: Duration = Duration::from_secs(120);

enum Call {
    Create,
    Delete(String),
    Wakeup { delay_s: Option<u64>, stop: bool },
}

#[derive(Default)]
pub struct ScheduleRegistry {
    /// Schedule tool calls awaiting their result, by `tool_use` id.
    calls: HashMap<String, Call>,
    /// The session-only cron jobs, by job id, with when each expires (`None` =
    /// not known: a one-shot, or a recurring job whose expiry could not be read).
    jobs: HashMap<String, Option<Instant>>,
    /// The pending `ScheduleWakeup`, counted until this instant.
    wakeup_until: Option<Instant>,
}

impl ScheduleRegistry {
    /// Remember the schedule tool calls of an `assistant` line (any thread: a
    /// sub-agent's cron is the session's too).
    pub fn note_assistant(&mut self, v: &Value) {
        let Some(blocks) = v["message"]["content"].as_array() else { return };
        for b in blocks.iter().filter(|b| b["type"].as_str() == Some("tool_use")) {
            let Some(id) = b["id"].as_str() else { continue };
            let input = &b["input"];
            let call = match b["name"].as_str() {
                Some("CronCreate") => Call::Create,
                Some("CronDelete") => match input["id"].as_str() {
                    Some(job) => Call::Delete(job.to_string()),
                    None => continue,
                },
                Some("ScheduleWakeup") => Call::Wakeup {
                    delay_s: input["delaySeconds"].as_f64().map(|s| s.max(0.0) as u64),
                    stop: input["stop"].as_bool() == Some(true),
                },
                _ => continue,
            };
            if self.calls.len() >= CALLS_MAX {
                self.calls.clear(); // results that never came: forget them, never grow
            }
            self.calls.insert(id.to_string(), call);
        }
    }

    /// Some schedule call awaits its result: a `user` line is worth reading.
    pub fn awaits_results(&self) -> bool {
        !self.calls.is_empty()
    }

    /// Fold in the results a `user` line carries for the calls remembered.
    pub fn note_user(&mut self, v: &Value, now: Instant) {
        let Some(blocks) = v["message"]["content"].as_array() else { return };
        for b in blocks.iter().filter(|b| b["type"].as_str() == Some("tool_result")) {
            let Some(call) = b["tool_use_id"].as_str().and_then(|id| self.calls.remove(id)) else { continue };
            if b["is_error"].as_bool() == Some(true) {
                continue; // nothing was scheduled, nor cancelled
            }
            let text = result_text(&b["content"]);
            match call {
                Call::Create => {
                    if text.contains("Persisted to") {
                        continue; // on disk: a restart does not lose it
                    }
                    let id = job_id_after(&text, &["Scheduled recurring job ", "Scheduled one-shot task "])
                        .unwrap_or_else(|| format!("call:{}", b["tool_use_id"].as_str().unwrap_or_default()));
                    let expires = text.contains("Scheduled recurring job ").then(|| expiry_days(&text)).flatten();
                    self.jobs.insert(id, expires.map(|d| now + d));
                }
                Call::Delete(job) => {
                    self.jobs.remove(&job);
                }
                Call::Wakeup { stop: true, .. } => self.wakeup_until = None,
                Call::Wakeup { delay_s, stop: false } => {
                    let delay = delay_s.unwrap_or(WAKEUP_DELAY_RANGE.1).clamp(WAKEUP_DELAY_RANGE.0, WAKEUP_DELAY_RANGE.1);
                    self.wakeup_until = Some(now + Duration::from_secs(delay) + WAKEUP_GRACE);
                }
            }
        }
    }

    /// How many schedules would wake this session later, as of `now`.
    pub fn scheduled(&self, now: Instant) -> usize {
        let jobs = self.jobs.values().filter(|exp| exp.is_none_or(|at| at > now)).count();
        jobs + usize::from(self.wakeup_until.is_some_and(|at| at > now))
    }
}

/// A `tool_result` content: a string, or text blocks.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The job id right after one of `prefixes` (up to a space or punctuation).
fn job_id_after(text: &str, prefixes: &[&str]) -> Option<String> {
    let rest = prefixes.iter().find_map(|p| text.split_once(p).map(|(_, r)| r))?;
    let id: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    (!id.is_empty()).then_some(id)
}

/// `Auto-expires after <N> days`.
fn expiry_days(text: &str) -> Option<Duration> {
    let (_, rest) = text.split_once("Auto-expires after ")?;
    let n: u64 = rest.split_whitespace().next()?.parse().ok()?;
    Some(Duration::from_secs(n * 24 * 3600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, name: &str, input: Value) -> Value {
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
    }

    fn result(id: &str, text: &str, is_error: bool) -> Value {
        json!({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": id, "content": [{"type": "text", "text": text}], "is_error": is_error}
        ]}})
    }

    #[test]
    fn a_session_cron_counts_as_scheduled_until_deleted() {
        let mut r = ScheduleRegistry::default();
        let t0 = Instant::now();
        r.note_assistant(&call("tu1", "CronCreate", json!({"cron": "*/15 * * * *", "prompt": "check the deploy"})));
        assert!(r.awaits_results());
        r.note_user(
            &result(
                "tu1",
                "Scheduled recurring job a1b2c3d4 (every 15 minutes). Session-only (not written to disk, dies when \
                 Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.",
                false,
            ),
            t0,
        );
        assert_eq!(r.scheduled(t0), 1);
        assert_eq!(r.scheduled(t0 + Duration::from_secs(8 * 24 * 3600)), 0, "expired");
        r.note_assistant(&call("tu2", "CronDelete", json!({"id": "a1b2c3d4"})));
        r.note_user(&result("tu2", "Cancelled job a1b2c3d4.", false), t0);
        assert_eq!(r.scheduled(t0), 0);
        assert!(!r.awaits_results());
    }

    #[test]
    fn a_persisted_job_a_refused_call_and_a_one_shot() {
        let mut r = ScheduleRegistry::default();
        let t0 = Instant::now();
        r.note_assistant(&call("p", "CronCreate", json!({"durable": true})));
        r.note_user(&result("p", "Scheduled recurring job pj (daily). Persisted to .claude/scheduled_tasks.json.", false), t0);
        r.note_assistant(&call("e", "CronCreate", json!({})));
        r.note_user(&result("e", "Invalid cron expression 'x'. Expected 5 fields: M H DoM Mon DoW.", true), t0);
        assert_eq!(r.scheduled(t0), 0, "a persisted job survives a restart; a refused one does not exist");
        r.note_assistant(&call("o", "CronCreate", json!({"recurring": false})));
        r.note_user(
            &json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "o",
                "content": "Scheduled one-shot task 9f8e (at 14:30). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete."}]}}),
            t0,
        );
        assert_eq!(r.scheduled(t0 + Duration::from_secs(400 * 24 * 3600)), 1, "a one-shot counts until deleted");
        // A delete that failed leaves it.
        r.note_assistant(&call("d", "CronDelete", json!({"id": "9f8e"})));
        r.note_user(&result("d", "Cannot delete cron job '9f8e': owned by another agent", true), t0);
        assert_eq!(r.scheduled(t0), 1);
    }

    #[test]
    fn a_wakeup_counts_until_its_delay_has_passed_and_stop_ends_it() {
        let mut r = ScheduleRegistry::default();
        let t0 = Instant::now();
        r.note_assistant(&call("w1", "ScheduleWakeup", json!({"delaySeconds": 1200, "reason": "poll", "prompt": "/loop"})));
        r.note_user(&result("w1", "Next wakeup scheduled for 15:20.", false), t0);
        assert_eq!(r.scheduled(t0 + Duration::from_secs(1200)), 1);
        assert_eq!(r.scheduled(t0 + Duration::from_secs(1200) + WAKEUP_GRACE), 0);
        // clamped to the runtime's range
        r.note_assistant(&call("w2", "ScheduleWakeup", json!({"delaySeconds": 5})));
        r.note_user(&result("w2", "ok", false), t0);
        assert_eq!(r.scheduled(t0 + Duration::from_secs(59)), 1);
        r.note_assistant(&call("w3", "ScheduleWakeup", json!({"stop": true})));
        r.note_user(&result("w3", "no further wakeups scheduled", false), t0);
        assert_eq!(r.scheduled(t0), 0);
    }

    #[test]
    fn an_unreadable_job_id_still_counts() {
        let mut r = ScheduleRegistry::default();
        let t0 = Instant::now();
        r.note_assistant(&call("x", "CronCreate", json!({})));
        r.note_user(&result("x", "Scheduled.", false), t0);
        assert_eq!(r.scheduled(t0), 1);
    }
}
