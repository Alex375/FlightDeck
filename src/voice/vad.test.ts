import { describe, it, expect } from "vitest";
import {
  VAD_EAGERNESS_DEFAULT,
  VAD_MODE_DEFAULT,
  VAD_THRESHOLD_DEFAULT,
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  asVadEagerness,
  asVadMode,
  buildTurnDetection,
  clampVadThreshold,
  type VadSettings,
} from "./vad";

const settings = (patch: Partial<VadSettings> = {}): VadSettings => ({
  mode: VAD_MODE_DEFAULT,
  eagerness: VAD_EAGERNESS_DEFAULT,
  threshold: VAD_THRESHOLD_DEFAULT,
  ...patch,
});

describe("clampVadThreshold", () => {
  it("keeps the threshold inside the usable band", () => {
    expect(clampVadThreshold(0.7)).toBe(0.7);
    expect(clampVadThreshold(9)).toBe(VAD_THRESHOLD_MAX);
    expect(clampVadThreshold(-1)).toBe(VAD_THRESHOLD_MIN);
    expect(clampVadThreshold(Number.NaN)).toBe(VAD_THRESHOLD_DEFAULT);
  });
});

describe("buildTurnDetection", () => {
  // The default has to be semantic: a loudness gate cannot tell a plate from a
  // word at ANY threshold, and 0.90 — the maximum — still let a dishwasher cut
  // the agent off every ten seconds.
  it("defaults to semantic turn detection, waiting rather than cutting in", () => {
    const td = buildTurnDetection(settings());
    expect(td.type).toBe("semantic_vad");
    expect(td.eagerness).toBe("low");
    expect(td).not.toHaveProperty("threshold");
  });

  it("builds the loudness gate when that mode is chosen, clamped", () => {
    const td = buildTurnDetection(settings({ mode: "loudness", threshold: 9 }));
    expect(td.type).toBe("server_vad");
    expect(td.threshold).toBe(VAD_THRESHOLD_MAX);
    expect(td.prefix_padding_ms).toBe(300);
    expect(td.silence_duration_ms).toBe(500);
    expect(td).not.toHaveProperty("eagerness");
  });

  // Barge-in is wanted behaviour in both modes — what changed is what counts as
  // speaking, not whether the user may interrupt.
  it("keeps barge-in and auto-response on in both modes", () => {
    for (const mode of ["semantic", "loudness"] as const) {
      const td = buildTurnDetection(settings({ mode }));
      expect(td.interrupt_response).toBe(true);
      expect(td.create_response).toBe(true);
    }
  });

  // A stored value from an older build, or a hand-edited one, must not travel to
  // the server as an unknown enum — the whole session.update would be rejected.
  it("coerces an unknown mode or eagerness back to the default", () => {
    const td = buildTurnDetection({
      mode: "whatever" as never,
      eagerness: "frantic" as never,
      threshold: 0.6,
    });
    expect(td.type).toBe("semantic_vad");
    expect(td.eagerness).toBe(VAD_EAGERNESS_DEFAULT);
  });
});

describe("the stored-value coercions", () => {
  it("accepts the known values and rejects everything else", () => {
    expect(asVadMode("loudness")).toBe("loudness");
    expect(asVadMode("semantic")).toBe("semantic");
    expect(asVadMode(undefined)).toBe(VAD_MODE_DEFAULT);
    expect(asVadMode(null)).toBe(VAD_MODE_DEFAULT);
    expect(asVadEagerness("high")).toBe("high");
    expect(asVadEagerness(42)).toBe(VAD_EAGERNESS_DEFAULT);
  });
});
