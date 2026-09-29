import { describe, expect, it } from "vitest";
import {
  approach,
  estTokensPerSec,
  fmtClockMs,
  fmtSecs,
  gaugeFraction,
  latency,
  pushSample,
  STALLED_RATIO,
  streamGrowth,
  turnLoad,
} from "./telemetryLive";

describe("millisecond clocks", () => {
  it("reads a run to the millisecond", () => {
    expect(fmtClockMs(0)).toBe("0:00.000");
    expect(fmtClockMs(12_347)).toBe("0:12.347");
    expect(fmtClockMs(3_725_123)).toBe("1:02:05.123");
  });

  it("reads a call with the precision its length deserves", () => {
    expect(fmtSecs(142)).toBe("0.142s");
    expect(fmtSecs(12_314)).toBe("12.31s");
    expect(fmtSecs(62_400)).toBe("1:02.4");
  });
});

describe("approach (needles and smoothing)", () => {
  it("closes part of the gap each frame and never overshoots", () => {
    const v = approach(0, 100, 16, 120);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });

  it("is frame-rate independent: two half steps equal one full step", () => {
    const one = approach(0, 100, 32, 120);
    const two = approach(approach(0, 100, 16, 120), 100, 16, 120);
    expect(two).toBeCloseTo(one, 9);
  });

  it("lands on the target when there is no time constant", () => {
    expect(approach(3, 9, 16, 0)).toBe(9);
  });
});

describe("streamGrowth (the throughput signal)", () => {
  it("counts the characters each open bubble gained", () => {
    const first = streamGrowth(new Map(), [["a", 100]]);
    const { chars } = streamGrowth(first.next, [["a", 160]]);
    expect(chars).toBe(60);
  });

  it("does not count what was already written when the deck first sees a bubble", () => {
    // Opening the deck mid-answer: 900 characters already streamed are not a burst.
    expect(streamGrowth(new Map(), [["a", 900]]).chars).toBe(0);
  });

  it("reads a bubble that closes (its buffer folded away) as no growth, not a negative", () => {
    const { chars } = streamGrowth(new Map([["a", 500]]), [["a", 0]]);
    expect(chars).toBe(0);
  });

  it("sums a sub-agent streaming alongside the main thread", () => {
    const last = new Map([
      ["root", 10],
      ["sub", 5],
    ]);
    expect(
      streamGrowth(last, [
        ["root", 30],
        ["sub", 25],
      ]).chars,
    ).toBe(40);
  });

  it("forgets a bubble that is no longer open", () => {
    const { next } = streamGrowth(new Map([["gone", 50]]), [["a", 1]]);
    expect(next.has("gone")).toBe(false);
  });

  it("estimates tokens from characters, never negative", () => {
    expect(estTokensPerSec(400)).toBe(100);
    expect(estTokensPerSec(-5)).toBe(0);
  });
});

describe("latency (a running call against its kind)", () => {
  it("has no verdict before anything of that kind finished live", () => {
    expect(latency(5000, null)).toEqual({ level: "unknown", fill: 0 });
  });

  it("is ok under the median, slow above it, stalled past the stall ratio", () => {
    expect(latency(500, 1000).level).toBe("ok");
    expect(latency(1500, 1000).level).toBe("slow");
    expect(latency(1000 * STALLED_RATIO, 1000).level).toBe("stalled");
  });

  it("puts the median at a third of the bar and fills it on a stall", () => {
    expect(latency(1000, 1000).fill).toBeCloseTo(1 / STALLED_RATIO);
    expect(latency(10_000, 1000).fill).toBe(1);
  });
});

describe("turn load and gauge scale", () => {
  it("reads the current turn against the median turn — or nothing, honestly", () => {
    expect(turnLoad(30_000, 20_000)).toBe(1.5);
    expect(turnLoad(30_000, null)).toBeNull();
    expect(turnLoad(null, 20_000)).toBeNull();
  });

  it("clamps a reading to the dial", () => {
    expect(gaugeFraction(50, 200)).toBe(0.25);
    expect(gaugeFraction(900, 200)).toBe(1);
    expect(gaugeFraction(-3, 200)).toBe(0);
    expect(gaugeFraction(Number.NaN, 200)).toBe(0);
  });

  it("keeps the oscilloscope's ring at its size", () => {
    let s: number[] = [];
    for (let i = 0; i < 10; i++) s = pushSample(s, i, 4);
    expect(s).toEqual([6, 7, 8, 9]);
  });
});
