import { describe, expect, it } from "vitest";

import { countChanges, diffLines, hasChanges, withElisions } from "./lineDiff";

const kinds = (before: string, after: string) => diffLines(before, after).map((l) => l.kind);
const shown = (before: string, after: string) =>
  diffLines(before, after).map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);

describe("line diff", () => {
  it("marks an added line", () => {
    expect(shown("a\nb", "a\nnew\nb")).toEqual([" a", "+new", " b"]);
  });

  it("KEEPS a removed line, marked as removed", () => {
    // The whole point: a line about to disappear from the file stays on screen until the
    // user saves, so nothing is deleted unnoticed.
    expect(shown("a\ngone\nb", "a\nb")).toEqual([" a", "-gone", " b"]);
    expect(countChanges(diffLines("a\ngone\nb", "a\nb"))).toEqual({ added: 0, removed: 1 });
  });

  it("shows a replacement as a removal then an addition", () => {
    expect(shown("keep\nold", "keep\nnew")).toEqual([" keep", "-old", "+new"]);
  });

  it("treats an empty before as all additions", () => {
    expect(kinds("", "one\ntwo")).toEqual(["add", "add"]);
  });

  it("treats an empty after as all removals", () => {
    // Clearing the block must show every line it would take with it.
    expect(kinds("one\ntwo", "")).toEqual(["del", "del"]);
  });

  it("ignores a trailing-newline-only difference", () => {
    expect(hasChanges(diffLines("a\nb", "a\nb\n"))).toBe(false);
    expect(hasChanges(diffLines("a\nb\n\n", "a\nb"))).toBe(false);
  });

  it("reports no changes for identical text", () => {
    expect(hasChanges(diffLines("same\nlines", "same\nlines"))).toBe(false);
    expect(countChanges(diffLines("same", "same"))).toEqual({ added: 0, removed: 0 });
  });

  it("finds the common run rather than rewriting the whole block", () => {
    const before = "l1\nl2\nl3\nl4\nl5";
    const after = "l1\nl2\nCHANGED\nl4\nl5";
    expect(countChanges(diffLines(before, after))).toEqual({ added: 1, removed: 1 });
  });

  it("handles a moved-looking edit without exploding", () => {
    const d = diffLines("a\nb\nc", "c\nb\na");
    expect(countChanges(d).added).toBeGreaterThan(0);
    expect(d.filter((l) => l.kind === "same").length).toBeGreaterThan(0);
  });

  describe("elision", () => {
    it("collapses long unchanged runs to context lines", () => {
      const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
      const after = before.replace("line 20", "line 20 edited");
      const rows = withElisions(diffLines(before, after));
      // One gap above and one below the edit, rather than 38 identical lines.
      expect(rows.filter((r) => r === null)).toHaveLength(2);
      expect(rows.length).toBeLessThan(15);
      expect(rows.some((r) => r?.text === "line 20 edited")).toBe(true);
    });

    it("elides nothing when everything is near a change", () => {
      const rows = withElisions(diffLines("a\nb", "a\nc"));
      expect(rows.every((r) => r !== null)).toBe(true);
    });

    it("leaves an unchanged document fully elided rather than half-rendered", () => {
      const rows = withElisions(diffLines("a\nb\nc", "a\nb\nc"));
      expect(rows).toEqual([null]);
    });
  });
});
