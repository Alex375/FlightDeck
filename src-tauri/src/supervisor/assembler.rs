//! Assembler — turns the raw [`CliMessage`] stream into normalized,
//! UI-facing [`SessionEvent`]s (spec §6.2 "assembler").
//!
//! Design choices for robustness:
//!   - Live typing comes from `stream_event` text/thinking deltas.
//!   - Authoritative content (tool_use blocks, final text) is read from the
//!     top-level `assistant` message, which carries the full `content[]`. We do
//!     NOT reconstruct tool inputs from `input_json_delta` fragments — reading
//!     the assembled block is simpler and less fragile (spec §3.6).
//!   - `stop_reason` / final usage come from the `result` line.
//!
//! The assembler owns the coarse [`SessionStatePayload`]; the session asks it to
//! reflect permission / mode changes so all state lives in one place.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::model::{
    BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, ConversationItem, NormalizedBlock,
    RateLimitSnapshot, RemoteControlState, SessionEvent, SessionStatePayload,
};
use super::protocol::{
    AssistantMsg, CliMessage, RateLimitMsg, ResultMsg, StreamEventMsg, SystemMsg,
    TaskNotificationMsg, TaskProgressMsg, TaskStartedMsg, TaskUpdatedMsg, UserMsg,
};

/// Stateful normalizer for one session.
#[derive(Debug, Default)]
pub struct Assembler {
    state: SessionStatePayload,
    /// Id of the assistant message currently streaming (for delta correlation).
    current_message_id: Option<String>,
    /// Last CONFIRMED (model-felt) control values we announced in the timeline, as
    /// friendly labels. Distinct from `state` (which updates optimistically on a
    /// click): a "control changed" notice fires ONLY when a confirmed source moves
    /// one of these — the `get_settings` read-back (effort + model), the
    /// `set_permission_mode` ack, or `system/init` (model + permission, per turn) —
    /// never on the optimistic click. So the line always reflects what the model
    /// actually got, and it also catches a change made from the chat (e.g. /model).
    announced: Announced,
    /// `tool_use.id` → the tool that spawned it (name + captured Bash command),
    /// recorded from each assistant `tool_use` block. The tool NAME is the ONLY way to
    /// tell a background `Bash` from a `Monitor` apart (both carry
    /// `task_type:"local_bash"`): we correlate a `task_*`'s `tool_use_id` back to the
    /// tool that spawned it. The `command` is captured for `Bash` so a background
    /// command can show its real `$ command` (the wire's `task_started` carries only a
    /// `description`, not the input). Populated before the matching `task_started` (the
    /// tool must be requested before it runs).
    tool_names: HashMap<String, ToolUse>,
    /// Live background tasks keyed by `task_id`, updated in place on every `task_*`
    /// transition (spec §6.2).
    background_tasks: HashMap<String, BackgroundTask>,
    /// Reverse index `tool_use_id → task_id`. Lets `record_tool` / `set_task_output_file`
    /// reconcile a tracked task from its spawning tool_use in O(1) instead of scanning
    /// `background_tasks` — most `Bash` tool_uses are foreground and spawn no task, so the
    /// scan was pure waste on every one. Kept in lock-step with each task's `tool_use_id`
    /// via [`Assembler::link_tool_use`].
    tasks_by_tool_use: HashMap<String, String>,
    /// Uuids of user turns WE wrote to stdin (see [`Assembler::note_sent_user_message`]).
    /// `--replay-user-messages` echoes every user turn back on stdout with its uuid;
    /// an echo whose uuid is in here is OUR own message (already shown optimistically)
    /// → suppressed. A remote (phone/web) turn carries a uuid we never sent → surfaced.
    /// Consumed on match (removed), so the set self-bounds to in-flight sends.
    sent_user_uuids: HashSet<String>,
    /// Armed when a model-invoked `Skill` tool_use is seen; consumed in `ingest_user`.
    /// A `Skill` tool_use expands into an INJECTED `user` line carrying the SKILL.md body
    /// (it opens with `Base directory for this skill:`). ON DISK that line is flagged
    /// `isMeta:true` and dropped by the `is_meta` guard (mirrored by `history.rs`). But on
    /// the LIVE stdout wire the CLI OMITS `isMeta` (and `sourceToolUseID`) on it — proven
    /// by a live capture (`live_capture_skill_body_replay`) — so the `is_meta` guard never
    /// fires live and the body leaked as a fake user bubble. This was LIVE-ONLY: a reload
    /// reads the on-disk `isMeta:true` line and drops it, which is why it looked "fixed but
    /// still happening". While armed we drop that body by its boilerplate prefix. Reset at
    /// end-of-turn (`ingest_result`) so it can never swallow a real user turn (those only
    /// arrive AFTER a `result`, never mid-turn).
    skill_invocation_pending: bool,
}

/// The last-announced friendly labels for the three controls (see [`Assembler`]).
#[derive(Debug, Default)]
struct Announced {
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
}

/// A background-capable `tool_use` the assembler is tracking by id (see
/// [`Assembler::tool_names`]).
#[derive(Debug, Default)]
struct ToolUse {
    /// Tool name (`Bash` / `Monitor` / `Agent` / `Workflow`) — classifies the task.
    name: String,
    /// The `command` of a `Bash` tool_use. Present only once the ASSEMBLED assistant
    /// message lands (the streamed `content_block_start` carries an empty input), so it
    /// can arrive AFTER the task is already tracked. `None` for non-Bash tools.
    command: Option<String>,
    /// ABSOLUTE path of the task's output file, parsed from the background tool_result
    /// ("…Output is being written to: <path>"). Captured here so it can seed a task
    /// whose `task_started` is yet to arrive (and vice-versa). `None` until that
    /// tool_result is seen.
    output_file: Option<String>,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read-only view of the current session state.
    pub fn state(&self) -> &SessionStatePayload {
        &self.state
    }

    /// Record the uuid of a user turn WE just wrote to `claude`'s stdin, so its
    /// `--replay-user-messages` echo (same uuid) is recognised as our own and NOT
    /// re-rendered (the UI already showed it optimistically). Called by the session
    /// actor right before it sends the message. See [`Assembler::ingest_user`].
    pub fn note_sent_user_message(&mut self, uuid: &str) {
        self.sent_user_uuids.insert(uuid.to_string());
    }

    /// Flip the "awaiting permission" flag and return the resulting state event.
    pub fn set_awaiting_permission(&mut self, awaiting: bool) -> SessionEvent {
        self.state.awaiting_permission = awaiting;
        SessionEvent::State(self.state.clone())
    }

    /// Mark a turn in flight on user send (before the CLI streams anything back),
    /// so the composer flips to "working" immediately.
    pub fn set_busy(&mut self, busy: bool) -> SessionEvent {
        self.state.busy = busy;
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a permission-mode change (after `set_permission_mode`).
    pub fn set_permission_mode(&mut self, mode: &str) -> SessionEvent {
        self.state.permission_mode = Some(mode.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a model change (after `set_model`).
    pub fn set_model(&mut self, model: &str) -> SessionEvent {
        self.state.model = Some(model.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// Seed the live state with the spawn controls, so the FIRST emitted state event
    /// already carries them (before the round-trips land). Also seeds the announced
    /// baseline, so the INITIAL state — and the first confirming `get_settings` /
    /// `system/init` — never produces a spurious "control changed" notice. Does NOT
    /// emit — the session emits its first state on a real event.
    pub fn seed_controls(
        &mut self,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: Option<String>,
        ultracode: bool,
    ) {
        self.announced.model = model.as_deref().map(model_label);
        self.announced.effort = effort_label(effort.as_deref(), ultracode);
        self.announced.permission = permission_mode.as_deref().map(permission_label);
        self.state.model = model;
        self.state.effort = effort;
        self.state.permission_mode = permission_mode;
        self.state.ultracode = ultracode;
    }

    /// Optimistically reflect an effort/ultracode change from a UI click: updates the
    /// display state immediately, but does NOT announce — the timeline line waits for
    /// the `get_settings` read-back ([`apply_settings`]), so it shows the CONFIRMED
    /// value, never the optimistic one.
    pub fn set_effort_optimistic(
        &mut self,
        effort: Option<String>,
        ultracode: bool,
    ) -> SessionEvent {
        if let Some(e) = effort {
            self.state.effort = Some(e);
        }
        self.state.ultracode = ultracode;
        SessionEvent::State(self.state.clone())
    }

    /// Apply a live `get_settings` read-back: the authoritative model / effort /
    /// ultracode the CLI reports. A field absent from the response (`None`) is left
    /// untouched. Returns the state event PLUS a "control changed" notice for each
    /// value that actually MOVED (the model-felt source of truth).
    pub fn apply_settings(
        &mut self,
        model: Option<String>,
        effort: Option<String>,
        ultracode: Option<bool>,
    ) -> Vec<SessionEvent> {
        if let Some(m) = &model {
            self.state.model = Some(m.clone());
        }
        if let Some(e) = &effort {
            self.state.effort = Some(e.clone());
        }
        if let Some(u) = ultracode {
            self.state.ultracode = u;
        }
        let mut out = vec![SessionEvent::State(self.state.clone())];
        if let Some(m) = &model {
            self.announce_model(m, &mut out);
        }
        if effort.is_some() || ultracode.is_some() {
            self.announce_effort(&mut out);
        }
        out
    }

    /// Apply the CONFIRMED permission mode from a `set_permission_mode` ack (it echoes
    /// the mode the CLI actually applied, which can differ from the requested one).
    /// Returns the state event plus a "control changed" notice if it moved.
    pub fn confirm_permission_mode(&mut self, mode: &str) -> Vec<SessionEvent> {
        self.state.permission_mode = Some(mode.to_string());
        let mut out = vec![SessionEvent::State(self.state.clone())];
        self.announce_permission(mode, &mut out);
        out
    }

    /// Emit a "Model: X → Y" notice if the confirmed model moved (compared by
    /// friendly label, so an alias vs the resolved id never false-positives and a
    /// per-turn re-report of the same model is silent). The first sighting only
    /// records the baseline.
    fn announce_model(&mut self, id: &str, out: &mut Vec<SessionEvent>) {
        let to = model_label(id);
        match self.announced.model.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Model", "diamond", &from, &to));
                self.announced.model = Some(to);
            }
            None => self.announced.model = Some(to),
        }
    }

    /// Emit a "Thinking effort: X → Y" notice if the confirmed effort/ultracode
    /// moved (the Ultra code tier folds in as its own label).
    fn announce_effort(&mut self, out: &mut Vec<SessionEvent>) {
        let Some(to) = effort_label(self.state.effort.as_deref(), self.state.ultracode) else {
            return;
        };
        match self.announced.effort.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Thinking effort", "bolt", &from, &to));
                self.announced.effort = Some(to);
            }
            None => self.announced.effort = Some(to),
        }
    }

    /// Emit a "Permission mode: X → Y" notice if the confirmed mode moved.
    fn announce_permission(&mut self, mode: &str, out: &mut Vec<SessionEvent>) {
        let to = permission_label(mode);
        match self.announced.permission.clone() {
            Some(from) if from == to => {}
            Some(from) => {
                out.push(change_notice("Permission mode", "shield", &from, &to));
                self.announced.permission = Some(to);
            }
            None => self.announced.permission = Some(to),
        }
    }

    /// Mark the session as ended and return the terminal state event.
    pub fn set_ended(&mut self) -> SessionEvent {
        self.state.busy = false;
        self.state.awaiting_permission = false;
        self.state.activity = None;
        self.state.ended = true;
        SessionEvent::State(self.state.clone())
    }

    /// Ingest one inbound message, returning the events to emit (possibly none).
    /// Control-channel messages are handled by the session, not here.
    pub fn ingest(&mut self, msg: &CliMessage) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        match msg {
            CliMessage::System(sys) => self.ingest_system(sys, &mut out),
            CliMessage::StreamEvent(se) => self.ingest_stream_event(se, &mut out),
            CliMessage::Assistant(a) => self.ingest_assistant(a, &mut out),
            CliMessage::User(u) => self.ingest_user(u, &mut out),
            CliMessage::Result(r) => self.ingest_result(r, &mut out),
            CliMessage::RateLimitEvent(rl) => self.ingest_rate_limit(rl, &mut out),
            // A top-level `"type"` we do not model — almost always CLI protocol drift
            // after a binary upgrade. Nothing to render (we don't know its shape), but
            // log it so the drift is diagnosable instead of vanishing without a trace.
            CliMessage::Unknown => {
                eprintln!(
                    "[assembler] dropping an unmodeled top-level message (CLI protocol drift after an upgrade?)"
                );
            }
            // control_* / keep_alive / transcript_mirror: nothing for the UI at this layer.
            _ => {}
        }
        out
    }

    fn ingest_system(&mut self, sys: &SystemMsg, out: &mut Vec<SessionEvent>) {
        match sys {
            SystemMsg::Init(init) => {
                self.state.session_id = init.session_id.clone();
                self.state.model = init.model.clone();
                self.state.permission_mode = init.permission_mode.clone();
                // `system/init` is re-emitted at the start of EACH turn, so when the
                // agent moves the session into/out of a worktree (EnterWorktree /
                // ExitWorktree), the next turn's init carries the new cwd — the UI's
                // worktree indicator follows along.
                self.state.cwd = init.cwd.clone();
                // Do NOT force busy here: `system/init` is emitted at the start of
                // each turn (not at spawn). Marking busy on init is fine for turns,
                // but busy is driven by user-send (set_busy) + message_start /
                // result so the composer is never wedged "busy" without a turn.
                out.push(SessionEvent::State(self.state.clone()));
                // `system/init` carries the authoritative model + permission each
                // turn: announce a change made from the chat (e.g. /model) too. Same
                // value → silent (announce_* dedupes).
                if let Some(m) = &init.model {
                    self.announce_model(m, out);
                }
                if let Some(pm) = &init.permission_mode {
                    self.announce_permission(pm, out);
                }
            }
            SystemMsg::Status {
                status,
                permission_mode,
                session_id,
            } => {
                if let Some(pm) = permission_mode {
                    self.state.permission_mode = Some(pm.clone());
                }
                if session_id.is_some() {
                    self.state.session_id = session_id.clone();
                }
                self.state.activity = status.clone();
                out.push(SessionEvent::State(self.state.clone()));
                if let Some(pm) = permission_mode {
                    self.announce_permission(pm, out);
                }
            }
            SystemMsg::TaskStarted(t) => self.ingest_task_started(t, out),
            SystemMsg::TaskProgress(t) => self.ingest_task_progress(t, out),
            SystemMsg::TaskUpdated(t) => self.ingest_task_updated(t, out),
            SystemMsg::TaskNotification(t) => self.ingest_task_notification(t, out),
            // Remote Control health: a bridged session's remote surface dropped
            // (`disconnected`) or the bridge errored (`error`, with a `detail`). This
            // only ever DOWNGRADES — "connected" comes from the `remote_control`
            // control response, never from here. Any other `state` is ignored
            // (forward-compat). Not persisted in `self.state`: the front's
            // remote-control store, seeded by the control-response ack, owns it.
            SystemMsg::BridgeState { state, detail } => {
                let status = match state.as_deref() {
                    Some("disconnected") => "disconnected",
                    Some("error") => "error",
                    _ => return,
                };
                out.push(SessionEvent::RemoteControl(RemoteControlState {
                    status: status.to_string(),
                    error: if status == "error" { detail.clone() } else { None },
                    ..RemoteControlState::default()
                }));
            }
            // Other subtypes are discarded by the protocol layer's catch-all; we
            // surface nothing for them yet.
            SystemMsg::Unknown => {}
        }
    }

