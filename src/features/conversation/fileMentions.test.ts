import { describe, expect, it } from "vitest";
import { normalizePosix, parseFileMention, resolveMentionAbs, routeMarkdownLink } from "./fileMentions";

describe("parseFileMention", () => {
  it("detects a relative path with an extension", () => {
    expect(parseFileMention("src/features/editor/editorStore.ts")).toEqual({
      path: "src/features/editor/editorStore.ts",
    });
  });

  it("detects an absolute path", () => {
    expect(parseFileMention("/Users/a/repo/src/foo.rs")).toEqual({
      path: "/Users/a/repo/src/foo.rs",
    });
  });

  it("detects a bare filename with an extension", () => {
    expect(parseFileMention("package.json")).toEqual({ path: "package.json" });
  });

  it("splits a :line suffix", () => {
    expect(parseFileMention("src/foo.ts:42")).toEqual({ path: "src/foo.ts", line: 42 });
  });

  it("splits a :line:col suffix", () => {
    expect(parseFileMention("src/foo.ts:42:7")).toEqual({
      path: "src/foo.ts",
      line: 42,
      column: 7,
    });
  });

  it("keeps ./ and ../ prefixes", () => {
    expect(parseFileMention("./a.ts")).toEqual({ path: "./a.ts" });
    expect(parseFileMention("../b/c.ts")).toEqual({ path: "../b/c.ts" });
  });

  it("detects bare dotfiles", () => {
    expect(parseFileMention(".gitignore")).toEqual({ path: ".gitignore" });
    expect(parseFileMention(".env")).toEqual({ path: ".env" });
    expect(parseFileMention(".eslintrc")).toEqual({ path: ".eslintrc" });
    expect(parseFileMention("src/.gitignore")).toEqual({ path: "src/.gitignore" });
  });

  it("detects extensionless files when the token is path-shaped (slash or absolute)", () => {
    expect(parseFileMention("src/Makefile")).toEqual({ path: "src/Makefile" });
    expect(parseFileMention(".github/CODEOWNERS")).toEqual({ path: ".github/CODEOWNERS" });
    expect(parseFileMention("/Users/a/repo/Dockerfile")).toEqual({
      path: "/Users/a/repo/Dockerfile",
    });
  });

  it("rejects a bare extensionless word (too ambiguous from prose)", () => {
    expect(parseFileMention("Makefile")).toBeNull();
    expect(parseFileMention("LICENSE")).toBeNull();
  });

  it("rejects ordinary inline-code identifiers", () => {
    expect(parseFileMention("useState")).toBeNull(); // no extension
    expect(parseFileMention("const x = 1")).toBeNull(); // has whitespace
    expect(parseFileMention("toggleTree()")).toBeNull(); // trailing () is not an extension
  });

  it("rejects version numbers (digit-led extension)", () => {
    expect(parseFileMention("1.2.3")).toBeNull();
    expect(parseFileMention("v0.11.0")).toBeNull();
  });

  it("rejects URLs", () => {
    expect(parseFileMention("https://example.com/a.ts")).toBeNull();
    expect(parseFileMention("file:///tmp/x.ts")).toBeNull();
  });

  it("rejects BARE tokens with whitespace (prose, not a path)", () => {
    expect(parseFileMention("a b.ts")).toBeNull();
    expect(parseFileMention("  ")).toBeNull();
  });

  it("rejects a bare time like 12:30", () => {
    expect(parseFileMention("12:30")).toBeNull();
  });
});

// Real files DO contain spaces — a macOS screenshot is the everyday one. The composer
// writes such a mention as an inline-code span so it reaches the agent as ONE literal
// token (see quoteMention), which is what the drop had to fix. The RESOLVER deliberately
// does NOT follow: a whitespace-bearing token stays prose or a shell line to it, because
// widening it bought no chip anywhere (a user turn renders as plain text, no Markdown
// pass) while flagging `/usr/bin/ls -la` and `./gradlew build` as files — each false
// positive also costing a `pathExists` probe.
describe("parseFileMention — whitespace is never a path", () => {
  it("refuses a space-bearing token, anchored or not", () => {
    expect(parseFileMention("a b.ts")).toBeNull();
    expect(parseFileMention("./Capture d ecran 2026-09-19 a 14.03.21.png")).toBeNull();
    expect(parseFileMention("/Volumes/nas/My Pictures/holiday 01.png")).toBeNull();
    expect(parseFileMention("/usr/bin/ls -la")).toBeNull();
    expect(parseFileMention("./gradlew build")).toBeNull();
    expect(parseFileMention("git add src/foo.ts")).toBeNull();
  });
});

// The gate that routes a Markdown link's href (StreamMarkdown's `a` renderer +
// `urlTransform`): Codex references files as real Markdown links whose href is a
// filesystem path — those must classify AS a path (→ preserved through the URL
// sanitizer, opened in the editor), while genuine web URLs must NOT (→ external
// anchor / react-markdown's default sanitizer).
describe("parseFileMention — Codex Markdown-link hrefs", () => {
  it("detects an absolute path with a :line anchor (Alexandre's real example)", () => {
    expect(
      parseFileMention("/Users/alexandrejosien/Repos/wind_get/app/tide_compute.py:232"),
    ).toEqual({
      path: "/Users/alexandrejosien/Repos/wind_get/app/tide_compute.py",
      line: 232,
    });
  });

  it("detects a bare filename href (the note.txt capture fixture)", () => {
    expect(parseFileMention("note.txt")).toEqual({ path: "note.txt" });
    expect(
      parseFileMention("/var/folders/2p/tp/T/fd-codex-capture/note.txt"),
    ).toEqual({ path: "/var/folders/2p/tp/T/fd-codex-capture/note.txt" });
  });

  it("does NOT classify a web URL as a path (routes to an external anchor)", () => {
    expect(parseFileMention("https://example.com")).toBeNull();
    expect(parseFileMention("http://example.com/a.ts")).toBeNull();
    expect(parseFileMention("mailto:foo@bar.com")).toBeNull();
  });

  it("does NOT classify a dangerous scheme as a path (left to the sanitizer)", () => {
    expect(parseFileMention("javascript:alert(1)")).toBeNull();
  });
});

