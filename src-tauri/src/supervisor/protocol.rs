//! Wire types for the Claude Code stream-json protocol (CLI v2.1.178).
//!
//! Clean-room model of the messages the `claude` binary emits on stdout when
//! driven in persistent bidirectional `stream-json` mode. Derived from the spec
//! at `docs/claude-code-protocol.md` and validated against the checked-in ground
//! truth fixture (`fixtures/capture_text.jsonl`).
//!
//! Scope note (subtask 1 = transport): this module only needs to *classify and
//! deserialize* inbound lines without losing data. The top-level [`CliMessage`]
//! enum is modeled fully; payloads that belong to later layers are kept as
//! [`serde_json::Value`] on purpose:
//!   - the control-channel bodies (`control_request` / `control_response`) get
//!     typed in subtask 2 (control channel),
//!   - the assistant/user content blocks and stream-event deltas get assembled
//!     in subtask 3 (IPC / assembler).
//!
//! Every variant tolerates unknown fields (serde ignores them by default) and
//! every `#[serde(tag = ...)]` enum has an `Unknown` catch-all, so a future CLI
//! build never makes the reader drop a whole line.

use serde::Deserialize;
use serde_json::Value;

/// A single top-level JSON-lines message emitted by the `claude` binary on
/// stdout. Discriminated by the `"type"` field.
///
/// `tool_use` / `tool_result` are intentionally absent: per the protocol they
/// are *content blocks* inside an `assistant` / `user` message, never top-level
/// message types.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliMessage {
    /// Session lifecycle (`init`, `status`, …).
    System(SystemMsg),
    /// An assembled assistant message (carries usage / model / tool-input
    /// snapshots; the authoritative `stop_reason` & final usage come from the
    /// `stream_event{message_delta}` and `result` lines — see spec §3.6).
    Assistant(AssistantMsg),
    /// A user turn echo, or — more importantly — the delivery vehicle for a
    /// `tool_result` content block.
    User(UserMsg),
    /// End-of-turn summary (cost, usage, duration, denials).
    Result(ResultMsg),
    /// Incremental SSE delta (only emitted with `--include-partial-messages`).
    StreamEvent(StreamEventMsg),
    /// Rate-limit status snapshot.
    RateLimitEvent(RateLimitMsg),
    /// Control channel — typed in subtask 2; kept raw here.
    ControlRequest(Value),
    /// Control channel — typed in subtask 2; kept raw here.
    ControlResponse(Value),
    /// Abort an in-flight inbound control request we are answering.
    ControlCancelRequest {
        request_id: String,
    },
    /// Housekeeping heartbeat — consume, never reply.
    KeepAlive,
    /// Housekeeping transcript mirror — consume.
    TranscriptMirror(Value),
    /// Forward-compat catch-all for any `"type"` we do not model yet.
    #[serde(other)]
    Unknown,
}

impl CliMessage {
    /// Stable, lowercase discriminant string — handy for logging and tests.
    pub fn kind(&self) -> &'static str {
        match self {
            CliMessage::System(_) => "system",
            CliMessage::Assistant(_) => "assistant",
            CliMessage::User(_) => "user",
            CliMessage::Result(_) => "result",
            CliMessage::StreamEvent(_) => "stream_event",
            CliMessage::RateLimitEvent(_) => "rate_limit_event",
            CliMessage::ControlRequest(_) => "control_request",
            CliMessage::ControlResponse(_) => "control_response",
            CliMessage::ControlCancelRequest { .. } => "control_cancel_request",
            CliMessage::KeepAlive => "keep_alive",
            CliMessage::TranscriptMirror(_) => "transcript_mirror",
            CliMessage::Unknown => "unknown",
        }
    }

    /// `true` when the message fell through to the forward-compat catch-all,
    /// i.e. the CLI emitted a top-level `"type"` we do not model.
    pub fn is_unknown(&self) -> bool {
        matches!(self, CliMessage::Unknown)
    }
}

