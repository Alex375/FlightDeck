// Dedicated rendering for the TOSSE (CRM) MCP calls in the transcript: what the agent DID to
// the CRM, read off the wire instead of an anonymous `mcp__…` step row.
//
// Two shapes, decided here and honoured by every renderer (live thread, clean-output fold,
// sub-agent drill-in):
//  - a WRITE (a task filed, a status moved, a context updated) gets its own card — it is a
//    durable change to shared data, and "which task did it just create?" is the question the
//    generic "claude ai TOSSE · 3 tools" header cannot answer;
//  - a READ stays an ordinary step inside its run, with the CRM's own mark and a human label
//    ("Read tasks" + "12 tasks"): it is intermediate work, and a card per read would bury the
//    writes it was looking things up for.
//
// ⚠️ Recognising the server WITHOUT hard-coding one name. The same CRM reaches us under
// several server segments depending on how it is mounted: `claude_ai_TOSSE` (the claude.ai
// connector), a plugin variant, and plain `tosse` on the Codex side (already normalised to
// `mcp__<server>__<tool>` by `codex/session.rs`). So the test is "server segment CONTAINS
// tosse, case-insensitively" — plus a tool we actually recognise, so a same-named server that
// is not the CRM can never wear its rose.
//
// ⚠️ TOLERANT parsing, everywhere. The CRM owns these payloads and can add, rename or drop a
// field without telling us. Nothing here throws and nothing here is required: a shape we don't
// recognise degrades to the generic TOSSE card (action + whatever name we could find), never
// to a blank or a crash. Pure + framework-free so it is unit-testable and shared verbatim by
// the live thread and the off-thread transcript.

import type { JsonValue } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { parseMcpToolName } from "../../agent/toolNames";

/**
 * What a TOSSE call is ABOUT, which picks the card:
 *  - `task`    — a task (or subtask, or a blocking relation): the rich card, with the CRM's
 *                own status pill and assignee mark.
 *  - `context` — the context cascade (`update_context`, `sync_claude_md`…): the level it
 *                touched is the whole story.
 *  - `entity`  — any other CRM object (client, mission, project, document, finance…): the
 *                generic card, action + name.
 *  - `read`    — a lookup: no card at all, a step row inside its run.
 */
export type TosseFamily = "task" | "context" | "entity" | "read";

export interface TosseAction {
  family: TosseFamily;
  /** Past-tense verb for the card's eyebrow — "created", "moved", "archived"… */
  verb: string;
  /** The object acted on, singular and human — "task", "project", "context". */
  entity: string;
  /** Imperative phrase for a READ's step row ("Read tasks"). Unused by the other families. */
  readLabel?: string;
  /** Plural noun for a read's count badge ("12 tasks"). Absent → no badge. */
  countNoun?: string;
}

/**
 * The CRM's tool catalogue, as the MCP server exposes it (TOSSE API v1, 2026-09).
 *
 * Explicit rather than derived: the verb prefixes alone would read `sync_claude_md` as a
 * "sync" of a "claude md" and `recommend_invoicing` as a write. A tool missing from this
 * table is NOT dropped — {@link tosseAction} infers a family from its verb prefix — but it
 * loses the tailored wording.
 */
