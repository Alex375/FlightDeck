// The message minimap's pure rules: which bar lights up, where each bar sits, how thick it
// is drawn, and what a hover says. Kept out of the component so they are testable without
// a scroll container.
import { describe, it, expect } from "vitest";
import {
  activeAnchorId,
  dockMagnification,
  dockPushPx,
  hoverDelayMs,
  hoverRegime,
  isScrolledToBottom,
  tipStyle,
  markOffsetPx,
  minimapBlockHeightPx,
  minimapPitchPx,
  resolveMessageLabel,
} from "./MessageMinimap";
import { summaryKey } from "../../store/lastMessageSummary";

describe("activeAnchorId", () => {
  const anchors = [
    { id: "u1", top: -400 },
    { id: "u2", top: -50 },
    { id: "u3", top: 300 },
  ];

  it("is the LAST message whose top has crossed the reading line", () => {
    expect(activeAnchorId(anchors, 100)).toBe("u2");
  });

  it("is null before the first message has crossed (you are at the very top)", () => {
    expect(activeAnchorId([{ id: "u1", top: 500 }], 100)).toBeNull();
    expect(activeAnchorId([], 100)).toBeNull();
  });

  it("counts a message sitting exactly ON the line as reached", () => {
    expect(activeAnchorId([{ id: "u1", top: 100 }], 100)).toBe("u1");
  });

  it("stops at the first anchor past the line (the caller may truncate the list there)", () => {
    // What the component actually passes: it breaks out of the DOM walk after the first
    // anchor below the line, so the tail is never measured.
    expect(activeAnchorId(anchors.slice(0, 3), 100)).toBe("u2");
  });
});

describe("isScrolledToBottom (the last message must be able to light up)", () => {
  it("is true at the end, and within a hair of it", () => {
    expect(isScrolledToBottom(600, 400, 1000)).toBe(true);
    expect(isScrolledToBottom(597, 400, 1000)).toBe(true); // 3px of slack
  });

  it("is false while there is still thread below", () => {
    expect(isScrolledToBottom(0, 400, 1000)).toBe(false);
    expect(isScrolledToBottom(500, 400, 1000)).toBe(false);
  });

  it("is true for a thread too short to scroll at all", () => {
    // The exact shape of the bug: nothing to scroll, so no message can ever cross the
    // reading line — yet you ARE at the last one.
    expect(isScrolledToBottom(0, 400, 400)).toBe(true);
  });
});

describe("minimapPitchPx", () => {
  it("keeps a fixed pitch while the block has room", () => {
    expect(minimapPitchPx(600, 2)).toBe(10);
    expect(minimapPitchPx(600, 20)).toBe(10);
  });

  it("tightens once the block would outgrow its share of the column", () => {
    // 100 messages at the resting pitch would be 990px — far past 45% of 600.
    expect(minimapPitchPx(600, 100)).toBeCloseTo(270 / 99, 5);
    expect(minimapPitchPx(600, 100)).toBeLessThan(10);
  });

  it("survives a column that hasn't been measured yet", () => {
    expect(minimapPitchPx(0, 40)).toBe(10);
    expect(minimapPitchPx(600, 1)).toBe(10);
  });
});

describe("minimapBlockHeightPx (it stays a BLOCK, never a full-height ladder)", () => {
  it("is compact for a short conversation", () => {
    expect(minimapBlockHeightPx(600, 5)).toBe(40);
    expect(minimapBlockHeightPx(600, 1)).toBe(0);
  });

  it("never exceeds its share of the column, at any count", () => {
    for (const count of [2, 12, 60, 200, 2000]) {
      expect(minimapBlockHeightPx(600, count)).toBeLessThanOrEqual(600 * 0.45 + 0.001);
    }
  });
});

describe("markOffsetPx", () => {
  it("centres the block on the column", () => {
    // 5 bars, 10px pitch → a 40px block centred on 300.
    expect(markOffsetPx(0, 5, 600)).toBe(280);
    expect(markOffsetPx(2, 5, 600)).toBe(300);
    expect(markOffsetPx(4, 5, 600)).toBe(320);
  });

  it("puts a lone bar dead centre", () => {
    expect(markOffsetPx(0, 1, 600)).toBe(300);
  });

  it("is monotonically increasing (bars keep the conversation's order)", () => {
    const tops = Array.from({ length: 12 }, (_, i) => markOffsetPx(i, 12, 600));
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThan(tops[i - 1]);
  });

  it("stays well inside the column even at absurd counts", () => {
    for (const count of [50, 300, 3000]) {
      expect(markOffsetPx(0, count, 600)).toBeGreaterThan(0);
      expect(markOffsetPx(count - 1, count, 600)).toBeLessThan(600);
    }
  });
});

describe("dockMagnification", () => {
  it("is full under the cursor and fades to nothing out of reach", () => {
    expect(dockMagnification(0)).toBe(1);
    expect(dockMagnification(3)).toBe(0);
    expect(dockMagnification(50)).toBe(0);
  });

  it("decreases with distance, symmetrically", () => {
    expect(dockMagnification(1)).toBeGreaterThan(dockMagnification(2));
    expect(dockMagnification(2)).toBeGreaterThan(dockMagnification(3));
    expect(dockMagnification(-2)).toBe(dockMagnification(2));
  });
});