/// `system` messages, discriminated by `"subtype"`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemMsg {
    /// First message of a session: carries `session_id`, the available tools,
    /// the model, the permission mode, etc.
    Init(Box<InitMsg>),
    /// Transient activity status (`requesting`, …).
    Status {
        status: Option<String>,
        #[serde(rename = "permissionMode")]
        permission_mode: Option<String>,
        session_id: Option<String>,
    },
    /// A background task was created (a sub-agent `Agent` run, a `Workflow` run, a
    /// `Bash run_in_background`, or a `Monitor` watch). Carries the `task_type` and
    /// the correlating `tool_use_id` so the assembler can classify the producer.
    TaskStarted(TaskStartedMsg),
    /// Live progress for a running task (the only one a `Workflow` emits per agent:
    /// `description = "<phase>: <label>"`). Coarse on the wire by design — the rich
    /// detail (tokens, transcripts) is read from disk.
    TaskProgress(TaskProgressMsg),
    /// A task's state changed (`patch.status` = `completed` / `failed` / …). The
    /// terminal transition for `Bash`/`Monitor`/`Agent`; `end_time` is ignored.
    TaskUpdated(TaskUpdatedMsg),
    /// A task finished, with the summary and (for sub-agents) the usage roll-up and
    /// the `output_file` to read its full result from on disk.
    TaskNotification(TaskNotificationMsg),
    /// `system/bridge_state` — Remote Control ("bridge") health, emitted while a
    /// session is bridged to claude.ai/code. The core consumes it to DOWNGRADE an
    /// active bridge: `state:"disconnected"` (the remote surface went away) or
    /// `state:"error"` (with a `detail`). It never drives "connected" (that comes
    /// from the `remote_control` control response) — so it is intercepted here, not
    /// rendered as a normal message. Both fields are optional for forward-compat.
    BridgeState {
        state: Option<String>,
        detail: Option<String>,
    },
    /// Other system subtypes (`compact_boundary`, `thinking_tokens`, …) are tolerated
    /// here so they never drop to [`CliMessage::Unknown`].
    #[serde(other)]
    Unknown,
}

/// `system/task_started` — a background task was created. The four producers share
/// this shape; they are told apart by `task_type` plus the `tool_use` named by
/// `tool_use_id` (`local_agent`→Agent; `Workflow`→workflow run; `local_bash`+`Bash`
/// →background shell; `local_bash`+`Monitor`→watch). The large `prompt` field (when
/// present) is ignored — the full transcript lives on disk.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskStartedMsg {
    pub task_id: String,
    pub tool_use_id: Option<String>,
    pub description: Option<String>,
    /// Only sub-agent (`Agent`) tasks carry this (e.g. `"Explore"`).
    pub subagent_type: Option<String>,
    /// `"local_agent"` (sub-agent) or `"local_bash"` (Bash-bg AND Monitor); a
    /// `Workflow` run omits it. Combined with the tool name to classify the kind.
    pub task_type: Option<String>,
}

/// `system/task_progress` — a live progress tick. Emitted per workflow agent as
/// `description = "<phase>: <label>"`; rare for the other producers.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskProgressMsg {
    pub task_id: String,
    pub tool_use_id: Option<String>,
    pub description: Option<String>,
}

/// `system/task_updated` — a state patch. We read `patch.status`; `end_time` and any
/// other patched fields are tolerated and ignored.
///
/// `task_id` is REQUIRED on purpose: it is the stable correlation key tying every
/// `task_*` of a task together, and a line without it is unaddressable — so a missing
/// `task_id` deliberately fails this variant and the transport drops the line (logged).
#[derive(Debug, Clone, Deserialize)]
pub struct TaskUpdatedMsg {
    pub task_id: String,
    /// `Option` (not `#[serde(default)]`) so BOTH a missing `patch` AND an explicit
    /// `"patch":null` deserialize to `None` instead of failing the whole line.
    pub patch: Option<TaskPatch>,
}

/// The `patch` object of a `task_updated`. Only `status` is read; `end_time` (epoch ms)
/// is intentionally NOT captured — duration is sourced from the `task_notification`
/// usage roll-up, and per-producer duration for tasks whose notification omits usage is
/// a concern of the (future) fleet view, not this socle.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TaskPatch {
    pub status: Option<String>,
}

/// `system/task_notification` — a task finished. Carries the final `status`, a human
/// `summary`, the `output_file` to read the full result from, and (for sub-agents) a
/// `usage` roll-up.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskNotificationMsg {
    pub task_id: String,
    pub tool_use_id: Option<String>,
    pub status: Option<String>,
    pub output_file: Option<String>,
    pub summary: Option<String>,
    /// `Option` (not `#[serde(default)]`) so BOTH a missing `usage` AND an explicit
    /// `"usage":null` deserialize to `None` instead of failing the whole line.
    pub usage: Option<TaskUsage>,
}

/// The `usage` roll-up on a `task_notification` (present for sub-agents). All fields
/// are optional — a producer that does not track a metric simply omits it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TaskUsage {
    pub total_tokens: Option<u64>,
    pub tool_uses: Option<u64>,
    pub duration_ms: Option<u64>,
}

