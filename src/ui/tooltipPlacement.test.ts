import { describe, expect, it } from "vitest";
import { tooltipPlacement } from "./tooltipPlacement";

const VP = { width: 1000, height: 800 };
const tip = { width: 120, height: 40 };
/** A trigger box, from its centre — the tooltip is centred on it. */
const at = (cx: number, top: number, h = 16, w = 14) => ({
  left: cx - w / 2,
  right: cx + w / 2,
  top,
  bottom: top + h,
});

describe("tooltipPlacement", () => {
  it("sits above the trigger, centred, when there is room", () => {
    const p = tooltipPlacement(at(500, 400), tip, VP);
    expect(p.side).toBe("top");
    expect(p.top).toBe(400 - 6 - 40);
    expect(p.left).toBe(500 - 60);
  });

  it("flips below only when it genuinely does not fit above", () => {
    expect(tooltipPlacement(at(500, 10), tip, VP).side).toBe("bottom");
    // Tighter above than below, but still room: it must NOT flip, or a tooltip would
    // jump sides as the window resizes.
    expect(tooltipPlacement(at(500, 300), tip, VP).side).toBe("top");
  });

  it("keeps a tooltip on a far-left trigger fully on screen", () => {
    // The sidebar case: centring would put it at -52.
    expect(tooltipPlacement(at(8, 400), tip, VP).left).toBe(6);
  });

  it("keeps a tooltip on a far-right trigger fully on screen", () => {
    const p = tooltipPlacement(at(996, 400), tip, VP);
    expect(p.left).toBe(VP.width - 120 - 6);
    expect(p.left + tip.width).toBeLessThanOrEqual(VP.width);
  });

  it("prefers the left edge when the tooltip is wider than the viewport", () => {
    const p = tooltipPlacement(at(50, 400), { width: 400, height: 40 }, { width: 200, height: 800 });
    expect(p.left).toBe(6);
  });
});