const ACTIONS: Record<string, TosseAction> = {
  // ---- Tasks ----
  create_task: { family: "task", verb: "created", entity: "task" },
  create_subtask: { family: "task", verb: "created", entity: "subtask" },
  update_task: { family: "task", verb: "updated", entity: "task" },
  update_task_status: { family: "task", verb: "moved", entity: "task" },
  archive_task: { family: "task", verb: "archived", entity: "task" },
  add_task_relation: { family: "task", verb: "added", entity: "blocker" },
  remove_task_relation: { family: "task", verb: "removed", entity: "blocker" },
  // ---- Context cascade ----
  update_context: { family: "context", verb: "updated", entity: "context" },
  sync_claude_md: { family: "context", verb: "synced", entity: "CLAUDE.md" },
  sync_todo_md: { family: "context", verb: "synced", entity: "TODO.md" },
  // ---- Other entities ----
  create_client: { family: "entity", verb: "created", entity: "client" },
  update_client: { family: "entity", verb: "updated", entity: "client" },
  archive_client: { family: "entity", verb: "archived", entity: "client" },
  create_mission: { family: "entity", verb: "created", entity: "mission" },
  update_mission: { family: "entity", verb: "updated", entity: "mission" },
  archive_mission: { family: "entity", verb: "archived", entity: "mission" },
  create_project: { family: "entity", verb: "created", entity: "project" },
  update_project: { family: "entity", verb: "updated", entity: "project" },
  archive_project: { family: "entity", verb: "archived", entity: "project" },
  create_repository: { family: "entity", verb: "created", entity: "repository" },
  update_repository: { family: "entity", verb: "updated", entity: "repository" },
  archive_repository: { family: "entity", verb: "archived", entity: "repository" },
  create_document: { family: "entity", verb: "created", entity: "document" },
  update_document: { family: "entity", verb: "updated", entity: "document" },
  archive_document: { family: "entity", verb: "archived", entity: "document" },
  add_document_link: { family: "entity", verb: "linked", entity: "document" },
  remove_document_link: { family: "entity", verb: "unlinked", entity: "document" },
  create_finance: { family: "entity", verb: "created", entity: "finance entry" },
  update_finance: { family: "entity", verb: "updated", entity: "finance entry" },
  archive_finance: { family: "entity", verb: "archived", entity: "finance entry" },
  create_release_note: { family: "entity", verb: "created", entity: "release note" },
  update_release_note: { family: "entity", verb: "updated", entity: "release note" },
  archive_release_note: { family: "entity", verb: "archived", entity: "release note" },
  create_recurring_task: { family: "entity", verb: "created", entity: "recurring task" },
  update_recurring_task: { family: "entity", verb: "updated", entity: "recurring task" },
  archive_recurring_task: { family: "entity", verb: "archived", entity: "recurring task" },
  generate_recurring_task_now: { family: "entity", verb: "generated", entity: "recurring task" },
  update_settings: { family: "entity", verb: "updated", entity: "settings" },
  // ---- Reads ----
  get_tasks: { family: "read", verb: "read", entity: "tasks", readLabel: "Read tasks", countNoun: "task" },
  list_subtasks: {
    family: "read",
    verb: "read",
    entity: "subtasks",
    readLabel: "Read subtasks",
    countNoun: "subtask",
  },
  get_task_relations: { family: "read", verb: "read", entity: "blockers", readLabel: "Read blockers" },
  get_context: { family: "read", verb: "read", entity: "context", readLabel: "Read context" },
  get_context_chain: {
    family: "read",
    verb: "read",
    entity: "context",
    readLabel: "Read the context chain",
  },
  get_daily_briefing: { family: "read", verb: "read", entity: "briefing", readLabel: "Read the briefing" },
  get_project_status: { family: "read", verb: "read", entity: "project", readLabel: "Read project status" },
  get_repository: { family: "read", verb: "read", entity: "repository", readLabel: "Read a repository" },
  get_repositories: {
    family: "read",
    verb: "read",
    entity: "repositories",
    readLabel: "Read repositories",
    countNoun: "repository",
  },
  get_document: { family: "read", verb: "read", entity: "document", readLabel: "Read a document" },
  get_documents: {
    family: "read",
    verb: "read",
    entity: "documents",
    readLabel: "Read documents",
    countNoun: "document",
  },
  get_finance: { family: "read", verb: "read", entity: "finance entry", readLabel: "Read a finance entry" },
  get_financial_balance: { family: "read", verb: "read", entity: "balance", readLabel: "Read the balance" },
  get_release_notes: {
    family: "read",
    verb: "read",
    entity: "release notes",
    readLabel: "Read release notes",
    countNoun: "release note",
  },
  get_settings: { family: "read", verb: "read", entity: "settings", readLabel: "Read settings" },
  list_clients: {
    family: "read",
    verb: "read",
    entity: "clients",
    readLabel: "Read clients",
    countNoun: "client",
  },
  list_missions: {
    family: "read",
    verb: "read",
    entity: "missions",
    readLabel: "Read missions",
    countNoun: "mission",
  },
  list_projects: {
    family: "read",
    verb: "read",
    entity: "projects",
    readLabel: "Read projects",
    countNoun: "project",
  },
  list_finances: {
    family: "read",
    verb: "read",
    entity: "finances",
    readLabel: "Read finances",
    countNoun: "finance entry",
  },
  list_recurring_tasks: {
    family: "read",
    verb: "read",
    entity: "recurring tasks",
    readLabel: "Read recurring tasks",
    countNoun: "recurring task",
  },
  recommend_invoicing: {
    family: "read",
    verb: "read",
    entity: "invoicing",
    readLabel: "Read invoicing advice",
  },
};

