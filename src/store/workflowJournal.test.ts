import { describe, expect, it, beforeEach } from "vitest";
import {
  EMPTY_JOURNAL,
  inFlightAgents,
  JOURNAL_UNAVAILABLE,
  journalTally,
  pickJournal,
  toJournalView,
  useWorkflowJournalStore,
} from "./workflowJournal";

describe("toJournalView", () => {
  it("derives the in-flight count and collapses a missing journal", () => {
    const view = toJournalView({
      started: 5,
      done: 2,
      agents: [
        { agentId: "a", done: true },
        { agentId: "b", done: false },
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
    expect(toJournalView({ started: 1, done: 4, agents: [] }).running).toBe(0);
  });
});

describe("inFlightAgents", () => {
  it("keeps only the unfinished agents, in spawn order", () => {
    const view = toJournalView({
      started: 3,
      done: 1,
      agents: [
        { agentId: "first", done: false },
        { agentId: "second", done: true },
        { agentId: "third", done: false },
      ],
    });
    expect(inFlightAgents(view).map((a) => a.agentId)).toEqual(["first", "third"]);
  });
});

describe("journalTally", () => {
  const view = (started: number, done: number) => toJournalView({ started, done, agents: [] });

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
    // mean "never closed", not "still working", so the live wording must not appear.
    expect(journalTally(view(38, 0), false)).toBe("0/38 done");
    expect(journalTally(view(5, 2), false)).toBe("2/5 done");
  });

  it("says the progress is unavailable rather than showing stale numbers", () => {
    const stale = { ...view(5, 2), error: "permission denied" };
    expect(journalTally(stale, true)).toBe(JOURNAL_UNAVAILABLE);
    expect(journalTally(stale, false)).toBe(JOURNAL_UNAVAILABLE);
  });
});

describe("pickJournal", () => {
  const pushed = toJournalView({ started: 9, done: 8, agents: [] });
  const disk = toJournalView({ started: 9, done: 9, agents: [] });

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
    const openTime = toJournalView({ started: 2, done: 1, agents: [] });
    expect(pickJournal(false, pushed, openTime)).toBe(pushed);
    // Worst case: the modal was opened before the journal existed, so the disk read is empty.
    // That must NOT win, or a run that just completed renders as "report not found".
    expect(pickJournal(false, pushed, EMPTY_JOURNAL)).toBe(pushed);
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
});

describe("useWorkflowJournalStore", () => {
  beforeEach(() => useWorkflowJournalStore.getState().clear());

  it("stores a snapshot per conversation and run", () => {
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 2, done: 1, agents: [{ agentId: "x", done: false }] });
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_a"].running).toBe(1);
  });

  it("is a no-op on an identical re-delivery (Tauri delivers at least once)", () => {
    const { apply } = useWorkflowJournalStore.getState();
    const journal = { started: 1, done: 0, agents: [{ agentId: "x", done: false }] };
    apply("conv", "wf_a", journal);
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { ...journal, agents: [{ agentId: "x", done: false }] });
    expect(useWorkflowJournalStore.getState().runs).toBe(first);
  });

  it("re-renders when an agent actually finishes", () => {
    const { apply } = useWorkflowJournalStore.getState();
    apply("conv", "wf_a", { started: 1, done: 0, agents: [{ agentId: "x", done: false }] });
    const first = useWorkflowJournalStore.getState().runs;
    apply("conv", "wf_a", { started: 1, done: 1, agents: [{ agentId: "x", done: true }] });
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
    apply("conv", "wf_a", { started: 7, done: 3, agents: [{ agentId: "x", done: false }] });
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
    apply("conv", "wf_a", { started: 2, done: 1, agents: [{ agentId: "x", done: false }] });
    expect(useWorkflowJournalStore.getState().runs["conv"]["wf_a"].error).toBeNull();
  });

  it("drops a conversation's runs and clears everything", () => {
    const { apply, drop } = useWorkflowJournalStore.getState();
    apply("a", "wf_1", { started: 1, done: 0, agents: [{ agentId: "x", done: false }] });
    apply("b", "wf_2", { started: 1, done: 0, agents: [{ agentId: "y", done: false }] });
    drop("a");
    expect(useWorkflowJournalStore.getState().runs["a"]).toBeUndefined();
    expect(useWorkflowJournalStore.getState().runs["b"]).toBeDefined();
    useWorkflowJournalStore.getState().clear();
    expect(useWorkflowJournalStore.getState().runs).toEqual({});
  });
});