    /// Maintain the `tool_use_id → task_id` reverse index (consumed by `record_tool` /
    /// `set_task_output_file` for an O(1) reconcile). No-op for an absent/empty id.
    fn link_tool_use(&mut self, tool_use_id: Option<&str>, task_id: &str) {
        if let Some(id) = tool_use_id {
            if !id.is_empty() {
                self.tasks_by_tool_use.insert(id.to_string(), task_id.to_string());
            }
        }
    }

    /// A background task was created: classify its producer (from `task_type` + the
    /// correlated tool name), seed a [`BackgroundTask`] keyed by `task_id`, and emit.
    fn ingest_task_started(&mut self, t: &TaskStartedMsg, out: &mut Vec<SessionEvent>) {
        self.link_tool_use(t.tool_use_id.as_deref(), &t.task_id);
        // Owned copies so the immutable `tool_names` read doesn't outlive the mutable
        // `background_tasks` borrow below.
        let tool = t.tool_use_id.as_deref().and_then(|id| self.tool_names.get(id));
        let tool_name = tool.map(|t| t.name.clone());
        let tool_command = tool.and_then(|t| t.command.clone());
        let tool_output_file = tool.and_then(|t| t.output_file.clone());
        let kind = classify_task(t.task_type.as_deref(), tool_name.as_deref());
        // The label is the NAME the agent gave the task (`description`, e.g. "build the
        // app") — the meaningful pinned line. The raw command lives in its own field; the
        // command and the output path arrive on their own schedule (assistant message /
        // tool_result) and `record_tool` / `set_task_output_file` backfill them later.
        let label = t.description.clone();
        // `task_started` normally arrives FIRST, so the common path inserts a fresh entry.
        // If a lazy entry already exists (the stream was joined mid-run and a
        // `task_updated`/`task_progress` was seen first), MERGE the authoritative identity
        // in rather than clobbering any status/progress already accumulated — and backfill
        // `tool_use_id` so a later tool name can still reach it via `record_tool`.
        let task = self
            .background_tasks
            .entry(t.task_id.clone())
            .or_insert_with(|| BackgroundTask {
                task_id: t.task_id.clone(),
                kind,
                tool_use_id: t.tool_use_id.clone(),
                label: label.clone(),
                command: tool_command.clone(),
                subagent_type: t.subagent_type.clone(),
                model: None,
                agent_id: None,
                status: BackgroundTaskStatus::Running,
                progress: None,
                tokens: None,
                tool_uses: None,
                duration_ms: None,
                summary: None,
                output_file: tool_output_file.clone(),
            });
        if task.tool_use_id.is_none() {
            task.tool_use_id = t.tool_use_id.clone();
        }
        if task.kind == BackgroundTaskKind::Other {
            task.kind = kind;
        }
        if task.label.is_none() {
            task.label = label;
        }
        if task.command.is_none() {
            task.command = tool_command;
        }
        if task.output_file.is_none() {
            task.output_file = tool_output_file;
        }
        if task.subagent_type.is_none() {
            task.subagent_type = t.subagent_type.clone();
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A live progress tick. Stash the latest `description` (a `Workflow` emits
    /// `"<phase>: <label>"`) and re-emit. Tolerates a tick for an unseen task.
    fn ingest_task_progress(&mut self, t: &TaskProgressMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, t.tool_use_id.as_deref());
        // A progress tick on a COMPLETED sub-agent means a resumed agent came back to life
        // (the wire never re-emits `task_started` on a `SendMessage` wake). This is the
        // backstop for a resume we didn't observe as a local `SendMessage` tool_use — e.g.
        // one issued from the phone via Remote Control; [`Self::resume_agent_via_send_message`]
        // handles the local case eagerly. Only a tool-using woken agent emits progress,
        // hence both signals. The helper resets stale roll-up (incl. `progress`), so set
        // THIS tick's description AFTER it, or the fresh label would be wiped.
        reactivate_completed_agent(task);
        if t.description.is_some() {
            task.progress = t.description.clone();
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A state patch (the terminal transition for Bash/Monitor/Agent). Map the patch
    /// status onto our coarse status and re-emit.
    fn ingest_task_updated(&mut self, t: &TaskUpdatedMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, None);
        if let Some(status) = t.patch.as_ref().and_then(|p| p.status.as_deref()) {
            task.status = map_status(status);
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A task finished: fold in the final status, summary, output file and usage
    /// roll-up, then re-emit the terminal state.
    fn ingest_task_notification(&mut self, t: &TaskNotificationMsg, out: &mut Vec<SessionEvent>) {
        let task = self.task_entry(&t.task_id, t.tool_use_id.as_deref());
        // A notification ALWAYS means the task finished. So never leave it Running: a
        // recognized status maps as usual; a present-but-UNRECOGNIZED terminal status
        // (a future CLI vocab like "timed_out") must NOT silently stay Running — fall
        // back to Completed and log it so the unknown vocab surfaces and gets captured.
        task.status = match t.status.as_deref() {
            Some(status) => match map_status(status) {
                BackgroundTaskStatus::Running => {
                    eprintln!(
                        "[assembler] task_notification with unrecognized terminal status {status:?}; treating as completed"
                    );
                    BackgroundTaskStatus::Completed
                }
                terminal => terminal,
            },
            None => BackgroundTaskStatus::Completed,
        };
        if t.summary.is_some() {
            task.summary = t.summary.clone();
        }
        // Fill output_file from the notification only if we don't ALREADY have one. For a
        // Bash/Monitor the start tool_result already captured the live-tailable TEMP path
        // (`set_task_output_file`) — the notification must not clobber it. An Agent had
        // none set earlier (no marker), so this is where its transcript path lands (and
        // the agent_id extraction below depends on it).
        if task.output_file.is_none() && t.output_file.is_some() {
            task.output_file = t.output_file.clone();
        }
        if let Some(usage) = &t.usage {
            if usage.total_tokens.is_some() {
                task.tokens = usage.total_tokens;
            }
            if usage.tool_uses.is_some() {
                task.tool_uses = usage.tool_uses;
            }
            if usage.duration_ms.is_some() {
                task.duration_ms = usage.duration_ms;
            }
        }
        // For a sub-agent, the only place the agent id appears on the wire is inside
        // `output_file` (`subagents/agent-<agentId>.jsonl`). A path matching that shape
        // unambiguously identifies a sub-agent, so surface the id (for a drill-down to
        // call `load_subagent_transcript` without re-parsing) AND, if the task was only
        // joined mid-run and never classified, upgrade Other → Agent off that same signal.
        if task.agent_id.is_none() {
            if let Some(id) = task
                .output_file
                .as_deref()
                .and_then(agent_id_from_output_file)
            {
                task.agent_id = Some(id);
                if task.kind == BackgroundTaskKind::Other {
                    task.kind = BackgroundTaskKind::Agent;
                }
            }
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A `SendMessage` tool_use whose `to` names an existing COMPLETED background sub-agent
    /// RESUMES it. For a sub-agent the wire's `to` IS the agentId, which IS the task_id — so
    /// a direct `background_tasks` lookup is exact. The resume re-activates the agent under
    /// the SAME task_id and NEVER re-emits `task_started`, so we flip it back to Running via
    /// [`reactivate_completed_agent`] (which keeps the ORIGINAL `Agent` `tool_use_id` — still
    /// in the front's `bgAgentIds` — and resets the prior run's roll-up). A `to` that is a
    /// live-teammate NAME or the literal `"main"` (neither an agentId) simply won't match any
    /// task_id and is a safe no-op; likewise a `to` that matches a task of another kind, or a
    /// task that is Stopped/Failed rather than a natural finish, is left untouched by the
    /// helper's scoping. Idempotent: an already-Running task is not re-emitted.
    fn resume_agent_via_send_message(&mut self, input: &Value, out: &mut Vec<SessionEvent>) {
        let Some(target) = input.get("to").and_then(Value::as_str) else {
            return;
        };
        if let Some(task) = self.background_tasks.get_mut(target) {
            if reactivate_completed_agent(task) {
                out.push(SessionEvent::Task(task.clone()));
            }
        }
    }

    /// Get (or lazily create) the tracked task for `task_id`. A `task_updated` /
    /// `task_notification` for a task whose `task_started` we missed (e.g. the stream
    /// was joined mid-run) still yields a usable entry, classified from whatever the
    /// late event carries.
    fn task_entry(&mut self, task_id: &str, tool_use_id: Option<&str>) -> &mut BackgroundTask {
        self.link_tool_use(tool_use_id, task_id);
        let tool_name = tool_use_id
            .and_then(|id| self.tool_names.get(id))
            .map(|t| t.name.clone());
        self.background_tasks
            .entry(task_id.to_string())
            .or_insert_with(|| BackgroundTask {
                task_id: task_id.to_string(),
                kind: classify_task(None, tool_name.as_deref()),
                tool_use_id: tool_use_id.map(str::to_string),
                label: None,
                command: None,
                subagent_type: None,
                model: None,
                agent_id: None,
                status: BackgroundTaskStatus::Running,
                progress: None,
                tokens: None,
                tool_uses: None,
                duration_ms: None,
                summary: None,
                output_file: None,
            })
    }

    fn ingest_stream_event(&mut self, se: &StreamEventMsg, out: &mut Vec<SessionEvent>) {
        let event = &se.event;
        match event.get("type").and_then(Value::as_str).unwrap_or_default() {
            "message_start" => {
                let id = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.current_message_id = (!id.is_empty()).then(|| id.clone());
                let mut state_changed = false;
                if !self.state.busy {
                    self.state.busy = true;
                    state_changed = true;
                }
                // Live context fill: a ROOT model call's input usage = the prompt size
                // sent to the model = current context occupancy. Sub-agent (Task) calls
                // have `parent_tool_use_id` set and their own window — never let them
                // clobber the conversation's context meter.
                if se.parent_tool_use_id.is_none() {
                    if let Some(used) = event
                        .get("message")
                        .and_then(|m| m.get("usage"))
                        .and_then(context_used_from_usage)
                    {
                        if self.state.context_tokens != Some(used) {
                            self.state.context_tokens = Some(used);
                            state_changed = true;
                        }
                    }
                }
                if state_changed {
                    out.push(SessionEvent::State(self.state.clone()));
                }
                out.push(SessionEvent::Item(ConversationItem::MessageStarted {
                    id,
                    role: "assistant".to_string(),
                    parent_tool_use_id: se.parent_tool_use_id.clone(),
                }));
            }
            "content_block_delta" => {
                if let Some(delta) = event.get("delta") {
                    match delta.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                out.push(SessionEvent::Item(ConversationItem::TextDelta {
                                    message_id: self.current_message_id.clone(),
                                    text: text.to_string(),
                                }));
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                                out.push(SessionEvent::Item(ConversationItem::ThinkingDelta {
                                    message_id: self.current_message_id.clone(),
                                    text: text.to_string(),
                                }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_start" => {
                // A tool_use block is announced here (id + name) BEFORE the assembled
                // assistant message and well before the tool runs / emits `task_started`.
                // Recording the name now guarantees a background task is classified
                // correctly the moment it starts (Bash vs Monitor hinges on this name).
                if let Some(cb) = event.get("content_block") {
                    if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                        let id = cb.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = cb.get("name").and_then(Value::as_str).unwrap_or_default();
                        // Arm the skill-body belt-and-braces HERE, not only from the
                        // assembled assistant message: that message lands at END of turn, and
                        // on a concurrent tool branch the injected body can arrive BEFORE it
                        // (4 such orderings exist in real transcripts) — the prefix guard
                        // would then be disarmed when the body shows up. Armed from the
                        // stream, it is set the moment the tool_use is announced.
                        //
                        // ⚠️ Set before `record_tool`, which returns early for any tool that
                        // is not background-capable ("Skill" is not, and must NOT be added to
                        // `is_bg_capable_tool` — that would reclassify it as a background task).
                        if name == "Skill" {
                            self.skill_invocation_pending = true;
                        }
                        // Input is empty at content_block_start (it streams later); the
                        // command is captured from the assembled assistant message.
                        self.record_tool(id, name, cb.get("input"), out);
                    }
                }
            }
            // content_block_stop, message_delta, message_stop carry no incremental
            // text we surface yet.
            _ => {}
        }
    }

    /// Record a background-capable tool_use's `id → (name, command)` for later `task_*`
    /// correlation, and — belt-and-suspenders — reconcile an ALREADY-tracked task that
    /// turns out to belong to it: re-classify it (covers the rare wire ordering where a
    /// `task_started` beat the tool name) and backfill a `Bash`'s raw command (which
    /// lands only with the ASSEMBLED assistant message, often AFTER the task is already
    /// tracked) so the output popover can show it. Only background-CAPABLE tools are
    /// kept, which keeps the map small — though note `Bash` qualifies even when run in
    /// the foreground, so it is NOT strictly bounded to calls that actually spawn a task.
    fn record_tool(&mut self, id: &str, name: &str, input: Option<&Value>, out: &mut Vec<SessionEvent>) {
        if id.is_empty() || !is_bg_capable_tool(name) {
            return;
        }
        // The Bash command is present only in the ASSEMBLED assistant message's input —
        // the streamed `content_block_start` carries an empty input — so it lands on the
        // SECOND call for this id.
        let command = (name == "Bash")
            .then(|| input.and_then(|i| i.get("command")).and_then(Value::as_str))
            .flatten()
            .map(str::to_string);

        // Called (at least) twice for the same tool_use: streamed `content_block_start`
        // (name only), then the assembled assistant message (name + full input). No-op
        // when nothing new arrived — the name is already recorded and no command appeared.
        let known = self.tool_names.get(id);
        let name_known = known.map(|t| t.name.as_str()) == Some(name);
        let command_new = command.is_some() && known.and_then(|t| t.command.as_deref()) != command.as_deref();
        if name_known && !command_new {
            return;
        }
        let entry = self.tool_names.entry(id.to_string()).or_default();
        entry.name = name.to_string();
        if command.is_some() {
            entry.command = command.clone();
        }

        // Reconcile an already-tracked task spawned by this tool_use:
        //  - re-classify if the (now-known) name changes its kind (ambiguous
        //    `local_bash` → Bash fallback, or `Other`) — the name is authoritative;
        //  - backfill a `Bash`'s raw command (a SEPARATE field from the `label` name) so
        //    the output popover can show `$ command` alongside the name.
        let task_id = self.tasks_by_tool_use.get(id).cloned();
        if let Some(task) = task_id.as_deref().and_then(|tid| self.background_tasks.get_mut(tid)) {
            let mut changed = false;
            let corrected = classify_task(None, Some(name));
            if corrected != task.kind {
                task.kind = corrected;
                changed = true;
            }
            if let Some(cmd) = &command {
                if task.command.as_deref() != Some(cmd.as_str()) {
                    task.command = Some(cmd.clone());
                    changed = true;
                }
            }
            if changed {
                out.push(SessionEvent::Task(task.clone()));
            }
        }
    }

    /// Capture a background task's ABSOLUTE output path, parsed from its Bash/Monitor
    /// tool_result ("…Output is being written to: <path>"). Stash it by `tool_use_id`
    /// (so a not-yet-started task picks it up in [`Self::ingest_task_started`]) AND, if
    /// the task is already tracked, set it and re-emit. This is the ONLY wire source of
    /// the path early enough to live-tail the output (the CLI writes it to a temp dir,
    /// so the path can't be reconstructed; `task_notification.output_file` only confirms
    /// it at the very end).
    fn set_task_output_file(&mut self, tool_use_id: &str, path: String, out: &mut Vec<SessionEvent>) {
        if tool_use_id.is_empty() {
            return;
        }
        self.tool_names.entry(tool_use_id.to_string()).or_default().output_file = Some(path.clone());
        let task_id = self.tasks_by_tool_use.get(tool_use_id).cloned();
        if let Some(task) = task_id.as_deref().and_then(|tid| self.background_tasks.get_mut(tid)) {
            if task.output_file.as_deref() != Some(path.as_str()) {
                task.output_file = Some(path);
                out.push(SessionEvent::Task(task.clone()));
            }
        }
    }

    fn ingest_assistant(&mut self, a: &AssistantMsg, out: &mut Vec<SessionEvent>) {
        let id = a
            .message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let blocks = normalize_blocks(a.message.get("content"));
        // Remember each background-capable tool_use's name so a later `task_*` (which
        // only carries the tool_use_id) can be classified — e.g. Bash vs Monitor. The
        // assembled `assistant` message is the AUTHORITATIVE source; the streamed
        // `content_block_start` (handled in ingest_stream_event) records it EARLIER, so
        // the name is known before `task_started` even though this message arrives at
        // end-of-turn.
        for b in &blocks {
            if let NormalizedBlock::ToolUse { id, name, input } = b {
                self.record_tool(id, name, Some(input), out);
                // A `SendMessage` that targets an existing background agent RESUMES it:
                // flip that agent's task back to Running eagerly (before any progress tick).
                if name == "SendMessage" {
                    self.resume_agent_via_send_message(input, out);
                }
                // A model-invoked skill: the CLI will inject the SKILL.md body as a bare
                // `user` text line that — LIVE — lacks the `isMeta` flag we'd normally drop
                // it by. Arm the drop; it's consumed in `ingest_user`. See the field doc.
                if name == "Skill" {
                    self.skill_invocation_pending = true;
                }
            }
        }
        out.push(SessionEvent::Item(ConversationItem::AssistantMessage {
            id,
            blocks,
            parent_tool_use_id: a.parent_tool_use_id.clone(),
            // Claude has no Codex turn id — it targets rewind/fork by prompt text.
            turn_id: None,
        }));
        // A sub-agent's assistant message carries the model it ran on — the wire's only
        // place a sub-agent's model appears (absent from every `task_*` event). Correlate
        // by `parent_tool_use_id` → the spawning `Agent` tool_use → its BackgroundTask,
        // stash the model, and re-emit the task on first capture / change so the UI can
        // show it on the sub-agent card. Cheap: only sub-agent messages (parent set) hit
        // this, and only a real change re-emits.
        if let Some(parent) = a.parent_tool_use_id.as_deref() {
            if let Some(model) = a.message.get("model").and_then(Value::as_str) {
                match self
                    .background_tasks
                    .values_mut()
                    .find(|t| t.tool_use_id.as_deref() == Some(parent))
                {
                    Some(task) => {
                        if task.model.as_deref() != Some(model) {
                            task.model = Some(model.to_string());
                            out.push(SessionEvent::Task(task.clone()));
                        }
                    }
                    // The sub-agent's model is data that exists ONLY here on the wire, so a
                    // failed correlation (e.g. its `assistant` arrived before `task_started`
                    // seeded the task) silently loses it. That must never be silent — log it
                    // (same policy as the rest of this module). Rare: `task_started` normally
                    // precedes any sub-agent output.
                    None => eprintln!(
                        "[assembler] sub-agent model {model:?} not correlated: no background task with tool_use_id {parent:?}"
                    ),
                }
            }
        }
    }

    fn ingest_user(&mut self, u: &UserMsg, out: &mut Vec<SessionEvent>) {
        // Is this a line the CLI injected ITSELF rather than a turn a human typed?
        //
        // LIVE the flag is `isSynthetic`; on the transcript shape the same lines carry
        // `isMeta` (the CLI renames it on the way out — see `UserMsg::is_synthetic`).
        // Honour BOTH so this guard can't go dead the way the `isMeta`-only one did.
        //
        // ⚠️ Deliberately NOT an early return: an injected line can also carry
        // `tool_result` blocks, and those must still be surfaced (a returning-early guard
        // would silently swallow a tool's output). It gates the BUBBLE only, below.
        let injected = u.is_synthetic == Some(true) || u.is_meta == Some(true);
        // A `user` message carries two things we surface: `tool_result` blocks (always),
        // AND — when the session is bridged (Remote Control) — a turn typed on the
        // phone/web, which the binary injects into the stream as an ordinary text user
        // message. Our OWN messages are shown optimistically and are NOT echoed here (no
        // `--replay-user-messages`), so a text user message on the live stream is
        // remote-originated: surface it (keyed by uuid → the UI dedupes a re-delivery)
        // or it would only appear on reload. Mirrors history.rs `push_user`.
        let mut text = String::new();
        let mut has_image = false;
        match u.message.get("content") {
            Some(Value::String(s)) => text.push_str(s),
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        // Counted, not rendered: the normalized block model carries no image
                        // yet (restoring thumbnails is a separate follow-up). What matters
                        // here is that an image-only turn is not INVISIBLE — see the
                        // placeholder below, which mirrors `history.rs::push_user`.
                        Some("image") => has_image = true,
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    text.push('\n');
                                }
                                text.push_str(t);
                            }
                        }
                        Some("tool_result") => {
                            let tool_use_id = b
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let content = b.get("content").cloned().unwrap_or(Value::Null);
                            // A background `Bash`/`Monitor` tool_result announces where its
                            // output is being written ("…Output is being written to: <path>").
                            // Capture that absolute path NOW so the output popover can read
                            // (and live-tail) it — the CLI writes to a temp dir the app can't
                            // reconstruct.
                            if let Some(path) = output_file_from_tool_result(&content) {
                                self.set_task_output_file(&tool_use_id, path, out);
                            }
                            out.push(SessionEvent::Item(ConversationItem::ToolResult {
                                tool_use_id,
                                content,
                                is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                                parent_tool_use_id: u.parent_tool_use_id.clone(),
                            }));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        // Belt-and-braces for the INJECTED SKILL.md body of a model-invoked skill: its
        // boilerplate prefix, while a `Skill` invocation is in flight this turn. The
        // `injected` flag above already covers it on a current binary — this stays so the
        // body can't come back as a bubble if a future binary drops `isSynthetic` too.
        // Gated on BOTH (armed flag AND prefix) so a real user turn is never swallowed —
        // the visible trace is the `Skill` tool_use (SkillChip).
        //
        // ⚠️ It only catches PREFIXED bodies. A skill with no filesystem root injects its
        // SKILL.md raw (the CLI only prepends the header when it has a root), and a
        // re-invocation injects a one-line notice instead — 35 such bodies exist in real
        // transcripts. Those are caught by `injected`, never by this prefix.
        let skill_body =
            self.skill_invocation_pending && text.trim_start().starts_with(SKILL_BODY_PREFIX);
        {
            let uuid = u.uuid.clone().unwrap_or_default();
            // Consume the echo bookkeeping FIRST, regardless of content: a turn WE sent
            // (`--replay-user-messages` returns it with the uuid we stamped) is recognised
            // and dropped from `sent_user_uuids` here. Doing this outside the text guard
            // matters for an images-only turn (empty text + image blocks): its uuid would
            // otherwise linger in the set forever (a slow leak on a long-lived session).
            let was_ours = !uuid.is_empty() && self.sent_user_uuids.remove(&uuid);
            // Only surface a bubble for a genuine remote turn WITH text — the UI already
            // shows our own turns optimistically, and image-only content isn't rendered on
            // the live/replay path (an accepted limit).
            //
            // ⚠️ A `user` line carrying `parent_tool_use_id` is a SUB-AGENT (sidechain) turn:
            // the prompt Claude sends INTO a `Task`/`Agent` tool, streamed live under the
            // spawning tool_use's id. It is NOT a human turn and must never render as a
            // main-conversation user bubble (the "messages Claude sends to sub-agents appear
            // as if I sent them" bug). VERIFIED on the live wire (claude 2.1.203): a sub-agent
            // prompt arrives with a FRESH uuid (so `was_ours` is false), `parent_tool_use_id`
            // = the Task tool_use, `isReplay` absent, and `isSidechain`/`isMeta` OMITTED (disk-
            // only, like `sourceToolUseID` — the skill-body lesson). `parent_tool_use_id` is a
            // top-level field that SURVIVES the live stream, so it is the live-safe
            // distinguisher — mirroring `history.rs` skipping `isSidechain:true` on disk and
            // the context-meter guard in `ingest_stream_event`. The `tool_result` blocks above
            // are still surfaced (a sub-agent's internal results carry the same parent and are
            // routed to its own card downstream).
            // Strip the IDE's "user opened a file" banner glued in front of a real prompt,
            // before the emptiness test — same call as `push_user_text` on reload.
            let mut text = super::history::strip_ide_banner(&text).to_string();
            // An image-only turn from the bridge (a photo sent from the phone with no
            // caption) has empty text and would fail the emptiness test below — it used to
            // be INVISIBLE live and then appear out of nowhere on reload, which reads as the
            // app inventing a message. Use the same "[image]" placeholder the reload path
            // uses so both surfaces show the same thing. Our OWN image turns never get here
            // (`was_ours`); the UI already shows their thumbnails optimistically.
            if text.trim().is_empty() && has_image && !was_ours {
                text = "[image]".to_string();
            }
            if !was_ours
                && !injected
                && !skill_body
                && !text.trim().is_empty()
                && u.parent_tool_use_id.is_none()
            {
                // Injected shapes the wire does NOT flag (`/goal` plumbing, `[Request
                // interrupted by user]`, another local command's stdout) are classified by
                // text — the same body `push_user_text` runs on reload, so a given line
                // renders identically on both surfaces.
                match super::history::classify_injected_text(&text) {
                    Some(super::history::InjectedText::Drop) => {}
                    Some(super::history::InjectedText::Notice { subtype, message }) => {
                        out.push(SessionEvent::Item(ConversationItem::Notice {
                            subtype: subtype.to_string(),
                            detail: serde_json::json!({ "message": message }),
                        }));
                    }
                    None => {
                        out.push(SessionEvent::Item(ConversationItem::UserMessage {
                            id: uuid,
                            text,
                            parent_tool_use_id: u.parent_tool_use_id.clone(),
                            // A live wire turn is an out-of-order replay to splice into place;
                            // a real remote turn always carries `isReplay:true` here.
                            replay: u.is_replay == Some(true),
                        }));
                    }
                }
            }
        }
    }

    fn ingest_result(&mut self, r: &ResultMsg, out: &mut Vec<SessionEvent>) {
        self.state.busy = false;
        self.state.activity = None;
        self.state.awaiting_permission = false;
        self.current_message_id = None;
        // Disarm the skill-body drop at end-of-turn: a real user turn can only arrive after
        // this `result`, so the guard must never straddle into the next turn.
        self.skill_invocation_pending = false;
        // Authoritative end-of-turn context fill + window size. A multi-call turn's
        // top-level `usage` can aggregate its `iterations[]`, so prefer the LAST
        // iteration — the final model call's prompt = current context occupancy.
        let final_usage = r
            .usage
            .get("iterations")
            .and_then(Value::as_array)
            .and_then(|it| it.last())
            .unwrap_or(&r.usage);
        if let Some(used) = context_used_from_usage(final_usage) {
            self.state.context_tokens = Some(used);
        }
        // Authoritative window for THIS session's model (distinguishes 200k vs 1M).
        // Only updates when the result reports the session model's own entry — a
        // sub-agent-only turn returns None and keeps the last known window.
        if let Some(window) =
            context_window_from_model_usage(&r.model_usage, self.state.model.as_deref())
        {
            self.state.context_window = Some(window);
        }
        out.push(SessionEvent::Item(ConversationItem::TurnResult {
            subtype: r.subtype.clone(),
            is_error: r.is_error,
            result: r.result.clone(),
            // Present on the wire (often null); surface it only when it's a real string
            // so an errored turn can show a typed "API error: <status>" heading.
            api_error_status: r.api_error_status.as_str().map(str::to_string),
            total_cost_usd: r.total_cost_usd,
            num_turns: r.num_turns,
            duration_ms: r.duration_ms,
            duration_api_ms: r.duration_api_ms,
            ttft_ms: r.ttft_ms,
        }));
        out.push(SessionEvent::State(self.state.clone()));
    }

    /// Normalize a `rate_limit_event` into the session's [`RateLimitSnapshot`]. The
    /// inner `rate_limit_info` has camelCase keys; we read them by hand off the raw
    /// Value (protocol.rs keeps it untyped). Emits a state event only on change so a
    /// per-turn re-emit of the same snapshot does not churn the UI.
    fn ingest_rate_limit(&mut self, rl: &RateLimitMsg, out: &mut Vec<SessionEvent>) {
        let info = &rl.rate_limit_info;
        let snapshot = RateLimitSnapshot {
            status: info.get("status").and_then(Value::as_str).map(str::to_string),
            resets_at: info.get("resetsAt").and_then(Value::as_i64),
            limit_type: info
                .get("rateLimitType")
                .and_then(Value::as_str)
                .map(str::to_string),
            using_overage: info
                .get("isUsingOverage")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        if self.state.rate_limit.as_ref() != Some(&snapshot) {
            self.state.rate_limit = Some(snapshot);
            out.push(SessionEvent::State(self.state.clone()));
        }
    }
}

/// Build a "control changed" timeline notice (`{control}: {from} → {to}`) — the
/// model-felt signal that a control actually moved. The front renders it as a subtle
/// inline line (mirrors the VS Code extension's settings lines).
fn change_notice(control: &str, icon: &str, from: &str, to: &str) -> SessionEvent {
    SessionEvent::Item(ConversationItem::Notice {
        subtype: "control_change".to_string(),
        detail: serde_json::json!({ "control": control, "icon": icon, "from": from, "to": to }),
    })
}

/// The boilerplate header the CLI prepends to an injected SKILL.md body — but ONLY when
/// the skill has a filesystem root (`skillRoot ? "Base directory for this skill: …" : body`).
/// A rootless/bundled skill injects its body raw, and a re-invocation injects a one-line
/// notice instead, so this prefix identifies SOME injected bodies, never all of them: it is
/// the belt-and-braces behind `UserMsg::is_synthetic`, not the primary guard.
const SKILL_BODY_PREFIX: &str = "Base directory for this skill:";

/// The tools CAPABLE of spawning a background task. Only these are remembered in
/// `tool_names` (the correlation map), keeping it far smaller than "every tool_use" —
/// though `Bash` qualifies even in the foreground (`run_in_background` is not visible
/// here), so the map is not strictly limited to calls that truly spawn a task. The
/// per-session assembler is torn down with its session, so this is not a process-lifetime
/// leak; terminal-task pruning is deferred to whoever (the fleet view) consumes them.
fn is_bg_capable_tool(name: &str) -> bool {
    matches!(name, "Agent" | "Workflow" | "Bash" | "Monitor")
}

/// Extract the absolute output path a background `Bash`/`Monitor` tool_result announces
/// ("…Output is being written to: `/tmp/claude-<uid>/<slug>/<session>/tasks/<id>.output`.
/// …"). The path runs from the marker to the `.output` suffix (the sentence continues
/// after it). `None` when the marker is absent (a normal, foreground tool_result).
///
/// Scans the BORROWED text (a string, or each `{text}` block of an array) in place — it
/// never copies the content, so a large Read/grep result is not cloned just to look for a
/// marker that foreground results never carry. Only the matched path is allocated.
fn output_file_from_tool_result(content: &Value) -> Option<String> {
    fn extract(text: &str) -> Option<String> {
        const MARKER: &str = "Output is being written to: ";
        const SUFFIX: &str = ".output";
        let after = &text[text.find(MARKER)? + MARKER.len()..];
        let end = after.find(SUFFIX)? + SUFFIX.len();
        Some(after[..end].to_string())
    }
    match content {
        Value::String(s) => extract(s),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .find_map(extract),
        _ => None,
    }
}

/// Extract a sub-agent's id from its transcript `output_file`
/// (`…/subagents/agent-<agentId>.jsonl` → `<agentId>`). `None` if the path does not
/// match that shape.
fn agent_id_from_output_file(path: &str) -> Option<String> {
    let file = path.rsplit('/').next()?;
    file.strip_suffix(".jsonl")?
        .strip_prefix("agent-")
        .map(str::to_string)
}

/// Classify a background task's producer. The tool NAME is the strongest signal
/// (it is the only thing that separates a background `Bash` from a `Monitor`, which
/// share `task_type:"local_bash"`); `task_type` is the fallback when the tool name
/// is not yet known.
fn classify_task(task_type: Option<&str>, tool_name: Option<&str>) -> BackgroundTaskKind {
    match tool_name {
        Some("Agent") => return BackgroundTaskKind::Agent,
        Some("Workflow") => return BackgroundTaskKind::Workflow,
        Some("Bash") => return BackgroundTaskKind::Bash,
        Some("Monitor") => return BackgroundTaskKind::Monitor,
        _ => {}
    }
    match task_type {
        // `local_bash` is ambiguous without the tool name (Bash bg AND Monitor) —
        // default to Bash, the common case; a later event with the name refines it.
        Some("local_bash") => BackgroundTaskKind::Bash,
        Some("local_agent") => BackgroundTaskKind::Agent,
        _ => BackgroundTaskKind::Other,
    }
}

/// Re-activate a background sub-agent task we'd already marked terminal. A detached
/// sub-agent RESUMED via `SendMessage` re-uses its task_id (== its agentId) and NEVER
/// re-emits `task_started` (captured by the `live_capture_subagent_wake` probe), so the
/// socle has to flip it back to Running itself — the running-gated AgentBar / FlightDeck
/// would otherwise never re-surface a woken agent.
///
/// SCOPED to exactly what the capture proves — a naturally-FINISHED (`Completed`) sub-agent
/// (`kind == Agent`): we deliberately do NOT revive a `Stopped` task (a user's Stop must
/// win, absent a real new `task_started`) nor a `Failed` one, and never touch a
/// Bash/Monitor/Workflow task (whose ids can't be a `SendMessage` target anyway). This
/// keeps a Stop from silently un-doing itself and avoids resurrecting a task the CLI won't
/// actually re-run (which, lacking a fresh terminal event, would linger Running until the
/// whole session ends).
///
/// On the flip it also RESETS the previous run's usage roll-up (tokens / tool_uses /
/// duration_ms / summary / progress) so the re-running row shows live-blank stats, not the
/// last run's numbers. Returns whether it flipped (so the caller re-emits the task).
fn reactivate_completed_agent(task: &mut BackgroundTask) -> bool {
    if task.kind != BackgroundTaskKind::Agent || task.status != BackgroundTaskStatus::Completed {
        return false;
    }
    task.status = BackgroundTaskStatus::Running;
    task.tokens = None;
    task.tool_uses = None;
    task.duration_ms = None;
    task.summary = None;
    task.progress = None;
    true
}

/// Map a wire status string onto our coarse [`BackgroundTaskStatus`]. Anything we do
/// not recognize is treated as still-running (a conservative default — a real
/// terminal state always sends `completed`/`failed`/etc.).
fn map_status(status: &str) -> BackgroundTaskStatus {
    match status {
        "completed" | "success" | "done" => BackgroundTaskStatus::Completed,
        "failed" | "error" | "timeout" | "timed_out" | "expired" => BackgroundTaskStatus::Failed,
        "stopped" | "cancelled" | "canceled" | "killed" => BackgroundTaskStatus::Stopped,
        // Non-terminal (`in_progress`, `running`, `queued`, …) or an unknown vocab. A
        // `task_notification` caller treats this as terminal (and logs it); a
        // `task_updated` legitimately stays Running until a terminal patch arrives.
        _ => BackgroundTaskStatus::Running,
    }
}

/// Friendly label for a model id (alias OR resolved id) — matches the composer's.
fn model_label(id: &str) -> String {
    let s = id.to_lowercase();
    if s.contains("opus") {
        "Opus 4.8".to_string()
    } else if s.contains("sonnet") {
        "Sonnet 4.6".to_string()
    } else if s.contains("haiku") {
        "Haiku 4.5".to_string()
    } else if s.contains("fable") {
        "Fable 5".to_string()
    } else {
        id.to_string()
    }
}

/// Friendly effort label, folding the ultracode tier in. `None` when there is no
/// known effort yet (so we never announce a phantom transition).
fn effort_label(effort: Option<&str>, ultracode: bool) -> Option<String> {
    if ultracode {
        return Some("Ultra code".to_string());
    }
    Some(
        match effort? {
            "low" => "Low",
            "medium" => "Medium",
            "high" => "High",
            "xhigh" => "Extra high",
            other => return Some(other.to_string()),
        }
        .to_string(),
    )
}

/// Friendly permission-mode label — matches the composer's PERM_LABEL.
fn permission_label(mode: &str) -> String {
    match mode {
        "auto" => "Auto mode",
        "default" => "Default",
        "acceptEdits" => "Auto-accept edits",
        "plan" => "Plan mode",
        "bypassPermissions" | "dontAsk" => "Bypass permissions",
        other => other,
    }
    .to_string()
}

/// Sum the tokens that occupy the context window from a `usage` object:
/// `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (the full
/// prompt sent to the model). Returns `None` when the object carries no token counts
/// (e.g. an empty/`null` usage), so callers don't reset a known value to zero.
pub(crate) fn context_used_from_usage(usage: &Value) -> Option<u64> {
    let field = |k: &str| usage.get(k).and_then(Value::as_u64);
    let input = field("input_tokens");
    let cache_creation = field("cache_creation_input_tokens");
    let cache_read = field("cache_read_input_tokens");
    if input.is_none() && cache_creation.is_none() && cache_read.is_none() {
        return None;
    }
    Some(input.unwrap_or(0) + cache_creation.unwrap_or(0) + cache_read.unwrap_or(0))
}

/// The AUTHORITATIVE context-window size for the session's own model, read from a
/// `result.modelUsage` map. This is the only reliable source of the window: the
/// number distinguishes e.g. Opus-200k from Opus-1M, which the model NAME cannot
/// (both are `claude-opus-4-8`; only the `[1m]` variant — and its `contextWindow`
/// value — tells them apart).
///
/// We match the entry whose key is `session_model` exactly, or `session_model`
/// followed by a bracketed beta suffix (`claude-opus-4-8[1m]`). Requiring the `[`
/// boundary (rather than a bare prefix) keeps a short id from matching a longer
/// sibling version — `claude-opus-4` must NOT swallow `claude-opus-4-8`. We
/// deliberately DO NOT fall back to "some other model in the map": a turn that only
/// ran a sub-agent (e.g. haiku 200k) must not shrink an Opus conversation's window —
/// returning `None` there tells the caller to KEEP the last known window instead of
/// clobbering it.
pub(crate) fn context_window_from_model_usage(
    model_usage: &Value,
    session_model: Option<&str>,
) -> Option<u64> {
    let obj = model_usage.as_object()?;
    let model = session_model?;
    // Exact key first, then `model[…]` (absorbs a `[1m]`-style beta suffix without
    // matching a longer version id).
    obj.iter()
        .find(|(k, _)| k.as_str() == model)
        .or_else(|| {
            obj.iter()
                .find(|(k, _)| k.strip_prefix(model).is_some_and(|rest| rest.starts_with('[')))
        })
        .and_then(|(_, entry)| entry.get("contextWindow"))
        .and_then(Value::as_u64)
}

/// Turn an assistant `content[]` array into typed normalized blocks.
///
/// Shared with [`super::history`], which reconstructs assistant turns from
/// Claude's on-disk transcript (same Anthropic `content[]` shape).
pub(crate) fn normalize_blocks(content: Option<&Value>) -> Vec<NormalizedBlock> {
    let mut blocks = Vec::new();
    if let Some(Value::Array(arr)) = content {
        for b in arr {
            match b.get("type").and_then(Value::as_str).unwrap_or_default() {
                "text" => blocks.push(NormalizedBlock::Text {
                    text: b.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
                }),
                "thinking" => blocks.push(NormalizedBlock::Thinking {
                    text: b
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }),
                "tool_use" | "server_tool_use" => blocks.push(NormalizedBlock::ToolUse {
                    id: b.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    name: b.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    input: b.get("input").cloned().unwrap_or(Value::Null),
                }),
                _ => blocks.push(NormalizedBlock::Other { raw: b.clone() }),
            }
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURE: &str = include_str!("fixtures/capture_text.jsonl");
    const CAPTURE_SKILL: &str = include_str!("fixtures/capture_skill.jsonl");
    /// The LIVE stdout shape of a model-invoked skill (captured via
    /// `live_capture_skill_body_replay`): the injected SKILL.md body carries NO `isMeta`
    /// (the CLI only adds it when persisting), so the `is_meta` guard can't drop it — only
    /// the armed skill-body drop can. This is the fixture the ON-DISK `capture_skill.jsonl`
    /// could NOT model.
    const CAPTURE_SKILL_LIVE: &str = include_str!("fixtures/capture_skill_live.jsonl");

    #[test]
    fn assembles_fixture_into_normalized_events() {
        let mut asm = Assembler::new();
        let mut streamed_text = String::new();
        let mut saw_model = false;
        let mut saw_session_id = false;
        let mut turn = None;
        let mut ended_idle = None;

        for line in CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                match ev {
                    SessionEvent::State(s) => {
                        saw_model |= s.model.is_some();
                        saw_session_id |= s.session_id.is_some();
                        ended_idle = Some(s.busy);
                    }
                    SessionEvent::Item(ConversationItem::TextDelta { text, .. }) => {
                        streamed_text.push_str(&text);
                    }
                    SessionEvent::Item(ConversationItem::TurnResult {
                        subtype,
                        is_error,
                        duration_api_ms,
                        ttft_ms,
                        ..
                    }) => {
                        turn = Some((subtype, is_error, duration_api_ms, ttft_ms));
                    }
                    _ => {}
                }
            }
        }

        assert!(saw_model, "a state event should carry the model");
        assert!(saw_session_id, "a state event should carry the session_id");
        assert!(
            streamed_text.to_lowercase().contains("hello world"),
            "streamed text deltas should reconstruct the reply, got {streamed_text:?}"
        );
        // The result's timing breakdown must survive normalization by VALUE (not just
        // parse): a renamed/typo'd wire field would silently deserialize to None and drop
        // the "N s de modèle" footer with no other failing test. The fixture's final
        // `result` line carries duration_api_ms:6605 and ttft_ms:5586.
        assert_eq!(
            turn,
            Some(("success".to_string(), false, Some(6605), Some(5586))),
            "the turn result must carry subtype/is_error AND the duration_api_ms/ttft_ms breakdown"
        );
        assert_eq!(ended_idle, Some(false), "session should be idle after the result");
    }

    /// A model-invoked skill (land → /done) fixture: the `Skill` tool_use IS surfaced (the
    /// front renders it as a command chip), while the SKILL.md body — a following `user` line
    /// with `isMeta:true` — is dropped, so it never shows as a fake user bubble. The tool_result
    /// ack surfaces as a ToolResult (attached to the Skill card), NOT a UserMessage.
    #[test]
    fn skill_invocation_fixture_surfaces_tool_use_not_body() {
        let mut asm = Assembler::new();
        let mut saw_skill_tool_use = false;
        let mut user_messages = 0;
        for line in CAPTURE_SKILL.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                match ev {
                    SessionEvent::Item(ConversationItem::AssistantMessage { blocks, .. }) => {
                        saw_skill_tool_use |= blocks
                            .iter()
                            .any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "Skill"));
                    }
                    SessionEvent::Item(ConversationItem::UserMessage { .. }) => user_messages += 1,
                    _ => {}
                }
            }
        }
        assert!(saw_skill_tool_use, "the Skill tool_use must be surfaced (rendered as a chip)");
        assert_eq!(
            user_messages, 0,
            "neither the tool_result ack nor the isMeta SKILL.md body may surface as a user bubble"
        );
    }

    /// REGRESSION (task 7e69f8ee): the LIVE wire of a model-invoked skill. The injected
    /// SKILL.md body arrives WITHOUT `isMeta` (the CLI only adds it when persisting to the
    /// transcript — proven by `live_capture_skill_body_replay`), so the `is_meta` guard the
    /// prior fix relied on NEVER fires live and the body leaked as a fake user bubble (bug
    /// was LIVE-ONLY: a reload read the on-disk `isMeta:true` line and dropped it). The
    /// armed skill-body drop (a `Skill` tool_use + the boilerplate prefix) must suppress it.
    /// This fixture has NO `isMeta`, so it FAILS the prior fix and PASSES this one.
    #[test]
    fn skill_body_live_line_without_ismeta_is_dropped() {
        let mut asm = Assembler::new();
        let mut saw_skill_tool_use = false;
        let mut user_messages = 0;
        for line in CAPTURE_SKILL_LIVE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                match ev {
                    SessionEvent::Item(ConversationItem::AssistantMessage { blocks, .. }) => {
                        saw_skill_tool_use |= blocks
                            .iter()
                            .any(|b| matches!(b, NormalizedBlock::ToolUse { name, .. } if name == "Skill"));
                    }
                    SessionEvent::Item(ConversationItem::UserMessage { .. }) => user_messages += 1,
                    _ => {}
                }
            }
        }
        assert!(saw_skill_tool_use, "the Skill tool_use must still surface (the SkillChip)");
        assert_eq!(
            user_messages, 0,
            "the LIVE SKILL.md body (no isMeta) must be dropped, never a fake user bubble"
        );
    }

    /// The armed skill-body drop is GATED: it must not swallow a real user turn that merely
    /// arrives after a skill invocation. A genuine turn only comes after the `result` that
    /// disarms the guard — and even in-turn, only the exact boilerplate prefix is dropped.
    #[test]
    fn skill_body_drop_does_not_swallow_real_next_turn() {
        let mut asm = Assembler::new();
        // Drive a full skill invocation (arms, then disarms on `result`).
        for line in CAPTURE_SKILL_LIVE.lines().filter(|l| !l.trim().is_empty()) {
            let msg: CliMessage = serde_json::from_str(line.trim()).unwrap();
            asm.ingest(&msg);
        }
        // A real user turn in the NEXT turn must surface normally.
        let real: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": "thanks, now do X"}]},
            "uuid": "u-real-next"
        }))
        .unwrap();
        let events = asm.ingest(&real);
        assert!(
            events.iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { text, .. }) if text == "thanks, now do X"
            )),
            "a real user turn after a skill invocation must NOT be swallowed by the drop guard"
        );
    }

    #[test]
    fn normalizes_assistant_tool_use_blocks() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "let me check"},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
                ]
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(assistant).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        let blocks = events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::AssistantMessage { blocks, .. }) => Some(blocks),
            _ => None,
        });
        let blocks = blocks.expect("expected an AssistantMessage");
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], NormalizedBlock::Text { text } if text == "let me check"));
        assert!(matches!(&blocks[1], NormalizedBlock::ToolUse { name, .. } if name == "Bash"));
    }

    /// A sub-agent's model surfaces ONLY inside its own streamed `assistant` message
    /// (`message.model`); the assembler must correlate it (via `parent_tool_use_id` →
    /// the spawning Agent tool_use → its task) and stash it on the BackgroundTask.
    #[test]
    fn captures_subagent_model_from_its_assistant_message() {
        let mut asm = Assembler::new();
        // The spawning `Agent` tool_use — records the tool name for task classification.
        let parent: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "msg_p", "role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_agent", "name": "Agent",
                 "input": {"description": "Explore", "subagent_type": "Explore"}}
            ]},
            "session_id": "s", "uuid": "u_p"
        }))
        .unwrap();
        asm.ingest(&parent);
        // `task_started` for that Agent tool_use → seeds the BackgroundTask.
        let started: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_started", "task_id": "task_1",
            "tool_use_id": "toolu_agent", "description": "Explore",
            "subagent_type": "Explore", "task_type": "local_agent"
        }))
        .unwrap();
        asm.ingest(&started);
        // The sub-agent's OWN assistant message: parent_tool_use_id set + model present.
        let sub: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "msg_s", "role": "assistant", "model": "claude-haiku-4-5",
                        "content": [{"type": "text", "text": "hi"}]},
            "parent_tool_use_id": "toolu_agent", "session_id": "s", "uuid": "u_s"
        }))
        .unwrap();
        let events = asm.ingest(&sub);
        let task = events
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Task(t) => Some(t),
                _ => None,
            })
            .expect("the sub-agent's assistant message should re-emit its task with the model");
        assert_eq!(task.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(task.tool_use_id.as_deref(), Some("toolu_agent"));
    }

    #[test]
    fn normalizes_user_tool_result() {
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok", "is_error": false}]
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(user).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        let result = events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::ToolResult { tool_use_id, .. }) => Some(tool_use_id),
            _ => None,
        });
        assert_eq!(result.as_deref(), Some("toolu_1"));
    }

    const WEBSEARCH_CAPTURE: &str = include_str!("fixtures/capture_websearch.jsonl");

    /// Non-regression: the web-research tools (WebSearch / WebFetch) carry their
    /// structure (the `Links: [...]` JSON array, the fetched markdown) INSIDE a
    /// string tool_result. The assembler must keep that content verbatim — the front
    /// parser (webResults.ts) recovers the sources from it — and never flatten or
    /// drop it. Guards the "preserve metadata to the front" contract.
    #[test]
    fn preserves_web_tool_result_content_verbatim() {
        let mut asm = Assembler::new();
        let mut results: Vec<(String, String)> = Vec::new();
        for line in WEBSEARCH_CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::Item(ConversationItem::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                    ..
                }) = ev
                {
                    assert!(!is_error, "fixture tool_results are successful");
                    // Content stays a raw string — not parsed, not flattened to text blocks.
                    let s = content.as_str().expect("web tool_result content is a string");
                    results.push((tool_use_id, s.to_string()));
                }
            }
        }
        assert_eq!(results.len(), 2, "one WebSearch + one WebFetch result");

        let websearch = &results
            .iter()
            .find(|(id, _)| id == "toolu_ws")
            .expect("WebSearch result present")
            .1;
        // The Links JSON array survives intact, with its title/url fields.
        assert!(websearch.contains("Links: ["));
        assert!(websearch.contains("\"url\":\"https://dev.to/serada/pandas-30-is-here\""));
        assert!(websearch.contains("\"url\":\"https://pandas.pydata.org/docs/whatsnew/v3.0.0.html\""));

        let webfetch = &results
            .iter()
            .find(|(id, _)| id == "toolu_wf")
            .expect("WebFetch result present")
            .1;
        // The fetched markdown survives intact.
        assert!(webfetch.contains("# Major Changes in pandas 3.0.0"));
        assert!(webfetch.contains("Copy-on-Write enforced by default"));
    }

    #[test]
    fn captures_context_fill_and_window_from_fixture() {
        let mut asm = Assembler::new();
        for line in CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            asm.ingest(&msg);
        }
        // input(5069) + cache_creation(9061) + cache_read(15626) = 29756.
        assert_eq!(asm.state().context_tokens, Some(29_756));
        // Opus 1M window wins over the haiku sub-agent's 200k (more input tokens).
        assert_eq!(asm.state().context_window, Some(1_000_000));
    }

    #[test]
    fn context_helpers_sum_and_pick_window() {
        let usage = serde_json::json!({
            "input_tokens": 100,
            "cache_creation_input_tokens": 20,
            "cache_read_input_tokens": 3,
            "output_tokens": 9
        });
        assert_eq!(context_used_from_usage(&usage), Some(123));
        // Empty usage → None (don't reset a known fill to zero).
        assert_eq!(context_used_from_usage(&serde_json::json!({})), None);

        let model_usage = serde_json::json!({
            "claude-haiku-4-5": {"inputTokens": 500, "contextWindow": 200000},
            "claude-opus-4-8[1m]": {
                "inputTokens": 5000, "cacheReadInputTokens": 15000,
                "cacheCreationInputTokens": 9000, "contextWindow": 1000000
            }
        });
        // Matches the session model by prefix (absorbs the `[1m]` suffix) → 1M, NOT
        // the sub-agent's 200k.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-opus-4-8")),
            Some(1_000_000)
        );
        // A 200k model resolves to 200k — the VALUE, not the name, sets the window.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-haiku-4-5")),
            Some(200_000)
        );
        // No entry for the session model → None (caller keeps the last known window,
        // so a sub-agent-only turn can't shrink an Opus conversation).
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-sonnet-4-6")),
            None
        );
        // A shorter version id must NOT match a longer sibling by bare prefix: the
        // suffix has to start with `[`, so `claude-opus-4` doesn't swallow
        // `claude-opus-4-8[1m]`.
        assert_eq!(
            context_window_from_model_usage(&model_usage, Some("claude-opus-4")),
            None
        );
        assert_eq!(context_window_from_model_usage(&model_usage, None), None);
        assert_eq!(context_window_from_model_usage(&Value::Null, Some("x")), None);
    }

    #[test]
    fn result_context_uses_last_iteration_not_aggregate() {
        let result = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "ok",
            "stop_reason": "end_turn",
            "session_id": "s",
            "uuid": "u",
            // A multi-call turn: the LAST iteration is the real final prompt size and
            // must win over the (here tiny) top-level number.
            "usage": {
                "input_tokens": 1,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "iterations": [
                    {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                    {"input_tokens": 2000, "cache_read_input_tokens": 18000, "cache_creation_input_tokens": 0}
                ]
            },
            "modelUsage": {"claude-opus-4-8[1m]": {"inputTokens": 2000, "contextWindow": 1000000}}
        });
        let msg: CliMessage = serde_json::from_value(result).unwrap();
        let mut asm = Assembler::new();
        // The window is matched to the session model, so set it (system/init does this
        // live); the modelUsage key carries a `[1m]` suffix the prefix match absorbs.
        let _ = asm.set_model("claude-opus-4-8");
        asm.ingest(&msg);
        // last iteration: 2000 + 18000 + 0 = 20000 (NOT the top-level 1).
        assert_eq!(asm.state().context_tokens, Some(20_000));
        assert_eq!(asm.state().context_window, Some(1_000_000));
    }

    const TASKS_CAPTURE: &str = include_str!("fixtures/capture_tasks.jsonl");

    /// Feed the captured task lifecycle through the assembler and collect the final
    /// [`BackgroundTask`] per id. Asserts the four producers are classified — crucially
    /// Bash vs Monitor (same `task_type:"local_bash"`, told apart by tool name) — and
    /// that the terminal status + usage roll-up land.
    #[test]
    fn ingests_background_tasks_and_classifies_producers() {
        use std::collections::HashMap;
        let mut asm = Assembler::new();
        let mut tasks: HashMap<String, BackgroundTask> = HashMap::new();
        let mut emissions = 0;
        for line in TASKS_CAPTURE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::Task(t) = ev {
                    emissions += 1;
                    tasks.insert(t.task_id.clone(), t);
                }
            }
        }
        // Every task_* transition emits (4 producers × {started, updated, notif} +
        // the workflow's progress tick = 13).
        assert_eq!(emissions, 13, "one Task event per task_* transition");
        assert_eq!(tasks.len(), 4, "four distinct background tasks");

        let agent = &tasks["task_agent_1"];
        assert_eq!(agent.kind, BackgroundTaskKind::Agent);
        assert_eq!(agent.subagent_type.as_deref(), Some("Explore"));
        assert_eq!(agent.status, BackgroundTaskStatus::Completed);
        assert_eq!(agent.tokens, Some(11174));
        assert_eq!(agent.tool_uses, Some(3));
        assert_eq!(agent.duration_ms, Some(859));
        assert_eq!(agent.tool_use_id.as_deref(), Some("toolu_agent"));
        // agent_id parsed from the notification's output_file (…/subagents/agent-aa11.jsonl).
        assert_eq!(agent.agent_id.as_deref(), Some("aa11"));

        let wf = &tasks["task_wf_1"];
        assert_eq!(wf.kind, BackgroundTaskKind::Workflow);
        assert_eq!(wf.progress.as_deref(), Some("Research: r-alpha"));
        assert_eq!(wf.status, BackgroundTaskStatus::Completed);

        let bash = &tasks["task_bash_1"];
        assert_eq!(bash.kind, BackgroundTaskKind::Bash, "local_bash + Bash tool → Bash");
        assert_eq!(bash.status, BackgroundTaskStatus::Completed);
        assert!(bash.output_file.as_deref().unwrap().ends_with("task_bash_1.output"));

        let mon = &tasks["task_mon_1"];
        assert_eq!(
            mon.kind,
            BackgroundTaskKind::Monitor,
            "local_bash + Monitor tool → Monitor (NOT Bash)"
        );
        assert_eq!(mon.status, BackgroundTaskStatus::Completed);
    }

    /// The classifier prefers the tool name (the only Bash/Monitor discriminator),
    /// falls back to `task_type`, and the status mapper folds wire strings onto the
    /// coarse states.
    #[test]
    fn classify_and_status_mapping() {
        assert_eq!(classify_task(Some("local_bash"), Some("Monitor")), BackgroundTaskKind::Monitor);
        assert_eq!(classify_task(Some("local_bash"), Some("Bash")), BackgroundTaskKind::Bash);
        assert_eq!(classify_task(None, Some("Workflow")), BackgroundTaskKind::Workflow);
        assert_eq!(classify_task(Some("local_agent"), None), BackgroundTaskKind::Agent);
        // Ambiguous local_bash with no tool name yet defaults to Bash (refined later).
        assert_eq!(classify_task(Some("local_bash"), None), BackgroundTaskKind::Bash);
        assert_eq!(classify_task(None, None), BackgroundTaskKind::Other);

        assert_eq!(map_status("completed"), BackgroundTaskStatus::Completed);
        assert_eq!(map_status("failed"), BackgroundTaskStatus::Failed);
        assert_eq!(map_status("timed_out"), BackgroundTaskStatus::Failed);
        assert_eq!(map_status("stopped"), BackgroundTaskStatus::Stopped);
        assert_eq!(map_status("in_progress"), BackgroundTaskStatus::Running);

        assert_eq!(agent_id_from_output_file("/x/s/subagents/agent-aa11.jsonl").as_deref(), Some("aa11"));
        assert_eq!(agent_id_from_output_file("/x/s/tasks/t.output"), None);
    }

    /// A Monitor's tool name, recorded from `content_block_start`, must classify the
    /// task as Monitor (NOT Bash) even though `task_started` arrives before the
    /// assembled assistant message — the ordering hazard (finding #2).
    #[test]
    fn monitor_classified_from_content_block_start_before_assistant_message() {
        let mut asm = Assembler::new();
        let cbs: CliMessage = serde_json::from_str(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_mon","name":"Monitor","input":{}}},"session_id":"s"}"#,
        )
        .unwrap();
        asm.ingest(&cbs);
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_mon","tool_use_id":"tu_mon","description":"watch","task_type":"local_bash"}"#,
        )
        .unwrap();
        let task = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        assert_eq!(task.expect("a Task event").kind, BackgroundTaskKind::Monitor);
    }

    /// If `task_started` truly beats the tool name, the task starts as the ambiguous
    /// Bash fallback but is RE-CLASSIFIED (and re-emitted) the moment the name arrives.
    #[test]
    fn late_tool_name_reclassifies_an_ambiguous_local_bash_task() {
        let mut asm = Assembler::new();
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_late","tool_use_id":"tu_late","description":"watch","task_type":"local_bash"}"#,
        )
        .unwrap();
        let first = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        // No name yet → ambiguous local_bash defaults to Bash.
        assert_eq!(first.expect("a Task event").kind, BackgroundTaskKind::Bash);

        // The name arrives late (assistant message); the task is corrected to Monitor.
        let assistant: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_late", "name": "Monitor", "input": {}}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        let corrected = asm.ingest(&assistant).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        assert_eq!(
            corrected.expect("a re-classify Task event").kind,
            BackgroundTaskKind::Monitor
        );
    }

    /// The label is the NAME the agent gave the task (`description`), and the raw command
    /// lands in its OWN field — so the pinned line reads "build the app" while the popover
    /// can still show `$ <command>`. Here the assembled assistant message precedes the task.
    #[test]
    fn background_bash_keeps_name_label_and_captures_command() {
        let mut asm = Assembler::new();
        let assistant: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_bash", "name": "Bash",
                 "input": {"command": "npm run build && ./scripts/sign.sh", "description": "Build the app", "run_in_background": true}}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        asm.ingest(&assistant);
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_bash","tool_use_id":"tu_bash","description":"Build the app","task_type":"local_bash"}"#,
        )
        .unwrap();
        let task = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let task = task.expect("a Task event");
        assert_eq!(task.kind, BackgroundTaskKind::Bash);
        assert_eq!(task.label.as_deref(), Some("Build the app"), "label = the name");
        assert_eq!(
            task.command.as_deref(),
            Some("npm run build && ./scripts/sign.sh"),
            "the raw command is captured in its own field"
        );
    }

    /// The realistic streamed ordering: `content_block_start` (name only) →
    /// `task_started` (command not known yet) → the assembled `assistant` message carries
    /// the full command and BACKFILLS the `command` field (re-emitting the task), leaving
    /// the `label` name intact.
    #[test]
    fn late_bash_command_backfills_the_command_field() {
        let mut asm = Assembler::new();
        let cbs: CliMessage = serde_json::from_str(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_bash","name":"Bash","input":{}}},"session_id":"s"}"#,
        )
        .unwrap();
        asm.ingest(&cbs);
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_bash","tool_use_id":"tu_bash","description":"Watch the log","task_type":"local_bash"}"#,
        )
        .unwrap();
        let first = asm.ingest(&started).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let first = first.expect("a Task event");
        assert_eq!(first.label.as_deref(), Some("Watch the log"));
        assert_eq!(first.command, None, "command not known yet");

        let assistant: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "tu_bash", "name": "Bash",
                 "input": {"command": "tail -f log.txt", "description": "Watch the log", "run_in_background": true}}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        let backfilled = asm.ingest(&assistant).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let backfilled =
            backfilled.expect("the assistant message must re-emit the task with the command");
        assert_eq!(backfilled.label.as_deref(), Some("Watch the log"), "name unchanged");
        assert_eq!(backfilled.command.as_deref(), Some("tail -f log.txt"));
    }

    /// The background Bash tool_result announces the ABSOLUTE output path; the assembler
    /// parses it and sets `output_file` on the task (the only wire source early enough to
    /// live-tail it — the CLI writes to a temp dir, not the session dir).
    #[test]
    fn captures_output_file_path_from_background_tool_result() {
        // The exact format captured live from claude 2.1.187.
        let real = "Command running in background with ID: by7jmgia3. Output is being written to: /private/tmp/claude-501/-Users-x-Repos-y/sess-1/tasks/by7jmgia3.output. You will be notified when it completes.";
        assert_eq!(
            output_file_from_tool_result(&serde_json::json!(real)).as_deref(),
            Some("/private/tmp/claude-501/-Users-x-Repos-y/sess-1/tasks/by7jmgia3.output"),
        );
        // An ordinary tool_result (no marker) yields nothing.
        assert_eq!(output_file_from_tool_result(&serde_json::json!("done, 3 files")), None);
        // Each text block of an array is scanned in place (no whole-content copy).
        let arr = serde_json::json!([{"type":"text","text":"Output is being written to: /t/sess/tasks/k.output."}]);
        assert_eq!(
            output_file_from_tool_result(&arr).as_deref(),
            Some("/t/sess/tasks/k.output"),
        );

        // End-to-end: task_started → its tool_result sets output_file and re-emits.
        let mut asm = Assembler::new();
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_bash","tool_use_id":"tu_bash","description":"d","task_type":"local_bash"}"#,
        )
        .unwrap();
        asm.ingest(&started);
        let result: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "tu_bash",
                 "content": "Command running in background with ID: x. Output is being written to: /tmp/claude-501/s/tasks/tk.output. You will be notified.",
                 "is_error": false}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        let task = asm.ingest(&result).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        assert_eq!(
            task.expect("a re-emitted Task event").output_file.as_deref(),
            Some("/tmp/claude-501/s/tasks/tk.output"),
        );
    }

    /// A terminal `task_notification` must NOT clobber the live TEMP `output_file` already
    /// captured from the start tool_result marker — that temp path is the live-tailable
    /// one; the notification's path may point elsewhere (a session-dir path the CLI does
    /// not actually write for a Bash/Monitor). Regression guard for the completion read.
    #[test]
    fn notification_does_not_clobber_the_captured_output_file() {
        let mut asm = Assembler::new();
        let started: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_started","task_id":"tk_bash","tool_use_id":"tu_bash","description":"d","task_type":"local_bash"}"#,
        )
        .unwrap();
        asm.ingest(&started);
        // The start tool_result announces the real, live-tailable TEMP path.
        let result: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "tu_bash",
                 "content": "Running in background. Output is being written to: /tmp/claude-1/s/tasks/tk_bash.output. You will be notified.",
                 "is_error": false}
            ]},
            "session_id": "s"
        }))
        .unwrap();
        asm.ingest(&result);
        // A terminal notification carrying a DIFFERENT (session-dir) path must leave the
        // already-captured temp path intact.
        let notif: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_notification","task_id":"tk_bash","tool_use_id":"tu_bash","status":"completed","output_file":"/Users/x/.claude/projects/-x/s/tasks/tk_bash.output","summary":"done"}"#,
        )
        .unwrap();
        let task = asm.ingest(&notif).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let task = task.expect("a terminal Task event");
        assert_eq!(task.status, BackgroundTaskStatus::Completed);
        assert_eq!(
            task.output_file.as_deref(),
            Some("/tmp/claude-1/s/tasks/tk_bash.output"),
            "the live temp path captured from the marker must survive the notification"
        );
    }

    /// A late `task_updated` for a task whose `task_started` we missed still yields a
    /// usable (Running→Completed) entry — the stream can be joined mid-run.
    #[test]
    fn task_updated_without_prior_started_is_tolerated() {
        let mut asm = Assembler::new();
        let msg: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"task_updated","task_id":"orphan","patch":{"status":"completed"}}"#,
        )
        .unwrap();
        let ev = asm.ingest(&msg);
        let task = ev.into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        });
        let task = task.expect("a Task event even without a prior task_started");
        assert_eq!(task.task_id, "orphan");
        assert_eq!(task.status, BackgroundTaskStatus::Completed);
        assert_eq!(task.kind, BackgroundTaskKind::Other);
    }

    #[test]
    fn ingests_rate_limit_event_into_state() {
        let event = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "resetsAt": 1781618400_i64,
                "rateLimitType": "five_hour",
                "overageStatus": "rejected",
                "isUsingOverage": false
            },
            "session_id": "s", "uuid": "u"
        });
        let msg: CliMessage = serde_json::from_value(event).unwrap();
        let mut asm = Assembler::new();
        let events = asm.ingest(&msg);
        // First sighting emits a state event...
        assert!(events
            .iter()
            .any(|e| matches!(e, SessionEvent::State(_))));
        let rl = asm.state().rate_limit.clone().expect("rate limit captured");
        assert_eq!(rl.status.as_deref(), Some("allowed_warning"));
        assert_eq!(rl.resets_at, Some(1781618400));
        assert_eq!(rl.limit_type.as_deref(), Some("five_hour"));
        assert!(!rl.using_overage);
        // ...re-emitting the same snapshot is a no-op (no churn).
        let again = asm.ingest(&msg);
        assert!(again.is_empty(), "unchanged rate limit should emit nothing");
    }

    // ---- "control changed" announcements -----------------------------------

    fn first_notice(events: Vec<SessionEvent>) -> Option<(String, Value)> {
        events.into_iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => Some((subtype, detail)),
            _ => None,
        })
    }

    fn seeded() -> Assembler {
        let mut asm = Assembler::new();
        // Spawn baseline: Opus / Extra high / Default.
        asm.seed_controls(Some("opus".into()), Some("xhigh".into()), Some("default".into()), false);
        asm
    }

    /// A read-back that MATCHES the seed must not announce (no notice on spawn /
    /// resume); a real effort move must announce exactly one transition.
    #[test]
    fn effort_change_announces_only_a_real_move() {
        let mut asm = seeded();
        // The initial get_settings confirms the seed → state only, no notice.
        let evs = asm.apply_settings(Some("claude-opus-4-8[1m]".into()), Some("xhigh".into()), Some(false));
        assert!(first_notice(evs).is_none(), "confirming the seed must stay silent");
        // Now a genuine change xhigh → high.
        let (subtype, detail) = first_notice(asm.apply_settings(None, Some("high".into()), Some(false)))
            .expect("a control_change notice");
        assert_eq!(subtype, "control_change");
        assert_eq!(detail["control"], serde_json::json!("Thinking effort"));
        assert_eq!(detail["from"], serde_json::json!("Extra high"));
        assert_eq!(detail["to"], serde_json::json!("High"));
        // Re-reading the same value is silent (idempotent).
        assert!(first_notice(asm.apply_settings(None, Some("high".into()), Some(false))).is_none());
    }

    /// Ultra code is announced as its own label, not as "Extra high".
    #[test]
    fn ultracode_change_announces_its_own_label() {
        let mut asm = seeded();
        let (_, detail) = first_notice(asm.apply_settings(None, Some("xhigh".into()), Some(true)))
            .expect("a notice");
        assert_eq!(detail["from"], serde_json::json!("Extra high"));
        assert_eq!(detail["to"], serde_json::json!("Ultra code"));
    }

    /// A confirmed permission move announces; re-confirming the same mode is silent.
    #[test]
    fn permission_confirm_announces_then_is_idempotent() {
        let mut asm = seeded();
        let (_, detail) = first_notice(asm.confirm_permission_mode("plan")).expect("a notice");
        assert_eq!(detail["control"], serde_json::json!("Permission mode"));
        assert_eq!(detail["from"], serde_json::json!("Default"));
        assert_eq!(detail["to"], serde_json::json!("Plan mode"));
        assert!(first_notice(asm.confirm_permission_mode("plan")).is_none());
    }

    /// A model change reported by `system/init` (e.g. switched via /model in chat)
    /// is announced; the permission, unchanged from the seed, stays silent.
    #[test]
    fn model_change_from_system_init_is_announced() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-sonnet-4-6", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["control"], serde_json::json!("Model"));
        assert_eq!(detail["from"], serde_json::json!("Opus 4.8"));
        assert_eq!(detail["to"], serde_json::json!("Sonnet 4.6"));
    }

    /// `system/bridge_state` is a Remote Control HEALTH signal: a `disconnected` /
    /// `error` state DOWNGRADES the bridge (emitting a `RemoteControl` event); any
    /// other `state` is ignored, and it never carries a session URL (that only comes
    /// from the control response).
    #[test]
    fn bridge_state_disconnected_and_error_downgrade_but_other_is_ignored() {
        let mut asm = seeded();
        let disconnected: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "bridge_state", "state": "disconnected"
        }))
        .unwrap();
        match asm.ingest(&disconnected).as_slice() {
            [SessionEvent::RemoteControl(s)] => {
                assert_eq!(s.status, "disconnected");
                assert!(s.session_url.is_none());
                assert!(s.error.is_none());
            }
            other => panic!("expected one RemoteControl event, got {other:?}"),
        }

        let errored: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "bridge_state", "state": "error", "detail": "bridge closed"
        }))
        .unwrap();
        match asm.ingest(&errored).as_slice() {
            [SessionEvent::RemoteControl(s)] => {
                assert_eq!(s.status, "error");
                assert_eq!(s.error.as_deref(), Some("bridge closed"));
            }
            other => panic!("expected one RemoteControl error event, got {other:?}"),
        }

        // A `connected`/unknown state on bridge_state is NOT authoritative → ignored.
        let connected: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "bridge_state", "state": "connected"
        }))
        .unwrap();
        assert!(asm.ingest(&connected).is_empty(), "bridge_state never drives connected");
    }

    /// A remote-originated user turn (typed on the phone while the session is bridged)
    /// arrives as an ordinary text `user` message on the live stream — it must surface
    /// as a `UserMessage` (keyed by uuid), or it would only appear on reload.
    #[test]
    fn remote_user_text_message_surfaces_as_user_message_live() {
        let mut asm = seeded();
        // String content, carrying the live `isReplay:true` marker → replay=true.
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "salut depuis le téléphone" },
            "uuid": "u-remote-1", "isReplay": true
        }))
        .unwrap();
        match asm.ingest(&m).as_slice() {
            [SessionEvent::Item(ConversationItem::UserMessage { id, text, replay, .. })] => {
                assert_eq!(id, "u-remote-1");
                assert_eq!(text, "salut depuis le téléphone");
                assert!(*replay, "a live wire echo carries replay=true → spliced by the UI");
            }
            other => panic!("expected one UserMessage, got {other:?}"),
        }
        // Array content with a text block.
        let m2: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": "deuxième" }] },
            "uuid": "u-remote-2"
        }))
        .unwrap();
        match asm.ingest(&m2).as_slice() {
            [SessionEvent::Item(ConversationItem::UserMessage { id, text, .. })] => {
                assert_eq!(id, "u-remote-2");
                assert_eq!(text, "deuxième");
            }
            other => panic!("expected one UserMessage, got {other:?}"),
        }
    }

    /// A `user` message that only carries a `tool_result` (no text) must emit the
    /// ToolResult but NOT a spurious empty UserMessage.
    #[test]
    fn tool_result_only_user_message_emits_no_user_message() {
        let mut asm = seeded();
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "ok" }
            ] },
            "uuid": "u-tr"
        }))
        .unwrap();
        let events = asm.ingest(&m);
        assert!(
            events.iter().all(|e| !matches!(e, SessionEvent::Item(ConversationItem::UserMessage { .. }))),
            "a tool_result-only user message must not emit a UserMessage"
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::Item(ConversationItem::ToolResult { .. }))),
            "the tool_result must still be surfaced"
        );
    }

    /// A SUB-AGENT (sidechain) prompt — the text Claude sends INTO a `Task`/`Agent`
    /// tool — arrives live as a `user` line with a FRESH uuid (not ours) and
    /// `parent_tool_use_id` = the spawning tool_use. It must NOT surface as a
    /// main-conversation user bubble (the "sub-agent prompts appear as if I sent them"
    /// bug). Wire shape VERIFIED against claude 2.1.203 (fresh uuid, parent set,
    /// `isReplay`/`isSidechain` absent). A remote turn, by contrast, is a ROOT turn
    /// (`parent_tool_use_id` absent) and still surfaces — see the test above.
    #[test]
    fn subagent_prompt_with_parent_is_not_surfaced_as_user_message() {
        let mut asm = seeded();
        // Exact shape captured on the live wire: sub-agent prompt with a parent id.
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "text", "text": "Output the single word PINEAPPLE and nothing else." }
            ] },
            "uuid": "abea97c6-8ddf-4004-b25e-0e88fb2a1507",
            "parent_tool_use_id": "toolu_01AhBhoo496zXkuW9TxSVMU5"
        }))
        .unwrap();
        assert!(
            asm.ingest(&m).iter().all(|e| !matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { .. })
            )),
            "a sub-agent prompt (parent_tool_use_id set) must never surface as a user bubble"
        );
        // A sub-agent's INTERNAL tool_result (same parent) is still surfaced (routed to
        // its own card downstream) — the parent guard only gates the text bubble.
        let tr: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_inner", "content": "done" }
            ] },
            "uuid": "78c31232-8c9b-427e-9251-1e3b58598387",
            "parent_tool_use_id": "toolu_01AhBhoo496zXkuW9TxSVMU5"
        }))
        .unwrap();
        let events = asm.ingest(&tr);
        assert!(
            events.iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::ToolResult { parent_tool_use_id: Some(p), .. })
                    if p == "toolu_01AhBhoo496zXkuW9TxSVMU5"
            )),
            "a sub-agent's internal tool_result must still be surfaced with its parent"
        );
        assert!(
            events.iter().all(|e| !matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { .. })
            )),
            "the tool_result-only sidechain line still emits no user bubble"
        );
    }

    /// A user turn WE sent (uuid recorded via `note_sent_user_message`) is echoed back
    /// by `--replay-user-messages` — that echo must be SUPPRESSED (the UI shows it
    /// optimistically). The suppression is one-shot (the uuid is consumed), which
    /// self-bounds the set — a message is only ever replayed once.
    #[test]
    fn own_sent_user_message_echo_is_suppressed_one_shot() {
        let mut asm = seeded();
        asm.note_sent_user_message("mine-1");
        let echo: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user", "uuid": "mine-1", "isReplay": true,
            "message": { "role": "user", "content": "hello" }
        }))
        .unwrap();
        assert!(asm.ingest(&echo).is_empty(), "our own replayed turn must be suppressed");
        // The uuid is consumed: were the same uuid to arrive again (it never does in
        // practice), it would now surface — proving the set self-bounds.
        assert!(
            asm.ingest(&echo).iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::UserMessage { .. })
            )),
            "the suppression is one-shot (uuid consumed)"
        );
    }

    /// An injected/meta user line (`isMeta:true` — command output, system reminders,
    /// the queued "while you were working" wrapper) is NOT a real turn → dropped, just
    /// like the transcript restore does.
    ///
    /// ⚠️ This shape is the DISK one. It is kept because the same types parse transcripts,
    /// but it proves nothing about the live path: the CLI renames the flag to `isSynthetic`
    /// on stdout, so for years this test was green while the live guard was dead code. The
    /// live shape is covered by [`synthetic_user_lines_are_dropped`] and the parity table.
    #[test]
    fn meta_user_message_is_dropped() {
        let mut asm = seeded();
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "<system-reminder>…</system-reminder>" },
            "isMeta": true,
            "uuid": "u-meta"
        }))
        .unwrap();
        assert!(asm.ingest(&m).is_empty(), "a meta user line must be dropped");
    }

    /// Every user line the CLI injects itself carries `isSynthetic:true` on the LIVE wire —
    /// and NO `isMeta` (VERIFIED against claude 2.1.217 by live probe and by reading the
    /// binary: `isSynthetic: o.isMeta || o.isVisibleInTranscriptOnly`). None of them may
    /// become a user bubble.
    ///
    /// The four shapes below are the ones that actually leaked, each with real occurrence
    /// counts from the user's own transcripts.
    #[test]
    fn synthetic_user_lines_are_dropped() {
        for (label, text) in [
            // A skill with a filesystem root: body prefixed by the boilerplate header.
            ("prefixed skill body", "Base directory for this skill: /x/.claude/skills/done\n\n# Done\n…"),
            // A ROOTLESS skill: the CLI prepends nothing, so the prefix guard can't see it.
            // 27 such bodies (3.5–8.8 KB) exist on disk.
            ("rootless skill body", "Approach this as the design lead at a small studio known for their versatility…"),
            // Re-invoking a skill already loaded this session (8 on disk).
            ("skill re-invocation", "(Re-invocation of /done — the skill instructions were previously loaded; the arguments or dynamic output below are new.)"),
            // The sidecar the CLI emits after reading an image it had to downscale (23 on
            // disk) — the "Claude's screenshot shows up as a message I sent" report.
            ("image downscale note", "[Image: original 2400x1524, displayed at 2000x1270. Multiply coordinates by 1.20 to map to original image.]"),
        ] {
            let mut asm = seeded();
            let m: CliMessage = serde_json::from_value(serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": [{"type": "text", "text": text}] },
                // As on the wire: isSynthetic present, isMeta ABSENT.
                "isSynthetic": true,
                "uuid": "u-synth"
            }))
            .unwrap();
            let items: Vec<_> = user_texts(asm.ingest(&m));
            assert!(items.is_empty(), "{label} must not surface as a user bubble, got {items:?}");
        }
    }

    /// A synthetic line can also be the CARRIER of a `tool_result`. Dropping the whole line
    /// (rather than just its bubble) would swallow a tool's output — a silent loss.
    #[test]
    fn a_synthetic_line_still_surfaces_its_tool_result() {
        let mut asm = seeded();
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "output"},
                {"type": "text", "text": "[Image: original 2400x1524, displayed at 2000x1270.]"}
            ]},
            "isSynthetic": true,
            "uuid": "u-synth-tr"
        }))
        .unwrap();
        let evs = asm.ingest(&m);
        assert!(user_texts(evs.clone()).is_empty(), "the injected text must not become a bubble");
        assert!(
            evs.iter().any(|e| matches!(
                e,
                SessionEvent::Item(ConversationItem::ToolResult { tool_use_id, .. }) if tool_use_id == "toolu_1"
            )),
            "the tool_result on the same line must still be surfaced"
        );
    }

    /// The skill-body belt-and-braces must be armed from the STREAMED `content_block_start`,
    /// not only from the assembled assistant message: that message lands at end of turn, and
    /// on a concurrent tool branch the injected body arrives BEFORE it (4 such orderings on
    /// disk). Here the assistant message never arrives at all.
    #[test]
    fn skill_body_is_dropped_when_armed_only_from_the_stream() {
        let mut asm = seeded();
        let start: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "stream_event",
            "event": {"type": "content_block_start", "index": 0,
                      "content_block": {"type": "tool_use", "id": "toolu_sk", "name": "Skill", "input": {}}},
            "session_id": "s"
        }))
        .unwrap();
        asm.ingest(&start);
        // The injected body, WITHOUT any provenance flag at all — the worst case, where only
        // the armed prefix guard can catch it.
        let body: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                {"type": "text", "text": "Base directory for this skill: /x/.claude/skills/done\n\n# Done"}
            ]},
            "uuid": "u-body"
        }))
        .unwrap();
        assert!(
            user_texts(asm.ingest(&body)).is_empty(),
            "a skill body must be dropped even when the assistant message hasn't arrived yet"
        );
    }

    /// A GENUINE turn must still get through — the guards must not swallow real messages.
    #[test]
    fn a_real_remote_turn_still_surfaces() {
        let mut asm = seeded();
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{"type": "text", "text": "ship it"}] },
            "uuid": "u-remote", "isReplay": true
        }))
        .unwrap();
        assert_eq!(user_texts(asm.ingest(&m)), vec!["ship it".to_string()]);
    }

    /// The user-visible texts of any `UserMessage` items in a batch of events.
    fn user_texts(evs: Vec<SessionEvent>) -> Vec<String> {
        evs.into_iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::UserMessage { text, .. }) => Some(text),
                _ => None,
            })
            .collect()
    }

    /// REGRESSION (task 2247ebd6): a MODEL-invoked skill (the `Skill` tool — e.g. land → /done)
    /// expands its SKILL.md body onto the wire as a `user` line carrying `isMeta:true` (verified
    /// on-disk on every model-invoked skill: a `tool_result` ack then a text-block body opening
    /// on "Base directory for this skill:"). It MUST be dropped like any meta line — never
    /// surfaced as a fake user bubble. The visible trace is the `Skill` tool_use itself (rendered
    /// as a command chip by the front), so this redundant body stays hidden.
    #[test]
    fn skill_body_user_line_is_dropped() {
        let mut asm = seeded();
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                {"type": "text",
                 "text": "Base directory for this skill: /x/.claude/skills/done\n\n# Done — Terminer une tâche\n\n…whole SKILL.md body…"}
            ]},
            "isMeta": true,
            "uuid": "u-skill-body"
        }))
        .unwrap();
        assert!(
            asm.ingest(&m).is_empty(),
            "a model-invoked skill's isMeta body must be dropped, never surfaced as a user bubble"
        );
    }

    // --- Shared helpers for the SendMessage-wake tests -----------------------------------
    /// Ingest a main-loop `SendMessage{to}` tool_use and return any `Task` events it emits.
    fn ingest_send(asm: &mut Assembler, to: &str) -> Vec<BackgroundTask> {
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "assistant",
            "message": {"id": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_s", "name": "SendMessage",
                 "input": {"to": to, "message": "go", "summary": "go"}}
            ]},
            "session_id": "s", "uuid": "u"
        }))
        .unwrap();
        asm.ingest(&m)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::Task(t) => Some(t),
                _ => None,
            })
            .collect()
    }
    /// Seed a COMPLETED background task carrying a usage roll-up (so a later reactivation can
    /// be checked to reset it). `task_type` = `local_agent` → kind Agent; `local_bash` → Bash.
    fn seed_completed(asm: &mut Assembler, task_id: &str, tool_use_id: &str, task_type: &str) {
        let started: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_started", "task_id": task_id,
            "tool_use_id": tool_use_id, "description": "x", "task_type": task_type
        }))
        .unwrap();
        asm.ingest(&started);
        let done: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_notification", "task_id": task_id,
            "tool_use_id": tool_use_id, "status": "completed",
            "usage": {"total_tokens": 999, "tool_uses": 2, "duration_ms": 500}
        }))
        .unwrap();
        asm.ingest(&done);
    }

    /// REGRESSION (task f267b721): a detached background sub-agent RESUMED via `SendMessage`
    /// must re-surface as Running. The wire re-uses the agent's task_id (== its agentId) and
    /// NEVER re-emits `task_started`, so the socle flips the tracked task back to Running off
    /// the `SendMessage{to}` tool_use. Drives the FULL captured wire fixture — including the
    /// post-wake `task_notification` whose `tool_use_id` is the SendMessage id (line 11), the
    /// one place the identity the AgentBar keys on could be clobbered.
    #[test]
    fn send_message_wake_reactivates_a_completed_background_agent() {
        const WAKE: &str = include_str!("fixtures/capture_subagent_wake.jsonl");
        const TASK: &str = "a5704a9056e4e1a0c"; // task_id == agentId (stable across the wake)
        let lines: Vec<&str> = WAKE.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 11, "fixture shape: launch (1..=6) + wake (7..=11)");

        let mut asm = Assembler::new();
        let mut last: Option<BackgroundTask> = None;
        let mut after_first_completion: Option<BackgroundTask> = None;
        let mut after_wake: Option<BackgroundTask> = None;
        for (i, line) in lines.iter().enumerate() {
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::Task(t) = ev {
                    if t.task_id == TASK {
                        last = Some(t);
                    }
                }
            }
            match i {
                5 => after_first_completion = last.clone(), // line 6: first task_notification
                6 => after_wake = last.clone(),             // line 7: the SendMessage wake
                _ => {}
            }
        }

        // First run finished: Completed, Agent, with its usage roll-up folded in.
        let done = after_first_completion.expect("the launched agent should have a tracked task");
        assert_eq!(done.status, BackgroundTaskStatus::Completed, "the agent finished its first run");
        assert_eq!(done.kind, BackgroundTaskKind::Agent);
        assert_eq!(done.tool_use_id.as_deref(), Some("toolu_agent"));
        assert_eq!(done.tokens, Some(1234));
        assert_eq!(done.tool_uses, Some(1));

        // The SendMessage wake flips it back to Running, KEEPS the original Agent tool_use_id
        // (the AgentBar keys on it via bgAgentIds), and RESETS the prior run's stale roll-up.
        let woke = after_wake.expect("the SendMessage wake must re-emit the agent's task");
        assert_eq!(woke.status, BackgroundTaskStatus::Running, "the resumed agent is Running again");
        assert_eq!(woke.tool_use_id.as_deref(), Some("toolu_agent"));
        assert_eq!(woke.kind, BackgroundTaskKind::Agent);
        assert_eq!(woke.tokens, None, "the prior run's token count must not show on the running row");
        assert_eq!(woke.tool_uses, None);
        assert_eq!(woke.duration_ms, None);

        // After the full wake — incl. the terminal `task_notification` whose tool_use_id is the
        // SendMessage id (fixture line 11) — the task settles Completed but its identity must be
        // UNCLOBBERED (still the Agent tool_use_id), now carrying run #2's roll-up.
        let end = last.expect("a final snapshot");
        assert_eq!(end.status, BackgroundTaskStatus::Completed);
        assert_eq!(
            end.tool_use_id.as_deref(),
            Some("toolu_agent"),
            "the SendMessage tool_use_id must NOT overwrite the identity the AgentBar keys on"
        );
        assert_eq!(end.kind, BackgroundTaskKind::Agent);
        assert_eq!(end.tokens, Some(2345), "the second run's usage roll-up");
        assert_eq!(end.duration_ms, Some(8100));
    }

    /// The progress-tick backstop: a `task_progress` on a COMPLETED sub-agent flips it back to
    /// Running AND resets the prior run's stale roll-up, while keeping the fresh tick label.
    /// Covers a resume we did NOT observe as a local `SendMessage` tool_use (e.g. one issued
    /// from the phone via Remote Control).
    #[test]
    fn task_progress_reactivates_a_completed_agent_and_resets_stale_stats() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent"); // Completed Agent w/ usage
        let progress: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_progress", "task_id": "t1",
            "tool_use_id": "toolu_send", "description": "Running again"
        }))
        .unwrap();
        let events = asm.ingest(&progress);
        let t = events
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Task(t) => Some(t),
                _ => None,
            })
            .expect("the progress tick re-emits the task");
        assert_eq!(t.status, BackgroundTaskStatus::Running, "a completed agent came back to life");
        assert_eq!(t.progress.as_deref(), Some("Running again"), "the fresh tick label survives the reset");
        assert_eq!(t.tokens, None, "the prior run's roll-up is cleared on reactivation");
        assert_eq!(t.tool_uses, None);
        assert_eq!(t.tool_use_id.as_deref(), Some("toolu_agent"), "identity preserved");
    }

    /// SCOPING (hardening from the adversarial review): reactivation is NOT unconditional. A
    /// STOPPED agent (the user hit Stop → the CLI settles it `stopped`) must NOT be resurrected
    /// — neither by a trailing `task_progress` tick nor by a later `SendMessage` to it. Absent a
    /// real new `task_started`, the user's Stop wins.
    #[test]
    fn a_stopped_agent_is_not_resurrected() {
        let mut asm = Assembler::new();
        let started: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_started", "task_id": "t1",
            "tool_use_id": "toolu_agent", "description": "go", "subagent_type": "Explore",
            "task_type": "local_agent"
        }))
        .unwrap();
        asm.ingest(&started);
        let stopped: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_updated", "task_id": "t1",
            "patch": {"status": "stopped"}
        }))
        .unwrap();
        asm.ingest(&stopped);

        // A later SendMessage to it emits nothing (the helper's scoping refuses a non-Completed
        // task)…
        assert!(
            ingest_send(&mut asm, "t1").is_empty(),
            "SendMessage must not resurrect a stopped agent"
        );
        // …and a trailing progress tick still shows it Stopped, proving the store wasn't flipped.
        let progress: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "task_progress", "task_id": "t1", "description": "late tick"
        }))
        .unwrap();
        let t = asm
            .ingest(&progress)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Task(t) => Some(t),
                _ => None,
            })
            .expect("progress re-emits the task");
        assert_eq!(t.status, BackgroundTaskStatus::Stopped, "a stopped agent stays stopped");
    }

    /// SELECTIVITY (hardening from the adversarial review): against a POPULATED store,
    /// `resume_agent_via_send_message` flips ONLY a matching Completed AGENT. A teammate NAME
    /// matches no task_id; a `to` matching a non-agent (Bash) task is scoped out by kind.
    #[test]
    fn send_message_resume_is_selective() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "agentX", "toolu_agent", "local_agent");
        seed_completed(&mut asm, "bashY", "toolu_bash", "local_bash");

        // A teammate NAME / "main" matches no task_id → no flip at all.
        assert!(ingest_send(&mut asm, "researcher").is_empty(), "a teammate name matches no task");
        assert!(ingest_send(&mut asm, "main").is_empty(), "\"main\" matches no task");
        // A `to` matching a non-agent (Bash) task → scoped out by the kind guard → no flip.
        assert!(ingest_send(&mut asm, "bashY").is_empty(), "a Bash task must not be resurrected");
        // A `to` matching the completed agent → flips exactly that one to Running.
        let flipped = ingest_send(&mut asm, "agentX");
        assert_eq!(flipped.len(), 1, "exactly the matching agent flips");
        assert_eq!(flipped[0].task_id, "agentX");
        assert_eq!(flipped[0].status, BackgroundTaskStatus::Running);
        assert_eq!(flipped[0].kind, BackgroundTaskKind::Agent);
    }
}

