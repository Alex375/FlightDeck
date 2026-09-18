import { describe, expect, it } from "vitest";
import { isHiddenName } from "./hiddenEntries";

describe("isHiddenName", () => {
  it("is true for a dot-name", () => {
    expect(isHiddenName(".git")).toBe(true);
    expect(isHiddenName(".claude")).toBe(true);
    expect(isHiddenName(".DS_Store")).toBe(true);
    expect(isHiddenName(".editorconfig")).toBe(true);
    expect(isHiddenName(".gitattributes")).toBe(true);
  });

  it("is false for an ordinary name, wherever its dots are", () => {
    expect(isHiddenName("src")).toBe(false);
    expect(isHiddenName("README.md")).toBe(false);
    expect(isHiddenName("editorStore.test.ts")).toBe(false);
    expect(isHiddenName("a.b.c")).toBe(false);
  });

  it("is false for the relative directory links and for an empty name", () => {
    expect(isHiddenName(".")).toBe(false);
    expect(isHiddenName("..")).toBe(false);
    expect(isHiddenName("")).toBe(false);
  });

  it("answers about the NAME, not a path (so a dot-folder's children are not hidden)", () => {
    // The tree asks with `entry.name`; a full path is never the question. This
    // pins the contract that makes "only the row's OWN name dims it" work.
    expect(isHiddenName("/Users/x/.git/config")).toBe(false);
    expect(isHiddenName("config")).toBe(false);
  });
});
