import { describe, expect, it, beforeEach } from "vitest";
import {
  EMPTY_JOURNAL,
  inFlightAgents,
  JOURNAL_UNAVAILABLE,
  journalTally,
  peekStatus,
  pickJournal,
  progressText,
  toJournalView,
  useWorkflowJournalStore,
} from "./workflowJournal";
import type { WorkflowJournalAgent } from "../ipc/client";

const ag = (agentId: string, done: boolean, extra: Partial<WorkflowJournalAgent> = {}): WorkflowJournalAgent => ({
  key: `v2:${agentId}`,
  agentId,
  label: null,
  phase: null,
  done,
  failed: false,
  lastStarted: null,
  ...extra,
});

describe("toJournalView", () => {
  it("derives the in-flight count and collapses a missing journal", () => {
    const view = toJournalView({
      started: 5,
      done: 2,
      failed: 0,
      namesAgents: false,
      agents: [
        ag("a", true),
        ag("b", false),
      ],
    });
    expect(view.running).toBe(3);
    expect(view.started).toBe(5);
    // "Not written yet" and "no agents" both mean "nothing to show" — same stable object, so
    // a subscriber isn't re-rendered by the difference.
    expect(toJournalView(null)).toBe(EMPTY_JOURNAL);
    expect(toJournalView(undefined)).toBe(EMPTY_JOURNAL);
  });

  it("never reports a negative in-flight count", () => {
    // Defensive: the two counters come from the same read, but a shape change upstream must
    // degrade to 0 rather than render "-1 running".
    expect(toJournalView({ started: 1, done: 4, failed: 0, namesAgents: false, agents: [] }).running).toBe(0);
  });
});

describe("inFlightAgents", () => {
  it("keeps only the unfinished agents, in spawn order", () => {
    const view = toJournalView({
      started: 3,
      done: 1,
      failed: 0,
      namesAgents: false,
      agents: [
        ag("first", false),
        ag("second", true),
        ag("third", false),
      ],
    });
    expect(inFlightAgents(view).map((a) => a.agentId)).toEqual(["first", "third"]);
  });
});

describe("journalTally", () => {
  const view = (started: number, done: number) => toJournalView({ started, done, failed: 0, namesAgents: false, agents: [] });

  it("words the running fleet, and says nothing before the first agent", () => {
    expect(journalTally(view(5, 2), true)).toBe("3 running · 2/5 done");
    // Nothing in flight: drop the "running" half rather than print a "0 running".
    expect(journalTally(view(5, 5), true)).toBe("5/5 done");
    // A launched-but-agentless run is STARTING, not stalled — "0/0 done" would say the latter.
    expect(journalTally(EMPTY_JOURNAL, true)).toBeNull();
  });

  it("never claims agents are running once the run has settled", () => {
    // The CLI does not guarantee a `result` line per agent — a real run on disk ends with
    // 38 started / 0 result and a "completed" manifest. On a settled run the unclosed entries
    // mean "never closed", not "still working", so the live wording must not appear — and,
    // since they may well have finished, they are not called unfinished either: "no result".
    expect(journalTally(view(38, 0), false)).toBe("0/38 done · 38 no result");
    expect(journalTally(view(5, 2), false)).toBe("2/5 done · 3 no result");
  });

  it("says the progress is unavailable rather than showing stale numbers", () => {
    const stale = { ...view(5, 2), error: "permission denied" };
    expect(journalTally(stale, true)).toBe(JOURNAL_UNAVAILABLE);
    expect(journalTally(stale, false)).toBe(JOURNAL_UNAVAILABLE);
  });
});