/// LIVE ↔ RELOAD parity — the structural guard for the "content I never wrote is shown as a
/// message I sent" class of bug.
///
/// The two surfaces are different code (`Assembler::ingest` reads the stdout wire,
/// `history::parse_transcript_str` reads the transcript) and their guards key on DIFFERENT
/// fields, because the CLI renames them on the way to disk (`isSynthetic` → `isMeta`) and
/// hides some shapes behind no field at all. Nothing forced the two halves to agree, so each
/// could regress to green on its own — which is exactly what happened: the disk test passed
/// while the live guard was dead code, for every shape below.
///
/// This table pins the invariant directly: for each known line, the LIVE shape and the DISK
/// shape must yield the SAME user bubbles. A future field rename breaks this test on the
/// surface that drifted.
#[cfg(test)]
mod parity_tests {
    use super::*;
    use crate::supervisor::history::parse_transcript_str;
    use serde_json::json;

    /// The user-visible bubble texts the LIVE path produces for one wire line.
    fn live_bubbles(line: serde_json::Value) -> Vec<String> {
        let mut asm = Assembler::new();
        let msg: CliMessage = serde_json::from_value(line).expect("live line must parse");
        asm.ingest(&msg)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::UserMessage { text, .. }) => Some(text),
                _ => None,
            })
            .collect()
    }

    /// The user-visible bubble texts the RELOAD path produces for one transcript line.
    fn disk_bubbles(line: serde_json::Value) -> Vec<String> {
        let content = serde_json::to_string(&line).expect("disk line must serialize");
        let (items, _) = parse_transcript_str(&content, true);
        items
            .into_iter()
            .filter_map(|i| match i {
                ConversationItem::UserMessage { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    /// Each case: a label, the line as it arrives LIVE, the same line as PERSISTED, and the
    /// bubbles both must produce. Real shapes, taken from probes against claude 2.1.217 and
    /// from the on-disk transcripts.
    #[test]
    fn live_and_reload_agree_on_every_known_line() {
        let text_content = |t: &str| json!([{ "type": "text", "text": t }]);
        let cases: Vec<(&str, serde_json::Value, serde_json::Value, Vec<&str>)> = vec![
            (
                "a genuine human prompt",
                json!({"type":"user","uuid":"u1","message":{"role":"user","content":text_content("ship it")}}),
                json!({"type":"user","uuid":"u1","message":{"role":"user","content":text_content("ship it")}}),
                vec!["ship it"],
            ),
            (
                "a prefixed skill body",
                json!({"type":"user","uuid":"u2","isSynthetic":true,
                       "message":{"role":"user","content":text_content("Base directory for this skill: /x\n\n# Done")}}),
                json!({"type":"user","uuid":"u2","isMeta":true,
                       "message":{"role":"user","content":text_content("Base directory for this skill: /x\n\n# Done")}}),
                vec![],
            ),
            (
                "a rootless skill body (no prefix to key on)",
                json!({"type":"user","uuid":"u3","isSynthetic":true,
                       "message":{"role":"user","content":text_content("Approach this as the design lead at a small studio…")}}),
                json!({"type":"user","uuid":"u3","isMeta":true,
                       "message":{"role":"user","content":text_content("Approach this as the design lead at a small studio…")}}),
                vec![],
            ),
            (
                "the image downscale sidecar",
                json!({"type":"user","uuid":"u4","isSynthetic":true,
                       "message":{"role":"user","content":text_content("[Image: original 2400x1524, displayed at 2000x1270.]")}}),
                // On disk this one is a bare STRING content, not a block array.
                json!({"type":"user","uuid":"u4","isMeta":true,
                       "message":{"role":"user","content":"[Image: original 2400x1524, displayed at 2000x1270.]"}}),
                vec![],
            ),
            (
                "stop-hook feedback",
                json!({"type":"user","uuid":"u5","isSynthetic":true,
                       "message":{"role":"user","content":text_content("Stop hook feedback:\n[all tests pass]: not yet")}}),
                json!({"type":"user","uuid":"u5","isMeta":true,
                       "message":{"role":"user","content":text_content("Stop hook feedback:\n[all tests pass]: not yet")}}),
                vec![],
            ),
            (
                "the /compact continuation summary",
                json!({"type":"user","uuid":"u6","isSynthetic":true,
                       "message":{"role":"user","content":text_content("This session is being continued from a previous conversation…")}}),
                // Disk: NO isMeta — `isCompactSummary` + `isVisibleInTranscriptOnly` instead.
                json!({"type":"user","uuid":"u6","isCompactSummary":true,"isVisibleInTranscriptOnly":true,
                       "message":{"role":"user","content":text_content("This session is being continued from a previous conversation…")}}),
                vec![],
            ),
            (
                "an interrupt marker (flagged on NEITHER surface)",
                json!({"type":"user","uuid":"u7","message":{"role":"user","content":text_content("[Request interrupted by user]")}}),
                json!({"type":"user","uuid":"u7","message":{"role":"user","content":text_content("[Request interrupted by user]")}}),
                vec![],
            ),
            (
                "another command's stdout (flagged on NEITHER surface)",
                json!({"type":"user","uuid":"u8","message":{"role":"user","content":text_content("<local-command-stdout>Set model to opus</local-command-stdout>")}}),
                json!({"type":"user","uuid":"u8","message":{"role":"user","content":text_content("<local-command-stdout>Set model to opus</local-command-stdout>")}}),
                vec![],
            ),
            (
                "the IDE banner glued in front of a real prompt",
                json!({"type":"user","uuid":"u9","message":{"role":"user","content":text_content(
                    "<ide_opened_file>The user opened /a/b.md in the IDE.</ide_opened_file>\nfix the typo")}}),
                json!({"type":"user","uuid":"u9","message":{"role":"user","content":text_content(
                    "<ide_opened_file>The user opened /a/b.md in the IDE.</ide_opened_file>\nfix the typo")}}),
                vec!["fix the typo"],
            ),
            (
                "a sub-agent prompt (parent_tool_use_id live, isSidechain on disk)",
                json!({"type":"user","uuid":"u10","parent_tool_use_id":"toolu_a",
                       "message":{"role":"user","content":text_content("Research the auth flow")}}),
                json!({"type":"user","uuid":"u10","isSidechain":true,
                       "message":{"role":"user","content":text_content("Research the auth flow")}}),
                vec![],
            ),
            (
                "an image-only turn",
                json!({"type":"user","uuid":"u11","message":{"role":"user","content":
                    [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}]}}),
                json!({"type":"user","uuid":"u11","message":{"role":"user","content":
                    [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR"}}]}}),
                vec!["[image]"],
            ),
            (
                "/goal plumbing",
                json!({"type":"user","uuid":"u12","message":{"role":"user","content":text_content(
                    "<local-command-stdout>Goal set: all tests pass</local-command-stdout>")}}),
                json!({"type":"user","uuid":"u12","message":{"role":"user","content":text_content(
                    "<local-command-stdout>Goal set: all tests pass</local-command-stdout>")}}),
                vec![],
            ),
        ];

        for (label, live, disk, want) in cases {
            let want: Vec<String> = want.into_iter().map(str::to_string).collect();
            assert_eq!(live_bubbles(live), want, "LIVE differs from expectation: {label}");
            assert_eq!(disk_bubbles(disk), want, "RELOAD differs from expectation: {label}");
        }
    }
}
