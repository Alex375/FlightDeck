import { afterEach, describe, it, expect, vi } from "vitest";
import { resolveCleanOutput } from "./display";

/** The store reads localStorage ONCE, at module load — so each case has to boot a fresh
 *  copy of the module against the storage it wants to describe. */
async function bootWith(stored: object | null) {
  localStorage.clear();
  if (stored) localStorage.setItem("tosse:display", JSON.stringify(stored));
  vi.resetModules();
  const { useDisplay } = await import("./display");
  return useDisplay.getState();
}

describe("client favicons default", () => {
  afterEach(() => localStorage.clear());

  // Flipped ON on 2026-08-07. Shipped OFF, the client marks read as broken rather than as
  // a decision anyone had made — the CRM's own page resolves the same favicons for the
  // same person, so the app was withholding marks the browser already shows. The switch
  // (Settings → TOSSE) is what carries the privacy choice; the default no longer does.
  it("is ON on a fresh install", async () => {
    expect((await bootWith(null)).tosseClientFavicons).toBe(true);
  });

  // The case that made the flip WORK for existing installs: a blob written before this
  // pref existed omits the key entirely, so `load()`'s merge over DEFAULTS is what decides
  // — and that is every install that has not touched a preference since the TOSSE release.
  it("takes the new default when a stored blob predates the pref", async () => {
    const old = { cleanOutput: true, markdownMode: "warm", clickableFileMentions: false };
    const state = await bootWith(old);
    expect(state.tosseClientFavicons).toBe(true);
    // …without trampling what that blob DID say.
    expect(state.clickableFileMentions).toBe(false);
  });

  // And the case the flip must NOT override: someone who switched it off on purpose stays
  // off. `false` is a value, not an absence — a merge that treated it as one would turn
  // the setting back on under them at every launch.
  it("respects an explicit opt-out", async () => {
    expect((await bootWith({ tosseClientFavicons: false })).tosseClientFavicons).toBe(false);
  });
});

describe("resolveCleanOutput — per-conversation tristate", () => {
  it("inherits the global default when there is no override (null)", () => {
    expect(resolveCleanOutput(null, true)).toBe(true);
    expect(resolveCleanOutput(null, false)).toBe(false);
  });

  it("an explicit override wins over the global default", () => {
    // Opt IN even though the default is off…
    expect(resolveCleanOutput(true, false)).toBe(true);
    // …and, crucially, opt OUT even though the default is on.
    expect(resolveCleanOutput(false, true)).toBe(false);
  });
});
