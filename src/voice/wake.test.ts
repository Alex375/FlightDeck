import { describe, it, expect } from "vitest";
import { shouldFireWake, type WakeGateState } from "./wake";

const base: WakeGateState = { configured: true, enabled: true, phase: "armed" };

describe("shouldFireWake", () => {
  it("fires when configured, enabled and not speaking", () => {
    expect(shouldFireWake({ ...base, phase: "armed" })).toBe(true);
    expect(shouldFireWake({ ...base, phase: "listening" })).toBe(true);
    expect(shouldFireWake({ ...base, phase: "connecting" })).toBe(true);
  });

  it("stays silent without a stored key", () => {
    expect(shouldFireWake({ ...base, configured: false })).toBe(false);
    expect(shouldFireWake({ ...base, configured: null })).toBe(false);
  });

  it("stays silent when the user has not opted in", () => {
    expect(shouldFireWake({ ...base, enabled: false })).toBe(false);
  });

  it("does not self-trigger while the agent is speaking", () => {
    // The always-on mic hears the agent's own TTS; that is never a wake word.
    expect(shouldFireWake({ ...base, phase: "speaking" })).toBe(false);
  });

  it("does not fire on a broken session", () => {
    expect(shouldFireWake({ ...base, phase: "error" })).toBe(false);
  });
});
