import { describe, expect, it, vi } from "vitest";
import { chordLabel } from "./platform";

/** The module as a webview with this user agent loads it (its constants are read at import). */
async function loadAs(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  try {
    return await import("./platform");
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("MACHINE and PLUS_SIGN", () => {
  it("a Mac keeps its words and the full-width plus", async () => {
    const p = await loadAs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect(p.MACHINE).toBe("Mac");
    expect(p.PLUS_SIGN).toBe("＋");
  });

  it("Linux says computer, with a plus every font has", async () => {
    const p = await loadAs("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect(p.MACHINE).toBe("computer");
    expect(p.PLUS_SIGN).toBe("+");
  });
});

describe("chordLabel", () => {
  it("a Mac keeps the label byte for byte", () => {
    for (const label of ["⌘⇧M", "⌘ B", "⌘⌥ ↑ / ⌘⌥ ↓", "⌘↵", "⌘ + / ⌘ −", "Same as ⌘J."]) {
      expect(chordLabel(label, true)).toBe(label);
    }
  });

  it("elsewhere: Ctrl/Shift/Alt spelled out, joined with +", () => {
    expect(chordLabel("⌘⇧M", false)).toBe("Ctrl+Shift+M");
    expect(chordLabel("⌘ B", false)).toBe("Ctrl+B");
    expect(chordLabel("⌘⇧ O", false)).toBe("Ctrl+Shift+O");
    expect(chordLabel("⌘⌥ ↑ / ⌘⌥ ↓", false)).toBe("Ctrl+Alt+↑ / Ctrl+Alt+↓");
    expect(chordLabel("⌘ G / ⌘⇧ G", false)).toBe("Ctrl+G / Ctrl+Shift+G");
    expect(chordLabel("⌘ ,", false)).toBe("Ctrl+,");
    expect(chordLabel("⌘ + / ⌘ −", false)).toBe("Ctrl++ / Ctrl+−");
    expect(chordLabel("⌘↵", false)).toBe("Ctrl+Enter");
    expect(chordLabel("⌘⏎ to add", false)).toBe("Ctrl+Enter to add");
    expect(chordLabel("⇧Tab to change", false)).toBe("Shift+Tab to change");
    expect(chordLabel("⇧ ⇥", false)).toBe("Shift+Tab");
    expect(chordLabel("Previous match (⇧↵)", false)).toBe("Previous match (Shift+Enter)");
  });

  it("inside a sentence, only the chord changes", () => {
    expect(chordLabel("Delete conversation (⌘Z to undo)", false)).toBe("Delete conversation (Ctrl+Z to undo)");
    expect(chordLabel("Same as ⌘⇧G.", false)).toBe("Same as Ctrl+Shift+G.");
  });
});
