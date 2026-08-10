import { describe, expect, it } from "vitest";
import {
  ALL_CHIPS,
  LEFT_CHIPS,
  MIN_COMPOSER_PX,
  RIGHT_CHIPS,
  SLOT_CAPACITY,
  appliesToBackend,
  canUnhide,
  chipById,
  nativeWorstCase,
  orderedRight,
  remainingSlots,
  reorderVisible,
  slotCapacity,
  slotCost,
  usedSlots,
  type CustomButton,
} from "./composerLayout";

const none = new Set<string>();
const custom = (id: string): CustomButton => ({ id, icon: "spark", label: id, action: "insert-text" });

describe("slot capacity", () => {
  it("fits the measured chips inside the narrowest composer", () => {
    // 500 − 16 (composer padding) − 12 (foot padding) = 472 available;
    // minus 7 (separator) + 72 (context ring) + 2×3 (their gaps) = 85 → 387 / 28 = 13.
    expect(slotCapacity(MIN_COMPOSER_PX)).toBe(13);
    expect(SLOT_CAPACITY).toBe(13);
  });

  it("never reports a negative capacity for an absurdly narrow bar", () => {
    expect(slotCapacity(50)).toBe(0);
  });

  it("grows with the available width", () => {
    expect(slotCapacity(700)).toBeGreaterThan(slotCapacity(MIN_COMPOSER_PX));
  });
});

describe("worst case", () => {
  it("takes the max of the two backends, never their sum", () => {
    // Claude: model, effort, permission + 6 right-hand chips, worktree counting double = 10.
    // Codex:  model, effort, safety, speed, options + 4 right-hand chips (same) = 10.
    // Summing them would eat the whole budget on a bar that can never show both.
    expect(nativeWorstCase(none)).toBe(10);
  });

  it("charges the worktree control two slots, as measured", () => {
    // 52px against a plain chip's 25px — counting it as one would promise a slot that
    // isn't there, and the bar would overflow at the floor width.
    expect(nativeWorstCase(new Set(["worktree"]))).toBe(nativeWorstCase(none) - 2);
  });

  it("counts a hidden right-hand chip as freed on both backends", () => {
    expect(nativeWorstCase(new Set(["cleanOutput", "worktree"]))).toBe(7);
  });

  it("frees only one slot for a chip that exists on a single backend", () => {
    // `goal` is Claude-only: hiding it drops Claude to 9, but Codex still sits at 10,
    // so the worst case — and therefore the budget — is unchanged.
    expect(nativeWorstCase(new Set(["goal"]))).toBe(10);
  });

  it("ignores attempts to hide a left-hand chip", () => {
    // The left side is never hideable; a stale id in storage must not buy free slots.
    expect(nativeWorstCase(new Set(["model", "effort"]))).toBe(10);
  });
});

describe("slot accounting", () => {
  it("adds custom buttons to the native worst case", () => {
    expect(usedSlots(none, 3)).toBe(13);
    expect(remainingSlots(none, 3)).toBe(0);
  });

  it("reports zero rather than a negative remainder when saturated", () => {
    expect(remainingSlots(none, 99)).toBe(0);
  });

  it("hiding chips buys room for custom buttons", () => {
    const hidden = new Set(["cleanOutput", "worktree"]);
    expect(remainingSlots(hidden, 0)).toBe(6);
  });
});

describe("right-hand arrangement", () => {
  const customs = [custom("c1"), custom("c2")];

  it("honours the stored order", () => {
    const out = orderedRight(["cleanOutput", "extensions", "c1"], none, customs);
    expect(out.slice(0, 3)).toEqual(["cleanOutput", "extensions", "c1"]);
  });

  it("drops hidden ids wherever they appear", () => {
    const out = orderedRight(["cleanOutput", "extensions"], new Set(["cleanOutput"]), customs);
    expect(out).not.toContain("cleanOutput");
    expect(out).toContain("extensions");
  });

  it("appends chips the stored order never mentioned", () => {
    // A control shipped in a later version must APPEAR for someone with a saved
    // arrangement, not silently vanish because their blob predates it.
    const out = orderedRight(["extensions"], none, customs);
    expect(out[0]).toBe("extensions");
    expect(out).toContain("goal");
    expect(out).toContain("c2");
  });

  it("ignores unknown ids left over from a deleted button", () => {
    const out = orderedRight(["ghost", "extensions"], none, customs);
    expect(out).not.toContain("ghost");
    expect(out[0]).toBe("extensions");
  });

  it("never repeats an id listed twice", () => {
    const out = orderedRight(["extensions", "extensions"], none, []);
    expect(out.filter((id) => id === "extensions")).toHaveLength(1);
  });
});