/// `system/init` — the session bootstrap message.
///
/// Only the fields the supervisor needs are typed; the CLI sends many more (agents,
/// skills, plugins, mcp_servers, slash_commands, memory_paths, …) which serde
/// ignores. The configured picture is read from on-disk config (see
/// [`crate::extensions`]); the live MCP status is queried on demand via the
/// `mcp_status` control request (NOT the init snapshot, which shows servers stuck
/// at `pending`). Field casing on the wire is mixed, hence the renames.
#[derive(Debug, Clone, Deserialize)]
pub struct InitMsg {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub claude_code_version: Option<String>,
    #[serde(rename = "apiKeySource")]
    pub api_key_source: Option<String>,
    pub uuid: Option<String>,
}

/// `assistant` message. The inner `message` (Anthropic message shape with its
/// `content[]` blocks) is kept raw; the assembler (subtask 3) parses it.
#[derive(Debug, Clone, Deserialize)]
pub struct AssistantMsg {
    pub message: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub request_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
}

/// `user` message (user turn echo, or `tool_result` delivery). Inner `message`
/// kept raw for the assembler.
#[derive(Debug, Clone, Deserialize)]
pub struct UserMsg {
    pub message: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub parent_tool_use_id: Option<String>,
    /// Injected/meta user lines (command output, system reminders, the queued-message
    /// "while you were working" wrapper) carry `isMeta:true` and are NOT real turns.
    /// ⚠️ DISK-ONLY: the live stdout wire never carries this name — see [`Self::is_synthetic`],
    /// which is the same flag under the name the CLI actually emits. Kept because the
    /// transcript shape is parsed with these same types.
    #[serde(rename = "isMeta")]
    pub is_meta: Option<bool>,
    /// The LIVE-wire counterpart of [`Self::is_meta`]: every `user` line the CLI injects
    /// ITSELF (skill bodies, the `[Image: original WxH…]` downscale note, stop-hook
    /// feedback, continuation nudges, plugin-injected prompts, the `/compact` summary)
    /// carries `isSynthetic:true` on stdout, and NEVER `isMeta`.
    ///
    /// VERIFIED against claude 2.1.217, both by live probe and by reading the binary: all
    /// three `case"user"` emitters yield
    /// `{type:"user", …, isSynthetic: o.isMeta || o.isVisibleInTranscriptOnly}`, the public
    /// zod schema for the `user` type declares `isSynthetic` and no `isMeta`, and the
    /// inverse converter maps `isMeta: t.isSynthetic`. It is a deliberate rename, not an
    /// omission — which is why the `is_meta` guard was dead code on the live path and every
    /// injected line leaked as a fake user bubble (LIVE-ONLY: a reload reads the on-disk
    /// `isMeta:true` twin and drops it, so the ghost vanished when you came back).
    ///
    /// ⚠️ It is a SUPERSET of the disk flag (`isMeta || isVisibleInTranscriptOnly`), so the
    /// reload guard in `history.rs::push_user` must honour BOTH source flags or the two
    /// surfaces drift again — see that function.
    #[serde(rename = "isSynthetic")]
    pub is_synthetic: Option<bool>,
    /// `true` on a user turn RE-EMITTED by `--replay-user-messages` (a live echo). The
    /// UI splices these into the right spot (they can arrive out-of-order vs the
    /// streaming reply); a transcript restore, by contrast, is already chronological and
    /// is appended. Absent (→ `None`) on transcript lines.
    #[serde(rename = "isReplay")]
    pub is_replay: Option<bool>,
    /// On the PERSISTED transcript, a user line injected as a tool_use's expansion (e.g.
    /// the `SKILL.md` body a `Skill` tool_use expands into) carries `sourceToolUseID` = the
    /// spawning tool_use's id. ⚠️ On the LIVE stdout wire the CLI OMITS this (AND `isMeta`)
    /// on that line — proven by `live_capture_skill_body_replay` (both came back `None`
    /// live, `isMeta:true` + `sourceToolUseID` only on disk). So it is NOT a live-safe
    /// distinguisher; live, that body is recognised by [`Self::is_synthetic`]. Kept for the
    /// disk shape and future wire changes.
    #[serde(rename = "sourceToolUseID")]
    pub source_tool_use_id: Option<String>,
}

