// The /workflows-style detail modal. Two faces, because of how the CLI persists a run:
//
//  - WHILE RUNNING → a LIVE OVERVIEW. The rich per-phase/per-agent data does NOT exist on
//    disk yet (the manifest is written only when the run ENDS). The only live signals are the
//    wire's coarse `task_progress` ("<phase>: <label>", passed in as `currentProgress`) and
//    the append-only `journal.jsonl` (agents launched vs done). So mid-run we show the
//    overview the user asked for: current phase + agents launched / done / running.
//  - ONCE FINISHED → the rich 3-panel view (phases → agents w/ metrics → transcript), read
//    from the manifest (`load_workflow_run`) + per-agent transcripts (`load_subagent_transcript`).
//
// Portal + scrim (same family as <TranscriptPopover>). While running we poll both readers; the
// moment the run ends we re-fetch (the manifest lands just after the status flips), upgrading
// the live overview in place to the rich report. The shared read-only <SubAgentTranscript>
// renders each agent's transcript, so the off-thread view never drifts from the live one.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConversationItem, WorkflowJournal, WorkflowPhase, WorkflowRun } from "../../ipc/client";
import { commands } from "../../ipc/client";
import { Dot, Ico, RunDots } from "../../ui/kit";
import { fmtDuration, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { useAppErrors } from "../../store/appErrors";
import type { WfLive } from "../../store/workflowLive";
import { SubAgentTranscript } from "./SubAgentTranscript";
import {
  parseWorkflow,
  phaseProgress,
  runProgress,
  wfStateDot,
  type WfAgent,
  type WfPhase,
} from "./workflowModel";
import styles from "./WorkflowDetail.module.css";

const POLL_MS = 1500;

function phaseKey(p: WfPhase): string {
  return `${p.index ?? ""}|${p.title}`;
}

/** Stable selection key for an agent row: its `agentId` when present, else a positional key.
 *  A queued/id-less agent (legitimate — `parseWorkflow` keeps it) is thus still selectable and
 *  highlights correctly (B4). */
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

export function WorkflowDetail({
  open,
  sessionId,
  runId,
  running,
  workflowName,
  currentProgress,
  liveActivity,
  onClose,
}: {
  open: boolean;
  /** Claude's durable session_id — the key for the on-disk manifest + transcripts. */
  sessionId: string | null;
  /** The run id (`wf_<id>`), parsed from the Workflow tool_result. */
  runId: string | null;
  /** Whether the run is still going — drives the poll, and the live-vs-rich face. */
  running: boolean;
  /** Fallback name shown in the header before the manifest loads. */
  workflowName?: string | null;
  /** The wire's latest coarse progress ("<phase>: <label>") — the live current step. */
  currentProgress?: string | null;
  /** Accumulated per-phase agent activity from the wire (live per-phase started counts). */
  liveActivity?: WfLive;
  onClose: () => void;
}) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [journal, setJournal] = useState<WorkflowJournal | null>(null);
  const [livePhases, setLivePhases] = useState<WorkflowPhase[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0); // bumped on each poll → refetches the transcript too
  const [selPhaseKey, setSelPhaseKey] = useState<string | null>(null);
  const [selAgentKey, setSelAgentKey] = useState<string | null>(null);
  // The script is written once at t=0 — fetch its phases until loaded, then stop re-parsing it
  // on every poll (the manifest + journal are the only things that change during the run).
  const phasesLoadedRef = useRef(false);

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
      if (j.status === "ok") setJournal(j.data);
      else useAppErrors.getState().pushError("Workflow journal unreadable", j.error);
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
    setJournal(null);
    setLivePhases([]);
    setErr(null);
    setSelPhaseKey(null);
    setSelAgentKey(null);
    phasesLoadedRef.current = false;
    void fetchData();
  }, [open, fetchData]);

  // Poll while the run is going (the session dir isn't fs-watched).
  useEffect(() => {
    if (!open || !running) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      void fetchData();
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

  // Default selection once the (rich) model lands; never clobber a live user choice. Agents are
  // keyed by a STABLE row key (agentId, or a positional fallback) so a queued/id-less agent is
  // still selectable and highlights correctly.
  useEffect(() => {
    if (model.phases.length === 0) return;
    const found = model.phases.find((p) => phaseKey(p) === selPhaseKey);
    if (!found) {
      const def = model.phases.find((p) => p.agents.length > 0) ?? model.phases[0];
      setSelPhaseKey(phaseKey(def));
      setSelAgentKey(def.agents[0] ? agentRowKey(def.agents[0], 0) : null);
    }
  }, [model, selPhaseKey]);

  const selectedPhase = model.phases.find((p) => phaseKey(p) === selPhaseKey) ?? null;
  const selectedAgent =
    selectedPhase?.agents.find((a, i) => agentRowKey(a, i) === selAgentKey) ?? null;

  if (!open) return null;

  const total = runProgress(model);
  // Header subtitle: rich stats once the manifest is in, else the live count from the journal.
  const subParts = run
    ? [
        run.status ? run.status : null,
        total.total > 0 ? `${total.done}/${total.total} agents` : null,
        run.totalTokens != null ? `${fmtTokens(run.totalTokens)} tk` : null,
        run.durationMs != null ? fmtDuration(run.durationMs) : null,
        run.defaultModel ? shortModel(run.defaultModel) : null,
      ].filter(Boolean)
    : [
        running ? "running" : "completed",
        journal ? `${journal.done}/${journal.started} agents` : null,
      ].filter(Boolean);

  let bodyInner: ReactNode;
  if (run) {
    // ---- Rich, post-run 3-panel view ----
    bodyInner = (
      <>
        <div className={styles.colPhases}>
          <div className={styles.colHdr}>Phases</div>
          {model.phases.length === 0 ? (
            <div className={styles.note}>No phases.</div>
          ) : (
            model.phases.map((p) => {
              const pp = phaseProgress(p);
              const k = phaseKey(p);
              const sel = k === selPhaseKey;
              return (
                <button
                  key={k}
                  type="button"
                  className={styles.phaseRow + (sel ? " " + styles.sel : "")}
                  onClick={() => {
                    setSelPhaseKey(k);
                    setSelAgentKey(p.agents[0] ? agentRowKey(p.agents[0], 0) : null);
                  }}
                >
                  <span className={styles.phaseName}>{p.title}</span>
                  <span className={styles.phaseCount}>{pp.total > 0 ? `${pp.done}/${pp.total}` : "—"}</span>
                </button>
              );
            })
          )}
        </div>

        <div className={styles.colAgents}>
          <div className={styles.colHdr}>Agents</div>
          {!selectedPhase || selectedPhase.agents.length === 0 ? (
            <div className={styles.note}>No agents for this phase.</div>
          ) : (
            selectedPhase.agents.map((a, i) => {
              const rk = agentRowKey(a, i);
              return (
                <AgentRow
                  key={rk}
                  agent={a}
                  selected={rk === selAgentKey}
                  onSelect={() => setSelAgentKey(rk)}
                />
              );
            })
          )}
        </div>

        <div className={styles.colTranscript}>
          {selectedAgent ? (
            <AgentTranscriptPane sessionId={sessionId} agent={selectedAgent} running={running} refreshTick={tick} />
          ) : (
            <div className={styles.note}>Select an agent to view its transcript.</div>
          )}
        </div>
      </>
    );
  } else if (err) {
    bodyInner = <div className={styles.note}>Manifest unreadable: {err}</div>;
  } else if (running || journal) {
    // ---- Live overview (manifest not written yet) ----
    bodyInner = (
      <LiveOverview
        phases={livePhases}
        liveActivity={liveActivity ?? { phases: [] }}
        currentProgress={currentProgress}
        journal={journal}
      />
    );
  } else if (loading) {
    bodyInner = <div className={styles.note}>Loading workflow…</div>;
  } else {
    bodyInner = (
      <div className={styles.note}>Workflow report not found (conversation reopened?).</div>
    );
  }

  return createPortal(
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.panel + (run ? "" : " " + styles.panelLive)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className={styles.head}>
          {running ? <RunDots /> : <Ico name="layers" className={"sm " + styles.headIco} />}
          <div className={styles.titles}>
            <div className={styles.title}>{run?.workflowName ?? workflowName ?? "Workflow"}</div>
            {subParts.length > 0 ? <div className={styles.subtitle}>{subParts.join(" · ")}</div> : null}
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
        <div className={run ? styles.body : styles.bodyLive}>{bodyInner}</div>
      </div>
    </div>,
    document.body,
  );
}

const norm = (s: string) => s.trim().toLowerCase();

/** A live row for the phase list. `started` = agents seen in this phase on the wire; `done` =
 *  agents finished (derived); `state` = done | cur | todo, driven by the wire's CURRENT phase
 *  when known (more reliable than the derived counts). */
interface LiveRow {
  title: string;
  detail: string | null;
  started: number;
  done: number;
  state: "done" | "cur" | "todo";
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
      const state = p.started > 0 && done >= p.started ? "done" : p.started > 0 ? "cur" : "todo";
      return { ...p, done, state };
    });
  }

  // Agents started before the current phase — the global done minus this is the current phase's
  // progress (clamped to its own started, so it never claims more than it launched).
  let priorStarted = 0;
  for (let i = 0; i < curIdx; i++) priorStarted += order[i].started;
  return order.map((p, i) => {
    let done: number;
    let state: "done" | "cur" | "todo";
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

/** The mid-run overview: 3 colour-coded count boxes + the full step list with a per-phase
 *  "done/total" badge. Phases come from the script's `meta` (available at t=0 → upcoming steps
 *  show); per-phase started from the accumulated wire; done from the journal — the only live
 *  signals (the rich per-agent manifest is written only at the end). */
function LiveOverview({
  phases,
  liveActivity,
  currentProgress,
  journal,
}: {
  phases: WorkflowPhase[];
  liveActivity: WfLive;
  currentProgress: string | null | undefined;
  journal: WorkflowJournal | null;
}) {
  const cur = splitProgress(currentProgress);
  const started = journal?.started ?? 0;
  const done = journal?.done ?? 0;
  const inflight = Math.max(0, started - done);
  const rows = buildLiveRows(phases, liveActivity, done, cur?.phase ?? null);

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

      {rows.length > 0 ? (
        <div className={styles.livePhases}>
          {rows.map((r, i) => {
            const isActive = r.state === "cur";
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
        Live overview. Per-step counts refine as the run progresses; per-agent detail (metrics,
        transcripts) appears at the end, once the full report is written.
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: WfAgent;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = [agent.agentType, agent.model ? shortModel(agent.model) : null].filter(Boolean).join(" · ");
  const stats = [
    agent.tokens != null ? `${fmtTokens(agent.tokens)} tk` : null,
    agent.toolCalls != null ? `${agent.toolCalls} tools` : null,
    agent.durationMs != null ? fmtDuration(agent.durationMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const live = agent.state.toLowerCase() === "running";
  return (
    <button
      type="button"
      className={styles.agentRow + (selected ? " " + styles.sel : "")}
      onClick={onSelect}
      title={agent.agentId ? "View the agent's transcript" : "Transcript unavailable"}
    >
      <span className={styles.agentTop}>
        {live ? <RunDots /> : <Dot s={wfStateDot(agent.state)} />}
        <span className={styles.agentLabel}>{agent.label}</span>
        <Ico name="arrow" className={"sm " + styles.agentChevron} />
      </span>
      {meta ? <span className={styles.agentMeta + " wf-mono"}>{meta}</span> : null}
      {stats ? <span className={styles.agentStats + " wf-mono"}>{stats}</span> : null}
    </button>
  );
}

function AgentTranscriptPane({
  sessionId,
  agent,
  running,
  refreshTick,
}: {
  sessionId: string | null;
  agent: WfAgent;
  running: boolean;
  refreshTick: number;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const agentId = agent.agentId;

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

  return (
    <div>
      <div className={styles.txHead}>
        <div className={styles.txTitle}>{agent.label}</div>
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
      {body}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
