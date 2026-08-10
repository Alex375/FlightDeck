// The live per-agent progress of running workflows, pushed from disk by the Rust watcher
// (`supervisor::workflow_watch` → `WorkflowJournalEvent`).
//
// Why this exists: a workflow is ONE aggregated task on the wire — its inner agents never
// surface individually — and the rich manifest is written only when the run ends. The one
// live source is the run's `journal.jsonl`, which the CLI appends to as agents start and
// finish. It used to be read by a 1.5 s poll that ran only while the detail modal was open;
// now a single watch per run feeds this store, and EVERY surface (pinned bar, inline card,
// Flight Deck card, modal) reads from here. No surface polls, and closing the modal no longer
// blinds the readout.
//
// Keyed by a conversation's STABLE id then `run_id` (`wf_…`), like the other live stores.
// Live-only: not persisted, dropped with its conversation.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { WorkflowJournal, WorkflowJournalAgent } from "../ipc/client";

/** What one surface needs to describe a run's live progress. */
export interface WfJournalView {
  /** Distinct agents the journal knows about. */
  started: number;
  /** Agents whose result has landed. */
  done: number;
  /** Agents the journal shows as unfinished — `started - done`, never negative.
   *  ⚠️ This is "not closed in the journal", NOT "working right now": the CLI does not
   *  guarantee a `result` line per agent (a real run on disk has 38 `started` / 0 `result`
   *  with a `completed` manifest). Only present it as "running" while the TASK itself is
   *  running — see {@link journalTally}. */
  running: number;
  /** Every agent in spawn order (id + done), for the in-flight list and drill-in. */
  agents: WorkflowJournalAgent[];
  /** Set when the journal EXISTS but could not be read. The numbers above are then the last
   *  known ones and MUST NOT be shown as live — a stale readout presented as fresh is the
   *  silent failure this field exists to prevent. */
  error: string | null;
}

const EMPTY_AGENTS: WorkflowJournalAgent[] = [];
export const EMPTY_JOURNAL: WfJournalView = {
  started: 0,
  done: 0,
  running: 0,
  agents: EMPTY_AGENTS,
  error: null,
};

/** What a surface shows instead of counts once the journal can no longer be read. Shared so
 *  the bar, the card and the modal say the same thing. */
export const JOURNAL_UNAVAILABLE = "progress unavailable";

/** Shape a raw journal into the view (adds the derived in-flight count). `null` — the normal
 *  state before the CLI writes the journal — collapses to the shared empty view, so a surface
 *  never has to distinguish "no journal yet" from "no agents yet": both mean "nothing to show". */
export function toJournalView(journal: WorkflowJournal | null | undefined): WfJournalView {
  if (!journal) return EMPTY_JOURNAL;
  return {
    started: journal.started,
    done: journal.done,
    running: Math.max(0, journal.started - journal.done),
    agents: journal.agents,
    error: null,
  };
}

/** Agents still in flight, in spawn order — the "who is working right now" list. */
export function inFlightAgents(view: WfJournalView): WorkflowJournalAgent[] {
  return view.agents.filter((a) => !a.done);
}

/**
 * The one-line tally every pinned surface shows, so the pinned bar and the inline card word it
 * identically. `null` before the run has an agent — there is nothing to count yet, and "0/0"
 * would read as a stalled run rather than a starting one.
 *
 * `running` is the TASK's own status, and it gates the "N running" half: an unfinished journal
 * entry only means "an agent is working" while the run is still going. Once it has settled, the
 * same number means "the CLI never wrote that agent's result" — printing "38 running" next to a
 * completed dot (a real case on disk) states something false about a run that is over.
 */
export function journalTally(view: WfJournalView, running: boolean): string | null {
  if (view.error) return JOURNAL_UNAVAILABLE;
  if (view.started === 0) return null;
  const inFlight = running && view.running > 0 ? `${view.running} running · ` : "";
  return `${inFlight}${view.done}/${view.started} done`;
}

/** Whether `a` is at least as far along as `b`. Journal counters only ever grow within a run
 *  (agents are appended, never removed), so "further along" is a sound proxy for "fresher" —
 *  which a timestamp would give us but the journal does not carry. */
function atLeastAsAdvanced(a: WfJournalView, b: WfJournalView): boolean {
  return a.started > b.started || (a.started === b.started && a.done >= b.done);
}

