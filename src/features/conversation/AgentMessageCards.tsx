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
import { useSessionState, useToolResult } from "../../store/conversationStore";
import { Expandable } from "../../ui/Expandable";
import { Ico } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { ConversationLink, repoLabel, useLiveConversation } from "./conversationRef";
import { openConversationAt } from "../../store/threadJump";
import { asObject } from "./questionnaire";
import {
  CREATE_CONVERSATION_TOOL,
  UNWATCH_CONVERSATION_TOOL,
  WAIT_FOR_CONVERSATION_TOOL,
  isWatchTool,
  parseSendMessageResult,
  parseWatchCallResult,
  WAIT_OUTCOMES,
  waitOutcome,
  type AgentMessage,
} from "./agentMessage";
import { fmtFrozenElapsed } from "../../ui/liveElapsed";

/** A message another conversation sent to this one. */
export function AgentMessageReceivedCard({
  message,
  queued,
}: {
  message: AgentMessage;
  /** Arrived while this agent was working — not read yet. */
  queued?: boolean;
}) {
  if (message.watch) return <WatchNotificationLine message={message} queued={queued} />;
  return <AgentMessageBubble message={message} queued={queued} />;
}

function AgentMessageBubble({ message, queued }: { message: AgentMessage; queued?: boolean }) {
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

/**
 * A watch notification — the app reporting that a conversation this one watches finished, needs
 * attention or stopped. ONE discreet line, like a sub-agent's report: what happened, the
 * watched conversation's name, and a click that opens it there. The text the watcher's MODEL
 * read (its last reply, the prompt it is blocked on) is the agent's business, not the reader's:
 * it is one click away, in the conversation itself.
 */
function WatchNotificationLine({ message, queued }: { message: AgentMessage; queued?: boolean }) {
  const id = message.fromConversationId;
  const live = useLiveConversation(id);
  const event = message.watch!.event;
  const name = live.name?.trim() || message.fromTitle || "a conversation";
  const reachable = !!id && live.exists;
  const line = (
    <>
      <Ico name="eye" className="sm cv-handback-ico" />
      <span className="cv-handback-t">
        <span className="cv-handback-name">{name}</span>
      </span>
      <span className="cv-watchline-event">{WAIT_OUTCOMES[event].label}</span>
      {queued ? <span className="cv-agentmsg-pending">pending</span> : null}
      {reachable ? <Ico name="arrow" className="sm cv-handback-go" /> : null}
    </>
  );
  return (
    <div className={`cv-handback cv-watchline is-${event}`} role="note">
      {reachable ? (
        <button
          type="button"
          className="cv-handback-row"
          title={`Open "${name}"`}
          onClick={(e) => {
            e.stopPropagation();
            openConversationAt(id, null);
          }}
        >
          {line}
        </button>
      ) : (
        <div className="cv-handback-row" title={id ? "No longer in the conversation list" : undefined}>
          {line}
        </div>
      )}
    </div>
  );
}

/** The sender's side, from plain data (the disk transcript hands the result in). A watch /
 *  unwatch / wait call gets its own row; a send or a creation the message row. */
export function AgentMessageSentView(props: SentViewProps) {
  return isWatchTool(props.name) ? <WatchCallRow {...props} /> : <MessageSentRow {...props} />;
}

interface SentViewProps {
  /** `send_message`, `create_conversation`, or a watch tool. */
  name: string;
  toolUseId: string;
  input: JsonValue;
  result: { content: JsonValue; isError: boolean } | undefined;
  /** The call belongs to the live, busy turn — only then may a resultless send spin. A
   *  resultless call in a past turn (a session torn down mid-call, a truncated transcript)
   *  would otherwise read "sending" forever. */
  running?: boolean;
}


/** This conversation watching / unwatching / waiting for another — a messaging-style row, the
 *  other conversation's name opening it. */
function WatchCallRow({ name, toolUseId, input, result, running = false }: SentViewProps) {
  const [open, setOpen] = useState(false);
  const targetId = field(input, "conversation_id") ?? null;
  const live = useLiveConversation(targetId);
  const errored = !!result?.isError;
  const outcome = result && !errored ? parseWatchCallResult(result.content) : null;
  const reason = errored ? resultText(result?.content).trim() || "The call was refused" : null;
  const waiting = name === WAIT_FOR_CONVERSATION_TOOL;

  let icon = "eye";
  let verb: string;
  let tag: { label: string; tone: string } | null = null;
  if (waiting) {
    icon = "clock";
    verb = !result && running ? "Waiting for" : "Waited for";
    tag = waitOutcome(outcome?.outcome);
  } else if (name === UNWATCH_CONVERSATION_TOOL) {
    verb = outcome?.wasWatching === false ? "Was not watching" : "Stopped watching";
  } else {
    verb = "Watching";
    if ((outcome?.watching ?? field(input, "mode")) === "persistent") tag = { label: "until stopped", tone: "quiet" };
  }

  const status = !result ? (
    running ? <span className="cv-step-run" aria-label={waiting ? "waiting" : "working"} /> : null
  ) : errored ? (
    <Ico name="alert" className="sm cv-step-errico" />
  ) : waiting ? null : (
    <Ico name="check" className="sm cv-step-okico" />
  );
  const waited = outcome?.waitedSeconds ? fmtFrozenElapsed(outcome.waitedSeconds * 1000) : null;
  return (
    <div className="cv-agentmsg-sent" data-agent-msg-sent={toolUseId}>
      <div
        className="cv-agentmsg-row"
        onClick={reason ? () => setOpen((o) => !o) : undefined}
        role={reason ? "button" : undefined}
        aria-expanded={reason ? open : undefined}
      >
        <Ico name={icon} className="sm cv-agentmsg-ico" />
        <span className="cv-agentmsg-row-t">
          <span className="cv-agentmsg-verb">{verb}</span>
          <ConversationLink id={targetId} live={live} title={null} anchor={null} />
          {tag ? <span className={`cv-watchline-event is-${tag.tone}`}>{tag.label}</span> : null}
          {waited ? <span className="cv-agentmsg-repo">{waited}</span> : null}
        </span>
        <span className="cv-step-end">
          {status}
          {reason ? (
            <span className="cv-step-chev" data-open={open ? "1" : undefined}>
              <Ico name="chev" className="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {open && reason ? (
        <div className="cv-agentmsg-row-b">
          <p className="cv-agentmsg-err">{reason}</p>
        </div>
      ) : null}
    </div>
  );
}

function MessageSentRow({ name, toolUseId, input, result, running = false }: SentViewProps) {
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
          {/* Sent with `watch`: this conversation will hear when the recipient settles. */}
          {asObject(input)?.watch === true && !errored ? (
            <span className="cv-watchline-event is-quiet" title="You'll be notified once when it settles">
              watching
            </span>
          ) : null}
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