/// `result` — emitted at the end of every turn (NOT end of session; the session
/// stays alive for the next user message while stdin remains open).
#[derive(Debug, Clone, Deserialize)]
pub struct ResultMsg {
    pub subtype: String,
    #[serde(default)]
    pub is_error: bool,
    /// Final assistant text, or structured output. String in the common case.
    pub result: Option<Value>,
    /// API-level error status on an errored turn (e.g. `"overloaded"`). Present on the
    /// wire (often `null`); kept raw so a non-string shape can't fail the whole line,
    /// and surfaced as a typed error heading by the assembler.
    #[serde(default)]
    pub api_error_status: Value,
    pub stop_reason: Option<String>,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
    pub num_turns: Option<u64>,
    pub duration_ms: Option<u64>,
    /// Wall-clock time spent in model/API calls this turn (cumulative — can exceed
    /// `duration_ms` when calls overlap). Surfaced as the "model time" breakdown.
    pub duration_api_ms: Option<u64>,
    /// Time-to-first-token this turn (ms). Captured for future use; not yet displayed.
    pub ttft_ms: Option<u64>,
    pub total_cost_usd: Option<f64>,
    /// Aggregate usage; shape varies per message kind, kept raw.
    #[serde(default)]
    pub usage: Value,
    /// Per-model usage map (`{"claude-opus-4-8[1m]": {inputTokens, contextWindow, …}}`).
    /// camelCase inner fields; kept raw and read by the assembler to surface the
    /// context-window size. Absent on some result subtypes → defaults to `null`.
    #[serde(default, rename = "modelUsage")]
    pub model_usage: Value,
}

/// `stream_event` — an incremental SSE delta wrapped with session metadata.
/// The inner `event` (message_start / content_block_* / message_*) is parsed by
/// the assembler in subtask 3.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamEventMsg {
    pub event: Value,
    pub session_id: Option<String>,
    pub parent_tool_use_id: Option<String>,
    pub uuid: Option<String>,
    /// Present only on the `message_start` event.
    pub ttft_ms: Option<u64>,
}

