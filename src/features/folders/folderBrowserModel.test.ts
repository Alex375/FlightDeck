import { describe, expect, it } from "vitest";
import {
  baseName,
  filterFolders,
  filterRepos,
  folderNameProblem,
  joinDir,
  looksLikePath,
  parentDir,
  pathCrumbs,
  repoEntries,
  resolveTypedPath,
  sortFolders,
  tildePath,
} from "./folderBrowserModel";

const HOME = "/home/alex";

describe("paths", () => {
  it("parentDir climbs to the root and stops there", () => {
    expect(parentDir("/home/alex/code")).toBe("/home/alex");
    expect(parentDir("/home/alex/code/")).toBe("/home/alex");
    expect(parentDir("/srv")).toBe("/");
    expect(parentDir("/")).toBeNull();
    expect(parentDir("")).toBeNull();
  });

  it("joinDir and baseName", () => {
    expect(joinDir("/", "srv")).toBe("/srv");
    expect(joinDir("/home/alex/", "code")).toBe("/home/alex/code");
    expect(baseName("/home/alex/code")).toBe("code");
    expect(baseName("/")).toBe("/");
  });

  it("tildePath shortens only what is below the home", () => {
    expect(tildePath(HOME, HOME)).toBe("~");
    expect(tildePath(`${HOME}/code/app`, HOME)).toBe("~/code/app");
    expect(tildePath("/home/alexandra", HOME)).toBe("/home/alexandra");
    expect(tildePath("/srv", HOME)).toBe("/srv");
    expect(tildePath("/srv", null)).toBe("/srv");
  });
});

describe("pathCrumbs", () => {
  it("starts at the home for a path below it", () => {
    expect(pathCrumbs(`${HOME}/code/app`, HOME)).toEqual([
      { label: "~", path: HOME, home: true },
      { label: "code", path: `${HOME}/code` },
      { label: "app", path: `${HOME}/code/app` },
    ]);
    expect(pathCrumbs(HOME, HOME)).toEqual([{ label: "~", path: HOME, home: true }]);
  });

  it("starts at the root otherwise", () => {
    expect(pathCrumbs("/srv/data", HOME)).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "data", path: "/srv/data" },
    ]);
    expect(pathCrumbs("/", HOME)).toEqual([{ label: "/", path: "/" }]);
    expect(pathCrumbs("/home", HOME)).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
    ]);
  });
});

describe("typed paths", () => {
  it("tells a path from a filter", () => {
    expect(looksLikePath("/srv")).toBe(true);
    expect(looksLikePath("~")).toBe(true);
    expect(looksLikePath("~/code")).toBe(true);
    expect(looksLikePath("  /srv ")).toBe(true);
    expect(looksLikePath("code")).toBe(false);
    expect(looksLikePath("~code")).toBe(false);
  });

  it("expands the home and folds . and ..", () => {
    expect(resolveTypedPath("~", HOME)).toBe(HOME);
    expect(resolveTypedPath("~/code/", HOME)).toBe(`${HOME}/code`);
    expect(resolveTypedPath("/srv//data/./x/..", HOME)).toBe("/srv/data");
    expect(resolveTypedPath("/..", HOME)).toBe("/");
    expect(resolveTypedPath("code", HOME)).toBeNull();
  });

  it("can't place ~ before the home is known", () => {
    expect(resolveTypedPath("~/code", null)).toBeNull();
    expect(resolveTypedPath("/srv", null)).toBe("/srv");
  });
});

describe("filter and sort", () => {
  it("sorts case-insensitively, numbers by value", () => {
    expect(sortFolders(["b", "exp-10", "A", "exp-2"])).toEqual(["A", "b", "exp-2", "exp-10"]);
  });

  it("keeps names holding the text, the ones starting with it first, with where it matched", () => {
    expect(filterFolders(["my-app", "apps", "docs", "App"], "app")).toEqual([
      { name: "apps", at: 0, length: 3 },
      { name: "App", at: 0, length: 3 },
      { name: "my-app", at: 3, length: 3 },
    ]);
    expect(filterFolders(["a", "b"], "  ")).toEqual([
      { name: "a", at: -1, length: 0 },
      { name: "b", at: -1, length: 0 },
    ]);
  });

  it("finds repositories by name first, then by where they are", () => {
    const repos = repoEntries([`${HOME}/code/api`, "/srv/web", `${HOME}/api-old/site`], HOME);
    expect(repos[0]).toEqual({ path: `${HOME}/code/api`, name: "api", where: "~/code" });
    expect(filterRepos(repos, "api").map((r) => r.name)).toEqual(["api", "site"]);
    expect(filterRepos(repos, "srv").map((r) => r.name)).toEqual(["web"]);
  });
});

describe("folderNameProblem", () => {
  it("accepts a plain name, and says nothing about an empty one", () => {
    expect(folderNameProblem("my-app", ["docs"])).toBeNull();
    expect(folderNameProblem("   ", [])).toBeNull();
  });

  it("refuses a slash, a reserved name, a taken one and an overlong one", () => {
    expect(folderNameProblem("a/b", [])).toMatch(/“\/”/);
    expect(folderNameProblem("..", [])).toMatch(/reserved/);
    expect(folderNameProblem("docs", ["docs"])).toMatch(/already here/);
    expect(folderNameProblem("é".repeat(128), [])).toMatch(/too long/);
  });
});
