import { describe, expect, it } from "vitest";
import { MIN_CONVERSATION_PANE_PX } from "./composerLayout";
import {
  clampSidePanelWidth,
  dockedSidePanelWidth,
  floatingSidePanelWidth,
  SIDE_PANEL_MAX_PX,
  SIDE_PANEL_MIN_PX,
  SIDE_PANEL_PX,
  SIDE_REGION_MIN_PX,
  sidePanelDocks,
} from "./sidePanelLayout";

describe("sidePanelDocks", () => {
  // The test is against the panel's FLOOR, not its current width: a window with room for a
  // narrow panel docks a narrow panel rather than floating a wide one over the thread.
  const alone = MIN_CONVERSATION_PANE_PX + SIDE_PANEL_MIN_PX;
  const withRegion = alone + SIDE_REGION_MIN_PX;

  it("docks when the conversation keeps its floor beside the panel", () => {
    expect(sidePanelDocks(alone, false)).toBe(true);
    expect(sidePanelDocks(alone + 400, false)).toBe(true);
  });

  it("floats when docking would squeeze the conversation below its floor", () => {
    expect(sidePanelDocks(alone - 1, false)).toBe(false);
  });

  it("reserves the side region's floor too while it is open", () => {
    // Wide enough for conversation + panel, but not for the editor/terminal region as well.
    expect(sidePanelDocks(alone + 100, true)).toBe(false);
    expect(sidePanelDocks(withRegion, true)).toBe(true);
    expect(sidePanelDocks(withRegion - 1, true)).toBe(false);
  });
});

describe("clampSidePanelWidth", () => {
  it("holds a dragged width inside the panel's own bounds", () => {
    expect(clampSidePanelWidth(420)).toBe(420);
    expect(clampSidePanelWidth(10)).toBe(SIDE_PANEL_MIN_PX);
    expect(clampSidePanelWidth(5000)).toBe(SIDE_PANEL_MAX_PX);
  });

  it("rounds, and falls back to the default for a value that is not a number", () => {
    expect(clampSidePanelWidth(420.6)).toBe(421);
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_PX);
    expect(clampSidePanelWidth(Number.POSITIVE_INFINITY)).toBe(SIDE_PANEL_PX);
  });
});

describe("dockedSidePanelWidth", () => {
  const roomy = MIN_CONVERSATION_PANE_PX + SIDE_PANEL_MAX_PX + 200;

  it("gives the width asked for when there is room for it", () => {
    expect(dockedSidePanelWidth(480, roomy, false)).toBe(480);
  });

  it("caps at the room left beside the conversation rather than crushing it", () => {
    // Exactly 400px past the conversation's floor: a 520 request renders at 400.
    const area = MIN_CONVERSATION_PANE_PX + 400;
    expect(dockedSidePanelWidth(520, area, false)).toBe(400);
  });

  it("counts the side region's floor when it is open", () => {
    const area = MIN_CONVERSATION_PANE_PX + SIDE_REGION_MIN_PX + 400;
    expect(dockedSidePanelWidth(520, area, true)).toBe(400);
    expect(dockedSidePanelWidth(520, area, false)).toBe(520);
  });

  it("never renders below the floor — below it the panel floats instead of docking", () => {
    const tooTight = MIN_CONVERSATION_PANE_PX + 40;
    expect(sidePanelDocks(tooTight, false)).toBe(false);
    expect(dockedSidePanelWidth(SIDE_PANEL_PX, tooTight, false)).toBe(SIDE_PANEL_MIN_PX);
  });
});

describe("floatingSidePanelWidth", () => {
  it("ignores the conversation's floor (it overlays rather than sharing the row)", () => {
    expect(floatingSidePanelWidth(480, MIN_CONVERSATION_PANE_PX + 40)).toBe(480);
  });

  it("still never hangs off the window", () => {
    expect(floatingSidePanelWidth(480, 300)).toBe(300);
  });
});
