import { describe, expect, it } from "vitest";
import { MIN_CONVERSATION_PANE_PX } from "./composerLayout";
import { SIDE_PANEL_PX, SIDE_REGION_MIN_PX, sidePanelDocks } from "./sidePanelLayout";

describe("sidePanelDocks", () => {
  const alone = MIN_CONVERSATION_PANE_PX + SIDE_PANEL_PX;
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
