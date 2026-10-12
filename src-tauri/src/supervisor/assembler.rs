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

use super::bash_limits::{cli_has_deadline, BashTimeLimits};
use super::control;
use super::model::{
    BackgroundStopCause, BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, CompactInfo, ConversationItem, LoadedAgent,
    LoadedPlugin, ModelTokenUsage, NormalizedBlock, RateLimitSnapshot, RemoteControlState, RemoteLinkState, RetryState, SessionEvent,
    SessionStatePayload, SessionUsage, TokenUsage,
};
use super::protocol::{
    AssistantMsg, CliMessage, LiveTaskEntry, RateLimitMsg, ResultMsg, StreamEventMsg, SystemMsg,
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
    /// The permission mode the CLI last REPORTED for this process (`initialize`'s
    /// `current_permission_mode`, `system/init`, `system/status`, a `set_permission_mode`
    /// ack) — distinct from `state.permission_mode`, which a click moves optimistically.
    /// A refused switch puts the display back on this value (the `get_settings` read-back
    /// carries no permission mode). Seeded with the spawn mode.
    confirmed_permission: Option<String>,
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
    /// Ids of the MAIN-THREAD `SendMessage` tool_uses seen this session. A
    /// `SendMessage{to:<agentId>}` WAKES a finished sub-agent, and since CLI 2.1.283 that
    /// wake emits a real `task_started` whose `tool_use_id` is the SENDMESSAGE's, not the
    /// original `Agent`'s — this set is how [`Assembler::ingest_task_started`] tells a wake
    /// from a launch. Load-bearing when the registry is COLD (conversation reloaded /
    /// session re-spawned between launch and wake): the task is then unknown and the
    /// wake's `task_started` creates it. Main thread only, like the front's `bgAgentIds`:
    /// a sub-agent waking ITS OWN agent (nesting) must not surface that grandchild as the
    /// conversation's background work. Deliberately NOT folded into `tool_names`:
    /// `classify_task` would read the unknown name as `Other` and `record_tool` would
    /// re-classify the woken task with it.
    send_message_ids: HashSet<String>,
    /// Every `SendMessage` tool_use (any thread) → its target (`to`) and whether the MAIN
    /// thread sent it, waiting for its tool_result. A SUCCESSFUL result revives the target
    /// sub-agent ([`Assembler::wake_on_send_message_result`]) — the only wake signal of a
    /// pre-2.1.283 binary, which emits no `task_started`. Nothing is revived on the
    /// tool_use alone: a SendMessage that then fails (interrupted, refused,
    /// `success:false`) never woke anything, and an inferred flip would have had to be
    /// undone — reading to the front, the phone and the voice agent as a run that finished.
    send_message_targets: HashMap<String, (String, bool)>,
    /// Finds the `Agent` tool_use that launched a sub-agent, from the session's on-disk
    /// sidecar (see [`super::subagents::launch_tool_use_id`]). Consulted ONCE per cold wake
    /// to re-key the woken task onto the id its own messages stream under. `None` = no disk
    /// to read (a session hosted on another machine, unit tests): the task then stays keyed
    /// on the SendMessage id and the front resolves the launch from its rehydrated ack.
    launch_resolver: Option<LaunchResolver>,
    /// Sub-agent `parent_tool_use_id`s whose model could not be tied to a task, already
    /// logged — a woken agent we could not re-key streams dozens of messages, one log each
    /// would bury the signal.
    uncorrelated_model_parents: HashSet<String>,
    /// Ids in the latest `background_tasks_changed` level — the CLI's own word on which
    /// background tasks are live. Empty until the first level: it is per process and
    /// nothing is sent at startup (a fresh process gets a fresh assembler).
    live_level: HashSet<String>,
    /// Running tasks that LEFT the level, awaiting the edge (`task_updated` /
    /// `task_notification`) that settles them with their real status. The level PRECEDES
    /// those edges (verified live, 2.1.286), so retiring a task on the level itself would
    /// flash a guessed status — and fire the front's once-per-task "finished" push with
    /// it. An edge that ends the task clears it here; one still pending when an unrelated
    /// line arrives lost its edge for good (see [`Assembler::retire_orphaned_tasks`]).
    pending_retire: HashSet<String>,
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
    /// Armed when this turn's `[Request interrupted by user…]` marker line arrives (it
    /// precedes the turn's `result`); reset by every `result`. The fallback interrupt
    /// signal for a binary whose `result` carries no `terminal_reason` — see
    /// [`is_user_interrupt`].
    interrupt_marker_seen: bool,
    /// The CLI's CUMULATIVE `result.duration_api_ms` as of the previous `result` — the
    /// baseline a turn's own model time is measured from. The wire value is a running
    /// per-SESSION total (verified live, claude 2.1.283: 2.1s → 6.0s → 7.1s over three
    /// plain prompts) that is even restored across `--resume` (7.1s → 7.9s after a
    /// re-spawn), NOT a per-turn figure. `Some(0)` for a brand-new session (the counter
    /// starts at zero — see [`Assembler::mark_fresh_session`]); `None` while unknown (a
    /// resumed or re-attached process, until its first `result` sets it).
    api_ms_baseline: Option<u64>,
    /// `set_model` requests sent but not yet acked. The CLI DEFERS a model switch
    /// (claude 2.1.285: a per-session promise chain, PreModelSwitch hooks and, for a
    /// pinned id, a server entitlement check of up to 5 s) and acks only once it is
    /// applied — while `get_settings` and each turn's `system/init` answer from the
    /// model in force RIGHT NOW. Until the last switch acks, both still describe the
    /// PREVIOUS model: letting them through overwrote the pick with the old model and
    /// left the picker one click behind. See [`Assembler::begin_model_switch`].
    model_switches_in_flight: u32,
    /// The figures a background `Bash` command's time limit is drawn from, as this
    /// session's CLI process sees them (see [`Assembler::set_bash_limits`]).
    bash_limits: BashTimeLimits,
    /// The CLI's version, from `system/init`. A CLI before 2.1.285 has no background
    /// time limit, so no deadline is computed for it. `None` until the first init.
    cli_version: Option<String>,
    /// Wall clock override for tests (epoch ms); `None` = the system clock.
    clock: Option<fn() -> u64>,
}

/// `(session_id, agent_id) → launching Agent tool_use id` (see `Assembler::launch_resolver`).
pub type LaunchResolver = fn(&str, &str) -> Option<String>;

/// The last-announced friendly labels for the controls (see [`Assembler`]).
#[derive(Debug, Default)]
struct Announced {
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    /// Ultracode's last-announced on/off. Unlike the others it is NOT seeded from the
    /// spawn: the first read-back sets it silently. A spawn that asks for ultracode where
    /// it can't run (workflows turned off) already raises its own control error; a seeded
    /// baseline would add a second, redundant "Ultracode: On → Off" line on top.
    ultracode: Option<bool>,
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
    /// The `timeout` a `Bash` launched WITH `run_in_background` asked for — the only
    /// case it sets the background time limit (a command moved to the background mid-run
    /// gets the default). `None` otherwise, and until the assembled input lands.
    background_timeout_ms: Option<u64>,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// This process started a brand-new session (no `--resume`, no re-attach), so the
    /// CLI's cumulative model-time counter starts at zero and the FIRST turn's model time
    /// is known too. Left unset otherwise: a resumed session's restored total cannot be
    /// known before its first `result`, whose model time is then reported as unknown.
    pub fn mark_fresh_session(&mut self) {
        self.api_ms_baseline = Some(0);
    }

    /// Let a cold wake look up its launching `Agent` on disk (see `launch_resolver`). Set
    /// only for a session whose artifacts live on THIS machine.
    pub fn set_launch_resolver(&mut self, resolver: LaunchResolver) {
        self.launch_resolver = Some(resolver);
    }

    /// The limits this session's CLI process derives background time limits from (its
    /// env and settings — see [`BashTimeLimits::resolve`]). Left at the CLI's defaults
    /// when unknown (a session hosted on another machine).
    pub fn set_bash_limits(&mut self, limits: BashTimeLimits) {
        self.bash_limits = limits;
    }

    fn now_ms(&self) -> u64 {
        match self.clock {
            Some(clock) => clock(),
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        }
    }

    /// The background time limit of the `Bash` spawned by `tool_use_id`, or `None` when
    /// this CLI has none. The requested `timeout` counts only for a command launched
    /// with `run_in_background` (see [`ToolUse::background_timeout_ms`]).
    fn bash_time_limit(&self, tool_use_id: Option<&str>) -> Option<u64> {
        if self.cli_version.as_deref().is_some_and(|v| !cli_has_deadline(v)) {
            return None;
        }
        let requested = tool_use_id
            .and_then(|id| self.tool_names.get(id))
            .and_then(|t| t.background_timeout_ms);
        Some(self.bash_limits.limit_for(requested))
    }

