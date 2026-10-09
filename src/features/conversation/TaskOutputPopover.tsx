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
// All the producer-specific wording (the header, the empty/loading placeholders) is injected via
// props, so <BashOutputPopover> and <MonitorBar> reuse the exact same tailing engine with their
// own copy.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { FileReadError } from "../../ipc/client";
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
  // Bumped whenever the viewed output changes: a read started for the previous one is dropped
  // when it lands, never written over the new one.
  const genRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the user is scrolled to the bottom — so a live tail keeps following the
  // output, but stops yanking the view if they scrolled up to read.
  const atBottomRef = useRef(true);

  const fetchOutput = useCallback(async () => {
    if (!outputFile || inFlightRef.current) return;
    inFlightRef.current = true;
    const gen = genRef.current;
    const asked = offsetRef.current;
    setLoading(true);
    try {
      const res = await commands.readTaskOutput(convId, outputFile, asked);
      if (gen !== genRef.current) return; // another output is shown now
      if (res.status === "ok") {
        const chunk = res.data;
        if (chunk == null) {
          // Absent (not written yet, or cleaned up): keep null distinct from "" — null =
          // absent, "" = present but empty. Coercing it is what made the popover claim "no
          // output" when it simply didn't have the file.
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
      if (gen === genRef.current) setErr(String(e));
    } finally {
      // A read for a previous output leaves the current one's bookkeeping alone.
      if (gen === genRef.current) {
        inFlightRef.current = false;
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [convId, outputFile]);

  // Reset the captured text when switching to a different task (avoid flashing the previous
  // task's output before the first read lands). Declared BEFORE the polling effect so it runs
  // first: the new output's first read must not be skipped as "one already in flight".
  useEffect(() => {
    genRef.current += 1;
    inFlightRef.current = false;
    offsetRef.current = null;
    setText(null);
    setErr(null);
    setLoading(false);
    setLoaded(false);
    setHeadOmitted(false);
  }, [convId, outputFile]);

  // Initial read on open, then poll while the task runs — this Mac every 1.5 s, a server every
  // 4 s (one ssh each). Depending on `running` means the final read fires automatically when it
  // stops (the interval is cleared and a fresh effect with running=false does the last fetch).
  // A closed popover reads nothing.
  useEffect(() => {
    if (!open) return;
    void fetchOutput();
    if (!running) return;
    const id = setInterval(() => void fetchOutput(), remote ? REMOTE_POLL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [open, running, remote, fetchOutput]);

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
    hasPath: !!outputFile,
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