describe("pickJournal", () => {
  const pushed = toJournalView({ started: 9, done: 8, failed: 0, namesAgents: false, agents: [] });
  const disk = toJournalView({ started: 9, done: 9, failed: 0, namesAgents: false, agents: [] });

  it("believes the pushed snapshot while the run is watched", () => {
    // Mid-run the watcher re-reads on every append; the modal's one-shot read is from open time.
    expect(pickJournal(true, pushed, disk)).toBe(pushed);
  });

  it("believes the further-along disk read once the run has settled", () => {
    // The watch is torn down when the task settles, so the pushed snapshot is frozen — while
    // the disk read has the closing lines. Preferring the push here made the modal contradict
    // data it already held ("8/9 agents" on a run whose journal says 9/9).
    expect(pickJournal(false, pushed, disk)).toBe(disk);
  });

  it("never regresses to an OLDER disk snapshot at the moment the run settles", () => {
    // The disk read is NOT "what we just read": it is the last read that SUCCEEDED — for a
    // modal opened early in a run, its open-time snapshot, which the tick effect stops
    // refreshing once the script's phases are loaded. A binary "settled → believe the disk"
    // flip therefore jumped BACKWARDS exactly when the run ended.
    const openTime = toJournalView({ started: 2, done: 1, failed: 0, namesAgents: false, agents: [] });
    expect(pickJournal(false, pushed, openTime)).toBe(pushed);
    // Worst case: the modal was opened before the journal existed, so the disk read is empty.
    // That must NOT win, or a run that just completed renders as "report not found".
    expect(pickJournal(false, pushed, EMPTY_JOURNAL)).toBe(pushed);
  });

  it("never swaps a flagged push for an OLDER disk read while the run lives", () => {
    // The modal's disk read is its open-time snapshot. Shown as live it would freeze (or rewind)
    // the view; the flagged push makes the surface say "unavailable" instead.
    const flagged = { ...toJournalView({ started: 9, done: 8, failed: 0, namesAgents: false, agents: [] }), error: "io" };
    const openTime = toJournalView({ started: 4, done: 2, failed: 0, namesAgents: false, agents: [] });
    expect(pickJournal(true, flagged, openTime)).toBe(flagged);
    // Once the run is over, a readable snapshot beats a flag (the run won't move any more).
    expect(pickJournal(false, flagged, openTime)).toBe(openTime);
  });

  it("lets a successful read override a flagged one, in both directions", () => {
    const flagged = { ...pushed, error: "permission denied" };
    // A fresh successful read proves the journal is readable again — believe it.
    expect(pickJournal(true, flagged, disk)).toBe(disk);
    // And the reverse: a failed disk read must not bury a good pushed snapshot.
    expect(pickJournal(false, pushed, { ...disk, error: "boom" })).toBe(pushed);
  });

  it("surfaces an error even when nothing was ever read successfully", () => {
    // `markError` on a never-read run leaves started === 0; that entry must still win over an
    // empty disk read, or the failure is silently swallowed by a source that knows nothing.
    const errored = { ...EMPTY_JOURNAL, error: "I/O error" };
    expect(pickJournal(true, errored, null)).toBe(errored);
    expect(pickJournal(false, errored, EMPTY_JOURNAL)).toBe(errored);
  });

  it("falls back sanely when a source is missing", () => {
    expect(pickJournal(false, pushed, null)).toBe(pushed);
    expect(pickJournal(true, undefined, disk)).toBe(disk);
    expect(pickJournal(true, EMPTY_JOURNAL, null)).toBe(EMPTY_JOURNAL);
    expect(pickJournal(false, undefined, null)).toBe(EMPTY_JOURNAL);
  });

  it("words progress ONE way, failures always named and never folded into the ratio", () => {
    expect(progressText(3, 5, 0)).toBe("3/5");
    expect(progressText(3, 5, 2)).toBe("3/5 · 2 failed");
    expect(progressText(3, 5, 2, "agents")).toBe("3/5 agents · 2 failed");
    // The view's `delivered` is what every surface feeds it: settled minus failed, never < 0.
    expect(toJournalView({ started: 5, done: 4, failed: 1, namesAgents: false, agents: [] }).delivered).toBe(3);
    expect(toJournalView({ started: 1, done: 0, failed: 2, namesAgents: false, agents: [] }).delivered).toBe(0);
  });

  it("names, once the run is over, the agents the journal never closed", () => {
    // A kill writes no line for the agents it interrupts: neither delivered nor failed as far as
    // the journal knows, they would otherwise be in none of the tally's numbers.
    const v = toJournalView({ started: 5, done: 3, failed: 1, namesAgents: true, agents: [] });
    expect(journalTally(v, true)).toBe("2 running · 2/5 done · 1 failed");
    expect(journalTally(v, false)).toBe("2/5 done · 1 failed · 2 no result");
    expect(progressText(2, 5, 1, "agents", 2)).toBe("2/5 agents · 1 failed · 2 no result");
  });

  it("keeps failed agents out of \"done\" and names them", () => {
    // 2 running, 2 delivered, 1 failed: the failure has settled (not running) but did not deliver.
    const v = toJournalView({ started: 5, done: 3, failed: 1, namesAgents: false, agents: [] });
    expect(v.running).toBe(2);
    expect(journalTally(v, true)).toBe("2 running · 2/5 done · 1 failed");
    expect(journalTally(toJournalView({ started: 5, done: 5, failed: 2, namesAgents: false, agents: [] }), false)).toBe(
      "3/5 done · 2 failed",
    );
  });
});

