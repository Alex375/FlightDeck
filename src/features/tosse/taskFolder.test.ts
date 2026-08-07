// The chain task → project → CRM repositories → local folder.
//
// Three rules earn a test, because getting any of them wrong is invisible on screen and
// wrong where it matters: archived repositories must not manufacture a choice, a pin must
// beat the automatic match, and "we could not read TOSSE" must never be reported as "this
// project has no folder".

import { describe, expect, it } from "vitest";
import type { Repo } from "../../store/conversationsStore";
import type { TosseProjectRepo, TosseRepoLink, TosseRepoLinksPayload, TosseRepository } from "../../ipc/client";
import { foldersForProject, resolveTaskFolder } from "./taskFolder";

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
