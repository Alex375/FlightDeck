import { describe, it, expect } from "vitest";
import {
  ACTION_BINDINGS,
  type ChordSpec,
  isEditableTarget,
  isSettingsChord,
  isSoundToggleChord,
  isUndoChord,
  matchChord,
  SHORTCUT_GROUPS,
  viewForShortcut,
  type ChordEvent,
  type SettingsChordEvent,
  type SoundToggleChordEvent,
  type UndoChordEvent,
  type ViewShortcutEvent,
} from "./shortcuts";

function chord(p: Partial<ChordEvent>): ChordEvent {
  return { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function ev(p: Partial<ViewShortcutEvent>): ViewShortcutEvent {
  return { code: "Digit1", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function uev(p: Partial<UndoChordEvent>): UndoChordEvent {
  return { key: "z", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function sev(p: Partial<SoundToggleChordEvent>): SoundToggleChordEvent {
  return { key: "m", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function cev(p: Partial<SettingsChordEvent>): SettingsChordEvent {
  return { key: ",", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

/** Every keystroke a spec claims: one per listed code, one per listed key, ×(Shift on/off)
 *  when the spec is shift-agnostic. Used to check bindings against each other by behaviour. */
function keystrokesFor(spec: ChordSpec): ChordEvent[] {
  const codes = spec.codes ?? (spec.code ? [spec.code] : []);
  const keys = spec.keys ?? (spec.key ? [spec.key] : []);
  const shifts = spec.shift === "any" ? [false, true] : [spec.shift ?? false];
  const out: ChordEvent[] = [];
  for (const shiftKey of shifts) {
    for (const code of codes) {
      out.push(chord({ metaKey: true, altKey: spec.alt ?? false, shiftKey, code }));
    }
    for (const key of keys) {
      out.push(chord({ metaKey: true, altKey: spec.alt ?? false, shiftKey, key }));
    }
  }
  return out;
}

describe("viewForShortcut", () => {
  it("⌘1 → conversation, ⌘2 → flight deck, ⌘3 → TOSSE", () => {
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit1" }))).toBe("conversation");
    expect(viewForShortcut(ev({ ctrlKey: true, code: "Digit1" }))).toBe("conversation");
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit2" }))).toBe("flightdeck");
    expect(viewForShortcut(ev({ ctrlKey: true, code: "Digit2" }))).toBe("flightdeck");
    // Resolving ⌘3 here says nothing about whether that view EXISTS right now — the TOSSE
    // tab is conditional on being signed in, and App is what ignores an unavailable target.
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit3" }))).toBe("tosse");
    expect(viewForShortcut(ev({ ctrlKey: true, code: "Digit3" }))).toBe("tosse");
  });

  it("keys off the PHYSICAL e.code, so other digits/codes don't match (AZERTY safety)", () => {
    // On AZERTY ⌘1 fires with e.key="&" but e.code="Digit1"; matching e.code is what
    // makes the chord layout-independent. A code outside Digit1-3 never matches.
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit4" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, code: "Numpad1" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, code: "KeyA" }))).toBeNull();
  });

  it("requires ⌘/Ctrl and rejects Shift or Alt", () => {
    expect(viewForShortcut(ev({ code: "Digit1" }))).toBeNull(); // bare digit, no modifier
    expect(viewForShortcut(ev({ metaKey: true, shiftKey: true, code: "Digit1" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, altKey: true, code: "Digit1" }))).toBeNull();
    expect(viewForShortcut(ev({ ctrlKey: true, shiftKey: true, code: "Digit2" }))).toBeNull();
  });
});

describe("isUndoChord", () => {
  it("⌘Z / Ctrl+Z is the undo chord", () => {
    expect(isUndoChord(uev({ metaKey: true }))).toBe(true);
    expect(isUndoChord(uev({ ctrlKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED letter e.key (case-insensitive), not the physical code", () => {
    // Unlike the digit chords, a LETTER's e.key is the same on every layout — it's the
    // QWERTY-positional e.code that drifts (AZERTY 'z' sits at code 'KeyW'). So undo
    // tracks the key that types "z", which is what e.key gives us.
    expect(isUndoChord(uev({ metaKey: true, key: "Z" }))).toBe(true); // capitalised (no shift)
    expect(isUndoChord(uev({ metaKey: true, key: "w" }))).toBe(false);
    expect(isUndoChord(uev({ metaKey: true, key: "a" }))).toBe(false);
  });

  it("requires ⌘/Ctrl and rejects Shift (redo) or Alt", () => {
    expect(isUndoChord(uev({}))).toBe(false); // bare z, no modifier
    expect(isUndoChord(uev({ metaKey: true, shiftKey: true }))).toBe(false); // ⌘⇧Z = redo
    expect(isUndoChord(uev({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("isSoundToggleChord", () => {
  it("⌘⇧M / Ctrl+⇧M is the sound-toggle chord", () => {
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isSoundToggleChord(sev({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED letter e.key (case-insensitive), not the physical code", () => {
    // Same AZERTY reasoning as undo: a letter's e.key is layout-stable, e.code is not
    // (AZERTY 'm' sits at QWERTY's Semicolon position). Shift uppercases it to "M".
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, key: "M" }))).toBe(true);
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, key: "n" }))).toBe(false);
  });

  it("REQUIRES Shift (bare ⌘M minimises the window) and rejects Alt / no modifier", () => {
    expect(isSoundToggleChord(sev({ metaKey: true }))).toBe(false); // ⌘M without Shift
    expect(isSoundToggleChord(sev({ shiftKey: true }))).toBe(false); // ⇧M without ⌘/Ctrl
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isSoundToggleChord(sev({ key: "m" }))).toBe(false); // bare m
  });
});

describe("isSettingsChord", () => {
  it("⌘, / Ctrl+, is the settings chord", () => {
    expect(isSettingsChord(cev({ metaKey: true }))).toBe(true);
    expect(isSettingsChord(cev({ ctrlKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED character e.key, not the physical code (AZERTY safety)", () => {
    // The comma is a character whose physical position moves across layouts: on AZERTY
    // the key read as "," produces e.key="," unshifted but sits at QWERTY's KeyM
    // position (e.code="Comma" there is the ";" key). So we track the produced ",",
    // same reasoning as the letter chords — never the physical e.code.
    expect(isSettingsChord(cev({ metaKey: true, key: ";" }))).toBe(false);
    expect(isSettingsChord(cev({ metaKey: true, key: "." }))).toBe(false);
  });

  it("requires ⌘/Ctrl and rejects Shift or Alt", () => {
    expect(isSettingsChord(cev({}))).toBe(false); // bare comma, no modifier
    expect(isSettingsChord(cev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSettingsChord(cev({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("matchChord", () => {
  it("matches a letter chord via the PRODUCED key (case-insensitive), ⌘ or Ctrl", () => {
    expect(matchChord(chord({ metaKey: true, key: "b" }), { key: "b" })).toBe(true);
    expect(matchChord(chord({ ctrlKey: true, key: "B" }), { key: "b" })).toBe(true);
    expect(matchChord(chord({ metaKey: true, key: "x" }), { key: "b" })).toBe(false);
  });

  it("requires ⌘/Ctrl", () => {
    expect(matchChord(chord({ key: "b" }), { key: "b" })).toBe(false);
    expect(matchChord(chord({ shiftKey: true, key: "b" }), { key: "b" })).toBe(false);
  });

  it("matches Shift/Alt EXACTLY (⌘L ≠ ⌘⇧L ≠ ⌥⌘L)", () => {
    // plain ⌘L requires no Shift and no Alt
    expect(matchChord(chord({ metaKey: true, key: "l" }), { key: "l" })).toBe(true);
    expect(matchChord(chord({ metaKey: true, shiftKey: true, key: "l" }), { key: "l" })).toBe(false);
    expect(matchChord(chord({ metaKey: true, altKey: true, key: "l" }), { key: "l" })).toBe(false);
    // a shift-required chord (⌘⇧G) only fires WITH shift
    expect(matchChord(chord({ metaKey: true, shiftKey: true, key: "g" }), { key: "g", shift: true })).toBe(true);
    expect(matchChord(chord({ metaKey: true, key: "g" }), { key: "g", shift: true })).toBe(false);
  });

  it("matches ANY of `codes` / `keys`, and OR's the two", () => {
    const spec = { codes: ["Equal", "NumpadAdd"], keys: ["+"] };
    expect(matchChord(chord({ metaKey: true, code: "Equal" }), spec)).toBe(true);
    expect(matchChord(chord({ metaKey: true, code: "NumpadAdd" }), spec)).toBe(true);
    // key-only match: the physical code is something else entirely
    expect(matchChord(chord({ metaKey: true, code: "Digit8", key: "+" }), spec)).toBe(true);
    expect(matchChord(chord({ metaKey: true, code: "Digit8", key: "8" }), spec)).toBe(false);
  });

  it('ignores Shift only when asked to (shift: "any")', () => {
    // ⌘+ is ⌘⇧= on a US layout and a bare ⌘= elsewhere — one chord, two shift states.
    const zoomIn = { codes: ["Equal"], shift: "any" as const };
    expect(matchChord(chord({ metaKey: true, code: "Equal" }), zoomIn)).toBe(true);
    expect(matchChord(chord({ metaKey: true, shiftKey: true, code: "Equal" }), zoomIn)).toBe(true);
    // …but Alt still disqualifies, and a shift-agnostic chord stays ⌘-gated
    expect(matchChord(chord({ metaKey: true, altKey: true, code: "Equal" }), zoomIn)).toBe(false);
    expect(matchChord(chord({ code: "Equal" }), zoomIn)).toBe(false);
    // absent the opt-in, Shift is still matched exactly
    expect(matchChord(chord({ metaKey: true, shiftKey: true, code: "Equal" }), { codes: ["Equal"] })).toBe(false);
  });

  it("matches an arrow chord via the PHYSICAL code (⌘⌥↑ / ⌘⌥↓)", () => {
    expect(matchChord(chord({ metaKey: true, altKey: true, code: "ArrowUp" }), { code: "ArrowUp", alt: true })).toBe(true);
    expect(matchChord(chord({ metaKey: true, altKey: true, code: "ArrowDown" }), { code: "ArrowUp", alt: true })).toBe(false);
    // the arrow chords require Alt: bare ⌘↑ must not match
    expect(matchChord(chord({ metaKey: true, code: "ArrowUp" }), { code: "ArrowUp", alt: true })).toBe(false);
  });
});

describe("ACTION_BINDINGS / SHORTCUT_GROUPS", () => {
  it("has a unique chord per action (no two bindings collide)", () => {
    // Compare on BEHAVIOUR, not on the spec's spelling: since a spec can list several codes
    // and keys, two differently-written specs can still answer to the same keystroke — and
    // the App handler runs the FIRST match, so a collision would silently shadow an action.
    // We replay every keystroke each binding claims and require exactly one taker.
    for (const b of ACTION_BINDINGS) {
      for (const e of keystrokesFor(b.spec)) {
        const takers = ACTION_BINDINGS.filter((other) => matchChord(e, other.spec));
        expect(takers.map((t) => t.action), `${b.action} on ${e.code || e.key}`).toEqual([b.action]);
      }
    }
  });

  it("answers the zoom chords on a US layout", () => {
    const bind = (e: ChordEvent) => ACTION_BINDINGS.find((b) => matchChord(e, b.spec))?.action;
    // "=" bare and "+" (Shift+Equal) both zoom in; "-" and "_" both zoom out.
    expect(bind(chord({ metaKey: true, code: "Equal", key: "=" }))).toBe("zoom-in");
    expect(bind(chord({ metaKey: true, shiftKey: true, code: "Equal", key: "+" }))).toBe("zoom-in");
    expect(bind(chord({ metaKey: true, code: "Minus", key: "-" }))).toBe("zoom-out");
    expect(bind(chord({ metaKey: true, shiftKey: true, code: "Minus", key: "_" }))).toBe("zoom-out");
    expect(bind(chord({ metaKey: true, code: "Digit0", key: "0" }))).toBe("zoom-reset");
    // Still ⌘-gated, and Alt still disqualifies.
    expect(bind(chord({ code: "Equal", key: "=" }))).toBeUndefined();
    expect(bind(chord({ metaKey: true, altKey: true, code: "Equal", key: "=" }))).toBeUndefined();
  });

  it("answers them on a FRENCH APPLE layout, where the punctuation codes lie", () => {
    // Regression: the shipped-then-fixed bug. On this layout the key PRINTED "-" reports
    // `code: "Equal"` (QWERTY's "=" position) and "=" lives on `Slash` — so binding the
    // main row by `code` made ⌘- zoom IN (zoom-in is tested first) and left the user with
    // no way to zoom out at all, while ⌘= matched nothing.
    const bind = (e: ChordEvent) => ACTION_BINDINGS.find((b) => matchChord(e, b.spec))?.action;
    expect(bind(chord({ metaKey: true, code: "Equal", key: "-" }))).toBe("zoom-out");
    expect(bind(chord({ metaKey: true, shiftKey: true, code: "Equal", key: "_" }))).toBe("zoom-out");
    expect(bind(chord({ metaKey: true, code: "Slash", key: "=" }))).toBe("zoom-in");
    expect(bind(chord({ metaKey: true, shiftKey: true, code: "Slash", key: "+" }))).toBe("zoom-in");
    // ⌘0 works both ways: the key printed "0" (which types "à" unshifted here), and the
    // shifted digit the user actually reads as zero.
    expect(bind(chord({ metaKey: true, code: "Digit0", key: "à" }))).toBe("zoom-reset");
    expect(bind(chord({ metaKey: true, shiftKey: true, code: "Digit0", key: "0" }))).toBe("zoom-reset");
    // The ")" key (`code: "Minus"` here) must NOT be a zoom chord — it is not printed with
    // any zoom symbol, so it would fire on a keystroke the user never meant as one.
    expect(bind(chord({ metaKey: true, code: "Minus", key: ")" }))).toBeUndefined();
  });

  it("answers the zoom chords on the numeric keypad", () => {
    const bind = (e: ChordEvent) => ACTION_BINDINGS.find((b) => matchChord(e, b.spec))?.action;
    expect(bind(chord({ metaKey: true, code: "NumpadAdd", key: "+" }))).toBe("zoom-in");
    expect(bind(chord({ metaKey: true, code: "NumpadSubtract", key: "-" }))).toBe("zoom-out");
    expect(bind(chord({ metaKey: true, code: "Numpad0", key: "0" }))).toBe("zoom-reset");
  });

  it("binds no main-row punctuation by PHYSICAL code (the layout trap)", () => {
    // The guard that keeps the fix from being undone: a `code` on the main row names a
    // QWERTY position that carries a different character elsewhere, so a zoom chord must
    // never claim one. Only the keypad (stable symbols) and the digit row may.
    const MAIN_ROW_PUNCTUATION = ["Equal", "Minus", "Slash", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Backquote", "BracketLeft", "BracketRight"];
    for (const b of ACTION_BINDINGS) {
      const codes = b.spec.codes ?? (b.spec.code ? [b.spec.code] : []);
      for (const code of codes) {
        expect(MAIN_ROW_PUNCTUATION, `${b.action} binds ${code} positionally`).not.toContain(code);
      }
    }
  });

  it("leaves the view chords alone (⌘1/⌘2/⌘3 are not zoom keys)", () => {
    // ⌘0 sits one key away from ⌘1; a spec matching digits too loosely would eat the view
    // switch, which the App handler resolves BEFORE this table.
    for (const code of ["Digit1", "Digit2", "Digit3"]) {
      const hit = ACTION_BINDINGS.find((b) => matchChord(chord({ metaKey: true, code }), b.spec));
      expect(hit, `${code} must stay a view chord`).toBeUndefined();
    }
  });

  it("every catalogue group is non-empty (the Settings recap renders something)", () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const g of SHORTCUT_GROUPS) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.items.length).toBeGreaterThan(0);
    }
  });
});

describe("isEditableTarget", () => {
  it("treats text inputs, textareas and selects as editable", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
  });

  it("treats a contenteditable element as editable", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    // jsdom derives isContentEditable from the attribute.
    expect(isEditableTarget(el)).toBe(true);
  });

  it("treats a node inside the Monaco editor or the xterm terminal as editable", () => {
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const inner = document.createElement("span");
    monaco.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);

    const term = document.createElement("div");
    term.className = "xterm";
    const cell = document.createElement("span");
    term.appendChild(cell);
    expect(isEditableTarget(cell)).toBe(true);
  });

  it("is false for a plain element and for null (no focus)", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
