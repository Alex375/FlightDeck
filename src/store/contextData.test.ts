import { describe, it, expect } from "vitest";
import { contextFill, fmtTokens } from "./contextData";

describe("fmtTokens", () => {
  it("renders raw counts below 1k", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(42)).toBe("42");
    expect(fmtTokens(999)).toBe("999");
  });

  it("renders thousands as k — integer with no decimal, otherwise one decimal", () => {
    expect(fmtTokens(1_000)).toBe("1k");
    expect(fmtTokens(29_756)).toBe("29.8k");
    expect(fmtTokens(200_000)).toBe("200k");
    expect(fmtTokens(999_949)).toBe("999.9k");
  });

  it("rounds up to '1M' just under the boundary instead of '1000.0k'", () => {
    // 999_950 / 1000 = 999.95 → the guard kicks in.
    expect(fmtTokens(999_950)).toBe("1M");
    expect(fmtTokens(999_999)).toBe("1M");
  });

  it("renders millions as M — integer with no decimal, otherwise one decimal", () => {
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
    expect(fmtTokens(2_000_000)).toBe("2M");
  });
});

describe("contextFill", () => {
  it("reports a real fill once both figures are known", () => {
    expect(contextFill(29_756, 200_000)).toEqual({
      pct: 15,
      used: "29.8k",
      max: "200k",
      usedKnown: true,
      windowKnown: true,
    });
  });

  it("clamps a fill that exceeds the window", () => {
    expect(contextFill(250_000, 200_000).pct).toBe(100);
  });

  it("keeps the token count but withholds the fill while the window is unknown", () => {
    // The state during a conversation's FIRST turn (and after a reload): the root
    // `message_start` already reported the prompt size, but only the end-of-turn
    // `result` carries the window. The popover must stay openable and show a real
    // "29.8k tokens" — never a 0 % that would read as an empty context.
    expect(contextFill(29_756, null)).toEqual({
      pct: 0,
      used: "29.8k",
      max: "—",
      usedKnown: true,
      windowKnown: false,
    });
  });

  it("treats a zero window as unknown, never as a division", () => {
    expect(contextFill(29_756, 0).windowKnown).toBe(false);
    expect(contextFill(29_756, 0).pct).toBe(0);
  });

  it("reports nothing known before the first model call", () => {
    expect(contextFill(null, null)).toEqual({
      pct: 0,
      used: "—",
      max: "—",
      usedKnown: false,
      windowKnown: false,
    });
  });

  it("never claims a window without a token count", () => {
    // A window with no usage is not a measurable fill — both flags stay false.
    expect(contextFill(null, 200_000)).toMatchObject({ usedKnown: false, windowKnown: false });
  });
});
