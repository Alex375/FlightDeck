// A floating overlay showing a sub-agent's full transcript, opened from the pinned
// AgentBar (conversation) or the FlightDeck badge. Portal + scrim (same pattern as
// ConfirmDialog) so it floats above every stacking context; Escape or a scrim click
// closes it. The body reuses the read-only <SubAgentTranscript> renderer; the items
// are read via `load_subagent_transcript` when it opens — routed by the conversation: this
// Mac's disk, or the conversation's SERVER when it runs on one (the transcript lives there,
// and this Mac's disk would only ever answer "not written yet").

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BackgroundTask, ConversationItem, FileReadError } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useAgentWake, useSubAgentPrompt, useSubThread } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";
import { SubAgentTranscript } from "./SubAgentTranscript";
import { LiveSubThread } from "./LiveSubThread";
import { useConvMachineId, useConvStreaming } from "./ConvMark";
import { fileReadErrorText } from "./remoteRead";
import { resolveTranscriptSource } from "./transcriptSource";
import styles from "./TranscriptPopover.module.css";

export function TranscriptPopover({
  open,
  sessionId,
  agentId,
  liveSession,
  toolUseId,
  running = false,
  wokenBy,
  label,
  subtitle,
  fallback,
  fallbackAnswersWake = false,
  onClose,
}: {
  open: boolean;
  /** Claude's own session_id (durable) — the key for the on-disk transcript. */
  sessionId: string | null;
  /** The sub-agent's id; null when it can't be resolved (e.g. resumed conversation). */
  agentId: string | null;
  /** The store session key (conversation's stable id): the live sub-thread fallback, and
   *  where the transcript is read (this Mac or the conversation's server). */
  liveSession?: string | null;
  /** The Agent tool_use id that spawned the sub-agent — the live sub-thread's parent key. */
  toolUseId?: string | null;
  /** Whether the task is still running (prefer the live sub-thread while it is). */
  running?: boolean;
  /** The SendMessage that started the task's current run (`BackgroundTask.woken_by`), when
   *  it is a wake: the live view then follows THAT run. */
  wokenBy?: string | null;
  label: ReactNode;
  /** Optional second line in the header (e.g. subagent_type · model). */
  subtitle?: ReactNode;
  /** Shown under the reason when the transcript can't be shown (unreadable, unavailable, not
   *  written), so content the caller already holds — a sub-agent's report — is not lost with it. */
  fallback?: ReactNode;
  /** The fallback answers the message that woke the run shown (`wokenBy`): the report that
   *  run handed back. Only then is it also appended under a live view holding nothing but
   *  that message — the report of an EARLIER run, under a later run's wake, reads as its
   *  answer when it is not. */
  fallbackAnswersWake?: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<FileReadError | string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const remote = useConvMachineId(liveSession ?? "") != null;
  // The run as far as the LIVE view goes: still running AND still streaming here. A remote
  // conversation's session can end while its process — and this run — go on on the server
  // (the phone took it over, the link failed for good): the sub-thread then stops where the
  // Mac lost it, and the server's transcript is the only current copy.
  const streaming = useConvStreaming(liveSession ?? "");
  const liveRunning = running && streaming;
  // Where the stream said the transcript is (an `Agent` task's `output_file`): lets a server
  // read go straight to it instead of searching. A stable string selector.
  const hint = useBackgroundTasksStore((s) => agentOutputFile(s.sessions[liveSession ?? ""], agentId));

  // Live sub-thread fallback: when the agent_id can't be resolved (or the disk
  // transcript isn't written yet) but the agent streamed into the store, render that —
  // the same source the inline <SubAgentCard> uses. Fixes the FlightDeck drill-down
  // showing "transcript unavailable" for an agent that renders fine in the thread.
  const threadIds = useSubThread(liveSession ?? "", toolUseId ?? "");
  // The prompt the sub-agent was launched with — the live sub-thread carries only its
  // replies, so prepend it as the opening user turn (the disk transcript already has it).
  const launchPrompt = useSubAgentPrompt(liveSession ?? "", toolUseId ?? "");
  // A WOKEN run answers the SendMessage that woke it, not the launch prompt — and the
  // sub-thread may still hold the earlier run's turns (no reload in between): show that
  // message, then only the turns that came after it.
  const wake = useAgentWake(liveSession ?? "", wokenBy ?? null);
  const cut = wake ? (wake.cuts[toolUseId ?? ""] ?? 0) : 0;
  const liveIds = useMemo(() => (cut > 0 ? threadIds.slice(cut) : threadIds), [threadIds, cut]);
  const promptText = wake ? wake.message : launchPrompt;

  // Open at the BOTTOM (most recent), like the conversation thread: a sub-agent's
  // transcript is read from its latest output, not its opening prompt. Tracks both the
  // disk items and the live sub-thread length so either source lands scrolled to bottom.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [items, liveIds.length]);

  // ONE popover is re-targeted from agent to agent (AgentBar, a Flight Deck badge): what it holds
  // belongs to the agent it was read for. A new target drops it at once — never shown under the
  // next agent's header while that one's read is in flight (a server read takes a moment), nor
  // left there for good when that read fails (disk outranks error in `resolveTranscriptSource`).
  const target = `${liveSession ?? ""}|${sessionId ?? ""}|${agentId ?? ""}`;
  const [shownFor, setShownFor] = useState(target);
  if (shownFor !== target) {
    setShownFor(target);
    setItems(null);
    setErr(null);
    setLoading(false);
  }
  // The target the latest read was started for: a read for an earlier one is dropped on landing.
  const targetRef = useRef(target);
  targetRef.current = target;

  const fetchTranscript = useCallback(async () => {
    // The conversation id routes the read: without it there is nowhere safe to read from.
    if (!sessionId || !agentId || !liveSession) return;
    const forTarget = `${liveSession}|${sessionId}|${agentId}`;
    setLoading(true);
    setErr(null);
    try {
      const res = await commands.loadSubagentTranscript(liveSession, sessionId, agentId, hint);
      if (targetRef.current !== forTarget) return; // another agent is shown now
      if (res.status === "ok") setItems(res.data);
      else setErr(res.error);
    } catch (e) {
      // Never swallow a thrown IPC/transport error: surface it, and the `finally`
      // guarantees we never get stuck on "Loading…".
      console.error("loadSubagentTranscript threw:", e);
      if (targetRef.current === forTarget) setErr(String(e));
    } finally {
      if (targetRef.current === forTarget) setLoading(false);
    }
  }, [liveSession, sessionId, agentId, hint]);

  // On open. For a conversation on a server, skip the round trip while the run is live AND its
  // sub-thread is streaming: the live view wins then anyway (see `resolveTranscriptSource`),
  // and the settle edge below reads the full transcript the moment it stops.
  const liveWins = liveRunning && liveIds.length > 0;
  useEffect(() => {
    if (open && !(remote && liveWins)) void fetchTranscript();
    // `liveWins` is read at open only: a sub-thread growing must not re-fetch on every turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fetchTranscript, remote]);
  // A caller reading the task LIVE flips `running` off when the run settles, and the view then
  // falls back to the disk transcript: re-read it at that moment, or it would show the copy
  // taken when the popover opened — without the end of the run (same rule as SubAgentCard).
  // Same when the session stops streaming while the run goes on (see `liveRunning`).
  const wasRunning = useRef(liveRunning);
  useEffect(() => {
    if (open && wasRunning.current && !liveRunning) void fetchTranscript();
    wasRunning.current = liveRunning;
  }, [open, liveRunning, fetchTranscript]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // This popover is the topmost layer while open, so it OWNS Escape: stopPropagation
      // keeps an outer window-level listener (e.g. the Flight Deck reply modal) from also
      // closing on the same keypress. (Fullscreen is protected globally by App.tsx's
      // capture-phase guard, which preventDefaults Escape.)
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  let body: ReactNode;
  const source = resolveTranscriptSource({
    running: liveRunning,
    // A live woken run opens on the message that woke it, even before its first turn —
    // never on the disk transcript, which still ends on the PREVIOUS run.
    liveCount: liveIds.length + (wake?.message ? 1 : 0),
    diskCount: items?.length ?? 0,
    loading,
    error: err != null,
    resolvable: !!(sessionId && agentId && liveSession),
  });
  switch (source) {
    case "live":
      body = <LiveSubThread session={liveSession ?? ""} ids={liveIds} promptText={promptText} />;
      break;
    case "disk":
      body = <SubAgentTranscript items={items!} agentPrompt />;
      break;
    case "loading":
      body = <div className={styles.note}>Loading transcript…</div>;
      break;
    case "error":
      body = <div className={styles.note}>Transcript unreadable: {err == null ? "" : fileReadErrorText(err)}</div>;
      break;
    case "working":
      body = <div className={styles.note}>The sub-agent is working…</div>;
      break;
    case "unavailable":
      body = <div className={styles.note}>Transcript unavailable (conversation reopened).</div>;
      break;
    case "empty":
      body = <div className={styles.note}>The sub-agent hasn't written a transcript yet.</div>;
      break;
  }
  // A live view that holds nothing of the run but the message that woke it (its turns stream
  // under a key this view could not resolve, or were never received): what the caller holds
  // is the only content there is — append it too.
  const onlyTheWake = fallbackAnswersWake && source === "live" && liveIds.length === 0 && !!wake?.message;
  if (fallback && (source === "error" || source === "unavailable" || source === "empty" || onlyTheWake)) {
    body = (
      <>
        {body}
        {fallback}
      </>
    );
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className={styles.head}>
          <Ico name="spark" className="sm" />
          <div className={styles.titles}>
            <div className={styles.title}>{label}</div>
            {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body} ref={bodyRef}>{body}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The `output_file` of the session's task for sub-agent `agentId` (an `Agent` task's is a link
 *  to its transcript on the machine it runs on), or null. */
function agentOutputFile(tasks: Record<string, BackgroundTask> | undefined, agentId: string | null): string | null {
  if (!tasks || !agentId) return null;
  for (const t of Object.values(tasks)) if (t.agent_id === agentId && t.output_file) return t.output_file;
  return null;
}
