// Step-row rendering for the app's OWN MCP server (`flightdeck`, hosted by `appmcp/`): what an
// agent did to the app — "Read "Refactor auth"", "List conversations · 8 conversations" —
// instead of the anonymous plug + `flightdeck : read_conversation` every unknown MCP call gets.
//
// Rows, never cards: these calls are intermediate work (a lookup, a focus, a rename), so they
// stay steps inside their run, wearing the app's own mark. The two calls that reach ANOTHER
// agent (`send_message`, `create_conversation`) keep their dedicated cards
// (AgentMessageCards) — they are peeled into `message` segments before a row is ever built;
// their labels here only serve the in-flight activity line. No preference gates this: it
// replaces an anonymous label and hides nothing (the row still expands to the raw result).
//
// The wire names a target conversation by id only. Its NAME comes from the caller's resolver
// (the live store), else from the result's own `title` (a removed conversation is no longer
// in the store, but `remove_conversation` echoes the title it had). Pure + framework-free:
// the live thread, the disk transcript and the in-flight activity line share it.

import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { parseMcpToolName } from "../../agent/toolNames";
import { CLAUDE_MODELS } from "./models";
import { waitOutcome } from "./agentMessage";

/** The in-app server's name on the wire — `appmcp::SDK_SERVER_NAME` on the Rust side. */
export const FLIGHTDECK_SERVER = "flightdeck";

/** The tool segment of a `mcp__flightdeck__<tool>` call, or null for anything else. Exact
 *  server match: the name is ours (unlike the CRM, which reaches us under several mounts). */
export function parseFlightdeckTool(name: string): string | null {
  const mcp = parseMcpToolName(name);
  return mcp && mcp.server === FLIGHTDECK_SERVER ? mcp.tool : null;
}

/** Is this wire name a call to the app's own MCP server? */
export function isFlightdeckMcpTool(name: string): boolean {
  return parseFlightdeckTool(name) !== null;
}

/** What a label may draw on beyond the call's input. */
export interface FlightdeckLabelContext {
  /** The call's result content, once it has landed. */
  result?: JsonValue;
  /** A conversation's live name by id; null when unknown (removed, or another session's). */
  titleOf?: (id: string) => string | null;
}

type Obj = Record<string, JsonValue>;

function asObject(v: JsonValue | null | undefined): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

/** The result's JSON (the executor's return value, pretty-printed by the Rust router). Null
 *  for an error string, a missing result, or anything that is not JSON. Never throws. */
