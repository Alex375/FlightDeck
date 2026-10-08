// The chain task → project → CRM repositories → local folder.
//
// Three rules earn a test, because getting any of them wrong is invisible on screen and
// wrong where it matters: archived repositories must not manufacture a choice, a pin must
// beat the automatic match, and "we could not read TOSSE" must never be reported as "this
// project has no folder".

import { describe, expect, it } from "vitest";
import type { Repo } from "../../store/conversationsStore";
import type { TosseProjectRepo, TosseRepoLink, TosseRepoLinksPayload, TosseRepository } from "../../ipc/client";
import { dialogPinsDefault, foldersForProject, launchTarget, resolveTaskFolder, taskPlaces } from "./taskFolder";

const repos: Repo[] = [
  { id: "r1", path: "/Users/dev/one", addedAt: 1 },
  { id: "r2", path: "/Users/dev/two", addedAt: 2 },
];

function repository(id: string, projectIds: string[], status = "Actif"): TosseRepository {
  return {
    id,
    name: id,
    url: `https://github.com/x/${id}`,
    host: "github",
    status,
    context: null,
    projects: projectIds.map((p) => ({ id: p, name: p, status: "En cours" })),
  };
}

function link(repoId: string, repository: TosseRepository | null): TosseRepoLink {
  return {
    repoId,
    resolved: true,
    remoteUrl: repository?.url ?? null,
    repository,
    source: repository ? "remote" : null,
    manualRepositoryId: null,
    ambiguous: [],
    notARepository: false,
    remoteError: null,
    machine: null,
  };
}

function payload(links: TosseRepoLink[], error: string | null = null): TosseRepoLinksPayload {
  return { connected: true, links, repositories: [], error };
}

const pin = (projectId: string, repoId: string): TosseProjectRepo => ({
  project_id: projectId,
  repo_id: repoId,
});

describe("foldersForProject", () => {
  it("finds the folders whose CRM repository belongs to the project", () => {
    const p = payload([
      link("r1", repository("crm-1", ["proj-a"])),
      link("r2", repository("crm-2", ["proj-b"])),
    ]);
    expect(foldersForProject(p, "proj-a")).toEqual(["r1"]);
    expect(foldersForProject(p, "proj-b")).toEqual(["r2"]);
  });

  // Measured on real data: keeping archived rows turned single answers into fake
  // multiple-choice questions, which is a dialog the user should never have seen.
  it("ignores archived repositories", () => {
    const p = payload([
      link("r1", repository("crm-old", ["proj-a"], "Archivé")),
      link("r2", repository("crm-new", ["proj-a"])),
    ]);
    expect(foldersForProject(p, "proj-a")).toEqual(["r2"]);
  });

  it("deduplicates on the FOLDER, not on the CRM row", () => {
    // The CRM legitimately holds several repository rows for one clone. They are one
    // choice, not two.
    const p = payload([link("r1", repository("crm-dup", ["proj-a"]))]);
    expect(foldersForProject(p, "proj-a")).toEqual(["r1"]);
  });

  it("answers nothing for a missing payload or project", () => {
    expect(foldersForProject(undefined, "proj-a")).toEqual([]);
    expect(foldersForProject(payload([]), null)).toEqual([]);
  });
});

describe("resolveTaskFolder", () => {
  it("resolves a single matching folder", () => {
    const got = resolveTaskFolder([], payload([link("r1", repository("c", ["proj-a"]))]), "proj-a", repos);
    expect(got).toMatchObject({ repoId: "r1", source: "derived", checked: true });
  });

  it("asks when several folders match", () => {
    const got = resolveTaskFolder(
      [],
      payload([
        link("r1", repository("c1", ["proj-a"])),
        link("r2", repository("c2", ["proj-a"])),
      ]),
      "proj-a",
      repos,
    );
    expect(got.repoId).toBeNull();
    expect(got.candidates).toEqual(["r1", "r2"]);
  });

  // The whole point of asking once: the answer given then must never be overridden by
  // the automatic match afterwards.
  it("lets a pin beat the automatic match", () => {
    const got = resolveTaskFolder(
      [pin("proj-a", "r2")],
      payload([link("r1", repository("c1", ["proj-a"]))]),
      "proj-a",
      repos,
    );
    expect(got).toMatchObject({ repoId: "r2", source: "pin" });
  });

  it("ignores a pin whose folder is no longer registered", () => {
    const got = resolveTaskFolder([pin("proj-a", "gone")], payload([]), "proj-a", repos);
    expect(got.repoId).toBeNull();
  });

  // ⚠️ "We could not look" must stay distinguishable from "we looked and found nothing":
  // the dialog says a different sentence, and a pin still resolves in that state.
  it("reports an unreadable CRM as unchecked, without inventing an answer", () => {
    const failed = payload([], "TOSSE is unreachable");
    expect(resolveTaskFolder([], failed, "proj-a", repos)).toMatchObject({
      repoId: null,
      checked: false,
    });
    expect(resolveTaskFolder([pin("proj-a", "r1")], failed, "proj-a", repos)).toMatchObject({
      repoId: "r1",
      source: "pin",
      checked: false,
    });
  });

  it("is unchecked while the payload has not loaded", () => {
    expect(resolveTaskFolder([], undefined, "proj-a", repos).checked).toBe(false);
  });
});

