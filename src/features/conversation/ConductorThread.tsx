import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type {
  BackgroundTaskStatus,
  ConversationItem,
  JsonValue,
  NormalizedBlock,
  PermissionRequestPayload,
} from "../../ipc/client";
import { commands } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { classifyAsk, field } from "../../agent/ask";
import { useActivityLabel, useLiveBashCommand } from "../../store/activity";
import { RollText } from "../../ui/RollText";
import {
  coalesceCleanRounds,
  useConversationStore,
  useError,
  useBackgroundAgentIds,
  useNotice,
  usePendingPermissions,
  useSessionState,
  useSubThread,
  useRunErrored,
  useTimelineRender,
  useToolResult,
  useTurn,
  useTurnResult,
  useTurnStartedAt,
  useThinkingStartedAt,
  useThinkingDuration,
} from "../../store/conversationStore";
import type { RoundMarker, UserTurnImage } from "../../store/types";
import { imageDataUrl } from "./composerAttachments";
import { useConversationsStore, rewindConversation, forkConversation } from "../../store/conversationsStore";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useBackgroundTasksStore, useTaskByToolUse, useRunningTaskCount } from "../../store/backgroundTasksStore";
import { fmtDuration, isBackgroundAgentInput, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { Avatar, Dot, Ico, UserMark, type StreamState } from "../../ui/kit";
import { AiAvatar } from "./ConvMark";
import { useNow } from "../../ui/useNow";
import { QuestionCard, QuestionnaireAsk } from "./QuestionnaireAsk";
import { PlanCard } from "./PlanCard";
import { StreamMarkdown } from "./StreamMarkdown";
import { SubAgentTranscript } from "./SubAgentTranscript";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  atomsToSegments,
  atomStillRunning,
  countWorkSteps,
  flattenWork,
  groupBlocks,
  interleaveMarkers,
  liveVisibleStart,
  runHeader,
  splitFinalMessage,
  workStepIds,
  type GroupInput,
  type Segment,
  type ToolStep,
} from "./toolGroup";
import { useEffectiveCleanOutput, useDisplay } from "../../store/display";
import { ClaudeWorkBlock, LiveToolStep, ToolSection } from "./ToolSection";
import { SkillChip, UserText } from "./userText";
import { parseSpecialMessage } from "./specialMessage";
import { SpecialMessageCard } from "./SpecialMessageCard";
import { ErrorBlock, NoticeBlock } from "./noticeView";
import { useShallow } from "zustand/react/shallow";
import { LiveSubThread } from "./LiveSubThread";
import { WorkflowCard } from "./WorkflowCard";
import { ArtifactCard } from "./ArtifactCard";
import { resolveTranscriptSource } from "./transcriptSource";
import type { StickToBottom } from "./useStickToBottom";
import styles from "./ConductorThread.module.css";


const EMPTY_BLOCKS: NormalizedBlock[] = [];

/**
 * A stable key for matching a LIVE user turn's text against an on-disk human prompt when
 * locating a rewind/fork target by text (a live turn's front id isn't on disk). MUST mirror
 * the Rust `prompt_match_key` (supervisor/history.rs): a slash command reduces to its command
 * token (so the raw "/foo bar" typed live and the persisted "…<command-name>/foo…" header
 * agree), the image placeholder stays itself, a plain prompt maps to itself. Used both to
 * find the target and to count identical prior prompts (the occurrence disambiguator).
 */
function promptMatchKey(text: string): string {
  const t = text.trim();
  const m = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (m) return m[1].trim();
  if (t.startsWith("/")) return t.split(/\s+/)[0];
  return t;
}

/**
 * Discreet hover controls at the BOTTOM of a conversation message — bare icons (no frame,
 * no background), on both the user's and Claude's messages. Revealed on hover of the parent
 * `.cv-msg` (see conductor-conversation.css). Two actions, each gated INDEPENDENTLY by the
 * caller (the handler is `undefined` → its icon doesn't render):
 *  - rewind ("resume here"): rewind the conversation IN PLACE (destructive, confirmed);
 *  - fork ("fork here"): branch a NEW conversation at this message (non-destructive).
 * Both are hidden entirely when the `messageControls` pref is off or the agent is busy.
 */
function MessageActions({
  onRewind,
  onFork,
  forkBusy,
}: {
  onRewind?: () => void;
  onFork?: () => void;
  /** The fork for this message is in flight — spin its icon and block re-clicks. */
  forkBusy?: boolean;
}) {
  if (!onRewind && !onFork) return null;
  return (
    <div className="cv-msg-actions">
      {onRewind && (
        <button
          type="button"
          className="cv-msg-action"
          title="Resume the conversation from here (rewind)"
          aria-label="Resume the conversation from here"
          onClick={onRewind}
        >
          <Ico name="restart" />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          className={"cv-msg-action" + (forkBusy ? " is-busy" : "")}
          title="Fork a new conversation from here"
          aria-label="Fork a new conversation from here"
          onClick={onFork}
          disabled={forkBusy}
        >
          <Ico name={forkBusy ? "refresh" : "pr"} />
        </button>
      )}
    </div>
  );
}

export function MsgUser({
  text,
  queued,
  images,
  onRewind,
  onFork,
  forkBusy,
}: {
  text: string;
  queued?: boolean;
  images?: UserTurnImage[];
  /** When set, show the rewind hover control on this message. */
  onRewind?: () => void;
  /** When set, show the fork hover control on this message. */
  onFork?: () => void;
  /** The fork on this message is in flight (spin its icon). */
  forkBusy?: boolean;
}) {
  // A `<task-notification>` (and other CLI-injected markers) reaches us AS a user turn,
  // but the human didn't type it — render the clean card instead of a raw user bubble.
  const special = parseSpecialMessage(text);
  if (special) return <SpecialMessageCard data={special} />;
  return (
    <div className={"cv-msg cv-user" + (queued ? " is-queued" : "")}>
      <Avatar user><UserMark /></Avatar>
      <div className="cv-bubble">
        {queued ? (
          <span className="cv-queued-tag" title="Sent while the agent is working — will be handled along the way">
            <Ico name="clock" />
            pending
          </span>
        ) : null}
        {images && images.length ? (
          <div className="cv-user-images">
            {images.map((img, i) => (
              <img
                key={i}
                className="cv-user-image"
                src={imageDataUrl(img)}
                alt={img.name ?? "attached image"}
                title={img.name}
              />
            ))}
          </div>
        ) : null}
        {text.trim() ? <UserText text={text} /> : null}
        <MessageActions onRewind={onRewind} onFork={onFork} forkBusy={forkBusy} />
      </div>
    </div>
  );
}