/** Verb prefixes for a tool the catalogue doesn't know (the CRM ships one before we do). */
const WRITE_PREFIXES = ["create_", "update_", "archive_", "add_", "remove_", "set_", "sync_", "generate_"];
const READ_PREFIXES = ["get_", "list_", "search_", "find_", "recommend_"];

/** The TOSSE tool name behind an MCP wire name, or null when it isn't one of the CRM's.
 *
 *  Both halves must agree: a server segment that mentions tosse AND a tool we can place. A
 *  tosse-ish server exposing something unplaceable (a `ping`) falls through to the ordinary
 *  MCP step path rather than being claimed — it is still rendered, just not as a CRM action. */
export function parseTosseTool(name: string): string | null {
  const mcp = parseMcpToolName(name);
  if (!mcp) return null;
  if (!mcp.server.toLowerCase().includes("tosse")) return null;
  const tool = mcp.tool;
  if (ACTIONS[tool]) return tool;
  const known = [...WRITE_PREFIXES, ...READ_PREFIXES].some((p) => tool.startsWith(p));
  return known ? tool : null;
}

/** What this TOSSE tool does, catalogued or inferred from its verb. */
export function tosseAction(tool: string): TosseAction {
  const known = ACTIONS[tool];
  if (known) return known;
  // Unknown tool: place it by verb so a brand-new CRM tool still lands in the right shape.
  // The entity is the rest of the name read back as words (`archive_invoice` → "invoice").
  const under = tool.indexOf("_");
  const verb = under > 0 ? tool.slice(0, under) : tool;
  const entity = (under > 0 ? tool.slice(under + 1) : tool).replace(/_+/g, " ");
  if (READ_PREFIXES.some((p) => tool.startsWith(p)))
    return { family: "read", verb: "read", entity, readLabel: `Read ${entity}` };
  const past = verb.endsWith("e") ? `${verb}d` : `${verb}ed`;
  return { family: "entity", verb: past, entity };
}

/** Is this wire name a TOSSE CRM call at all? */
export function isTosseMcpTool(name: string): boolean {
  return parseTosseTool(name) !== null;
}

/** Does this call deserve its own card (a WRITE), rather than a step row inside a run? */
export function isTosseWriteTool(name: string): boolean {
  const tool = parseTosseTool(name);
  return tool !== null && tosseAction(tool).family !== "read";
}

/** The step-row label for a TOSSE call, or null when it isn't one. Reads get their phrase
 *  ("Read tasks"); a write that stays a step (the pref is off, or the tool is unknown) is
 *  named plainly rather than through the verbose `claude ai TOSSE : update_task_status`. */
export function tosseStepLabel(name: string): string | null {
  const tool = parseTosseTool(name);
  if (!tool) return null;
  const action = tosseAction(tool);
  if (action.readLabel) return action.readLabel;
  if (action.family === "read") return `Read ${action.entity}`;
  return `TOSSE · ${tool.replace(/_+/g, " ")}`;
}

// ---- Result parsing --------------------------------------------------------

function asObject(v: JsonValue | undefined): Record<string, JsonValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : null;
}

/** Parse a tool_result's text as JSON. `null` for anything that isn't — an error string, a
 *  truncation notice, a payload the host spilled to a file. Never throws. */
export function parseTosseJson(content: JsonValue | undefined): JsonValue | null {
  const raw = resultText(content).trim();
  if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

/** How many rows a READ came back with, as a badge ("12 tasks"). Only a JSON ARRAY counts:
 *  a single object is one thing, and a count of 1 says nothing. */
export function tosseReadCount(name: string, content: JsonValue | undefined): string | null {
  const tool = parseTosseTool(name);
  if (!tool) return null;
  const action = tosseAction(tool);
  if (action.family !== "read" || !action.countNoun) return null;
  const parsed = parseTosseJson(content);
  if (!Array.isArray(parsed)) return null;
  const n = parsed.length;
  return `${n} ${action.countNoun}${n === 1 ? "" : "s"}`;
}

/** A task as the CRM hands it back — every field optional, because every field can be absent
 *  (a partial payload, a drifted name, an older server). */
export interface TosseTaskInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  type: string | null;
  assignedTo: string | null;
  project: string | null;
}

/** Read a task out of a write's result payload. `null` when the result carries no task-shaped
 *  object at all (the caller then falls back to the input). */
