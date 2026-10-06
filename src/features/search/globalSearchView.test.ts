import { describe, expect, it } from "vitest";
import { flatRows, highlightSegments, hintFromPreview, isUnder, searchRoots, splitPath } from "./globalSearchView";

describe("isUnder", () => {
  it("matches on a path boundary only", () => {
    expect(isUnder("/a/repo", "/a/repo")).toBe(true);
    expect(isUnder("/a/repo/src/x.ts", "/a/repo")).toBe(true);
    expect(isUnder("/a/repo/src", "/a/repo/")).toBe(true);
    expect(isUnder("/a/repo2/x", "/a/repo")).toBe(false);
  });
});

describe("searchRoots", () => {
  const label = (id: string) => (id === "m1" ? "box" : null);

  it("ticks every local repository by default, honours unticks, and greys remote ones with a reason", () => {
    const { chips, roots } = searchRoots(
      [
        { id: "a", path: "/w/a" },
        { id: "b", path: "/w/b" },
        { id: "r", path: "/home/u/r", machineId: "m1" },
        { id: "d", path: "." },
      ],
      ["b"],
      [],
      label,
    );
    expect(roots).toEqual(["/w/a"]);
    expect(chips.find((c) => c.key === "b")?.on).toBe(false);
    expect(chips.find((c) => c.key === "r")?.disabledReason).toMatch(/box/);
    expect(chips.find((c) => c.key === "r")?.on).toBe(false);
    expect(chips.find((c) => c.key === "d")?.disabledReason).toBeTruthy();
  });

  it("appends added folders, skipping one that duplicates a repository", () => {
    const { chips, roots } = searchRoots(
      [{ id: "a", path: "/w/a" }],
      [],
      [
        { path: "/w/a", on: true },
        { path: "/other", on: true },
        { path: "/off", on: false },
      ],
      label,
    );
    expect(chips.map((c) => c.path)).toEqual(["/w/a", "/other", "/off"]);
    expect(roots).toEqual(["/w/a", "/other"]);
  });
});

describe("highlightSegments", () => {
  it("splits around hits, merging overlaps and clamping out-of-range spans", () => {
    expect(highlightSegments("hello world", [{ start: 6, end: 11 }, { start: 0, end: 2 }, { start: 1, end: 4 }])).toEqual([
      { text: "hell", hit: true },
      { text: "o ", hit: false },
      { text: "world", hit: true },
    ]);
    expect(highlightSegments("abc", [{ start: 2, end: 99 }])).toEqual([
      { text: "ab", hit: false },
      { text: "c", hit: true },
    ]);
  });
});

describe("flatRows", () => {
  it("lists hit rows in screen order, skipping collapsed groups and sections", () => {
    const rows = flatRows([2, 1], [1], new Set(["conv:1"]));
    expect(rows).toEqual([
      { kind: "conv", group: 0, hit: 0 },
      { kind: "conv", group: 0, hit: 1 },
      { kind: "file", group: 0, hit: 0 },
    ]);
    expect(flatRows([2], [1], new Set(["section:conv"]))).toEqual([{ kind: "file", group: 0, hit: 0 }]);
  });
});

describe("misc", () => {
  it("splits a relative path", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", name: "b.ts" });
    expect(splitPath("b.ts")).toEqual({ dir: "", name: "b.ts" });
  });

  it("derives the context around the first hit, without the ellipses", () => {
    expect(hintFromPreview("…before HIT after…", [{ start: 8, end: 11 }])).toEqual({ before: "before ", after: " after" });
    expect(hintFromPreview("x", [])).toBeNull();
  });
});