describe("reordering within the visible subset", () => {
  // The preview only ever shows one backend's applicable, non-hidden controls.
  const full = ["artifacts", "extensions", "cleanOutput", "goal", "worktree"];
  const visible = ["extensions", "cleanOutput", "worktree"]; // artifacts + goal hidden

  it("moves the dragged item and leaves the hidden ones exactly where they were", () => {
    // Naively rebuilding as [...moved, ...rest] shoved `artifacts` and `goal` to the end,
    // silently rewriting positions the drag never concerned.
    const out = reorderVisible(full, visible, 0, 2); // extensions → last visible slot
    expect(out).toEqual(["artifacts", "cleanOutput", "worktree", "goal", "extensions"]);
    expect(out.indexOf("artifacts")).toBe(0);
    expect(out.indexOf("goal")).toBe(3);
  });

  it("keeps the same members, never dropping or duplicating one", () => {
    const out = reorderVisible(full, visible, 2, 0);
    expect([...out].sort()).toEqual([...full].sort());
  });

  it("is a no-op for a drag that lands where it started", () => {
    expect(reorderVisible(full, visible, 1, 1)).toEqual(full);
  });

  it("ignores an out-of-range index instead of corrupting the order", () => {
    expect(reorderVisible(full, visible, 0, 9)).toEqual(full);
    expect(reorderVisible(full, visible, -1, 1)).toEqual(full);
  });
});

describe("restoring a hidden control", () => {
  it("refuses when the freed slots have already been spent", () => {
    // The hole the budget had: hide chips, fill the freed slots with buttons, then
    // un-hide — the cap was only ever checked when ADDING. Hiding these two leaves 8
    // native slots, so 5 buttons saturate the 13.
    const hidden = new Set(["cleanOutput", "extensions"]);
    expect(remainingSlots(hidden, 5)).toBe(0);
    expect(canUnhide("cleanOutput", hidden, 5)).toBe(false);
    // One button fewer and it fits again.
    expect(canUnhide("cleanOutput", hidden, 4)).toBe(true);
  });

  it("allows it while there is room", () => {
    const hidden = new Set(["cleanOutput"]);
    expect(canUnhide("cleanOutput", hidden, 0)).toBe(true);
  });

  it("charges a wide control its real cost", () => {
    // Worktree is two slots: one free slot is not enough to bring it back.
    const hidden = new Set(["worktree"]);
    expect(slotCost("worktree")).toBe(2);
    expect(canUnhide("worktree", hidden, remainingSlots(hidden, 0) - 1)).toBe(false);
  });

  it("charges a custom button one slot", () => {
    expect(slotCost("some-custom-id")).toBe(1);
  });
});

describe("descriptors", () => {
  it("keeps every id unique across both sides", () => {
    expect(new Set(ALL_CHIPS.map((c) => c.id)).size).toBe(ALL_CHIPS.length);
  });

  it("resolves ids and rejects unknown ones", () => {
    expect(chipById("cleanOutput")?.side).toBe("right");
    expect(chipById("nope")).toBeNull();
  });

  it("documents the condition of every conditional control", () => {
    // Without the note, hiding something you never see reads as a broken setting.
    for (const id of ["artifacts", "goal", "worktree", "effort", "codexSpeed"]) {
      expect(chipById(id)?.condition, id).toBeTruthy();
    }
  });

  it("splits backend-specific controls the way the budget assumes", () => {
    const claudeOnly = ALL_CHIPS.filter((c) => c.backend === "claude").map((c) => c.id);
    const codexOnly = ALL_CHIPS.filter((c) => c.backend === "codex").map((c) => c.id);
    expect(claudeOnly).toEqual(["permission", "artifacts", "goal"]);
    expect(codexOnly).toEqual(["codexSafety", "codexSpeed", "codexOptions"]);
    for (const c of LEFT_CHIPS) expect(appliesToBackend(c, "claude") || appliesToBackend(c, "codex")).toBe(true);
    for (const c of RIGHT_CHIPS) expect(c.side).toBe("right");
  });
});
