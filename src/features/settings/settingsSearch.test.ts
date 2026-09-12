import { describe, it, expect } from "vitest";
import { SETTINGS_INDEX, SETTINGS_SUBS, searchSettings } from "./settingsSearch";

describe("the settings index", () => {
  // A result that lands on a sub-tab nobody renders leaves the user on an empty
  // page — the one failure mode of this feature that isn't self-evident.
  it("only points at sub-tabs the panel actually renders", () => {
    for (const entry of SETTINGS_INDEX) {
      const subs = SETTINGS_SUBS[entry.section];
      if (entry.sub) {
        expect(subs, `${entry.title}: section "${entry.section}" has no sub-tabs`).toBeDefined();
        expect(subs, `${entry.title}: unknown sub-tab "${entry.sub}"`).toContain(entry.sub);
      }
    }
  });

  it("gives every sectioned entry a sub-tab where the section has them", () => {
    for (const entry of SETTINGS_INDEX) {
      if (SETTINGS_SUBS[entry.section]) {
        expect(entry.sub, `${entry.title} needs a sub-tab`).toBeTruthy();
      }
    }
  });

  it("has no duplicate destinations", () => {
    const keys = SETTINGS_INDEX.map((e) => `${e.section}/${e.sub ?? ""}/${e.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("searchSettings", () => {
  it("finds a setting by its title, ranking title hits first", () => {
    const [first] = searchSettings("wake phrase");
    expect(first?.title).toBe("Wake phrase");
  });

  it("finds settings by keyword, including the French word", () => {
    expect(searchSettings("voix").map((e) => e.title)).toContain("Voice");
    expect(searchSettings("veille").map((e) => e.title)).toContain("Keep the Mac awake");
    expect(searchSettings("raccourcis").map((e) => e.title)).toContain("Keyboard shortcuts");
  });

  it("ignores accents in both directions", () => {
    expect(searchSettings("reflexion").map((e) => e.title)).toContain("Thinking time");
    expect(searchSettings("réflexion").map((e) => e.title)).toContain("Thinking time");
  });

  it("narrows with every extra term instead of widening", () => {
    const broad = searchSettings("voice");
    const narrow = searchSettings("voice threshold");
    expect(narrow.length).toBeLessThan(broad.length);
    expect(narrow[0]?.title).toBe("Voice detection threshold");
  });

  it("returns nothing for an empty query or a word nobody indexed", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("routes the voice-prompt search to the voice sub-tab", () => {
    const hit = searchSettings("prompt").find((e) => e.title === "What the agent is told");
    expect(hit?.section).toBe("control");
    expect(hit?.sub).toBe("voice");
  });
});
