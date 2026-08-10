import { describe, expect, it } from "vitest";
import { isOnScreen, zoomTransform, type Box } from "./modalZoom";

const VP = { width: 1440, height: 900 };
// A realistic pair: a Flight Deck card in the top-left swimlane, and the centred panel.
const CARD: Box = { left: 40, top: 120, width: 348, height: 240 };
const PANEL: Box = { left: 220, top: 40, width: 1000, height: 820 };

describe("zoomTransform", () => {
  it("maps the panel onto the origin card (centre-to-centre + per-axis scale)", () => {
    const t = zoomTransform(CARD, PANEL, VP);
    // card centre (214, 240) − panel centre (720, 450) = (−506, −210)
    // scale = 348/1000, 240/820
    expect(t).toBe("translate(-506px, -210px) scale(0.348, 0.2927)");
  });

  it("lands the panel exactly on the card, so the two ends line up", () => {
    const t = zoomTransform(CARD, PANEL, VP)!;
    const [, dx, dy, sx, sy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)/
      .exec(t)!
      .map(Number) as unknown as [never, number, number, number, number];
    // Applying the transform to the panel box (scaling about its centre, then translating)
    // must reproduce the card box.
    const cx = PANEL.left + PANEL.width / 2 + dx;
    const cy = PANEL.top + PANEL.height / 2 + dy;
    expect(cx - (PANEL.width * sx) / 2).toBeCloseTo(CARD.left, 1);
    expect(cy - (PANEL.height * sy) / 2).toBeCloseTo(CARD.top, 1);
    expect(PANEL.width * sx).toBeCloseTo(CARD.width, 1);
    expect(PANEL.height * sy).toBeCloseTo(CARD.height, 1);
  });

  it("refuses a missing origin (nothing to zoom from → caller fades instead)", () => {
    expect(zoomTransform(null, PANEL, VP)).toBeNull();
    expect(zoomTransform(undefined, PANEL, VP)).toBeNull();
  });

  it("refuses a degenerate box — a hidden or detached card measures all-zero", () => {
    expect(zoomTransform({ left: 0, top: 0, width: 0, height: 0 }, PANEL, VP)).toBeNull();
    expect(zoomTransform({ ...CARD, height: 0 }, PANEL, VP)).toBeNull();
    expect(zoomTransform(CARD, { ...PANEL, width: 0 }, VP)).toBeNull();
  });

  it("refuses non-finite coordinates rather than emitting NaN into a transform", () => {
    expect(zoomTransform({ ...CARD, left: Number.NaN }, PANEL, VP)).toBeNull();
    expect(zoomTransform({ ...CARD, top: Number.POSITIVE_INFINITY }, PANEL, VP)).toBeNull();
  });

  it("refuses a card scrolled entirely off-screen (the panel would fly at nothing)", () => {
    // The swimlanes scroll horizontally: a card can sit well past the right edge.
    expect(zoomTransform({ ...CARD, left: VP.width + 30 }, PANEL, VP)).toBeNull();
    expect(zoomTransform({ ...CARD, left: -CARD.width - 1 }, PANEL, VP)).toBeNull();
    // …but a partially-visible card is a perfectly good target.
    expect(zoomTransform({ ...CARD, left: VP.width - 4 }, PANEL, VP)).not.toBeNull();
  });

  it("never plays backwards: an origin bigger than the panel clamps to scale 1", () => {
    const huge: Box = { left: 0, top: 0, width: 4000, height: 3000 };
    expect(zoomTransform(huge, PANEL, VP)).toContain("scale(1, 1)");
  });
});

describe("isOnScreen", () => {
  it("accepts a box straddling an edge and rejects one fully outside", () => {
    expect(isOnScreen({ left: -10, top: -10, width: 40, height: 40 }, VP)).toBe(true);
    expect(isOnScreen({ left: -50, top: 10, width: 40, height: 40 }, VP)).toBe(false);
    expect(isOnScreen({ left: 10, top: VP.height + 1, width: 40, height: 40 }, VP)).toBe(false);
  });
});
