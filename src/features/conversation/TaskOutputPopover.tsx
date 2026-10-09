// A floating viewer for a background task's captured output (`tasks/<task_id>.output`) — the
// live sink shared by background `Bash` commands and `Monitor` watches. While the task is still
// running it re-reads on an interval (a live tail); once it finishes the `running` flag flips
// false and the effect does one final read. Portal + scrim, reusing the transcript popover's
// chrome so the read-only overlays stay visually identical.
//
// The read is ROUTED BY CONVERSATION (`read_task_output`): this Mac's disk for a local
// conversation, the conversation's SERVER for a remote one — the output path the stream reports
// names a file on the machine `claude` runs on, so reading it here for a remote conversation
// could only ever answer "absent" ("no output yet" forever). It is INCREMENTAL: each read asks
// from the offset already held and the text is appended, so a live tail no longer re-sends the
// whole file every tick. A remote read is one ssh round trip, so it polls slower (every 4 s) and
// only while the popover is open AND the task runs; a closed popover reads nothing.
//
// A task whose output path the stream has not reported is FOUND by (session, task) instead — a
// running `Monitor` reports its path only once it ends, so without that its events could not be
// read at all while it ran ("no events yet" over a file that was filling up).
//
// The final read is never lost: a request made while a read is still in flight (the task just
// ended, its path just arrived) is queued and runs as soon as that read lands — on a server the
// in-flight read can easily predate the command's last lines. And a read that fails once output
// is already shown says so above it, instead of leaving the last chunk to pass for a live tail.
//
// All the producer-specific wording (the header, the empty/loading placeholders) is injected via
// props, so <BashOutputPopover> and <MonitorBar> reuse the exact same tailing engine with their
// own copy.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FileReadError, TaskOutputLocator } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { useMachineName } from "../tosse/PlaceMark";
import { useConvMachineId } from "./ConvMark";
import { fileReadErrorText } from "./remoteRead";
import { pickOutputView } from "./taskOutputView";
import styles from "./TranscriptPopover.module.css";

/** How often to re-read a LOCAL output file while the task is still running. */
const POLL_MS = 1500;
/** How often to re-read a REMOTE one: each read is an ssh round trip, so a slower tail. */
export const REMOTE_POLL_MS = 4000;