describe("peekStatus", () => {
  const v = (started: number, done: number, failed: number) =>
    toJournalView({ started, done, failed, namesAgents: false, agents: [] });

  it("says what is happening now", () => {
    expect(peekStatus(EMPTY_JOURNAL)).toEqual({ text: "starting…", failed: null });
    expect(peekStatus(v(5, 3, 0))).toEqual({ text: "2 agents running", failed: null });
    expect(peekStatus(v(5, 4, 0))).toEqual({ text: "1 agent running", failed: null });
    expect(peekStatus(v(5, 5, 0))).toEqual({ text: "between steps…", failed: null });
  });

  it("names the failures — the card's count leaves them out", () => {
    // Running alongside failures: both parts.
    expect(peekStatus(v(5, 3, 1))).toEqual({ text: "2 agents running", failed: "1 failed" });
    // Everything settled, some failed: the failure IS the news, not "between steps…" (a run
    // whose agents all failed before starting used to read "0/5 agents · between steps…").
    expect(peekStatus(v(5, 5, 3))).toEqual({ text: null, failed: "3 failed" });
    expect(peekStatus(v(5, 5, 5))).toEqual({ text: null, failed: "5 failed" });
  });

  it("states an unreadable journal instead of stale numbers", () => {
    expect(peekStatus({ ...v(5, 5, 3), error: "boom" })).toEqual({ text: JOURNAL_UNAVAILABLE, failed: null });
  });
});

