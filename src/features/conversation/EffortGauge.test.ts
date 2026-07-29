import { describe, it, expect } from "vitest";
import { clampEffort, effortLevelsForModel, type EffortLevel } from "./EffortGauge";

describe("effortLevelsForModel", () => {
  it("offers 'max' on the models that accept it (Opus, Sonnet, Fable), not the others", () => {
    // 2.1.187 promoted `max` to a real runtime level — verified live. Per-model:
    // Opus 5, Sonnet 5 and Fable 5 accept it; Haiku has no effort; the fallback stays lean.
    for (const m of ["opus", "claude-opus-5[1m]", "sonnet", "fable", "claude-fable-5"]) {
      expect(effortLevelsForModel(m)).toContain("max" as EffortLevel);
    }
    for (const m of ["haiku", "whatever"]) {
      expect(effortLevelsForModel(m)).not.toContain("max" as EffortLevel);
    }
  });

  it("opus and sonnet both have xhigh+max, haiku has no effort", () => {
    expect(effortLevelsForModel("opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The live resolved id (with the [1m] suffix) maps to the same family.
    expect(effortLevelsForModel("claude-opus-5[1m]")).toContain("xhigh");
    // Sonnet 5 gained `xhigh` (legacy Sonnet 4.6 had `max` but not `xhigh`).
    expect(effortLevelsForModel("sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsForModel("sonnet")).toContain("xhigh");
    expect(effortLevelsForModel("haiku")).toEqual([]); // gauge hidden
  });

  it("fable has the same effort tier as opus (xhigh + max)", () => {
    // Fable 5 is the time-limited preview model; it shares Opus's effort levels.
    expect(effortLevelsForModel("fable")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The resolved id `claude-fable-5` maps to the same family.
    expect(effortLevelsForModel("claude-fable-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsForModel("fable")).toContain("xhigh");
  });
});

describe("clampEffort", () => {
  it("keeps a supported level unchanged", () => {
    expect(clampEffort("high", "opus")).toBe("high");
    expect(clampEffort("max", "opus")).toBe("max");
    expect(clampEffort("xhigh", "sonnet")).toBe("xhigh"); // Sonnet 5 now supports xhigh
  });

  it("clamps an unsupported xhigh down to high — never jumps UP to max", () => {
    // Invariant: `max` ranks ABOVE `xhigh` in ORDER, so on a `max`-but-not-`xhigh`
    // ladder the highest supported level ≤ xhigh is `high`, never `max`. No current
    // Claude model is max-without-xhigh, so exercise it with an explicit ladder.
    expect(clampEffort("xhigh", "whatever", ["low", "medium", "high", "max"])).toBe("high");
  });

  it("lands ultracode on the top available level of a weaker ladder", () => {
    // A ladder without xhigh/ultracode: the highest supported ≤ ultracode is its top rung.
    expect(clampEffort("ultracode", "whatever", ["low", "medium", "high", "max"])).toBe("max");
  });

  it("ultracode stays on an xhigh-capable model (opus and now sonnet)", () => {
    expect(clampEffort("ultracode", "opus")).toBe("ultracode");
    expect(clampEffort("ultracode", "sonnet")).toBe("ultracode"); // Sonnet 5 is xhigh-capable
  });

  it("returns the value unchanged for a model with no effort (gauge hidden)", () => {
    expect(clampEffort("high", "haiku")).toBe("high");
  });
});
