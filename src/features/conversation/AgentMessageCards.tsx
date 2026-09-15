// The two sides of an agent-to-agent message (the flightdeck `send_message` tool), rendered
// as MESSAGING — never as the human's own bubble, never as an anonymous MCP step:
//  - the RECIPIENT sees who sent it (the sender conversation, live title + repo + backend),
//    and that name jumps to the place in the sender's thread where it was sent;
//  - the SENDER sees a "message to" card (recipient, text, delivery state), and the
//    recipient's name jumps to the message as it arrived.
//
// Each card takes plain data so the live thread and the disk transcript (history preview,
// sub-agent drill-in) render it identically; only `AgentMessageSentCard` reads the store.

import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { useConversationsStore } from "../../store/conversationsStore";
import { useToolResult } from "../../store/conversationStore";
import { openConversationAt, type JumpAnchor } from "../../store/threadJump";
import { Expandable } from "../../ui/Expandable";
import { Dot, Ico } from "../../ui/kit";
import { BackendMark } from "./ConvMark";
import { StreamMarkdown } from "./StreamMarkdown";
import { parseSendMessageResult, type AgentMessage } from "./agentMessage";

function repoLabel(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * The other conversation of the exchange, as a chip. Resolved LIVE by id (a rename shows
 * up) with the envelope's snapshot as the fallback. Clickable while the conversation is on
 * the list; once it has been removed the chip says so in plain text rather than offering a
 * dead jump.
 */
function ConversationChip({
  id,
  title,
  repo,
  backend,
  anchor,
}: {
  id: string | null;
  title: string | null;
  repo: string | null;
  backend: string | null;
  anchor: JumpAnchor | null;
}) {
  // Primitive selectors only: each re-renders on ITS value, not on every store write.
  const liveName = useConversationsStore((s) =>
    id ? (s.conversations.find((c) => c.id === id)?.name ?? null) : null,
  );
  const liveKind = useConversationsStore((s) =>
    id ? (s.conversations.find((c) => c.id === id)?.kind ?? null) : null,
  );
  const liveRepo = useConversationsStore((s) => {
    const conv = id ? s.conversations.find((c) => c.id === id) : undefined;
    return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
  });
  const exists = liveKind !== null;
  const label = liveName?.trim() || title || "Unknown conversation";
  const repoName = liveRepo ? repoLabel(liveRepo) : repo;
  // No backend mark for a conversation we know nothing about — guessing Claude would be a lie.
  const kind = liveKind ?? backend;
  const body = (
    <>
      {kind ? (
        <span className="cv-agentmsg-mark">
          <BackendMark kind={kind} />
        </span>
      ) : null}
      <span className="cv-agentmsg-conv-t">{label}</span>
      {repoName ? <span className="cv-agentmsg-conv-repo">{repoName}</span> : null}
    </>
  );
  if (!id || !exists) {
    return (
      <span className="cv-agentmsg-conv" data-gone="1">
        {body}
        <span className="cv-agentmsg-conv-gone">no longer in the list</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cv-agentmsg-conv"
      title={anchor ? "Open this conversation at the message" : "Open this conversation"}
      onClick={(e) => {
        e.stopPropagation(); // don't trigger the pane's background click
        openConversationAt(id, anchor);
      }}
    >
      {body}
      <Ico name="arrow" className="sm cv-agentmsg-go" />
    </button>
  );
}

function MessageBody({ text }: { text: string }) {
  return (
    <div className="cv-agentmsg-body">
      <Expandable maxHeight={220} fadeColor="var(--wf-panel)">
        <StreamMarkdown text={text} />
      </Expandable>
    </div>
  );
}

/** A message another conversation sent to this one. */
export function AgentMessageReceivedCard({
  message,
  queued,
}: {
  message: AgentMessage;
  /** Arrived while this agent was working — not read yet. */
  queued?: boolean;
}) {
  return (
    <div
      className="cv-agentmsg is-received"
      data-agent-msg={message.messageId ?? undefined}
      role="note"
    >
      <div className="cv-agentmsg-h">
        <span className="cv-agentmsg-ico">
          <Ico name="chat" className="sm" />
        </span>
        <span className="cv-agentmsg-kind">Message from</span>
        <ConversationChip
          id={message.fromConversationId}
          title={message.fromTitle}
          repo={message.fromRepo}
          backend={message.fromBackend}
          anchor={message.messageId ? { kind: "sent", messageId: message.messageId } : null}
        />
        {queued ? <span className="cv-agentmsg-status is-wait">Pending</span> : null}
      </div>
      {message.body ? <MessageBody text={message.body} /> : null}
    </div>
  );
}

/** The sender's side, from plain data (the disk transcript hands the result in). */
export function AgentMessageSentView({
  toolUseId,
  input,
  result,
}: {
  toolUseId: string;
  input: JsonValue;
  result: { content: JsonValue; isError: boolean } | undefined;
}) {
  const toId = field(input, "conversation_id") ?? null;
  const text = (field(input, "text") ?? "").trim();
  const errored = !!result?.isError;
  const outcome = result && !errored ? parseSendMessageResult(result.content) : null;
  // A refused send (unknown conversation, self-message…) comes back is_error with the reason:
  // surface it, never let it read as delivered.
  const reason = errored ? resultText(result?.content).trim() || "The message could not be sent" : null;
  const status = errored
    ? { tone: "err", label: "Failed" }
    : !result
      ? { tone: "work", label: "Sending" }
      : outcome?.queued
        ? { tone: "wait", label: "Queued" }
        : { tone: "ok", label: "Delivered" };
  return (
    <div
      className="cv-agentmsg is-sent"
      data-state={errored ? "error" : undefined}
      data-agent-msg-sent={toolUseId}
    >
      <div className="cv-agentmsg-h">
        <span className="cv-agentmsg-ico">
          <Ico name="send" className="sm" />
        </span>
        <span className="cv-agentmsg-kind">Message to</span>
        <ConversationChip
          id={toId}
          title={null}
          repo={null}
          backend={null}
          anchor={outcome?.messageId ? { kind: "received", messageId: outcome.messageId } : null}
        />
        <span className={`cv-agentmsg-status is-${status.tone}`}>
          {status.tone === "work" ? <Dot s="work" pulse /> : null}
          {status.label}
        </span>
      </div>
      {text ? <MessageBody text={text} /> : null}
      {reason ? <p className="cv-agentmsg-err">{reason}</p> : null}
    </div>
  );
}

/** The sender's side in the live thread: its delivery state follows the tool_result. */
export function AgentMessageSentCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const result = useToolResult(session, toolUseId);
  return <AgentMessageSentView toolUseId={toolUseId} input={input} result={result} />;
}