    /// The model time spent since the previous `result` — this turn's share of the CLI's
    /// cumulative `duration_api_ms` (see [`Self::api_ms_baseline`]). `None` when the
    /// baseline is unknown, or when the counter went BACKWARDS (a re-spawned process that
    /// restored an older total): the delta would be meaningless, so the turn reports none
    /// and the new total becomes the baseline. A `result` without the field leaves the
    /// baseline untouched.
    fn turn_api_ms(&mut self, cumulative: Option<u64>) -> Option<u64> {
        let total = cumulative?;
        let turn = self.api_ms_baseline.and_then(|base| total.checked_sub(base));
        self.api_ms_baseline = Some(total);
        turn
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

    /// Reflect the live remote SSH link's lifecycle — see
    /// [`RemoteLinkState`]/[`SessionStatePayload::link`]'s own docs. Mirrors
    /// [`Self::set_busy`] in shape; called only by `supervisor::session::run_actor` for
    /// a REMOTE conversation (never set for a local one).
    pub fn set_link(&mut self, link: Option<RemoteLinkState>) -> SessionEvent {
        self.state.link = link;
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a permission-mode change (after `set_permission_mode`).
    pub fn set_permission_mode(&mut self, mode: &str) -> SessionEvent {
        self.state.permission_mode = Some(mode.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// The permission mode the CLI last reported (see `confirmed_permission`).
    pub fn confirmed_permission_mode(&self) -> Option<&str> {
        self.confirmed_permission.as_deref()
    }

    /// Record a mode the CLI reported outside the per-turn stream — `initialize`'s
    /// `current_permission_mode`, the live process's mode at handshake time (a REMOTE
    /// attach may re-join a process started with another one). Silent: no "control
    /// changed" notice, and the baseline is left alone — the session either moves the
    /// process to the composer's mode right after, or explains why it can't. `show:
    /// false` while a click's switch is still in flight (its ack is newer than this).
    pub fn observe_permission_mode(&mut self, mode: &str, show: bool) -> Option<SessionEvent> {
        self.confirmed_permission = Some(mode.to_string());
        if !show || self.state.permission_mode.as_deref() == Some(mode) {
            return None;
        }
        self.state.permission_mode = Some(mode.to_string());
        Some(SessionEvent::State(self.state.clone()))
    }

    /// A permission switch was REFUSED: show the mode the process is really in again
    /// (the optimistic click had moved the display). The refusal is already explained
    /// by its own error notice, so this re-bases the "control changed" baseline too —
    /// the next turn's `system/init` must not announce the same fact a second time.
    pub fn revert_permission_mode(&mut self) -> SessionEvent {
        if let Some(mode) = self.confirmed_permission.clone() {
            self.announced.permission = Some(permission_label(&mode));
            self.state.permission_mode = Some(mode);
        }
        SessionEvent::State(self.state.clone())
    }

    /// Whether THIS process can run `bypassPermissions` (see
    /// [`SessionStatePayload::bypass_available`]). `None` = unknown.
    pub fn set_bypass_available(&mut self, available: Option<bool>) -> SessionEvent {
        self.state.bypass_available = available;
        SessionEvent::State(self.state.clone())
    }

    /// See [`Self::set_bypass_available`].
    pub fn bypass_available(&self) -> Option<bool> {
        self.state.bypass_available
    }

    /// Reflect an acknowledged `reload_plugins`: the fresh plugin and sub-agent lists it
    /// carries (each `None` when the response has none — an older CLI — and then left as
    /// is). The skills are FORGOTTEN: the reload may have added or dropped a plugin's
    /// skills, and no response carries the new list — showing the old one would contradict
    /// the fresh plugins next to it. The next turn's `system/init` brings it back.
    pub fn apply_reload(
        &mut self,
        plugins: Option<Vec<LoadedPlugin>>,
        agents: Option<Vec<LoadedAgent>>,
    ) -> SessionEvent {
        if let Some(p) = plugins {
            self.state.loaded_plugins = Some(p);
        }
        if let Some(a) = agents {
            self.state.loaded_agents = Some(a);
        }
        self.state.loaded_skills = None;
        SessionEvent::State(self.state.clone())
    }

    /// Reflect the sub-agents (with descriptions) the `initialize` response carries. A
    /// reload goes through [`Self::apply_reload`], which also forgets the skills.
    pub fn set_loaded_agents(&mut self, agents: Vec<LoadedAgent>) -> SessionEvent {
        self.state.loaded_agents = Some(agents);
        SessionEvent::State(self.state.clone())
    }

    /// Reflect a model change (after `set_model`).
    pub fn set_model(&mut self, model: &str) -> SessionEvent {
        self.state.model = Some(model.to_string());
        SessionEvent::State(self.state.clone())
    }

    /// A `set_model` request just went out: until its ack, every live report of the
    /// model predates it (see [`Assembler::model_switches_in_flight`]).
    pub fn begin_model_switch(&mut self) {
        self.model_switches_in_flight += 1;
    }

    /// A `set_model` request was acked (applied or refused).
    pub fn end_model_switch(&mut self) {
        self.model_switches_in_flight = self.model_switches_in_flight.saturating_sub(1);
    }

    /// Stop waiting for switches whose ack can no longer be relied on (the link that
    /// carried them died). A late ack still lands harmlessly on the saturating decrement.
    pub fn forget_model_switches(&mut self) {
        self.model_switches_in_flight = 0;
    }

    /// Whether a model switch is still pending on the CLI side — while it is, the live
    /// settings describe the model we are switching AWAY from.
    pub fn model_switch_in_flight(&self) -> bool {
        self.model_switches_in_flight > 0
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
        self.announced.effort = effort.as_deref().and_then(effort_label);
        self.announced.permission = permission_mode.as_deref().map(permission_label);
        self.confirmed_permission = permission_mode.clone();
        self.state.model = model;
        self.state.effort = effort;
        self.state.permission_mode = permission_mode;
        self.state.ultracode = ultracode;
    }

    /// Optimistically reflect an effort change from a UI click: updates the display
    /// state immediately, but does NOT announce — the timeline line waits for the
    /// `get_settings` read-back ([`apply_settings`]), so it shows the CONFIRMED value,
    /// never the optimistic one. Leaves ultracode alone: it is independent of the effort.
    pub fn set_effort_optimistic(&mut self, effort: String) -> SessionEvent {
        self.state.effort = Some(effort);
        SessionEvent::State(self.state.clone())
    }

    /// Optimistically reflect an ultracode switch from a UI click — never announced
    /// either (see [`set_effort_optimistic`]). Turning it on where the last read-back
    /// said it can't run leaves it off: the switch must not show what won't happen.
    pub fn set_ultracode_optimistic(&mut self, on: bool) -> SessionEvent {
        self.state.ultracode = on && self.state.ultracode_available != Some(false);
        SessionEvent::State(self.state.clone())
    }

    /// Apply a live `get_settings` read-back: the authoritative model / effort /
    /// ultracode (and whether ultracode can run at all) the CLI reports. A field absent
    /// from the response (`None`) is left untouched. Returns the state event PLUS a
    /// "control changed" notice for each value that actually MOVED (the model-felt
    /// source of truth).
    pub fn apply_settings(
        &mut self,
        model: Option<String>,
        effort: Option<String>,
        ultracode: Option<bool>,
        ultracode_available: Option<bool>,
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
        if ultracode_available.is_some() {
            self.state.ultracode_available = ultracode_available;
        }
        let mut out = vec![SessionEvent::State(self.state.clone())];
        if let Some(m) = &model {
            self.announce_model(m, &mut out);
        }
        if effort.is_some() {
            self.announce_effort(&mut out);
        }
        if let Some(u) = ultracode {
            self.announce_ultracode(u, &mut out);
        }
        out
    }

    /// Apply the CONFIRMED permission mode from a `set_permission_mode` ack (it echoes
    /// the mode the CLI actually applied, which can differ from the requested one).
    /// Returns the state event plus a "control changed" notice if it moved.
    pub fn confirm_permission_mode(&mut self, mode: &str) -> Vec<SessionEvent> {
        self.confirmed_permission = Some(mode.to_string());
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

    /// Emit a "Thinking effort: X → Y" notice if the confirmed effort moved.
    fn announce_effort(&mut self, out: &mut Vec<SessionEvent>) {
        let Some(to) = self.state.effort.as_deref().and_then(effort_label) else {
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

    /// Emit an "Ultracode: Off → On" notice if the confirmed ultracode moved. Its own
    /// line, no longer folded into the effort: the two are independent since 2.1.284.
    /// The first sighting only records the baseline (see [`Announced::ultracode`]).
    fn announce_ultracode(&mut self, on: bool, out: &mut Vec<SessionEvent>) {
        let label = |v: bool| if v { "On" } else { "Off" };
        match self.announced.ultracode {
            Some(from) if from == on => {}
            Some(from) => {
                out.push(change_notice("Ultracode", "bolt", label(from), label(on)));
                self.announced.ultracode = Some(on);
            }
            None => self.announced.ultracode = Some(on),
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
        self.state.link = None;
        self.state.ended = true;
        SessionEvent::State(self.state.clone())
    }

    /// Ingest one inbound message, returning the events to emit (possibly none).
    /// Control-channel messages are handled by the session, not here.
    pub fn ingest(&mut self, msg: &CliMessage) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        if !self.pending_retire.is_empty() && !is_task_lifecycle(msg) {
            self.retire_orphaned_tasks(&mut out);
        }
        match msg {
            CliMessage::System(sys) => self.ingest_system(sys, &mut out),
            CliMessage::StreamEvent(se) => {
                self.clear_retry(&mut out);
                self.ingest_stream_event(se, &mut out)
            }
            CliMessage::Assistant(a) => {
                self.clear_retry(&mut out);
                self.ingest_assistant(a, &mut out)
            }
            CliMessage::User(u) => self.ingest_user(u, &mut out),
            CliMessage::Result(r) => {
                self.clear_retry(&mut out);
                self.ingest_result(r, &mut out)
            }
            CliMessage::RateLimitEvent(rl) => self.ingest_rate_limit(rl, &mut out),
            // Generated after `result`; the binary aborts it when the next command
            // arrives, but one already on the wire can still land after a new turn
            // started — it predicts a reply to a turn that is no longer the last one.
            CliMessage::PromptSuggestion(p) => {
                let suggestion = p.suggestion.trim();
                if !self.state.busy && !suggestion.is_empty() {
                    out.push(SessionEvent::PromptSuggestion { suggestion: suggestion.to_string() });
                }
            }
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

    /// Drop a pending retry notice: anything arriving from the model proves the
    /// connection recovered. Emits a state event only when there was something to
    /// clear, so this stays free on the hot path.
    fn clear_retry(&mut self, out: &mut Vec<SessionEvent>) {
        if self.state.retry.take().is_some() {
            out.push(SessionEvent::State(self.state.clone()));
        }
    }

    fn ingest_system(&mut self, sys: &SystemMsg, out: &mut Vec<SessionEvent>) {
        match sys {
            SystemMsg::Init(init) => {
                self.state.session_id = init.session_id.clone();
                if init.claude_code_version.is_some() {
                    self.cli_version = init.claude_code_version.clone();
                }
                // A turn that starts while a model switch is still pending reports the
                // model it is switching AWAY from: keep the pick shown (the switch's ack
                // re-reads the settings) instead of flipping the picker back to it.
                let model_settled = !self.model_switch_in_flight();
                if model_settled {
                    self.state.model = init.model.clone();
                }
                self.state.permission_mode = init.permission_mode.clone();
                if init.permission_mode.is_some() {
                    self.confirmed_permission = init.permission_mode.clone();
                }
                // `system/init` is re-emitted at the start of EACH turn, so when the
                // agent moves the session into/out of a worktree (EnterWorktree /
                // ExitWorktree), the next turn's init carries the new cwd — the UI's
                // worktree indicator follows along.
                self.state.cwd = init.cwd.clone();
                // Output style is re-emitted each turn like cwd/model; keep the state's
                // copy in step so the UI shows the style the binary is actually running.
                self.state.output_style = init.output_style.clone();
                // The plugins the binary loaded, wherever it runs. An init WITHOUT the
                // field (older CLI) keeps the last known list rather than claiming none.
                if let Some(Value::Array(plugins)) = &init.plugins {
                    self.state.loaded_plugins = Some(control::loaded_plugins_from_array(plugins));
                }
                // Same for its skills and sub-agents. The agent names keep the descriptions
                // an earlier `initialize` / `reload_plugins` response gave them.
                if let Some(Value::Array(skills)) = &init.skills {
                    self.state.loaded_skills = Some(control::loaded_skills_from_array(skills));
                }
                if let Some(Value::Array(agents)) = &init.agents {
                    let names = control::loaded_agents_from_array(agents);
                    self.state.loaded_agents =
                        Some(control::merge_agent_names(self.state.loaded_agents.as_deref(), names));
                }
                // Do NOT force busy here: `system/init` is emitted at the start of
                // each turn (not at spawn). Marking busy on init is fine for turns,
                // but busy is driven by user-send (set_busy) + message_start /
                // result so the composer is never wedged "busy" without a turn.
                out.push(SessionEvent::State(self.state.clone()));
                // `system/init` carries the authoritative model + permission each
                // turn: announce a change made from the chat (e.g. /model) too. Same
                // value → silent (announce_* dedupes).
                if let Some(m) = init.model.as_ref().filter(|_| model_settled) {
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
                compact_result,
                compact_error,
            } => {
                if let Some(pm) = permission_mode {
                    self.state.permission_mode = Some(pm.clone());
                    self.confirmed_permission = Some(pm.clone());
                }
                if session_id.is_some() {
                    self.state.session_id = session_id.clone();
                }
                // `"compacting"` lands here too: the UI's working line reads it to say
                // "Compacting conversation…" for as long as the summarization runs.
                self.state.activity = status.clone();
                out.push(SessionEvent::State(self.state.clone()));
                if let Some(pm) = permission_mode {
                    self.announce_permission(pm, out);
                }
                // A compaction that FAILED says so only here — no boundary follows. Without
                // this the "compacting" line just vanished and the context stayed full.
                if compact_result.as_ref().and_then(Value::as_str) == Some("failed") {
                    out.push(SessionEvent::Item(compact_failed_notice(compact_error.as_ref())));
                }
            }
            SystemMsg::TaskStarted(t) => self.ingest_task_started(t, out),
            SystemMsg::TaskProgress(t) => self.ingest_task_progress(t, out),
            SystemMsg::TaskUpdated(t) => self.ingest_task_updated(t, out),
            SystemMsg::TaskNotification(t) => self.ingest_task_notification(t, out),
            SystemMsg::BackgroundTasksChanged { tasks } => match tasks {
                Some(tasks) => self.ingest_background_level(tasks, out),
                None => eprintln!("[assembler] background_tasks_changed without a task list; ignored"),
            },
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
            // The CLI pushed a fresh slash-command catalogue mid-session (plugin
            // toggled / installed / hot-reloaded). Forward it so the `/` menu follows
            // a command set that changed under a live session, instead of waiting for
            // the next spawn or an explicit refetch.
            SystemMsg::CommandsChanged { commands } => {
                if let Some(raw) = commands {
                    out.push(SessionEvent::Commands(control::slash_commands_from_array(
                        raw,
                    )));
                }
            }
            // Routine traffic we deliberately don't render (see the variant docs in
            // protocol.rs). Listed explicitly so the drift canary below stays meaningful.
            // The CLI is retrying the turn's API call after a connection failure. It
            // recovers by itself, but without surfacing this the turn just appears to
            // hang. Cleared as soon as anything else arrives (see `clear_retry`).
            SystemMsg::ApiError {
                error,
                retry_attempt,
                max_retries,
            } => {
                self.state.retry = Some(RetryState {
                    attempt: *retry_attempt,
                    max: *max_retries,
                    reason: error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(|m| m.trim().to_string())
                        .filter(|m| !m.is_empty()),
                });
                out.push(SessionEvent::State(self.state.clone()));
            }
            // The conversation was compacted: a separator in the thread, and the context
            // ring drops to the compacted size at once. (A manual `/compact` ends on a
            // model-call-free `result` that must not then zero it — see `ingest_result`.)
            SystemMsg::CompactBoundary { compact_metadata } => {
                let info = CompactInfo::from_wire(compact_metadata);
                if let Some(post) = info.post_tokens {
                    self.state.context_tokens = Some(post);
                    // The last call's breakdown described the PRE-compaction prompt; it no
                    // longer sums to the fill. Unknown until the next model call.
                    self.state.context_usage = None;
                    out.push(SessionEvent::State(self.state.clone()));
                }
                out.push(SessionEvent::Item(info.into_notice()));
            }
            SystemMsg::LocalCommand
            | SystemMsg::StopHookSummary
            | SystemMsg::TurnDuration
            | SystemMsg::Informational
            | SystemMsg::ThinkingTokens
            | SystemMsg::ModelRefusalFallback
            | SystemMsg::ElicitationComplete => {}
            // A `system` subtype we do not model AT ALL — like the top-level `Unknown`
            // arm, almost always CLI protocol drift after a binary upgrade. We can't
            // render it (we don't know its shape), but it must not vanish without a
            // trace. Because every routine subtype is matched above, this line firing
            // actually means something.
            SystemMsg::Unknown => {
                eprintln!(
                    "[assembler] dropping an unmodeled system subtype (CLI protocol drift after an upgrade?)"
                );
            }
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
        // A sub-agent started by a `SendMessage` is a WAKE of an existing agent (its
        // task_id is that agent's id), not a launch — see `send_message_ids`.
        let wake = kind == BackgroundTaskKind::Agent && self.is_send_message(t.tool_use_id.as_deref());
        // A COLD wake (this process never saw the launch) would key the task on the
        // SendMessage's id, while the woken agent's own messages stream under its LAUNCH
        // id: re-key it onto the launch, so its model, its live drill-in and the front's
        // `bgAgentIds` all line up as on a warm wake.
        let launch = if wake && !self.background_tasks.contains_key(&t.task_id) {
            self.resolve_launch(&t.task_id)
        } else {
            None
        };
        self.link_tool_use(launch.as_deref(), &t.task_id);
        // The label is the NAME the agent gave the task (`description`, e.g. "build the
        // app") — the meaningful pinned line. The raw command lives in its own field; the
        // command and the output path arrive on their own schedule (assistant message /
        // tool_result) and `record_tool` / `set_task_output_file` backfill them later.
        let label = t.description.clone();
        let ambient = t.ambient == Some(true) || t.skip_transcript == Some(true);
        // A nested sub-agent carries no `owned_by_subagent` (the CLI sets it on `local_bash`
        // only) — its depth says it.
        let owned_by_subagent = t.owned_by_subagent == Some(true) || t.spawn_depth.is_some_and(|d| d > 1);
        // A background command's clock starts now (see `arm_deadline`).
        let time_limit = self.bash_time_limit(t.tool_use_id.as_deref());
        let now = self.now_ms();
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
                tool_use_id: launch.clone().or_else(|| t.tool_use_id.clone()),
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
                woken_by: None,
                backgrounded: t.is_backgrounded,
                ambient,
                owned_by_subagent,
                time_limit_ms: None,
                deadline_at_ms: None,
                stop_cause: None,
            });
        // A `task_started` for a sub-agent we hold as FINISHED is the CLI running it again
        // (a wake re-uses the task_id). Unlike the inferred revivals (the SendMessage result
        // of an old binary, the progress backstop), this is the wire's own word, so it
        // revives a Stopped or Failed agent too — the user's Stop already took effect; this
        // is a NEW run.
        if task.kind == BackgroundTaskKind::Agent && task.status != BackgroundTaskStatus::Running {
            restart_agent_run(task);
        }
        // Cold or warm, a main-thread wake marks the run as detached background work: a
        // woken agent is never awaited by its caller, whatever its launch was. Cold and
        // un-re-keyed, the entry carries the SendMessage's tool_use_id, which the front's
        // `bgAgentIds` never holds — without this mark the woken agent read as FOREGROUND
        // and the AgentBar hid it.
        if let (true, Some(send)) = (wake, t.tool_use_id.as_deref()) {
            mark_woken(task, send);
        }
        // The start's own word on these wins over a lazy entry's defaults (and a wake's
        // fresh `task_started` re-registers the agent in the background).
        if t.is_backgrounded.is_some() {
            task.backgrounded = t.is_backgrounded;
        }
        task.ambient |= ambient;
        task.owned_by_subagent |= owned_by_subagent;
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
        // Launched in the background (`run_in_background`): the CLI's time limit runs
        // from here. A foreground command (`is_backgrounded:false`) is armed only if it
        // is later moved there (`ingest_task_updated`).
        if task.backgrounded != Some(false) && task.deadline_at_ms.is_none() {
            arm_deadline(task, time_limit, now);
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A live progress tick. Stash the latest `description` (a `Workflow` emits
    /// `"<phase>: <label>"`) and re-emit. Tolerates a tick for an unseen task.
    fn ingest_task_progress(&mut self, t: &TaskProgressMsg, out: &mut Vec<SessionEvent>) {
        let main_wake = t
            .tool_use_id
            .clone()
            .filter(|id| self.is_send_message(Some(id)));
        let task = self.task_entry(&t.task_id, t.tool_use_id.as_deref());
        // A progress tick on a COMPLETED sub-agent means a resumed agent came back to life.
        // Since CLI 2.1.283 a wake emits its own `task_started` (which revives the task
        // first), so this is a backstop: for an older binary that did not and whose
        // SendMessage result has not landed yet, and for a resume whose `task_started` we
        // missed. The new run counts as a conversation-level wake (`woken_by`) only when the
        // tick names a MAIN-THREAD SendMessage: a bare tick can't say which thread woke the
        // agent (a sub-agent may wake its own). The helper resets stale roll-up (incl.
        // `progress`), so set THIS tick's description AFTER it, or the fresh label would be
        // wiped.
        if reactivate_completed_agent(task) {
            if let Some(send) = main_wake.as_deref() {
                mark_woken(task, send);
            }
        }
        if t.description.is_some() {
            task.progress = t.description.clone();
        }
        out.push(SessionEvent::Task(task.clone()));
    }

    /// A state patch (the terminal transition for Bash/Monitor/Agent). Map the patch
    /// status onto our coarse status and re-emit.
    fn ingest_task_updated(&mut self, t: &TaskUpdatedMsg, out: &mut Vec<SessionEvent>) {
        // Read before `task_entry` borrows the registry: the limit of a command about to
        // be moved to the background.
        let spawned_by = self.background_tasks.get(&t.task_id).and_then(|task| task.tool_use_id.clone());
        let time_limit = self.bash_time_limit(spawned_by.as_deref());
        let now = self.now_ms();
        let task = self.task_entry(&t.task_id, None);
        if let Some(status) = t.patch.as_ref().and_then(|p| p.status.as_deref()) {
            task.status = map_status(status);
        }
        // A foreground task moved to the background mid-run: from now on it IS background
        // work (the CLI also adds it to the level) — and, for a command, the CLI's time
        // limit starts running from this move.
        if let Some(backgrounded) = t.patch.as_ref().and_then(|p| p.is_backgrounded) {
            let moved = backgrounded && task.backgrounded != Some(true);
            task.backgrounded = Some(backgrounded);
            if moved && task.status == BackgroundTaskStatus::Running {
                arm_deadline(task, time_limit, now);
            }
        }
        let settled = task.status != BackgroundTaskStatus::Running;
        out.push(SessionEvent::Task(task.clone()));
        if settled {
            self.pending_retire.remove(&t.task_id);
        }
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
        if task.status == BackgroundTaskStatus::Stopped {
            if let Some(cause) = stop_cause(t.reason.as_deref(), t.summary.as_deref()) {
                task.stop_cause = Some(cause);
            }
        }
        if t.ambient == Some(true) || t.skip_transcript == Some(true) {
            task.ambient = true;
        }
        // Fill output_file from the notification only if we don't ALREADY have one. For a
        // Bash/Monitor the start tool_result already captured the live-tailable TEMP path
        // (`set_task_output_file`) — the notification must not clobber it. An Agent had
        // none set earlier (no marker), so this is where its transcript path lands (and
        // the agent_id extraction below depends on it). A foreground `Bash` ends on
        // `output_file:""` (verified live, 2.1.286): no file, not an empty path to read.
        if task.output_file.is_none() {
            task.output_file = t.output_file.clone().filter(|p| !p.is_empty());
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
        // `output_file`. Surface it (for a drill-down to call `load_subagent_transcript`
        // without re-parsing). The legacy `subagents/agent-<agentId>.jsonl` shape is
        // unambiguous, so it also upgrades a never-classified Other → Agent. Since 2.1.28x
        // the path is the temp `tasks/<agentId>.output` (a symlink to that transcript) —
        // the SAME shape as a Bash/Monitor output, so it only names an agent for a task
        // already known to be one.
        if task.agent_id.is_none() {
            if let Some(path) = task.output_file.as_deref() {
                if let Some(id) = agent_id_from_output_file(path) {
                    task.agent_id = Some(id);
                    if task.kind == BackgroundTaskKind::Other {
                        task.kind = BackgroundTaskKind::Agent;
                    }
                } else if task.kind == BackgroundTaskKind::Agent {
                    task.agent_id = task_id_from_output_file(path);
                }
            }
        }
        out.push(SessionEvent::Task(task.clone()));
        self.pending_retire.remove(&t.task_id);
    }

    /// `system/background_tasks_changed`: the full set of live background tasks. Two uses,
    /// both kept off the `task_*` edges' toes (the CLI warns not to correlate the two):
    ///  - an entry's `ambient` flag is re-announced here, and can FLIP mid-run;
    ///  - a task that LEFT the set is no longer running. It is NOT settled here: its own
    ///    edges follow right behind with the real status, so it is only parked in
    ///    `pending_retire` — see [`Self::retire_orphaned_tasks`] for one whose edge never
    ///    comes (the "stale running indicator" the level exists to cure).
    /// Membership is never ADDED from here: a task enters the registry through its
    /// `task_started`, which carries what the level lacks (tool_use_id, kind…).
    fn ingest_background_level(&mut self, entries: &[LiveTaskEntry], out: &mut Vec<SessionEvent>) {
        let level: HashSet<String> = entries.iter().map(|e| e.task_id.clone()).collect();
        for entry in entries {
            if let Some(task) = self.background_tasks.get_mut(&entry.task_id) {
                // The CLI omits the flag when false (`...isAmbient && {ambient:true}`).
                let ambient = entry.ambient == Some(true);
                if task.ambient != ambient {
                    task.ambient = ambient;
                    out.push(SessionEvent::Task(task.clone()));
                }
            }
        }
        for id in self.live_level.difference(&level) {
            if self
                .background_tasks
                .get(id)
                .is_some_and(|t| t.status == BackgroundTaskStatus::Running)
            {
                self.pending_retire.insert(id.clone());
            }
        }
        // Back in the set (a woken agent): live again, nothing to retire.
        self.pending_retire.retain(|id| !level.contains(id));
        self.live_level = level;
    }

    /// Settle the tasks that left the level and whose own edge never followed: an
    /// unrelated line arrived, and the CLI writes a transition's level and its edges back
    /// to back — so it is not coming. Marked `Stopped` (an end we could not observe, like
    /// a session ending under a running task) rather than left `Running`, which would keep
    /// the conversation green with no "done" notification. Logged: it should be rare.
    fn retire_orphaned_tasks(&mut self, out: &mut Vec<SessionEvent>) {
        for id in std::mem::take(&mut self.pending_retire) {
            if let Some(task) = self.background_tasks.get_mut(&id) {
                if task.status == BackgroundTaskStatus::Running {
                    eprintln!(
                        "[assembler] background task {id} left the live set with no task_* end event; marking it stopped"
                    );
                    task.status = BackgroundTaskStatus::Stopped;
                    out.push(SessionEvent::Task(task.clone()));
                }
            }
        }
    }

    /// Remember a `SendMessage` tool_use's target until its result lands (see
    /// `send_message_targets`). Re-recording the same id is harmless (stream + assembled).
    /// Only a target FINISHED at send time can be woken by it: a SendMessage to a running
    /// agent merely queues a message ("Message queued for delivery…"), starting no run.
    fn note_send_message(&mut self, id: &str, input: &Value, main_thread: bool) {
        if id.is_empty() {
            return;
        }
        if main_thread {
            self.send_message_ids.insert(id.to_string());
        }
        if let Some(to) = input.get("to").and_then(Value::as_str) {
            let finished = self.background_tasks.get(to).is_some_and(|t| {
                t.kind == BackgroundTaskKind::Agent && t.status == BackgroundTaskStatus::Completed
            });
            if finished {
                self.send_message_targets.insert(id.to_string(), (to.to_string(), main_thread));
            }
        }
    }

    /// A `SendMessage`'s tool_result: the wake signal of a pre-2.1.283 binary, which emits no
    /// `task_started` for it. A SUCCESSFUL result whose `to` named a sub-agent FINISHED at
    /// send time means that agent RESUMED: the wire's `to` IS the agentId, which IS the
    /// task_id, so the lookup is exact. Revived via [`reactivate_completed_agent`] — the
    /// ORIGINAL `Agent` `tool_use_id` kept, the prior run's roll-up reset — and marked woken
    /// only for a MAIN-THREAD sender: a sub-agent waking its own agent keeps it out of the
    /// conversation-level surfaces, like its launch was.
    ///
    /// Not inferred when the wire already spoke for this SendMessage (any task event under
    /// its id): it then reported the run itself — 2.1.283+ always does, with a `task_started`
    /// BEFORE this result — and the run may even be over already (a BLOCKING resume — e.g.
    /// background tasks disabled — answers only once the woken run ended): reviving here
    /// would leave a finished agent Running for good. A FAILED result (interrupted, refused,
    /// `success:false`) woke nothing.
    fn wake_on_send_message_result(&mut self, tool_use_id: &str, content: &Value, is_error: bool, out: &mut Vec<SessionEvent>) {
        let Some((target, main_thread)) = self.send_message_targets.remove(tool_use_id) else {
            return;
        };
        if is_error || send_message_reports_failure(content) || self.tasks_by_tool_use.contains_key(tool_use_id) {
            return;
        }
        if let Some(task) = self.background_tasks.get_mut(&target) {
            if reactivate_completed_agent(task) {
                if main_thread {
                    mark_woken(task, tool_use_id);
                }
                out.push(SessionEvent::Task(task.clone()));
            }
        }
    }

    /// The `Agent` tool_use that launched sub-agent `agent_id`, looked up on disk (see
    /// `launch_resolver`). `None` without a resolver or a known session id, or when the
    /// sidecar has no answer — logged, since the woken agent then stays keyed on the
    /// SendMessage id (no model, live drill-in only through the front's fallback).
    fn resolve_launch(&self, agent_id: &str) -> Option<String> {
        let resolver = self.launch_resolver?;
        let launch = self
            .state
            .session_id
            .as_deref()
            .and_then(|session| resolver(session, agent_id));
        if launch.is_none() {
            eprintln!(
                "[assembler] woken sub-agent {agent_id}: launching Agent not found on disk; keeping the SendMessage id"
            );
        }
        launch
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
        // Seen for the first time under a `SendMessage` id: the only task a SendMessage
        // produces is a woken sub-agent, whose `task_started` we missed — re-keyed onto its
        // launch like a cold wake's (see `ingest_task_started`).
        let wake = self.is_send_message(tool_use_id);
        let launch = if wake && !self.background_tasks.contains_key(task_id) {
            self.resolve_launch(task_id)
        } else {
            None
        };
        self.link_tool_use(launch.as_deref(), task_id);
        let task = self
            .background_tasks
            .entry(task_id.to_string())
            .or_insert_with(|| BackgroundTask {
                task_id: task_id.to_string(),
                kind: if wake {
                    BackgroundTaskKind::Agent
                } else {
                    classify_task(None, tool_name.as_deref())
                },
                tool_use_id: launch.or_else(|| tool_use_id.map(str::to_string)),
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
                woken_by: None,
                // Unknown until an event says otherwise (see the field docs).
                backgrounded: None,
                ambient: false,
                owned_by_subagent: false,
                // Joined mid-run: when it entered the background is unknown, so no
                // deadline is guessed for it.
                time_limit_ms: None,
                deadline_at_ms: None,
                stop_cause: None,
            });
        if let (true, true, Some(send)) = (wake, task.kind == BackgroundTaskKind::Agent, tool_use_id) {
            mark_woken(task, send);
        }
        task
    }

    /// Is `tool_use_id` a main-thread `SendMessage` tool_use (see `send_message_ids`)?
    fn is_send_message(&self, tool_use_id: Option<&str>) -> bool {
        tool_use_id.is_some_and(|id| self.send_message_ids.contains(id))
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
                    let usage = event.get("message").and_then(|m| m.get("usage"));
                    if let Some(used) = usage.and_then(context_used_from_usage) {
                        if self.state.context_tokens != Some(used) {
                            self.state.context_tokens = Some(used);
                            state_changed = true;
                        }
                    }
                    // Its breakdown, from the SAME object (so the two never disagree). The
                    // output is only a stub here; the call's `message_delta` completes it.
                    if let Some(breakdown) = usage.and_then(token_usage_from) {
                        if self.state.context_usage != Some(breakdown) {
                            self.state.context_usage = Some(breakdown);
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
                        // Same reason: a SendMessage is known before its wake's
                        // `task_started` can land (its `to` comes with the assembled message).
                        if name == "SendMessage" {
                            let input = cb.get("input").unwrap_or(&Value::Null);
                            self.note_send_message(id, input, se.parent_tool_use_id.is_none());
                        }
                        // Input is empty at content_block_start (it streams later); the
                        // command is captured from the assembled assistant message.
                        self.record_tool(id, name, cb.get("input"), out);
                    }
                }
            }
            // A root call's `message_delta` carries its final `output_tokens` — the one figure
            // of its usage that `message_start` could not know yet. One per model call, so this
            // is one state event per call, not per token.
            "message_delta" if se.parent_tool_use_id.is_none() => {
                let output = event
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(Value::as_u64);
                if let (Some(output), Some(usage)) = (output, self.state.context_usage.as_mut()) {
                    if usage.output != output {
                        usage.output = output;
                        out.push(SessionEvent::State(self.state.clone()));
                    }
                }
            }
            // content_block_stop, message_stop, and a sub-agent's message_delta carry nothing
            // we surface yet.
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
            // Same assembled input as the command: the `timeout` that sets a background
            // launch's time limit.
            entry.background_timeout_ms = input.and_then(background_timeout_ms);
        }
        let time_limit = self.bash_time_limit(Some(id));
        let now = self.now_ms();

        // Reconcile an already-tracked task spawned by this tool_use:
        //  - re-classify if the (now-known) name changes its kind (ambiguous
        //    `local_bash` → Bash fallback, or `Other`) — the name is authoritative;
        //  - backfill a `Bash`'s raw command (a SEPARATE field from the `label` name) so
        //    the output popover can show `$ command` alongside the name;
        //  - settle its time limit on what the input asked for (see `reconcile_deadline`).
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
            changed |= reconcile_deadline(task, time_limit, now);
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
                // A `SendMessage` may WAKE a finished sub-agent: remember its target; the
                // wake itself is confirmed by the wire (its `task_started`, or the
                // SendMessage's successful result — see `wake_on_send_message_result`).
                if name == "SendMessage" {
                    self.note_send_message(id, input, a.parent_tool_use_id.is_none());
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
                    // seeded the task, or a cold wake we could not re-key) silently loses it.
                    // That must never be silent — log it (same policy as the rest of this
                    // module), ONCE per parent: such an agent streams dozens of messages.
                    None => {
                        if self.uncorrelated_model_parents.insert(parent.to_string()) {
                            eprintln!(
                                "[assembler] sub-agent model {model:?} not correlated: no background task with tool_use_id {parent:?}"
                            );
                        }
                    }
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
                            let is_error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                            // A SendMessage's result: on success, its target sub-agent resumed.
                            self.wake_on_send_message_result(&tool_use_id, &content, is_error, out);
                            out.push(SessionEvent::Item(ConversationItem::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
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
            // A sub-agent's final report (its `SubagentHandback` call): injected like any CLI
            // line, but the one the thread shows — same structural gate as the reload
            // (`history::is_handback_origin`). Appended in place (`replay:false`): the CLI
            // emits it at its injection point, while the replay splice would hoist a mid-turn
            // report above the whole response it landed in. `busy` is what tells the two
            // deliveries apart (VERIFIED live 2.1.293): mid-turn it arrives after the turn's
            // first `message_start`; a report that opens a turn of its own arrives right after
            // that turn's `system/init`, before any model output.
            if injected
                && u.parent_tool_use_id.is_none()
                && super::history::is_handback_origin(u.origin.as_ref())
            {
                if !text.trim().is_empty() {
                    out.push(SessionEvent::Item(ConversationItem::UserMessage {
                        id: uuid,
                        text,
                        parent_tool_use_id: None,
                        replay: false,
                        mid_turn: self.state.busy,
                    }));
                }
                return;
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
                        if subtype == "interrupted" {
                            self.interrupt_marker_seen = true;
                        }
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
                            mid_turn: false,
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
        let interrupted = is_user_interrupt(r, std::mem::take(&mut self.interrupt_marker_seen));
        // Authoritative end-of-turn context fill + window size. A multi-call turn's
        // top-level `usage` can aggregate its `iterations[]`, so prefer the LAST
        // iteration — the final model call's prompt = current context occupancy.
        let final_usage = r
            .usage
            .get("iterations")
            .and_then(Value::as_array)
            .and_then(|it| it.last())
            .unwrap_or(&r.usage);
        // A turn that made NO model call (a local slash command: `/compact`, `/model`, …)
        // ends on an all-zero usage. That is "nothing measured", not an empty context: it
        // must keep the last known fill — after `/compact`, the boundary's compacted size.
        if let Some(used) = context_used_from_usage(final_usage).filter(|&used| used > 0) {
            self.state.context_tokens = Some(used);
            if let Some(breakdown) = token_usage_from(final_usage) {
                self.state.context_usage = Some(breakdown);
            }
        }
        // Authoritative window for THIS session's model (distinguishes 200k vs 1M).
        // Only updates when the result reports the session model's own entry — a
        // sub-agent-only turn returns None and keeps the last known window.
        if let Some(window) =
            context_window_from_model_usage(&r.model_usage, self.state.model.as_deref())
        {
            self.state.context_window = Some(window);
        }
        // What the whole session has consumed, every agent included: the CLI's cumulative
        // `modelUsage` snapshot, REPLACED (never summed, never max'd — a `/clear` legitimately
        // lowers it). A result without one (an absent/empty map) keeps the last known value
        // rather than reading as "nothing spent". Rides the State event pushed just below.
        if let Some(usage) = session_usage_from_model_usage(&r.model_usage, r.total_cost_usd) {
            self.state.session_usage = Some(usage);
        }
        out.push(SessionEvent::Item(ConversationItem::TurnResult {
            // A turn the user stopped is not a failure: the `[Request interrupted by user]`
            // notice already says what happened, so the UI must neither draw an error box
            // nor settle the conversation into error / review (`interrupted` = seen).
            subtype: if interrupted { "interrupted".to_string() } else { r.subtype.clone() },
            is_error: r.is_error && !interrupted,
            result: r.result.clone(),
            // Present on the wire (often null); surface it only when it's a real string
            // so an errored turn can show a typed "API error: <status>" heading.
            api_error_status: r.api_error_status.as_str().map(str::to_string),
            total_cost_usd: r.total_cost_usd,
            num_turns: r.num_turns,
            duration_ms: r.duration_ms,
            duration_api_ms: self.turn_api_ms(r.duration_api_ms),
            ttft_ms: r.ttft_ms,
            // The TOP-LEVEL usage: the turn's aggregate over all its calls — what it consumed —
            // where the context reading above takes the LAST call's.
            usage: token_usage_from(&r.usage),
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

/// The id in a temp task output path (`…/tasks/<id>.output` → `<id>`). For a sub-agent
/// that id IS its agentId (the CLI keys a `local_agent` task by it, verified live on
/// 2.1.286) — but every Bash/Monitor output has the same shape, so the caller decides.
fn task_id_from_output_file(path: &str) -> Option<String> {
    let mut segments = path.rsplit('/');
    let id = segments.next()?.strip_suffix(".output")?;
    (segments.next() == Some("tasks") && !id.is_empty()).then(|| id.to_string())
}

/// A `task_*` edge or a `background_tasks_changed` level. The CLI enqueues a transition's
/// level and its edges back to back, so any OTHER line means those edges are all in.
fn is_task_lifecycle(msg: &CliMessage) -> bool {
    matches!(
        msg,
        CliMessage::System(
            SystemMsg::TaskStarted(_)
                | SystemMsg::TaskProgress(_)
                | SystemMsg::TaskUpdated(_)
                | SystemMsg::TaskNotification(_)
                | SystemMsg::BackgroundTasksChanged { .. }
        )
    )
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

/// Re-activate a background sub-agent task we'd already marked terminal, on an INFERRED
/// wake: the successful result of a `SendMessage` to it (a pre-2.1.283 binary's only wake
/// signal) or a progress tick after its finish. A sub-agent RESUMED via `SendMessage` re-uses
/// its task_id (== its agentId); the running-gated AgentBar / FlightDeck would never
/// re-surface it unless the socle flips it back to Running. (The wake's own `task_started`,
/// 2.1.283+, revives it first — see [`Assembler::ingest_task_started`].)
///
/// SCOPED to a naturally-FINISHED (`Completed`) sub-agent (`kind == Agent`): an inference
/// does NOT revive a `Stopped` task (a user's Stop must win, absent a real new
/// `task_started`) nor a `Failed` one, and never touches a Bash/Monitor/Workflow task (whose
/// ids can't be a `SendMessage` target anyway). This keeps a Stop from silently un-doing
/// itself and avoids resurrecting a task the CLI won't actually re-run (which, lacking a
/// fresh terminal event, would linger Running until the whole session ends).
///
/// Returns whether it flipped (so the caller re-emits the task).
fn reactivate_completed_agent(task: &mut BackgroundTask) -> bool {
    if task.kind != BackgroundTaskKind::Agent || task.status != BackgroundTaskStatus::Completed {
        return false;
    }
    restart_agent_run(task);
    true
}

/// Start a NEW run of a sub-agent task: back to Running, the previous run's usage roll-up
/// (tokens / tool_uses / duration_ms / summary / progress) cleared so the re-running row
/// shows live-blank stats, not the last run's numbers. Whether the run counts as a WAKE the
/// conversation should surface is the caller's call ([`mark_woken`]): only a main-thread
/// `SendMessage` proves that.
fn restart_agent_run(task: &mut BackgroundTask) {
    task.status = BackgroundTaskStatus::Running;
    task.tokens = None;
    task.tool_uses = None;
    task.duration_ms = None;
    task.summary = None;
    task.progress = None;
    // Per RUN: a past main-thread wake says nothing about this one (a sub-agent may be the
    // one waking it now).
    task.woken_by = None;
}

/// Does a `SendMessage` tool_result report a failure in its body? Since 2.1.283 the result
/// is JSON (`{"success":true,"message":"Resuming agent …",…}`), a plain string or a list of
/// text blocks; only an explicit `"success": false` counts — anything else (prose from an
/// older binary, unparseable text) is not evidence of failure.
fn send_message_reports_failure(content: &Value) -> bool {
    let failed = |text: &str| {
        serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("success").and_then(Value::as_bool))
            == Some(false)
    };
    match content {
        Value::String(s) => failed(s),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .any(failed),
        _ => false,
    }
}

/// Record that main-thread SendMessage `send_message_id` started the current run (see
/// [`BackgroundTask::woken_by`]) and fill the sub-agent's `agent_id`: its task_id IS its
/// agentId, so the drill-in can read its transcript even when `tool_use_id` names the waking
/// `SendMessage` (whose result carries no launch ack).
fn mark_woken(task: &mut BackgroundTask, send_message_id: &str) {
    task.woken_by = Some(send_message_id.to_string());
    // The CLI registers a resumed sub-agent in the background (its `task_started` says
    // `is_backgrounded:true`); said here too, so a revival inferred without that line never
    // leaves a foreground launch's `Some(false)` hiding the woken run from the counts.
    task.backgrounded = Some(true);
    if task.agent_id.is_none() {
        task.agent_id = Some(task.task_id.clone());
    }
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

/// Start the clock on a background `Bash` command: from `now`, the CLI stops it after
/// `time_limit` ms (see [`super::bash_limits`]). No-op for any other kind, for a CLI
/// without a limit (`None`), and once armed — the clock starts at the background edge
/// and only [`reconcile_deadline`] moves it after that.
fn arm_deadline(task: &mut BackgroundTask, time_limit: Option<u64>, now: u64) {
    if task.kind != BackgroundTaskKind::Bash || task.deadline_at_ms.is_some() {
        return;
    }
    if let Some(limit) = time_limit {
        task.time_limit_ms = Some(limit);
        task.deadline_at_ms = Some(now.saturating_add(limit));
    }
}

/// Bring a tracked task's deadline in line with what its tool_use turned out to be. Its
/// name and input can land AFTER `task_started` (see [`Assembler::record_tool`]): a task
/// re-classified as a Monitor drops the limit it never had; a running background `Bash`
/// not armed yet is armed now (its real start was a moment earlier); one armed on the
/// default whose input asked for its own `timeout` keeps its start and moves its end.
/// Returns whether anything changed.
fn reconcile_deadline(task: &mut BackgroundTask, time_limit: Option<u64>, now: u64) -> bool {
    if task.kind != BackgroundTaskKind::Bash {
        let had = task.time_limit_ms.is_some() || task.deadline_at_ms.is_some();
        task.time_limit_ms = None;
        task.deadline_at_ms = None;
        return had;
    }
    if task.status != BackgroundTaskStatus::Running || task.backgrounded == Some(false) {
        return false;
    }
    match (task.deadline_at_ms, task.time_limit_ms, time_limit) {
        (None, _, Some(_)) => {
            arm_deadline(task, time_limit, now);
            true
        }
        (Some(at), Some(old), Some(new)) if old != new => {
            task.deadline_at_ms = Some(at.saturating_sub(old).saturating_add(new));
            task.time_limit_ms = Some(new);
            true
        }
        _ => false,
    }
}

/// The `timeout` (ms) of a `Bash` input launched with `run_in_background` — the one case
/// it sets the command's background time limit. `None` for a foreground launch or no
/// usable timeout.
fn background_timeout_ms(input: &Value) -> Option<u64> {
    if input.get("run_in_background").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let timeout = input.get("timeout")?;
    timeout
        .as_u64()
        .or_else(|| timeout.as_f64().filter(|ms| ms.is_finite() && *ms > 0.0).map(|ms| ms as u64))
        .filter(|&ms| ms > 0)
}

/// Why the CLI stopped a task on its own, from its `task_notification`. Only
/// `worker_restart` has a machine-readable `reason`; the time limit and memory pressure
/// are named in the summary alone, which ends — after the command's own description —
/// with a fixed phrase (2.1.293's `$Q` table). Matched on the END so a description that
/// happens to contain the phrase cannot fake it.
fn stop_cause(reason: Option<&str>, summary: Option<&str>) -> Option<BackgroundStopCause> {
    if reason == Some("worker_restart") {
        return Some(BackgroundStopCause::WorkerRestart);
    }
    let summary = summary?.trim_end();
    if summary.ends_with(" was stopped after reaching its background time limit") {
        Some(BackgroundStopCause::Deadline)
    } else if summary.ends_with(" was stopped because the system is running low on memory") {
        Some(BackgroundStopCause::MemoryPressure)
    } else {
        None
    }
}

/// Friendly label for a model id (alias OR resolved id) — matches the composer's
/// catalogue (`CLAUDE_MODELS`, front).
///
/// A family alias names the NEWEST model of its family, so it must read exactly like the
/// resolved id it stands for: the change notice compares labels, and a seed of `opus`
/// read back as `claude-opus-5-5[1m]` is a confirmation, not a model switch.
/// ⚠️ Keep the alias arms in step with the `modelId` of the front's alias rows — the CLI
/// moves an alias on each release (`opus` went Opus 5 → Opus 5.5 in 2.1.280, `sonnet`
/// Sonnet 5 → Sonnet 5.5 in 2.1.284).
///
/// Every other id is read off its own name (`claude-<family>-<major>[-<minor>]`, or the
/// older `claude-<major>-<minor>-<family>`), so a pinned version can never be mistaken
/// for the family's newest — the bug a `contains("opus")` ladder kept reintroducing.
fn model_label(id: &str) -> String {
    let s = id.to_lowercase();
    match s.as_str() {
        "opus" => return "Opus 5.5".to_string(),
        "sonnet" => return "Sonnet 5.5".to_string(),
        "haiku" => return "Haiku 4.5".to_string(),
        "fable" => return "Fable 5.1".to_string(),
        _ => {}
    }
    parse_model_label(&s).unwrap_or_else(|| id.to_string())
}

/// `claude-opus-4-8[1m]` → "Opus 4.8", `claude-3-5-sonnet-20241022` → "Sonnet 3.5",
/// `us.anthropic.claude-opus-4-6-v1` → "Opus 4.6". `None` for anything else.
fn parse_model_label(s: &str) -> Option<String> {
    const FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];
    let from = s.find("claude-")?;
    // Drop the context suffix (`[1m]`) and provider tails (`@20250805`, `:0`).
    let name = s[from..].split(['[', '@', ':']).next()?;
    let mut family = None;
    let mut version: Vec<&str> = Vec::new();
    for part in name.split('-').skip(1) {
        if FAMILIES.contains(&part) {
            family = Some(part);
        } else if part.len() <= 2 && part.chars().all(|c| c.is_ascii_digit()) {
            // Version digits only — an 8-digit date stamp or a `v1` tail is not one.
            version.push(part);
        }
    }
    let family = family?;
    if version.last() == Some(&"0") && version.len() > 1 {
        version.pop(); // `claude-opus-4-0` is "Opus 4"
    }
    if version.is_empty() {
        return None;
    }
    let mut label = family[..1].to_uppercase();
    label.push_str(&family[1..]);
    Some(format!("{label} {}", version.join(".")))
}

/// Friendly effort label. Ultracode is NOT folded in — it is its own control (see
/// [`Assembler::announce_ultracode`]). `Option` so callers chain it on an effort that
/// may not be known yet (never announce a phantom transition).
fn effort_label(effort: &str) -> Option<String> {
    // ⚠️ Must mirror the front's EFFORT_LABELS (`src/agent/subagentMeta.ts`) verbatim:
    // this label lands in the in-thread "Thinking effort: X → Y" notice, right under
    // the composer chip that renders the SAME value from the front's table. Any drift
    // makes the two disagree about one setting (they did: "Extra high" vs "Extra", and
    // `max` fell through raw as "max" next to a chip reading "Max").
    Some(
        match effort {
            "low" => "Low",
            "medium" => "Medium",
            "high" => "High",
            "xhigh" => "Extra",
            "max" => "Max",
            "ultra" => "Ultra",
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
        "bypassPermissions" => "Bypass permissions",
        // NOT bypass: the CLI's "don't ask" DENIES whatever isn't pre-approved.
        "dontAsk" => "Don't ask",
        other => other,
    }
    .to_string()
}

/// The error notice for a compaction that failed (`system/status` with
/// `compact_result:"failed"`). The CLI's reason (`compact_error`) is the message when it sent
/// one — it may not: the binary withholds it in some modes — else a generic line, so the
/// failure is never silent either way.
fn compact_failed_notice(compact_error: Option<&Value>) -> ConversationItem {
    let reason = match compact_error {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    ConversationItem::Notice {
        subtype: "compact_failed".to_string(),
        detail: serde_json::json!({
            "message": if reason.is_empty() {
                "Claude Code couldn't compact the conversation.".to_string()
            } else {
                reason
            },
        }),
    }
}

/// Did this `result` close a turn the user stopped (the composer's Stop, a remote
/// interrupt, a deny-and-stop)? The CLI reports a stopped turn as a FAILURE —
/// `subtype:"error_during_execution"`, `is_error:true` — so it would read as a crash.
/// Primary signal: `terminal_reason` `aborted_streaming` / `aborted_tools` (the CLI's
/// abort-controller exits; verified live, claude 2.1.293). Fallback for a binary without
/// that field: an errored result right after this turn's `[Request interrupted by user…]`
/// marker line, which the CLI writes before the `result`.
fn is_user_interrupt(r: &ResultMsg, marker_seen: bool) -> bool {
    matches!(r.terminal_reason.as_deref(), Some("aborted_streaming" | "aborted_tools"))
        || (marker_seen && r.is_error && r.subtype == "error_during_execution")
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

/// The four token counts of a `usage` object, broken down (see [`TokenUsage`]). `None` when
/// it carries none of them — an empty/`null` usage must not zero a known breakdown, exactly as
/// [`context_used_from_usage`] refuses to zero a known fill. Its prompt part always sums to
/// what that function returns for the same object.
pub(crate) fn token_usage_from(usage: &Value) -> Option<TokenUsage> {
    let field = |k: &str| usage.get(k).and_then(Value::as_u64);
    let input = field("input_tokens");
    let cache_creation = field("cache_creation_input_tokens");
    let cache_read = field("cache_read_input_tokens");
    let output = field("output_tokens");
    if input.is_none() && cache_creation.is_none() && cache_read.is_none() && output.is_none() {
        return None;
    }
    Some(TokenUsage {
        input: input.unwrap_or(0),
        cache_creation: cache_creation.unwrap_or(0),
        cache_read: cache_read.unwrap_or(0),
        output: output.unwrap_or(0),
    })
}

/// A session's cumulative, all-agent spend (see [`SessionUsage`]) from a `modelUsage` map —
/// `result.modelUsage` live, or the `modelUsage` of the transcript's `cost-state` line (the
/// same camelCase shape). Each model's `inputTokens + cacheCreationInputTokens +
/// cacheReadInputTokens + outputTokens` is added into the total; `thinkingTokens` is NOT, it is
/// already inside `outputTokens`. `cost_usd` is the caller's session cost (`total_cost_usd` /
/// `totalCostUSD`), passed through as is.
///
/// `None` when the map is absent, not an object, or names no model with a single token count:
/// an empty snapshot must not overwrite a known total with zeros.
pub(crate) fn session_usage_from_model_usage(
    model_usage: &Value,
    cost_usd: Option<f64>,
) -> Option<SessionUsage> {
    let obj = model_usage.as_object()?;
    let mut per_model: Vec<ModelTokenUsage> = obj
        .iter()
        .filter_map(|(model, entry)| {
            let field = |k: &str| entry.get(k).and_then(Value::as_u64);
            let input = field("inputTokens");
            let cache_creation = field("cacheCreationInputTokens");
            let cache_read = field("cacheReadInputTokens");
            let output = field("outputTokens");
            if input.is_none() && cache_creation.is_none() && cache_read.is_none() && output.is_none() {
                return None;
            }
            Some(ModelTokenUsage {
                model: model.clone(),
                usage: TokenUsage {
                    input: input.unwrap_or(0),
                    cache_creation: cache_creation.unwrap_or(0),
                    cache_read: cache_read.unwrap_or(0),
                    output: output.unwrap_or(0),
                },
                cost_usd: entry.get("costUSD").and_then(Value::as_f64),
            })
        })
        .collect();
    if per_model.is_empty() {
        return None;
    }
    let size = |u: &TokenUsage| u.input + u.cache_creation + u.cache_read + u.output;
    // Largest first; the id breaks a tie so the order never depends on the map's.
    per_model.sort_by(|a, b| size(&b.usage).cmp(&size(&a.usage)).then_with(|| a.model.cmp(&b.model)));
    let total = per_model.iter().fold(TokenUsage::default(), |acc, m| TokenUsage {
        input: acc.input.saturating_add(m.usage.input),
        cache_creation: acc.cache_creation.saturating_add(m.usage.cache_creation),
        cache_read: acc.cache_read.saturating_add(m.usage.cache_read),
        output: acc.output.saturating_add(m.usage.output),
    });
    Some(SessionUsage { total, cost_usd, per_model })
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

    /// A real `/compact` on the LIVE wire (claude 2.1.286, production flags): the previous
    /// turn's `result`, then `status:"compacting"` → `status:null`+`compact_result:"success"` →
    /// `init` → `compact_boundary` → the synthetic summary → "Compacted" → the command echo →
    /// a model-call-free `result`.
    const CAPTURE_COMPACT_LIVE: &str = include_str!("fixtures/capture_compact_live.jsonl");

    fn ingest_lines(asm: &mut Assembler, lines: &str) -> Vec<SessionEvent> {
        lines
            .lines()
            .filter(|l| !l.trim().is_empty())
            .flat_map(|l| asm.ingest(&serde_json::from_str::<CliMessage>(l).unwrap()))
            .collect()
    }

    #[test]
    fn live_compaction_marks_the_thread_and_resets_the_ring() {
        let mut asm = Assembler::new();
        // The app stamps the `/compact` it sends, so its echo is recognised as ours.
        asm.note_sent_user_message("4a47e22e-0526-4735-8629-a312e238a537");
        let events = ingest_lines(&mut asm, CAPTURE_COMPACT_LIVE);

        let activities: Vec<Option<String>> = events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::State(s) => Some(s.activity.clone()),
                _ => None,
            })
            .collect();
        assert!(
            activities.contains(&Some("compacting".to_string())),
            "the working line must learn a compaction is running, got {activities:?}"
        );

        let notices: Vec<(&str, &Value)> = events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => Some((subtype.as_str(), detail)),
                _ => None,
            })
            .collect();
        // ONE separator, carrying the facts; no "Compacted" line, no failure.
        assert_eq!(notices.len(), 1, "got {notices:?}");
        let (subtype, d) = notices[0];
        assert_eq!(subtype, "compact_boundary");
        assert_eq!(d["trigger"], "manual");
        assert_eq!(d["pre_tokens"], 36488);
        assert_eq!(d["post_tokens"], 5964);
        assert_eq!(d["duration_ms"], 13250);
        // Neither the summary nor our own echo becomes a bubble.
        assert!(!events
            .iter()
            .any(|e| matches!(e, SessionEvent::Item(ConversationItem::UserMessage { .. }))));

        // The ring shows the compacted size — and the closing all-zero `result` (no model
        // call) leaves it there instead of zeroing it.
        let last = events
            .iter()
            .rev()
            .find_map(|e| match e {
                SessionEvent::State(s) => Some(s),
                _ => None,
            })
            .unwrap();
        assert_eq!(last.context_tokens, Some(5964));
        assert_eq!(last.context_usage, None);
        assert_eq!(last.activity, None);
    }

    #[test]
    fn a_failed_compaction_is_an_error_notice() {
        let mut asm = Assembler::new();
        let with_reason = r#"{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"Not enough messages to compact.","session_id":"s"}"#;
        let bare = r#"{"type":"system","subtype":"status","status":null,"compact_result":"failed","session_id":"s"}"#;
        let ok = r#"{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"s"}"#;
        let messages: Vec<String> = ingest_lines(&mut asm, &format!("{with_reason}\n{bare}\n{ok}"))
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::Notice { subtype, detail }) => {
                    assert_eq!(subtype, "compact_failed");
                    detail["message"].as_str().map(str::to_string)
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            messages,
            vec![
                "Not enough messages to compact.".to_string(),
                "Claude Code couldn't compact the conversation.".to_string()
            ]
        );
    }

    #[test]
    fn a_compaction_field_of_an_unexpected_type_never_fails_the_status_line() {
        let mut asm = Assembler::new();
        // `compact_error` as an object: the line still parses, so its permission mode lands.
        let line = r#"{"type":"system","subtype":"status","status":null,"permissionMode":"plan","compact_result":"failed","compact_error":{"code":42}}"#;
        let events = ingest_lines(&mut asm, line);
        assert!(events
            .iter()
            .any(|e| matches!(e, SessionEvent::State(s) if s.permission_mode.as_deref() == Some("plan"))));
    }

    #[test]
    fn assembles_fixture_into_normalized_events() {
        let mut asm = Assembler::new();
        // The capture is a brand-new session's first turn: its cumulative model time IS
        // this turn's.
        asm.mark_fresh_session();
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
    fn context_usage_breaks_down_the_same_fill_from_the_fixture() {
        let mut asm = Assembler::new();
        for line in CAPTURE.lines().map(str::trim).filter(|l| !l.is_empty()) {
            asm.ingest(&serde_json::from_str::<CliMessage>(line).unwrap());
        }
        let u = asm.state().context_usage.expect("the fixture reports usage");
        assert_eq!((u.input, u.cache_creation, u.cache_read), (5069, 9061, 15626));
        // The breakdown and the fill come from the same object: they can never disagree.
        assert_eq!(Some(u.input + u.cache_creation + u.cache_read), asm.state().context_tokens);
    }

    #[test]
    fn a_root_call_s_output_is_completed_by_its_message_delta() {
        let line = |s: &str| serde_json::from_str::<CliMessage>(s).unwrap();
        let mut asm = Assembler::new();
        asm.ingest(&line(
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":40,"cache_creation_input_tokens":300,"cache_read_input_tokens":9000,"output_tokens":1}}},"session_id":"s"}"#,
        ));
        let at_start = asm.state().context_usage.unwrap();
        assert_eq!((at_start.input, at_start.cache_creation, at_start.cache_read), (40, 300, 9000));
        // A SUB-AGENT's delta must not overwrite the conversation's own call.
        asm.ingest(&line(
            r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":7777}},"parent_tool_use_id":"tu_sub","session_id":"s"}"#,
        ));
        assert_eq!(asm.state().context_usage.unwrap().output, 1);
        let evs = asm.ingest(&line(
            r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":512}},"session_id":"s"}"#,
        ));
        assert_eq!(asm.state().context_usage.unwrap().output, 512);
        assert!(evs.iter().any(|e| matches!(e, SessionEvent::State(_))), "the new output reaches the UI");
    }

    #[test]
    fn a_turn_reports_what_it_consumed_while_the_context_reads_its_last_call() {
        let result = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "ok",
            "stop_reason": "end_turn", "session_id": "s", "uuid": "u",
            "usage": {
                "input_tokens": 2100, "cache_read_input_tokens": 18000,
                "cache_creation_input_tokens": 500, "output_tokens": 900,
                "iterations": [
                    {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 500, "output_tokens": 300},
                    {"input_tokens": 2000, "cache_read_input_tokens": 18000, "cache_creation_input_tokens": 0, "output_tokens": 600}
                ]
            }
        });
        let mut asm = Assembler::new();
        let evs = asm.ingest(&serde_json::from_value::<CliMessage>(result).unwrap());
        // The window holds the LAST call's prompt…
        assert_eq!(
            asm.state().context_usage,
            Some(TokenUsage { input: 2000, cache_creation: 0, cache_read: 18000, output: 600 })
        );
        // …while the turn consumed the aggregate.
        let usage = evs.iter().find_map(|e| match e {
            SessionEvent::Item(ConversationItem::TurnResult { usage, .. }) => Some(*usage),
            _ => None,
        });
        assert_eq!(
            usage,
            Some(Some(TokenUsage { input: 2100, cache_creation: 500, cache_read: 18000, output: 900 }))
        );
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
    fn session_usage_sums_every_model_and_never_adds_thinking() {
        let model_usage = serde_json::json!({
            "claude-haiku-4-5": {"inputTokens": 514, "outputTokens": 11, "costUSD": 0.0006},
            "claude-opus-5[1m]": {
                "inputTokens": 5069, "outputTokens": 900, "thinkingTokens": 400,
                "cacheReadInputTokens": 15626, "cacheCreationInputTokens": 9061,
                "costUSD": 0.12, "contextWindow": 1000000
            },
            // A model the map lists without a single count adds nothing and is not listed.
            "claude-sonnet-4-6": {"contextWindow": 200000}
        });
        let u = session_usage_from_model_usage(&model_usage, Some(0.1206)).expect("known");
        // `thinkingTokens` is already inside `outputTokens`: 900 + 11, not 1311.
        assert_eq!(
            u.total,
            TokenUsage { input: 5069 + 514, cache_creation: 9061, cache_read: 15626, output: 911 }
        );
        assert_eq!(u.cost_usd, Some(0.1206));
        // Largest first; the helper Haiku is IN the total.
        let models: Vec<&str> = u.per_model.iter().map(|m| m.model.as_str()).collect();
        assert_eq!(models, ["claude-opus-5[1m]", "claude-haiku-4-5"]);
        assert_eq!(u.per_model[1].cost_usd, Some(0.0006));
        // Nothing to read → None, so a result without a map never zeroes a known total.
        assert_eq!(session_usage_from_model_usage(&Value::Null, Some(1.0)), None);
        assert_eq!(session_usage_from_model_usage(&serde_json::json!({}), None), None);
        assert_eq!(
            session_usage_from_model_usage(&serde_json::json!({"m": {"contextWindow": 1}}), None),
            None
        );
    }

    #[test]
    fn fixture_result_carries_the_all_model_session_usage() {
        let mut asm = Assembler::new();
        let mut last = None;
        for line in CAPTURE.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::State(s) = ev {
                    last = Some(s.session_usage);
                }
            }
        }
        // The fixture's result: Opus 5069/9061/15626/5 + a helper Haiku 514/11.
        let u = last.flatten().expect("the result's state carries the session usage");
        assert_eq!(
            u.total,
            TokenUsage { input: 5069 + 514, cache_creation: 9061, cache_read: 15626, output: 5 + 11 }
        );
        assert_eq!(u.cost_usd, Some(0.124462));
        assert_eq!(u.per_model.len(), 2);
    }

    #[test]
    fn session_usage_is_replaced_by_each_result_never_summed() {
        let result = |input: u64, cost: f64| -> CliMessage {
            serde_json::from_value(serde_json::json!({
                "type": "result", "subtype": "success", "is_error": false,
                "total_cost_usd": cost,
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "modelUsage": {"claude-opus-5": {"inputTokens": input, "outputTokens": 10}}
            }))
            .unwrap()
        };
        let mut asm = Assembler::new();
        asm.ingest(&result(100, 0.5));
        // The second result carries the RUNNING total (100 + 50): it replaces, never adds.
        asm.ingest(&result(150, 0.8));
        let u = asm.state().session_usage.clone().unwrap();
        assert_eq!(u.total.input, 150);
        assert_eq!(u.cost_usd, Some(0.8));
        // A `/clear` resets the CLI's counter: the value goes DOWN, and is taken as is.
        asm.ingest(&result(20, 0.05));
        assert_eq!(asm.state().session_usage.as_ref().unwrap().total.input, 20);
        // A result without a map keeps the last known total.
        let bare: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true
        }))
        .unwrap();
        asm.ingest(&bare);
        assert_eq!(asm.state().session_usage.as_ref().unwrap().total.input, 20);
    }

    /// `(subtype, is_error)` of every `TurnResult` in `events`.
    fn turn_outcomes(events: &[SessionEvent]) -> Vec<(String, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::TurnResult { subtype, is_error, .. }) => {
                    Some((subtype.clone(), *is_error))
                }
                _ => None,
            })
            .collect()
    }

    /// The composer's Stop, on the LIVE wire (claude 2.1.293, production flags, cut mid-reply):
    /// the CLI writes the interrupt marker, then reports the turn as a FAILURE. It must reach
    /// the UI as the marker notice + an `interrupted` (non-error) turn — no "Error during
    /// execution" box, no red / blue settle.
    #[test]
    fn user_interrupt_settles_as_interrupted_not_error() {
        let mut asm = Assembler::new();
        let events = ingest_lines(
            &mut asm,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"2771d4d1"}
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":2646,"duration_api_ms":617,"num_turns":2,"stop_reason":null,"terminal_reason":"aborted_streaming","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],"session_id":"s","uuid":"7f79d2f1"}"#,
        );
        assert!(events.iter().any(|e| matches!(
            e,
            SessionEvent::Item(ConversationItem::Notice { subtype, .. }) if subtype == "interrupted"
        )));
        assert_eq!(turn_outcomes(&events), vec![("interrupted".to_string(), false)]);
    }

    /// A turn cut during (or while a permission prompt held) a tool exits on `aborted_tools`.
    #[test]
    fn interrupt_during_a_tool_settles_as_interrupted() {
        let mut asm = Assembler::new();
        let events = ingest_lines(
            &mut asm,
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools"}"#,
        );
        assert_eq!(turn_outcomes(&events), vec![("interrupted".to_string(), false)]);
    }

    /// No `terminal_reason` (an older binary): the marker line preceding the errored result is
    /// the signal. It arms for ONE result only — a genuine failure on a later turn stays an
    /// error, and so does one with neither signal.
    #[test]
    fn interrupt_marker_is_the_fallback_signal_for_one_result_only() {
        let mut asm = Assembler::new();
        let events = ingest_lines(
            &mut asm,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"parent_tool_use_id":null,"uuid":"m1"}
{"type":"result","subtype":"error_during_execution","is_error":true}
{"type":"result","subtype":"error_during_execution","is_error":true}"#,
        );
        assert_eq!(
            turn_outcomes(&events),
            vec![
                ("interrupted".to_string(), false),
                ("error_during_execution".to_string(), true),
            ]
        );
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

    /// A `result` line carrying only the timing fields under test.
    fn timed_result(duration_ms: u64, cumulative_api_ms: u64) -> CliMessage {
        serde_json::from_value(serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "ok",
            "session_id": "s",
            "uuid": "u",
            "duration_ms": duration_ms,
            "duration_api_ms": cumulative_api_ms,
        }))
        .unwrap()
    }

    /// The (duration_ms, duration_api_ms) of the TurnResult a `result` normalizes to.
    fn turn_timing(asm: &mut Assembler, msg: &CliMessage) -> (Option<u64>, Option<u64>) {
        asm.ingest(msg)
            .into_iter()
            .find_map(|ev| match ev {
                SessionEvent::Item(ConversationItem::TurnResult {
                    duration_ms,
                    duration_api_ms,
                    ..
                }) => Some((duration_ms, duration_api_ms)),
                _ => None,
            })
            .expect("a result normalizes to a TurnResult")
    }

    /// `result.duration_api_ms` is a running per-session TOTAL on the wire (values from a
    /// live probe of claude 2.1.283, three prompts in one process). Each turn must report
    /// its OWN share, or every footer after the first shows the whole session's model time.
    #[test]
    fn turn_model_time_is_the_delta_of_the_cumulative_counter() {
        let mut asm = Assembler::new();
        asm.mark_fresh_session();
        assert_eq!(turn_timing(&mut asm, &timed_result(1265, 2128)), (Some(1265), Some(2128)));
        assert_eq!(turn_timing(&mut asm, &timed_result(3907, 6016)), (Some(3907), Some(3888)));
        assert_eq!(turn_timing(&mut asm, &timed_result(1115, 7086)), (Some(1115), Some(1070)));
    }

    /// A resumed process restores the session's earlier total, which we cannot know
    /// before its first `result`: that turn's model time is unknown (never the whole
    /// restored total), the next ones are exact again.
    #[test]
    fn turn_model_time_is_unknown_on_the_first_result_of_a_resumed_process() {
        let mut asm = Assembler::new(); // not marked fresh: a --resume spawn
        assert_eq!(turn_timing(&mut asm, &timed_result(863, 7894)), (Some(863), None));
        assert_eq!(turn_timing(&mut asm, &timed_result(900, 8800)), (Some(900), Some(906)));
    }

    /// A counter that went BACKWARDS (a re-spawned process restored an older total) yields
    /// no model time for that turn instead of an underflow, and re-bases on the new total.
    #[test]
    fn turn_model_time_survives_a_counter_that_went_backwards() {
        let mut asm = Assembler::new();
        asm.mark_fresh_session();
        assert_eq!(turn_timing(&mut asm, &timed_result(1000, 5000)).1, Some(5000));
        assert_eq!(turn_timing(&mut asm, &timed_result(1000, 3000)).1, None);
        assert_eq!(turn_timing(&mut asm, &timed_result(1000, 3500)).1, Some(500));
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

    /// Ingest one wire line (as JSON) and return the Task snapshots it emitted.
    fn task_events(asm: &mut Assembler, line: serde_json::Value) -> Vec<BackgroundTask> {
        let msg: CliMessage = serde_json::from_value(line).unwrap();
        asm.ingest(&msg)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::Task(t) => Some(t),
                _ => None,
            })
            .collect()
    }

    fn level(ids: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "background_tasks_changed",
            "tasks": ids.iter().map(|id| serde_json::json!({
                "task_id": id, "task_type": "local_bash", "description": "d"
            })).collect::<Vec<_>>()
        })
    }

    fn bg_started(id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "task_started", "task_id": id,
            "tool_use_id": format!("tu_{id}"), "description": "d",
            "is_backgrounded": true, "task_type": "local_bash"
        })
    }

