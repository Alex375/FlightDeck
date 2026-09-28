import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_CLOCK,
  FOLLOW_UP_WINDOW_MS,
  liveRunStart,
  rowRunClock,
  runBusy,
  runEndAll,
  runFooterFor,
  runResult,
  runSend,
  runTask,
  settledRunMs,
  type RunClock,
} from "./runClock";

/** A plain prompt: sent at `at`, turn from `at + 100`, answered at `endAt`. */
function plainRun(clock: RunClock, at: number, resultId: string, endAt: number, modelMs: number | null = 1000) {
  let c = runSend(clock, at, false);
  c = runBusy(c, true, at + 100);
  c = runResult(c, resultId, endAt, modelMs);
  return runBusy(c, false, endAt);
}

describe("runClock", () => {
  it("times a plain prompt from the Enter to its answer", () => {
    const c = plainRun(EMPTY_RUN_CLOCK, 1000, "tr_1", 7000);
    expect(runFooterFor(c, "tr_1")).toEqual({
      mainMs: 6000,
      totalMs: 6000,
      backgroundSince: null,
      backgroundCount: 0,
      extended: false,
      modelMs: 1000,
    });
    expect(liveRunStart(c)).toBeNull();
  });

  // The sequence a live probe of claude 2.1.283 produced for ONE prompt launching a
  // background sub-agent and a background Bash: the main answer, then one follow-up
  // turn the CLI starts on its own per task that reports back (no user line on the wire).
  it("keeps ONE clock across the follow-up turns background work triggers", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "agent", true, 2900);
    c = runTask(c, "bash", true, 5000);
    c = runResult(c, "tr_1", 6900, 7900);
    c = runBusy(c, false, 6900);

    // Main agent answered, background still running: frozen main time + live counter.
    expect(runFooterFor(c, "tr_1")).toMatchObject({
      mainMs: 6900,
      totalMs: null,
      backgroundSince: 0,
      backgroundCount: 2,
    });

    // The sub-agent reports back → the CLI wakes the main agent: same run, same start.
    c = runTask(c, "agent", false, 8800);
    c = runBusy(c, true, 9500);
    expect(liveRunStart(c)).toBe(0);
    // During the follow-up the working indicator carries the live count, not the footer.
    expect(runFooterFor(c, "tr_1")).toMatchObject({ backgroundSince: null });
    c = runResult(c, "tr_2", 11400, 2500);
    c = runBusy(c, false, 11400);

    // The footer moved under the latest result; the earlier one shows nothing.
    expect(runFooterFor(c, "tr_1")).toBe("hidden");
    expect(runFooterFor(c, "tr_2")).toMatchObject({ mainMs: 6900, backgroundSince: 0, backgroundCount: 1 });

    // The Bash finishes → its follow-up turn still belongs to this run.
    c = runTask(c, "bash", false, 45000);
    c = runBusy(c, true, 45700);
    expect(liveRunStart(c)).toBe(0);
    c = runResult(c, "tr_3", 46400, 1300);
    c = runBusy(c, false, 46400);

    expect(runFooterFor(c, "tr_2")).toBe("hidden");
    expect(runFooterFor(c, "tr_3")).toEqual({
      mainMs: 6900,
      totalMs: 46400,
      backgroundSince: null,
      backgroundCount: 0,
      extended: true,
      modelMs: 7900 + 2500 + 1300,
    });
    expect(c.runs).toHaveLength(1);
  });

  it("marks a run whose background work outlived the answer as extended even with no follow-up", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 1000);
    c = runResult(c, "tr_1", 2000, 500);
    c = runBusy(c, false, 2000);
    c = runTask(c, "bash", false, 9000);
    expect(runFooterFor(c, "tr_1")).toMatchObject({ mainMs: 2000, totalMs: 9000, extended: true });
  });

  it("does not extend a run for a FOREGROUND sub-agent that finished within the turn", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "fg-agent", true, 1000);
    c = runTask(c, "fg-agent", false, 4000);
    c = runResult(c, "tr_1", 5000, 800);
    c = runBusy(c, false, 5000);
    expect(runFooterFor(c, "tr_1")).toMatchObject({ mainMs: 5000, totalMs: 5000, extended: false });
  });

  it("opens a new run for an autonomous turn long after a run that ended on its answer", () => {
    let c = plainRun(EMPTY_RUN_CLOCK, 0, "tr_1", 5000);
    // A scheduled wake-up, 20 minutes later: its own run, timed from its own start.
    c = runBusy(c, true, 1_200_000);
    expect(liveRunStart(c)).toBe(1_200_000);
    c = runResult(c, "tr_2", 1_203_000, 900);
    c = runBusy(c, false, 1_203_000);
    expect(runFooterFor(c, "tr_1")).toMatchObject({ mainMs: 5000, totalMs: 5000 });
    expect(runFooterFor(c, "tr_2")).toMatchObject({ mainMs: 3000, totalMs: 3000, extended: false });
  });

  it("joins a follow-up that races a task finishing mid-turn, within the window only", () => {
    const base = (() => {
      let c = runSend(EMPTY_RUN_CLOCK, 0, false);
      c = runBusy(c, true, 100);
      c = runTask(c, "bash", true, 500);
      c = runTask(c, "bash", false, 3000); // done while the main turn still runs
      c = runResult(c, "tr_1", 4000, 700);
      return runBusy(c, false, 4000);
    })();
    const joined = runBusy(base, true, 4000 + FOLLOW_UP_WINDOW_MS);
    expect(joined.runs).toHaveLength(1);
    expect(liveRunStart(joined)).toBe(0);
    const separate = runBusy(base, true, 4001 + FOLLOW_UP_WINDOW_MS);
    expect(separate.runs).toHaveLength(2);
  });

  it("keeps a message sent mid-turn inside the run in flight", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    expect(runSend(c, 3000, true)).toBe(c);
    // Busy by the clock's own account wins over a caller that thought it was idle.
    expect(runSend(c, 3000, false)).toBe(c);
  });

  it("keeps an earlier run alive on its own background work while a new prompt runs", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "old-bash", true, 1000);
    c = runResult(c, "tr_1", 2000, 400);
    c = runBusy(c, false, 2000);

    // A new prompt while the first run's Bash still runs.
    c = plainRun(c, 10_000, "tr_2", 14_000);
    expect(runFooterFor(c, "tr_2")).toMatchObject({ mainMs: 4000, totalMs: 4000, extended: false });
    expect(runFooterFor(c, "tr_1")).toMatchObject({ backgroundSince: 0, backgroundCount: 1 });

    // The first run ends when ITS work does.
    c = runTask(c, "old-bash", false, 30_000);
    expect(runFooterFor(c, "tr_1")).toMatchObject({ mainMs: 2000, totalMs: 30_000, extended: true });
  });

  it("reopens a run when one of its tasks restarts (a sub-agent woken again)", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "agent", true, 500);
    c = runResult(c, "tr_1", 1000, 300);
    c = runBusy(c, false, 1000);
    c = runTask(c, "agent", false, 5000);
    expect(c.runs[0].endedAt).toBe(5000);
    c = runTask(c, "agent", true, 6000);
    expect(c.runs[0].endedAt).toBeNull();
    expect(runFooterFor(c, "tr_1")).toMatchObject({ backgroundSince: 0, backgroundCount: 1 });
  });

  it("ends every run when the session goes away", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 500);
    c = runResult(c, "tr_1", 1000, 300);
    c = runBusy(c, false, 1000);
    c = runEndAll(c, 8000);
    expect(runFooterFor(c, "tr_1")).toMatchObject({ totalMs: 8000, backgroundSince: null });
    expect(liveRunStart(c)).toBeNull();
    expect(runEndAll(c, 9000)).toBe(c);
  });

  it("loses the run's model time once any of its turns reports none", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 500);
    c = runResult(c, "tr_1", 1000, null); // first turn of a resumed process
    c = runBusy(c, false, 1000);
    c = runTask(c, "bash", false, 2000);
    c = runBusy(c, true, 2100);
    c = runResult(c, "tr_2", 3000, 600);
    c = runBusy(c, false, 3000);
    expect(runFooterFor(c, "tr_2")).toMatchObject({ modelMs: null });
  });

  it("returns the SAME clock when a signal changes nothing (progress ticks re-render nothing)", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 500);
    expect(runTask(c, "bash", true, 600)).toBe(c);
    expect(runBusy(c, true, 700)).toBe(c);
    // A result already attached is not re-attached (at-least-once delivery).
    const r = runResult(c, "tr_1", 900, 100);
    expect(runResult(r, "tr_1", 950, 100)).toBe(r);
  });

  it("leaves results and tasks alone when no run exists", () => {
    expect(runResult(EMPTY_RUN_CLOCK, "tr_1", 1000, 100)).toBe(EMPTY_RUN_CLOCK);
    expect(runTask(EMPTY_RUN_CLOCK, "bash", true, 1000)).toBe(EMPTY_RUN_CLOCK);
    expect(runFooterFor(EMPTY_RUN_CLOCK, "tr_1")).toBeNull();
    expect(runFooterFor(undefined, "tr_1")).toBeNull();
  });

  it("reports the settled run's whole span, and nothing while it runs", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 500);
    c = runResult(c, "tr_1", 3000, 300);
    c = runBusy(c, false, 3000);
    expect(settledRunMs(c)).toBeNull();
    c = runTask(c, "bash", false, 20_000);
    c = runBusy(c, true, 20_500);
    c = runResult(c, "tr_2", 22_000, 400);
    c = runBusy(c, false, 22_000);
    expect(settledRunMs(c)).toBe(22_000);
    expect(settledRunMs(undefined)).toBeNull();
  });

  it("gives the sidebar row the run's times", () => {
    let c = runSend(EMPTY_RUN_CLOCK, 0, false);
    c = runBusy(c, true, 100);
    c = runTask(c, "bash", true, 500);
    c = runResult(c, "tr_1", 3000, 300);
    c = runBusy(c, false, 3000);
    expect(rowRunClock(c)).toEqual({
      runLiveSince: 0,
      runStartedAt: 0,
      runSettledAt: 3000,
      backgroundRunSince: 0,
    });
    c = runTask(c, "bash", false, 9000);
    expect(rowRunClock(c)).toEqual({
      runLiveSince: null,
      runStartedAt: 0,
      runSettledAt: 9000,
      backgroundRunSince: null,
    });
    expect(rowRunClock(undefined)).toEqual({
      runLiveSince: null,
      runStartedAt: null,
      runSettledAt: null,
      backgroundRunSince: null,
    });
  });
});
