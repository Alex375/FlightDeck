import { describe, expect, it } from "vitest";
import { dockZoneAt, exceedsDragThreshold } from "./dockDrag";

// An area that is NOT at the origin and NOT square: an offset bug and an axis mix-up both
// show up. Right band starts at x = 700, bottom band at y = 350.
const AREA = { left: 100, top: 50, width: 1000, height: 500 };

describe("which drop zone the pointer is over", () => {
  it("answers the right column in the right band", () => {
    expect(dockZoneAt(AREA, 800, 100)).toBe("right");
    expect(dockZoneAt(AREA, 1099, 349)).toBe("right");
  });

  it("answers the bottom band in the bottom band", () => {
    expect(dockZoneAt(AREA, 200, 500)).toBe("bottom");
    expect(dockZoneAt(AREA, 699, 549)).toBe("bottom");
  });

  it("answers nothing in the neutral middle — releasing there cancels", () => {
    expect(dockZoneAt(AREA, 600, 300)).toBeNull();
    // Just short of each band.
    expect(dockZoneAt(AREA, 699, 349)).toBeNull();
  });

  it("gives the overlapping corner to the zone the pointer has entered deeper", () => {
    // Deep into the bottom band (95%), barely into the right one (12.5%).
    expect(dockZoneAt(AREA, 750, 540)).toBe("bottom");
    // The mirror image: deep on the right, barely at the bottom.
    expect(dockZoneAt(AREA, 1080, 360)).toBe("right");
    // The corner's diagonal — equal depth in both — resolves to "right", by documented
    // convention, so the answer never depends on floating-point luck.
    expect(dockZoneAt(AREA, 900, 450)).toBe("right");
    expect(dockZoneAt(AREA, 1100, 550)).toBe("right");
  });

  it("answers nothing outside the area, on every side", () => {
    expect(dockZoneAt(AREA, 99, 300)).toBeNull();
    expect(dockZoneAt(AREA, 1101, 300)).toBeNull();
    expect(dockZoneAt(AREA, 600, 49)).toBeNull();
    expect(dockZoneAt(AREA, 600, 551)).toBeNull();
    // Outside on the axis that is NOT the zone's own: still outside.
    expect(dockZoneAt(AREA, 1200, 540)).toBeNull();
  });

  it("answers nothing for a degenerate area — a panel with no box has no zones", () => {
    expect(dockZoneAt({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBeNull();
    expect(dockZoneAt({ left: 100, top: 50, width: 1000, height: 0 }, 900, 50)).toBeNull();
    expect(dockZoneAt({ left: 100, top: 50, width: 0, height: 500 }, 100, 500)).toBeNull();
    expect(dockZoneAt({ left: 0, top: 0, width: -10, height: -10 }, 0, 0)).toBeNull();
  });
});

describe("the click / drag threshold", () => {
  it("keeps a press that barely moved a click", () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(5, 0)).toBe(false);
    expect(exceedsDragThreshold(-4, 4)).toBe(false);
  });

  it("turns a press that travelled 6px — on any heading — into a drag", () => {
    expect(exceedsDragThreshold(6, 0)).toBe(true);
    expect(exceedsDragThreshold(0, -6)).toBe(true);
    expect(exceedsDragThreshold(5, 5)).toBe(true);
  });
});
