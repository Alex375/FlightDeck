// A floating overlay showing a sub-agent's full transcript, opened from the pinned
// AgentBar (conversation) or the FlightDeck badge. Portal + scrim (same pattern as
// ConfirmDialog) so it floats above every stacking context; Escape or a scrim click
// closes it. The body reuses the read-only <SubAgentTranscript> renderer; the items
// are read from disk via `load_subagent_transcript` when it opens.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationItem } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { useSubAgentPrompt, useSubThread } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";
import { SubAgentTranscript } from "./SubAgentTranscript";
import { LiveSubThread } from "./LiveSubThread";
import { resolveTranscriptSource } from "./transcriptSource";
import styles from "./TranscriptPopover.module.css";

export function TranscriptPopover({
  open,
  sessionId,
  agentId,
  liveSession,
  toolUseId,
  running = false,
  label,
  subtitle,
  onClose,
}: {
  open: boolean;
  /** Claude's own session_id (durable) — the key for the on-disk transcript. */
  sessionId: string | null;
  /** The sub-agent's id; null when it can't be resolved (e.g. resumed conversation). */
  agentId: string | null;
  /** The store session key (conversation's stable id) for the live sub-thread fallback. */
  liveSession?: string | null;
  /** The Agent tool_use id that spawned the sub-agent — the live sub-thread's parent key. */
  toolUseId?: string | null;
  /** Whether the task is still running (prefer the live sub-thread while it is). */
  running?: boolean;
  label: ReactNode;
  /** Optional second line in the header (e.g. subagent_type · model). */
  subtitle?: ReactNode;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Live sub-thread fallback: when the agent_id can't be resolved (or the disk
  // transcript isn't written yet) but the agent streamed into the store, render that —
  // the same source the inline <SubAgentCard> uses. Fixes the FlightDeck drill-down
  // showing "transcript unavailable" for an agent that renders fine in the thread.
  const liveIds = useSubThread(liveSession ?? "", toolUseId ?? "");
  // The prompt the sub-agent was launched with — the live sub-thread carries only its
  // replies, so prepend it as the opening user turn (the disk transcript already has it).
  const promptText = useSubAgentPrompt(liveSession ?? "", toolUseId ?? "");

  // Open at the BOTTOM (most recent), like the conversation thread: a sub-agent's
  // transcript is read from its latest output, not its opening prompt. Tracks both the
  // disk items and the live sub-thread length so either source lands scrolled to bottom.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [items, liveIds.length]);

  const fetchTranscript = useCallback(async () => {
    if (!sessionId || !agentId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await commands.loadSubagentTranscript(sessionId, agentId);
      if (res.status === "ok") setItems(res.data);
      else setErr(res.error);
    } catch (e) {
      // Never swallow a thrown IPC/transport error: surface it, and the `finally`
      // guarantees we never get stuck on "Loading…".
      console.error("loadSubagentTranscript threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, agentId]);

  useEffect(() => {
    if (open) void fetchTranscript();
  }, [open, fetchTranscript]);

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
  switch (
    resolveTranscriptSource({
      running,
      liveCount: liveIds.length,
      diskCount: items?.length ?? 0,
      loading,
      error: err != null,
      resolvable: !!(sessionId && agentId),
    })
  ) {
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
      body = <div className={styles.note}>Transcript unreadable: {err}</div>;
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
