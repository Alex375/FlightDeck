import { describe, expect, it } from "vitest";
import { changedSpans, inlineSpans, parseUnifiedDiff, patchFilePath } from "./unifiedDiff";

const GIT_MODIFY = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 3b18e51..a2c1f4d 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  " return a;",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads a git modification: paths, hunk bounds, numbering and counts", () => {
    const p = parseUnifiedDiff(GIT_MODIFY);
    expect(p.problems).toEqual([]);
    expect(p.files).toHaveLength(1);
    const f = p.files[0];
    expect(f).toMatchObject({ oldPath: "src/app.ts", newPath: "src/app.ts", status: "modified", binary: false });
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    const h = f.hunks[0];
    expect(h).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, section: "export function main() {" });
    expect(h.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 1, 1, "const a = 1;"],
      ["del", 2, null, "const b = 2;"],
      ["add", null, 2, "const b = 3;"],
      ["add", null, 3, "const c = 4;"],
      ["context", 3, 4, "const d = 5;"],
      ["context", 4, 5, "return a;"],
    ]);
  });

  it("reads several files and keeps them in order", () => {
    const text = [
      GIT_MODIFY,
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -10 +10 @@",
      "-old",
      "+new",
    ].join("\n");
    const p = parseUnifiedDiff(text);
    expect(p.files.map(patchFilePath)).toEqual(["src/app.ts", "README.md"]);
    // A count omitted from the hunk header means 1.
    expect(p.files[1].hunks[0]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 });
    expect(p.problems).toEqual([]);
  });

  it("recognises created, deleted, renamed and mode-changed files", () => {
    const text = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 92%",
      "rename from old name.ts",
      "rename to new name.ts",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const [created, deleted, renamed, chmod] = parseUnifiedDiff(text).files;
    expect(created).toMatchObject({ status: "added", oldPath: null, newPath: "new.txt", additions: 2 });
    expect(created.hunks[0].lines.map((l) => l.newNo)).toEqual([1, 2]);
    expect(deleted).toMatchObject({ status: "deleted", oldPath: "gone.txt", newPath: null, deletions: 1 });
    expect(patchFilePath(deleted)).toBe("gone.txt");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "old name.ts", newPath: "new name.ts" });
    expect(renamed.meta).toEqual(["similarity index 92%"]);
    expect(renamed.hunks).toEqual([]);
    expect(chmod).toMatchObject({ status: "modified", oldPath: "run.sh", newPath: "run.sh" });
    expect(chmod.meta).toEqual(["old mode 100644", "new mode 100755"]);
  });

  it("flags binary files and skips a GIT binary patch payload", () => {
    const text = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/icon.png b/icon.png",
      "GIT binary patch",
      "literal 12",
      "zcmZ?wbhEHbRA5kG",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const p = parseUnifiedDiff(text);
    expect(p.files.map((f) => [patchFilePath(f), f.binary])).toEqual([
      ["logo.png", true],
      ["icon.png", true],
      ["a.txt", false],
    ]);
    expect(p.blocks.every((b) => b.kind === "file")).toBe(true);
    expect(p.problems).toEqual([]);
  });

  it("keeps the no-newline marker without counting it", () => {
    const text = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-last",
      "\\ No newline at end of file",
      "+last",
      "\\ No newline at end of file",
    ].join("\n");
    const f = parseUnifiedDiff(text).files[0];
    expect(f.hunks[0].lines.map((l) => l.kind)).toEqual(["del", "note", "add", "note"]);
    expect(f.hunks[0].lines[1].text).toBe("No newline at end of file");
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
  });

  it("reads a plain `diff -u` (timestamps, no a/ b/ prefixes) and CRLF line ends", () => {
    const text = [
      "--- a/notes.txt\t2026-10-13 10:00:00.000000000 +0200",
      "+++ a/notes.txt\t2026-10-13 10:05:00.000000000 +0200",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-was",
      "+is",
    ].join("\r\n");
    const f = parseUnifiedDiff(text).files[0];
    // Both sides under `a/` is not git's prefix pair: a real directory named `a`.
    expect([f.oldPath, f.newPath]).toEqual(["a/notes.txt", "a/notes.txt"]);
    expect(f.hunks[0].lines.map((l) => l.text)).toEqual(["keep", "was", "is"]);
  });

  it("undoes git's quoting of unusual paths", () => {
    const text = [
      'diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"',
      '--- "a/caf\\303\\251 menu.txt"',
      '+++ "b/caf\\303\\251 menu.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(patchFilePath(parseUnifiedDiff(text).files[0])).toBe("café menu.txt");
  });

  it("reads an empty line inside a hunk as a trimmed context line", () => {
    const text = ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c"].join("\n");
    const p = parseUnifiedDiff(text);
    expect(p.problems).toEqual([]);
    expect(p.files[0].hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "a"],
      ["context", ""],
      ["del", "b"],
      ["add", "c"],
    ]);
  });

  it("keeps commit headers and a mail signature as text around the files", () => {
    const text = [
      "From 1a2b3c Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Fix the thing",
      "",
      "---",
      " src/app.ts | 3 ++-",
      GIT_MODIFY.trimEnd(),
      "-- ",
      "2.47.0",
    ].join("\n");
    const p = parseUnifiedDiff(text);
    expect(p.blocks.map((b) => b.kind)).toEqual(["text", "file", "text"]);
    const first = p.blocks[0];
    expect(first.kind === "text" && first.lines[0]).toBe("From 1a2b3c Mon Sep 17 00:00:00 2001");
    const last = p.blocks[2];
    expect(last.kind === "text" && last.lines).toEqual(["-- ", "2.47.0"]);
    expect(p.problems).toEqual([]);
  });

  it("reports a truncated hunk instead of dropping it", () => {
    const text = ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "-b"].join("\n");
    const p = parseUnifiedDiff(text);
    expect(p.files[0].hunks[0].lines).toHaveLength(2);
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0].line).toBe(3);
    expect(p.problems[0].message).toMatch(/incomplete: 1 old and 2 new line\(s\) missing/);
  });

  it("reports a hunk with no file header but still shows it", () => {
    const p = parseUnifiedDiff(["@@ -1 +1 @@", "-a", "+b"].join("\n"));
    expect(p.files).toHaveLength(1);
    expect(patchFilePath(p.files[0])).toBe("(unknown file)");
    expect(p.problems.map((x) => x.message)).toEqual(["Hunk without a file header — its file is unknown."]);
  });

  it("reports an unreadable hunk header and a combined diff", () => {
    const bad = parseUnifiedDiff(["--- a/f", "+++ b/f", "@@ nonsense @@"].join("\n"));
    expect(bad.problems.map((x) => x.line)).toEqual([3]);
    const cc = parseUnifiedDiff("diff --cc conflicted.txt\n");
    expect(cc.problems[0].message).toMatch(/Combined \(merge\) diffs are not supported/);
    expect(cc.files).toEqual([]);
  });

  it("finds no file in text that is not a diff", () => {
    const p = parseUnifiedDiff("just some notes\n- a bullet\n+ another\n");
    expect(p.files).toEqual([]);
    expect(p.blocks).toEqual([{ kind: "text", lines: ["just some notes", "- a bullet", "+ another"] }]);
    expect(parseUnifiedDiff("").blocks).toEqual([]);
  });
});

describe("changedSpans", () => {
  it("marks what lies between the common prefix and suffix", () => {
    expect(changedSpans("const b = 2;", "const b = 3;")).toEqual({ del: [10, 11], add: [10, 11] });
    expect(changedSpans("foo()", "foo(bar)")).toEqual({ del: [4, 4], add: [4, 7] });
  });

  it("marks nothing for identical or wholly different lines", () => {
    expect(changedSpans("same", "same")).toBeNull();
    expect(changedSpans("abc", "xyz")).toBeNull();
  });

  it("never lets prefix and suffix overlap on repeated characters", () => {
    expect(changedSpans("aa", "aaa")).toEqual({ del: [2, 2], add: [2, 3] });
  });
});

describe("inlineSpans", () => {
  it("pairs a run of deletions with the additions that follow it", () => {
    const lines = parseUnifiedDiff(GIT_MODIFY).files[0].hunks[0].lines;
    // del "const b = 2;" (index 1) ↔ add "const b = 3;" (index 2); "const c = 4;" stays unpaired.
    expect([...inlineSpans(lines).entries()]).toEqual([
      [1, [10, 11]],
      [2, [10, 11]],
    ]);
  });
});
