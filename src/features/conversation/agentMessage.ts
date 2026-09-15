// Agent-to-agent messages: what one conversation sends another through the app-hosted
// `flightdeck` MCP server's `send_message` tool.
//
// The recipient's binary only ever receives TEXT, and its transcript only ever keeps that
// text — so the attribution (who sent it, and the id that correlates the send with its
// arrival) has to travel INSIDE the text. A live-only side channel would vanish on reload
// (the lesson of `turn_result`, which a resumed history never carries). The envelope is
// therefore a small tagged block the model reads naturally and every renderer parses back:
//
//   <agent-message>
//   <from>Refactor auth</from>
//   <from-repo>tosse-code</from-repo>
//   <from-backend>claude</from-backend>
//   <from-conversation-id>…</from-conversation-id>
//   <message-id>…</message-id>
//   <note>…</note>
//   <body>
//   …the message…
//   </body>
//   </agent-message>
//
// Pure + tested. The SAME parse feeds the live thread, the clean-output inline marker and
// the disk transcript (via `parseSpecialMessage`), and is mirrored by the Rust excerpt
// reader (`history::agent_message_body`) so the History panel never lists the raw tags.

import type { JsonValue } from "../../ipc/client";
import { resultText } from "../../agent/subagentMeta";
import type { SessionEntry } from "../../store/types";

/** The in-app MCP server's `send_message` tool, as the model calls it. */
export const SEND_MESSAGE_TOOL = "mcp__flightdeck__send_message";

export interface AgentMessage {
  type: "agent-message";
  /** Correlates this arrival with the sender's `send_message` call (its result echoes it). */
  messageId: string | null;
  fromConversationId: string | null;
  /** Snapshots taken at send time — the live conversation (by id) wins when it still exists. */
  fromTitle: string | null;
  fromRepo: string | null;
  fromBackend: string | null;
  body: string;
}

export interface AgentMessageSender {
  conversationId: string;
  title: string;
  repo: string | null;
  backend: string;
}

const OPEN = "<agent-message>";
const CLOSE = "</agent-message>";
const BODY_OPEN = "<body>";
const BODY_CLOSE = "</body>";

/** Read by the RECIPIENT model: it must know the prompt did not come from its user. Kept
 *  neutral on purpose — answering another agent is a separate feature (the reply channel). */
const NOTE =
  "This message was sent by another agent conversation (named above) through the Flight Deck " +
  "send_message tool. It was not typed by the user.";

/** A header value on one line with no angle brackets, so a title like `</from>` can never
 *  break the envelope it is written into. */
function headerValue(v: string): string {
  return v.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/** Wrap a message in its attribution envelope. */
export function buildAgentMessageEnvelope(
  sender: AgentMessageSender,
  messageId: string,
  body: string,
): string {
  const lines = [OPEN, `<from>${headerValue(sender.title) || "Untitled conversation"}</from>`];
  const repo = sender.repo ? headerValue(sender.repo) : "";
  if (repo) lines.push(`<from-repo>${repo}</from-repo>`);
  lines.push(
    `<from-backend>${headerValue(sender.backend)}</from-backend>`,
    `<from-conversation-id>${headerValue(sender.conversationId)}</from-conversation-id>`,
    `<message-id>${headerValue(messageId)}</message-id>`,
    `<note>${NOTE}</note>`,
    BODY_OPEN,
    body,
    BODY_CLOSE,
    CLOSE,
  );
  return lines.join("\n");
}

function scalar(header: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(header);
  const v = m ? m[1].trim() : "";
  return v ? v : null;
}

/** Parse an agent-message envelope out of a user message's text; `null` for anything else.
 *
 *  Same strict gate as `<task-notification>`: the trimmed text must OPEN on the tag — a
 *  prompt that merely mentions `<agent-message>` in prose never does. The body is free text
 *  (it may itself contain tag-looking strings, even `</body>`), so it spans from the first
 *  `<body>` to the LAST `</body>`, and the header fields are only read BEFORE the body. */
export function parseAgentMessage(text: string): AgentMessage | null {
  const t = text.trimStart();
  if (!t.startsWith(OPEN)) return null;
  const bodyOpen = t.indexOf(BODY_OPEN);
  const header = bodyOpen === -1 ? t : t.slice(0, bodyOpen);
  let body = "";
  if (bodyOpen !== -1) {
    const start = bodyOpen + BODY_OPEN.length;
    const bodyClose = t.lastIndexOf(BODY_CLOSE);
    const envClose = t.lastIndexOf(CLOSE);
    // A truncated envelope (no close tag) still renders its body rather than raw XML.
    const end = bodyClose >= start ? bodyClose : envClose >= start ? envClose : t.length;
    body = t.slice(start, end).trim();
  }
  return {
    type: "agent-message",
    messageId: scalar(header, "message-id"),
    fromConversationId: scalar(header, "from-conversation-id"),
    fromTitle: scalar(header, "from"),
    fromRepo: scalar(header, "from-repo"),
    fromBackend: scalar(header, "from-backend"),
    body,
  };
}

/** The conversational content of a sent text: an envelope's body, else the text itself. What
 *  a recipient's auto-title is derived from — never the envelope's tags. */
export function agentMessageTopic(text: string): string {
  return parseAgentMessage(text)?.body || text;
}

export interface SendMessageOutcome {
  conversationId: string | null;
  messageId: string | null;
  /** The recipient was mid-turn: the message was queued / injected into its running turn. */
  queued: boolean;
}

/** Read a `send_message` tool_result (the executor's JSON, pretty-printed as MCP text).
 *  `null` when it isn't that JSON — an error text, or a result from before message ids. */
export function parseSendMessageResult(content: JsonValue | undefined): SendMessageOutcome | null {
  const raw = resultText(content).trim();
  if (!raw.startsWith("{")) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return null;
    return {
      conversationId: typeof v.conversation_id === "string" ? v.conversation_id : null,
      messageId: typeof v.message_id === "string" ? v.message_id : null,
      queued: typeof v.note === "string" && v.note.length > 0,
    };
  } catch {
    return null;
  }
}

/** The tool_use id of the `send_message` call that produced `messageId` in this conversation,
 *  found through the message id its result echoes. `null` until that result is in the store
 *  (a cold conversation is still loading its history). */
export function findSentMessageToolUse(
  entry: SessionEntry | undefined,
  messageId: string,
): string | null {
  if (!entry) return null;
  for (const r of Object.values(entry.toolResults)) {
    if (r.isError) continue;
    if (parseSendMessageResult(r.content)?.messageId === messageId) return r.toolUseId;
  }
  return null;
}
