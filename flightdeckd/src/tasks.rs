//! Per-session registry of claude's background tasks — the daemon's own view of
//! "is background work running", fed from the `system/task_*` edges and the
//! `system/background_tasks_changed` level that already flow through
//! `SessionActor::on_claude_line`.
//!
//! Why the daemon needs it (it is otherwise a transparent pipe): the phone talks
//! to THIS process, not to the Mac, so everything the Mac derives from its own
//! task registry must exist here too — the `task_finished` push, the green
//! `backgrounding` status, the background-task list and its Stop button, and the
//! suppression of a "ready for review" push for a turn that ended while work
//! still runs (the Mac suppresses exactly that ping for its local conversations).
//!
//! The rules MIRROR the Mac's (`src/store/backgroundTasksStore.ts`
//! `isBackgroundActivity`, `src-tauri/src/supervisor/assembler.rs`
//! `map_status` / `classify_task` / `ingest_background_level`) so a conversation
//! reads the same whichever host the phone asks:
//!  - background ACTIVITY = running, not registered in the foreground
//!    (`is_backgrounded:false`: a foreground sub-agent or a long foreground `Bash`
//!    the CLI tracks so it can be moved to the background later), and not
//!    `ambient` housekeeping (memory consolidation, auto-mode scan…);
//!  - a task's run ENDS on its first terminal `task_updated` or its
//!    `task_notification` — one `task_finished` per run (a `SendMessage` wake
//!    starts a new run of the same task id);
//!  - the level never ADDS a task (the daemon sees every edge of its own
//!    process); it re-announces `ambient`, and a running task that LEFT it is
//!    parked and retired as `stopped` only once an unrelated line shows its own
//!    edge is not coming (the CLI writes a transition's level and its edges back
//!    to back) — the cure the CLI documents for "a missed bookend wedging a stale
//!    running indicator".
//!
//! Everything here is pure (no I/O, no clock) so it is tested line by line.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

/// How many tasks a session remembers. Finished ones stay listed (the phone's
/// list shows final statuses, like the Mac's) until this many newer tasks push
/// them out; a RUNNING task is never evicted.
const TASKS_KEPT: usize = 256;
/// How many recent `tool_use` ids (of the tools that produce tasks) are kept to
/// classify a task and to recognize an `Agent` launch.
const TOOL_INDEX_MAX: usize = 4096;
/// A background `Bash` command, as listed to the phone (the Mac clips the same).
const COMMAND_CLIP: usize = 400;

/// The tools whose `tool_use` ids are worth remembering: the four task
/// producers, the legacy name of `Agent`, and the `SendMessage` that wakes a
/// finished sub-agent (its id then keys the woken run's `task_started`).
const INDEXED_TOOLS: &[&str] = &["Agent", "Task", "Workflow", "Bash", "Monitor", "SendMessage"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Agent,
    Workflow,
    Bash,
    Monitor,
    Other,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskKind::Agent => "agent",
            TaskKind::Workflow => "workflow",
            TaskKind::Bash => "bash",
            TaskKind::Monitor => "monitor",
            TaskKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::Stopped => "stopped",
        }
    }
}

/// The wire status vocabulary, folded like the Mac's `assembler::map_status`.
/// Anything unrecognized reads as still running: a `task_updated` legitimately
/// stays running until a terminal patch, and a `task_notification` caller
/// overrides it (a notification always means the run ended).
pub fn map_status(status: &str) -> TaskStatus {
    match status {
        "completed" | "success" | "done" => TaskStatus::Completed,
        "failed" | "error" | "timeout" | "timed_out" | "expired" => TaskStatus::Failed,
        "stopped" | "cancelled" | "canceled" | "killed" => TaskStatus::Stopped,
        _ => TaskStatus::Running,
    }
}

/// Classify a task's producer like the Mac's `assembler::classify_task`: the
/// tool NAME is the strongest signal (it alone separates a background `Bash`
/// from a `Monitor`, which share `task_type:"local_bash"`), `task_type` the
/// fallback.
fn classify(task_type: Option<&str>, tool_name: Option<&str>) -> TaskKind {
    match tool_name {
        Some("Agent") | Some("Task") => return TaskKind::Agent,
        Some("Workflow") => return TaskKind::Workflow,
        Some("Bash") => return TaskKind::Bash,
        Some("Monitor") => return TaskKind::Monitor,
        _ => {}
    }
    match task_type {
        Some("local_bash") => TaskKind::Bash,
        Some("local_agent") => TaskKind::Agent,
        Some("local_workflow") => TaskKind::Workflow,
        _ => TaskKind::Other,
    }
}

