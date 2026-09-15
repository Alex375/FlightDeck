// The two sides of an agent-to-agent exchange (the flightdeck `send_message` and
// `create_conversation` tools), kept COMPACT so a thread full of messaging stays readable:
//  - the RECIPIENT sees a light bubble headed "↩ from <conversation>" — never the human's own
//    bubble — whose name jumps to the place in the sender's thread where it was sent;
//  - the SENDER sees a single step-like row ("Message to <conversation> ✓" / "Created
//    conversation <conversation>"), the text one click away; the name jumps to the arrival.
//
// Each piece takes plain data so the live thread and the disk transcript (history preview,
// sub-agent drill-in) render it identically; only `AgentMessageSentCard` reads the result
// from the store.

import { useState } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { useConversationsStore } from "../../store/conversationsStore";
import { useSessionState, useToolResult } from "../../store/conversationStore";
import { openConversationAt, type JumpAnchor } from "../../store/threadJump";
import { Expandable } from "../../ui/Expandable";
import { Ico } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import {
  CREATE_CONVERSATION_TOOL,
  parseSendMessageResult,
  type AgentMessage,
} from "./agentMessage";

function repoLabel(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

interface LiveConversation {
  exists: boolean;
  name: string | null;
  repo: string | null;
}

/** The other conversation of the exchange, read LIVE by id (a rename shows up). Primitive
 *  selectors only, so a card re-renders on ITS values, not on every conversations write. */
function useLiveConversation(id: string | null): LiveConversation {
  const name = useConversationsStore((s) =>
    id ? (s.conversations.find((c) => c.id === id)?.name ?? null) : null,
  );
  const repoPath = useConversationsStore((s) => {
    const conv = id ? s.conversations.find((c) => c.id === id) : undefined;
    return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
  });
  return { exists: name !== null, name, repo: repoPath ? repoLabel(repoPath) : null };
}

/** The other conversation's name. A link while it is on the list; once removed it stays as
 *  plain, dimmed text (with the snapshot title) rather than offering a dead jump. */
function ConversationLink({
  id,
  live,
  title,
  anchor,
}: {
  id: string | null;
  live: LiveConversation;
  title: string | null;
  anchor: JumpAnchor | null;
}) {
  const label = live.name?.trim() || title || "unknown conversation";
  if (!id || !live.exists) {
    return (
      <span
        className="cv-agentmsg-name"
        data-gone={id ? "1" : undefined}
        title={id ? "No longer in the conversation list" : undefined}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cv-agentmsg-name"
      title={anchor ? "Open this conversation at the message" : "Open this conversation"}
      onClick={(e) => {
        e.stopPropagation(); // neither the row's toggle nor the pane's background click
        openConversationAt(id, anchor);
      }}
    >
      {label}
    </button>
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
  const live = useLiveConversation(message.fromConversationId);
  const repo = live.repo ?? message.fromRepo;
  return (
    <div className="cv-agentmsg" data-agent-msg={message.messageId ?? undefined} role="note">
      <div className="cv-agentmsg-h">
        <Ico name="reply" className="sm cv-agentmsg-ico" />
        <span>from</span>
        <ConversationLink
          id={message.fromConversationId}
          live={live}
          title={message.fromTitle}
          anchor={message.messageId ? { kind: "sent", messageId: message.messageId } : null}
        />
        {repo ? <span className="cv-agentmsg-repo">{repo}</span> : null}
        {queued ? <span className="cv-agentmsg-pending">pending</span> : null}
      </div>
      {message.body ? (
        <div className="cv-agentmsg-body">
          <Expandable maxHeight={180} fadeColor="var(--wf-panel)">
            <StreamMarkdown text={message.body} />
          </Expandable>
        </div>
      ) : null}
    </div>
  );
}

/** The sender's side, from plain data (the disk transcript hands the result in). */
export function AgentMessageSentView({
  name,
  toolUseId,
  input,
  result,
  running = false,
}: {
  /** `send_message` or `create_conversation`. */
  name: string;
  toolUseId: string;
  input: JsonValue;
  result: { content: JsonValue; isError: boolean } | undefined;
  /** The call belongs to the live, busy turn — only then may a resultless send spin. A
   *  resultless call in a past turn (a session torn down mid-call, a truncated transcript)
   *  would otherwise read "sending" forever. */
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const created = name === CREATE_CONVERSATION_TOOL;
  const errored = !!result?.isError;
  const outcome = result && !errored ? parseSendMessageResult(result.content) : null;
  // A created conversation is only known once the result names it.
  const targetId = created ? (outcome?.conversationId ?? null) : (field(input, "conversation_id") ?? null);
  const live = useLiveConversation(targetId);
  const snapshotTitle = created
    ? field(input, "title")?.trim() || repoLabel(field(input, "repo_path") ?? "") || null
    : null;
  const text = (field(input, created ? "first_message" : "text") ?? "").trim();
  // A refused call comes back is_error with the reason: flagged on the row, readable when opened.
  const reason = errored
    ? resultText(result?.content).trim() ||
      (created ? "The conversation could not be created" : "The message could not be sent")
    : null;
  const hasDetail = !!text || !!reason;
  // No result and not running = unknown outcome: no glyph, like a resultless tool step.
  const status = !result ? (
    running ? <span className="cv-step-run" aria-label="sending" /> : null
  ) : errored ? (
    <Ico name="alert" className="sm cv-step-errico" />
  ) : outcome?.queued ? (
    <span title="Queued — the recipient was working, it will read it along the way">
      <Ico name="clock" className="sm cv-agentmsg-queued" />
    </span>
  ) : (
    <Ico name="check" className="sm cv-step-okico" />
  );
  return (
    <div className="cv-agentmsg-sent" data-agent-msg-sent={toolUseId}>
      <div
        className="cv-agentmsg-row"
        onClick={hasDetail ? () => setOpen((o) => !o) : undefined}
        role={hasDetail ? "button" : undefined}
        aria-expanded={hasDetail ? open : undefined}
      >
        <Ico name={created ? "plus" : "send"} className="sm cv-agentmsg-ico" />
        <span className="cv-agentmsg-row-t">
          <span className="cv-agentmsg-verb">{created ? "Created conversation" : "Message to"}</span>
          <ConversationLink
            id={targetId}
            live={live}
            title={snapshotTitle}
            anchor={outcome?.messageId ? { kind: "received", messageId: outcome.messageId } : null}
          />
        </span>
        <span className="cv-step-end">
          {status}
          {hasDetail ? (
            <span className="cv-step-chev" data-open={open ? "1" : undefined}>
              <Ico name="chev" className="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {open && hasDetail ? (
        <div className="cv-agentmsg-row-b">
          {text ? <StreamMarkdown text={text} /> : null}
          {reason ? <p className="cv-agentmsg-err">{reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The sender's side in the live thread: its delivery state follows the tool_result. `active`
 *  marks a call of the actively streaming turn (same gate as `LiveToolStep`). */
export function AgentMessageSentCard({
  session,
  name,
  toolUseId,
  input,
  active = false,
}: {
  session: string;
  name: string;
  toolUseId: string;
  input: JsonValue;
  active?: boolean;
}) {
  const result = useToolResult(session, toolUseId);
  const busy = useSessionState(session)?.busy ?? false;
  return (
    <AgentMessageSentView
      name={name}
      toolUseId={toolUseId}
      input={input}
      result={result}
      running={active && !result && busy}
    />
  );
}
