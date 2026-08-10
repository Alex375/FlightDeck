// The message minimap's pure rules: which bar lights up, where each bar sits, how thick it
// is drawn, and what a hover says. Kept out of the component so they are testable without
// a scroll container.
import { describe, it, expect } from "vitest";
import {
  activeAnchorId,
  isScrolledToBottom,
  markOffsetPx,
  minimapBlockHeightPx,
  minimapPitchPx,
  resolveMessageLabel,
  verticalScaleOf,
} from "./MessageMinimap";
import { summaryKey } from "../../store/lastMessageSummary";

describe("verticalScaleOf (measuring inside the Flight Deck modal's opening zoom)", () => {
  it("reports the scale an ancestor transform is painting at", () => {
    // Panel laid out 820 tall, painted at a card's 240 while the zoom plays.
    expect(verticalScaleOf(240, 820)).toBeCloseTo(0.2927, 4);
    expect(verticalScaleOf(410, 820)).toBe(0.5);
  });

  it("recovers the layout figure when the caller divides by it", () => {
    const layout = 820;
    const painted = 240.12;
    expect(painted / verticalScaleOf(painted, layout)).toBeCloseTo(layout, 6);
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
  });
});

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
