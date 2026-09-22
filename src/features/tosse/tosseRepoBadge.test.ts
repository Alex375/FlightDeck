import { describe, expect, it } from "vitest";
import { badgeStateFor } from "./TosseRepoBadge";
import { orderForPicker, whyUnmatched } from "./TosseRepoCard";
import type { TosseRepoLink, TosseRepository } from "../../ipc/client";

const link = (over: Partial<Parameters<typeof badgeStateFor>[0]> = {}) => ({
  resolved: true,
  repository: null,
  ambiguous: [],
  manualRepositoryId: null,
  remoteError: null,
  machine: null,
  ...over,
});

describe("badgeStateFor", () => {
  it("is linked when a repository resolved", () => {
    expect(badgeStateFor(link({ repository: { id: "r" } }))).toBe("linked");
  });

  it("is unlinked for a folder that simply matches nothing", () => {
    expect(badgeStateFor(link())).toBe("unlinked");
  });

  it("asks for attention when several repositories match the same remote", () => {
    expect(badgeStateFor(link({ ambiguous: [{ id: "a" }, { id: "b" }] }))).toBe("attention");
  });

  it("asks for attention when a pinned repository no longer resolves", () => {
    // The user made a choice and it is now broken: hiding this behind the plain
    // "unlinked" state would silently discard their decision.
    expect(badgeStateFor(link({ manualRepositoryId: "gone" }))).toBe("attention");
  });

  it("asks for attention when the folder's git remote could not be read", () => {
    // A broken checkout is a real problem, and a different one from "no remote" — the
    // hollow "associate me" mark would send the user to fix the wrong thing.
    expect(badgeStateFor(link({ remoteError: "fatal: not a git repository" }))).toBe("attention");
  });

  // ── The regression the adversarial review caught: an unread CRM list is not evidence ──

  it("does not raise attention on a pinned folder when the CRM list was never read", () => {
    // Same shape as a genuinely deleted repository (`repository: null` + a surviving pin),
    // but here nothing was checked. Flagging it turned a 30-second outage into a warning
    // that pushed the user toward destroying a valid association.
    expect(badgeStateFor(link({ resolved: false, manualRepositoryId: "r-picked" }))).toBe(
      "unknown",
    );
  });

  it("stays quiet on an unpinned folder when the CRM list was never read", () => {
    // Nothing is known, and nothing is claimed — no invitation to associate either, since
    // the picker could not be populated anyway.
    expect(badgeStateFor(link({ resolved: false }))).toBe("unlinked");
  });

  it("does not flag a folder that lives on a paired server", () => {
    // The bug: this Mac's git was run on a path that only exists on the server, failed with
    // "cannot change to …" — indistinguishable from a deleted folder — and the badge showed
    // a warning on a repository whose remote matches the CRM perfectly. No automatic match
    // is possible from here, which is an ordinary limit, not a fault.
    expect(badgeStateFor(link({ machine: { id: "m1", label: "tower" } }))).toBe("unlinked");
  });

  it("still shows a repository pinned by hand on a remote folder", () => {
    // The manual pin is pure local SQLite, so it works over there exactly as it does here.
    expect(
      badgeStateFor(link({ machine: { id: "m1", label: "tower" }, repository: { id: "r" } })),
    ).toBe("linked");
  });

  it("is unknown for a folder with no entry at all", () => {
    // A repo added since the last fetch: we have not looked at it, so we say nothing
    // about it — least of all that it has no git remote.
    expect(badgeStateFor(undefined)).toBe("unknown");
  });
});

describe("whyUnmatched", () => {
  const cardLink = (over: Partial<TosseRepoLink> = {}): TosseRepoLink =>
    ({
      repoId: "r",
      resolved: true,
      remoteUrl: null,
      repository: null,
      source: null,
      manualRepositoryId: null,
      ambiguous: [],
      notARepository: false,
      remoteError: null,
      machine: null,
      ...over,
    }) as TosseRepoLink;

  it("names the server, instead of claiming the folder has no git remote", () => {
    // It has one — we simply never read it, because the path lives on that machine. Saying
    // "no git remote" sent the user hunting for a remote that is right there.
    const said = whyUnmatched(cardLink({ machine: { id: "m1", label: "tower" } }));
    expect(said).toContain("tower");
    expect(said).toContain("pick a TOSSE repository by hand");
    expect(said).not.toContain("no git remote");
  });

  it("does not pass an un-paired server off as this Mac", () => {
    // Only the id survives on the folder. The folder is still over there, and the sentence
    // must not quietly become the local one.
    expect(whyUnmatched(cardLink({ machine: { id: "m1", label: null } }))).toContain(
      "no longer paired",
    );
  });

  it("keeps the local answers it already gave", () => {
    expect(whyUnmatched(cardLink({ notARepository: true }))).toContain("not a git repository");
    expect(whyUnmatched(cardLink({ remoteError: "fatal: …" }))).toContain("could not be read");
    expect(whyUnmatched(cardLink({ remoteUrl: "git@github.com:a/b.git" }))).toContain(
      "git@github.com:a/b.git",
    );
    expect(whyUnmatched(cardLink())).toContain("has no git remote");
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