describe("dockPushPx", () => {
  it("leaves the hovered mark exactly where it was", () => {
    expect(dockPushPx(4, 4)).toBe(0);
  });

  it("pushes neighbours APART — down below, up above", () => {
    expect(dockPushPx(5, 4)).toBeGreaterThan(0);
    expect(dockPushPx(3, 4)).toBeLessThan(0);
    expect(dockPushPx(5, 4)).toBe(-dockPushPx(3, 4)); // symmetric
  });

  it("pushes further the further out you go, then settles", () => {
    const push = [1, 2, 3, 4, 8, 40].map((d) => dockPushPx(4 + d, 4));
    expect(push[1]).toBeGreaterThan(push[0]);
    expect(push[2]).toBeGreaterThan(push[1]);
    // Past the reach of the swell nothing more is added: distant marks all sit at the same
    // small offset instead of drifting away without end.
    expect(push[3]).toBe(push[2]);
    expect(push[5]).toBe(push[2]);
  });

  it("does nothing at all when no mark is hovered", () => {
    for (const i of [0, 3, 20]) expect(dockPushPx(i, -1)).toBe(0);
  });
});

describe("hoverRegime (cold on arrival, warm while reading)", () => {
  const T = 10_000; // an arbitrary "now"

  it("is cold on a first arrival — a pointer brushing past lights nothing up", () => {
    expect(hoverRegime({ previewOpen: false, leftWarmAt: null, now: T })).toBe("cold");
  });

  it("is warm while a card is up: sweeping the column follows the pointer", () => {
    expect(hoverRegime({ previewOpen: true, leftWarmAt: null, now: T })).toBe("warm");
  });

  it("stays warm through a quick round trip out of the column", () => {
    // Left 120ms ago with a card up — well inside the 300ms grace.
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T - 120, now: T })).toBe("warm");
    // Exactly on the edge still counts as reading.
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T - 300, now: T })).toBe("warm");
  });

  it("goes cold again once the grace window has passed", () => {
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T - 301, now: T })).toBe("cold");
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T - 30_000, now: T })).toBe("cold");
  });

  it("does not warm up on a sweep that never showed a card", () => {
    // The component only stamps `leftWarmAt` when a card was actually open, so a pointer that
    // crossed the column without settling arrives with nothing to inherit.
    expect(hoverRegime({ previewOpen: false, leftWarmAt: null, now: T })).toBe("cold");
  });

  // The component measures this on a monotonic clock, so a stamp cannot legitimately sit in
  // the future. Should one ever get there, "age <= 300" would hold for as long as it took the
  // clock to catch up and pin the column warm — so the window is bounded on BOTH sides.
  it("does not read a stamp from the future as 'still reading'", () => {
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T + 1, now: T })).toBe("cold");
    expect(hoverRegime({ previewOpen: false, leftWarmAt: T + 60_000, now: T })).toBe("cold");
  });
});

describe("hoverDelayMs", () => {
  it("asks for a beat of intent when cold", () => {
    expect(hoverDelayMs("cold")).toBe(260);
  });

  it("is imperceptible when warm — but never a flat 0, which strobes on a fast sweep", () => {
    expect(hoverDelayMs("warm")).toBe(30);
    expect(hoverDelayMs("warm")).toBeGreaterThan(0);
    expect(hoverDelayMs("warm")).toBeLessThan(hoverDelayMs("cold") / 4);
  });
});

describe("tipStyle (top-aligned preview)", () => {
  it("lands the first line of text ON the mark, not the preview's border", () => {
    // 7px above the mark = the preview's own top padding.
    expect(tipStyle(300, 600).top).toBe("293.00px");
  });

  it("never starts above the column", () => {
    expect(tipStyle(2, 600).top).toBe("0.00px");
  });

  it("caps its height to the room left BELOW, rather than sliding up out of alignment", () => {
    expect(tipStyle(300, 600).maxHeight).toBe("293.00px"); // 600 - 293 (top) - 14 (pad)
    // Hovering the lowest possible mark still leaves a usable preview…
    expect(parseFloat(tipStyle(0.725 * 600, 600).maxHeight)).toBeGreaterThan(140);
    // …and the cap never goes negative on a column too short to hold anything.
    expect(parseFloat(tipStyle(500, 100).maxHeight)).toBe(0);
  });
});

describe("resolveMessageLabel", () => {
  const noSummaries: Record<string, string> = {};

  it("prefers the summary saved for that message", () => {
    const text = "Rework the footer parsing so the duration comes from result";
    const summaries = { [summaryKey(text)]: "Rework footer duration parsing" };
    expect(resolveMessageLabel(text, "summary", summaries)).toBe("Rework footer duration parsing");
  });

  it("falls back to a first-line truncation when nothing was ever generated", () => {
    const text = "Fix the login crash\nand also check the tests";
    expect(resolveMessageLabel(text, "summary", noSummaries)).toBe("Fix the login crash");
  });

  it("shows a slash command as typed, never the CLI's <command-name> wrapper", () => {
    const wrapped =
      "<command-message>pickup</command-message><command-name>/pickup</command-name>" +
      "<command-args>1a90</command-args>";
    expect(resolveMessageLabel(wrapped, "summary", noSummaries)).toBe("/pickup 1a90");
    expect(resolveMessageLabel(wrapped, "full", noSummaries)).toBe("/pickup 1a90");
  });

  it("full mode keeps the message's own shape (line breaks included)", () => {
    const text = "one\ntwo\nthree";
    expect(resolveMessageLabel(text, "full", noSummaries)).toBe(text);
    // …and ignores a saved summary: "full" means the message as sent.
    expect(resolveMessageLabel(text, "full", { [summaryKey(text)]: "counted" })).toBe(text);
  });

  it("caps a pasted wall of text in full mode", () => {
    const label = resolveMessageLabel("x".repeat(5000), "full", noSummaries);
    expect(label.length).toBeLessThan(1300);
    expect(label.endsWith("…")).toBe(true);
  });

  it("labels an image-only send rather than rendering an empty bubble preview", () => {
    expect(resolveMessageLabel("", "summary", noSummaries)).toBe("[image]");
    expect(resolveMessageLabel("   ", "full", noSummaries)).toBe("[image]");
  });
});