// The routing that drives StreamMarkdown's `a` renderer (MentionLink). Codex writes
// file references as Markdown links; these must be clickable WITHOUT an existence
// gate (they are authoritative references) — the previous existence-gating rendered
// real links as dead plain text whenever the pathExists probe didn't confirm the file.
describe("routeMarkdownLink", () => {
  const cwd = "/repo";

  it("routes an absolute path (with :line) to a clickable file — no existence check", () => {
    expect(
      routeMarkdownLink("/Users/a/wind_get/app/tide_compute.py:232", { cwd, inert: false }),
    ).toEqual({ kind: "file", abs: "/Users/a/wind_get/app/tide_compute.py", line: 232 });
  });

  it("routes a NON-EXISTENT path to a clickable file anyway (authoritative, the fix)", () => {
    // The whole bug: a real Codex link must not degrade to dead text just because a
    // pathExists probe can't confirm it. Routing never consults the filesystem.
    expect(routeMarkdownLink("/does/not/exist/foo.ts:9", { cwd, inert: false })).toEqual({
      kind: "file",
      abs: "/does/not/exist/foo.ts",
      line: 9,
    });
  });

  it("resolves a relative path against the cwd", () => {
    expect(routeMarkdownLink("src/foo.ts:5", { cwd, inert: false })).toEqual({
      kind: "file",
      abs: "/repo/src/foo.ts",
      line: 5,
    });
  });

  it("keeps an absolute path clickable even without a cwd", () => {
    expect(routeMarkdownLink("/abs/foo.ts", { cwd: "", inert: false })).toEqual({
      kind: "file",
      abs: "/abs/foo.ts",
    });
  });

  it("falls back to plain text for a relative path with no cwd to anchor", () => {
    expect(routeMarkdownLink("src/foo.ts", { cwd: "", inert: false })).toEqual({ kind: "plain" });
  });

  it("routes an inert provider to plain text (no editor to reveal into)", () => {
    expect(routeMarkdownLink("/abs/foo.ts", { cwd, inert: true })).toEqual({ kind: "plain" });
  });

  it("routes a real web URL / mailto to an external anchor", () => {
    expect(routeMarkdownLink("https://example.com", { cwd, inert: false })).toEqual({
      kind: "external",
    });
    expect(routeMarkdownLink("mailto:foo@bar.com", { cwd, inert: false })).toEqual({
      kind: "external",
    });
  });
});

describe("resolveMentionAbs", () => {
  it("returns absolute paths untouched", () => {
    expect(resolveMentionAbs("/repo", "/abs/x.ts")).toBe("/abs/x.ts");
  });

  it("joins a relative path to the cwd", () => {
    expect(resolveMentionAbs("/repo", "src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("drops a leading ./", () => {
    expect(resolveMentionAbs("/repo", "./src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("normalises a trailing slash on the cwd", () => {
    expect(resolveMentionAbs("/repo/", "src/x.ts")).toBe("/repo/src/x.ts");
  });

  it("collapses .. and . segments to one canonical path", () => {
    expect(resolveMentionAbs("/repo/src", "../x.ts")).toBe("/repo/x.ts");
    expect(resolveMentionAbs("/repo", "../b/c.ts")).toBe("/b/c.ts");
    expect(resolveMentionAbs("/repo", "a/./b/../c.ts")).toBe("/repo/a/c.ts");
    expect(resolveMentionAbs("/repo", "/abs/../x.ts")).toBe("/x.ts");
  });
});

// Exported for the mention existence cache: it canonicalises raw fs-watcher paths to
// the SAME key shape used for cache lookups, so invalidation matches (see mentionCache).
describe("normalizePosix", () => {
  it("drops '.' and empty segments", () => {
    expect(normalizePosix("/repo/src/./late.ts")).toBe("/repo/src/late.ts");
    expect(normalizePosix("/a//b")).toBe("/a/b");
    expect(normalizePosix("/a/b/")).toBe("/a/b");
  });

  it("collapses '..' against the preceding segment", () => {
    expect(normalizePosix("/a/b/../c")).toBe("/a/c");
    expect(normalizePosix("/a/b/c/../../d")).toBe("/a/d");
  });

  it("leaves leading '..' in a relative path (can't climb above the root)", () => {
    expect(normalizePosix("../x.ts")).toBe("../x.ts");
    expect(normalizePosix("a/../../x")).toBe("../x");
  });

  it("clamps '..' at an absolute root", () => {
    expect(normalizePosix("/../x")).toBe("/x");
    expect(normalizePosix("/")).toBe("/");
  });

  it("is idempotent on an already-canonical path", () => {
    expect(normalizePosix("/repo/src/late.ts")).toBe("/repo/src/late.ts");
  });
});