/// One task, as the phone sees it.
#[derive(Debug, Clone)]
pub struct Task {
    pub task_id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    /// The task's `description` (what the Mac's bars print as its name).
    pub label: Option<String>,
    /// The raw shell command of a `Bash` task (clipped) — the readable fallback
    /// when the agent gave the task no description.
    pub command: Option<String>,
    pub subagent_type: Option<String>,
    pub tool_use_id: Option<String>,
    /// `Some(false)` = registered in the FOREGROUND (its tool call blocks on it);
    /// `None` = the CLI did not say (older binaries, workflows) — background.
    pub backgrounded: Option<bool>,
    pub ambient: bool,
    /// The latest `task_progress` description (a workflow's "<phase>: <label>").
    pub progress: Option<String>,
    pub summary: Option<String>,
    pub tokens: Option<u64>,
    pub tool_uses: Option<u64>,
    pub duration_ms: Option<u64>,
}

impl Task {
    /// Background WORK running now — the Mac's `isBackgroundActivity`.
    pub fn is_background_activity(&self) -> bool {
        self.status == TaskStatus::Running && self.backgrounded != Some(false) && !self.ambient
    }

    /// The row `list_background_tasks` returns — the Mac's app-control shape
    /// (`src/agent/appControl.ts` `listBackgroundTasksTool`). `model` is always
    /// null: the daemon does not correlate a sub-agent's messages to its task.
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "task_id": self.task_id,
            "kind": self.kind.as_str(),
            "status": self.status.as_str(),
            "label": self.label,
            "command": self.command,
            "subagent_type": self.subagent_type,
            "model": Value::Null,
            "progress": self.progress,
            "summary": self.summary,
            "tokens": self.tokens,
            "tool_uses": self.tool_uses,
            "duration_ms": self.duration_ms,
        });
        if self.backgrounded == Some(false) {
            v["foreground"] = json!(true);
        }
        if self.ambient {
            v["ambient"] = json!(true);
        }
        v
    }
}

/// A background task's run just ended: what a `task_finished` event carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    pub task_id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub label: Option<String>,
}

struct ToolUse {
    name: String,
    command: Option<String>,
}

#[derive(Default)]
pub struct TaskRegistry {
    tasks: HashMap<String, Task>,
    /// First-seen order (listing + eviction).
    order: VecDeque<String>,
    /// The last `background_tasks_changed` membership.
    live_level: HashSet<String>,
    /// Running tasks that left the level and whose own end edge has not come yet.
    pending_retire: HashSet<String>,
    tools: HashMap<String, ToolUse>,
    tool_order: VecDeque<String>,
    /// Sub-agent task id → the `tool_use` id of the `Agent` call that launched it,
    /// learned in-process (see `SessionActor::enrich_launch`).
    launches: HashMap<String, String>,
}

/// A `system` subtype that belongs to the task lifecycle.
pub fn is_lifecycle(subtype: &str) -> bool {
    matches!(
        subtype,
        "task_started" | "task_progress" | "task_updated" | "task_notification" | "background_tasks_changed"
    )
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let c: String = s.chars().take(max).collect();
        format!("{c}…")
    }
}

