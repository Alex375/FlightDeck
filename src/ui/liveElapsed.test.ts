import { describe, expect, it } from "vitest";
import { FAST_TICK_MS, SLOW_TICK_MS, fmtFrozenElapsed, fmtLiveElapsed, liveElapsedPeriod } from "./liveElapsed";

describe("fmtLiveElapsed", () => {
  it("shows centiseconds under a minute", () => {
    expect(fmtLiveElapsed(0)).toBe("0.00s");
    expect(fmtLiveElapsed(7_420)).toBe("7.42s");
    expect(fmtLiveElapsed(7_429)).toBe("7.42s"); // floored, never rounded up
    expect(fmtLiveElapsed(12_050)).toBe("12.05s");
  });

  it("never shows 60.00s: the last sub-minute value floors to 59.99s", () => {
    expect(fmtLiveElapsed(59_999)).toBe("59.99s");
    expect(fmtLiveElapsed(60_000)).toBe("1m 00s");
  });

  it("switches to minutes + zero-padded seconds, then hours + minutes", () => {
    expect(fmtLiveElapsed(187_000)).toBe("3m 07s");
    expect(fmtLiveElapsed(3_599_999)).toBe("59m 59s");
    expect(fmtLiveElapsed(3_600_000)).toBe("1h 00m");
    expect(fmtLiveElapsed(3_720_000)).toBe("1h 02m");
    expect(fmtLiveElapsed(10 * 3_600_000 + 5 * 60_000)).toBe("10h 05m");
  });

  it("clamps a negative elapsed (clock skew) to zero", () => {
    expect(fmtLiveElapsed(-500)).toBe("0.00s");
  });
});

describe("fmtFrozenElapsed", () => {
  it("drops the centiseconds a stopped counter cannot animate", () => {
    expect(fmtFrozenElapsed(0)).toBe("0s");
    expect(fmtFrozenElapsed(7_420)).toBe("7s");
    expect(fmtFrozenElapsed(53_000)).toBe("53s");
    expect(fmtFrozenElapsed(59_400)).toBe("59s");
    expect(fmtFrozenElapsed(59_999)).toBe("59s"); // floored: never an impossible "60s"
  });

  it("matches the live format past a minute", () => {
    expect(fmtFrozenElapsed(252_000)).toBe("4m 12s");
    expect(fmtFrozenElapsed(3_720_000)).toBe("1h 02m");
  });
});

describe("liveElapsedPeriod", () => {
  it("ticks fast only while centiseconds are on screen", () => {
    expect(liveElapsedPeriod(0)).toBe(FAST_TICK_MS);
    expect(liveElapsedPeriod(59_999)).toBe(FAST_TICK_MS);
    expect(liveElapsedPeriod(60_000)).toBe(SLOW_TICK_MS);
  });
});