/**
 * Which journal a surface should believe, given a PUSHED snapshot (from the watcher) and a
 * one-shot DISK read (from the modal's own fetch).
 *
 * Neither source is reliably the fresher one:
 *  - The push wins during the run — the watcher re-reads on every append.
 *  - But the watch is torn down the moment the task settles, so afterwards it is frozen.
 *  - And the disk read is NOT "what we just read": it is the last read that SUCCEEDED, which
 *    for a modal opened early in a run is its open-time snapshot (possibly from before the
 *    journal even existed). A binary "settled → believe the disk" flip therefore made the
 *    modal jump BACKWARDS at the exact moment the run ended — down to "report not found" when
 *    the open-time read predated the journal.
 *
 * So: prefer the push while the run lives, and once it has settled prefer whichever snapshot is
 * further along, rather than trusting either source's freshness by position. An error flag wins
 * over a clean-but-empty view, so a read failure is never masked by a source that knows nothing.
 */
export function pickJournal(
  running: boolean,
  pushed: WfJournalView | undefined,
  disk: WfJournalView | null,
): WfJournalView {
  const hasPushed = !!pushed && (pushed.started > 0 || !!pushed.error);
  const hasDisk = !!disk && (disk.started > 0 || !!disk.error);
  if (!hasPushed) return disk ?? pushed ?? EMPTY_JOURNAL;
  if (!hasDisk) return pushed!;
  // A successful read beats a flagged one: the flag says "the watcher could not read it", and a
  // fresh successful read is proof that it can be read now.
  if (pushed!.error && !disk!.error) return disk!;
  if (disk!.error && !pushed!.error) return pushed!;
  if (running) return pushed!;
  return atLeastAsAdvanced(disk!, pushed!) ? disk! : pushed!;
}

/** Field-wise equality, so a re-emitted identical snapshot is a no-op instead of a re-render
 *  of every subscribed surface (the watcher already gates on change, but Tauri delivery is
 *  at-least-once). */
function viewEqual(a: WfJournalView, b: WfJournalView): boolean {
  if (
    a.started !== b.started ||
    a.done !== b.done ||
    a.error !== b.error ||
    a.agents.length !== b.agents.length
  ) {
    return false;
  }
  for (let i = 0; i < a.agents.length; i++) {
    if (a.agents[i].agentId !== b.agents[i].agentId || a.agents[i].done !== b.agents[i].done) {
      return false;
    }
  }
  return true;
}

interface State {
  /** convId → (run_id → live progress). */
  runs: Record<string, Record<string, WfJournalView>>;
  /** Apply a watcher snapshot for one run (clears any previous read error). */
  apply: (session: string, runId: string, journal: WorkflowJournal | null) => void;
  /** Mark a run's progress as UNREADABLE, keeping the last known numbers but flagging them so
   *  no surface renders them as live. */
  markError: (session: string, runId: string, message: string) => void;
  /** Forget a conversation's runs (its conversation was deleted). */
  drop: (session: string) => void;
  /** Forget everything (wipe-all). */
  clear: () => void;
}

export const useWorkflowJournalStore = create<State>((set) => ({
  runs: {},

  apply: (session, runId, journal) =>
    set((s) => {
      const next = toJournalView(journal);
      const cur = s.runs[session] ?? {};
      const prev = cur[runId];
      // An empty snapshot for a run we know nothing about carries no information — storing it
      // would churn subscribers for a run that hasn't produced an agent yet.
      if (!prev && next === EMPTY_JOURNAL) return s;
      if (prev && viewEqual(prev, next)) return s;
      return { runs: { ...s.runs, [session]: { ...cur, [runId]: next } } };
    }),

  markError: (session, runId, message) =>
    set((s) => {
      const cur = s.runs[session] ?? {};
      // Keep whatever numbers we had (they are the last thing that WAS true) and flag them.
      // A run we never read at all still gets an entry, so the surface can say "unavailable"
      // rather than render nothing and look like a run with no agents.
      const prev = cur[runId] ?? EMPTY_JOURNAL;
      if (prev.error === message) return s;
      return {
        runs: { ...s.runs, [session]: { ...cur, [runId]: { ...prev, error: message } } },
      };
    }),

  drop: (session) =>
    set((s) => {
      if (!s.runs[session]) return s;
      const runs = { ...s.runs };
      delete runs[session];
      return { runs };
    }),

  clear: () => set({ runs: {} }),
}));

/** One run's live progress (stable empty fallback when nothing has been read yet). */
export const useWorkflowJournal = (session: string, runId: string | null): WfJournalView =>
  useWorkflowJournalStore(
    useShallow((s) => (runId ? s.runs[session]?.[runId] ?? EMPTY_JOURNAL : EMPTY_JOURNAL)),
  );
