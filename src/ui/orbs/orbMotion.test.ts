import { describe, it, expect } from "vitest";
import { FEEL, S_MIN, SWAP, TURN, liveFrame, morphFrame, morphProgress, pinchScale, pinchTurn } from "./orbMotion";

const STEPS = Array.from({ length: 1001 }, (_, i) => i / 1000);

describe("pinchScale (contraction then spring expansion)", () => {
  it("starts and lands exactly at full size", () => {
    expect(pinchScale(0)).toBeCloseTo(1, 10);
    expect(pinchScale(1)).toBeCloseTo(1, 10);
  });

  it("breathes in by ~4.7 % before contracting", () => {
    const peak = Math.max(...STEPS.filter((p) => p < SWAP).map((p) => pinchScale(p)));
    expect(peak).toBeGreaterThan(1.04);
    expect(peak).toBeLessThan(1.055);
  });

  it("is smallest (S_MIN) at the swap", () => {
    expect(pinchScale(SWAP)).toBeCloseTo(S_MIN, 6);
    const min = Math.min(...STEPS.map((p) => pinchScale(p)));
    expect(min).toBeCloseTo(S_MIN, 3);
  });

  it("overshoots by about 7 % on the way back out", () => {
    const peak = Math.max(...STEPS.filter((p) => p > SWAP).map((p) => pinchScale(p)));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.1);
  });
});

describe("pinchTurn (one full turn)", () => {
  it("goes 0 → half a turn at the swap → exactly one turn, monotonically", () => {
    expect(pinchTurn(0)).toBeCloseTo(0, 10);
    expect(pinchTurn(SWAP)).toBeCloseTo(TURN / 2, 6);
    // A full turn: the final rotation is the identity, so the orb never snaps on the last frame.
    expect(pinchTurn(1)).toBeCloseTo(TURN, 10);
    for (let i = 1; i < STEPS.length; i++) expect(pinchTurn(STEPS[i])).toBeGreaterThanOrEqual(pinchTurn(STEPS[i - 1]));
  });
});

describe("morphFrame", () => {
  it("is the target's live frame when no transition runs", () => {
    const m = { from: null, to: "searching" as const, start: 0, feel: { ...FEEL } };
    expect(morphProgress(m, 5)).toBe(1);
    expect(morphFrame(m, 20, 2.5)).toEqual(liveFrame("searching", 20, 2.5));
  });

  it("is the target's live frame once the transition has ended", () => {
    const m = { from: "working" as const, to: "shaping" as const, start: 10, feel: { ...FEEL } };
    expect(morphFrame(m, 20, 10 + FEEL.duration + 0.01)).toEqual(liveFrame("shaping", 20, 10 + FEEL.duration + 0.01));
  });

  it("shows the flash bead around the swap and finite geometry throughout", () => {
    const m = { from: "working" as const, to: "composing" as const, start: 0, feel: { ...FEEL } };
    const atSwap = morphFrame(m, 20, FEEL.duration * SWAP);
    expect(atSwap.dots.some((d) => d.z === 9 && d.x === 10 && d.y === 10)).toBe(true);
    for (const p of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      const f = morphFrame(m, 20, p * FEEL.duration);
      for (const d of f.dots) expect(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.r)).toBe(true);
    }
  });
});