/**
 * A message the user injected WHILE Claude was working ("while you were working"), rendered
 * inline inside the assistant round in clean output — a light note, not a full user bubble,
 * so it sits at its chronological place WITHOUT cutting the work fold (see coalesceCleanRounds).
 */
function InlineUserMarker({ session, turnId }: { session: string; turnId: string }) {
  const turn = useTurn(session, turnId);
  const text = turn?.streamingText ?? "";
  const images = turn?.images;
  const hasImages = !!(images && images.length);
  // Nothing to show only when there is neither text nor a joined image.
  if (!text.trim() && !hasImages) return null;
  // A CLI-injected special message (e.g. a `<task-notification>`) reaches us as a user turn
  // too — render its clean card, exactly like a standalone user turn (MsgUser), never raw XML.
  const special = text.trim() ? parseSpecialMessage(text) : null;
  if (special) return <SpecialMessageCard data={special} />;
  // Mirror MsgUser's affordance: while the message is still QUEUED (not yet delivered to the
  // CLI) show "pending", switching to "Message sent" once the badge clears on delivery.
  const queued = turn?.queued ?? false;
  return (
    <div className={styles.injectedMsg}>
      <span
        className={styles.injectedMsgTag}
        title={
          queued
            ? "Sent while the agent is working — will be handled along the way"
            : undefined
        }
      >
        <Ico name="clock" className="sm" />
        {queued ? "pending" : "Message sent"}
      </span>
      <div className={styles.injectedMsgBody}>
        {hasImages ? (
          <div className="cv-user-images">
            {images.map((img, i) => (
              <img
                key={i}
                className="cv-user-image"
                src={imageDataUrl(img)}
                alt={img.name ?? "attached image"}
                title={img.name}
              />
            ))}
          </div>
        ) : null}
        {text.trim() ? <UserText text={text} /> : null}
      </div>
    </div>
  );
}

function MsgError({ session, errorId }: { session: string; errorId: string }) {
  const err = useError(session, errorId);
  if (!err) return null;
  return <ErrorBlock detail={err.detail}>{err.message}</ErrorBlock>;
}

/** Control-channel + error notices surfaced from the core, keyed off the live store. The
 *  routing + visuals live in the pure `NoticeBlock` (`noticeView`) so the read-only
 *  transcript preview renders an error notice identically. */
function NoticeRow({ session, noticeId }: { session: string; noticeId: string }) {
  const notice = useNotice(session, noticeId);
  if (!notice) return null;
  return <NoticeBlock subtype={notice.subtype} detail={notice.detail} />;
}

/** A turn that ended in error: the CLI sends a `result` with `is_error` (or an
 *  `error_*` subtype) carrying the human error text — previously stored but never
 *  rendered (it fell through the timeline switch). Now a persistent error bubble
 *  with a typed heading. Successful / interrupted turns render nothing here. */
function turnErrorHeading(meta: { subtype: string; apiErrorStatus?: string | null }): string {
  if (meta.apiErrorStatus) return `API error: ${meta.apiErrorStatus}`;
  switch (meta.subtype) {
    case "error_max_turns":
      return "Turn limit reached";
    case "error_during_execution":
      return "Error during execution";
    default:
      return "The task ended in an error";
  }
}

function resultToText(result: JsonValue | null): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result.trim() || null;
  return JSON.stringify(result, null, 2);
}

function TurnResultRow({ session, resultId }: { session: string; resultId: string }) {
  const meta = useTurnResult(session, resultId);
  const showTurnDuration = useDisplay((s) => s.showTurnDuration);
  const showModelTime = useDisplay((s) => s.showModelTime);
  if (!meta) return null;
  const isError = meta.isError || meta.subtype.startsWith("error");
  if (isError) {
    const text = resultToText(meta.result);
    return <ErrorBlock heading={turnErrorHeading(meta)}>{text}</ErrorBlock>;
  }
  // Success / interrupted: optionally surface the wall-clock time the turn took
  // (duration_ms) plus the model-time breakdown (duration_api_ms). No cost/TTFT shown.
  if (!showTurnDuration || meta.durationMs == null) return null;
  return (
    <div className={styles.turnMeta + " wf-mono"} title="This turn's duration · including model time">
      <Ico name="clock" className="sm" />
      <span>{fmtDuration(meta.durationMs)}</span>
      {showModelTime && meta.durationApiMs != null && meta.durationApiMs > 0 && (
        <span className={styles.turnMetaModel}>{fmtDuration(meta.durationApiMs)} model</span>
      )}
    </div>
  );
}


/** Map a sub-agent's coarse lifecycle onto the design's status-dot colour token. */
function taskDotState(o: { running: boolean; failed: boolean; stopped: boolean }): StreamState {
  if (o.failed) return "err";
  if (o.running) return "work";
  if (o.stopped) return "off";
  return "done";
}


/**
 * A sub-agent launched by the `Agent` tool (ex-`Task`): a collapsible header with
 * the live lifecycle (label, type, running→done dot, tokens / tool-calls / duration
 * once finished) and, when expanded, the sub-agent's transcript INLINE. While it
 * runs we show the live sub-thread (streamed, keyed by this tool_use id); once
 * finished — or on a resumed conversation where the sub-thread wasn't replayed —
 * the full transcript is read from disk via `load_subagent_transcript`.
 *
 * Drill-down needs the claude session_id (durable) + the sub-agent's agent_id; the
 * latter is reported only by the LIVE task lifecycle, so a resumed conversation
 * degrades to the live sub-thread / a clear "unavailable" note instead.
 *
 * Renders nothing for a DETACHED sub-agent (`run_in_background`): those are surfaced
 * in the pinned <AgentBar>, not inline, to keep the thread clean.
 */
function SubAgentCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const task = useTaskByToolUse(session, toolUseId);
  const result = useToolResult(session, toolUseId);
  const state = useSessionState(session);
  const liveIds = useSubThread(session, toolUseId);
  // Detached even if this block's input lacked `run_in_background`: the store recovers it
  // from the launch ack into bgAgentIds. Belt-and-suspenders with groupBlocks (which already
  // hides the same id) so the inline card can never resurface for a detached agent.
  const detachedByAck = useBackgroundAgentIds(session).includes(toolUseId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );

  const status: BackgroundTaskStatus | null = task?.status ?? null;
  const label = field(input, "description") ?? task?.label ?? "Sub-agent";
  const subagentType = field(input, "subagent_type") ?? task?.subagent_type ?? null;
  const agentId = task?.agent_id ?? null;
  const model = task?.model ?? null;
  // Sub-agents inherit the conversation's reasoning effort (not recorded per sub-agent
  // anywhere), so the parent's effort is the best available signal.
  const effort = state?.effort ?? null;

  const running = status === "running" || (status === null && !result && (state?.busy ?? false));
  const failed = status === "failed" || (status === null && (result?.isError ?? false));
  const stopped = status === "stopped";
  const dot = taskDotState({ running, failed, stopped });

  const [open, setOpen] = useState(false);
  const [disk, setDisk] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchTranscript = useCallback(async () => {
    if (!claudeSessionId || !agentId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await commands.loadSubagentTranscript(claudeSessionId, agentId);
      if (res.status === "ok") setDisk(res.data);
      else setErr(res.error);
    } catch (e) {
      // A thrown IPC/transport error must NEVER be swallowed: surface it and clear the
      // loading state (the `finally` guarantees we don't get stuck "Loading…").
      console.error("loadSubagentTranscript threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [claudeSessionId, agentId]);

  // Fetch on open, and again once the task settles (running → terminal) so a
  // mid-run partial read is replaced by the complete transcript. Both effects depend
  // on `fetchTranscript` so a change of session/agent id re-binds to a fresh fetch
  // (no stale closure loading the wrong transcript).
  useEffect(() => {
    if (open) void fetchTranscript();
  }, [open, fetchTranscript]);
  useEffect(() => {
    if (open && status && status !== "running") void fetchTranscript();
  }, [open, status, fetchTranscript]);

  // A detached (run_in_background) sub-agent lives in the pinned AgentBar, not inline —
  // keep the thread clean. `detachedByAck` covers the case where the live block lacked the
  // input flag. All hooks above have run, so this conditional render is safe.
  if (isBackgroundAgentInput(input) || detachedByAck) return null;

  // The prompt sent to the sub-agent (the Agent tool's `prompt` input) — prepended to
  // the live view since the live sub-thread streams only the sub-agent's REPLIES. (The
  // disk transcript already carries it as its first user_message.)
  const promptText = field(input, "prompt");

  // Live → disk → fallback, resolved in one shared place (mirrored by <TranscriptPopover>).
  let body: ReactNode = null;
  if (open) {
    switch (
      resolveTranscriptSource({
        running,
        liveCount: liveIds.length,
        diskCount: disk?.length ?? 0,
        loading,
        error: err != null,
        resolvable: !!(claudeSessionId && agentId),
      })
    ) {
      case "live":
        body = <LiveSubThread session={session} ids={liveIds} promptText={promptText} />;
        break;
      case "disk":
        body = <SubAgentTranscript items={disk!} />;
        break;
      case "loading":
        body = <div className={styles.subEmpty}>Loading transcript…</div>;
        break;
      case "error":
        body = <div className={styles.subEmpty}>Transcript unreadable: {err}</div>;
        break;
      case "working":
        body = <div className={styles.subEmpty}>The sub-agent is working…</div>;
        break;
      case "unavailable":
        body = (
          <div className={styles.subEmpty}>Transcript unavailable (conversation reopened).</div>
        );
        break;
      case "empty":
        body = <div className={styles.subEmpty}>No transcript for this sub-agent.</div>;
        break;
    }
  }

  return (
    <div className="cv-tool">
      <div
        className="cv-tool-h"
        onClick={() => setOpen((o) => !o)}
        role="button"
        style={{ cursor: "pointer" }}
      >
        <Ico name="spark" className="sm" />
        <span className="cv-tool-t">Sub-agent</span>
        <span className="cv-tool-m" title={label}>
          {label}
        </span>
        {subagentType ? <span className={styles.subType}>{subagentType}</span> : null}
        <span className={styles.status}>
          <Dot s={dot} pulse={running} />
          <span
            style={{
              display: "inline-flex",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
              marginLeft: 4,
            }}
          >
            <Ico name="chev" className="sm" />
          </span>
        </span>
      </div>
      {model || effort || (task && (task.tokens != null || task.duration_ms != null || task.tool_uses != null)) ? (
        <div className={styles.subStats + " wf-mono"}>
          {model ? <span title={model}>{shortModel(model)}</span> : null}
          {effort ? <span>effort {effort}</span> : null}
          {task?.tokens != null ? <span>{fmtTokens(task.tokens)} tk</span> : null}
          {task?.tool_uses != null ? <span>{task.tool_uses} tools</span> : null}
          {task?.duration_ms != null ? <span>{fmtDuration(task.duration_ms)}</span> : null}
        </div>
      ) : null}
      {open ? <div className="cv-tool-b">{body}</div> : null}
    </div>
  );
}


/**
 * One collapsed section for a run of consecutive (non-sub-agent) tool steps. Its own
 * component so it can subscribe to the run's aggregate error state and auto-expand on
 * failure. Sub-agents are NOT here — they render inline via <SubAgentCard> (see
 * AssistantBlocks), keeping their live lifecycle and drill-in transcript.
 */
function LiveRunSection({
  session,
  steps,
  active,
  live,
}: {
  session: string;
  steps: ToolStep[];
  active: boolean;
  /** True while this run is the live trailing run → section stays expanded, collapses on settle. */
  live: boolean;
}) {
  const errored = useRunErrored(
    session,
    steps.map((s) => s.id),
  );
  return (
    <ToolSection title={runHeader(steps)} errored={errored} live={live}>
      {steps.map((step) => (
        <LiveToolStep key={step.id} session={session} step={step} active={active} />
      ))}
    </ToolSection>
  );
}

/** A FINALIZED thinking block with its frozen reflection time (looked up by text). Its own
 *  leaf so the lookup subscribes narrowly. No duration shown for disk-hydrated blocks. */
function FrozenThinkingBlock({ session, text }: { session: string; text: string }) {
  const show = useDisplay((s) => s.showThinkingTime);
  const durationMs = useThinkingDuration(session, text);
  return <ThinkingBlock text={text} finalized durationMs={show ? durationMs : null} />;
}

/** The thinking block currently STREAMING, with a live counter that ticks each second once
 *  it passes ~1s (floored, like {@link LiveElapsed}). Its own leaf so the 1 Hz tick doesn't
 *  re-render the rest of the response. */
function LiveThinkingBlock({ session, text }: { session: string; text: string }) {
  const show = useDisplay((s) => s.showThinkingTime);
  const startedAt = useThinkingStartedAt(session);
  const now = useNow(1000);
  const elapsed = startedAt != null ? now - startedAt : 0;
  const durationMs = show && elapsed >= 1000 ? Math.floor(elapsed / 1000) * 1000 : null;
  return <ThinkingBlock text={text} finalized={false} durationMs={durationMs} />;
}

/** Render a list of segments as the grouped transcript nodes. `active` marks segments
 *  belonging to the live turn (gates the running spinner); `liveIdx` is the index of the
 *  one run that should render EXPANDED & live (its steps appear as they stream), or -1.
 *  Shared by the normal flow and the inside of a folded <ClaudeWorkBlock>. */
function renderSegments(
  session: string,
  segs: Segment[],
  active: boolean,
  liveIdx: number,
): ReactNode[] {
  return segs.map((seg, i) => {
    if (seg.kind === "text") return <StreamMarkdown key={seg.key} text={seg.text} />;
    if (seg.kind === "thinking")
      return <FrozenThinkingBlock key={seg.key} session={session} text={seg.text} />;
    if (seg.kind === "marker")
      // An in-band marker absorbed into this round: a control-change bar (NoticeRow) or a
      // message injected mid-work (InlineUserMarker), rendered in place — never cuts the work.
      return seg.markerKind === "notice" ? (
        <NoticeRow key={seg.key} session={session} noticeId={seg.id} />
      ) : (
        <InlineUserMarker key={seg.key} session={session} turnId={seg.id} />
      );
    if (seg.kind === "agent")
      // A sub-agent always renders inline (live lifecycle + drill-in transcript),
      // never grouped nor hidden by the live-trailing suppression.
      return (
        <SubAgentCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    if (seg.kind === "workflow")
      // A Workflow renders as a persistent inline card (opens the live overview / report).
      return (
        <WorkflowCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    if (seg.kind === "skill")
      // A model-invoked slash-command renders as a dedicated command chip (never a raw tool row).
      return <SkillChip key={seg.key} input={seg.step.input} />;
    if (seg.kind === "plan")
      // A proposed plan (ExitPlanMode) renders as its own prominent card: the plan markdown,
      // its accept/reject decision (hosted here, not in the bottom AskTurn), and annotations.
      return (
        <PlanCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    if (seg.kind === "artifact")
      // An `Artifact` publish renders as its own inline card, opening the hosted claude.ai page.
      return (
        <ArtifactCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    if (seg.kind === "question")
      // A question to the user renders as its own inline card (question + chosen answer)
      // anchoring the exchange in the flow; the interactive ask stays in the bottom AskTurn.
      return (
        <QuestionCard
          key={seg.key}
          session={session}
          toolUseId={seg.step.id}
          input={seg.step.input}
        />
      );
    // A `run` of regular tools. The trailing run of the live turn renders EXPANDED so its
    // steps appear live (spinner → result), then collapses to its header on settle. Past
    // / non-trailing runs render collapsed. `active` gates the spinner so a resultless
    // step in a PAST turn never spins when the session is busy later.
    return (
      <LiveRunSection
        key={seg.key}
        session={session}
        steps={seg.steps}
        active={active}
        live={i === liveIdx}
      />
    );
  });
}

/** The live sliding window: how many trailing steps stay visible (current activity) before
 *  the rest fold into the block. */
const LIVE_WINDOW = 3;

/** Render a clean-output round's folded WORK. Normally one collapsible <ClaudeWorkBlock>. But a
 *  `plan` (ExitPlanMode) is a DECISION artifact that must never hide inside the fold — even when
 *  it's buried mid-round (e.g. a resumed history where an approved plan is followed by more work
 *  in the same group, so splitFinalMessage can't peel it into `final`). When the fold holds a
 *  plan, split it at each plan: every contiguous work run folds into its own block and each plan
 *  renders in clear between them, preserving chronology. The common (no-plan) case is byte-for-byte
 *  unchanged and keeps the round's single foldKey, so its remembered open/collapsed state stands. */
function renderFoldedWork(session: string, folded: Segment[], roundKey: string): ReactNode {
  // A `plan`, an `artifact` or a `question` is a decision/deliverable that must never hide
  // inside the fold, even when buried mid-round (e.g. an answered AskUserQuestion followed by
  // more work in the same group): split the fold at each so it renders in clear between runs.
  const cuts = (s: Segment) =>
    s.kind === "plan" || s.kind === "artifact" || s.kind === "question";
  if (!folded.some(cuts)) {
    return (
      <ClaudeWorkBlock count={countWorkSteps(folded)} foldConv={session} foldKey={roundKey}>
        {renderSegments(session, folded, false, -1)}
      </ClaudeWorkBlock>
    );
  }
  const out: ReactNode[] = [];
  let chunk: Segment[] = [];
  let part = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const c = chunk;
    const idx = part++;
    out.push(
      <ClaudeWorkBlock
        key={`fold-${idx}`}
        count={countWorkSteps(c)}
        foldConv={session}
        foldKey={`${roundKey}#${idx}`}
      >
        {renderSegments(session, c, false, -1)}
      </ClaudeWorkBlock>,
    );
    chunk = [];
  };
  for (const seg of folded) {
    if (cuts(seg)) {
      flush();
      out.push(...renderSegments(session, [seg], false, -1));
    } else {
      chunk.push(seg);
    }
  }
  flush();
  return out;
}

/**
 * The clean-output body of one assistant response: the fold + the trailing region + the final
 * message, rendered as ONE component so it has stable React identity. That stability is what
 * fixes the fold collapsing on settle — the SAME `<ClaudeWorkBlock>` fiber spans the live and
 * the settled render, so a block the user expanded mid-stream stays open when the response
 * finishes (live → settled is just a prop change here, not a remount).
 *
 * It subscribes to EXACTLY this response's tool results (which ids are still running) via a
 * shallow-compared boolean array, so a settled response never re-renders while a LATER turn
 * streams — only the live one (whose ids gain results) re-renders.
 *
 *  - live: settled work folds; the sliding window AND any still-running command / sub-agent
 *    stay visible (see {@link liveVisibleStart}); the trailing run shows live.
 *  - settled, with a final message: ALL the work folds, the final message shows in clear.
 *  - settled, ending on tools (no final): rendered unfolded — folding everything would leave
 *    nothing in clear.
 */
function CleanBlocks({
  session,
  work,
  final,
  live,
  roundKey,
}: {
  session: string;
  work: Segment[];
  final: Segment[];
  live: boolean;
  /** Stable id of this assistant round (its first turn id) — with `session` (the stable
   *  conversation id) it keys the fold's remembered open state so it survives a switch. */
  roundKey: string;
}) {
  const ids = workStepIds(work);
  // Per-id "has a tool_result?" for THIS response's tools. Shallow-compared so the component
  // re-renders only when one of ITS ids settles — a past response never re-renders while a
  // later turn streams.
  const hasResult = useConversationStore(
    useShallow((s) => {
      const tr = s.sessions[session]?.toolResults;
      return ids.map((id) => !!tr?.[id]);
    }),
  );
  // Per-id background-task status (or null when none). A sub-agent's tool_result can land
  // before its terminal task_notification, so the result alone would fold a card that still
  // shows the running dot — see atomStillRunning. Shallow-compared, same scoping as above.
  const taskStatus = useBackgroundTasksStore(
    useShallow((s) => {
      const tasks = s.sessions[session];
      return ids.map((id) => {
        if (tasks) {
          for (const t of Object.values(tasks)) if (t.tool_use_id === id) return t.status;
        }
        return null;
      });
    }),
  );
  const runningById = new Map<string, boolean>();
  ids.forEach((id, i) =>
    runningById.set(id, atomStillRunning({ hasResult: hasResult[i] ?? false, taskStatus: taskStatus[i] ?? null })),
  );
  const isRunning = (id: string) => runningById.get(id) ?? false;

  // Settled response ending on tools (no closing prose): render unfolded — folding everything
  // would leave nothing in clear.
  if (final.length === 0 && !live) {
    return <>{renderSegments(session, work, false, -1)}</>;
  }

  const atoms = flattenWork(work);
  const split = live ? liveVisibleStart(atoms, isRunning, LIVE_WINDOW) : atoms.length;
  const folded = atomsToSegments(atoms.slice(0, split), "fold");
  const visible = live ? atomsToSegments(atoms.slice(split), "vis") : [];
  // Expand the trailing run of the visible region so its steps show live (spinner → result).
  let liveIdx = -1;
  visible.forEach((s, i) => {
    if (s.kind === "run") liveIdx = i;
  });

  return (
    <>
      {folded.length > 0 ? renderFoldedWork(session, folded, roundKey) : null}
      {visible.length > 0 ? renderSegments(session, visible, true, liveIdx) : null}
      {final.length > 0 ? renderSegments(session, final, false, -1) : null}
    </>
  );
}

/**
 * An assistant turn's blocks as the grouped transcript. Default: prose / thinking inline,
 * every run of consecutive tool calls coalesced into one section (`groupBlocks`); the live
 * turn's trailing run shows EXPANDED & live, collapsing on settle.
 *
 * When the "clean output" pref is ON, the response's intermediate work folds into one
 * <ClaudeWorkBlock>, leaving only the concluding message in clear — see {@link CleanBlocks}
 * for the live / settled / ends-on-tools cases and the stable-fold behaviour.
 */
function AssistantBlocks({
  session,
  blocks,
  live,
  roundKey,
}: {
  session: string;
  /** Content blocks, possibly with in-band marker sentinels spliced in (clean output). */
  blocks: GroupInput[];
  live: boolean;
  /** Stable id of this assistant round (first turn id), forwarded to the clean-output fold
   *  so its open/collapsed state is remembered per conversation. */
  roundKey: string;
}) {
  // Clean output is per-conversation now: the effective value is this conversation's
  // explicit choice, else the global default. `session` is the stable conversation id.
  const cleanOutput = useEffectiveCleanOutput(session);
  // Detached sub-agents live in the pinned AgentBar, never inline. Normally detected from
  // the tool_use input flag; `bgAgentIds` ALSO carries any recovered from a launch ack (when
  // the live block lacked `run_in_background`), so a transient wire drop can't leak a
  // background agent into the thread. Shallow-compared → stable ref unless a new one appears.
  const bgAgentIds = useBackgroundAgentIds(session);
  const bgSet = useMemo(() => new Set(bgAgentIds), [bgAgentIds]);
  const segments = groupBlocks(blocks, false, bgSet);

  if (!cleanOutput) {
    const lastIdx = segments.length - 1;
    return <>{renderSegments(session, segments, live, live ? lastIdx : -1)}</>;
  }

  // Clean output: fold this response's intermediate work, keep the concluding message in
  // clear. Rendered through ONE component (CleanBlocks) so the fold keeps its open state
  // across the live → settled transition; it handles the live / settled / ends-on-tools
  // cases internally.
  const { work, final } = splitFinalMessage(segments);
  return <CleanBlocks session={session} work={work} final={final} live={live} roundKey={roundKey} />;
}

function MsgAI({
  session,
  turnId,
  busy,
  awaiting,
}: {
  session: string;
  turnId: string;
  busy: boolean;
  awaiting: boolean;
}) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  // The trailing run is shown live (bottom indicator) only for the turn that is ACTIVELY
  // streaming — keyed on the turn's own status, not the last timeline entry, so a queued
  // user message landing after it doesn't un-suppress this run; and not while paused on a
  // permission prompt (`awaiting`), so the pending tool still shows as a section.
  const live = busy && !awaiting && turn.status === "streaming";
  return (
    <div className="cv-msg cv-ai">
      <AiAvatar session={session} />
      <div className="cv-aibody">
        {/* Finalized blocks accumulated so far, then the block currently being
            typed as a live tail. Both render together so an already-shown block is
            never swapped out — the text between two tools stays put. */}
        {turn.blocks.length > 0 && (
          <AssistantBlocks session={session} blocks={turn.blocks} live={live} roundKey={turnId} />
        )}
        {turn.streamingThinking && <LiveThinkingBlock session={session} text={turn.streamingThinking} />}
        {turn.streamingText && <StreamMarkdown text={turn.streamingText} streaming />}
      </div>
    </div>
  );
}

/**
 * An ASSISTANT response = one OR MORE consecutive assistant turns (messages) rendered as
 * ONE flow under a single avatar. Their blocks are concatenated, so a run of tool calls
 * spread across several messages — the agent's loop emits one tool per message — groups
 * into ONE section; only a real text message breaks the run. The LAST turn carries the
 * live streaming tail and drives `live`.
 *
 * `markers` (clean output) are in-band items — a control-change bar, a message injected
 * mid-work — that split this response in the raw plan but were coalesced back in (see
 * coalesceCleanRounds). They're spliced into the block stream at their turn boundaries so
 * they render inline in place, WITHOUT cutting the work fold.
 */
function MsgAIGroup({
  session,
  turnIds,
  markers,
  busy,
  awaiting,
  onRewind,
  onFork,
  forkBusy,
}: {
  session: string;
  turnIds: string[];
  markers?: RoundMarker[];
  busy: boolean;
  awaiting: boolean;
  /** When set, show the rewind hover control on this response. */
  onRewind?: () => void;
  /** When set, show the fork hover control on this response. */
  onFork?: () => void;
  /** The fork on this response is in flight (spin its icon). */
  forkBusy?: boolean;
}) {
  // Per-turn blocks (shallow-compared: each turn's `blocks` is a stable ref) so we can splice
  // the markers back at their turn boundaries. With no markers this is just the concatenated
  // stream — identical to the plain grouped blocks.
  const blocksByTurn = useConversationStore(
    useShallow((s) =>
      turnIds.map((id) => s.sessions[session]?.turns[id]?.blocks ?? EMPTY_BLOCKS),
    ),
  );
  const lastTurn = useTurn(session, turnIds[turnIds.length - 1]);
  // Turns stay "streaming" until turn_result, so the group is live while its last turn
  // streams → the combined trailing run shows live and collapses once the turn settles.
  const live = busy && !awaiting && lastTurn?.status === "streaming";
  const blocks = useMemo(
    () => interleaveMarkers(blocksByTurn, markers ?? []),
    [blocksByTurn, markers],
  );
  return (
    <div className="cv-msg cv-ai">
      <AiAvatar session={session} />
      <div className="cv-aibody">
        {blocks.length > 0 && (
          <AssistantBlocks session={session} blocks={blocks} live={live} roundKey={turnIds[0]} />
        )}
        {lastTurn?.streamingThinking && (
          <LiveThinkingBlock session={session} text={lastTurn.streamingThinking} />
        )}
        {lastTurn?.streamingText && <StreamMarkdown text={lastTurn.streamingText} streaming />}
        <MessageActions onRewind={onRewind} onFork={onFork} forkBusy={forkBusy} />
      </div>
    </div>
  );
}

// ---- Ask box (the real request: question / permission / questionnaire) ----

function AskTurn({ session, request }: { session: string; request: PermissionRequestPayload }) {
  const answer = useAnswerPermission(session);
  // AskUserQuestion is an interactive questionnaire, not a yes/no prompt.
  if (request.tool_name === "AskUserQuestion") {
    return <QuestionnaireAsk session={session} request={request} />;
  }
  const ask = classifyAsk(request);
  const allow = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "allow", updated_input: null } });
  const deny = () =>
    answer.mutate({ requestId: request.request_id, decision: { behavior: "deny", message: "Rejected." } });

  return (
    <div className="cv-msg cv-ai">
      <AiAvatar session={session} />
      <div className="cv-aibody">
        <div className="cv-ask-turn">
          <div className="wf-ask">
            <div className="wf-ask-h">
              <Ico name="key" className="sm" />
              Requesting permission
            </div>
            <div className="wf-ask-t">{ask.text}</div>
            {ask.cmd ? <code className="wf-ask-cmd wf-mono">$ {ask.cmd}</code> : null}
          </div>
          <div className="wf-row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button className="wf-btn ghost sm" onClick={deny}>
              Reject
            </button>
            <button className="wf-btn prim sm" onClick={allow}>
              <Ico name="check" className="sm" />
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConductorThread({
  session,
  scrollRef,
  onRender,
  disableControls = false,
}: {
  session: string;
  // The stick-to-bottom instance is owned by the parent pane so the composer can
  // snap the thread to the bottom on send (see ConductorConversation).
  scrollRef: StickToBottom["scrollRef"];
  onRender: StickToBottom["onRender"];
  /** Suppress the per-message rewind/fork hover controls (set by the Flight Deck reply
   *  modal — a destructive rewind or a background-switching fork is never meant there). */
  disableControls?: boolean;
}) {
  const rawPlan = useTimelineRender(session);
  // In clean output, a mid-turn marker (control-change bar / injected message) split the
  // assistant response into two `ai` groups → two work sections. Coalesce them back into one
  // round, absorbing the markers as inline items so they render in place without cutting the
  // fold. The default plan is untouched (markers keep rendering as their own rows).
  const cleanOutput = useEffectiveCleanOutput(session);
  const notices = useConversationStore((s) => s.sessions[session]?.notices);
  const plan = useMemo(() => {
    if (!cleanOutput) return rawPlan;
    // A `user` turn is absorbed as an in-band marker ONLY if it was injected mid-work (durable
    // `injectedMidTurn`); a genuine new prompt starts its own round. This keeps a RESUMED
    // conversation correct — hydrated history has no turn_result boundaries and no injection
    // flag, so without this gate every past prompt would collapse into one giant fold.
    //
    // `injectedMidTurn` is immutable once set and `rawPlan` already changes whenever a turn is
    // added, so we read the turns map NON-reactively (getState) rather than subscribing to it —
    // subscribing would re-run this on every streamed token and re-render the whole thread.
    const turns = useConversationStore.getState().sessions[session]?.turns;
    return coalesceCleanRounds(
      rawPlan,
      (id) => notices?.[id]?.subtype,
      (id) => turns?.[id]?.injectedMidTurn ?? false,
    );
  }, [cleanOutput, rawPlan, notices, session]);
  const pending = usePendingPermissions(session);
  const state = useSessionState(session);
  const busy = state?.busy ?? false;
  const awaiting = state?.awaiting_permission ?? false;
  const empty = plan.length === 0 && pending.length === 0;

  // ── Message hover controls: rewind (in place) + fork (new conversation) ──
  // Gated by the display pref, and only on a SETTLED conversation (both operate on the
  // on-disk transcript and rewind kills the live process — racing a live turn is unsafe),
  // and never in a lightweight surface (the reply modal). `session` is the STABLE conv id.
  //
  // Rewind/fork work on BOTH backends. Claude truncates its on-disk transcript by prompt text;
  // Codex has no in-place truncation, so it FORKS the thread through the chosen turn
  // (thread/fork{lastTurnId}) and swaps onto the branch — targeting by Codex turn id, not text.
  // ⚠️ Neither reverts on-disk file changes — history only (spelled out in the confirm dialog).
  const isCodex = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.kind === "codex",
  );
  const messageControls = useDisplay((s) => s.messageControls);
  const runningBgTasks = useRunningTaskCount(session);
  const showControls = messageControls && !busy && !awaiting && !disableControls;
  // { target message id, is-user, its clean composer text, occurrence, and — for Codex — the
  // turn id to fork THROUGH } set on click; the rewind opens a confirm. `text`/`occurrence` are
  // the Claude fallback locator for a LIVE turn (synthetic front id not on disk; occurrence
  // disambiguates identical repeated prompts). `codexLastTurnId` is the Codex locator instead.
  const [rewindTarget, setRewindTarget] = useState<
    { id: string; isUser: boolean; text: string | null; occurrence: number | null; codexLastTurnId: string | null } | null
  >(null);
  const [rewinding, setRewinding] = useState(false);
  // The message whose fork is in flight (spins its icon; blocks a re-click). The thread
  // usually unmounts on success (the branch becomes active), so this mostly matters on error.
  const [forkingId, setForkingId] = useState<string | null>(null);
  // The FIRST user prompt is never a cut point — it would empty the branch/conversation
  // (the core refuses it too). A user prompt is rewindable/forkable when it's not first.
  const firstUserIdx = useMemo(() => plan.findIndex((i) => i.kind === "user"), [plan]);
  // A REWIND of a response is a no-op unless a later prompt follows it (nothing to remove);
  // a FORK is always valid on a response (it branches everything up to & including it).
  const hasUserAfter = useCallback(
    (k: number) => plan.slice(k + 1).some((i) => i.kind === "user"),
    [plan],
  );
  // Whether a user turn was INJECTED mid-work (queued while the agent ran). Such a turn is
  // NOT a clean round boundary — cutting there can land mid-response — and clean-output
  // already treats it as an in-band marker, so it must not be a rewind/fork target.
  const isInjected = useCallback(
    (id: string): boolean =>
      useConversationStore.getState().sessions[session]?.turns[id]?.injectedMidTurn ?? false,
    [session],
  );
  // The locator for a USER target: its clean text (the image placeholder for an image-only
  // turn so the on-disk "[image]" line still matches) plus the occurrence — how many prior
  // user turns share its match-key — so an identical repeated prompt cuts at the right one.
  const userTarget = useCallback(
    (id: string): { text: string; occurrence: number } => {
      const s = useConversationStore.getState().sessions[session];
      const turnOf = (tid: string) => {
        const t = s?.turns[tid];
        const raw = t?.streamingText ?? "";
        const hasImg = !!(t?.images && t.images.length);
        return raw.trim() === "" && hasImg ? "[image]" : raw;
      };
      const text = turnOf(id);
      const key = promptMatchKey(text);
      let occurrence = 0;
      for (const e of s?.timeline ?? []) {
        if (e.id === id) break;
        const t = s?.turns[e.id];
        if (t?.role !== "user") continue;
        if (promptMatchKey(turnOf(e.id)) === key) occurrence++;
      }
      return { text, occurrence };
    },
    [session],
  );
  // Codex ONLY: the turn id to fork THROUGH for a rewind/fork at plan index `idx`. Codex targets
  // a turn boundary by id (not by text like Claude). An AI-response target keeps THROUGH its own
  // turn → its Codex turn id. A user target removes that turn + everything after → keep through
  // the PREVIOUS turn → the nearest preceding AI group's Codex turn id. `null` when unavailable
  // (a Claude conv, or a turn with no surfaced id — e.g. the first turn, or a pre-`turn_context`
  // cold line): the caller then does NOT offer the control, so we never fork the whole thread by
  // accident.
  const codexCutTurnId = useCallback(
    (idx: number, isUser: boolean): string | null => {
      if (!isCodex) return null;
      const s = useConversationStore.getState().sessions[session];
      // Every item of an AI group carries the SAME Codex turn id; scan the group for the
      // first id that has one (the final agent_message reliably does, but a group's last id
      // could be a tool card whose stamp raced) rather than trusting only the last.
      const groupTurnId = (ids: string[]): string | null => {
        for (const tid of ids) {
          const t = s?.turns[tid]?.codexTurnId;
          if (t) return t;
        }
        return null;
      };
      if (!isUser) {
        const item = plan[idx];
        return item && item.kind === "ai" ? groupTurnId(item.ids) : null;
      }
      for (let k = idx - 1; k >= 0; k--) {
        const p = plan[k];
        if (p.kind === "ai") return groupTurnId(p.ids);
      }
      return null;
    },
    [isCodex, plan, session],
  );
  const doRewind = useCallback(async () => {
    const target = rewindTarget;
    if (!target) return;
    setRewinding(true);
    try {
      await rewindConversation(
        session,
        target.id,
        target.isUser,
        target.text,
        target.occurrence,
        target.codexLastTurnId,
      );
    } catch {
      /* the failure was already surfaced as an app error by rewindConversation */
    } finally {
      setRewinding(false);
      setRewindTarget(null);
    }
  }, [rewindTarget, session]);
  const doFork = useCallback(
    async (id: string, isUser: boolean, codexLastTurnId: string | null = null) => {
      if (forkingId) return; // guard a double-click (the thread unmounts on switch)
      setForkingId(id);
      const loc = isUser ? userTarget(id) : null;
      try {
        await forkConversation(
          session,
          id,
          isUser,
          loc ? loc.text : null,
          loc ? loc.occurrence : null,
          codexLastTurnId,
        );
      } catch {
        /* already surfaced as an app error by forkConversation */
      } finally {
        setForkingId(null);
      }
    },
    [session, userTarget, forkingId],
  );
  // Re-gate the OPEN confirm dialog: if the session goes active (a turn started out-of-band —
  // a remote/mobile message, a native injection) after the dialog opened, cancel the pending
  // rewind so we never truncate against a live writer / discard the just-arrived turn.
  useEffect(() => {
    if (rewindTarget && (busy || awaiting)) setRewindTarget(null);
  }, [busy, awaiting, rewindTarget]);

  return (
    <div className="cv-thread" ref={scrollRef}>
      <StreamFollow session={session} onRender={onRender} />
      <div className="cv-thread-inner">
        {empty && !busy ? (
          <div className={styles.empty}>Start the conversation by sending a message.</div>
        ) : (
          <>
            <div className="cv-day">
              <span className="wf-line" />
              today
              <span className="wf-line" />
            </div>
            {plan.map((item, idx) => {
              if (item.kind === "ai") {
                const aiId = item.ids[item.ids.length - 1];
                return (
                  <MsgAIGroup
                    key={item.ids[0]}
                    session={session}
                    turnIds={item.ids}
                    markers={item.markers}
                    busy={busy}
                    awaiting={awaiting}
                    onRewind={
                      showControls && hasUserAfter(idx) && (!isCodex || codexCutTurnId(idx, false) != null)
                        ? () =>
                            setRewindTarget({
                              id: aiId,
                              isUser: false,
                              text: null,
                              occurrence: null,
                              codexLastTurnId: codexCutTurnId(idx, false),
                            })
                        : undefined
                    }
                    onFork={
                      showControls && (!isCodex || codexCutTurnId(idx, false) != null)
                        ? () => doFork(aiId, false, codexCutTurnId(idx, false))
                        : undefined
                    }
                    forkBusy={forkingId === aiId}
                  />
                );
              }
              if (item.kind === "user") {
                // Not the first prompt, and not a mid-work injection (not a clean boundary).
                const usable =
                  showControls &&
                  idx !== firstUserIdx &&
                  !isInjected(item.id) &&
                  (!isCodex || codexCutTurnId(idx, true) != null);
                return (
                  <TurnRow
                    key={item.id}
                    session={session}
                    turnId={item.id}
                    onRewind={
                      usable
                        ? () => {
                            const loc = userTarget(item.id);
                            setRewindTarget({
                              id: item.id,
                              isUser: true,
                              text: loc.text,
                              occurrence: loc.occurrence,
                              codexLastTurnId: codexCutTurnId(idx, true),
                            });
                          }
                        : undefined
                    }
                    onFork={usable ? () => doFork(item.id, true, codexCutTurnId(idx, true)) : undefined}
                    forkBusy={forkingId === item.id}
                  />
                );
              }
              if (item.kind === "error")
                return <MsgError key={item.id} session={session} errorId={item.id} />;
              if (item.kind === "notice")
                return <NoticeRow key={item.id} session={session} noticeId={item.id} />;
              if (item.kind === "turn_result")
                return <TurnResultRow key={item.id} session={session} resultId={item.id} />;
              return null;
            })}
            {pending
              // ExitPlanMode's approval is hosted ON its plan card (see PlanCard) — which
              // finds this pending request by tool_use_id — so it must NOT also appear as a
              // generic yes/no AskTurn at the bottom. A pending plan is always the trailing
              // block (the agent pauses right after proposing it), so its card is on screen.
              .filter((req) => req.tool_name !== "ExitPlanMode")
              .map((req) => (
                <AskTurn key={req.request_id} session={session} request={req} />
              ))}
            {busy && !awaiting && <WorkingIndicator session={session} />}
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!rewindTarget}
        danger
        busy={rewinding}
        title="Resume the conversation from here?"
        confirmLabel="Rewind"
        onCancel={() => setRewindTarget(null)}
        onConfirm={doRewind}
      >
        {rewindTarget?.isUser ? (
          <>
            This message and everything after it will be <strong>permanently deleted</strong> from the
            conversation. Its text returns to the input box so you can resend it.
          </>
        ) : (
          <>
            Everything after this response will be <strong>permanently deleted</strong> from the
            conversation. The response itself is kept.
          </>
        )}
        {isCodex ? (
          <div className="cv-rewind-warn">
            <Ico name="alert" />
            <span>
              Only the conversation history is rewound: files already modified on disk are not
              restored.
            </span>
          </div>
        ) : null}
        {runningBgTasks > 0 ? (
          <div className="cv-rewind-warn">
            <Ico name="alert" />
            <span>
              {runningBgTasks === 1
                ? "One running background task will be stopped."
                : `${runningBgTasks} running background tasks will be stopped.`}
            </span>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** Below this many ms of a turn running, the live elapsed counter stays hidden — short
 *  turns don't need a stopwatch. Once a turn runs past it, the counter appears and ticks
 *  each second (like the CLI, which starts showing elapsed time on long-running turns). */
const TURN_ELAPSED_MIN_MS = 40_000;

/** The live elapsed counter (🕐 40s → 1m 04s) shown at the right of the working line once
 *  the turn passes {@link TURN_ELAPSED_MIN_MS}. Gated on the same `showTurnDuration` pref
 *  as the finished-turn footer, and its own leaf so its 1 Hz tick doesn't re-render the
 *  activity text. Whole seconds only (floored) so the number climbs smoothly. */
function LiveElapsed({ session }: { session: string }) {
  const show = useDisplay((s) => s.showTurnDuration);
  const startedAt = useTurnStartedAt(session);
  const now = useNow(1000);
  if (!show || startedAt == null) return null;
  const elapsed = now - startedAt;
  if (elapsed < TURN_ELAPSED_MIN_MS) return null;
  return (
    <span className={styles.elapsed + " wf-mono"} title="Current turn duration">
      <Ico name="clock" className="sm" />
      {fmtDuration(Math.floor(elapsed / 1000) * 1000)}
    </span>
  );
}

/**
 * The live "what's happening now" line shown under the timeline while the agent
 * works. Its own leaf so the per-token activity recompute (`useActivityLabel`
 * re-derives on every streamed delta, and ticks once a second for the playful
 * word's cumulative-time tier) re-renders only this row, not the message list.
 * Shares its classification with the FlightDeck card, so the thread and the card
 * never describe the agent differently — instead of the raw protocol hint.
 */
function WorkingIndicator({ session }: { session: string }) {
  const activity = useActivityLabel(session);
  // Special case: when the live tool is a FOREGROUND shell command, show it
  // terminal-style ("$ command…") rather than the generic "Running …" phrase — the
  // bottom-of-terminal feel of the CLI. Any other activity keeps the plain line.
  const bash = useLiveBashCommand(session);
  return (
    <div className={styles.activity}>
      <span className={styles.typing} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {bash ? (
        <code className={"cv-shellrun wf-mono"} title={bash}>
          <span className="cv-shellrun-p" aria-hidden="true">$</span>
          {bash}
        </code>
      ) : (
        <RollText text={activity} />
      )}
      <LiveElapsed session={session} />
    </div>
  );
}

/**
 * Invisible leaf that drives scroll positioning. It subscribes to the whole session
 * entry, so it re-renders on every store update for this session (each streamed token,
 * each state change, the async history replay), and calls `onRender` in a layout
 * effect — before paint — so positioning (initial restore, then stick-to-bottom while
 * streaming) tracks updates with no visible jump. Isolated in its own component so
 * this per-token re-render doesn't re-render the message list.
 */
function StreamFollow({ session, onRender }: { session: string; onRender: () => void }) {
  useConversationStore((s) => s.sessions[session]);
  useLayoutEffect(() => {
    onRender();
  });
  return null;
}

export function TurnRow({
  session,
  turnId,
  busy = false,
  awaiting = false,
  onRewind,
  onFork,
  forkBusy,
}: {
  session: string;
  turnId: string;
  /** Session-level flags; MsgAI derives `live` from them + the turn's own status. */
  busy?: boolean;
  awaiting?: boolean;
  /** Rewind/fork handlers for a USER turn (passed through to MsgUser's hover controls). */
  onRewind?: () => void;
  onFork?: () => void;
  forkBusy?: boolean;
}) {
  const turn = useTurn(session, turnId);
  if (!turn) return null;
  if (turn.role === "user")
    return (
      <MsgUser
        text={turn.streamingText}
        queued={turn.queued}
        images={turn.images}
        onRewind={onRewind}
        onFork={onFork}
        forkBusy={forkBusy}
      />
    );
  return <MsgAI session={session} turnId={turnId} busy={busy} awaiting={awaiting} />;
}