    /// Any line that is not part of the task lifecycle.
    fn unrelated_line() -> serde_json::Value {
        serde_json::json!({"type": "keep_alive"})
    }

    /// A real AUTO-mode run on claude 2.1.293 (production flags): a background sub-agent
    /// ("kiwi bg") hands its report back WHILE the parent works, then a second one ("pear fg",
    /// made async by auto mode) hands back AFTER the parent's turn ended — opening a turn of
    /// its own. Both reports ride `isSynthetic` lines with `origin.handback`.
    const HANDBACK_LIVE_CAPTURE: &str = include_str!("fixtures/capture_handback_live.jsonl");

    /// CRM bfb7978a: a sub-agent's report used to appear nowhere (dropped as an injected
    /// line). Both deliveries must now surface, in place, told apart by `mid_turn`.
    #[test]
    fn live_capture_surfaces_both_subagent_handbacks_in_place() {
        let mut asm = Assembler::new();
        // Our own prompt comes back through `--replay-user-messages`: not a bubble.
        asm.note_sent_user_message("de7cd307-d6f8-4bdb-8477-53bc716ad99c");
        let events = ingest_lines(&mut asm, HANDBACK_LIVE_CAPTURE);
        let users: Vec<(&str, &str, bool, bool)> = events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::Item(ConversationItem::UserMessage { id, text, replay, mid_turn, .. }) => {
                    Some((id.as_str(), text.as_str(), *replay, *mid_turn))
                }
                _ => None,
            })
            .collect();
        let handbacks: Vec<_> = users.iter().filter(|u| u.1.contains("[Subagent hand-back]")).collect();
        assert_eq!(handbacks.len(), 2, "both reports surface: {users:?}");

        let (_, kiwi, replay, mid_turn) = handbacks[0];
        assert!(kiwi.starts_with("<agent-message from=\"a57593c84fc7315e8\">"), "{kiwi}");
        assert!(kiwi.contains("\n  KIWI\n  - done\n"), "{kiwi}");
        // Appended where it landed, not hoisted by the replay splice; flagged mid-turn.
        assert!(!replay && *mid_turn, "kiwi landed mid-turn");

        let (_, pear, replay, mid_turn) = handbacks[1];
        assert!(pear.starts_with("Another Claude session sent a message:\n<agent-message from=\"a7afbf6c20693f449\">"));
        assert!(!replay && !mid_turn, "pear opened a turn of its own");

        // Each report comes after the tool_result that closed its sub-agent's run, and the
        // mid-turn one before the parent's next model output.
        let pos = |pred: &dyn Fn(&SessionEvent) -> bool| events.iter().position(pred).unwrap();
        let kiwi_at = pos(&|e| matches!(e, SessionEvent::Item(ConversationItem::UserMessage { text, .. }) if text.contains("a57593c84fc7315e8")));
        let pear_launch_ack = pos(&|e| matches!(e, SessionEvent::Item(ConversationItem::ToolResult { tool_use_id, .. }) if tool_use_id == "toolu_01FSj8NL394H5azg3j92RVrJ"));
        assert!(pear_launch_ack < kiwi_at, "kiwi's report lands after the call that preceded it");
    }

    const TASKS_LIVE_CAPTURE: &str = include_str!("fixtures/capture_tasks_live.jsonl");

    /// REGRESSION (CRM 5f971fbe), on a REAL 2.1.286 capture: a background Bash, a Monitor,
    /// a background sub-agent that runs a FOREGROUND Bash, a foreground Bash on the main
    /// thread, and a foreground sub-agent. The CLI registers a task for each — the three
    /// foreground ones flagged `is_backgrounded:false`, the sub-agent's Bash also
    /// `owned_by_subagent` — and the socle must say so. The levels precede every edge, so
    /// the whole run must settle on the edges' own statuses with nothing retired.
    #[test]
    fn live_capture_flags_foreground_tasks_and_settles_without_retiring() {
        use std::collections::HashMap;
        let mut asm = Assembler::new();
        let mut tasks: HashMap<String, BackgroundTask> = HashMap::new();
        for line in TASKS_LIVE_CAPTURE.lines().filter(|l| !l.trim().is_empty()) {
            let msg: CliMessage = serde_json::from_str(line).unwrap();
            for ev in asm.ingest(&msg) {
                if let SessionEvent::Task(t) = ev {
                    tasks.insert(t.task_id.clone(), t);
                }
            }
        }
        assert_eq!(tasks.len(), 6);
        assert!(
            tasks.values().all(|t| t.status == BackgroundTaskStatus::Completed),
            "every task settles on its own edge — no level retire: {:?}",
            tasks.values().map(|t| (&t.task_id, t.status)).collect::<Vec<_>>()
        );

        let bash = &tasks["bt5jfg9td"];
        assert_eq!((bash.kind, bash.backgrounded, bash.owned_by_subagent), (BackgroundTaskKind::Bash, Some(true), false));
        assert!(bash.output_file.as_deref().unwrap().ends_with("/tasks/bt5jfg9td.output"));
        assert_eq!(tasks["bk5y3rqjw"].kind, BackgroundTaskKind::Monitor);

        // The sub-agent's agentId IS its task_id; the notification's temp path names it.
        let kiwi = &tasks["ae1d7fc6a2a871bc1"];
        assert_eq!((kiwi.kind, kiwi.backgrounded), (BackgroundTaskKind::Agent, Some(true)));
        assert_eq!(kiwi.agent_id.as_deref(), Some("ae1d7fc6a2a871bc1"));

        // The ghost: a foreground Bash on the MAIN thread, registered after ~2 s.
        let fg = &tasks["bdrj736ha"];
        assert_eq!((fg.kind, fg.backgrounded, fg.owned_by_subagent), (BackgroundTaskKind::Bash, Some(false), false));
        assert_eq!(fg.output_file, None, "`output_file:\"\"` is no file, not an empty path");
        // …and the one run by the sub-agent.
        let sub_fg = &tasks["brf0oatl7"];
        assert_eq!((sub_fg.backgrounded, sub_fg.owned_by_subagent), (Some(false), true));

        let pear = &tasks["a94f2d97a76e48a97"];
        assert_eq!((pear.kind, pear.backgrounded, pear.owned_by_subagent), (BackgroundTaskKind::Agent, Some(false), false));
        assert_eq!(pear.agent_id.as_deref(), Some("a94f2d97a76e48a97"));

        // Only the background command runs against the CLI's time limit (no `timeout` in
        // its input → the 30 min default); a Monitor has none, and the foreground commands
        // were never moved to the background.
        assert_eq!(bash.time_limit_ms, Some(30 * 60_000));
        assert!(bash.deadline_at_ms.is_some());
        for id in ["bk5y3rqjw", "bdrj736ha", "brf0oatl7", "ae1d7fc6a2a871bc1"] {
            assert_eq!((tasks[id].time_limit_ms, tasks[id].deadline_at_ms), (None, None), "{id}");
        }
        assert!(tasks.values().all(|t| t.stop_cause.is_none()), "nothing was stopped");
    }

    // ---- Background time limit (CLI 2.1.285+) -------------------------------------------

    /// Fixed clock for the deadline tests (epoch ms).
    const T0: u64 = 1_700_000_000_000;

    fn clocked() -> Assembler {
        let mut asm = Assembler::new();
        asm.clock = Some(|| T0);
        asm
    }

    fn bash_tool_use(id: &str, input: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "type": "assistant", "parent_tool_use_id": null,
            "message": {"id": format!("m_{id}"), "role": "assistant",
                "content": [{"type": "tool_use", "id": id, "name": "Bash", "input": input}]}
        })
    }

    fn started(task: &str, tool_use: &str, backgrounded: bool) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "task_started", "task_id": task, "tool_use_id": tool_use,
            "description": "dev server", "is_backgrounded": backgrounded, "task_type": "local_bash"
        })
    }

    fn notification(task: &str, status: &str, summary: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "system", "subtype": "task_notification", "task_id": task,
            "status": status, "output_file": "/tmp/x.output", "summary": summary
        })
    }

    /// `run_in_background` without a `timeout`: the CLI stops it 30 min after launch.
    #[test]
    fn a_background_command_gets_the_default_time_limit() {
        let mut asm = clocked();
        task_events(&mut asm, bash_tool_use("tu1", serde_json::json!({"command": "pnpm dev", "run_in_background": true})));
        let t = task_events(&mut asm, started("b1", "tu1", true)).pop().unwrap();
        assert_eq!(t.time_limit_ms, Some(1_800_000));
        assert_eq!(t.deadline_at_ms, Some(T0 + 1_800_000));
    }

    /// A requested `timeout` sets a background command's limit (capped at 2 h).
    #[test]
    fn a_background_command_runs_for_its_requested_timeout() {
        let mut asm = clocked();
        task_events(
            &mut asm,
            bash_tool_use("tu1", serde_json::json!({"command": "pnpm dev", "run_in_background": true, "timeout": 3_600_000})),
        );
        task_events(
            &mut asm,
            bash_tool_use("tu2", serde_json::json!({"command": "watch", "run_in_background": true, "timeout": 86_400_000})),
        );
        let one = task_events(&mut asm, started("b1", "tu1", true)).pop().unwrap();
        assert_eq!((one.time_limit_ms, one.deadline_at_ms), (Some(3_600_000), Some(T0 + 3_600_000)));
        let two = task_events(&mut asm, started("b2", "tu2", true)).pop().unwrap();
        assert_eq!(two.time_limit_ms, Some(7_200_000), "capped at the CLI's max");
    }

    /// A `timeout` on a FOREGROUND command is its foreground timeout, not a background
    /// limit: moved to the background mid-run, it gets the default, timed from the move.
    #[test]
    fn a_command_moved_to_the_background_is_timed_from_the_move_on_the_default() {
        let mut asm = clocked();
        task_events(&mut asm, bash_tool_use("tu1", serde_json::json!({"command": "pnpm build", "timeout": 600_000})));
        let fg = task_events(&mut asm, started("b1", "tu1", false)).pop().unwrap();
        assert_eq!((fg.time_limit_ms, fg.deadline_at_ms), (None, None), "a foreground command has no deadline");
        asm.clock = Some(|| T0 + 120_000);
        let moved = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "b1", "patch": {"is_backgrounded": true}}),
        )
        .pop()
        .unwrap();
        assert_eq!(moved.time_limit_ms, Some(1_800_000));
        assert_eq!(moved.deadline_at_ms, Some(T0 + 120_000 + 1_800_000));
    }

    /// The input can land after `task_started` (the assembled message is late): the
    /// deadline keeps its start and moves its end to the requested `timeout`.
    #[test]
    fn a_late_input_moves_the_deadline_to_the_requested_timeout() {
        let mut asm = clocked();
        let t = task_events(&mut asm, started("b1", "tu1", true)).pop().unwrap();
        assert_eq!(t.deadline_at_ms, Some(T0 + 1_800_000), "armed on the default meanwhile");
        asm.clock = Some(|| T0 + 5_000);
        let t = task_events(
            &mut asm,
            bash_tool_use("tu1", serde_json::json!({"command": "pnpm dev", "run_in_background": true, "timeout": 3_600_000})),
        )
        .pop()
        .unwrap();
        assert_eq!((t.time_limit_ms, t.deadline_at_ms), (Some(3_600_000), Some(T0 + 3_600_000)));
    }

    /// A Monitor watch has no time limit — even when first classified as a Bash.
    #[test]
    fn a_monitor_has_no_time_limit() {
        let mut asm = clocked();
        let t = task_events(&mut asm, started("m1", "tu_m", true)).pop().unwrap();
        assert_eq!(t.kind, BackgroundTaskKind::Bash, "an unknown local_bash defaults to Bash");
        let t = task_events(
            &mut asm,
            serde_json::json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "tool_use", "id": "tu_m", "name": "Monitor", "input": {}}}}),
        )
        .pop()
        .expect("the re-classification is re-emitted");
        assert_eq!(t.kind, BackgroundTaskKind::Monitor);
        assert_eq!((t.time_limit_ms, t.deadline_at_ms), (None, None));
    }

    /// A CLI before 2.1.285 never stops a background command: no deadline is shown.
    #[test]
    fn an_older_cli_has_no_time_limit() {
        let mut asm = clocked();
        asm.ingest(&serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init", "session_id": "s", "claude_code_version": "2.1.284"
        })).unwrap());
        let t = task_events(&mut asm, started("b1", "tu1", true)).pop().unwrap();
        assert_eq!((t.time_limit_ms, t.deadline_at_ms), (None, None));
    }

    /// The real stop sequence (2.1.293): `task_updated{killed}` then a `stopped`
    /// notification whose summary names the cause.
    #[test]
    fn a_deadline_stop_is_told_apart_from_a_user_stop() {
        let mut asm = clocked();
        task_events(&mut asm, started("b1", "tu1", true));
        let killed = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "b1",
                "patch": {"status": "killed", "end_time": 1}}),
        )
        .pop()
        .unwrap();
        assert_eq!((killed.status, killed.stop_cause), (BackgroundTaskStatus::Stopped, None));
        let done = task_events(
            &mut asm,
            notification("b1", "stopped", "Background command \"dev server\" was stopped after reaching its background time limit"),
        )
        .pop()
        .unwrap();
        assert_eq!(done.stop_cause, Some(BackgroundStopCause::Deadline));

        task_events(&mut asm, started("b2", "tu2", true));
        let user = task_events(&mut asm, notification("b2", "stopped", "dev server")).pop().unwrap();
        assert_eq!(user.stop_cause, None, "the user's Stop carries the bare description");
    }

    #[test]
    fn memory_pressure_and_worker_restart_stops_are_named() {
        let mut asm = clocked();
        task_events(&mut asm, started("b1", "tu1", true));
        let t = task_events(
            &mut asm,
            notification("b1", "stopped", "Background command \"x\" was stopped because the system is running low on memory"),
        )
        .pop()
        .unwrap();
        assert_eq!(t.stop_cause, Some(BackgroundStopCause::MemoryPressure));

        task_events(&mut asm, started("b2", "tu2", true));
        let mut restart = notification("b2", "stopped", "Stopped by a worker restart: x");
        restart["reason"] = "worker_restart".into();
        assert_eq!(task_events(&mut asm, restart).pop().unwrap().stop_cause, Some(BackgroundStopCause::WorkerRestart));
    }

    /// The cause phrase must END the summary of a STOPPED task: a description quoting it
    /// on a command that completed is not a deadline stop.
    #[test]
    fn a_description_quoting_the_phrase_is_not_a_stop_cause() {
        let mut asm = clocked();
        task_events(&mut asm, started("b1", "tu1", true));
        let t = task_events(
            &mut asm,
            notification(
                "b1",
                "completed",
                "Background command \"echo was stopped after reaching its background time limit\" completed (exit code 0)",
            ),
        )
        .pop()
        .unwrap();
        assert_eq!(t.stop_cause, None);
    }

    /// A background task that LEFT the level is not settled by the level itself — its own
    /// edges follow with the real status, and a guess first would fire the front's
    /// once-per-task "finished" push with the wrong one.
    #[test]
    fn leaving_the_level_waits_for_the_tasks_own_end_event() {
        let mut asm = Assembler::new();
        task_events(&mut asm, level(&["t1"]));
        task_events(&mut asm, bg_started("t1"));
        assert!(task_events(&mut asm, level(&[])).is_empty(), "the level settles nothing");
        let ended = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_notification", "task_id": "t1", "status": "failed", "output_file": "", "summary": "x"}),
        );
        assert_eq!(ended[0].status, BackgroundTaskStatus::Failed);
        assert!(task_events(&mut asm, unrelated_line()).is_empty(), "settled by its edge: nothing to retire");
    }

    /// The level's reason to exist: a task whose end event never comes would stay Running
    /// forever (the conversation green, no "done" notification). Once a line from outside the
    /// task lifecycle proves its edges are not coming, it is retired as Stopped.
    #[test]
    fn a_task_that_left_the_level_without_an_end_event_is_retired() {
        let mut asm = Assembler::new();
        task_events(&mut asm, level(&["t1", "t2"]));
        task_events(&mut asm, bg_started("t1"));
        task_events(&mut asm, bg_started("t2"));
        task_events(&mut asm, level(&["t2"]));
        // A non-terminal edge does not vouch for a task the CLI no longer lists as live.
        task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_progress", "task_id": "t1", "description": "tick"}),
        );
        let retired = task_events(&mut asm, unrelated_line());
        assert_eq!(retired.len(), 1);
        assert_eq!((retired[0].task_id.as_str(), retired[0].status), ("t1", BackgroundTaskStatus::Stopped));
        assert!(task_events(&mut asm, unrelated_line()).is_empty(), "retired once");
    }

    /// A task that comes BACK into the level (a woken sub-agent) is live again — not retired.
    #[test]
    fn a_task_back_in_the_level_is_not_retired() {
        let mut asm = Assembler::new();
        task_events(&mut asm, level(&["t1"]));
        task_events(&mut asm, bg_started("t1"));
        task_events(&mut asm, level(&[]));
        task_events(&mut asm, level(&["t1"]));
        assert!(task_events(&mut asm, unrelated_line()).is_empty());
    }

    /// A foreground task never enters the level, so the level never retires it: it ends
    /// through its own notification, as on the live capture.
    #[test]
    fn a_foreground_task_is_never_retired_by_the_level() {
        let mut asm = Assembler::new();
        task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "fg", "tool_use_id": "tu_fg",
                "description": "d", "is_backgrounded": false, "task_type": "local_bash"}),
        );
        task_events(&mut asm, level(&["other"]));
        task_events(&mut asm, level(&[]));
        assert!(task_events(&mut asm, unrelated_line()).is_empty());
    }

    /// A foreground task moved to the background mid-run (`patch.is_backgrounded`) becomes
    /// background work from then on.
    #[test]
    fn task_updated_moves_a_foreground_task_to_the_background() {
        let mut asm = Assembler::new();
        let started = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "a1", "tool_use_id": "tu_a",
                "description": "d", "is_backgrounded": false, "spawn_depth": 1, "task_type": "local_agent"}),
        );
        assert_eq!(started[0].backgrounded, Some(false));
        let moved = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "a1", "patch": {"is_backgrounded": true}}),
        );
        assert_eq!((moved[0].backgrounded, moved[0].status), (Some(true), BackgroundTaskStatus::Running));
    }

    /// Housekeeping tasks are flagged ambient — from `ambient` or `skip_transcript` at start,
    /// and from the level, whose entries re-announce the flag (it can flip mid-run).
    #[test]
    fn ambient_comes_from_the_start_and_follows_the_level() {
        let mut asm = Assembler::new();
        let dream = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "d1",
                "description": "dreaming", "task_type": "dream", "skip_transcript": true}),
        );
        assert!(dream[0].ambient);

        task_events(&mut asm, bg_started("w1"));
        let flipped = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "background_tasks_changed", "tasks": [
                {"task_id": "w1", "task_type": "monitor_ws", "description": "watch", "ambient": true},
                {"task_id": "d1", "task_type": "dream", "description": "dreaming", "ambient": true}
            ]}),
        );
        assert_eq!(flipped.len(), 1, "only the task whose flag changed is re-emitted");
        assert!(flipped[0].ambient && flipped[0].task_id == "w1");
        let back = task_events(&mut asm, level(&["w1", "d1"]));
        // The CLI omits a false flag: both read as not ambient any more.
        assert_eq!(back.len(), 2);
        assert!(back.iter().all(|t| !t.ambient));
    }

    /// A nested sub-agent carries no `owned_by_subagent` (the CLI sets it on `local_bash`
    /// only): its `spawn_depth` says it was launched from inside another agent.
    #[test]
    fn a_nested_sub_agent_is_owned_by_a_sub_agent() {
        let mut asm = Assembler::new();
        let nested = task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "n1", "tool_use_id": "tu_n",
                "description": "d", "is_backgrounded": true, "spawn_depth": 2, "task_type": "local_agent"}),
        );
        assert!(nested[0].owned_by_subagent);
    }

    #[test]
    fn task_id_from_output_file_reads_the_temp_tasks_path_only() {
        assert_eq!(task_id_from_output_file("/tmp/claude-501/-w/s/tasks/ae1d.output").as_deref(), Some("ae1d"));
        assert_eq!(task_id_from_output_file("/x/s/subagents/agent-aa11.jsonl"), None);
        assert_eq!(task_id_from_output_file("/x/s/other/ae1d.output"), None);
        assert_eq!(task_id_from_output_file(""), None);
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
        // Spawn baseline: Opus / Extra / Default.
        asm.seed_controls(Some("opus".into()), Some("xhigh".into()), Some("default".into()), false);
        asm
    }

    /// A read-back that MATCHES the seed must not announce (no notice on spawn /
    /// resume); a real effort move must announce exactly one transition.
    #[test]
    fn effort_change_announces_only_a_real_move() {
        let mut asm = seeded();
        // The initial get_settings confirms the seed → state only, no notice. The
        // resolved id has to be the one the `opus` alias actually names — the LATEST
        // Opus, i.e. Opus 5.5 (Opus 5 and 4.8 are their own catalogue rows, so reading
        // one back against an `opus` seed is a genuine model change, not a confirmation).
        let evs = asm.apply_settings(Some("claude-opus-5-5[1m]".into()), Some("xhigh".into()), Some(false), Some(true));
        assert!(first_notice(evs).is_none(), "confirming the seed must stay silent");
        // Now a genuine change xhigh → high.
        let (subtype, detail) = first_notice(asm.apply_settings(None, Some("high".into()), Some(false), Some(true)))
            .expect("a control_change notice");
        assert_eq!(subtype, "control_change");
        assert_eq!(detail["control"], serde_json::json!("Thinking effort"));
        assert_eq!(detail["from"], serde_json::json!("Extra"));
        assert_eq!(detail["to"], serde_json::json!("High"));
        // Re-reading the same value is silent (idempotent).
        assert!(first_notice(asm.apply_settings(None, Some("high".into()), Some(false), Some(true))).is_none());
    }

    /// Ultracode is announced on its own line, independent of the effort: switching it
    /// on at `high` leaves the effort line silent and says "Ultracode: Off → On".
    #[test]
    fn ultracode_change_announces_its_own_line() {
        let mut asm = seeded();
        // First read-back: the ultracode baseline is recorded silently.
        assert!(first_notice(asm.apply_settings(None, Some("xhigh".into()), Some(false), Some(true))).is_none());
        let (_, detail) = first_notice(asm.apply_settings(None, Some("xhigh".into()), Some(true), Some(true)))
            .expect("a notice");
        assert_eq!(detail["control"], serde_json::json!("Ultracode"));
        assert_eq!(detail["from"], serde_json::json!("Off"));
        assert_eq!(detail["to"], serde_json::json!("On"));
        // An effort move with ultracode still on announces the effort only.
        let notices: Vec<_> = asm
            .apply_settings(None, Some("high".into()), Some(true), Some(true))
            .into_iter()
            .filter_map(|ev| match ev {
                SessionEvent::Item(ConversationItem::Notice { detail, .. }) => Some(detail),
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["control"], serde_json::json!("Thinking effort"));
    }

    /// A spawn seeded with ultracode never announces its own confirmation — nor its
    /// refusal: the refusal has its own control error (see `Announced::ultracode`).
    #[test]
    fn seeded_ultracode_first_read_back_is_silent() {
        let mut asm = Assembler::new();
        asm.seed_controls(Some("opus".into()), Some("high".into()), None, true);
        assert!(asm.state().ultracode, "the seed shows the spawn's ultracode before any round-trip");
        let evs = asm.apply_settings(None, Some("high".into()), Some(false), Some(false));
        assert!(first_notice(evs).is_none());
        assert!(!asm.state().ultracode);
        assert_eq!(asm.state().ultracode_available, Some(false));
    }

    /// Switching ultracode on where the last read-back said it can't run stays off.
    #[test]
    fn ultracode_optimistic_respects_known_unavailability() {
        let mut asm = seeded();
        asm.set_ultracode_optimistic(true);
        assert!(asm.state().ultracode, "unknown availability: optimistic on");
        asm.apply_settings(None, None, Some(false), Some(false));
        asm.set_ultracode_optimistic(true);
        assert!(!asm.state().ultracode, "known unavailable: the switch can't claim it runs");
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

    /// `initialize`'s live mode is shown without a notice (the session either moves the
    /// process to the composer's mode at once, or explains why it can't); hidden while a
    /// click's switch is in flight, but still remembered as what the process runs.
    #[test]
    fn an_observed_permission_mode_is_silent() {
        let mut asm = seeded();
        assert!(asm.observe_permission_mode("default", true).is_none(), "same as shown: no event");
        let shown = asm.observe_permission_mode("bypassPermissions", true);
        assert!(matches!(shown, Some(SessionEvent::State(s)) if s.permission_mode.as_deref() == Some("bypassPermissions")));
        asm.set_permission_mode("plan");
        assert!(asm.observe_permission_mode("acceptEdits", false).is_none());
        assert_eq!(asm.state().permission_mode.as_deref(), Some("plan"));
        assert_eq!(asm.confirmed_permission_mode(), Some("acceptEdits"));
    }

    /// A refused switch puts the display back on the last REPORTED mode and re-bases the
    /// notice baseline, so the next `system/init` does not announce it a second time.
    #[test]
    fn a_refused_permission_switch_reverts_to_the_reported_mode() {
        let mut asm = seeded(); // seeded "default" — the announce baseline
        asm.observe_permission_mode("acceptEdits", true); // silent: baseline still Default
        asm.set_permission_mode("bypassPermissions"); // optimistic click, then refused
        let back = asm.revert_permission_mode();
        assert!(matches!(back, SessionEvent::State(s) if s.permission_mode.as_deref() == Some("acceptEdits")));
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init", "session_id": "x", "model": "opus",
            "permissionMode": "acceptEdits", "tools": []
        }))
        .unwrap();
        assert!(first_notice(asm.ingest(&init)).is_none(), "the refusal already said it");
    }

    /// "Don't ask" denies whatever isn't pre-approved — it must never read as bypass.
    #[test]
    fn dont_ask_is_not_labelled_bypass() {
        let mut asm = seeded();
        let (_, detail) = first_notice(asm.confirm_permission_mode("dontAsk")).expect("a notice");
        assert_eq!(detail["to"], serde_json::json!("Don't ask"));
    }

    /// A model change reported by `system/init` (e.g. switched via /model in chat)
    /// is announced; the permission, unchanged from the seed, stays silent.
    #[test]
    fn model_change_from_system_init_is_announced() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-sonnet-5", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["control"], serde_json::json!("Model"));
        assert_eq!(detail["from"], serde_json::json!("Opus 5.5"));
        assert_eq!(detail["to"], serde_json::json!("Sonnet 5"));
    }

    /// `system/init.plugins` is the live session's own list (the only truthful one for a
    /// remote session). An init without the field (older CLI) keeps the last known list
    /// instead of wiping it; a malformed field never fails the init itself.
    #[test]
    fn system_init_carries_the_loaded_plugins() {
        let mut asm = seeded();
        let init = |plugins: Option<serde_json::Value>| -> CliMessage {
            let mut v = serde_json::json!({
                "type": "system", "subtype": "init",
                "session_id": "s", "uuid": "u", "cwd": "/x",
                "model": "claude-opus-5-5", "permissionMode": "default", "tools": []
            });
            if let Some(p) = plugins {
                v["plugins"] = p;
            }
            serde_json::from_value(v).unwrap()
        };
        assert_eq!(asm.state().loaded_plugins, None, "unknown before any init");

        let _ = asm.ingest(&init(Some(serde_json::json!([
            {"name": "cowork-plugin-management", "path": "/home/alex/.claude/plugins/synced/x",
             "source": "cowork-plugin-management@knowledge-work-plugins"},
            {"name": "cc-plugin-telemetry", "path": "builtin", "source": "cc-plugin-telemetry@builtin"}
        ]))));
        let names: Vec<_> = asm.state().loaded_plugins.as_ref().unwrap().iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["cowork-plugin-management"], "the CLI's builtins are dropped");

        let _ = asm.ingest(&init(None));
        assert_eq!(asm.state().loaded_plugins.as_ref().map(Vec::len), Some(1), "absent field keeps the list");

        let _ = asm.ingest(&init(Some(serde_json::json!("not-an-array"))));
        assert_eq!(asm.state().loaded_plugins.as_ref().map(Vec::len), Some(1), "malformed field keeps the list");

        let _ = asm.ingest(&init(Some(serde_json::json!([]))));
        assert_eq!(asm.state().loaded_plugins, Some(vec![]), "an empty list is a real answer");
    }

    /// `system/init.skills` / `.agents` are the session's own skill and sub-agent lists.
    /// Agent names keep the descriptions the `initialize` response gave; an init without
    /// the fields leaves what is known.
    #[test]
    fn system_init_carries_the_loaded_skills_and_agents() {
        let mut asm = seeded();
        let _ = asm.set_loaded_agents(vec![LoadedAgent { name: "Explore".into(), description: Some("search".into()) }]);
        let init = |extra: serde_json::Value| -> CliMessage {
            let mut v = serde_json::json!({
                "type": "system", "subtype": "init",
                "session_id": "s", "uuid": "u", "cwd": "/x",
                "model": "claude-opus-5-5", "permissionMode": "default", "tools": []
            });
            for (k, val) in extra.as_object().unwrap() {
                v[k] = val.clone();
            }
            serde_json::from_value(v).unwrap()
        };
        let _ = asm.ingest(&init(serde_json::json!({
            "skills": ["deep-research", "cowork-plugin-management:create-cowork-plugin"],
            "agents": ["Explore", "Plan"]
        })));
        assert_eq!(
            asm.state().loaded_skills.as_deref(),
            Some(&["deep-research".to_string(), "cowork-plugin-management:create-cowork-plugin".to_string()][..])
        );
        assert_eq!(
            asm.state().loaded_agents,
            Some(vec![
                LoadedAgent { name: "Explore".into(), description: Some("search".into()) },
                LoadedAgent { name: "Plan".into(), description: None },
            ])
        );

        let _ = asm.ingest(&init(serde_json::json!({})));
        assert_eq!(asm.state().loaded_skills.as_ref().map(Vec::len), Some(2), "absent field keeps the list");
        assert_eq!(asm.state().loaded_agents.as_ref().map(Vec::len), Some(2));

        // A malformed field neither wipes the lists nor fails the init: the rest of it
        // (here its cwd) still applies.
        let mut odd = init(serde_json::json!({ "skills": "oops", "agents": { "x": 1 } }));
        if let CliMessage::System(SystemMsg::Init(i)) = &mut odd {
            i.cwd = Some("/moved".into());
        }
        let _ = asm.ingest(&odd);
        assert_eq!(asm.state().cwd.as_deref(), Some("/moved"));
        assert_eq!(asm.state().loaded_skills.as_ref().map(Vec::len), Some(2));
        assert_eq!(asm.state().loaded_agents.as_ref().map(Vec::len), Some(2));

        // Empty arrays are a real answer: nothing loaded.
        let _ = asm.ingest(&init(serde_json::json!({ "skills": [], "agents": [] })));
        assert_eq!(asm.state().loaded_skills, Some(vec![]));
        assert_eq!(asm.state().loaded_agents, Some(vec![]));
    }

    /// The real captured `system/init` (fixture): its skills and sub-agents parse — so a
    /// typing of these fields that the wire would fail cannot slip in unnoticed.
    #[test]
    fn captured_system_init_yields_skills_and_agents() {
        let mut asm = seeded();
        let line = CAPTURE.lines().next().expect("the fixture opens on system/init");
        let msg: CliMessage = serde_json::from_str(line).expect("the captured init parses");
        let _ = asm.ingest(&msg);
        let skills = asm.state().loaded_skills.clone().expect("skills captured");
        assert!(skills.iter().any(|s| s == "deep-research"));
        assert!(skills.iter().any(|s| s == "tosse-workflow:pickup"));
        let agents = asm.state().loaded_agents.clone().expect("agents captured");
        assert!(agents.iter().any(|a| a.name == "Explore"));
        assert!(agents.iter().any(|a| a.name == "tosse-workflow:tosse-manager"));
        let plugins = asm.state().loaded_plugins.clone().expect("plugins captured");
        assert!(plugins.iter().any(|p| p.id.as_deref() == Some("railway@claude-plugins-official")));
    }

    /// A `reload_plugins` ack replaces plugins and sub-agents and FORGETS the skills (it may
    /// have changed them; no response carries the new list). A response without a list
    /// leaves that list alone.
    #[test]
    fn reload_refreshes_plugins_and_agents_and_forgets_skills() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init", "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-opus-5-5", "permissionMode": "default", "tools": [],
            "skills": ["railway:use-railway"], "plugins": [{"name": "railway", "source": "railway@m"}]
        }))
        .unwrap();
        let _ = asm.ingest(&init);
        assert!(asm.state().loaded_skills.is_some());

        let _ = asm.apply_reload(Some(vec![]), Some(vec![LoadedAgent { name: "Plan".into(), description: None }]));
        assert_eq!(asm.state().loaded_plugins, Some(vec![]));
        assert_eq!(asm.state().loaded_agents.as_ref().map(Vec::len), Some(1));
        assert_eq!(asm.state().loaded_skills, None, "stale after a reload");

        let _ = asm.apply_reload(None, None);
        assert_eq!(asm.state().loaded_plugins, Some(vec![]), "no list in the response: kept");
        assert_eq!(asm.state().loaded_agents.as_ref().map(Vec::len), Some(1));
    }

    /// A turn that starts while a `set_model` is still pending reports the model being
    /// switched AWAY from: it must neither put that model back in the picker nor
    /// announce it. Once the switch settles, `system/init` is authoritative again.
    #[test]
    fn system_init_during_a_pending_model_switch_keeps_the_pick() {
        let mut asm = seeded();
        let _ = asm.set_model("fable");
        asm.begin_model_switch();
        let init = |model: &str| -> CliMessage {
            serde_json::from_value(serde_json::json!({
                "type": "system", "subtype": "init",
                "session_id": "s", "uuid": "u", "cwd": "/x",
                "model": model, "permissionMode": "default",
                "tools": ["Bash"], "slash_commands": []
            }))
            .unwrap()
        };
        let evs = asm.ingest(&init("claude-opus-5-5[1m]"));
        assert!(first_notice(evs).is_none(), "no notice for the model being replaced");
        assert_eq!(asm.state().model.as_deref(), Some("fable"));

        asm.end_model_switch();
        let _ = asm.ingest(&init("claude-fable-5-1"));
        assert_eq!(asm.state().model.as_deref(), Some("claude-fable-5-1"));
    }

    /// Opus 4.8 is a DISTINCT row from the Opus family alias (and the app default), so
    /// its notice must name it — the resolved id contains "opus", which would otherwise
    /// announce a switch to "Opus 5" while the session actually runs 4.8.
    #[test]
    fn opus_4_8_is_labelled_by_its_own_name_not_the_family() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-opus-4-8[1m]", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["from"], serde_json::json!("Opus 5.5"));
        assert_eq!(detail["to"], serde_json::json!("Opus 4.8"));
    }

    /// Opus 5 became a pinned row when the `opus` alias moved on to Opus 5.5 — and its
    /// id is a PREFIX of the new one, so neither may be read as the other.
    #[test]
    fn opus_5_and_opus_5_5_are_told_apart() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-opus-5[1m]", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["from"], serde_json::json!("Opus 5.5"));
        assert_eq!(detail["to"], serde_json::json!("Opus 5"));
    }

    /// Each alias reads exactly like the id the CLI resolves it to (else a spawn on an
    /// alias would announce a phantom model change at its first read-back), and every
    /// other id is labelled off its own name — the front catalogue's labels, verbatim.
    #[test]
    fn model_labels_match_the_catalogue() {
        for (alias, resolved) in [
            ("opus", "claude-opus-5-5[1m]"),
            ("sonnet", "claude-sonnet-5-5"),
            ("haiku", "claude-haiku-4-5-20251001"),
            ("fable", "claude-fable-5-1"),
        ] {
            assert_eq!(model_label(alias), model_label(resolved), "{alias} vs {resolved}");
        }
        for (id, label) in [
            ("claude-opus-5-5", "Opus 5.5"),
            ("claude-opus-5", "Opus 5"),
            ("claude-opus-4-8[1m]", "Opus 4.8"),
            ("claude-opus-4-0", "Opus 4"),
            ("claude-opus-4-20250514", "Opus 4"),
            ("claude-opus-4-1@20250805", "Opus 4.1"),
            ("claude-sonnet-5-5", "Sonnet 5.5"),
            ("claude-sonnet-5", "Sonnet 5"),
            ("us.anthropic.claude-opus-4-6-v1", "Opus 4.6"),
            ("claude-3-5-sonnet-20241022", "Sonnet 3.5"),
            ("claude-3-7-sonnet", "Sonnet 3.7"),
            ("claude-fable-5", "Fable 5"),
            ("claude-mythos-5-1", "Mythos 5.1"),
            ("gpt-5.5", "gpt-5.5"),
            ("mystery", "mystery"),
        ] {
            assert_eq!(model_label(id), label, "{id}");
        }
    }

    /// The `fable` family now resolves to Fable 5.1 (binary 2.1.260); the label must
    /// mirror the composer's catalogue, which reads "Fable 5.1".
    #[test]
    fn fable_family_is_labelled_5_1() {
        let mut asm = seeded();
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": "s", "uuid": "u", "cwd": "/x",
            "model": "claude-fable-5-1", "permissionMode": "default",
            "tools": ["Bash"], "slash_commands": []
        }))
        .unwrap();
        let (_, detail) = first_notice(asm.ingest(&init)).expect("a model change notice");
        assert_eq!(detail["from"], serde_json::json!("Opus 5.5"));
        assert_eq!(detail["to"], serde_json::json!("Fable 5.1"));
    }

    /// A connection failure mid-turn must be VISIBLE: the CLI retries by itself, so
    /// without this the turn simply appears to hang. The notice clears as soon as the
    /// model produces anything, which proves the connection came back.
    #[test]
    fn an_api_retry_is_surfaced_then_cleared_when_the_stream_resumes() {
        let mut asm = seeded();
        let retry: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "api_error", "level": "error",
            "error": { "message": "Connection error." },
            "retryInMs": 1000, "retryAttempt": 2, "maxRetries": 3,
            "source": "connection_retry"
        }))
        .unwrap();

        let state = asm
            .ingest(&retry)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::State(s) => Some(s),
                _ => None,
            })
            .expect("a retry must reach the UI");
        let r = state.retry.expect("retry state");
        assert_eq!(r.attempt, Some(2));
        assert_eq!(r.max, Some(3));
        assert_eq!(r.reason.as_deref(), Some("Connection error."));

        // The stream resuming clears it.
        let delta: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0,
                       "delta": { "type": "text_delta", "text": "hi" } }
        }))
        .unwrap();
        let cleared = asm.ingest(&delta).into_iter().any(|e| {
            matches!(e, SessionEvent::State(s) if s.retry.is_none())
        });
        assert!(cleared, "the notice must disappear once the model answers");
        assert!(asm.state.retry.is_none());
    }

    /// REGRESSION: `system/commands_changed` is a PUSH of a fresh slash-command
    /// catalogue (a plugin was toggled / installed / hot-reloaded mid-session). It
    /// used to fall into `SystemMsg::Unknown` and be discarded, so the `/` menu kept
    /// serving a command set the live session no longer had.
    #[test]
    fn commands_changed_push_refreshes_the_slash_menu() {
        let mut asm = seeded();
        let push: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "commands_changed",
            "commands": [
                { "name": "pickup", "description": "(plugin) Start a task", "argumentHint": "<id>" },
                { "name": "compact" },
                { "description": "nameless entries are skipped" }
            ]
        }))
        .unwrap();

        let cmds = asm
            .ingest(&push)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::Commands(c) => Some(c),
                _ => None,
            })
            .expect("the push must surface a fresh catalogue");
        assert_eq!(cmds.len(), 2, "the entry without a name is dropped");
        assert_eq!(cmds[0].name, "pickup");
        assert_eq!(cmds[0].argument_hint, "<id>");
        assert_eq!(cmds[1].name, "compact");
        assert_eq!(cmds[1].description, "", "a missing description is empty, not an error");

        // A bare invalidation (no payload) is tolerated and emits nothing.
        let bare: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "commands_changed"
        }))
        .unwrap();
        assert!(asm.ingest(&bare).is_empty());
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
    /// Ingest the result of SendMessage `toolu_s` (see [`ingest_send`]) and return any `Task`
    /// events it emits.
    fn ingest_send_result(asm: &mut Assembler, is_error: bool, text: &str) -> Vec<BackgroundTask> {
        let m: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "user", "session_id": "s", "uuid": "r",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_s", "is_error": is_error,
                 "content": [{"type": "text", "text": text}]}
            ]}
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
    /// A successful SendMessage result, as 2.1.283+ words it.
    const SEND_OK: &str = r#"{"success":true,"message":"Resuming agent x"}"#;

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

    /// The captured SendMessage-wake wire (CLI 2.1.286): launch + first run (lines 1..=7),
    /// then the wake (8..=14) — whose `task_started` (line 9) and terminal events carry the
    /// SENDMESSAGE's tool_use_id, while the woken agent's own messages still name the
    /// ORIGINAL `Agent` as parent.
    const WAKE_FIXTURE: &str = include_str!("fixtures/capture_subagent_wake.jsonl");
    const WAKE_TASK: &str = "a68e26aa615c9f436"; // task_id == agentId (stable across the wake)
    /// Index of the `SendMessage` line — where the wake half of the fixture starts.
    const WAKE_SEND_LINE: usize = 7;

    fn wake_fixture_lines() -> Vec<&'static str> {
        let lines: Vec<&str> = WAKE_FIXTURE.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 14, "fixture shape: launch (1..=7) + wake (8..=14)");
        lines
    }

    /// Feed `lines` and return the `WAKE_TASK` snapshot after each one (`None` until the task
    /// first appears).
    fn wake_snapshots(asm: &mut Assembler, lines: &[&str]) -> Vec<Option<BackgroundTask>> {
        let mut last: Option<BackgroundTask> = None;
        lines
            .iter()
            .map(|line| {
                let msg: CliMessage = serde_json::from_str(line).unwrap();
                for ev in asm.ingest(&msg) {
                    if let SessionEvent::Task(t) = ev {
                        if t.task_id == WAKE_TASK {
                            last = Some(t);
                        }
                    }
                }
                last.clone()
            })
            .collect()
    }

    /// First `Task` event an ingest emits.
    fn first_task(asm: &mut Assembler, msg: serde_json::Value) -> Option<BackgroundTask> {
        let msg: CliMessage = serde_json::from_value(msg).unwrap();
        asm.ingest(&msg).into_iter().find_map(|e| match e {
            SessionEvent::Task(t) => Some(t),
            _ => None,
        })
    }

    /// REGRESSION (task f267b721): a detached background sub-agent RESUMED via `SendMessage`
    /// must re-surface as Running, in the SAME process that launched it (warm registry). The
    /// wire re-uses the agent's task_id (== its agentId); the wake's own `task_started` flips
    /// the tracked task back to Running, and neither it nor the run's terminal events (all
    /// under the SendMessage's tool_use_id) may clobber the identity the AgentBar keys on.
    #[test]
    fn send_message_wake_reactivates_a_completed_background_agent() {
        let lines = wake_fixture_lines();
        let mut asm = Assembler::new();
        let snaps = wake_snapshots(&mut asm, &lines);

        // First run finished: Completed, Agent, with its usage roll-up and model folded in.
        let done = snaps[WAKE_SEND_LINE - 1].clone().expect("the launched agent should have a tracked task");
        assert_eq!(done.status, BackgroundTaskStatus::Completed, "the agent finished its first run");
        assert_eq!(done.kind, BackgroundTaskKind::Agent);
        assert_eq!(done.tool_use_id.as_deref(), Some("toolu_agent"));
        assert_eq!(done.tokens, Some(1234));
        assert_eq!(done.tool_uses, Some(1));
        assert_eq!(done.model.as_deref(), Some("claude-opus-5-5"));
        assert!(done.woken_by.is_none(), "a plain launch is not a wake");

        // The SendMessage alone changes nothing: it may still fail.
        let sent = snaps[WAKE_SEND_LINE].clone().unwrap();
        assert_eq!(sent.status, BackgroundTaskStatus::Completed, "no flip on the tool_use alone");

        // The wake's own `task_started` flips it back to Running, KEEPS the original Agent
        // tool_use_id, RESETS the prior run's stale roll-up and flags the wake.
        let woke = snaps[WAKE_SEND_LINE + 1].clone().expect("the wake must re-emit the agent's task");
        assert_eq!(woke.status, BackgroundTaskStatus::Running, "the resumed agent is Running again");
        assert_eq!(woke.tool_use_id.as_deref(), Some("toolu_agent"));
        assert_eq!(woke.kind, BackgroundTaskKind::Agent);
        assert_eq!(woke.tokens, None, "the prior run's token count must not show on the running row");
        assert_eq!(woke.tool_uses, None);
        assert_eq!(woke.duration_ms, None);
        assert_eq!(woke.woken_by.as_deref(), Some("toolu_send"), "the SendMessage that started this run");
        assert_eq!(woke.agent_id.as_deref(), Some(WAKE_TASK));

        // The SendMessage's successful result, after it, is a no-op on the running entry.
        let acked = snaps[WAKE_SEND_LINE + 2].clone().unwrap();
        assert_eq!(acked, woke, "the result re-emits nothing new");

        // After the full wake — incl. the terminal `task_notification` whose tool_use_id is the
        // SendMessage id — the task settles Completed but its identity must be UNCLOBBERED
        // (still the Agent tool_use_id), now carrying run #2's roll-up.
        let end = snaps.last().cloned().flatten().expect("a final snapshot");
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

    /// REGRESSION (task 9ab0edf7): the wake on a COLD registry — the conversation was reloaded
    /// (or its session re-spawned) between the launch and the wake, so this assembler never saw
    /// the agent. The wake's `task_started` CREATES the entry under the SendMessage's
    /// tool_use_id, which the front's `bgAgentIds` (original `Agent` ids, rehydrated from the
    /// transcript) never holds: without the `woken_by` mark the woken agent read as FOREGROUND
    /// and the AgentBar hid it. Its `agent_id` must be known too, or the drill-in has nothing
    /// to read (the SendMessage's result carries no launch ack).
    #[test]
    fn send_message_wake_on_a_cold_registry_is_a_background_agent() {
        let lines = wake_fixture_lines();
        let mut asm = Assembler::new();
        let snaps = wake_snapshots(&mut asm, &lines[WAKE_SEND_LINE..]);

        assert!(snaps[0].is_none(), "the SendMessage alone matches no task on a cold registry");
        let woke = snaps[1].clone().expect("the wake's task_started creates the task");
        assert_eq!(woke.kind, BackgroundTaskKind::Agent);
        assert_eq!(woke.status, BackgroundTaskStatus::Running);
        assert_eq!(woke.tool_use_id.as_deref(), Some("toolu_send"), "the only id the wake carries");
        assert!(woke.woken_by.is_some(), "a woken agent is background work whatever its tool_use_id");
        assert_eq!(woke.agent_id.as_deref(), Some(WAKE_TASK), "task_id == agentId → drillable");
        assert_eq!(woke.label.as_deref(), Some("Sleep then reply BANANA"), "the ORIGINAL description");
        assert_eq!(woke.subagent_type.as_deref(), Some("general-purpose"));

        let end = snaps.last().cloned().flatten().expect("a final snapshot");
        assert_eq!(end.status, BackgroundTaskStatus::Completed);
        assert!(end.woken_by.is_some());
        assert_eq!(end.tokens, Some(2345));
        // No launch to find (no resolver — e.g. a session hosted on another machine): the
        // woken agent's messages name a parent no task carries, so its model is lost here and
        // the front resolves the launch from the rehydrated ack instead.
        assert_eq!(end.model, None);
    }

    /// The init line that gives the assembler its session id (what the launch resolver reads).
    fn ingest_init(asm: &mut Assembler, session_id: &str) {
        let init: CliMessage = serde_json::from_value(serde_json::json!({
            "type": "system", "subtype": "init",
            "session_id": session_id, "uuid": "u", "cwd": "/x",
            "model": "claude-opus-5-5", "permissionMode": "default",
            "tools": [], "slash_commands": []
        }))
        .unwrap();
        asm.ingest(&init);
    }

    /// The sidecar as the wake fixture's session would hold it: the woken agent was launched
    /// by `toolu_agent` in session `s`.
    fn fixture_launch_resolver(session_id: &str, agent_id: &str) -> Option<String> {
        (session_id == "s" && agent_id == WAKE_TASK).then(|| "toolu_agent".to_string())
    }

    /// Task 9ab0edf7 (review): a COLD wake whose launch is on disk is RE-KEYED onto the
    /// launching `Agent` id — the id its own messages stream under — so it behaves exactly
    /// like a warm wake: the model is captured, the live drill-in finds its sub-thread, and
    /// the front's rehydrated `bgAgentIds` holds its id.
    #[test]
    fn a_cold_wake_is_rekeyed_onto_its_launching_agent() {
        let lines = wake_fixture_lines();
        let mut asm = Assembler::new();
        asm.set_launch_resolver(fixture_launch_resolver);
        ingest_init(&mut asm, "s");
        let snaps = wake_snapshots(&mut asm, &lines[WAKE_SEND_LINE..]);

        let woke = snaps[1].clone().expect("the wake's task_started creates the task");
        assert_eq!(woke.tool_use_id.as_deref(), Some("toolu_agent"), "re-keyed onto the launch");
        assert!(woke.woken_by.is_some());
        assert_eq!(woke.agent_id.as_deref(), Some(WAKE_TASK));
        let end = snaps.last().cloned().flatten().expect("a final snapshot");
        assert_eq!(end.model.as_deref(), Some("claude-opus-5-5"), "the woken agent's messages now correlate");
        assert_eq!(end.tool_use_id.as_deref(), Some("toolu_agent"), "the SendMessage-keyed events never clobber it");
        assert_eq!(end.status, BackgroundTaskStatus::Completed);
        assert_eq!(end.tokens, Some(2345));
    }

    /// The real wire announces the SendMessage on the STREAM (`content_block_start`) before
    /// the wake's `task_started`, and the assembled message can land after it: the stream
    /// registration alone must be enough to recognise the wake.
    #[test]
    fn a_streamed_send_message_is_known_before_its_wake_task_started() {
        let mut asm = Assembler::new();
        first_task(
            &mut asm,
            serde_json::json!({
                "type": "stream_event", "session_id": "s", "uuid": "u",
                "event": {"type": "content_block_start", "index": 0,
                          "content_block": {"type": "tool_use", "id": "toolu_send", "name": "SendMessage", "input": {}}}
            }),
        );
        let t = first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_started", "task_id": "agentQ",
                "tool_use_id": "toolu_send", "description": "x", "task_type": "local_agent"
            }),
        )
        .expect("task_started emits the task");
        assert_eq!(t.kind, BackgroundTaskKind::Agent);
        assert!(t.woken_by.is_some(), "recognised as a wake from the streamed announcement alone");
        assert_eq!(t.agent_id.as_deref(), Some("agentQ"));
    }

    /// A sub-agent's SendMessage (streamed AND assembled under its parent) and the wake's
    /// `task_started` under its id: the target revives, but never as a conversation-level wake.
    fn nested_wake(asm: &mut Assembler, target: &str) -> BackgroundTask {
        first_task(
            asm,
            serde_json::json!({
                "type": "stream_event", "session_id": "s", "uuid": "u", "parent_tool_use_id": "toolu_child",
                "event": {"type": "content_block_start", "index": 0,
                          "content_block": {"type": "tool_use", "id": "toolu_nested_send", "name": "SendMessage", "input": {}}}
            }),
        );
        first_task(
            asm,
            serde_json::json!({
                "type": "assistant", "parent_tool_use_id": "toolu_child", "session_id": "s", "uuid": "u2",
                "message": {"id": "m", "role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_nested_send", "name": "SendMessage",
                     "input": {"to": target, "message": "go", "summary": "go"}}
                ]}
            }),
        );
        first_task(
            asm,
            serde_json::json!({
                "type": "system", "subtype": "task_started", "task_id": target,
                "tool_use_id": "toolu_nested_send", "description": "x", "task_type": "local_agent"
            }),
        )
        .expect("the nested wake's task_started re-emits the task")
    }

    /// NESTING: a SUB-AGENT waking its own agent (SendMessage under a parent) revives it, but
    /// never flags it as a conversation-level wake — the front keeps a grandchild out of the
    /// AgentBar exactly as it kept its launch out.
    #[test]
    fn a_sub_agent_waking_its_own_agent_is_not_a_conversation_wake() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "grandchild", "toolu_gc_launch", "local_agent");
        let started = nested_wake(&mut asm, "grandchild");
        assert_eq!(started.status, BackgroundTaskStatus::Running, "the nested wake still revives it");
        assert!(started.woken_by.is_none(), "a nested wake is not the conversation's");
        assert_eq!(started.tool_use_id.as_deref(), Some("toolu_gc_launch"));
    }

    /// `woken_by` is per RUN: an agent the main thread once woke, then later woken by a
    /// sub-agent, is not a conversation-level wake for that later run.
    #[test]
    fn woken_by_is_per_run() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        ingest_send(&mut asm, "t1");
        let main = first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_started", "task_id": "t1",
                "tool_use_id": "toolu_s", "description": "x", "task_type": "local_agent"
            }),
        )
        .unwrap();
        assert!(main.woken_by.is_some());
        first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_notification", "task_id": "t1",
                "tool_use_id": "toolu_s", "status": "completed"
            }),
        );
        let nested = nested_wake(&mut asm, "t1");
        assert_eq!(nested.status, BackgroundTaskStatus::Running);
        assert!(nested.woken_by.is_none(), "the earlier main-thread wake does not carry over");
    }

    /// Nothing revives on the SendMessage tool_use alone. A pre-2.1.283 binary (no wake
    /// `task_started`) revives the target on the SendMessage's SUCCESSFUL result; a FAILED one
    /// (error result — interrupted, refused — or `success:false`) leaves it as it was, with no
    /// event at all — no Running to undo, no false "finished" for the front to announce.
    #[test]
    fn a_send_message_wakes_only_on_success() {
        // Old binary: the successful result is the wake.
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        assert!(ingest_send(&mut asm, "t1").is_empty(), "no flip on the tool_use alone");
        let woke = ingest_send_result(&mut asm, false, SEND_OK);
        assert_eq!(woke.len(), 1);
        assert_eq!(woke[0].status, BackgroundTaskStatus::Running);
        assert!(woke[0].woken_by.is_some());
        assert_eq!(woke[0].tool_use_id.as_deref(), Some("toolu_agent"));
        assert_eq!(woke[0].tokens, None, "the prior run's roll-up is cleared");

        // An error result: nothing happens.
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        ingest_send(&mut asm, "t1");
        assert!(ingest_send_result(&mut asm, true, "[Request interrupted by user for tool use]").is_empty());

        // `success:false` in the body: nothing happens either.
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        ingest_send(&mut asm, "t1");
        assert!(ingest_send_result(&mut asm, false, r#"{"success":false,"message":"No agent named t1"}"#).is_empty());
        let still = first_task(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "t1", "patch": {}}),
        )
        .unwrap();
        assert_eq!(still.status, BackgroundTaskStatus::Completed);
        assert_eq!(still.tokens, Some(999), "the first run's roll-up is untouched");
    }

    /// A wake inferred without its `task_started` (old binary: the SendMessage result) of an
    /// agent LAUNCHED in the foreground: the woken run is background work, so the launch's
    /// `is_backgrounded:false` must not keep it out of the counts and the AgentBar.
    #[test]
    fn an_inferred_wake_of_a_foreground_launch_is_background_work() {
        let mut asm = Assembler::new();
        task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "t1", "tool_use_id": "toolu_agent",
                "description": "x", "is_backgrounded": false, "spawn_depth": 1, "task_type": "local_agent"}),
        );
        task_events(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_notification", "task_id": "t1", "status": "completed",
                "output_file": "", "summary": "x"}),
        );
        ingest_send(&mut asm, "t1");
        let woke = ingest_send_result(&mut asm, false, SEND_OK);
        assert_eq!((woke[0].status, woke[0].backgrounded), (BackgroundTaskStatus::Running, Some(true)));
    }

    /// Task 9ab0edf7 (review round 3): the SendMessage result is no wake signal once the wire
    /// reported the run itself. A BLOCKING resume (background tasks disabled, the built-in
    /// `web-fetch` agent) answers only after the woken run ENDED — reviving on that result
    /// left a finished agent Running for good.
    #[test]
    fn a_send_message_result_after_the_reported_run_does_not_revive_it() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        ingest_send(&mut asm, "t1");
        for line in [
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "t1",
                               "tool_use_id": "toolu_s", "description": "x", "task_type": "local_agent"}),
            serde_json::json!({"type": "system", "subtype": "task_progress", "task_id": "t1",
                               "tool_use_id": "toolu_s", "description": "Running Read"}),
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "t1",
                               "patch": {"status": "completed"}}),
            serde_json::json!({"type": "system", "subtype": "task_notification", "task_id": "t1",
                               "tool_use_id": "toolu_s", "status": "completed",
                               "usage": {"total_tokens": 42}}),
        ] {
            first_task(&mut asm, line);
        }
        assert!(
            ingest_send_result(&mut asm, false, r#"{"success":true,"message":"t1 replied: done"}"#).is_empty(),
            "the finished woken run stays finished"
        );
        let end = first_task(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_updated", "task_id": "t1", "patch": {}}),
        )
        .unwrap();
        assert_eq!(end.status, BackgroundTaskStatus::Completed);
        assert_eq!(end.tokens, Some(42), "its roll-up is kept");
    }

    /// A SendMessage to a RUNNING agent only queues a message ("Message queued for delivery…")
    /// — no new run. Its result must not revive the agent if that run finished meanwhile.
    #[test]
    fn a_send_message_to_a_running_agent_is_no_wake() {
        let mut asm = Assembler::new();
        first_task(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_started", "task_id": "t1",
                               "tool_use_id": "toolu_agent", "description": "x", "task_type": "local_agent"}),
        );
        ingest_send(&mut asm, "t1");
        first_task(
            &mut asm,
            serde_json::json!({"type": "system", "subtype": "task_notification", "task_id": "t1",
                               "tool_use_id": "toolu_agent", "status": "completed"}),
        );
        assert!(
            ingest_send_result(
                &mut asm,
                false,
                r#"{"success":true,"message":"Message queued for delivery to t1 at its next tool round."}"#
            )
            .is_empty(),
            "a queued message woke nothing"
        );
    }

    /// The wake's `task_started` is the wire's OWN word that the agent runs again — unlike the
    /// inferred flips, it revives a STOPPED agent too (the Stop already took effect; this is a
    /// new run). Without it the woken agent would sit Stopped while it works.
    #[test]
    fn a_wake_task_started_revives_a_stopped_agent() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "t1", "toolu_agent", "local_agent");
        first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_updated", "task_id": "t1",
                "patch": {"status": "stopped"}
            }),
        );
        ingest_send(&mut asm, "t1");
        assert!(
            ingest_send_result(&mut asm, false, SEND_OK).is_empty(),
            "the inference alone (an acked SendMessage) leaves it Stopped"
        );

        let t = first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_started", "task_id": "t1",
                "tool_use_id": "toolu_s", "description": "x", "task_type": "local_agent"
            }),
        )
        .expect("task_started re-emits the task");
        assert_eq!(t.status, BackgroundTaskStatus::Running);
        assert_eq!(t.tool_use_id.as_deref(), Some("toolu_agent"), "identity preserved");
        assert_eq!(t.tokens, None, "the stopped run's roll-up is cleared");
        assert!(t.woken_by.is_some());
    }

    /// Backstop: an event for an UNSEEN task under a `SendMessage` id (its `task_started` was
    /// missed — e.g. the stream was joined mid-wake) is still a woken sub-agent, not an
    /// unclassifiable `Other` task the AgentBar would never list.
    #[test]
    fn an_unseen_task_under_a_send_message_id_is_a_woken_agent() {
        let mut asm = Assembler::new();
        ingest_send(&mut asm, "agentZ");
        let t = first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_progress", "task_id": "agentZ",
                "tool_use_id": "toolu_s", "description": "Running Read"
            }),
        )
        .expect("the tick creates the task");
        assert_eq!(t.kind, BackgroundTaskKind::Agent);
        assert_eq!(t.status, BackgroundTaskStatus::Running);
        assert!(t.woken_by.is_some());
        assert_eq!(t.agent_id.as_deref(), Some("agentZ"));
    }

    /// A launch whose tool_use is NOT a SendMessage is never flagged as a wake — the flag would
    /// otherwise pull a FOREGROUND sub-agent into the AgentBar.
    #[test]
    fn a_launch_is_never_flagged_as_a_wake() {
        let mut asm = Assembler::new();
        ingest_send(&mut asm, "someone"); // a SendMessage exists, under another id
        let t = first_task(
            &mut asm,
            serde_json::json!({
                "type": "system", "subtype": "task_started", "task_id": "fg1",
                "tool_use_id": "toolu_fg", "description": "x", "task_type": "local_agent"
            }),
        )
        .unwrap();
        assert!(t.woken_by.is_none());
        assert_eq!(t.agent_id, None);
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
        // A bare tick can't tell which thread woke the agent (a sub-agent may wake its own),
        // so it never flags the run as a conversation-level wake.
        assert!(t.woken_by.is_none(), "the backstop revives without claiming a main-thread wake");
        assert_eq!(t.agent_id, None);
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

        // A later SendMessage to it, even acked, emits nothing (the helper's scoping refuses a
        // non-Completed task)…
        ingest_send(&mut asm, "t1");
        assert!(
            ingest_send_result(&mut asm, false, SEND_OK).is_empty(),
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

    /// SELECTIVITY (hardening from the adversarial review): against a POPULATED store, an
    /// acked SendMessage (`wake_on_send_message_result`) flips ONLY a matching Completed
    /// AGENT. A teammate NAME matches no task_id; a `to` matching a non-agent (Bash) task is
    /// scoped out by kind.
    #[test]
    fn send_message_resume_is_selective() {
        let mut asm = Assembler::new();
        seed_completed(&mut asm, "agentX", "toolu_agent", "local_agent");
        seed_completed(&mut asm, "bashY", "toolu_bash", "local_bash");
        let send_acked = |asm: &mut Assembler, to: &str| {
            ingest_send(asm, to);
            ingest_send_result(asm, false, SEND_OK)
        };

        // A teammate NAME / "main" matches no task_id → no flip at all.
        assert!(send_acked(&mut asm, "researcher").is_empty(), "a teammate name matches no task");
        assert!(send_acked(&mut asm, "main").is_empty(), "\"main\" matches no task");
        // A `to` matching a non-agent (Bash) task → scoped out by the kind guard → no flip.
        assert!(send_acked(&mut asm, "bashY").is_empty(), "a Bash task must not be resurrected");
        // A `to` matching the completed agent → flips exactly that one to Running.
        let flipped = send_acked(&mut asm, "agentX");
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
        // A `/goal <condition>` SET echo, in the CLI's wrapped shape — used as both the wire line
        // and the expected bubble text, so live and reload must agree it survives.
        let goal_set_echo = "<command-name>/goal</command-name>\n<command-args>ship the site</command-args>";
        // A sub-agent hand-back: the bare frame mid-turn, wrapped in a preamble + a trailing
        // note when it opens a turn of its own (both shapes VERIFIED live on 2.1.293).
        let handback_frame = "<agent-message from=\"a57593c84fc7315e8\">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n  KIWI\n  - done\n</agent-message>";
        let handback_turn_start: &str = &format!(
            "Another Claude session sent a message:\n{handback_frame}\n\nThat \"other Claude session\" is an agent working inside this same session."
        );
        let handback_origin = json!({"kind":"peer","from":"a57593c84fc7315e8","senderTaskId":"a57593c84fc7315e8",
            "name":"general-purpose","body":"[Subagent hand-back] …\n  KIWI\n  - done","handback":true});
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
                "/goal stdout plumbing (dropped)",
                json!({"type":"user","uuid":"u12","message":{"role":"user","content":text_content(
                    "<local-command-stdout>Goal set: all tests pass</local-command-stdout>")}}),
                json!({"type":"user","uuid":"u12","message":{"role":"user","content":text_content(
                    "<local-command-stdout>Goal set: all tests pass</local-command-stdout>")}}),
                vec![],
            ),
            (
                // A `/goal <condition>` SET is now shown in the thread (rendered as a "Goal set"
                // card by the front). The echo flows through as a user message on BOTH surfaces.
                "a /goal SET echo (kept — rendered as a Goal card)",
                json!({"type":"user","uuid":"u13","message":{"role":"user","content":text_content(goal_set_echo)}}),
                json!({"type":"user","uuid":"u13","message":{"role":"user","content":text_content(goal_set_echo)}}),
                vec![goal_set_echo],
            ),
            (
                // …but a `/goal clear` echo stays plumbing (represented by the target chip).
                "a /goal clear echo (dropped)",
                json!({"type":"user","uuid":"u14","message":{"role":"user","content":text_content(
                    "<command-name>/goal</command-name>\n<command-args>clear</command-args>")}}),
                json!({"type":"user","uuid":"u14","message":{"role":"user","content":text_content(
                    "<command-name>/goal</command-name>\n<command-args>clear</command-args>")}}),
                vec![],
            ),
            (
                // A sub-agent's report opening a turn (claude 2.1.293): injected, but SHOWN.
                "a sub-agent hand-back opening a turn (kept — rendered as a report card)",
                json!({"type":"user","uuid":"u15","isSynthetic":true,"isReplay":true,"origin":handback_origin,
                       "message":{"role":"user","content":handback_turn_start}}),
                json!({"type":"user","uuid":"u15","isMeta":true,"origin":handback_origin,
                       "message":{"role":"user","content":handback_turn_start}}),
                vec![handback_turn_start],
            ),
            (
                // Mid-turn the disk keeps NO user line: only a `queued_command` attachment.
                "a sub-agent hand-back landing mid-turn (kept — attachment on disk)",
                json!({"type":"user","uuid":"u16","isSynthetic":true,"isReplay":true,"origin":handback_origin,
                       "message":{"role":"user","content":handback_frame}}),
                json!({"type":"attachment","uuid":"u16","attachment":{"type":"queued_command",
                       "commandMode":"prompt","isMeta":true,"origin":handback_origin,"prompt":handback_frame}}),
                vec![handback_frame],
            ),
            (
                // Same `peer` origin without the hand-back mark (a teammate / peer session):
                // still plumbing on both surfaces.
                "a peer message that is not a hand-back (dropped)",
                json!({"type":"user","uuid":"u17","isSynthetic":true,"origin":{"kind":"peer","from":"s1"},
                       "message":{"role":"user","content":"Another Claude session sent a message: hi"}}),
                json!({"type":"user","uuid":"u17","isMeta":true,"origin":{"kind":"peer","from":"s1"},
                       "message":{"role":"user","content":"Another Claude session sent a message: hi"}}),
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
