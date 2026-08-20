import { describe, it, expect } from "vitest";
import {
  buildTurnDetection,
  clampVadThreshold,
  VAD_THRESHOLD_DEFAULT,
  VAD_THRESHOLD_MIN,
  VAD_THRESHOLD_MAX,
} from "./vad";

describe("clampVadThreshold", () => {
  it("keeps in-band values", () => {
    expect(clampVadThreshold(0.6)).toBe(0.6);
    expect(clampVadThreshold(0.35)).toBe(0.35);
  });
  it("clamps to the usable band", () => {
    expect(clampVadThreshold(0.05)).toBe(VAD_THRESHOLD_MIN);
    expect(clampVadThreshold(1.5)).toBe(VAD_THRESHOLD_MAX);
  });
  it("falls back to the default on non-finite input (NaN and Infinity)", () => {
    expect(clampVadThreshold(NaN)).toBe(VAD_THRESHOLD_DEFAULT);
    expect(clampVadThreshold(Infinity)).toBe(VAD_THRESHOLD_DEFAULT);
  });
});

describe("buildTurnDetection", () => {
  it("is server_vad and carries the (clamped) threshold", () => {
    const td = buildTurnDetection(0.7);
    expect(td.type).toBe("server_vad");
    expect(td.threshold).toBe(0.7);
    // An out-of-band request is clamped, never passed through raw.
    expect(buildTurnDetection(9).threshold).toBe(VAD_THRESHOLD_MAX);
  });
  it("KEEPS barge-in on so the user can always cut the agent off", () => {
    // This is a wanted behaviour the user asked to preserve — raising the
    // threshold reduces false triggers WITHOUT disabling interruption.
    expect(buildTurnDetection(0.9).interrupt_response).toBe(true);
  });
});