export function parseTosseTaskResult(content: JsonValue | undefined): TosseTaskInfo | null {
  const parsed = parseTosseJson(content);
  const obj = asObject(parsed ?? undefined);
  if (!obj) return null;
  const title = field(obj, "title") ?? null;
  const id = field(obj, "id") ?? null;
  // A task-shaped payload has at least one of the two. Anything else (a `{ok:true}` ack, a
  // relation record) is not a task and must not be dressed up as one.
  if (!title && !id) return null;
  const project = asObject(obj.project);
  return {
    id,
    title,
    status: field(obj, "status") ?? null,
    priority: field(obj, "priority") ?? null,
    type: field(obj, "type") ?? null,
    assignedTo: field(obj, "assignedTo") ?? null,
    project: project ? (field(project, "name") ?? null) : null,
  };
}

/** Everything a TOSSE card needs, already resolved from the input + the result. */
export interface TosseCardView {
  family: TosseFamily;
  action: TosseAction;
  /** The CRM tool as it was called (`update_task_status`). Shown on the card: the server has
   *  ~60 tools, and "TOSSE task · moved" does not say which of them ran. */
  tool: string;
  /** The card's first line — a task title, an entity name, a context level. */
  headline: string;
  /** The eyebrow's trailing detail, after "TOSSE <entity> · <tool>". */
  detail: string | null;
  /** Where the task stands AFTER this call — from the CRM's answer, or (while that answer is
   *  still on its way) the status the agent asked for. Null when the call carries no status. */
  statusTo: string | null;
  /** Present only for the task family, and only for what the payload actually carried. */
  task: TosseTaskInfo | null;
  /** The task the card links to, when we have an id to link with. */
  taskId: string | null;
}

/** The context level an `update_context` touched, as the CRM names it. */
function contextLevel(input: JsonValue): string | null {
  const t = field(input, "entity_type");
  return t ? t : null;
}

/** The field names a partial update actually changed, for the card's detail line. Every key
 *  but the identifiers — those say WHICH row, not what moved. */
const ID_KEYS = new Set([
  "task_id",
  "parent_task_id",
  "project_id",
  "client_id",
  "mission_id",
  "repository_id",
  "document_id",
  "finance_id",
  "entity_id",
  "entity_type",
  "recurring_task_id",
  "release_note_id",
]);

function changedFields(input: JsonValue): string[] {
  const obj = asObject(input);
  if (!obj) return [];
  return Object.keys(obj)
    .filter((k) => !ID_KEYS.has(k))
    .map((k) => k.replace(/_+/g, " "));
}

/**
 * The headline for a call we could not name — a write that FAILED (no payload came back) or
 * one still in flight. It states the ACTION, in the neutral infinitive the tool itself is
 * named with: `archive_task` → "Archive task". Deliberately not "Task archived": that is a
 * claim about an outcome the card does not yet have, and on the failed card it would be a
 * claim that is plainly false.
 */
