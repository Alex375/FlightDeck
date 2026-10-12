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
    /// `system/init` and `system/status` carry the session's permission mode.
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
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

/// What the RUNNING daemon supports, declared in every `fd_attach` (`caps`).
/// A client gates in-band behavior on these — never on the version of the
/// binary on disk, which differs from the running one after an upgrade that has
/// not restarted the daemon. Each name is a contract with the Mac:
///  - `busy-from-output`: `fd_attach.busy` (and `status`) also reflect turns
///    claude starts ON ITS OWN (a task-notification wake, a queued message, a
///    `/loop` or `/goal` continuation), read from claude's output — not only
///    turns a client or the phone started with a `user` line;
///  - `pending-dialogs`: EVERY inbound `control_request` still awaiting a host
///    answer (MCP `elicitation`, `request_user_dialog`, … — not only
///    `can_use_tool`) is listed in `fd_attach.pending` and re-sent after the
///    replay;
///  - `phone-cancel`: a request answered from the phone reaches the attached
///    client as a synthetic `control_cancel_request{request_id}` (never ringed,
///    `fd_resolved_by:"phone"`), so its card does not stay live and clickable;
///  - `stderr-tail`: `fd_detach{exited}` carries `stderr_tail` (the last
///    [`STDERR_TAIL_MAX`] lines claude wrote on stderr);
///  - `launch-enrich`: a sub-agent's `task_started` keyed on something other
///    than its launching `Agent` call (a `SendMessage` wake, possibly in a
///    later claude process) carries `fd_launch_tool_use_id`, read from the
///    sub-agent's sidecar on this server;
///  - `delivered-uuids`: `fd_attach.delivered` lists the `uuid` of the last
///    [`DELIVERED_UUIDS_MAX`] client `user` lines this claude process was handed
///    (oldest first). A message a client wrote on a link that died, missing from
///    it, never reached claude — whatever `busy` says (with `busy-from-output`,
///    a turn claude started on its own reads busy and hid such a loss).
pub const DAEMON_CAPS: &[&str] =
    &["busy-from-output", "pending-dialogs", "phone-cancel", "stderr-tail", "launch-enrich", "delivered-uuids"];

/// How many client `user` line uuids `fd_attach.delivered` carries.
pub const DELIVERED_UUIDS_MAX: usize = 64;

/// How many trailing stderr lines `fd_detach{exited}` carries (the Mac's own
/// `STDERR_TAIL_MAX` for a local session).
pub const STDERR_TAIL_MAX: usize = 80;

/// First line the daemon sends on a (re)attach: identifies the conversation,
/// the claude-process epoch, and where the replay starts. `busy` is the
/// daemon's OWN turn state (a client whose optimistic busy flag disagrees can
/// resync — a message lost in a dead link would otherwise leave it stuck);
/// `pending` lists the request ids of every inbound control request still
/// awaiting a host answer (a client drops stale cards not in this list).
/// `bypass_available` says whether THIS claude process can run
/// `bypassPermissions` at all (it was launched with the unlock flag, or
/// straight in bypass): the CLI refuses a runtime switch to bypass otherwise,
/// so a client offers that mode only when this is true — an older client
/// ignores the field. `skip: true` appears ONLY when the client asked for
/// replay compaction and this replay honors it (the frame is otherwise
/// unchanged). `version` (the running daemon's) and `caps` ([`DAEMON_CAPS`])
/// are additive since 0.4.0: an older daemon omits them, and so is `delivered`
/// (cap `delivered-uuids`).
#[allow(clippy::too_many_arguments)]
pub fn fd_attach(
    conversation: &str,
    epoch: &str,
    replay_from: u64,
    seq_now: u64,
    busy: bool,
    pending: &[&str],
    bypass_available: bool,
    delivered: &[&str],
    skip: bool,
) -> String {
    let mut v = json!({
        "type": "fd_attach",
        "conversation": conversation,
        "epoch": epoch,
        "replay_from": replay_from,
        "seq": seq_now,
        "busy": busy,
        "pending": pending,
        "delivered": delivered,
        "version": DAEMON_VERSION,
        "caps": DAEMON_CAPS,
        "bypass_available": bypass_available,
    });
    if skip {
        v["skip"] = json!(true);
    }
    v.to_string()
}