impl TaskRegistry {
    /// Remember the task-producing `tool_use` blocks of an `assistant` line (any
    /// thread: a sub-agent launches nested agents and its own shells).
    pub fn note_assistant(&mut self, v: &Value) {
        let Some(blocks) = v["message"]["content"].as_array() else { return };
        for b in blocks {
            if b["type"].as_str() != Some("tool_use") {
                continue;
            }
            let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) else { continue };
            if !INDEXED_TOOLS.contains(&name) || self.tools.contains_key(id) {
                continue;
            }
            let command = (name == "Bash")
                .then(|| b["input"]["command"].as_str().map(|c| clip(c, COMMAND_CLIP)))
                .flatten();
            self.tools.insert(id.to_string(), ToolUse { name: name.to_string(), command });
            self.tool_order.push_back(id.to_string());
            while self.tool_order.len() > TOOL_INDEX_MAX {
                if let Some(old) = self.tool_order.pop_front() {
                    self.tools.remove(&old);
                }
            }
        }
    }

    /// Is `tool_use_id` an `Agent` (or legacy `Task`) call seen in this process?
    pub fn is_agent_launch(&self, tool_use_id: &str) -> bool {
        self.tools.get(tool_use_id).is_some_and(|t| t.name == "Agent" || t.name == "Task")
    }

    /// The launching `Agent` call of sub-agent `task_id`, when this process saw it.
    pub fn launch_of(&self, task_id: &str) -> Option<&str> {
        self.launches.get(task_id).map(String::as_str)
    }

    pub fn remember_launch(&mut self, task_id: &str, tool_use_id: &str) {
        self.launches.insert(task_id.to_string(), tool_use_id.to_string());
    }

    /// Fold one task lifecycle line (`system/task_*` or the level) in. Returns
    /// the background runs it ended (each one → a `task_finished`).
    pub fn ingest(&mut self, v: &Value) -> Vec<Finished> {
        match v["subtype"].as_str().unwrap_or_default() {
            "task_started" => {
                self.on_started(v);
                Vec::new()
            }
            "task_progress" => {
                self.on_progress(v);
                Vec::new()
            }
            "task_updated" => self.on_updated(v).into_iter().collect(),
            "task_notification" => self.on_notification(v).into_iter().collect(),
            "background_tasks_changed" => {
                self.on_level(v);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// An unrelated line arrived: any task parked by the level whose own end
    /// edge never followed is not getting one — retire it as `stopped` (an end
    /// we could not observe) rather than leave the conversation "backgrounding"
    /// forever.
    pub fn retire_orphans(&mut self) -> Vec<Finished> {
        let mut out = Vec::new();
        for id in std::mem::take(&mut self.pending_retire) {
            if let Some(task) = self.tasks.get_mut(&id) {
                if task.status == TaskStatus::Running {
                    tracing::warn!("background task {id} left the live set with no task_* end event; marking it stopped");
                    let was_activity = task.is_background_activity();
                    task.status = TaskStatus::Stopped;
                    out.extend(ended(was_activity, task));
                }
            }
        }
        out
    }

    pub fn has_pending_retire(&self) -> bool {
        !self.pending_retire.is_empty()
    }

    /// How many background tasks are running now (what `backgrounding` counts).
    pub fn background_running(&self) -> usize {
        self.tasks.values().filter(|t| t.is_background_activity()).count()
    }

    pub fn get(&self, task_id: &str) -> Option<&Task> {
        self.tasks.get(task_id)
    }

    /// Every remembered task, first-seen first.
    pub fn snapshot(&self) -> Vec<Task> {
        self.order.iter().filter_map(|id| self.tasks.get(id)).cloned().collect()
    }

    fn on_started(&mut self, v: &Value) {
        let Some(task_id) = str_of(v, "task_id") else { return };
        let tool_use_id = str_of(v, "tool_use_id");
        let tool = tool_use_id.as_deref().and_then(|id| self.tools.get(id));
        let tool_name = tool.map(|t| t.name.clone());
        let command = tool.and_then(|t| t.command.clone());
        let task_type = str_of(v, "task_type");
        let kind = classify(task_type.as_deref(), tool_name.as_deref());
        if task_type.as_deref() == Some("local_agent") {
            if let Some(id) = tool_use_id.as_deref().filter(|id| self.is_agent_launch(id)) {
                self.remember_launch(&task_id, id);
            }
        }
        let ambient = v["ambient"].as_bool() == Some(true) || v["skip_transcript"].as_bool() == Some(true);
        let backgrounded = v["is_backgrounded"].as_bool();
        let task = self.entry(&task_id, kind);
        // A woken sub-agent's run is keyed on the SendMessage call: its kind
        // stays the one its launch gave it (only an `Other` is refined).
        if task.kind == TaskKind::Other {
            task.kind = kind;
        }
        // A finished task starting again (a `SendMessage` wake) is a NEW run: the
        // previous run's progress line and usage roll-up would otherwise be listed
        // as this run's until its first `task_progress` (the Mac's
        // `restart_agent_run` clears the same).
        if task.status != TaskStatus::Running {
            task.progress = None;
            task.tokens = None;
            task.tool_uses = None;
            task.duration_ms = None;
        }
        task.status = TaskStatus::Running;
        task.tool_use_id = tool_use_id.or(task.tool_use_id.take());
        if let Some(d) = str_of(v, "description") {
            task.label = Some(d);
        }
        if let Some(s) = str_of(v, "subagent_type") {
            task.subagent_type = Some(s);
        }
        if command.is_some() {
            task.command = command;
        }
        task.backgrounded = backgrounded;
        task.ambient = ambient;
        task.summary = None;
        self.pending_retire.remove(&task_id);
    }

    fn on_progress(&mut self, v: &Value) {
        let Some(task_id) = str_of(v, "task_id") else { return };
        let Some(task) = self.tasks.get_mut(&task_id) else { return };
        if let Some(d) = str_of(v, "description") {
            task.progress = Some(d);
        }
        apply_usage(task, &v["usage"]);
    }

    fn on_updated(&mut self, v: &Value) -> Option<Finished> {
        let task_id = str_of(v, "task_id")?;
        let task = self.tasks.get_mut(&task_id)?;
        let was_activity = task.is_background_activity();
        let patch = &v["patch"];
        if let Some(status) = patch["status"].as_str() {
            task.status = map_status(status);
        }
        if let Some(b) = patch["is_backgrounded"].as_bool() {
            task.backgrounded = Some(b);
        }
        if task.status != TaskStatus::Running {
            self.pending_retire.remove(&task_id);
        }
        let task = self.tasks.get(&task_id)?;
        ended(was_activity, task)
    }

    fn on_notification(&mut self, v: &Value) -> Option<Finished> {
        let task_id = str_of(v, "task_id")?;
        self.pending_retire.remove(&task_id);
        let task = self.tasks.get_mut(&task_id)?;
        let was_activity = task.is_background_activity();
        // A notification ALWAYS means the run ended: an unrecognized status
        // must not leave it running (logged, then read as completed).
        task.status = match v["status"].as_str() {
            Some(s) => match map_status(s) {
                TaskStatus::Running => {
                    tracing::warn!("task_notification with unrecognized terminal status {s:?}; treating as completed");
                    TaskStatus::Completed
                }
                terminal => terminal,
            },
            None => TaskStatus::Completed,
        };
        if let Some(s) = str_of(v, "summary") {
            task.summary = Some(s);
        }
        if v["ambient"].as_bool() == Some(true) || v["skip_transcript"].as_bool() == Some(true) {
            task.ambient = true;
        }
        apply_usage(task, &v["usage"]);
        ended(was_activity, task)
    }

    fn on_level(&mut self, v: &Value) {
        let Some(entries) = v["tasks"].as_array() else {
            tracing::warn!("background_tasks_changed without a task list; ignored");
            return;
        };
        let mut level = HashSet::new();
        for e in entries {
            let Some(id) = e["task_id"].as_str() else { continue };
            level.insert(id.to_string());
            if let Some(task) = self.tasks.get_mut(id) {
                // The CLI omits the flag when false.
                task.ambient = e["ambient"].as_bool() == Some(true);
            }
        }
        for id in self.live_level.difference(&level) {
            if self.tasks.get(id).is_some_and(|t| t.status == TaskStatus::Running) {
                self.pending_retire.insert(id.clone());
            }
        }
        // Back in the set (a woken agent): live again, nothing to retire.
        self.pending_retire.retain(|id| !level.contains(id));
        self.live_level = level;
    }

    /// The task `task_id`, created (and older finished tasks evicted) if new.
    fn entry(&mut self, task_id: &str, kind: TaskKind) -> &mut Task {
        if !self.tasks.contains_key(task_id) {
            self.tasks.insert(
                task_id.to_string(),
                Task {
                    task_id: task_id.to_string(),
                    kind,
                    status: TaskStatus::Running,
                    label: None,
                    command: None,
                    subagent_type: None,
                    tool_use_id: None,
                    backgrounded: None,
                    ambient: false,
                    progress: None,
                    summary: None,
                    tokens: None,
                    tool_uses: None,
                    duration_ms: None,
                },
            );
            self.order.push_back(task_id.to_string());
            self.evict();
        }
        self.tasks.get_mut(task_id).expect("just inserted")
    }

    /// Drop the oldest FINISHED tasks past the cap (a running one is never
    /// evicted — the counts and the Stop button depend on it).
    fn evict(&mut self) {
        while self.tasks.len() > TASKS_KEPT {
            let Some(pos) = self
                .order
                .iter()
                .position(|id| self.tasks.get(id).map(|t| t.status != TaskStatus::Running).unwrap_or(true))
            else {
                return;
            };
            if let Some(id) = self.order.remove(pos) {
                self.tasks.remove(&id);
                self.launches.remove(&id);
            }
        }
    }
}

fn apply_usage(task: &mut Task, usage: &Value) {
    if let Some(n) = usage["total_tokens"].as_u64() {
        task.tokens = Some(n);
    }
    if let Some(n) = usage["tool_uses"].as_u64() {
        task.tool_uses = Some(n);
    }
    if let Some(n) = usage["duration_ms"].as_u64() {
        task.duration_ms = Some(n);
    }
}

/// The run-ending edge of a task that WAS background activity a moment ago.
fn ended(was_activity: bool, task: &Task) -> Option<Finished> {
    (was_activity && task.status != TaskStatus::Running).then(|| Finished {
        task_id: task.task_id.clone(),
        kind: task.kind,
        status: task.status,
        label: task.label.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /// Feed a fixture-shaped line; non-lifecycle lines retire orphans first,
    /// exactly like the session actor does.
    fn feed(r: &mut TaskRegistry, raw: &str) -> Vec<Finished> {
        let v = line(raw);
        if v["type"] == "assistant" {
            r.note_assistant(&v);
        }
        let lifecycle = v["type"] == "system" && is_lifecycle(v["subtype"].as_str().unwrap_or_default());
        let mut out = Vec::new();
        if !lifecycle {
            out.extend(r.retire_orphans());
        }
        if lifecycle {
            out.extend(r.ingest(&v));
        }
        out
    }

    fn tool_use(id: &str, name: &str, input: Value) -> String {
        json!({"type": "assistant", "parent_tool_use_id": null,
               "message": {"id": "m", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
        .to_string()
    }

    /// The live capture `capture_tasks_live.jsonl`, task lines only (abridged):
    /// a background Bash, a Monitor, a background sub-agent, a foreground Bash
    /// and one launched INSIDE the sub-agent.
    #[test]
    fn the_live_capture_finishes_each_background_run_exactly_once() {
        let mut r = TaskRegistry::default();
        let mut finished = Vec::new();
        let script = [
            tool_use("tu_bash", "Bash", json!({"command": "sleep 3", "run_in_background": true})),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bt","task_type":"local_bash"}]}"#.into(),
            r#"{"type":"system","subtype":"task_started","task_id":"bt","tool_use_id":"tu_bash","description":"background sleep","is_backgrounded":true,"task_type":"local_bash"}"#.into(),
            tool_use("tu_mon", "Monitor", json!({})),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bt"},{"task_id":"bk"}]}"#.into(),
            r#"{"type":"system","subtype":"task_started","task_id":"bk","tool_use_id":"tu_mon","description":"tick watch","is_backgrounded":true,"task_type":"local_bash"}"#.into(),
            tool_use("tu_agent", "Agent", json!({})),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bt"}]}"#.into(),
            r#"{"type":"system","subtype":"task_updated","task_id":"bk","patch":{"status":"completed","end_time":1}}"#.into(),
            r#"{"type":"system","subtype":"task_notification","task_id":"bk","status":"completed","summary":"stream ended"}"#.into(),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bt"},{"task_id":"ag"}]}"#.into(),
            r#"{"type":"system","subtype":"task_started","task_id":"ag","tool_use_id":"tu_agent","description":"kiwi sub-agent","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent"}"#.into(),
            r#"{"type":"user","message":{"content":[]}}"#.into(),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"ag"}]}"#.into(),
            r#"{"type":"system","subtype":"task_updated","task_id":"bt","patch":{"status":"completed"}}"#.into(),
            r#"{"type":"system","subtype":"task_notification","task_id":"bt","status":"completed"}"#.into(),
            tool_use("tu_fg", "Bash", json!({"command": "sleep 4"})),
            r#"{"type":"system","subtype":"task_started","task_id":"fg","tool_use_id":"tu_fg","description":"foreground sleep","is_backgrounded":false,"task_type":"local_bash"}"#.into(),
            r#"{"type":"system","subtype":"task_started","task_id":"sub","owned_by_subagent":true,"tool_use_id":"tu_x","is_backgrounded":false,"task_type":"local_bash"}"#.into(),
            r#"{"type":"system","subtype":"task_notification","task_id":"fg","status":"completed","output_file":""}"#.into(),
            r#"{"type":"system","subtype":"task_notification","task_id":"sub","status":"completed","output_file":""}"#.into(),
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#.into(),
            r#"{"type":"system","subtype":"task_updated","task_id":"ag","patch":{"status":"completed"}}"#.into(),
            r#"{"type":"system","subtype":"task_notification","task_id":"ag","status":"completed","usage":{"total_tokens":34419,"tool_uses":2,"duration_ms":6000}}"#.into(),
            r#"{"type":"result","subtype":"success"}"#.into(),
        ];
        let mut running_at = Vec::new();
        for l in &script {
            finished.extend(feed(&mut r, l));
            running_at.push(r.background_running());
        }
        let ids: Vec<(&str, TaskKind)> = finished.iter().map(|f| (f.task_id.as_str(), f.kind)).collect();
        assert_eq!(ids, vec![("bk", TaskKind::Monitor), ("bt", TaskKind::Bash), ("ag", TaskKind::Agent)]);
        assert!(finished.iter().all(|f| f.status == TaskStatus::Completed), "{finished:?}");
        assert_eq!(finished[0].label.as_deref(), Some("tick watch"));
        assert_eq!(*running_at.iter().max().unwrap(), 2);
        assert_eq!(r.background_running(), 0);
        // the foreground shells never counted, and are listed as such
        let fg = r.get("fg").unwrap();
        assert_eq!(fg.to_json()["foreground"], true);
        assert_eq!(r.get("bt").unwrap().command.as_deref(), Some("sleep 3"));
        assert_eq!(r.get("ag").unwrap().tokens, Some(34419));
        assert!(r.is_agent_launch("tu_agent"));
        assert_eq!(r.launch_of("ag"), Some("tu_agent"));
    }

    #[test]
    fn foreground_and_ambient_tasks_never_count_nor_finish() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"fg","is_backgrounded":false,"task_type":"local_agent"}"#);
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"amb","ambient":true,"task_type":"local_agent"}"#);
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"skip","skip_transcript":true}"#);
        assert_eq!(r.background_running(), 0);
        let f = feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"fg","status":"completed"}"#);
        assert!(f.is_empty());
        let f = feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"amb","status":"completed"}"#);
        assert!(f.is_empty());
    }

    #[test]
    fn a_foreground_task_moved_to_the_background_counts_and_finishes() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"t","is_backgrounded":false,"task_type":"local_bash"}"#);
        assert_eq!(r.background_running(), 0);
        feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"t","patch":{"is_backgrounded":true}}"#);
        assert_eq!(r.background_running(), 1);
        let f = feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"t","patch":{"status":"killed"}}"#);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].status, TaskStatus::Stopped);
    }

    #[test]
    fn a_task_that_left_the_level_without_an_edge_is_retired_on_the_next_unrelated_line() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t"}]}"#);
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"t","task_type":"local_bash"}"#);
        // leaves the level: parked, not settled yet (its edges may follow)
        let f = feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#);
        assert!(f.is_empty());
        assert!(r.has_pending_retire());
        assert_eq!(r.background_running(), 1);
        // no edge came: the next unrelated line retires it as stopped
        let f = feed(&mut r, r#"{"type":"assistant","message":{"content":[]}}"#);
        assert_eq!(f, vec![Finished { task_id: "t".into(), kind: TaskKind::Bash, status: TaskStatus::Stopped, label: None }]);
        assert_eq!(r.background_running(), 0);
        assert!(feed(&mut r, r#"{"type":"result"}"#).is_empty(), "retired twice");
    }

    #[test]
    fn the_edge_behind_the_level_wins_over_the_retirement() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t"}]}"#);
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"t","task_type":"local_bash"}"#);
        feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#);
        let f = feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"t","patch":{"status":"failed"}}"#);
        assert_eq!(f[0].status, TaskStatus::Failed);
        assert!(!r.has_pending_retire());
        assert!(feed(&mut r, r#"{"type":"result"}"#).is_empty());
    }

    #[test]
    fn a_sendmessage_wake_is_a_new_run_of_the_same_agent() {
        // capture_subagent_wake.jsonl: launch, finish, then a SendMessage wake
        // whose task_started is keyed on the SendMessage call.
        let mut r = TaskRegistry::default();
        let mut f = Vec::new();
        f.extend(feed(&mut r, &tool_use("toolu_agent", "Agent", json!({}))));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"a6","tool_use_id":"toolu_agent","description":"Sleep then reply","subagent_type":"general-purpose","task_type":"local_agent"}"#));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_progress","task_id":"a6","description":"Running Wait six seconds","usage":{"total_tokens":900,"tool_uses":1,"duration_ms":6000}}"#));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"a6","patch":{"status":"completed"}}"#));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"a6","status":"completed","usage":{"total_tokens":1200,"tool_uses":2,"duration_ms":7000}}"#));
        assert_eq!(r.get("a6").unwrap().tokens, Some(1200));
        f.extend(feed(&mut r, &tool_use("toolu_send", "SendMessage", json!({"to": "a6"}))));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"a6","tool_use_id":"toolu_send","description":"Sleep then reply","subagent_type":"general-purpose","task_type":"local_agent"}"#));
        assert_eq!(r.background_running(), 1, "the woken run is background work again");
        let woken = r.get("a6").unwrap();
        assert_eq!(
            (woken.progress.as_deref(), woken.tokens, woken.tool_uses, woken.duration_ms),
            (None, None, None, None),
            "the new run starts blank, not on the previous run's roll-up"
        );
        // a duplicate task_started of a RUNNING task is not a new run
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_progress","task_id":"a6","description":"Replying","usage":{"total_tokens":50}}"#));
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"a6","tool_use_id":"toolu_send","task_type":"local_agent"}"#));
        assert_eq!((r.get("a6").unwrap().progress.as_deref(), r.get("a6").unwrap().tokens), (Some("Replying"), Some(50)));
        assert_eq!(r.get("a6").unwrap().kind, TaskKind::Agent);
        assert!(!r.is_agent_launch("toolu_send"));
        assert_eq!(r.launch_of("a6"), Some("toolu_agent"), "the launch learned at the first run stays");
        f.extend(feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"a6","tool_use_id":"toolu_send","status":"completed"}"#));
        assert_eq!(f.len(), 2, "one task_finished per run: {f:?}");
    }

    #[test]
    fn an_unknown_terminal_status_still_ends_the_run() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"t","task_type":"local_workflow"}"#);
        assert_eq!(r.get("t").unwrap().kind, TaskKind::Workflow);
        let f = feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"t","status":"vanished"}"#);
        assert_eq!(f[0].status, TaskStatus::Completed);
        // an unknown status on a task_updated keeps it running
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"u","task_type":"local_bash"}"#);
        assert!(feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"u","patch":{"status":"in_progress"}}"#).is_empty());
        assert_eq!(r.background_running(), 1);
    }

    #[test]
    fn edges_of_unknown_tasks_and_malformed_lines_are_ignored() {
        let mut r = TaskRegistry::default();
        assert!(feed(&mut r, r#"{"type":"system","subtype":"task_notification","task_id":"ghost","status":"completed"}"#).is_empty());
        assert!(feed(&mut r, r#"{"type":"system","subtype":"task_updated","task_id":"ghost","patch":null}"#).is_empty());
        assert!(feed(&mut r, r#"{"type":"system","subtype":"task_progress","task_id":"ghost"}"#).is_empty());
        assert!(feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":null}"#).is_empty());
        assert!(feed(&mut r, r#"{"type":"system","subtype":"task_started"}"#).is_empty());
        assert!(r.snapshot().is_empty());
    }

    #[test]
    fn finished_tasks_are_evicted_past_the_cap_but_running_ones_never() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"keep","task_type":"local_bash"}"#);
        for i in 0..TASKS_KEPT + 10 {
            feed(&mut r, &format!(r#"{{"type":"system","subtype":"task_started","task_id":"t{i}","task_type":"local_bash"}}"#));
            feed(&mut r, &format!(r#"{{"type":"system","subtype":"task_notification","task_id":"t{i}","status":"completed"}}"#));
        }
        assert!(r.snapshot().len() <= TASKS_KEPT);
        assert!(r.get("keep").is_some(), "a running task was evicted");
        assert_eq!(r.background_running(), 1);
    }

    #[test]
    fn the_ambient_flag_is_re_read_from_the_level() {
        let mut r = TaskRegistry::default();
        feed(&mut r, r#"{"type":"system","subtype":"task_started","task_id":"w","task_type":"local_bash"}"#);
        feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"w","ambient":true}]}"#);
        assert_eq!(r.background_running(), 0);
        assert_eq!(r.get("w").unwrap().to_json()["ambient"], true);
        feed(&mut r, r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"w"}]}"#);
        assert_eq!(r.background_running(), 1);
    }
}