function toolPhrase(tool: string): string {
  const words = tool.replace(/_+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "TOSSE action";
}

/** The best name we can put on a non-task entity: what the result called it, else the input. */
function entityName(input: JsonValue, content: JsonValue | undefined): string | null {
  const obj = asObject(parseTosseJson(content) ?? undefined);
  const fromResult = obj ? (field(obj, "name") ?? field(obj, "title") ?? null) : null;
  return fromResult ?? field(input, "name") ?? field(input, "title") ?? null;
}

/**
 * Resolve a TOSSE write into its card. Tolerant by construction: every lookup falls back, and
 * an unrecognised payload still yields a headline (the entity's name, or the action itself) —
 * the card degrades, it never empties.
 */
export function tosseCardView(
  name: string,
  input: JsonValue,
  content: JsonValue | undefined,
): TosseCardView {
  const tool = parseTosseTool(name) ?? "";
  const action = tosseAction(tool);

  if (action.family === "task") {
    const task = parseTosseTaskResult(content);
    const headline = task?.title ?? field(input, "title")?.trim() ?? toolPhrase(tool);
    const taskId = task?.id ?? field(input, "task_id") ?? field(input, "parent_task_id") ?? null;
    // Where the task stands now. The CRM's answer wins; while it is still on its way, the status
    // the agent ASKED for stands in, so a move in flight already reads as the move it is.
    const statusTo = task?.status ?? (tool === "update_task_status" ? field(input, "status") ?? null : null);
    // What the eyebrow says after "TOSSE task · update_task_status". A status move says nothing
    // here — the pills carry it, and repeating it would print the same word twice on one line.
    // A creation names the project it landed in; a partial update names the fields it touched.
    const detail =
      tool === "update_task_status"
        ? null
        : tool === "update_task"
          ? (changedFields(input).join(", ") || null)
          : (task?.project ?? null);
    return { family: "task", action, tool, headline, detail, statusTo, task, taskId };
  }

  if (action.family === "context") {
    const level = contextLevel(input);
    const named = entityName(input, content);
    return {
      family: "context",
      action,
      tool,
      headline: named ?? (level ? `${level} context` : toolPhrase(tool)),
      detail: level,
      statusTo: null,
      task: null,
      taskId: null,
    };
  }

  return {
    family: action.family,
    action,
    tool,
    headline: entityName(input, content) ?? toolPhrase(tool),
    detail: null,
    statusTo: null,
    task: null,
    taskId: null,
  };
}

// ---- Where a task was BEFORE -----------------------------------------------
// The CRM answers a status move with the task as it is AFTER it — it never sends the previous
// status. So "À faire → En cours" has to be reconstructed from what the conversation itself
// already saw: every earlier TOSSE call that carried this task (a lookup, a creation, an
// earlier move) is a sighting of its status at that moment. Walking the thread forward and
// keeping the LAST sighting before a given call gives the status that call moved away from.
//
// ⚠️ Strictly before. A sighting from the call's OWN result is the new status, and using it
// would render "En cours → En cours" — a transition that never happened.
//
// Derived, so it is honest about not knowing: a task the conversation is touching for the
// first time has no prior sighting and the card simply shows where it landed. Never guessed
// from the conversation's denormalised task status, which is a CURRENT value with no
// relationship to the moment of this call.

/** The `{id, status}` pairs anywhere in a payload — one object, an array of them, or a
 *  briefing's nested lists. Depth-bounded and type-checked at each step: a foreign shape
 *  yields nothing rather than throwing. */
export function taskStatusSightings(value: JsonValue | undefined, depth = 0): Array<[string, string]> {
  if (depth > 6 || value == null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => taskStatusSightings(v, depth + 1));
  const obj = value as Record<string, JsonValue>;
  const out: Array<[string, string]> = [];
  const id = field(obj, "id");
  const status = field(obj, "status");
  if (id && status) out.push([id, status]);
  // A task carries its subtasks, and a briefing its projects' tasks — both are sightings too.
  for (const v of Object.values(obj)) if (v && typeof v === "object") out.push(...taskStatusSightings(v, depth + 1));
  return out;
}

/**
 * The status this task was last seen in BEFORE `toolUseId` ran, or null when the conversation
 * had never seen it. Reads the MAIN thread only: a sub-agent's calls interleave on their own
 * timeline, and mixing them in would order sightings by something other than time.
 *
 * Returns a plain string (or null), which is what makes it safe to call from a selector per
 * card: a primitive compares by value, so an unrelated store write cannot re-render the card.
 */
export function priorTaskStatus(
  entry: SessionEntry | undefined,
  toolUseId: string,
  taskId: string | null,
): string | null {
  if (!entry || !taskId) return null;
  let seen: string | null = null;
  for (const t of entry.timeline) {
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.role !== "assistant" || turn.parentToolUseId !== null) continue;
    for (const b of turn.blocks) {
      if (b.type !== "tool_use") continue;
      if (b.id === toolUseId) return seen; // reached this call — everything after is "after"
      if (!isTosseMcpTool(b.name)) continue;
      const result = entry.toolResults[b.id];
      if (!result || result.isError) continue;
      // ⚠️ SUBSTRING PRE-FILTER before any JSON parse — the same guard the goal scan uses on
      // transcripts, and for the same reason. A CRM lookup is not small: `list_projects` comes
      // back at ~200 kB (every project carries its whole context), `get_tasks` at ~65 kB. This
      // runs inside a store selector, so it re-runs on every streamed token, per card: parsing
      // those payloads each time would cost milliseconds a frame for a task that is not even in
      // them. An id is a UUID, so a raw `includes` discards almost everything for almost nothing.
      const raw = resultText(result.content);
      if (!raw.includes(taskId)) continue;
      for (const [id, status] of taskStatusSightings(parseTosseJson(raw) ?? undefined))
        if (id === taskId) seen = status;
    }
  }
  // The call is not in the main thread (a sub-agent's card, a transcript we only partly hold):
  // no ordering we can trust, so no claim.
  return null;
}