/// `rate_limit_event`. Inner info kept raw (camelCase fields on the wire).
#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitMsg {
    pub rate_limit_info: Value,
    pub session_id: Option<String>,
    pub uuid: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real text turn captured live from `claude` v2.1.178.
    const CAPTURE: &str = include_str!("fixtures/capture_text.jsonl");

    /// The spec's strongest de-risking lever (§7): every line of a real session
    /// must deserialize into a *known* variant — never erroring, never falling
    /// through to `Unknown`. Re-capture and re-run on every CLI upgrade.
    #[test]
    fn ground_truth_capture_round_trips_into_known_variants() {
        let mut msgs = Vec::new();
        for (i, line) in CAPTURE.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("line {i} failed to parse: {e}\n{line}"));
            assert!(!msg.is_unknown(), "line {i} fell through to Unknown:\n{line}");
            if let CliMessage::System(sys) = &msg {
                assert!(
                    !matches!(sys, SystemMsg::Unknown),
                    "line {i} system subtype fell through to Unknown:\n{line}"
                );
            }
            msgs.push(msg);
        }

        // Exact ordered sequence of a real text turn (see docs §3.x).
        let kinds: Vec<&str> = msgs.iter().map(CliMessage::kind).collect();
        assert_eq!(
            kinds,
            vec![
                "system",           // init
                "system",           // status
                "rate_limit_event", //
                "stream_event",     // message_start
                "stream_event",     // content_block_start
                "stream_event",     // content_block_delta
                "stream_event",     // content_block_delta
                "assistant",        // assembled (side-band snapshot)
                "stream_event",     // content_block_stop
                "stream_event",     // message_delta
                "stream_event",     // message_stop
                "result",           // success
            ],
            "captured message sequence drifted — re-capture against the current CLI"
        );
    }

    #[test]
    fn init_message_exposes_session_metadata() {
        let line = CAPTURE.lines().next().expect("fixture has lines");
        match serde_json::from_str::<CliMessage>(line).unwrap() {
            CliMessage::System(SystemMsg::Init(init)) => {
                assert!(init.session_id.is_some(), "init must carry a session_id");
                assert!(init.model.is_some(), "init must carry a model");
                assert!(!init.tools.is_empty(), "init must list available tools");
                assert!(init.permission_mode.is_some(), "init must carry permissionMode");
            }
            other => panic!("first line should be system/init, got {}", other.kind()),
        }
    }

    #[test]
    fn result_message_reports_success() {
        let line = CAPTURE.lines().last().expect("fixture has a last line");
        match serde_json::from_str::<CliMessage>(line).unwrap() {
            CliMessage::Result(r) => {
                assert_eq!(r.subtype, "success");
                assert!(!r.is_error);
                assert_eq!(r.stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(r.result.as_ref().and_then(Value::as_str), Some("hello world"));
            }
            other => panic!("last line should be result, got {}", other.kind()),
        }
    }

    /// Ground truth for the background-task lifecycle (captured on `claude` 2.1.186).
    /// Every line — the four producers' `task_*` events plus the spawning `assistant`
    /// tool_use blocks — must deserialize into a KNOWN variant, never `Unknown`, and
    /// all four `task_*` subtypes must be present. Re-capture on every CLI upgrade.
    const TASKS_CAPTURE: &str = include_str!("fixtures/capture_tasks.jsonl");

    #[test]
    fn task_lifecycle_capture_round_trips_into_known_variants() {
        let (mut started, mut progress, mut updated, mut notified) = (0, 0, 0, 0);
        for (i, line) in TASKS_CAPTURE.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("line {i} failed to parse: {e}\n{line}"));
            assert!(!msg.is_unknown(), "line {i} fell through to Unknown:\n{line}");
            if let CliMessage::System(sys) = &msg {
                assert!(
                    !matches!(sys, SystemMsg::Unknown),
                    "line {i} system subtype fell through to Unknown:\n{line}"
                );
                match sys {
                    SystemMsg::TaskStarted(_) => started += 1,
                    SystemMsg::TaskProgress(_) => progress += 1,
                    SystemMsg::TaskUpdated(_) => updated += 1,
                    SystemMsg::TaskNotification(_) => notified += 1,
                    _ => {}
                }
            }
        }
        // Four producers each emit started + updated + notification; only the
        // workflow emits a progress tick.
        assert_eq!(started, 4, "expected one task_started per producer");
        assert!(progress >= 1, "expected at least the workflow's task_progress");
        assert_eq!(updated, 4, "expected one task_updated per producer");
        assert_eq!(notified, 4, "expected one task_notification per producer");
    }

    #[test]
    fn task_started_exposes_classification_fields() {
        // The sub-agent line carries task_type + subagent_type; the Bash-bg line
        // carries task_type local_bash (told from Monitor by the tool name later).
        let agent: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"tu1","description":"d","subagent_type":"Explore","task_type":"local_agent"}"#,
        )
        .unwrap();
        match agent {
            CliMessage::System(SystemMsg::TaskStarted(t)) => {
                assert_eq!(t.task_id, "t1");
                assert_eq!(t.tool_use_id.as_deref(), Some("tu1"));
                assert_eq!(t.task_type.as_deref(), Some("local_agent"));
                assert_eq!(t.subagent_type.as_deref(), Some("Explore"));
            }
            other => panic!("expected task_started, got {}", other.kind()),
        }
    }

    #[test]
    fn task_notification_reads_usage_rollup() {
        let n: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"done","usage":{"total_tokens":42,"tool_uses":2,"duration_ms":100}}"#,
        )
        .unwrap();
        match n {
            CliMessage::System(SystemMsg::TaskNotification(t)) => {
                assert_eq!(t.status.as_deref(), Some("completed"));
                let usage = t.usage.expect("usage present");
                assert_eq!(usage.total_tokens, Some(42));
                assert_eq!(usage.tool_uses, Some(2));
                assert_eq!(usage.duration_ms, Some(100));
            }
            other => panic!("expected task_notification, got {}", other.kind()),
        }
    }

    /// An explicit `"patch":null` / `"usage":null` (not just a missing key) must NOT
    /// fail the whole line — it deserializes to `None` (finding #7).
    #[test]
    fn explicit_null_patch_and_usage_do_not_drop_the_line() {
        let updated: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_updated","task_id":"t1","patch":null}"#,
        )
        .unwrap();
        assert!(matches!(updated, CliMessage::System(SystemMsg::TaskUpdated(t)) if t.patch.is_none()));
        let notif: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","usage":null}"#,
        )
        .unwrap();
        assert!(matches!(notif, CliMessage::System(SystemMsg::TaskNotification(t)) if t.usage.is_none()));
    }

    #[test]
    fn unknown_type_is_tolerated_not_an_error() {
        let msg: CliMessage =
            serde_json::from_str(r#"{"type":"some_future_type","foo":1}"#).unwrap();
        assert!(msg.is_unknown());
    }

    #[test]
    fn control_messages_classify_without_typing_their_bodies() {
        let req: CliMessage = serde_json::from_str(
            r#"{"type":"control_request","request_id":"abc","request":{"subtype":"can_use_tool"}}"#,
        )
        .unwrap();
        assert_eq!(req.kind(), "control_request");

        let cancel: CliMessage =
            serde_json::from_str(r#"{"type":"control_cancel_request","request_id":"abc"}"#).unwrap();
        assert!(matches!(cancel, CliMessage::ControlCancelRequest { .. }));
    }
}
