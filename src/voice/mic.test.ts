import { describe, it, expect } from "vitest";
import { METER_FLOOR_DB, levelToBar, rms, describeMicSettings } from "./mic";

describe("levelToBar", () => {
  // The bug this scale replaces: `rms * 3.2` put normal speech at 16% of a bar
  // whose threshold handle sat at 60%, so the level could never reach it. On a
  // dBFS scale, ordinary speech has to land in the readable middle.
  it("puts normal speech in the middle of the bar and room tone near the bottom", () => {
    const speech = levelToBar(0.05); // ≈ -26 dBFS, the RMS measured on real speech
    const roomTone = levelToBar(0.003); // ≈ -50 dBFS, a quiet room
    expect(speech).toBeGreaterThan(0.45);
    expect(speech).toBeLessThan(0.75);
    expect(roomTone).toBeLessThan(0.25);
    expect(speech).toBeGreaterThan(roomTone * 2);
  });

  it("bottoms out at the floor and tops out at full scale", () => {
    expect(levelToBar(0)).toBe(0);
    expect(levelToBar(-1)).toBe(0);
    expect(levelToBar(10 ** (METER_FLOOR_DB / 20))).toBeCloseTo(0, 5);
    expect(levelToBar(1)).toBe(1);
    expect(levelToBar(4)).toBe(1); // clipped input still reads full, never past it
  });

  it("rises monotonically", () => {
    const points = [0.001, 0.005, 0.02, 0.08, 0.3, 1].map(levelToBar);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeGreaterThan(points[i - 1]);
    }
  });
});

describe("rms", () => {
  it("is zero for silence and the amplitude for a constant signal", () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
  });
});

describe("describeMicSettings", () => {
  const streamWith = (settings: Record<string, unknown>) =>
    ({ getAudioTracks: () => [{ getSettings: () => settings }] }) as unknown as MediaStream;

  it("reports what the track actually negotiated", () => {
    const text = describeMicSettings(
      streamWith({ autoGainControl: false, noiseSuppression: true, echoCancellation: true }),
    );
    expect(text).toContain("auto gain off");
    expect(text).toContain("noise suppression on");
  });

  // A constraint the platform ignored comes back absent, not false — reporting it
  // as "off" would claim we turned something off that is still on.
  it("omits a constraint the platform did not report at all", () => {
    expect(describeMicSettings(streamWith({ echoCancellation: true }))).toBe(
      "echo cancellation on",
    );
    expect(describeMicSettings(streamWith({}))).toBeNull();
  });

  it("survives a stream with no audio track", () => {
    expect(describeMicSettings({ getAudioTracks: () => [] } as unknown as MediaStream)).toBeNull();
  });
});
