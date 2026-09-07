// The /workflows-style detail modal. ONE face, whether the run is live or finished — because
// what the user wants is the SAME clean view in both states:
//
//   phases (left) · agents (middle) · transcript (right) + a header summary on top.
//
// The two states differ only in where the data comes from, not in how it looks:
//  - WHILE RUNNING → the rich per-phase/per-agent manifest does NOT exist on disk yet (the CLI
//    writes it only when the run ENDS). So the tree is assembled from the LIVE signals: the
//    script's declared `phases` (known at t=0), the wire's coarse `task_progress` accumulated
//    into per-phase labels, and the run's `journal.jsonl` (agent ids + done state) pushed by the
//    app-wide watcher. Running agents show the classic spinner and a live "doing X" line read
//    from their incrementally-written transcript; per-agent models/tokens do NOT exist yet.
//  - ONCE FINISHED → the same three columns, now fed by the manifest (`load_workflow_run`), which
//    adds the exact labels, models, tokens, tool-calls and durations.
//
// The moment the run ends we re-fetch the manifest (it lands just after the status flips) and the
// same layout upgrades in place from live-approximate to exact. The shared read-only
// <SubAgentTranscript> renders every transcript, live or cold, so the two never drift.
//
// A lighter CLASSIC overview (colour-coded count boxes + an opaque id list) is kept behind the
// `workflowAgentDetail` pref OFF, as the revert path for anyone who prefers the compact readout.
//
// Portal + scrim (same family as <TranscriptPopover>). The journal is NOT polled here anymore:
// it arrives pushed, so the readout is identical whether this modal is open or closed.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationItem, WorkflowPhase, WorkflowRun } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { Dot, Ico, RunDots, type StreamState } from "../../ui/kit";
import { useNow } from "../../ui/useNow";
import { fmtDuration, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import { orderedLabels, type WfLive } from "../../store/workflowLive";
import {
  inFlightAgents,
  JOURNAL_UNAVAILABLE,
  pickJournal,
  toJournalView,
  type WfJournalView,
} from "../../store/workflowJournal";
import {
  deriveActivity,
  groupAgentsByPhase,
  norm,
  zipAgentsToLabels,
  type AgentActivity,
  type LiveAgent,
} from "./workflowTree";
import { SubAgentTranscript } from "./SubAgentTranscript";
import {
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

const EMPTY_LIVE: WfLive = { phases: [], startedAt: null };

function phaseKey(p: WfPhase): string {
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

type PhaseState = "done" | "cur" | "todo";

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
  /** Live one-line "doing X" — mid-run only. */
  activity: string | null;
  /** Show the animated spinner (agent working right now). */
  running: boolean;
  /** Whether the agent has settled — greys the label. */
  done: boolean;
  /** The dot to show when not running. */
  dot: StreamState;
  /** Selectable → its transcript can be read. A queued agent (no id yet) is not. */
  clickable: boolean;
  promptPreview: string | null;
  resultPreview: string | null;
}

interface UiPhase {
  key: string;
  title: string;
  detail: string | null;
  state: PhaseState;
  /** "3/5" · "upcoming" · "—". */
  count: string;
  agents: UiAgent[];
}

/** Shape the post-run manifest model into the unified phases. Phase state is derived from its
 *  agents: any running → current; all settled → done; none started → upcoming. */
function richToUi(model: { phases: WfPhase[] }): UiPhase[] {
  return model.phases.map((p) => {
    const { done, total } = phaseProgress(p);
    const anyRunning = p.agents.some((a) => a.state.toLowerCase() === "running");
    const state: PhaseState = anyRunning
      ? "cur"
      : total > 0 && done >= total
        ? "done"
        : total === 0
          ? "todo"
          : "cur";
    return {
      key: phaseKey(p),
      title: p.title,
      detail: p.detail,
      state,
      count: total > 0 ? `${done}/${total}` : "—",
      agents: p.agents.map((a, i) => {
        const meta =
          [a.agentType, a.model ? shortModel(a.model) : null].filter(Boolean).join(" · ") || null;
        const stats =
          [
            a.tokens != null ? `${fmtTokens(a.tokens)} tk` : null,
            a.toolCalls != null ? `${a.toolCalls} tools` : null,
            a.durationMs != null ? fmtDuration(a.durationMs) : null,
          ]
            .filter(Boolean)
            .join(" · ") || null;
        return {
          key: agentRowKey(a, i),
          agentId: a.agentId,
          label: a.label,
          mono: false,
          meta,
          stats,
          activity: null,
          running: a.state.toLowerCase() === "running",
          done: isTerminalState(a.state),
          dot: wfStateDot(a.state),
          clickable: true,
          promptPreview: a.promptPreview,
          resultPreview: a.resultPreview,
        };
      }),
    };
  });
}

/** Shape the live signals (phase rows + per-phase agents + activity) into the unified phases. */
function liveToUi(
  rows: LiveRow[],
  agentsByPhase: Map<string, LiveAgent[]>,
  activity: Map<string, AgentActivity | null>,
  running: boolean,
): UiPhase[] {
  return rows.map((r, i) => {
    const phaseAgents = agentsByPhase.get(norm(r.title)) ?? [];
    return {
      key: `${i}|${r.title}`,
      title: r.title,
      detail: r.detail,
      state: r.state,
      count: r.started > 0 ? `${r.done}/${r.started}` : "upcoming",
      agents: phaseAgents.map((a, j) => {
        const isRunning = running && !a.done && a.agentId != null;
        const name = a.label ?? (a.agentId ? shortAgentId(a.agentId) : "queued agent");
        const act = a.done
          ? null
          : a.agentId
            ? activity.get(a.agentId)?.detail ?? (isRunning ? "working…" : "starting…")
            : "queued";
        return {
          key: a.agentId ?? `${i}-q${j}`,
          agentId: a.agentId,
          label: name,
          mono: !a.label,
          meta: null,
          stats: null,
          activity: act,
          running: isRunning,
          done: a.done,
          dot: a.done ? "done" : "off",
          clickable: a.agentId != null,
          promptPreview: null,
          resultPreview: null,
        } satisfies UiAgent;
      }),
    };
  });
}

export function WorkflowDetail({
  open,
  sessionId,
  runId,
  running,
  workflowName,
  currentProgress,
  liveActivity,
  journal,
  onClose,
}: {
  open: boolean;
  /** Claude's durable session_id — the key for the on-disk manifest + transcripts. */
  sessionId: string | null;
  /** The run id (`wf_<id>`), parsed from the Workflow tool_result. */
  runId: string | null;
  /** Whether the run is still going — drives the poll, and the live-vs-rich data source. */
  running: boolean;
  /** Fallback name shown in the header before the manifest loads. */
  workflowName?: string | null;
  /** The wire's latest coarse progress ("<phase>: <label>") — the live current step. */
  currentProgress?: string | null;
  /** Accumulated per-phase agent activity from the wire (live per-phase started counts). */
  liveActivity?: WfLive;
  /** The run's live per-agent progress, pushed from disk by the app-wide watcher. */
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

  const fetchData = useCallback(async () => {
    if (!sessionId || !runId) return;
    setLoading(true);
    try {
      const wantPhases = !phasesLoadedRef.current;
      const [r, j, p] = await Promise.all([
        commands.loadWorkflowRun(sessionId, runId),
        commands.loadWorkflowJournal(sessionId, runId),
        wantPhases ? commands.loadWorkflowPhases(sessionId, runId) : Promise.resolve(null),
      ]);
      // The MANIFEST error is blocking (the body shows "unreadable"); a journal/phases error is
      // non-blocking but must NOT be silent → surface it in the app-level error banner.
      if (r.status === "ok") setRun(r.data);
      setErr(r.status === "error" ? r.error : null);
      if (j.status === "ok") setDiskJournal(toJournalView(j.data));
      // A failed read must DROP the previous disk snapshot, not keep it: leaving it in place
      // would let `pickJournal` serve unflagged stale numbers as this run's final truth, with
      // only a dismissible banner to say otherwise. Cleared → the pushed view (which carries
      // the watcher's own error flag) takes over.
      else {
        setDiskJournal(null);
        useAppErrors.getState().pushError("Workflow journal unreadable", j.error);
      }
      if (p) {
        if (p.status === "ok") {
          if (p.data.length > 0) {
            setLivePhases(p.data);
            phasesLoadedRef.current = true;
          }
        } else {
          useAppErrors.getState().pushError("Workflow phases unreadable", p.error);
        }
      }
    } catch (e) {
      console.error("loadWorkflowRun/Journal/Phases threw:", e);
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, runId]);

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
    void fetchData();
  }, [open, fetchData]);

  // Tick while the run is going — but for far less than before. The journal is PUSHED now
  // (the run dir is fs-watched app-wide), and the manifest does not exist until the run ends,
  // so the only reasons left to tick are: re-reading OPEN agent transcripts (live "doing X" +
  // the transcript column), and retrying the script's phases when they weren't written yet.
  useEffect(() => {
    if (!open || !running) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (!phasesLoadedRef.current) void fetchData();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, running, fetchData]);

  // The manifest lands shortly AFTER the run's status flips to done — and on a heavy run / slow
  // FS that can be more than a couple seconds. So once finished but the manifest isn't loaded
  // yet, poll a BOUNDED number of times (~10 s) to upgrade the live overview to the rich report
  // in place; then stop (the "not found" state + Refresh remain as the fallback).
  useEffect(() => {
    if (!open || running || run) return;
    void fetchData();
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
  }, [open, running, run, fetchData]);

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

  const model = useMemo(() => parseWorkflow(run), [run]);

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
  const wantLive3 = open && !run && agentDetail && (running || hasJournal) && !live.error;

  const liveRows = wantLive3 ? buildLiveRows(livePhases, liveAct, live.done, cur?.phase ?? null) : [];
  const zipped = wantLive3 ? zipAgentsToLabels(live.agents, orderedLabels(liveAct)) : [];
  const liveGroups = wantLive3
    ? groupAgentsByPhase(zipped, liveRows.map((r) => r.title), running ? cur?.phase ?? null : null)
    : [];
  const agentsByPhase = new Map(liveGroups.map((g) => [norm(g.phase), g.agents]));
  const runningIds = zipped.filter((a) => a.agentId && !a.done).map((a) => a.agentId as string);
  // Activity is read only for in-flight agents while the run lives (a finished one won't change).
  const activity = useAgentsActivity(sessionId, runningIds, running, tick);

  // The unified phases the 3-panel renders — from the manifest once in, else from the live tree.
  const uiPhases: UiPhase[] = run
    ? richToUi(model)
    : wantLive3
      ? liveToUi(liveRows, agentsByPhase, activity, running)
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
      setSelAgentKey(def.agents[0]?.key ?? null);
    } else if (selAgentKey && !found.agents.some((a) => a.key === selAgentKey)) {
      setSelAgentKey(found.agents[0]?.key ?? null);
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
  if (run) face = "rich";
  else if (err) face = "error";
  else if (agentDetail && (running || hasJournal)) face = live.error ? "liveErr" : "live3";
  else if (selLiveAgent) face = "liveDrill";
  else if (running || hasJournal) face = "liveClassic";
  else if (loading) face = "loading";
  else face = "empty";

  const wide = face === "rich" || face === "live3";
  const startedAt = liveAct.startedAt;

  // Header subtitle: exact stats once the manifest is in, else the live count + a run timer.
  // ⚠️ The error case must be stated HERE too, not only in the body: a header reading
  // "running · 4/9 agents" beside a body saying "progress unavailable" is the same stale-shown-
  // as-live failure, just in the one line the user reads first.
  let subtitle: ReactNode = null;
  if (run) {
    const total = runProgress(model);
    const parts = [
      run.status ? run.status : null,
      total.total > 0 ? `${total.done}/${total.total} agents` : null,
      run.totalTokens != null ? `${fmtTokens(run.totalTokens)} tk` : null,
      run.durationMs != null ? fmtDuration(run.durationMs) : null,
      run.defaultModel ? shortModel(run.defaultModel) : null,
    ].filter(Boolean);
    subtitle = parts.length > 0 ? parts.join(" · ") : null;
  } else if (live.error) {
    subtitle = JOURNAL_UNAVAILABLE;
  } else {
    subtitle = (
      <>
        {running ? "running" : "completed"}
        {hasJournal ? ` · ${live.done}/${live.started} agents` : ""}
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
                  data-state={p.state}
                  onClick={() => {
                    setSelPhaseKey(p.key);
                    setSelAgentKey(p.agents[0]?.key ?? null);
                  }}
                >
                  <span className={styles.phaseDot}>
                    {spin ? <RunDots /> : <Dot s={p.state === "done" ? "done" : "off"} />}
                  </span>
                  <span className={styles.phaseMain}>
                    <span className={styles.phaseName}>{p.title}</span>
                    {p.detail ? <span className={styles.phaseDetail}>{p.detail}</span> : null}
                  </span>
                  <span className={styles.phaseCount} data-state={p.state}>
                    {p.count}
                  </span>
                </button>
              );
            })
          )}
          {face === "live3" ? (
            <div className={styles.colFootNote}>
              Live view — labels, models and tokens finalize when the run ends.
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
              sessionId={sessionId}
              agent={selectedAgent}
              running={running}
              refreshTick={tick}
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
    bodyInner = (
      <LiveAgentTranscript
        sessionId={sessionId}
        agentId={selLiveAgent as string}
        running={running}
        refreshTick={tick}
        onBack={() => setSelLiveAgent(null)}
      />
    );
  } else if (face === "liveClassic") {
    // ---- CLASSIC (pref OFF) overview: count boxes + opaque id list + step list ----
    bodyInner = (
      <LiveOverviewClassic
        phases={livePhases}
        liveActivity={liveAct}
        currentProgress={currentProgress}
        journal={live}
        running={running}
        onOpenAgent={setSelLiveAgent}
      />
    );
  } else if (face === "loading") {
    bodyInner = <div className={styles.note}>Loading workflow…</div>;
  } else {
    bodyInner = (
      <div className={styles.note}>Workflow report not found (conversation reopened?).</div>
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
            <div className={styles.title}>{run?.workflowName ?? workflowName ?? "Workflow"}</div>
            {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
          </div>
          <button
            className={styles.headBtn}
            onClick={() => {
              setTick((t) => t + 1);
              void fetchData();
            }}
            aria-label="Refresh"
            title="Refresh"
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

/** A ticking elapsed label for a live run, from the app's first-seen start time (approximate —
 *  the wire carries no start timestamp). Its own leaf so the 1 Hz tick re-renders only this. */
function WfElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return <span className="wf-mono">{fmtDuration(Math.max(0, now - startedAt))}</span>;
}

/** A live row for the phase list. `started` = agents seen in this phase on the wire; `done` =
 *  agents finished (derived); `state` = done | cur | todo, driven by the wire's CURRENT phase
 *  when known (more reliable than the derived counts). */
interface LiveRow {
  title: string;
  detail: string | null;
  started: number;
  done: number;
  state: PhaseState;
}

/**
 * Build the live phase rows. Structure (which phases, in order, incl. upcoming) comes from the
 * script's declared `phases`; per-phase `started` from the accumulated wire; `state` is driven
 * by the wire's CURRENT phase (`curTitle`) — phases before it are done, after it are upcoming —
 * which is more reliable than inferring from counts. `done` per phase is then made consistent
 * with that state and with the journal's GLOBAL done, WITHOUT overflowing onto upcoming phases
 * or marking the current phase complete. Honest caveat: same-title fan-out can undercount
 * `started` (the wire dedups labels), so counts are approximate; the rich post-run report is
 * exact.
 */
function buildLiveRows(
  phases: WorkflowPhase[],
  liveActivity: WfLive,
  globalDone: number,
  curTitle: string | null,
): LiveRow[] {
  const startedBy = new Map(liveActivity.phases.map((p) => [norm(p.title), p.labels.length]));
  // Ordered titles: declared phases first (homonyms each get their OWN slot, but only the FIRST
  // occurrence of a title carries the wire count, so a duplicate title isn't double-counted),
  // then any wire-only phase not declared.
  const order: { title: string; detail: string | null; started: number }[] = [];
  const titleUsed = new Set<string>();
  const declaredTitles = new Set<string>();
  for (const p of phases) {
    const k = norm(p.title);
    declaredTitles.add(k);
    const started = titleUsed.has(k) ? 0 : startedBy.get(k) ?? 0;
    titleUsed.add(k);
    order.push({ title: p.title, detail: p.detail ?? null, started });
  }
  for (const p of liveActivity.phases) {
    const k = norm(p.title);
    if (!declaredTitles.has(k) && !titleUsed.has(k)) {
      titleUsed.add(k);
      order.push({ title: p.title, detail: null, started: p.labels.length });
    }
  }

  const curIdx = curTitle != null ? order.findIndex((p) => norm(p.title) === norm(curTitle)) : -1;
  const totalDone = Math.max(0, globalDone);

  if (curIdx < 0) {
    // No current phase known (e.g. just started, no wire tick yet): fall back to a bounded
    // greedy fill of the global done across phases in order.
    let remaining = totalDone;
    return order.map((p) => {
      const done = Math.min(remaining, p.started);
      remaining -= done;
      const state: PhaseState = p.started > 0 && done >= p.started ? "done" : p.started > 0 ? "cur" : "todo";
      return { ...p, done, state };
    });
  }

  // Agents started before the current phase — the global done minus this is the current phase's
  // progress (clamped to its own started, so it never claims more than it launched).
  let priorStarted = 0;
  for (let i = 0; i < curIdx; i++) priorStarted += order[i].started;
  return order.map((p, i) => {
    let done: number;
    let state: PhaseState;
    if (i < curIdx) {
      done = p.started; // an earlier (sequential) phase is fully done
      state = "done";
    } else if (i === curIdx) {
      done = Math.min(Math.max(0, totalDone - priorStarted), p.started);
      state = "cur";
    } else {
      done = 0;
      state = "todo";
    }
    return { ...p, done, state };
  });
}

/** The mid-run overview (CLASSIC, pref `workflowAgentDetail` OFF): 3 colour-coded count boxes,
 *  the in-flight agents (drillable, by opaque id), and the full step list with a per-phase
 *  "done/total" badge. Phases come from the script's `meta` (available at t=0 → upcoming steps
 *  show); per-phase started from the accumulated wire; the counts and the agent set from the
 *  journal — the only live signals (the rich per-agent manifest is written only at the end). */
function LiveOverviewClassic({
  phases,
  liveActivity,
  currentProgress,
  journal,
  running,
  onOpenAgent,
}: {
  phases: WorkflowPhase[];
  liveActivity: WfLive;
  currentProgress: string | null | undefined;
  journal: WfJournalView;
  /** Whether the RUN is still going. Gates everything that claims present-tense activity. */
  running: boolean;
  onOpenAgent: (agentId: string) => void;
}) {
  const cur = splitProgress(currentProgress);
  const { started, done } = journal;
  // "In flight" is only true while the run is going: an agent with no `result` line in a
  // SETTLED run was never closed by the CLI (real runs do this), not still working. Showing
  // spinners for it would state something false about a finished run.
  const inflight = running ? journal.running : 0;
  const rows = buildLiveRows(phases, liveActivity, done, cur?.phase ?? null);
  const flying = running ? inFlightAgents(journal) : [];

  return (
    <div className={styles.live}>
      <div className={styles.statBoxes}>
        <div className={styles.statBox + " " + styles.sbTotal}>
          <span className={styles.sbN}>{started}</span>
          <span className={styles.sbL}>launched</span>
        </div>
        <div className={styles.statBox + " " + styles.sbRun}>
          <span className={styles.sbN}>{inflight}</span>
          <span className={styles.sbL}>running</span>
        </div>
        <div className={styles.statBox + " " + styles.sbDone}>
          <span className={styles.sbN}>{done}</span>
          <span className={styles.sbL}>done</span>
        </div>
      </div>

      {flying.length > 0 ? (
        <div className={styles.liveAgents}>
          <div className={styles.liveAgentsHdr}>{running ? "In flight" : "No result recorded"}</div>
          {flying.map((a) => (
            <button
              key={a.agentId}
              type="button"
              className={styles.liveAgentRow}
              onClick={() => onOpenAgent(a.agentId)}
              title={running ? "Read this agent's transcript as it writes it" : "Read this agent's transcript"}
            >
              {running ? <RunDots /> : <Dot s="off" />}
              <span className={styles.liveAgentId + " wf-mono"}>{shortAgentId(a.agentId)}</span>
              <Ico name="arrow" className={"sm " + styles.liveAgentChevron} />
            </button>
          ))}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className={styles.livePhases}>
          {rows.map((r, i) => {
            const isActive = r.state === "cur" && running;
            const isCurPhase = cur != null && norm(r.title) === norm(cur.phase);
            return (
              <div key={`${r.title}-${i}`} className={styles.livePhaseRow} data-state={r.state}>
                <span className={styles.livePhaseDot}>
                  {isActive ? <RunDots /> : <Dot s={r.state === "done" ? "done" : "off"} />}
                </span>
                <span className={styles.livePhaseBody}>
                  <span className={styles.livePhaseName}>{r.title}</span>
                  {isCurPhase && cur?.label ? (
                    <span className={styles.livePhaseCur}>{cur.label}</span>
                  ) : r.detail ? (
                    <span className={styles.livePhaseDetail}>{r.detail}</span>
                  ) : null}
                </span>
                <span className={styles.livePhaseCount} data-state={r.state}>
                  {r.started > 0 ? `${r.done}/${r.started}` : "upcoming"}
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

      <div className={styles.liveNote}>
        Live overview. Launched / running / done are exact; the per-STEP split is approximate
        while the run lasts (the wire doesn't say which step an agent belongs to). Labels,
        metrics and models per agent appear at the end, with the full report.
      </div>
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
            const res = await commands.loadSubagentTranscript(sessionId, id);
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
  }, [sessionId, running, key, refreshTick]);
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
      title={
        agent.clickable
          ? "View the agent's transcript"
          : "This agent hasn't started writing a transcript yet"
      }
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
    </button>
  );
}

/** The transcript column for one selected agent — the same read-only renderer live or cold, so a
 *  running agent and a finished one read exactly the same. Shows the exact prompt/result previews
 *  when the manifest carries them, else the live "doing X" line. */
function UiAgentTranscriptPane({
  sessionId,
  agent,
  running,
  refreshTick,
}: {
  sessionId: string | null;
  agent: UiAgent;
  running: boolean;
  refreshTick: number;
}) {
  return (
    <div>
      <div className={styles.txHead}>
        <div className={styles.txTitle + (agent.mono ? " wf-mono" : "")}>{agent.label}</div>
        {agent.activity ? (
          <div className={styles.txPreview}>
            <span className={styles.txPreviewLbl}>Doing</span>
            {agent.activity}
          </div>
        ) : null}
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
      <TranscriptBody sessionId={sessionId} agentId={agent.agentId} running={running} refreshTick={refreshTick} />
    </div>
  );
}

/** A workflow agent id is a long opaque hash; mid-run there is no label for it anywhere on
 *  disk (labels live only in the end-of-run manifest), so the id itself has to identify the
 *  row — shortened, since only its head is needed to tell rows apart. */
function shortAgentId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** One in-flight agent's transcript, read mid-run in the CLASSIC face. Same read-only renderer
 *  as everywhere else; the back link returns to the overview (the classic face has no room for
 *  a persistent list). */
function LiveAgentTranscript({
  sessionId,
  agentId,
  running,
  refreshTick,
  onBack,
}: {
  sessionId: string | null;
  agentId: string;
  running: boolean;
  refreshTick: number;
  onBack: () => void;
}) {
  return (
    <div>
      <div className={styles.txHead}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          <Ico name="arrow" className={"sm " + styles.backIco} />
          Back to overview
        </button>
        <div className={styles.txTitle + " wf-mono"}>{shortAgentId(agentId)}</div>
      </div>
      <TranscriptBody sessionId={sessionId} agentId={agentId} running={running} refreshTick={refreshTick} />
    </div>
  );
}

/** Loads and renders one agent's on-disk transcript. Shared by the rich post-run pane and the
 *  mid-run drill-in, so a running agent and a finished one read exactly the same. `agentId`
 *  null = the manifest carried no id (a queued agent) — a normal state, stated as such. */
function TranscriptBody({
  sessionId,
  agentId,
  running,
  refreshTick,
}: {
  sessionId: string | null;
  agentId: string | null;
  running: boolean;
  refreshTick: number;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!sessionId || !agentId) {
      setItems(null);
      setErr(null);
      return;
    }
    setLoading(true);
    commands
      .loadSubagentTranscript(sessionId, agentId)
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
    // refreshTick drives the live re-read; only re-poll while running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentId, running ? refreshTick : 0]);

  let body: ReactNode;
  if (!agentId) {
    body = <div className={styles.note}>Transcript unavailable (agent has no id on disk).</div>;
  } else if (err) {
    body = <div className={styles.note}>Transcript unreadable: {err}</div>;
  } else if (loading && !items) {
    body = <div className={styles.note}>Loading transcript…</div>;
  } else if (!items || items.length === 0) {
    body = (
      <div className={styles.note}>
        {running ? "The agent is working — no transcript yet…" : "No transcript written."}
      </div>
    );
  } else {
    body = <SubAgentTranscript items={items} agentPrompt />;
  }

  return body;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