export function TaskOutputPopover({
  open,
  convId,
  outputFile,
  sessionId = null,
  taskId = null,
  running,
  icon,
  title,
  titleMono = false,
  commandLine,
  subtitle,
  loadingText,
  unreadableText,
  unavailableText,
  emptyRunningText,
  emptyDoneText,
  unloadedText,
  onClose,
}: {
  open: boolean;
  /** The conversation's stable id — routes the read to this Mac or to its server. */
  convId: string;
  /** ABSOLUTE path of the task's output (`BackgroundTask.output_file`, taken verbatim from
   *  the wire) on the machine the conversation runs on. The CLI writes it to a temp dir the
   *  app can't reconstruct, so this is the only reliable source. `null` until the path is
   *  known (or on a resumed conversation, where the live task lifecycle is gone). */
  outputFile: string | null;
  /** Claude's session id and the task's id — where to FIND the output while the stream has
   *  reported no path (a running `Monitor` never does before it ends). Both needed; ignored once
   *  `outputFile` is known. */
  sessionId?: string | null;
  taskId?: string | null;
  /** Whether the task is still running — drives the live polling + the subtitle. */
  running: boolean;
  /** Header glyph (a named {@link Ico}). */
  icon: string;
  /** Header title line — the NAME the agent gave the task (or the command if unnamed). */
  title: ReactNode;
  /** Render the title monospace — true for a real shell command (`$ cmd`); a prose label
   *  (a name / a Monitor's description) stays proportional, like <TranscriptPopover>. */
  titleMono?: boolean;
  /** The raw shell command, shown on its own `$ command` mono line UNDER the title (so
   *  the popover shows both the name and the command). Omitted when there is none. */
  commandLine?: string;
  /** The line under the title (already resolved by the caller, e.g. summary or status). */
  subtitle: string;
  /** Placeholder while the first read is in flight. */
  loadingText: string;
  /** Placeholder when the read failed (gets the error, already in words — naming the server
   *  when the output lives on one). */
  unreadableText: (err: string) => string;
  /** Placeholder when the output path is unresolvable (resumed conversation). */
  unavailableText: string;
  /** Placeholder when running but nothing has been written yet. */
  emptyRunningText: string;
  /** Placeholder when finished and the file is present but EMPTY (genuinely no output). */
  emptyDoneText: string;
  /** Placeholder when finished but the output file is absent (read returned null) — we don't
   *  have the output, as opposed to it being empty. Gets the server's name when the output
   *  lived on one (its file is gone from THERE), `null` for this Mac. */
  unloadedText: (server: string | null) => string;
  onClose: () => void;
}) {
  const machineId = useConvMachineId(convId);
  const remote = machineId != null;
  const serverName = useMachineName(machineId);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A read has COMPLETED for this output (see `pickOutputView`'s `loaded`): later polls don't
  // flash "Loading…" over what the last read established.
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<FileReadError | string | null>(null);
  // The read skipped ahead of earlier output (a large file opened at its tail, or a firehose
  // the poll fell behind): say so above the text, never present a tail as the whole output.
  const [headOmitted, setHeadOmitted] = useState(false);
  // Where the next read starts (null = nothing held yet). A ref, not state: it is bookkeeping
  // for the next request, never rendered.
  const offsetRef = useRef<number | null>(null);
  // One read at a time — a slow ssh round trip must not be overtaken by the next tick, whose
  // answer would then be appended at the wrong place.
  const inFlightRef = useRef(false);
  // A read that must not be dropped (the task just ended, its path just arrived, the popover just
  // opened) was asked while one was in flight: it runs as soon as that one lands. Ticks are not
  // queued — the next tick comes anyway.
  const pendingRef = useRef(false);
  // Bumped whenever the viewed output changes: a read started for the previous one is dropped
  // when it lands, never written over the new one.
  const genRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the user is scrolled to the bottom — so a live tail keeps following the
  // output, but stops yanking the view if they scrolled up to read.
  const atBottomRef = useRef(true);

  // What to read: the reported path, else the task to locate. Read through a ref by the read
  // loop, so a queued read uses the target as it is NOW (the path may have arrived meanwhile).
  const locate = useMemo<TaskOutputLocator | null>(
    () => (sessionId && taskId ? { session_id: sessionId, task_id: taskId } : null),
    [sessionId, taskId],
  );
  const targetRef = useRef({ path: outputFile, locate });
  targetRef.current = { path: outputFile, locate };

  // `queue`: a request that must not be dropped when a read is already in flight (see
  // `pendingRef`); a poll tick passes false.
  const fetchOutput = useCallback(
    async (queue: boolean) => {
      if (!targetRef.current.path && !targetRef.current.locate) return;
      if (inFlightRef.current) {
        if (queue) pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const gen = genRef.current;
      setLoading(true);
      try {
        do {
          pendingRef.current = false;
          const asked = offsetRef.current;
          const { path, locate: loc } = targetRef.current;
          try {
            const res = await commands.readTaskOutput(convId, path, path ? null : loc, asked);
            if (gen !== genRef.current) return; // another output is shown now
            if (res.status === "ok") {
              const chunk = res.data;
              if (chunk == null) {
                // Absent (not written yet, or cleaned up): keep null distinct from "" — null =
                // absent, "" = present but empty. Coercing it is what made the popover claim
                // "no output" when it simply didn't have the file.
                offsetRef.current = null;
                setText(null);
                setHeadOmitted(false);
              } else if (asked == null || chunk.start !== asked) {
                // A fresh read (the first, or the file started over): replace what we hold.
                offsetRef.current = chunk.next_offset;
                setText(chunk.data);
                setHeadOmitted(chunk.start > 0);
              } else {
                offsetRef.current = chunk.next_offset;
                setText((t) => (t ?? "") + chunk.data);
              }
              setErr(null);
            } else {
              setErr(res.error);
            }
          } catch (e) {
            // Never swallow a thrown IPC/transport error: surface it; `finally` guarantees we
            // never get stuck on "Loading…".
            console.error("readTaskOutput threw:", e);
            if (gen !== genRef.current) return;
            setErr(String(e));
          }
        } while (pendingRef.current && gen === genRef.current);
      } finally {
        // A read for a previous output leaves the current one's bookkeeping alone.
        if (gen === genRef.current) {
          inFlightRef.current = false;
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [convId],
  );

  // Reset the captured text when switching to a different task (avoid flashing the previous
  // task's output before the first read lands). Declared BEFORE the polling effect so it runs
  // first: the new output's first read must not be skipped as "one already in flight". Keyed on
  // the TASK when it is known — its path arriving mid-view (a Monitor's, at its end) names the
  // same file the locator found, so what is held stays valid and the offset carries on.
  const identity = taskId ?? outputFile;
  useEffect(() => {
    genRef.current += 1;
    inFlightRef.current = false;
    pendingRef.current = false;
    offsetRef.current = null;
    setText(null);
    setErr(null);
    setLoading(false);
    setLoaded(false);
    setHeadOmitted(false);
  }, [convId, identity]);

  // Initial read on open, then poll while the task runs — this Mac every 1.5 s, a server every
  // 4 s (one ssh each). Depending on `running` (and on the target) means a last read fires when
  // the task stops or its path arrives — QUEUED behind a read still in flight, never dropped.
  // A closed popover reads nothing.
  const locateKey = locate ? `${locate.session_id}/${locate.task_id}` : null;
  useEffect(() => {
    if (!open) return;
    void fetchOutput(true);
    if (!running) return;
    const id = setInterval(() => void fetchOutput(false), remote ? REMOTE_POLL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [open, running, remote, fetchOutput, identity, outputFile, locateKey]);

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

  // Follow the tail: keep pinned to the bottom on new output, unless the user scrolled
  // up to read earlier lines.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!open) return null;

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const errText = err == null ? null : fileReadErrorText(err);
  const view = pickOutputView({
    text,
    loading,
    loaded,
    err: errText,
    hasPath: !!outputFile || locate != null,
    running,
  });
  let body: ReactNode;
  switch (view) {
    case "output":
      body = (
        <>
          {headOmitted ? (
            <div className={styles.note}>
              Showing the latest output — earlier lines are in the file
              {remote ? ` on ${serverName}` : ""}.
            </div>
          ) : null}
          <pre className="cv-bashout wf-mono">{text}</pre>
        </>
      );
      break;
    case "loading":
      body = <div className={styles.note}>{loadingText}</div>;
      break;
    case "error":
      body = <div className={styles.note}>{unreadableText(errText ?? "")}</div>;
      break;
    case "unavailable":
      body = <div className={styles.note}>{unavailableText}</div>;
      break;
    case "empty-running":
      body = <div className={styles.note}>{emptyRunningText}</div>;
      break;
    case "empty-done":
      body = <div className={styles.note}>{emptyDoneText}</div>;
      break;
    case "unloaded":
      body = <div className={styles.note}>{unloadedText(remote ? serverName : null)}</div>;
      break;
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name={icon} className="sm" />
          <div className={styles.titles}>
            <div className={styles.title + (titleMono ? " wf-mono" : "")}>{title}</div>
            {commandLine ? (
              <div className="cv-taskout-cmd wf-mono">$ {commandLine}</div>
            ) : null}
            <div className={styles.subtitle}>{subtitle}</div>
            {view === "output" && errText ? (
              // The text below is what an EARLIER read got: a failing read must not leave it to
              // pass for a live (or final) tail. In the header, so a tail scrolled to its bottom
              // can't hide it.
              <div className={styles.stale} role="status">
                Showing the output read before — the latest read failed: {errText}.
              </div>
            ) : null}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body} ref={bodyRef} onScroll={onScroll}>
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}