/// Replay compaction, sent only to a client that announced `supports_skip`:
/// the replayable lines with seq `from..=to` (inclusive) were left out of this
/// replay — partial-message `stream_event` deltas of messages whose complete
/// `assistant` lines ARE replayed. On receipt the client's cursor is `from - 1`
/// (anything else is a protocol error) and it sets it to `to`. Like every
/// `fd_*` frame it is never counted itself.
pub fn fd_skip(from: u64, to: u64) -> String {
    json!({"type": "fd_skip", "from": from, "to": to}).to_string()
}

/// The running daemon's version (Cargo package version). Reported in
/// `fd_status` so a client detects version skew over the socket protocol
/// itself — distinct from `flightdeckd --version`, which reports the binary on
/// disk (the two differ after an upgrade that has not restarted the daemon).
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Reply to a `status` request on the attach socket: the node label, the
/// running daemon's version and one row per registered conversation.
pub fn fd_status(label: &str, conversations: Vec<Value>) -> String {
    json!({
        "type": "fd_status",
        "version": DAEMON_VERSION,
        "label": label,
        "conversations": conversations,
    })
    .to_string()
}

/// Last line before the daemon closes an attach stream. `reason` ∈
/// "replaced" (a newer client took over — do NOT auto-reconnect),
/// "stopped" (explicit fd_stop — do not reconnect),
/// "exited" (the claude process ended — do not reconnect, session is over),
/// "stalled" (the daemon gave up on a write the client's link did not accept
/// for `ATTACH_WRITE_TIMEOUT` — the session is still alive: the client SHOULD
/// reconnect and resume from its cursor). "stalled" is best effort: on a fully
/// stalled link the frame usually cannot get through either, so a client must
/// treat a bare EOF the same way.
pub fn fd_detach(reason: &str, exit_code: Option<i32>) -> String {
    let mut v = json!({ "type": "fd_detach", "reason": reason });
    if let Some(c) = exit_code {
        v["exit_code"] = json!(c);
    }
    v.to_string()
}

/// `fd_detach{exited}` with the tail of claude's stderr (oldest first, at most
/// [`STDERR_TAIL_MAX`] lines; possibly empty). It is what explains a remote
/// claude that died — an expired login, a flag an older CLI rejects, a bad
/// working folder, a crash — which the exit code alone cannot. Additive: an
/// older daemon sends no `stderr_tail`.
pub fn fd_detach_exited(exit_code: Option<i32>, stderr_tail: &[String]) -> String {
    let mut v = json!({ "type": "fd_detach", "reason": "exited", "stderr_tail": stderr_tail });
    if let Some(c) = exit_code {
        v["exit_code"] = json!(c);
    }
    v.to_string()
}

