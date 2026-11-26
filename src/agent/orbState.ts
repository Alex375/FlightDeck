// Which activity-orb SHAPE says what a running agent is doing. Derived from the same
// classification as the activity line (`store/activity.ts` → `ActivityKind`), so the shape and
// the words beside it never disagree. Pure + tested; the orb itself lives in `ui/orbs/`.
//
// The mapping (validated with Alexandre, 2026-11-26 — see the orbs spec in the TOSSE task):
//   Thinking… (and its playful words), a to-do's phrasing, anything unmapped → working
//   Writing a reply…                                                          → composing
//   Read / Grep / Glob / WebFetch / WebSearch / ToolSearch                    → searching
//   Edit / MultiEdit / Write / NotebookEdit (+ Codex ApplyPatch)              → shaping
//   a foreground shell command (Bash, reading its output)                     → listening
//   a sub-agent (Agent / Task / SendMessage / Codex collab) or a Workflow     → weaving
//   an MCP tool (`mcp__…`), a remote link redialing                           → connecting
//   the plan (TodoWrite, plan mode) and a compaction                          → solving
import type { OrbState } from "thinking-orbs";
import type { ActivityKind } from "../store/activity";

const SEARCHING = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch", "LS", "NotebookRead"]);
const SHAPING = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "ApplyPatch"]);
const LISTENING = new Set(["Bash", "BashOutput"]);
const WEAVING = new Set(["Agent", "Task", "Workflow", "SendMessage"]);
const SOLVING = new Set(["TodoWrite", "ExitPlanMode", "EnterPlanMode"]);

/** The orb shape for an in-flight tool, by its raw wire name. Pure. */
export function orbStateForTool(name: string): OrbState {
  if (SEARCHING.has(name)) return "searching";
  if (SHAPING.has(name)) return "shaping";
  if (LISTENING.has(name)) return "listening";
  if (WEAVING.has(name)) return "weaving";
  if (SOLVING.has(name)) return "solving";
  if (name.startsWith("mcp__")) return "connecting";
  // Codex names its multi-agent steps in words ("Spawning a sub-agent", "Waiting on a
  // sub-agent", "Sub-agent: <action>" — see `collab_action_fr` in codex/session.rs).
  if (/sub-agent/i.test(name)) return "weaving";
  return "working";
}

/** The orb shape for a BACKGROUND task, by its kind: a shell or a monitor listens, sub-agents
 *  and workflows weave. Pure. */
export function orbStateForTaskKind(kind: string): OrbState {
  switch (kind) {
    case "bash":
    case "monitor":
      return "listening";
    case "agent":
    case "workflow":
      return "weaving";
    default:
      return "working";
  }
}

/** The ONE shape for a conversation whose turn is over but whose background work still runs
 *  (the sidebar's green "backgrounding" row): `weaving` as soon as a sub-agent or a workflow is
 *  among the running tasks, else `listening` for shells / monitors, else `working`; `null` when
 *  nothing runs. Pure. */
export function orbStateForTaskKinds(kinds: readonly string[]): OrbState | null {
  if (kinds.length === 0) return null;
  const shapes = kinds.map(orbStateForTaskKind);
  if (shapes.includes("weaving")) return "weaving";
  if (shapes.includes("listening")) return "listening";
  return "working";
}

/** The orb shape for an activity (see the table at the top of this file). Pure. */
export function orbStateForActivity(activity: ActivityKind): OrbState {
  switch (activity.kind) {
    case "compacting":
      return "solving";
    case "tool":
      return orbStateForTool(activity.name);
    case "writing":
      return "composing";
    case "todo":
    case "thinking":
      return "working";
  }
}