// The same project cloned on this Mac AND on a paired server — the case the Start button's
// drop-down exists for. Every fixture above is local-only (`machine: null`).
describe("a project that lives in several places", () => {
  const multi: Repo[] = [
    { id: "srv-b", path: "/home/alex/work/app", addedAt: 3, machineId: "m-base" },
    { id: "mac", path: "/Users/dev/app", addedAt: 1 },
    { id: "srv-a", path: "/srv/app", addedAt: 4, machineId: "m-atlas" },
    { id: "orphan", path: "/opt/app", addedAt: 5, machineId: "m-gone" },
    { id: "mac-2", path: "/Users/dev/app-copy", addedAt: 2 },
  ];
  const machines = [
    { id: "m-base", label: "Base" },
    { id: "m-atlas", label: "atlas" },
  ];
  const everywhere = payload(
    ["srv-b", "mac", "srv-a", "orphan", "mac-2"].map((id) => link(id, repository("crm", ["proj-a"]))),
  );

  // Decision of 01/10: with several places and no pin, the first Start ASKS — the answer
  // then becomes the default. Guessing "the Mac" would run work on the wrong machine.
  it("asks when the project is on this Mac and on a server, with no pin", () => {
    const got = resolveTaskFolder(
      [],
      payload([link("mac", repository("c", ["proj-a"])), link("srv-b", repository("c", ["proj-a"]))]),
      "proj-a",
      multi,
    );
    expect(got.repoId).toBeNull();
    expect(got.candidates).toEqual(["mac", "srv-b"]);
  });

  it("starts on the server when the server is the pinned default", () => {
    const got = resolveTaskFolder([pin("proj-a", "srv-b")], everywhere, "proj-a", multi);
    expect(got).toMatchObject({ repoId: "srv-b", source: "pin" });
  });

  it("lists this Mac first, then servers by name, then unpaired ones — whatever the default", () => {
    const resolution = resolveTaskFolder([pin("proj-a", "srv-a")], everywhere, "proj-a", multi);
    const places = taskPlaces(resolution, multi, machines);
    expect(places.map((p) => p.repoId)).toEqual(["mac", "mac-2", "srv-a", "srv-b", "orphan"]);
    expect(places.filter((p) => p.isDefault).map((p) => p.repoId)).toEqual(["srv-a"]);
    expect(places.find((p) => p.repoId === "orphan")?.machineId).toBe("m-gone");
    expect(places.find((p) => p.repoId === "mac")?.machineId).toBeNull();
  });

  it("has no default to mark when nothing resolves", () => {
    const resolution = resolveTaskFolder([], everywhere, "proj-a", multi);
    expect(taskPlaces(resolution, multi, machines).some((p) => p.isDefault)).toBe(false);
  });

  // A pin is the user's own answer and may name a folder the CRM does not match. It is
  // still where Start runs, so it has to be on offer — and marked as the default.
  it("includes a pinned folder the CRM does not match", () => {
    const resolution = resolveTaskFolder(
      [pin("proj-a", "srv-b")],
      payload([link("mac", repository("c", ["proj-a"]))]),
      "proj-a",
      multi,
    );
    expect(taskPlaces(resolution, multi, machines)).toEqual([
      { repoId: "mac", path: "/Users/dev/app", machineId: null, isDefault: false },
      { repoId: "srv-b", path: "/home/alex/work/app", machineId: "m-base", isDefault: true },
    ]);
  });
});

// The rule that keeps a project's default from ping-ponging between machines: picking a
// place for ONE run must never move it, except to give a project its first default.
describe("launchTarget", () => {
  const regs = [{ id: "mac" }, { id: "srv" }];
  const withDefault = { repoId: "mac", source: "pin" as const, candidates: ["mac", "srv"], checked: true };
  const noDefault = { repoId: null, source: null, candidates: ["mac", "srv"], checked: true };

  it("runs in the default when no place was picked", () => {
    expect(launchTarget(withDefault, regs, "p")).toEqual({ repoId: "mac", rememberAsDefault: false });
    expect(launchTarget(noDefault, regs, "p")).toEqual({ repoId: null, rememberAsDefault: false });
  });

  it("runs in a picked place for this run only when a default exists", () => {
    expect(launchTarget(withDefault, regs, "p", "srv")).toEqual({ repoId: "srv", rememberAsDefault: false });
  });

  it("remembers the first answer when the project has no default yet", () => {
    expect(launchTarget(noDefault, regs, "p", "srv")).toEqual({ repoId: "srv", rememberAsDefault: true });
  });

  it("has nothing to remember for a task outside any project", () => {
    expect(launchTarget(noDefault, regs, null, "srv")).toEqual({ repoId: "srv", rememberAsDefault: false });
  });

  // ⚠️ Not the default: the user just chose somewhere ELSE, so falling back to it would
  // quietly run the work on the machine they did not pick.
  it("asks again when the picked place was unregistered since the menu opened", () => {
    expect(launchTarget(withDefault, regs, "p", "gone")).toEqual({ repoId: null, rememberAsDefault: false });
  });
});

describe("dialogPinsDefault", () => {
  it("does not move the default for a one-off launch elsewhere", () => {
    expect(dialogPinsDefault("p", false, "srv", "mac")).toBe(false);
  });

  it("pins when the user asks for it (or the project has no default yet)", () => {
    expect(dialogPinsDefault("p", true, "srv", "mac")).toBe(true);
    expect(dialogPinsDefault("p", true, "srv", null)).toBe(true);
  });

  it("writes nothing when the folder already is the default, or there is no project", () => {
    expect(dialogPinsDefault("p", true, "mac", "mac")).toBe(false);
    expect(dialogPinsDefault(null, true, "srv", null)).toBe(false);
  });
});