/// A synthetic `control_cancel_request` the daemon pushes to the attached
/// client when a request it was shown got settled ELSEWHERE (the phone
/// answered it). The client already retires a prompt on claude's own cancel,
/// so it needs no new code path; `fd_resolved_by` says who settled it.
/// Control plane: never ringed, never counted.
pub fn control_cancel_request(request_id: &str, resolved_by: &str) -> String {
    json!({ "type": "control_cancel_request", "request_id": request_id, "fd_resolved_by": resolved_by }).to_string()
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

/// The `initialize` the daemon sends FIRST to a claude no client will
/// initialize (phone create, lazy respawn, a cold respawn for a client that
/// reattaches with an epoch — see `SessionManager::spawn_into`). Only the first
/// `initialize` a process receives sets session options — a later one (the Mac
/// attaching) takes the CLI's re-init branch, which returns before
/// `perTaskStopAffordance` is read — and a `user` line on an uninitialized
/// stream marks it initialized too. Without this, such a process would never
/// get the affordance, and the user's next Stop (Mac or phone) would also kill
/// every running background agent and workflow. Same body as the Mac's
/// `session_initialize_request`, minus what only an attached app can serve
/// (SDK MCP servers, prompt suggestions — the re-init branch still applies a
/// later client's prompt-suggestion opt-in and hooks, verified in 2.1.293).
pub fn initialize_request(request_id: &str) -> String {
    control_request(request_id, json!({ "subtype": "initialize", "perTaskStopAffordance": true }))
}

/// `stop_task` — stop ONE background task (same wire as the Mac's
/// `control::stop_task_request`: the subtype is `stop_task`, not `task_stop`).
pub fn stop_task_request(request_id: &str, task_id: &str) -> String {
    control_request(request_id, json!({ "subtype": "stop_task", "task_id": task_id }))
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
        let a = fd_attach("conv-1", "ep", 3, 10, true, &["rq-1"], false, &["u-1"], false);
        let v: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v["type"], "fd_attach");
        assert_eq!(v["replay_from"], 3);
        assert_eq!(v["seq"], 10);
        assert_eq!(v["busy"], true);
        assert_eq!(v["pending"][0], "rq-1");
        assert_eq!(v["bypass_available"], false);
        assert_eq!(v["delivered"], json!(["u-1"]));
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            v["caps"],
            json!(["busy-from-output", "pending-dialogs", "phone-cancel", "stderr-tail", "launch-enrich", "delivered-uuids"])
        );
        assert!(v.get("skip").is_none(), "a flagless client's fd_attach must not change");
        let a = fd_attach("conv-1", "ep", 3, 10, true, &[], true, &[], true);
        let v: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v["skip"], true);
        assert_eq!(v["bypass_available"], true);
        let k = fd_skip(4, 9);
        assert_eq!(serde_json::from_str::<Value>(&k).unwrap(), json!({"type": "fd_skip", "from": 4, "to": 9}));
        assert!(!is_replayable_line(&k), "fd_skip must never count toward the cursor");
        let d = fd_detach("stalled", None);
        let v: Value = serde_json::from_str(&d).unwrap();
        assert_eq!(v, json!({"type": "fd_detach", "reason": "stalled"}));
        assert!(!is_replayable_line(&d), "fd_detach must never count toward the cursor");
        let d = fd_detach("exited", Some(1));
        let v: Value = serde_json::from_str(&d).unwrap();
        assert_eq!(v["reason"], "exited");
        assert_eq!(v["exit_code"], 1);
        let d = fd_detach_exited(Some(2), &["Error: not logged in".to_string()]);
        let v: Value = serde_json::from_str(&d).unwrap();
        assert_eq!(v, json!({"type": "fd_detach", "reason": "exited", "exit_code": 2, "stderr_tail": ["Error: not logged in"]}));
        let v: Value = serde_json::from_str(&fd_detach_exited(None, &[])).unwrap();
        assert_eq!(v, json!({"type": "fd_detach", "reason": "exited", "stderr_tail": []}));
        let c = control_cancel_request("rq-9", "phone");
        assert_eq!(
            serde_json::from_str::<Value>(&c).unwrap(),
            json!({"type": "control_cancel_request", "request_id": "rq-9", "fd_resolved_by": "phone"})
        );
        assert!(!is_replayable_line(&c), "a synthetic cancel must never count toward the cursor");
    }

    #[test]
    fn daemon_control_requests_match_the_mac_wire() {
        let v: Value = serde_json::from_str(&initialize_request("fdd-1")).unwrap();
        assert_eq!(
            v,
            json!({"request_id": "fdd-1", "type": "control_request",
                   "request": {"subtype": "initialize", "perTaskStopAffordance": true}})
        );
        let v: Value = serde_json::from_str(&stop_task_request("fdd-2", "tk_1")).unwrap();
        assert_eq!(v["request"], json!({"subtype": "stop_task", "task_id": "tk_1"}));
    }

    #[test]
    fn fd_status_carries_daemon_version() {
        let s = fd_status("node", vec![json!({"conversation": "c1"})]);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "fd_status");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["label"], "node");
        assert_eq!(v["conversations"][0]["conversation"], "c1");
        assert!(!is_replayable_line(&s));
    }

    #[test]
    fn probe_reads_request_id() {
        let p = probe(r#"{"type":"control_request","request_id":"x","request":{"subtype":"can_use_tool"}}"#).unwrap();
        assert_eq!(p.kind.as_deref(), Some("control_request"));
        assert_eq!(p.request_id.as_deref(), Some("x"));
    }
}
