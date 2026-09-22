import { describe, expect, it } from "vitest";
import { rowTiming, type RowClock } from "./rowTiming";
import type { AgentStatus } from "./status";

const clock = (p: Partial<RowClock> = {}): RowClock => ({
  turnStartedAt: null,
  lastTurnStartedAt: null,
  lastTurnEndedAt: null,
  awaitingSince: null,
  backgroundSince: null,
  ...p,
});

const RUNNING: AgentStatus = { kind: "running", activity: null };
const REVIEW: AgentStatus = { kind: "review" };
const ERROR: AgentStatus = { kind: "error", message: "boom" };
const QUESTION: AgentStatus = { kind: "needInput", via: "openQuestion", prompt: null };
const FORM: AgentStatus = { kind: "needInput", via: "questionnaire", prompt: null };
const PERMISSION: AgentStatus = { kind: "needIntervention", tool: "Bash" };
const BACKGROUNDING: AgentStatus = { kind: "backgrounding", count: 2 };

describe("rowTiming", () => {
  it("runs while the turn is in flight", () => {
    expect(rowTiming(RUNNING, clock({ turnStartedAt: 1000, lastTurnStartedAt: 1000 }))).toEqual({
      mode: "live",
      startedAt: 1000,
    });
  });

  it("counts background work from the WORK's own start, not from a turn", () => {
    expect(
      rowTiming(
        BACKGROUNDING,
        clock({ backgroundSince: 1000, lastTurnStartedAt: 400_000, lastTurnEndedAt: 405_000 }),
      ),
    ).toEqual({ mode: "live", startedAt: 1000 });
  });

  it("falls back to the last turn's start when the work has no stamp", () => {
    expect(
      rowTiming(BACKGROUNDING, clock({ lastTurnStartedAt: 1000, lastTurnEndedAt: 5000 })),
    ).toEqual({ mode: "live", startedAt: 1000 });
  });

  it("freezes a settled state on how long its turn took", () => {
    const c = clock({ lastTurnStartedAt: 1000, lastTurnEndedAt: 253_000 });
    expect(rowTiming(REVIEW, c)).toEqual({ mode: "paused", elapsedMs: 252_000 });
    expect(rowTiming(ERROR, c)).toEqual({ mode: "paused", elapsedMs: 252_000 });
    expect(rowTiming(QUESTION, c)).toEqual({ mode: "paused", elapsedMs: 252_000 });
  });

  it("freezes a blocked agent at the moment it asked, not at the turn's end", () => {
    const c = clock({ turnStartedAt: 1000, lastTurnStartedAt: 1000, awaitingSince: 9000 });
    expect(rowTiming(PERMISSION, c)).toEqual({ mode: "paused", elapsedMs: 8000 });
    expect(rowTiming(FORM, c)).toEqual({ mode: "paused", elapsedMs: 8000 });
  });

  it("shows nothing for the two calm states", () => {
    const c = clock({ lastTurnStartedAt: 1000, lastTurnEndedAt: 5000 });
    expect(rowTiming({ kind: "idle" }, c)).toEqual({ mode: "none" });
    expect(rowTiming({ kind: "off" }, c)).toEqual({ mode: "none" });
  });

  it("freezes a detached agent's question on the turn that launched it, once that turn ended", () => {
    // A background sub-agent asks for a permission AFTER its turn finished, so
    // `turnStartedAt` is already cleared: the row must keep its line, not drop it.
    expect(
      rowTiming(PERMISSION, clock({ lastTurnStartedAt: 1000, awaitingSince: 9000 })),
    ).toEqual({ mode: "paused", elapsedMs: 8000 });
  });

  it("keeps the frozen line without a time when nothing was measured", () => {
    // A conversation restored from disk: the state still reads the same shape.
    expect(rowTiming(REVIEW, undefined)).toEqual({ mode: "paused", elapsedMs: null });
    expect(rowTiming(REVIEW, clock())).toEqual({ mode: "paused", elapsedMs: null });
    expect(rowTiming(PERMISSION, clock({ turnStartedAt: 1000 }))).toEqual({
      mode: "paused",
      elapsedMs: null,
    });
    // A running row with no start has nothing to tick: no line at all.
    expect(rowTiming(RUNNING, clock())).toEqual({ mode: "none" });
    // Calm states stay a single line even with no clock.
    expect(rowTiming({ kind: "idle" }, undefined)).toEqual({ mode: "none" });
  });

  it("ignores a span that ends before it starts (clock skew)", () => {
    expect(rowTiming(REVIEW, clock({ lastTurnStartedAt: 5000, lastTurnEndedAt: 1000 }))).toEqual({
      mode: "paused",
      elapsedMs: null,
    });
  });
});