describe("useWorkflowJournalStore", () => {
  beforeEach(() => useWorkflowJournalStore.getState().clear());

  it("stores a snapshot per conversation and run", () => {
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 2, done: 1, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_a"].running).toBe(1);
  });

  it("is a no-op on an identical re-delivery (Tauri delivers at least once)", () => {
    const { apply } = useWorkflowJournalStore.getState();
    const journal = { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("x", false)] };
    apply("conv", "wf_a", journal);
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { ...journal, agents: [ag("x", false)] });
    expect(useWorkflowJournalStore.getState().runs).toBe(first);
  });

  it("re-renders when a retry moves an agent to a new attempt", () => {
    // Same call (key), new agent id: the transcript to read changed, so subscribers must hear it.
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("try1", false, { key: "v2:k" })] });
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("try2", false, { key: "v2:k" })] });
    expect(useWorkflowJournalStore.getState().runs).not.toBe(first);
  });

  it("re-renders when only the journal's naming flag or an agent's recency changes", () => {
    // Both drive what the view shows (the exact path; the current phase), so an otherwise
    // identical snapshot must still reach subscribers.
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: true, agents: [ag("x", false)] });
    const second = useWorkflowJournalStore.getState().runs;
    expect(second).not.toBe(first);
    apply("conv", "wf_a", {
      started: 1,
      done: 0,
      failed: 0,
      namesAgents: true,
      agents: [ag("x", false, { lastStarted: 7 })],
    });
    expect(useWorkflowJournalStore.getState().runs).not.toBe(second);
  });

  it("re-renders when an agent's name or failure lands", () => {
    // label/phase/failed are part of what a surface shows — an equal-by-id-and-done snapshot
    // that differs there must still reach subscribers.
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", {
      started: 1,
      done: 0,
      failed: 0,
      namesAgents: false,
      agents: [ag("x", false, { label: "review:tests", phase: "Review" })],
    });
    const second = useWorkflowJournalStore.getState().runs;
    expect(second).not.toBe(first);
    apply("conv", "wf_a", {
      started: 1,
      done: 1,
      failed: 1,
      namesAgents: false,
      agents: [ag("x", true, { label: "review:tests", phase: "Review", failed: true })],
    });
    expect(useWorkflowJournalStore.getState().runs).not.toBe(second);
  });

  it("re-renders when an agent actually finishes", () => {
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { started: 1, done: 1, failed: 0, namesAgents: false, agents: [ag("x", true)] });
    expect(useWorkflowJournalStore.getState().runs).not.toBe(first);
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_a"].running).toBe(0);
  });

  it("ignores an empty snapshot for an unknown run", () => {
    // The watcher emits before the CLI has created the journal; storing that would churn
    // every subscriber for a run that has produced nothing.
    useWorkflowJournalStore.getState().apply("conv", "wf_new", null);
    expect(useWorkflowJournalStore.getState().runs["conv"]).toBeUndefined();
  });

  it("flags an unreadable run without losing its last known numbers", () => {
    const { apply, markError } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 7, done: 3, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    markError("conv", "wf_a", "permission denied");
    const view = useWorkflowJournalStore.getState().runs["conv"]["wf_a"];
    // The numbers stay (they were true once) but are now flagged, so no surface renders them
    // as live — the watcher only re-emits on CHANGE, so a persistent IO failure produces ONE
    // event and the banner can be dismissed.
    expect(view).toMatchObject({ started: 7, done: 3, error: "permission denied" });
    expect(journalTally(view, true)).toBe(JOURNAL_UNAVAILABLE);
  });

  it("flags a run it never managed to read at all", () => {
    // Without an entry the surface would render nothing and read as "a run with no agents".
    useWorkflowJournalStore.getState().markError("conv", "wf_new", "I/O error");
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_new"].error).toBe("I/O error");
  });

  it("is a no-op on a repeated identical error", () => {
    const { markError } = useWorkflowJournalStore.getState();
    markError("conv", "wf_a", "boom");
    const first = useWorkflowJournalStore.getState().runs;
    markError("conv", "wf_a", "boom");
    expect(useWorkflowJournalStore.getState().runs).toBe(first);
  });

  it("clears the error as soon as a read succeeds again", () => {
    const { apply, markError } = useWorkflowJournalStore.getState();
    markError("conv", "wf_a", "transient");
    apply("conv", "wf_a", { started: 2, done: 1, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_a"].error).toBeNull();
  });

  it("drops a conversation's runs and clears everything", () => {
    const { apply, drop } = useWorkflowJournalStore.getState();
    apply("a", "wf_1", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("x", false)] });
    apply("b", "wf_2", { started: 1, done: 0, failed: 0, namesAgents: false, agents: [ag("y", false)] });
    drop("a");
    expect(useWorkflowJournalStore.getState().runs["a"]).toBeUndefined();
    expect(useWorkflowJournalStore.getState().runs["b"]).toBeDefined();
    useWorkflowJournalStore.getState().clear();
    expect(useWorkflowJournalStore.getState().runs).toEqual({});
  });
});
