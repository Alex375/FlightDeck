import { describe, expect, it } from "vitest";
import {
  compileFindQuery,
  countLabel,
  escapeRegExp,
  findAll,
  initialMatchIndex,
  pickByHint,
  seedFromSelection,
  stepIndex,
  type FindOptions,
} from "./findQuery";

const LIT: FindOptions = { isRegex: false, matchCase: false, wholeWord: false };

function hits(text: string, pattern: string, opts: Partial<FindOptions> = {}): string[] {
  const c = compileFindQuery(pattern, { ...LIT, ...opts });
  if (!c || "error" in c) throw new Error("did not compile");
  return findAll(text, c.re).matches.map((m) => text.slice(m.start, m.end));
}

describe("compileFindQuery", () => {
  it("returns null for an empty pattern (nothing to search, not an error)", () => {
    expect(compileFindQuery("", LIT)).toBeNull();
  });

  it("treats a literal pattern literally — regex syntax included", () => {
    expect(hits("a.b axb a.b", "a.b")).toEqual(["a.b", "a.b"]);
    expect(hits("f(x) + [y]", "f(x)")).toEqual(["f(x)"]);
    expect(hits("path/to/file", "to/")).toEqual(["to/"]);
  });

  it("is case-insensitive unless match case is on", () => {
    expect(hits("Foo foo FOO", "foo")).toEqual(["Foo", "foo", "FOO"]);
    expect(hits("Foo foo FOO", "foo", { matchCase: true })).toEqual(["foo"]);
  });

  it("matches whole words with a Unicode-aware fence (accents are word characters)", () => {
    expect(hits("été étés l'été", "été", { wholeWord: true })).toEqual(["été", "été"]);
    expect(hits("cat concat cat_ cats", "cat", { wholeWord: true })).toEqual(["cat"]);
  });

  it("fences only the word edges of a literal, so 'foo(' still matches as a whole word", () => {
    expect(hits("foo(x) barfoo(y)", "foo(", { wholeWord: true })).toEqual(["foo("]);
  });

  it("passes a regex through, with ^/$ as line anchors", () => {
    expect(hits("ab12 cd345", "\\d+", { isRegex: true })).toEqual(["12", "345"]);
    expect(hits("one\ntwo\nthree", "^t\\w+$", { isRegex: true })).toEqual(["two", "three"]);
  });

  it("reports an invalid regex with the engine's reason instead of throwing", () => {
    const c = compileFindQuery("(unclosed", { ...LIT, isRegex: true });
    expect(c && "error" in c && c.error).toMatch(/^Invalid regular expression: /);
  });

  it("accepts legacy-dialect escapes the `u` flag rejects", () => {
    expect(hits("a-b", "a\\-b", { isRegex: true })).toEqual(["a-b"]);
  });
});

describe("findAll", () => {
  it("skips zero-length matches without stalling", () => {
    const c = compileFindQuery("x*", { ...LIT, isRegex: true });
    if (!c || "error" in c) throw new Error();
    expect(findAll("ab xx c x", c.re).matches.map((m) => [m.start, m.end])).toEqual([
      [3, 5],
      [8, 9],
    ]);
  });

  it("steps over an astral character on an empty match", () => {
    const c = compileFindQuery("(?:)", { ...LIT, isRegex: true });
    if (!c || "error" in c) throw new Error();
    expect(findAll("😀a", c.re).matches).toEqual([]);
  });

  it("stops at the cap and says so", () => {
    const c = compileFindQuery("a", LIT);
    if (!c || "error" in c) throw new Error();
    const r = findAll("aaaaa", c.re, 3);
    expect(r.matches).toHaveLength(3);
    expect(r.capped).toBe(true);
  });

  it("reports UTF-16 offsets (JS indices)", () => {
    const c = compileFindQuery("b", LIT);
    if (!c || "error" in c) throw new Error();
    expect(findAll("😀b", c.re).matches).toEqual([{ start: 2, end: 3 }]);
  });
});

describe("navigation helpers", () => {
  const m = [{ start: 10, end: 12 }, { start: 50, end: 52 }, { start: 90, end: 92 }];

  it("lands on the first hit at or after the anchor, else the last one before it", () => {
    expect(initialMatchIndex(m, 0)).toBe(0);
    expect(initialMatchIndex(m, 40)).toBe(1);
    expect(initialMatchIndex(m, 95)).toBe(2);
    expect(initialMatchIndex([], 5)).toBe(-1);
  });

  it("wraps at both ends", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });

  it("labels the counter", () => {
    expect(countLabel(0, 0, false)).toBe("No results");
    expect(countLabel(2, 17, false)).toBe("3 of 17");
    expect(countLabel(0, 10000, true)).toBe("1 of 10000+");
    expect(countLabel(-1, 5, false)).toBe("5 results");
  });
});

describe("pickByHint", () => {
  it("picks the occurrence whose surroundings match, ignoring markdown punctuation", () => {
    const text = "first token here. then the **real** token appears. last token.";
    const c = compileFindQuery("token", LIT);
    if (!c || "error" in c) throw new Error();
    const ms = findAll(text, c.re).matches;
    expect(pickByHint(text, ms, { before: "then the real ", after: " appears" })).toBe(1);
  });

  it("returns -1 when no occurrence shares any context", () => {
    const text = "aaa token bbb";
    expect(pickByHint(text, [{ start: 4, end: 9 }], { before: "zzz", after: "yyy" })).toBe(-1);
  });
});

describe("helpers", () => {
  it("escapes only syntax characters", () => {
    expect(escapeRegExp("a-b.c*")).toBe("a-b\\.c\\*");
  });

  it("seeds from a short one-line selection only", () => {
    expect(seedFromSelection("  foo  ")).toBe("foo");
    expect(seedFromSelection("a\nb")).toBeNull();
    expect(seedFromSelection("x".repeat(201))).toBeNull();
    expect(seedFromSelection("")).toBeNull();
    expect(seedFromSelection(null)).toBeNull();
  });
});
