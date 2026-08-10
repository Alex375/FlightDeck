import { describe, it, expect } from "vitest";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  formatZoom,
  nextZoom,
  prevZoom,
  sanitizeZoom,
} from "./zoom";

describe("ZOOM_STEPS", () => {
  it("is ascending, and contains 100% as an exact step", () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]).toBeGreaterThan(ZOOM_STEPS[i - 1]);
    }
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });
});

describe("sanitizeZoom", () => {
  it("keeps a sane factor as-is", () => {
    expect(sanitizeZoom(1)).toBe(1);
    expect(sanitizeZoom(1.5)).toBe(1.5);
  });

  it("falls back to 100% for anything that is not a finite number", () => {
    // What a hand-edited / older / corrupted localStorage entry can hold. Letting any of
    // these reach the webview would leave the window unreadable with no way back.
    expect(sanitizeZoom(undefined)).toBe(DEFAULT_ZOOM);
    expect(sanitizeZoom(null)).toBe(DEFAULT_ZOOM);
    expect(sanitizeZoom("1.5")).toBe(DEFAULT_ZOOM);
    expect(sanitizeZoom(NaN)).toBe(DEFAULT_ZOOM);
    expect(sanitizeZoom(Infinity)).toBe(DEFAULT_ZOOM);
  });

  it("clamps out-of-range factors to the ladder's ends (never 0)", () => {
    expect(sanitizeZoom(0)).toBe(MIN_ZOOM);
    expect(sanitizeZoom(-3)).toBe(MIN_ZOOM);
    expect(sanitizeZoom(99)).toBe(MAX_ZOOM);
  });
});

describe("nextZoom / prevZoom", () => {
  it("walks the ladder one step at a time, in both directions", () => {
    expect(nextZoom(1)).toBe(1.1);
    expect(nextZoom(1.1)).toBe(1.25);
    expect(prevZoom(1)).toBe(0.9);
    expect(prevZoom(0.9)).toBe(0.8);
  });

  it("round-trips every step (float slack doesn't strand 0.67 / 1.1 on themselves)", () => {
    for (const step of ZOOM_STEPS) {
      if (step !== MAX_ZOOM) expect(prevZoom(nextZoom(step))).toBeCloseTo(step, 10);
      if (step !== MIN_ZOOM) expect(nextZoom(prevZoom(step))).toBeCloseTo(step, 10);
    }
  });

  it("stops at the ends instead of running off the ladder", () => {
    expect(nextZoom(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(prevZoom(MIN_ZOOM)).toBe(MIN_ZOOM);
  });

  it("snaps an off-ladder factor back onto the ladder", () => {
    // A value from a hand-edited pref (or a future build's finer ladder): stepping must
    // land on OUR steps, not keep drifting by some remembered delta.
    expect(nextZoom(1.02)).toBe(1.1);
    expect(prevZoom(1.02)).toBe(1);
    expect(nextZoom(0.71)).toBe(0.75);
    expect(prevZoom(0.71)).toBe(0.67);
  });

  it("treats an unusable stored factor as 100% before stepping", () => {
    expect(nextZoom(0)).toBe(0.67);
    expect(prevZoom(NaN as unknown as number)).toBe(0.9);
  });
});

describe("formatZoom", () => {
  it("renders whole percentages", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(0.67)).toBe("67%");
    expect(formatZoom(1.25)).toBe("125%");
    expect(formatZoom(2)).toBe("200%");
  });

  it("never prints a nonsense percentage for a corrupted factor", () => {
    expect(formatZoom(NaN)).toBe("100%");
  });
});
