import { describe, expect, it } from "vitest";
import { caffeineDesired, LIGHT_RELEASE_GRACE_MS, releaseGraceMs } from "./caffeinate";

describe("releaseGraceMs", () => {
  it("lingers only for Light's activity-driven release", () => {
    expect(releaseGraceMs(true, "light")).toBe(LIGHT_RELEASE_GRACE_MS);
  });

  it("releases at once when the user turns Caffeinate off", () => {
    expect(releaseGraceMs(false, "light")).toBe(0);
    expect(releaseGraceMs(false, "hard")).toBe(0);
  });

  it("does not linger in Hard (its only release is being turned off)", () => {
    expect(releaseGraceMs(true, "hard")).toBe(0);
  });
});

describe("caffeineDesired", () => {
  it("never holds when disabled, whatever the mode or activity", () => {
    expect(caffeineDesired(false, "light", true)).toBe(false);
    expect(caffeineDesired(false, "hard", true)).toBe(false);
    expect(caffeineDesired(false, "light", false)).toBe(false);
    expect(caffeineDesired(false, "hard", false)).toBe(false);
  });

  it("Light follows fleet activity", () => {
    expect(caffeineDesired(true, "light", true)).toBe(true); // an agent is working
    expect(caffeineDesired(true, "light", false)).toBe(false); // everything idle → sleep
  });

  it("Hard holds permanently while enabled, ignoring activity", () => {
    expect(caffeineDesired(true, "hard", false)).toBe(true); // idle but still awake
    expect(caffeineDesired(true, "hard", true)).toBe(true);
  });
});