function parseResult(content: JsonValue | undefined): JsonValue | null {
  if (content === undefined) return null;
  const raw = resultText(content).trim();
  if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function quoted(s: string): string {
  return `"${clip(s, 40)}"`;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** How the call names its target conversation: quoted live name, else the result's title,
 *  else "a conversation". `selfDefault` tools act on the CALLER when the id is omitted. */
function subject(input: JsonValue, res: Obj | null, ctx: FlightdeckLabelContext, selfDefault = false): string {
  const id = field(input, "conversation_id")?.trim();
  if (!id) return selfDefault ? "this conversation" : "a conversation";
  const name = ctx.titleOf?.(id)?.trim() || field(res, "title")?.trim();
  return name ? quoted(name) : "a conversation";
}

/** " in "X"" for a tool that targets the caller by default — nothing when it does. */
function inSubject(input: JsonValue, res: Obj | null, ctx: FlightdeckLabelContext): string {
  return field(input, "conversation_id") ? ` in ${subject(input, res, ctx)}` : "";
}

const VIEW_NAMES: Record<string, string> = {
  conversation: "Conversation",
  flightdeck: "Flight Deck",
  tosse: "TOSSE",
  ide: "IDE",
};

const PANEL_LABELS: Record<string, string> = {
  editor: "Open the editor",
  terminal: "Open the terminal",
  git: "Open the git panel",
  none: "Close the side panel",
};

function modelLabel(value: string): string {
  return CLAUDE_MODELS.find((m) => m.value === value)?.label ?? value;
}

/**
 * The step-row label for a Flight Deck call, or null when it isn't one. Imperative, like every
 * other step ("Read App.tsx", "Run pnpm test"). A tool this table doesn't know (a newer
 * catalogue entry) still reads plainly: "Flight Deck · <tool>".
 */
export function flightdeckStepLabel(
  name: string,
  input: JsonValue,
  ctx: FlightdeckLabelContext = {},
): string | null {
  const tool = parseFlightdeckTool(name);
  if (!tool) return null;
  const res = asObject(parseResult(ctx.result));
  const target = () => subject(input, res, ctx);
  switch (tool) {
    case "list_conversations":
      return "List conversations";
    case "read_conversation":
      return `Read ${target()}`;
    case "focus_conversation":
      return `Open ${target()}`;
    case "rename_conversation": {
      const n = field(input, "name");
      return n?.trim() ? `Rename to ${quoted(n)}` : "Rename a conversation";
    }
    case "acknowledge_conversation":
      return `Mark ${subject(input, res, ctx, true)} as seen`;
    case "remove_conversation":
      return `Remove ${target()} from the list`;
    case "search_past_conversations": {
      const q = field(input, "query");
      return q?.trim() ? `Search history for ${quoted(q)}` : "List past conversations";
    }
    case "reopen_conversation": {
      // The input carries a disk session id; the conversation id only exists once reopened.
      const id = field(res, "conversation_id");
      const n = (id && ctx.titleOf?.(id)?.trim()) || field(res, "title")?.trim();
      return n ? `Reopen ${quoted(n)}` : "Reopen a past conversation";
    }
    case "list_models":
      return "List models";
    case "set_conversation_model": {
      const m = field(input, "model");
      return m ? `Set model to ${modelLabel(m)} for ${target()}` : `Set the model of ${target()}`;
    }
    case "set_conversation_effort": {
      const parts: string[] = [];
      const e = field(input, "effort");
      if (e) parts.push(`effort to ${e}`);
      const uc = asObject(input)?.ultracode;
      if (typeof uc === "boolean") parts.push(`Ultracode ${uc ? "on" : "off"}`);
      return parts.length ? `Set ${parts.join(", ")} for ${target()}` : `Set the effort of ${target()}`;
    }
    case "interrupt_conversation":
      return `Interrupt ${target()}`;
    case "stop_stream":
      return `Turn off ${target()}`;
    case "list_background_tasks":
      return `List background tasks in ${target()}`;
    case "stop_background_task":
      return `Stop a background task in ${target()}`;
    case "get_pending_request":
      return `Check pending requests in ${target()}`;
    case "answer_request": {
      const behavior = field(input, "behavior");
      const verb =
        behavior === "deny"
          ? "Deny a request"
          : asObject(asObject(input)?.answers ?? null)
            ? "Answer a question"
            : "Allow a request";
      return `${verb} in ${target()}`;
    }
    case "send_message":
      return `Message ${target()}`;
    case "create_conversation": {
      const repo = field(input, "repo_path");
      return repo?.trim() ? `Create a conversation in ${basename(repo)}` : "Create a conversation";
    }
    case "whoami":
      return "Identify this conversation";
    case "watch_conversation":
      return field(input, "mode") === "persistent" ? `Watch ${target()} until told otherwise` : `Watch ${target()}`;
    case "unwatch_conversation":
      return `Stop watching ${target()}`;
    case "wait_for_conversation": {
      // The outcome is the point of the call: say it once it is in.
      const said = waitOutcome(field(res, "outcome"))?.label;
      return said ? `Wait for ${target()} · ${said}` : `Wait for ${target()}`;
    }
    case "link_tosse_task": {
      const title = field(input, "title") ?? field(asObject(res?.task ?? null), "title");
      return title?.trim() ? `Link to TOSSE task ${quoted(title)}` : "Link to a TOSSE task";
    }
    case "unlink_tosse_task":
      return "Unlink the TOSSE task";
    case "add_repo": {
      const p = field(input, "path");
      return p?.trim() ? `Add folder ${basename(p)}` : "Add a folder";
    }
    case "browse_folders": {
      const p = field(input, "path");
      return p?.trim() ? `Browse ${basename(p)}` : "Browse the home folder";
    }
    case "open_file": {
      const p = field(input, "path");
      if (!p?.trim()) return "Open a file";
      const line = asObject(input)?.line;
      return `Open ${basename(p)}${typeof line === "number" ? `:${line}` : ""}${inSubject(input, res, ctx)}`;
    }
    case "open_diff": {
      const l = field(input, "left_path");
      const r = field(input, "right_path");
      if (!l?.trim() || !r?.trim()) return "Compare two files";
      return `Compare ${basename(l)} ↔ ${basename(r)}${inSubject(input, res, ctx)}`;
    }
    case "open_view": {
      const v = field(input, "view");
      return v && VIEW_NAMES[v] ? `Switch to the ${VIEW_NAMES[v]} view` : "Switch view";
    }
    case "open_panel": {
      const p = field(input, "panel");
      return `${(p && PANEL_LABELS[p]) || "Open a side panel"}${inSubject(input, res, ctx)}`;
    }
    case "notify_user": {
      const m = field(input, "message");
      return m?.trim() ? `Notify: ${quoted(m)}` : "Notify the user";
    }
    case "wait_for_events":
      return "Wait for fleet events";
    default:
      return `Flight Deck · ${tool.replace(/_+/g, " ")}`;
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A compact count for a lookup's row ("8 conversations"), from its result. Null for a call
 *  that isn't a lookup, an error, or a result whose shape we don't recognise. */
export function flightdeckStepCount(name: string, content: JsonValue | undefined): string | null {
  const tool = parseFlightdeckTool(name);
  if (!tool) return null;
  const parsed = parseResult(content);
  const res = asObject(parsed);
  const len = (key: string): number | null => {
    const v = res?.[key];
    return Array.isArray(v) ? v.length : null;
  };
  let n: number | null = null;
  let noun = "";
  switch (tool) {
    case "list_conversations":
      [n, noun] = [Array.isArray(parsed) ? parsed.length : null, "conversation"];
      break;
    case "search_past_conversations":
      [n, noun] = [len("conversations"), "result"];
      break;
    case "read_conversation":
      [n, noun] = [len("turns"), "turn"];
      break;
    case "list_background_tasks":
      [n, noun] = [len("tasks"), "task"];
      break;
    case "get_pending_request":
      [n, noun] = [len("requests"), "request"];
      break;
    case "list_models":
      [n, noun] = [len("models"), "model"];
      break;
  }
  return n === null ? null : plural(n, noun);
}

/** The ids of conversations a call names — what a renderer must resolve to show their names.
 *  Lets a row subscribe to exactly those names rather than to the whole conversation list. */
export function flightdeckTargetIds(name: string, input: JsonValue, content?: JsonValue): string[] {
  const tool = parseFlightdeckTool(name);
  if (!tool) return [];
  const ids: string[] = [];
  const id = field(input, "conversation_id")?.trim();
  if (id) ids.push(id);
  if (tool === "reopen_conversation") {
    const reopened = field(asObject(parseResult(content)), "conversation_id");
    if (reopened) ids.push(reopened);
  }
  return ids;
}
