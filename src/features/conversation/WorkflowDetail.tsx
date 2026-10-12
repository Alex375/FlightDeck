// The /workflows-style detail modal. ONE face, whether the run is live or finished — because
// what the user wants is the SAME clean view in both states:
//
//   phases (left) · agents (middle) · transcript (right) + a header summary on top.
//
// The two states differ only in where the data comes from, not in how it looks:
//  - WHILE RUNNING → the tree is assembled from the LIVE signals. First the STREAM snapshot
//    (`task_progress.workflow_progress`, see `store/workflowProgress`): every declared phase, every
//    agent — queued ones included — with its state, model, tokens and previews. It is the only
//    live source for a conversation running on a paired server, whose files (journal, script,
//    manifest) live on that server. Without one (an older CLI), the script's declared `phases` and
//    the run's `journal.jsonl` pushed by the app-wide watcher — which, since claude 2.1.272, names
//    every agent (label + phase) exactly. (An older binary's journal has ids only; the wire's
//    `task_progress` labels are then zipped on by spawn order, approximately.) Running agents show
//    the classic spinner and a live "doing X" line, read from their incrementally-written
//    transcript (this Mac only) or from the snapshot's last tool.
//  - ONCE FINISHED → the same three columns, now fed by the manifest (`load_workflow_run`), or —
//    until it is read (a remote run's is read ON its server, one ssh round trip) or when there is
//    none — by the stream's final snapshot, which carries the same models, tokens, tool-calls and
//    durations.
//
// Every read is ROUTED BY CONVERSATION: this Mac's disk for a local run, the conversation's
// server for a remote one (the manifest and the agent transcripts live there). A remote run's
// journal and script are never read — the stream carries its per-agent state and declared phases
// — and its reads are bounded to what is on screen: the manifest once the run is over (a short
// retry ladder while it lands), the SELECTED agent's transcript (at most every 5 s while it runs,
// and only when its stream snapshot moved), nothing for a closed modal.
//
// The moment the run ends we re-fetch the manifest (it lands just after the status flips) and the
// same layout upgrades in place. The shared read-only <SubAgentTranscript> renders every
// transcript, live or cold, so the two never drift.
//
// A lighter CLASSIC overview (colour-coded count boxes + an in-flight list) is kept behind the
// `workflowAgentDetail` pref OFF, as the revert path for anyone who prefers the compact readout.
//
// Portal + scrim (same family as <TranscriptPopover>). The journal is NOT polled here anymore:
// it arrives pushed, so the readout is identical whether this modal is open or closed.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ConversationItem,
  FileReadError,
  WorkflowJournalAgent,
  WorkflowPhase,
  WorkflowRun,
} from "../../ipc/client";
import { commands } from "../../ipc/client";
import { Dot, Ico, RunDots, type StreamState } from "../../ui/kit";
import { useNow } from "../../ui/useNow";
import { fmtDuration, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import type { WfLive } from "../../store/workflowLive";
import { useWorkflowProgress } from "../../store/workflowProgress";
import { useMachineName } from "../tosse/PlaceMark";
import { useConvMachineId } from "./ConvMark";
import { fileReadErrorText } from "./remoteRead";
import {
  inFlightAgents,
  JOURNAL_UNAVAILABLE,
  pickJournal,
  progressText,
  toJournalView,
  type WfJournalView,
} from "../../store/workflowJournal";
import {
  deriveActivity,
  liveTree,
  phaseRowView,
  type AgentActivity,
  type LiveAgent,
  type LivePhaseRow,
  type LivePhaseState,
  type LiveTree,
  type PhaseTone,
} from "./workflowTree";
import { SubAgentTranscript } from "./SubAgentTranscript";
import {
  streamActivity,
  streamAgentDetails,
  streamPhases,
  streamRedacted,
  streamReport,
  streamStartedAt,
  streamUsable,
} from "./workflowStream";
import {
  acceptReport,
  isFailedState,
  isTerminalState,
  parseWorkflow,
  phaseProgress,
  runProgress,
  wfStateDot,
  type WfAgent,
  type WfPhase,
} from "./workflowModel";
import styles from "./WorkflowDetail.module.css";

const POLL_MS = 1500;
/** After a REMOTE run ends, when to retry reading its manifest (on top of the first read): the CLI
 *  writes it a beat after the status flips, and each read is an ssh round trip — a short widening
 *  ladder instead of the local 1.5 s poll. */
const REMOTE_MANIFEST_RETRY_MS = [2500, 6000];
/** How often a REMOTE agent transcript may be re-read while the agent runs (one ssh each). */
export const REMOTE_TRANSCRIPT_MS = 5000;

const EMPTY_LIVE: WfLive = { phases: [], startedAt: null };

function richPhaseKey(p: WfPhase): string {
  return `${p.index ?? ""}|${p.title}`;
}

/** Stable selection key for a rich agent row: its `agentId` when present, else a positional key.
 *  A queued/id-less agent (legitimate — `parseWorkflow` keeps it) is thus still selectable and
 *  highlights correctly. */
function agentRowKey(a: WfAgent, i: number): string {
  return a.agentId ?? `#${i}-${a.label}`;
}

/** Split the wire's coarse `task_progress` ("<phase>: <label>") into its parts. */
function splitProgress(progress: string | null | undefined): { phase: string; label: string | null } | null {
  if (!progress) return null;
  const i = progress.indexOf(":");
  if (i < 0) return { phase: progress.trim(), label: null };
  return { phase: progress.slice(0, i).trim(), label: progress.slice(i + 1).trim() || null };
}

// ---- the unified 3-panel view-model ---------------------------------------
// Both the live tree and the post-run manifest are shaped into this before rendering, so the two
// go through the exact same columns / rows and can never visually drift.

/** One agent row, source-agnostic. `meta`/`stats` are the manifest's exact per-agent detail
 *  (post-run only); `activity` is the live "doing X" line (mid-run only). */
interface UiAgent {
  key: string;
  agentId: string | null;
  label: string;
  /** Monospace the label (it's a short id, not a real label — mid-run before the manifest). */
  mono: boolean;
  /** "type · model" — post-run only (the live journal has neither). */
  meta: string | null;
  /** "tokens · tools · duration" — post-run only. */
  stats: string | null;
  /** Live one-line "doing X" — mid-run, in-flight agents only. */
  activity: string | null;
  /** The last tool a settled agent called ("Read src/foo.ts"), when the stream or the report
   *  says — what it last did, once there is no "doing" any more. */
  lastTool: string | null;
  /** How a settled agent ENDED, when that is worth saying — a failure (error tone), or no result
   *  at all in a run that is over (muted) — under its own label, never as a "doing" activity. */
  outcome: Outcome | null;
  /** Show the animated spinner (agent working right now). */
  running: boolean;
  /** Whether the agent has settled — greys the label. */
  done: boolean;
  /** The dot to show when not running. */
  dot: StreamState;
  /** Selectable → its transcript can be read. A queued agent (no id yet) is not; nor is a call
   *  that failed before it started — its row says so in visible text (a disabled control never
   *  shows a tooltip). */
  clickable: boolean;
  /** What the transcript pane says when the agent has no transcript id (else the generic note). */
  missingNote: string | null;
  promptPreview: string | null;
  resultPreview: string | null;
}

const HINT_OPEN = "View the agent's transcript";
const FAILED_BEFORE_START = "This agent failed before it started — no transcript was written.";
const QUEUED_NOTE = "Queued — it hasn't started yet, so there is nothing to read.";
/** An agent a journal does not list yet (an older CLI's by-index path): it spawned or is about
 *  to — nothing says it is waiting. */
const NOT_IN_JOURNAL_NOTE = "Not in the run's journal yet — nothing to read for now.";
/** An agent of a run on a paired server whose CLI streams no per-agent progress: its journal is
 *  on that server, so neither its state nor its id is known here. */
const remoteUnknownNote = (server: string) =>
  `This agent's state isn't known here: this Claude Code version doesn't stream per-agent progress, and the run's journal lives on ${server}.`;
/** What a settled agent's outcome line says, and in which tone. */
interface Outcome {
  text: string;
  tone: "err" | "muted";
}
const OUTCOME_FAILED: Outcome = { text: "failed", tone: "err" };
/** The outcome of a call that failed before spawning. */
const OUTCOME_NOSTART: Outcome = { text: "failed before start — no transcript", tone: "err" };
/** The outcome of an agent the CLI never closed, in a run that is over (a kill writes no line). */
const OUTCOME_UNFINISHED: Outcome = { text: "no result recorded", tone: "muted" };

interface UiPhase {
  key: string;
  title: string;
  detail: string | null;
  state: LivePhaseState;
  /** Dot + count colour: the state, or "err" once a phase with a failed agent has settled. */
  tone: PhaseTone;
  /** One of our synthetic buckets, not a script phase — its name renders apart. */
  synthetic: boolean;
  /** "3/5" · "3/5 · 1 failed" · "upcoming" · "—". */
  count: string;
  agents: UiAgent[];
}

/** "type · model" of an agent, or null when neither is known. */
function agentMeta(a: WfAgent): string | null {
  return [a.agentType, a.model ? shortModel(a.model) : null].filter(Boolean).join(" · ") || null;
}

/** "tokens · tools · duration" of an agent, or null when none is known yet. */
function agentStats(a: WfAgent): string | null {
  return (
    [
      a.tokens != null ? `${fmtTokens(a.tokens)} tk` : null,
      a.toolCalls != null ? `${a.toolCalls} tools` : null,
      a.durationMs != null ? fmtDuration(a.durationMs) : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

/** Shape the post-run manifest model into the unified phases. Phase state is derived from its
 *  agents: any running → current; all settled → done; none started → upcoming. */
function richToUi(model: { phases: WfPhase[] }): UiPhase[] {
  return model.phases.map((p) => {
    const { done, failed, total } = phaseProgress(p);
    const anyRunning = p.agents.some((a) => a.state.toLowerCase() === "running");
    const state: LivePhaseState = anyRunning
      ? "cur"
      : total > 0 && done >= total
        ? "done"
        : total === 0
          ? "todo"
          : "cur";
    // A report only exists once the run is over: nothing in it is still in progress.
    const view = phaseRowView({ started: total, done, failed, state }, "—", true);
    return {
      key: richPhaseKey(p),
      title: p.title,
      detail: p.detail,
      state,
      tone: view.tone,
      synthetic: false,
      count: view.count,
      agents: p.agents.map((a, i) => {
        const meta = agentMeta(a);
        const stats = agentStats(a);
        return {
          key: agentRowKey(a, i),
          agentId: a.agentId,
          label: a.label,
          mono: false,
          meta,
          stats,
          activity: null,
          lastTool: streamActivity(a),
          // A report is written once the run is over: an agent it still lists as running/queued
          // was interrupted — no spinner, and say so instead of leaving it unsaid.
          outcome: isFailedState(a.state)
            ? OUTCOME_FAILED
            : !isTerminalState(a.state)
              ? OUTCOME_UNFINISHED
              : null,
          running: false,
          // Greyed like any settled agent: a report's run is over, an unclosed agent included.
          done: true,
          dot: isTerminalState(a.state) ? wfStateDot(a.state) : "off",
          clickable: true,
          missingNote: null,
          promptPreview: a.promptPreview,
          resultPreview: a.resultPreview,
        };
      }),
    };
  });
}

/** Shape the live signals (phase rows + per-phase agents + activity) into the unified phases.
 *  Rows and agents are keyed by STABLE identities — the row's bucket key, the agent's call key —
 *  so a retry (which moves the agent to a new id) or a newly reached phase never resets what the
 *  user selected. */
function liveToUi(
  rows: LivePhaseRow[],
  byPhase: Map<string, LiveAgent[]>,
  activity: Map<string, AgentActivity | null>,
  running: boolean,
  source: {
    /** The stream's per-agent detail by row key (model, tokens, previews, last tool) — empty
     *  when the live view comes from a journal, whose agents carry none of it. */
    details: Map<string, WfAgent>;
    /** The live view is the stream snapshot: an agent with no id there IS queued. Anywhere else
     *  a missing id only means "not listed yet" — calling it queued would state a cause the
     *  data doesn't give. */
    fromStream: boolean;
    /** The paired server the run lives on, or null for this Mac. */
    remoteServer: string | null;
  } = { details: new Map(), fromStream: false, remoteServer: null },
): UiPhase[] {
  const { details, fromStream, remoteServer } = source;
  // The run lives on a server and nothing streams its agents: their state is unknown here.
  const unknown = !fromStream && remoteServer != null;
  return rows.map((r) => {
    const view = phaseRowView(r, "upcoming", !running);
    return {
      key: r.key,
      title: r.title,
      detail: r.detail,
      state: r.state,
      tone: view.tone,
      synthetic: r.synthetic,
      count: view.count,
      agents: (byPhase.get(r.key) ?? []).map((a) => {
        const isRunning = running && !a.done && a.agentId != null;
        // A failed call with no id never spawned (this execution): there is no transcript.
        const neverStarted = a.failed && a.agentId == null;
        const idless = running && !a.done && !a.failed && a.agentId == null;
        const d = details.get(a.key);
        const name =
          a.label ??
          (a.agentId
            ? shortAgentId(a.agentId)
            : neverStarted
              ? "unnamed agent"
              : fromStream
                ? "queued agent"
                : "agent");
        // Present tense only while the run lives: once it is over, an agent the CLI never closed
        // is not "starting…" — its outcome says it left no result.
        const act =
          !running || a.done
            ? null
            : a.agentId
              ? activity.get(a.agentId)?.detail ??
                (d ? streamActivity(d) : null) ??
                (isRunning ? "working…" : "starting…")
              : unknown
                ? "state unknown"
                : "queued";
        return {
          key: a.key,
          agentId: a.agentId,
          label: name,
          mono: !a.label && a.agentId != null,
          meta: d ? agentMeta(d) : null,
          stats: d ? agentStats(d) : null,
          activity: act,
          lastTool: a.done && d ? streamActivity(d) : null,
          outcome: a.failed
            ? neverStarted
              ? OUTCOME_NOSTART
              : OUTCOME_FAILED
            : !running && !a.done
              ? OUTCOME_UNFINISHED
              : null,
          running: isRunning,
          done: a.done || !running,
          dot: a.failed ? "err" : a.done ? "done" : "off",
          clickable: a.agentId != null,
          missingNote: neverStarted
            ? FAILED_BEFORE_START
            : !idless
              ? null
              : fromStream
                ? QUEUED_NOTE
                : unknown
                  ? remoteUnknownNote(remoteServer!)
                  : NOT_IN_JOURNAL_NOTE,
          promptPreview: d?.promptPreview ?? null,
          resultPreview: d?.resultPreview ?? null,
        } satisfies UiAgent;
      }),
    };
  });
}

export function WorkflowDetail({
  open,
  convId,
  sessionId,
  runId,
  taskId,
  status,
  superseded = false,
  running,
  workflowName,
  currentProgress,
  liveActivity,
  journal,
  onClose,
}: {
  open: boolean;
  /** The conversation's stable id — keys the run's stream snapshot, and says whether the run
   *  lives on a paired server (then nothing is read from this Mac's disk). */
  convId: string;
  /** Claude's durable session_id — the key for the on-disk manifest + transcripts. */
  sessionId: string | null;
  /** The run id (`wf_<id>`), parsed from the Workflow tool_result. */
  runId: string | null;
  /** The background task of THIS execution. A resumed run (`resumeFromRunId`) reuses the run id,
   *  and the previous execution's report stays on disk under it: the report's own `taskId` is
   *  what tells it apart from this one's. */
  taskId?: string | null;
  /** The task's own status ("completed" / "failed" / "stopped"…) — what the live header says once
   *  the run is over (it has no report of its own to say it). */
  status?: string | null;
  /** Another, still-running execution of this run id (a resume) is writing the run's journal —
   *  the journal no longer describes THIS execution. */
  superseded?: boolean;
  /** Whether the run is still going — drives the poll, and the live-vs-rich data source. */
  running: boolean;
  /** Fallback name shown in the header before the manifest loads. */
  workflowName?: string | null;
  /** The wire's latest coarse progress ("<phase>: <label>") — the live current step. */
  currentProgress?: string | null;
  /** Accumulated per-phase agent activity from the wire (live per-phase started counts). */
  liveActivity?: WfLive;
  /** The run's live per-agent progress (`useWorkflowJournal`: the stream snapshot first, else the
   *  journal pushed from disk by the app-wide watcher). */
  journal?: WfJournalView;
  onClose: () => void;
}) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  // One-shot read of the journal, as a FALLBACK for a run nothing is watching: a finished run
  // reopened from history whose manifest never landed would otherwise show "report not found"
  // even though its journal is right there on disk. The live push always wins when present.
  const [diskJournal, setDiskJournal] = useState<WfJournalView | null>(null);
  const [livePhases, setLivePhases] = useState<WorkflowPhase[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0); // bumped on each poll → refetches the transcript too
  // Bumped by the Refresh button only — a remote transcript ignores the 1.5 s tick (each read is
  // an ssh round trip) but must still honour an explicit Refresh.
  const [manualRefresh, setManualRefresh] = useState(0);
  const [selPhaseKey, setSelPhaseKey] = useState<string | null>(null);
  const [selAgentKey, setSelAgentKey] = useState<string | null>(null);
  // The in-flight agent being read mid-run in the CLASSIC (pref OFF) face, which has no room for
  // a persistent list. The 3-panel face reads transcripts in its own column, so it ignores this.
  const [selLiveAgent, setSelLiveAgent] = useState<string | null>(null);
  // The script is written once at t=0 — fetch its phases until loaded, then stop re-parsing it
  // on every poll (the manifest + journal are the only things that change during the run).
  const phasesLoadedRef = useRef(false);
  // Opt-in (default ON): the per-agent 3-panel view. Off → the compact classic overview.
  const agentDetail = useDisplay((s) => s.workflowAgentDetail);
  // A conversation running on a paired server: its run's files (manifest, journal, script, agent
  // transcripts) live on THAT machine — nothing here reads this Mac's disk for it (an absent file
  // would only read as "no agents", "not found"). The stream snapshot is its source.
  const machineId = useConvMachineId(convId);
  const remote = machineId != null;
  const serverName = useMachineName(machineId);
  const stream = useWorkflowProgress(convId, taskId);
  const streamOk = useMemo(() => streamUsable(stream), [stream]);

  const fetchData = useCallback(async () => {
    if (!sessionId || !runId) return;
    setLoading(true);
    try {
      if (remote) {
        // A run on a paired server: only its manifest is read, ON the server. Its journal and
        // script are not read at all — the session's stream carries the per-agent progress and
        // the declared phases.
        const r = await commands.loadWorkflowRun(convId, sessionId, runId);
        if (r.status === "ok") setRun(r.data);
        setErr(r.status === "error" ? fileReadErrorText(r.error) : null);
        return;
      }
      const wantPhases = !phasesLoadedRef.current;
      const [r, j, p] = await Promise.all([
        commands.loadWorkflowRun(convId, sessionId, runId),
        commands.loadWorkflowJournal(convId, sessionId, runId),
        wantPhases ? commands.loadWorkflowPhases(convId, sessionId, runId) : Promise.resolve(null),
      ]);
      // The MANIFEST error is blocking (the body shows "unreadable"); a journal/phases error is
      // non-blocking but must NOT be silent → surface it in the app-level error banner.
      if (r.status === "ok") setRun(r.data);
      setErr(r.status === "error" ? fileReadErrorText(r.error) : null);
      if (j.status === "ok") setDiskJournal(toJournalView(j.data));
      // A failed read must DROP the previous disk snapshot, not keep it: leaving it in place
      // would let `pickJournal` serve unflagged stale numbers as this run's final truth, with
      // only a dismissible banner to say otherwise. Cleared → the pushed view (which carries
      // the watcher's own error flag) takes over.
      else {
        setDiskJournal(null);
        useAppErrors.getState().pushError("Workflow journal unreadable", fileReadErrorText(j.error));
      }
      if (p) {
        if (p.status === "ok") {
          if (p.data.length > 0) {
            setLivePhases(p.data);
            phasesLoadedRef.current = true;
          }
        } else {
          useAppErrors.getState().pushError("Workflow phases unreadable", fileReadErrorText(p.error));
        }
      }
    } catch (e) {
      console.error("loadWorkflowRun/Journal/Phases threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [convId, sessionId, runId, remote]);

  // Reset transient state each time the modal opens for a (possibly different) run.
  useEffect(() => {
    if (!open) return;
    setRun(null);
    setDiskJournal(null);
    setLivePhases([]);
    setErr(null);
    setSelPhaseKey(null);
    setSelAgentKey(null);
    setSelLiveAgent(null);
    phasesLoadedRef.current = false;
    // A remote run is read by the post-run effect below once it is over — while it runs there is
    // nothing on its server worth a round trip (the manifest is written at the end).
    if (!remote) void fetchData();
  }, [open, fetchData, remote]);

  // Tick while the run is going — but for far less than before. The journal is PUSHED now
  // (the run dir is fs-watched app-wide), and the manifest does not exist until the run ends,
  // so the only reasons left to tick are: re-reading OPEN agent transcripts (live "doing X" +
  // the transcript column), and retrying the script's phases when they weren't written yet.
  useEffect(() => {
    if (!open || !running) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      // Never for a remote run: that would be an ssh round trip per tick (its phases come from
      // the stream anyway).
      if (!remote && !phasesLoadedRef.current) void fetchData();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, running, remote, fetchData]);

  // The end-of-run report this view may use: never while the run is going (it has none yet — any
  // report on disk under this run id is a PREVIOUS execution's, from before a resume), and only
  // when it was written by this execution's task. Anything else would show an earlier run's
  // outcome — a re-executed call as delivered, its failure as a success — in place of the live one.
  const diskReport = acceptReport(run, running, taskId);
  // No report on disk to read (a remote run's is on its server, or the CLI hasn't written it yet):
  // the stream's FINAL snapshot carries the same per-agent detail, and it is this execution's own
  // (keyed by its task) — never another resume's.
  const settledStream = !running && stream?.settled === true && streamOk ? stream : null;
  const streamRun = useMemo(
    () => (settledStream ? streamReport(settledStream, status) : null),
    [settledStream, status],
  );
  // …except a REDACTED one on this Mac (generic "phase N" names): until the manifest lands, the
  // live view built from the readable journal describes the run better (see `preferredView`).
  const report =
    diskReport ?? (streamRun && (remote || !streamRedacted(settledStream)) ? streamRun : null);
  // A report IS on disk but belongs to another execution of this run id (a later resume).
  const foreignReport = !running && run != null && diskReport == null;
  // The run's journal is SHARED by every execution of the run id (a resume appends to it, and each
  // call shows its latest attempt): once another execution wrote the report, or is writing the
  // journal right now, the journal can't be presented as this execution's own.
  const sharedJournal = !running && (foreignReport || superseded);

  // The manifest lands shortly AFTER the run's status flips to done — and on a heavy run / slow
  // FS that can be more than a couple seconds. So once finished but this execution's report isn't
  // loaded yet (none, or only a previous execution's), poll a BOUNDED number of times (~10 s) to
  // upgrade the live overview to the rich report in place; then stop (the "not found" state +
  // Refresh remain as the fallback).
  useEffect(() => {
    // Still polled when the stream's report is shown: the manifest adds what only it has (the
    // run's return value, its default model).
    if (!open || running || diskReport) return;
    void fetchData();
    if (remote) {
      // Each read of a remote manifest is an ssh round trip: a short widening ladder, cancelled
      // the moment the report lands (`diskReport` re-runs this effect).
      const timers = REMOTE_MANIFEST_RETRY_MS.map((ms) => setTimeout(() => void fetchData(), ms));
      return () => timers.forEach(clearTimeout);
    }
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (n >= 6) {
        clearInterval(id);
        return;
      }
      void fetchData();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, running, diskReport, remote, fetchData]);

  // Escape closes.
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

  const model = useMemo(() => parseWorkflow(report), [report]);

  // ---- live snapshot + derived tree (used when the manifest isn't in yet) ----
  const cur = splitProgress(currentProgress);
  // Which snapshot to believe — see `pickJournal`: neither the push nor the one-shot disk read
  // is reliably the fresher one, so the choice depends on the run's state, not on the source.
  const live: WfJournalView = pickJournal(running, journal, diskJournal);
  const hasJournal = live.started > 0 && !live.error;
  const liveAct = liveActivity ?? EMPTY_LIVE;

  // The 3-panel LIVE face is shown when: the modal is open, the manifest isn't in, the pref is
  // on, the journal is readable, and there is (or was) a run. `open` gates the transcript reads
  // below so a closed modal never drives always-on disk polling.
  const wantLive3 = open && !report && agentDetail && (running || hasJournal) && !live.error;

  // The declared phases: the stream's (the script's own, with details — known from t=0), else the
  // script read from this Mac's disk.
  const declared = useMemo(() => {
    // When the live view yielded to the local journal (a redacted stream), its agents carry the
    // script's real phase names: label the rows with the script's own phases too, or the stream's
    // generic "phase N" rows would sit, empty, above them.
    if (!live.fromStream && livePhases.length > 0) return livePhases;
    const fromStream = streamPhases(stream);
    return fromStream.length > 0 ? fromStream : livePhases;
  }, [stream, livePhases, live.fromStream]);
  const details = useMemo(() => streamAgentDetails(stream), [stream]);
  // ONE live tree for both live faces (3-panel and classic), so they never split a run differently.
  const tree = open && !report ? liveTree(declared, live, liveAct, cur, running) : null;
  // The transcripts the "doing X" line is read from are on this Mac only for a local run; a
  // remote one's come from the snapshot's last tool instead (see `liveToUi`).
  const runningIds =
    wantLive3 && tree && !remote
      ? tree.agents.filter((a) => a.agentId && !a.done).map((a) => a.agentId as string)
      : [];
  // Activity is read only for in-flight agents while the run lives (a finished one won't change).
  const activity = useAgentsActivity(convId, sessionId, runningIds, running, tick);

  // The unified phases the 3-panel renders — from the manifest once in, else from the live tree.
  const uiPhases: UiPhase[] = report
    ? richToUi(model)
    : wantLive3 && tree
      ? liveToUi(tree.rows, tree.byPhase, activity, running, {
          details,
          fromStream: live.fromStream === true,
          remoteServer: remote ? serverName : null,
        })
      : [];

  // Default selection once phases exist; never clobber a live user choice. Keyed on the phase +
  // agent key SET (not the activity, which changes each tick) so it only re-defaults on a real
  // structural change. Prefer the current phase, then the first phase that has agents.
  const selectionSig = uiPhases.map((p) => `${p.key}:${p.agents.map((a) => a.key).join(",")}`).join("|");
  useEffect(() => {
    if (uiPhases.length === 0) return;
    const found = uiPhases.find((p) => p.key === selPhaseKey);
    if (!found) {
      const def =
        uiPhases.find((p) => p.state === "cur" && p.agents.length > 0) ??
        uiPhases.find((p) => p.agents.length > 0) ??
        uiPhases[0];
      setSelPhaseKey(def.key);
      setSelAgentKey(firstAgentKey(def.agents));
    } else if (selAgentKey && !found.agents.some((a) => a.key === selAgentKey)) {
      setSelAgentKey(firstAgentKey(found.agents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionSig]);

  const selectedPhase = uiPhases.find((p) => p.key === selPhaseKey) ?? null;
  const selectedAgent = selectedPhase?.agents.find((a) => a.key === selAgentKey) ?? null;

  if (!open) return null;

  // Which face to show. `rich`/`live3` are the 3-panel layout (wide); the rest are the compact
  // classic/notes (narrow).
  type Face = "rich" | "live3" | "liveErr" | "liveDrill" | "liveClassic" | "error" | "loading" | "empty";
  let face: Face;
  if (report) face = "rich";
  // A manifest read error only matters once there should be a report (while the run goes, the
  // file on disk is at best a previous execution's).
  else if (err && !running) face = "error";
  else if (agentDetail && (running || hasJournal)) face = live.error ? "liveErr" : "live3";
  // Classic face too: its last readable snapshot must not be shown as live.
  else if (live.error && (running || live.started > 0)) face = "liveErr";
  else if (selLiveAgent) face = "liveDrill";
  else if (running || hasJournal) face = "liveClassic";
  else if (loading) face = "loading";
  else face = "empty";

  const wide = face === "rich" || face === "live3";

  // What Refresh can do. While a run on a paired server goes, it has no report to re-read (that is
  // written at the end) and its progress comes from the stream: the ONLY thing it re-reads is the
  // transcript of an agent that is open — the 3-panel face's selected agent, or the classic face's
  // drilled-in one — and only once that agent has an id (it has started). Anywhere else a click
  // would do nothing, so it is not offered as if it would: dimmed, saying why.
  const drilledAgentId =
    face === "live3"
      ? (selectedAgent?.agentId ?? null)
      : face === "liveDrill"
        ? (live.agents.find((a) => a.key === selLiveAgent)?.agentId ?? null)
        : null;
  const refreshOff = remote && running && drilledAgentId == null;
  const refreshTitle = refreshOff
    ? `Nothing to refresh yet — while the run on ${serverName} is going, its progress comes from the session's stream; Refresh re-reads the transcript of an agent you open, once it has started.`
    : remote && running
      ? `Refresh — re-read this agent's transcript on ${serverName}`
      : "Refresh";

  // What the live faces say about themselves. While the run goes: what is still to come (and, on
  // an older journal, that names are a guess). Once it is over: why no report is shown — never
  // the promise that one is coming when it cannot.
  const liveFootnote = running
    ? live.fromStream
      ? "Live view — from the session's stream."
      : tree?.exact
        ? "Live view — models and tokens appear when the run ends."
        : remote
          ? `Live view — this Claude Code version doesn't stream per-agent progress, and the run's journal lives on ${serverName}: labels and steps are matched by spawn order (approximate).`
          : "Live view — this Claude Code version doesn't name agents in the run's journal: labels and steps are matched by spawn order (approximate) until the report lands."
    : remote
      ? err
        ? `The run is over, but its report on ${serverName} couldn't be read (${err}) — Refresh to retry. Showing the session's last snapshot of it.`
        : `The run is over, but its report isn't on ${serverName} (yet) — Refresh to retry. Showing the session's last snapshot of it.`
      : live.fromStream
        ? "The run is over but its report isn't on disk (yet) — Refresh to retry. Showing the session's last snapshot of it."
        : sharedJournal
        ? "This run was resumed by another execution: the report and the journal on disk are shared with it, so each call below shows its LATEST attempt, not necessarily this execution's. Refresh to retry."
        : "The run is over but its report isn't on disk (yet) — Refresh to retry. Showing its journal.";
  // When the run started: the CLI's own time (its first agent queued) — the app's first sighting
  // is only a fallback, since a reattach that replays the run would restart the timer from 0. On a
  // paired server that time is the SERVER's clock, so the timer carries any server↔Mac skew
  // (sub-second under NTP; a server running ahead reads 0 s until the skew has elapsed).
  const startedAt = streamStartedAt(stream) ?? liveAct.startedAt;

  // Header subtitle: exact stats once the manifest is in, else the live count + a run timer.
  // ⚠️ The error case must be stated HERE too, not only in the body: a header reading
  // "running · 4/9 agents" beside a body saying "progress unavailable" is the same stale-shown-
  // as-live failure, just in the one line the user reads first.
  let subtitle: ReactNode = null;
  if (report) {
    const total = runProgress(model);
    const parts = [
      report.status ? report.status : null,
      total.total > 0
        ? progressText(total.done - total.failed, total.total, total.failed, "agents", total.total - total.done)
        : null,
      report.totalTokens != null ? `${fmtTokens(report.totalTokens)} tk` : null,
      report.durationMs != null ? fmtDuration(report.durationMs) : null,
      report.defaultModel ? shortModel(report.defaultModel) : null,
    ].filter(Boolean);
    subtitle = parts.length > 0 ? parts.join(" · ") : null;
  } else if (live.error) {
    subtitle = JOURNAL_UNAVAILABLE;
  } else {
    subtitle = (
      <>
        {running ? "running" : status ?? "finished"}
        {sharedJournal && !live.fromStream
          ? " · resumed by another execution"
          : hasJournal
            ? ` · ${progressText(live.delivered, live.started, live.failed, "agents", running ? 0 : live.running + live.queued)}`
            : ""}
        {startedAt != null && running ? (
          <>
            {" · "}
            <WfElapsed startedAt={startedAt} />
          </>
        ) : null}
      </>
    );
  }

  let bodyInner: ReactNode;
  if (face === "rich" || face === "live3") {
    // ---- the unified 3-panel view (live OR finished) ----
    bodyInner = (
      <>
        <div className={styles.colPhases}>
          <div className={styles.colHdr}>Phases</div>
          {uiPhases.length === 0 ? (
            <div className={styles.note}>No phases.</div>
          ) : (
            uiPhases.map((p) => {
              const sel = p.key === selPhaseKey;
              const spin = p.state === "cur" && running;
              return (
                <button
                  key={p.key}
                  type="button"
                  className={styles.phaseRow + (sel ? " " + styles.sel : "")}
                  data-state={settledState(p.state, running)}
                  onClick={() => {
                    setSelPhaseKey(p.key);
                    setSelAgentKey(p.agents[0]?.key ?? null);
                  }}
                >
                  <span className={styles.phaseDot}>
                    {spin ? <RunDots /> : <Dot s={toneDot(p.tone)} />}
                  </span>
                  <span className={styles.phaseMain}>
                    <span className={styles.phaseName + (p.synthetic ? " " + styles.synthetic : "")}>
                      {p.title}
                    </span>
                    {p.detail ? <span className={styles.phaseDetail}>{p.detail}</span> : null}
                  </span>
                  <span className={styles.phaseCount} data-state={p.tone}>
                    {p.count}
                  </span>
                </button>
              );
            })
          )}
          {face === "live3" ? (
            <div className={styles.colFootNote}>{liveFootnote}</div>
          ) : remote && err && report && !diskReport ? (
            // The stream's final snapshot stands in for a report that couldn't be read — say so.
            <div className={styles.colFootNote}>
              Showing the session's last snapshot of this run: its report on {serverName} couldn't be
              read ({err}).
            </div>
          ) : null}
        </div>

        <div className={styles.colAgents}>
          <div className={styles.colHdr}>Agents</div>
          {!selectedPhase ? (
            <div className={styles.note}>Select a phase.</div>
          ) : selectedPhase.agents.length === 0 ? (
            <div className={styles.note}>
              {selectedPhase.state === "cur" && running
                ? "Spawning agents…"
                : "No agents for this phase."}
            </div>
          ) : (
            selectedPhase.agents.map((a) => (
              <UiAgentRow
                key={a.key}
                agent={a}
                selected={a.key === selAgentKey}
                onSelect={() => setSelAgentKey(a.key)}
              />
            ))
          )}
        </div>

        <div className={styles.colTranscript}>
          {selectedAgent ? (
            <UiAgentTranscriptPane
              convId={convId}
              sessionId={sessionId}
              agent={selectedAgent}
              refreshTick={tick}
              manualRefresh={manualRefresh}
              remoteServer={remote ? serverName : null}
            />
          ) : (
            <div className={styles.note}>Select an agent to view its transcript.</div>
          )}
        </div>
      </>
    );
  } else if (face === "error") {
    bodyInner = <div className={styles.note}>Manifest unreadable: {err}</div>;
  } else if (face === "liveErr") {
    bodyInner = (
      <div className={styles.live}>
        <div className={styles.note}>
          {JOURNAL_UNAVAILABLE} — {live.error}
        </div>
        <div className={styles.liveNote}>
          The run's journal could not be read, so the state below its last known values is not
          being refreshed. The run itself is unaffected.
        </div>
      </div>
    );
  } else if (face === "liveDrill") {
    // ---- CLASSIC (pref OFF) drill-in: ONE in-flight agent's transcript, mid-run ----
    // The selection is the agent's CALL key, resolved here to its current attempt — so a retry
    // follows the agent to its new transcript instead of freezing on the abandoned one.
    bodyInner = (
      <LiveAgentTranscript
        convId={convId}
        sessionId={sessionId}
        agent={live.agents.find((a) => a.key === selLiveAgent) ?? null}
        detail={(selLiveAgent && details.get(selLiveAgent)) || null}
        running={running}
        refreshTick={tick}
        manualRefresh={manualRefresh}
        remoteServer={remote ? serverName : null}
        onBack={() => setSelLiveAgent(null)}
      />
    );
  } else if (face === "liveClassic") {
    // ---- CLASSIC (pref OFF) overview: count boxes + in-flight list + step list ----
    bodyInner = (
      <LiveOverviewClassic
        tree={tree}
        currentProgress={currentProgress}
        journal={live}
        running={running}
        note={liveFootnote}
        onOpenAgent={setSelLiveAgent}
      />
    );
  } else if (face === "loading") {
    bodyInner = <div className={styles.note}>Loading workflow…</div>;
  } else {
    bodyInner = (
      <div className={styles.note}>
        {remote
          ? `Workflow report not found on ${serverName}, and the session didn't stream one.`
          : "Workflow report not found (conversation reopened?)."}
      </div>
    );
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.panel + (wide ? "" : " " + styles.panelLive)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className={styles.head}>
          {running ? <RunDots /> : <Ico name="layers" className={"sm " + styles.headIco} />}
          <div className={styles.titles}>
            <div className={styles.title}>{report?.workflowName ?? workflowName ?? "Workflow"}</div>
            {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
          {/* Re-reads the report and the selected agent's transcript — for a run on a paired
              server, on that server. While a remote run goes there is no report to read yet, so
              only the transcript is re-read (and with none open, Refresh says so — see
              `refreshOff`). ⚠️ `aria-disabled`, NOT `disabled`: a disabled button takes no pointer
              events, so the title carrying the reason would never show. */}
          <button
            className={styles.headBtn}
            aria-disabled={refreshOff || undefined}
            onClick={() => {
              if (refreshOff) return;
              setTick((t) => t + 1);
              setManualRefresh((n) => n + 1);
              if (!(remote && running)) void fetchData();
            }}
            aria-label="Refresh"
            title={refreshTitle}
          >
            <Ico name="refresh" className={"sm" + (loading ? " wf-spin-fast" : "")} />
          </button>
          <button className={styles.headBtn} onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={wide ? styles.body : styles.bodyLive}>{bodyInner}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A ticking elapsed label for a live run, from its start time: the CLI's own (the stream
 *  snapshot's first `queuedAt`; on a paired server, that server's clock), else the app's first
 *  sighting of the run. Its own leaf so the 1 Hz tick re-renders only this. */
function WfElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <span className="wf-mono">{fmtDuration(Math.max(0, now - startedAt))}</span>;
}

/** The mid-run overview (CLASSIC, pref `workflowAgentDetail` OFF): colour-coded count boxes
 *  (launched / running / done, plus failed when any), the in-flight agents (drillable, named by
 *  their script label — by short id only for a pre-2.1.272 journal), and the full step list with
 *  a per-phase "delivered/total" badge. Phases come from the script's `meta` (available at t=0 →
 *  upcoming steps show); the counts and the agent set from the journal (per-phase counts too,
 *  exactly, when it names its agents — else split from the wire, approximately). */
function LiveOverviewClassic({
  tree,
  currentProgress,
  journal,
  running,
  note,
  onOpenAgent,
}: {
  /** The shared live tree (see `liveTree`); null only while the modal is closing. */
  tree: LiveTree | null;
  currentProgress: string | null | undefined;
  journal: WfJournalView;
  /** Whether the RUN is still going. Gates everything that claims present-tense activity. */
  running: boolean;
  /** The face's footnote — shared with the 3-panel face (see `liveFootnote`). */
  note: string;
  /** Open an agent's transcript, by its CALL key (stable across retries). */
  onOpenAgent: (key: string) => void;
}) {
  const cur = splitProgress(currentProgress);
  const { started, delivered, failed, queued } = journal;
  // A stream view knows agents still waiting behind the run's concurrency gate: they are part of
  // the run, not launched — counted in their own box, so the boxes add up.
  const launched = started - queued;
  // "In flight" is only true while the run is going: an agent with no `result` line in a
  // SETTLED run was never closed by the CLI (real runs do this), not still working. Showing
  // spinners for it would state something false about a finished run.
  const inflight = running ? journal.running : 0;
  const rows = tree?.rows ?? [];
  // The agents the journal has not closed (only one with a transcript can be drilled into):
  // in flight while the run lives, "no result recorded" once it is over — listed either way, so
  // none of them goes unsaid.
  const flying = inFlightAgents(journal).filter((a) => a.agentId != null);

  return (
    <div className={styles.live}>
      <div className={styles.statBoxes}>
        <div className={styles.statBox + " " + styles.sbTotal}>
          <span className={styles.sbN}>{launched}</span>
          <span className={styles.sbL}>launched</span>
        </div>
        {running ? (
          <div className={styles.statBox + " " + styles.sbRun}>
            <span className={styles.sbN}>{inflight}</span>
            <span className={styles.sbL}>running</span>
          </div>
        ) : (
          <div className={styles.statBox + " " + styles.sbTotal}>
            {/* Same count as the header and the tally: an agent that never left the queue left
                no result either. */}
            <span className={styles.sbN}>{journal.running + queued}</span>
            <span className={styles.sbL}>no result</span>
          </div>
        )}
        {running && queued > 0 ? (
          <div className={styles.statBox + " " + styles.sbTotal}>
            <span className={styles.sbN}>{queued}</span>
            <span className={styles.sbL}>queued</span>
          </div>
        ) : null}
        <div className={styles.statBox + " " + styles.sbDone}>
          <span className={styles.sbN}>{delivered}</span>
          <span className={styles.sbL}>done</span>
        </div>
        {failed > 0 ? (
          <div className={styles.statBox + " " + styles.sbFail}>
            <span className={styles.sbN}>{failed}</span>
            <span className={styles.sbL}>failed</span>
          </div>
        ) : null}
      </div>

      {flying.length > 0 ? (
        <div className={styles.liveAgents}>
          <div className={styles.liveAgentsHdr}>{running ? "In flight" : "No result recorded"}</div>
          {flying.map((a) => (
            <button
              key={a.key}
              type="button"
              className={styles.liveAgentRow}
              onClick={() => onOpenAgent(a.key)}
              title={running ? "Read this agent's transcript as it writes it" : "Read this agent's transcript"}
            >
              {running ? <RunDots /> : <Dot s="off" />}
              {a.label ? (
                <span className={styles.liveAgentId}>{a.label}</span>
              ) : (
                <span className={styles.liveAgentId + " wf-mono"}>{shortAgentId(a.agentId ?? "")}</span>
              )}
              <Ico name="arrow" className={"sm " + styles.liveAgentChevron} />
            </button>
          ))}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className={styles.livePhases}>
          {rows.map((r) => {
            const isActive = r.state === "cur" && running;
            // Matched by row KEY, never by title: a synthetic bucket can share a phase's title.
            const isCurPhase = tree?.curKey != null && r.key === tree.curKey;
            const view = phaseRowView(r, "upcoming", !running);
            return (
              <div key={r.key} className={styles.livePhaseRow} data-state={settledState(r.state, running)}>
                <span className={styles.livePhaseDot}>
                  {isActive ? <RunDots /> : <Dot s={toneDot(view.tone)} />}
                </span>
                <span className={styles.livePhaseBody}>
                  <span className={styles.livePhaseName + (r.synthetic ? " " + styles.synthetic : "")}>
                    {r.title}
                  </span>
                  {isCurPhase && tree?.curLabel ? (
                    <span className={styles.livePhaseCur}>{tree.curLabel}</span>
                  ) : r.detail ? (
                    <span className={styles.livePhaseDetail}>{r.detail}</span>
                  ) : null}
                </span>
                <span className={styles.livePhaseCount} data-state={view.tone}>
                  {view.count}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.liveCur}>
          <div className={styles.liveCurLbl}>Current step</div>
          <div className={styles.liveCurPhase}>{cur ? cur.phase : "Workflow starting…"}</div>
          {cur?.label ? <div className={styles.liveCurAgent}>{cur.label}</div> : null}
        </div>
      )}

      <div className={styles.liveNote}>{note}</div>
    </div>
  );
}

/** How many in-flight agents we read a live "doing X" line for per tick. A workflow can fan out
 *  to dozens; reading every transcript on every tick would be the kind of always-reading cost
 *  this project refuses. Bounded — beyond it, agents still show label + state, just no activity
 *  line. In a pipeline only the active phase has running agents, so this is rarely hit. */
const ACTIVITY_CAP = 10;

/** Read a live one-line activity for a bounded set of running agents, refreshed each tick. Each
 *  read is the same `load_subagent_transcript` the drill-in uses; we only derive its last line.
 *  Fetches only while the run lives (a settled run has nothing new to say). */
function useAgentsActivity(
  convId: string,
  sessionId: string | null,
  agentIds: string[],
  running: boolean,
  refreshTick: number,
): Map<string, AgentActivity | null> {
  const [map, setMap] = useState<Map<string, AgentActivity | null>>(new Map());
  const capped = agentIds.slice(0, ACTIVITY_CAP);
  const key = capped.join(",");
  useEffect(() => {
    if (!sessionId || !running || capped.length === 0) {
      setMap((m) => (m.size === 0 ? m : new Map()));
      return;
    }
    let alive = true;
    void (async () => {
      const entries = await Promise.all(
        capped.map(async (id) => {
          try {
            const res = await commands.loadSubagentTranscript(convId, sessionId, id, null);
            if (res.status === "ok") return [id, deriveActivity(res.data)] as const;
          } catch {
            /* a transient read error just leaves this agent without an activity line */
          }
          return [id, null] as const;
        }),
      );
      if (alive) setMap(new Map(entries));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, sessionId, running, key, refreshTick]);
  return map;
}

/** One agent row in the unified 3-panel Agents column (live or finished). Spinner while running,
 *  a state dot otherwise; the exact per-agent meta/stats (post-run) or a live "doing X" line
 *  (mid-run). A queued agent (no id yet) is shown but not clickable — nothing to read. */
function UiAgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: UiAgent;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.agentRow + (selected ? " " + styles.sel : "")}
      data-clickable={agent.clickable}
      disabled={!agent.clickable}
      onClick={agent.clickable ? onSelect : undefined}
      title={agent.clickable ? HINT_OPEN : undefined}
    >
      <span className={styles.agentTop}>
        {agent.running ? <RunDots /> : <Dot s={agent.dot} />}
        <span className={styles.agentLabel + (agent.mono ? " wf-mono" : "")} data-done={agent.done}>
          {agent.label}
        </span>
        {agent.clickable ? <Ico name="arrow" className={"sm " + styles.agentChevron} /> : null}
      </span>
      {agent.meta ? <span className={styles.agentMeta + " wf-mono"}>{agent.meta}</span> : null}
      {agent.stats ? <span className={styles.agentStats + " wf-mono"}>{agent.stats}</span> : null}
      {agent.activity ? <span className={styles.agentAct}>{agent.activity}</span> : null}
      {agent.outcome ? (
        <span className={styles.agentOutcome} data-tone={agent.outcome.tone}>
          {agent.outcome.text}
        </span>
      ) : null}
    </button>
  );
}

/** The transcript column for one selected agent — the same read-only renderer live or cold, so a
 *  running agent and a finished one read exactly the same. Shows the exact prompt/result previews
 *  when the manifest carries them, else the live "doing X" line. Re-reads only while THIS agent
 *  is running: a settled agent's transcript won't change, and the empty-transcript note must not
 *  claim an agent that already failed "is working". */
function UiAgentTranscriptPane({
  convId,
  sessionId,
  agent,
  refreshTick,
  manualRefresh,
  remoteServer,
}: {
  convId: string;
  sessionId: string | null;
  agent: UiAgent;
  refreshTick: number;
  manualRefresh: number;
  /** The paired server the run lives on (its transcripts are there), or null for this Mac. */
  remoteServer: string | null;
}) {
  // What the stream says about this agent right now: a remote transcript is re-read only when
  // this moved (see TranscriptBody). Null when the stream says nothing (an older CLI).
  const streamKey =
    agent.activity || agent.lastTool || agent.stats
      ? [agent.activity, agent.lastTool, agent.stats, agent.running, agent.done].join("|")
      : null;
  return (
    <div>
      <div className={styles.txHead}>
        <div className={styles.txTitle + (agent.mono ? " wf-mono" : "")}>{agent.label}</div>
        {agent.meta || agent.stats ? (
          <div className={styles.txPreview + " wf-mono"}>
            {[agent.meta, agent.stats].filter(Boolean).join(" · ")}
          </div>
        ) : null}
        {agent.activity ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Doing</span>
            {agent.activity}
          </div>
        ) : agent.lastTool ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Last</span>
            {agent.lastTool}
          </div>
        ) : null}
        {agent.outcome ? <OutcomeLine outcome={agent.outcome} /> : null}
        {agent.promptPreview ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Prompt</span>
            {truncate(agent.promptPreview, 320)}
          </div>
        ) : null}
        {agent.resultPreview ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Result</span>
            {truncate(agent.resultPreview, 320)}
          </div>
        ) : null}
      </div>
      <TranscriptBody
        convId={convId}
        sessionId={sessionId}
        agentId={agent.agentId}
        running={agent.running}
        refreshTick={refreshTick}
        manualRefresh={manualRefresh}
        streamKey={streamKey}
        missingNote={agent.missingNote}
        remoteServer={remoteServer}
        streamDetailShown={!!(agent.promptPreview || agent.resultPreview || agent.activity || agent.lastTool)}
      />
    </div>
  );
}

/** A settled agent's outcome, under its own label and in the error tone — a failure is not a
 *  "doing" activity. */
function OutcomeLine({ outcome }: { outcome: Outcome }) {
  return (
    <div className={styles.txPreview + " " + styles.txOutcome} data-tone={outcome.tone}>
      <span className={styles.txPreviewLbl}>Outcome</span>
      {outcome.text}
    </div>
  );
}

/** A phase row's displayed state: once the run is over nothing is "current" any more — a phase
 *  left with unclosed agents (live tree) or interrupted ones (a report) must not keep the
 *  in-progress styling. */
function settledState(state: LivePhaseState, live: boolean): LivePhaseState {
  return !live && state === "cur" ? "todo" : state;
}

/** The dot a phase tone maps to. */
function toneDot(tone: PhaseTone): StreamState {
  return tone === "err" ? "err" : tone === "done" ? "done" : "off";
}

/** A workflow agent id is a long opaque hash. It only identifies a row when the journal carries
 *  no label for it (a claude binary older than 2.1.272) — shortened, since only its head is
 *  needed to tell rows apart. */
function shortAgentId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** One in-flight agent's transcript, read mid-run in the CLASSIC face. Same read-only renderer
 *  as everywhere else; the back link returns to the overview (the classic face has no room for
 *  a persistent list). `agent` is the journal's CURRENT view of the selected call (null if the
 *  journal no longer lists it), so a retry swaps in the new attempt's transcript. */
function LiveAgentTranscript({
  convId,
  sessionId,
  agent,
  detail,
  running,
  refreshTick,
  manualRefresh,
  remoteServer,
  onBack,
}: {
  convId: string;
  sessionId: string | null;
  agent: WorkflowJournalAgent | null;
  /** The stream's detail for this agent (model, tokens, previews, last tool), when the live view
   *  comes from the stream — for a remote run, everything there is to show. */
  detail: WfAgent | null;
  running: boolean;
  refreshTick: number;
  manualRefresh: number;
  remoteServer: string | null;
  onBack: () => void;
}) {
  const agentId = agent?.agentId ?? null;
  const working = running && agent != null && !agent.done;
  const meta = detail ? [agentMeta(detail), agentStats(detail)].filter(Boolean).join(" · ") : "";
  const tool = detail ? streamActivity(detail) : null;
  return (
    <div>
      <div className={styles.txHead}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          <Ico name="arrow" className={"sm " + styles.backIco} />
          Back to overview
        </button>
        {agent?.label ? (
          <div className={styles.txTitle}>{agent.label}</div>
        ) : (
          <div className={styles.txTitle + " wf-mono"}>{agentId ? shortAgentId(agentId) : "agent"}</div>
        )}
        {meta ? <div className={styles.txPreview + " wf-mono"}>{meta}</div> : null}
        {tool ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>{working ? "Doing" : "Last"}</span>
            {tool}
          </div>
        ) : null}
        {agent?.failed ? (
          <OutcomeLine outcome={agentId ? OUTCOME_FAILED : OUTCOME_NOSTART} />
        ) : agent != null && !agent.done && !running ? (
          <OutcomeLine outcome={OUTCOME_UNFINISHED} />
        ) : null}
        {detail?.promptPreview ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Prompt</span>
            {truncate(detail.promptPreview, 320)}
          </div>
        ) : null}
        {detail?.resultPreview ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Result</span>
            {truncate(detail.resultPreview, 320)}
          </div>
        ) : null}
      </div>
      <TranscriptBody
        convId={convId}
        sessionId={sessionId}
        agentId={agentId}
        running={working}
        refreshTick={refreshTick}
        manualRefresh={manualRefresh}
        streamKey={
          detail
            ? [detail.state, detail.lastToolName, detail.lastToolSummary, detail.tokens, detail.toolCalls].join("|")
            : null
        }
        remoteServer={remoteServer}
        streamDetailShown={!!(meta || tool || detail?.promptPreview || detail?.resultPreview)}
        missingNote={
          agent == null
            ? "This agent is no longer listed in the run's journal."
            : agent.failed
              ? FAILED_BEFORE_START
              : null
        }
      />
    </div>
  );
}

/** Loads and renders one agent's transcript. Shared by the rich post-run pane and the mid-run
 *  drill-in, so a running agent and a finished one read exactly the same. `agentId` null = the
 *  manifest carried no id (a queued agent) — a normal state, stated as such.
 *
 *  The read is routed by the conversation: this Mac's disk, or — for a run on a paired server —
 *  that server (incrementally: the core keeps what it already fetched). How often it re-reads
 *  while the agent runs differs: on this Mac, every tick of the modal (1.5 s, a cheap disk read);
 *  on a server, at most every {@link REMOTE_TRANSCRIPT_MS} and only once the agent's stream
 *  snapshot (`streamKey`) moved since the last read — with no snapshot to watch (an older CLI),
 *  every such interval. Mounted only while its agent is selected, so a closed modal or another
 *  selection reads nothing. */
function TranscriptBody({
  convId,
  sessionId,
  agentId,
  running,
  refreshTick,
  manualRefresh = 0,
  streamKey = null,
  missingNote = null,
  remoteServer = null,
  streamDetailShown = false,
}: {
  convId: string;
  sessionId: string | null;
  agentId: string | null;
  /** Whether THIS agent is still working — drives the re-read and the empty-transcript wording. */
  running: boolean;
  refreshTick: number;
  /** Bumped by the modal's Refresh button: always re-reads, local or remote. */
  manualRefresh?: number;
  /** What the stream currently says about this agent (state, last tool, tokens…), or null when
   *  it says nothing — a remote re-read waits for this to move. */
  streamKey?: string | null;
  /** What to say when there is no id (default: the manifest's queued-agent case). */
  missingNote?: string | null;
  /** The paired server the run lives on (the transcript is read there), or null for this Mac. */
  remoteServer?: string | null;
  /** Whether the pane above shows the stream's detail for this agent — a failed remote read
   *  points to it when it is there. */
  streamDetailShown?: boolean;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<FileReadError | string | null>(null);
  const remote = remoteServer != null;
  // Remote re-read pacing: the interval bumps `remoteTick` only when the stream moved since the
  // last read (both read through refs, so a snapshot changing every second never resets the
  // interval — it would then never fire).
  const [remoteTick, setRemoteTick] = useState(0);
  const streamKeyRef = useRef(streamKey);
  streamKeyRef.current = streamKey;
  const readKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!remote || !running) return;
    const id = setInterval(() => {
      const now = streamKeyRef.current;
      if (now == null || now !== readKeyRef.current) setRemoteTick((t) => t + 1);
    }, REMOTE_TRANSCRIPT_MS);
    return () => clearInterval(id);
  }, [remote, running]);

  // A different agent selected: drop the previous one's transcript at once — never show it under
  // this agent's header while the new read is in flight (a remote read takes a moment).
  const target = `${convId}|${sessionId}|${agentId}`;
  const [shownFor, setShownFor] = useState(target);
  if (shownFor !== target) {
    setShownFor(target);
    setItems(null);
    setErr(null);
  }

  // Local: the modal's tick while running (a settled agent's `0` re-reads once at the settle).
  // Remote: its own paced tick, plus the settle edge itself.
  const readSeq = remote ? `r${remoteTick}:${running}` : `l${running ? refreshTick : 0}`;
  useEffect(() => {
    let alive = true;
    if (!sessionId || !agentId) {
      setItems(null);
      setErr(null);
      return;
    }
    setLoading(true);
    readKeyRef.current = streamKeyRef.current;
    commands
      .loadSubagentTranscript(convId, sessionId, agentId, null)
      .then((res) => {
        if (!alive) return;
        if (res.status === "ok") {
          setItems(res.data);
          setErr(null);
        } else setErr(res.error);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [convId, sessionId, agentId, readSeq, manualRefresh]);

  let body: ReactNode;
  if (!agentId) {
    body = (
      <div className={styles.note}>
        {missingNote ?? "Transcript unavailable (agent has no id on disk)."}
      </div>
    );
  } else if (err) {
    body = (
      <div className={styles.note}>
        Transcript unreadable: {fileReadErrorText(err)}
        {remote && streamDetailShown ? ". What the session's stream says about it is shown above." : ""}
      </div>
    );
  } else if (loading && !items) {
    body = (
      <div className={styles.note}>
        {remote ? `Reading the transcript on ${remoteServer}…` : "Loading transcript…"}
      </div>
    );
  } else if (!items || items.length === 0) {
    body = (
      <div className={styles.note}>
        {running
          ? "The agent is working — no transcript yet…"
          : remote
            ? `No transcript written on ${remoteServer}.`
            : "No transcript written."}
      </div>
    );
  } else {
    body = <SubAgentTranscript items={items} agentPrompt />;
  }

  return body;
}

/** The agent a phase selects by default: the first one with something to read (a queued agent
 *  has no transcript yet), else the first. */
function firstAgentKey(agents: UiAgent[]): string | null {
  return (agents.find((a) => a.clickable) ?? agents[0])?.key ?? null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
