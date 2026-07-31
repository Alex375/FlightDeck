import { describe, expect, it } from "vitest";
import { badgeStateFor } from "./TosseRepoBadge";
import { orderForPicker } from "./TosseRepoCard";
import type { TosseRepository } from "../../ipc/client";

const link = (over: Partial<Parameters<typeof badgeStateFor>[0]> = {}) => ({
  repository: null,
  ambiguous: [],
  manualRepositoryId: null,
  ...over,
});

describe("badgeStateFor", () => {
  it("is linked when a repository resolved", () => {
    expect(badgeStateFor(link({ repository: { id: "r" } }))).toBe("linked");
  });

  it("is unlinked for a folder that simply matches nothing", () => {
    expect(badgeStateFor(link())).toBe("unlinked");
    // No entry at all (repo added after the last fetch) reads the same way — the badge
    // must never claim a link it has not seen.
    expect(badgeStateFor(undefined)).toBe("unlinked");
  });

  it("asks for attention when several repositories match the same remote", () => {
    expect(badgeStateFor(link({ ambiguous: [{ id: "a" }, { id: "b" }] }))).toBe("attention");
  });

  it("asks for attention when a pinned repository no longer resolves", () => {
    // The user made a choice and it is now broken: hiding this behind the plain
    // "unlinked" state would silently discard their decision.
    expect(badgeStateFor(link({ manualRepositoryId: "gone" }))).toBe("attention");
  });
});

const repo = (name: string): TosseRepository => ({
  id: name,
  name,
  url: null,
  host: null,
  status: null,
  context: null,
  projects: [],
});

describe("orderForPicker", () => {
  it("floats the repositories whose name resembles the folder, then sorts by name", () => {
    const list = [repo("zeta"), repo("alpha"), repo("tosse-code")];
    expect(orderForPicker(list, "tosse-code").map((r) => r.name)).toEqual([
      "tosse-code",
      "alpha",
      "zeta",
    ]);
  });

  it("matches across the punctuation the two systems disagree on", () => {
    // Real pair: the folder is `landing_page`, the CRM calls it `landing-page-josty`.
    const list = [repo("zeta"), repo("landing-page-josty")];
    expect(orderForPicker(list, "landing_page")[0].name).toBe("landing-page-josty");
  });

  it("is alphabetical when nothing resembles the folder", () => {
    const list = [repo("zeta"), repo("alpha")];
    expect(orderForPicker(list, "unrelated").map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });

  it("puts the currently linked repository first, whatever its name", () => {
    // It is the one the user is most likely to look for (to confirm or to change),
    // and by name alone it would sink to the bottom.
    const list = [repo("alpha"), repo("zeta")];
    expect(orderForPicker(list, "alpha", "zeta").map((r) => r.name)).toEqual(["zeta", "alpha"]);
  });

  it("does not mutate the list it is given", () => {
    const list = [repo("zeta"), repo("alpha")];
    orderForPicker(list, "alpha");
    expect(list.map((r) => r.name)).toEqual(["zeta", "alpha"]);
  });
});
