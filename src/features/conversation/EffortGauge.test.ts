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

  it("Opus 4.8 keeps the full Opus effort ladder (it is the app default)", () => {
    // `max` was verified live ON Opus 4.8 (see control.rs VALID_EFFORT_LEVELS), and the
    // binary declares xhigh_effort for `claude-opus-4-8`.
    const ladder = ["low", "medium", "high", "xhigh", "max"];
    expect(effortLevelsForModel("claude-opus-4-8")).toEqual(ladder);
    expect(effortLevelsForModel("claude-opus-4-8[1m]")).toEqual(ladder);
  });

  it("reads each model's OWN ladder from the catalogue, not from its family name", () => {
    // Straight from the CLI's baked model registry (2.1.233): the 4.6 generation declares
    // `max_effort` but NOT `xhigh_effort`, and everything at 4.5 and older declares no
    // effort capability at all. A family heuristic ("it says opus → give it everything")
    // gets both of these wrong, which is why the catalogue carries `caps`.
    expect(effortLevelsForModel("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(effortLevelsForModel("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(effortLevelsForModel("claude-opus-4-5")).toEqual([]);
    expect(effortLevelsForModel("claude-sonnet-4-5")).toEqual([]);
  });

  it("clamps onto a max-but-not-xhigh model without ever stepping UP", () => {
    // xhigh sits BELOW max in the ladder, so asking for xhigh on a model that skips it
    // lands on `high` — taking `max` instead would silently give more than was asked.
    expect(clampEffort("xhigh", "claude-sonnet-4-6")).toBe("high");
    // A request from ABOVE max (Ultra code) does land on `max`: that IS stepping down.
    expect(clampEffort("ultracode", "claude-opus-4-6")).toBe("max");
  });

  it("fable has the same effort tier as opus (xhigh + max)", () => {
    // Fable is the time-limited preview family; it shares Opus's effort levels.
    expect(effortLevelsForModel("fable")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Both resolved ids (Fable 5 and Fable 5.1) map to the same family/ladder.
    expect(effortLevelsForModel("claude-fable-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsForModel("claude-fable-5-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
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
