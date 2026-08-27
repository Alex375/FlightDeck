import { describe, it, expect } from "vitest";
import {
  DEFAULT_PTT,
  describePtt,
  makeTapDetector,
  matchesChord,
  shortcutFromEvent,
  type PttShortcut,
} from "./pttShortcut";

const kb = (over: Partial<KeyboardEvent>): KeyboardEvent => over as KeyboardEvent;

describe("modifier tap detection (the Right ⌘ default)", () => {
  const fireLog = () => {
    const fired: number[] = [];
    const d = makeTapDetector(
      () => DEFAULT_PTT,
      () => fired.push(1),
    );
    return { d, fired };
  };

  it("fires on a clean press-and-release of the modifier alone", () => {
    const { d, fired } = fireLog();
    d.keydown(kb({ code: "MetaRight" }));
    d.keyup(kb({ code: "MetaRight" }));
    expect(fired).toHaveLength(1);
  });

  it("does NOT fire when the modifier was part of a chord (⌘C with the right thumb)", () => {
    const { d, fired } = fireLog();
    d.keydown(kb({ code: "MetaRight" }));
    d.keydown(kb({ code: "KeyC" })); // disarms the tap
    d.keyup(kb({ code: "MetaRight" }));
    expect(fired).toHaveLength(0);
  });

  it("ignores the OTHER modifier of the same family (Left ⌘)", () => {
    const { d, fired } = fireLog();
    d.keydown(kb({ code: "MetaLeft" }));
    d.keyup(kb({ code: "MetaLeft" }));
    expect(fired).toHaveLength(0);
  });
});

describe("chord matching & recording", () => {
  it("matchesChord requires the exact modifier set and never fires for tap shortcuts", () => {
    const chord: PttShortcut = { code: "KeyV", meta: true, shift: true };
    expect(
      matchesChord(chord, kb({ code: "KeyV", metaKey: true, shiftKey: true, altKey: false, ctrlKey: false })),
    ).toBe(true);
    expect(
      matchesChord(chord, kb({ code: "KeyV", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })),
    ).toBe(false);
    expect(matchesChord(DEFAULT_PTT, kb({ code: "MetaRight" }))).toBe(false);
  });

  it("shortcutFromEvent records a modifier as a tap, a key as a chord, Escape as cancel", () => {
    expect(shortcutFromEvent(kb({ code: "AltRight" }))).toEqual({ code: "AltRight", tap: true });
    expect(
      shortcutFromEvent(kb({ code: "KeyV", metaKey: true, shiftKey: true, altKey: false, ctrlKey: false })),
    ).toEqual({ code: "KeyV", meta: true, shift: true, alt: undefined, ctrl: undefined });
    expect(shortcutFromEvent(kb({ code: "Escape" }))).toBeNull();
  });

  it("describePtt renders human labels", () => {
    expect(describePtt(DEFAULT_PTT)).toBe("Right ⌘");
    expect(describePtt({ code: "KeyV", meta: true, shift: true })).toBe("⇧⌘ V");
    expect(describePtt({ code: "F13" })).toBe("F13");
  });
});
