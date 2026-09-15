// Some messages reach the thread as a plain `user_message` but aren't the human
// speaking — the CLI injects them. The prime example is a `<task-notification>` block,
// emitted when a background task/agent finishes (task-id, status, summary, result,
// usage…). Rendered raw it's unreadable XML. We detect these injected "special
// messages" here and route them to a dedicated card, mirroring how `userText`
// special-cases slash-commands. Pure + tested; the SAME parse feeds the live thread
// (MsgUser) and the disk transcript (SubAgentTranscript) so both render identically.
//
// The union is deliberately open (`SpecialMessage`) so future injected markers get a
// new `type` here rather than another ad-hoc branch scattered across the renderers.

import { parseAgentMessage, type AgentMessage } from "./agentMessage";

export interface TaskNotificationUsage {
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface TaskNotification {
  type: "task-notification";
  taskId: string | null;
  toolUseId: string | null;
  outputFile: string | null;
  /** completed | failed | killed | stopped | … — kept verbatim; the UI maps known ones. */
  status: string | null;
  summary: string | null;
  /** Model-directed boilerplate ("a task-notification fires each time…"); de-emphasised. */
  note: string | null;
  /** The (possibly very long) body — a sub-agent's final report, a command's output… */
  result: string | null;
  usage: TaskNotificationUsage | null;
}

/** Extensible union: add future injected markers as new members. An agent-message is not
 *  CLI-injected, but it is not the human speaking either (another conversation sent it), so
 *  it shares the same routing: never a user bubble, never "the user's last message". */
export type SpecialMessage = TaskNotification | AgentMessage;

const TN_OPEN = "<task-notification>";
const TN_CLOSE = "</task-notification>";

/** First `<tag>…</tag>` (non-greedy), trimmed — for the short scalar fields near the top. */
function scalar(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? m[1].trim() : null;
}

function intField(body: string, tag: string): number | null {
  const raw = scalar(body, tag);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** The `result` body can hold arbitrary text (markdown, angle brackets, even
 *  tag-looking substrings), so we grab from the first `<result>` to the LAST
 *  `</result>` — robust to `<…>` (and a stray `</result>`) inside the report. */
function resultField(body: string): string | null {
  const open = body.indexOf("<result>");
  if (open === -1) return null;
  const close = body.lastIndexOf("</result>");
  if (close === -1 || close < open) return null;
  const inner = body.slice(open + "<result>".length, close).trim();
  return inner.length ? inner : null;
}

function usageField(body: string): TaskNotificationUsage | null {
  const m = /<usage>([\s\S]*?)<\/usage>/.exec(body);
  if (!m) return null;
  const usage: TaskNotificationUsage = {
    tokens: intField(m[1], "subagent_tokens"),
    toolUses: intField(m[1], "tool_uses"),
    durationMs: intField(m[1], "duration_ms"),
  };
  if (usage.tokens == null && usage.toolUses == null && usage.durationMs == null) return null;
  return usage;
}

/** Detect an injected special message inside a user-message's text. Returns `null`
 *  for ordinary prompts — including prose that merely *mentions* `<task-notification>`
 *  (we require the trimmed text to OPEN with the tag; real injections always do, and
 *  hand-written prompts referencing it in prose never do). */
export function parseSpecialMessage(text: string): SpecialMessage | null {
  const agent = parseAgentMessage(text);
  if (agent) return agent;
  const t = text.trimStart();
  // The `startsWith` gate is the decisive anti-false-positive: real injections always
  // OPEN on the tag; prose that merely mentions it never does. Kept strict.
  if (!t.startsWith(TN_OPEN)) return null;
  // Having opened strictly on the tag, this IS an injection — never prose. If the close
  // tag is missing (a truncated / mid-stream block) parse to the end anyway, rather than
  // bailing and dumping raw XML into a user bubble (the exact output the card prevents).
  const closeIdx = t.lastIndexOf(TN_CLOSE);
  const body = t.slice(TN_OPEN.length, closeIdx === -1 ? t.length : closeIdx);

  // The `<result>` report holds arbitrary, tag-looking text, so header scalars and the
  // trailing `<usage>` block MUST be scanned OUTSIDE it — otherwise a report that itself
  // contains e.g. `<usage>…` or `<note>…` (plausible when a sub-agent discusses this very
  // format) contaminates those fields. Header fields sit before `<result>`; `<usage>`
  // sits after `</result>`. With no result, both zones are the whole body (nothing to
  // contaminate).
  const rOpen = body.indexOf("<result>");
  const rClose = body.lastIndexOf("</result>");
  const hasResult = rOpen !== -1 && rClose !== -1 && rClose >= rOpen;
  const header = hasResult ? body.slice(0, rOpen) : body;
  const tail = hasResult ? body.slice(rClose + "</result>".length) : body;

  return {
    type: "task-notification",
    taskId: scalar(header, "task-id"),
    toolUseId: scalar(header, "tool-use-id"),
    outputFile: scalar(header, "output-file"),
    status: scalar(header, "status"),
    summary: scalar(header, "summary"),
    note: scalar(header, "note"),
    result: resultField(body),
    usage: usageField(tail),
  };
}

export type NotifTone = "ok" | "err" | "warn" | "muted";

export interface NotifStyle {
  /** `Ico` glyph name. */
  icon: string;
  tone: NotifTone;
  /** Status label shown in the pill. */
  label: string;
}

/** Map a task-notification `status` to its icon glyph, colour tone and label.
 *  Pure so the mapping is testable without rendering the card. */
export function taskNotificationStyle(status: string | null): NotifStyle {
  switch ((status || "").toLowerCase()) {
    case "completed":
      return { icon: "check", tone: "ok", label: "Completed" };
    case "failed":
      return { icon: "alert", tone: "err", label: "Failed" };
    case "killed":
      return { icon: "x", tone: "err", label: "Killed" };
    case "stopped":
      return { icon: "stopc", tone: "warn", label: "Stopped" };
    default:
      return { icon: "bolt", tone: "muted", label: status ? status : "Notification" };
  }
}
