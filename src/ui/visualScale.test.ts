import { describe, expect, it } from "vitest";
import { verticalScaleOf } from "./visualScale";

describe("verticalScaleOf (measuring under the Flight Deck modal's opening zoom)", () => {
  it("reports the scale an ancestor transform is painting at", () => {
    // Panel laid out 820 tall, painted at a card's 240 while the zoom plays.
    expect(verticalScaleOf(240, 820)).toBeCloseTo(0.2927, 4);
    expect(verticalScaleOf(410, 820)).toBe(0.5);
  });

  it("recovers the layout figure when a visual measurement is divided by it", () => {
    const layout = 820;
    const painted = 240.12;
    expect(painted / verticalScaleOf(painted, layout)).toBeCloseTo(layout, 6);
  });

  it("projects a layout constant into visual space when multiplied by it", () => {
    // The minimap's reading line: 96 layout px must be compared against visual rects.
    expect(96 * verticalScaleOf(240, 820)).toBeCloseTo(28.1, 1);
  });

  it("snaps to exactly 1 when nothing is scaling — offsetHeight is integer-rounded", () => {
    // A rect of 810.4px against an offsetHeight of 810 must NOT nudge the untransformed case.
    expect(verticalScaleOf(810.4, 810)).toBe(1);
    expect(verticalScaleOf(809.6, 810)).toBe(1);
    expect(verticalScaleOf(820, 820)).toBe(1);
  });

  it("falls back to 1 rather than dividing by nonsense", () => {
    expect(verticalScaleOf(240, 0)).toBe(1); // display:none / not laid out yet
    expect(verticalScaleOf(0, 820)).toBe(1);
    expect(verticalScaleOf(Number.NaN, 820)).toBe(1);
    expect(verticalScaleOf(240, Number.NaN)).toBe(1);
    expect(verticalScaleOf(240, -10)).toBe(1);
  });
});
