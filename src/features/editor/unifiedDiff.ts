// Parser for a unified diff — what `git diff`, `git format-patch`, `git log -p` and
// `diff -u` print — into the structure the editor's diff Preview renders (DiffPreview).
//
// PURE and React-free, so every shape it meets is unit-tested. It never throws: a patch is
// a text file the user (or an agent) opened, and whatever it holds must still be shown.
// What it cannot make sense of is either kept as plain TEXT (commit headers, a mail
// signature — legitimately part of many patches) or reported as a PROBLEM (a truncated
// hunk, a hunk with no file) that the Preview surfaces instead of rendering less in
// silence.

export type PatchLineKind = "context" | "add" | "del" | "note";

/** One line of a hunk. `note` is the `\ No newline at end of file` marker: it belongs to
 *  the line before it and counts on neither side. */
export interface PatchLine {
  kind: PatchLineKind;
  /** The line WITHOUT its leading sign column. */
  text: string;
  /** 1-based line number in the old file (null for an added line or a note). */
  oldNo: number | null;
  /** 1-based line number in the new file (null for a deleted line or a note). */
  newNo: number | null;
}

export interface PatchHunk {
  /** The `@@ -a,b +c,d @@` line itself. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What follows the closing `@@` (git puts the enclosing function there), or "". */
  section: string;
  lines: PatchLine[];
}

export type PatchFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface PatchFile {
  /** Path before the change (`a/` prefix stripped), or null for a created file. */
  oldPath: string | null;
  /** Path after the change (`b/` prefix stripped), or null for a deleted file. */
  newPath: string | null;
  status: PatchFileStatus;
  /** git reported the file as binary: there are no text hunks to show. */
  binary: boolean;
  /** Extended header facts worth showing (mode changes, similarity), in patch order. */
  meta: string[];
  hunks: PatchHunk[];
  additions: number;
  deletions: number;
}

/** A patch read in order: runs of free text (preamble, commit headers, mail signature)
 *  and file diffs, interleaved exactly as they appear. */
export type PatchBlock = { kind: "text"; lines: string[] } | { kind: "file"; file: PatchFile };

export interface PatchProblem {
  /** 1-based line in the patch where the problem was found. */
  line: number;
  message: string;
}

export interface ParsedPatch {
  blocks: PatchBlock[];
  /** The file blocks, in order (a convenience view over `blocks`). */
  files: PatchFile[];
  problems: PatchProblem[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of a path (`"a/caf\303\251 b.txt"`). Octal escapes are
 *  bytes of the UTF-8 encoding, so they are collected and decoded together. */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const SIMPLE: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 3;
        continue;
      }
      if (next in SIMPLE) {
        bytes.push(SIMPLE[next]);
        i += 1;
        continue;
      }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path named on a `---` / `+++` line: tab-separated timestamp dropped (`diff -u`),
 *  quoting undone, `/dev/null` → null. Prefixes are stripped by the caller. */
function headerPath(rest: string): string | null {
  let p = rest;
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  p = unquote(p.trimEnd());
  return p === "/dev/null" ? null : p;
}

/** Strip git's `a/` / `b/` source and destination prefixes. Done only when the pair
 *  looks like git's (old under `a/`, new under `b/`) — a plain `diff -u` of a real
 *  directory named `a` must keep its path. */
function stripPrefixes(oldPath: string | null, newPath: string | null): [string | null, string | null] {
  const oldOk = oldPath === null || oldPath.startsWith("a/");
  const newOk = newPath === null || newPath.startsWith("b/");
  if (!oldOk || !newOk || (oldPath === null && newPath === null)) return [oldPath, newPath];
  return [oldPath?.slice(2) ?? null, newPath?.slice(2) ?? null];
}

/** The two paths of a `diff --git a/x b/y` line — a FALLBACK only: `---`/`+++` and
 *  `rename from/to` are authoritative when present. An unquoted path may contain spaces,
 *  so the split prefers the ` b/` where both halves name the same file (the common,
 *  unrenamed case). */
function gitLinePaths(rest: string): [string | null, string | null] {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted && (rest.startsWith('"') || rest.endsWith('"'))) {
    return stripPrefixes(unquote(quoted[1]), unquote(quoted[2]));
  }
  let at = -1;
  for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) {
    if (at < 0) at = i;
    if (rest.slice(0, i).replace(/^a\//, "") === rest.slice(i + 3)) {
      at = i;
      break;
    }
  }
  if (at < 0) return [null, null];
  return stripPrefixes(rest.slice(0, at), rest.slice(at + 1));
}

function newFile(): PatchFile {
  return {
    oldPath: null,
    newPath: null,
    status: "modified",
    binary: false,
    meta: [],
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

/** Parse a unified diff. Never throws (see the module doc). */
export function parseUnifiedDiff(text: string): ParsedPatch {
  const lines = text.split(/\r?\n/);
  // A trailing newline is the normal end of a text file, not an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const blocks: PatchBlock[] = [];
  const files: PatchFile[] = [];
  const problems: PatchProblem[] = [];
  // Held in an object, not two `let`s: the helpers below reassign them, and TypeScript
  // does not see a closure's assignment when it narrows a local.
  const cur: {
    /** The file being filled, while its headers/hunks may still follow. */
    file: PatchFile | null;
    /** `file` came from a `diff --git` line and has not seen `---`/`+++` yet. */
    awaitingHeaders: boolean;
  } = { file: null, awaitingHeaders: false };

  const pushText = (line: string) => {
    cur.file = null;
    cur.awaitingHeaders = false;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "text") last.lines.push(line);
    else blocks.push({ kind: "text", lines: [line] });
  };
  const startFile = (): PatchFile => {
    const f = newFile();
    blocks.push({ kind: "file", file: f });
    files.push(f);
    cur.file = f;
    return f;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const f = startFile();
      [f.oldPath, f.newPath] = gitLinePaths(line.slice("diff --git ".length));
      cur.awaitingHeaders = true;
      i++;
      // Extended headers, up to the first `---`, hunk, or anything else.
      while (i < lines.length) {
        const h = lines[i];
        if (h.startsWith("new file mode")) f.status = "added";
        else if (h.startsWith("deleted file mode")) f.status = "deleted";
        else if (h.startsWith("rename from ")) {
          f.status = "renamed";
          f.oldPath = unquote(h.slice("rename from ".length));
        } else if (h.startsWith("rename to ")) {
          f.status = "renamed";
          f.newPath = unquote(h.slice("rename to ".length));
        } else if (h.startsWith("copy from ")) {
          f.status = "copied";
          f.oldPath = unquote(h.slice("copy from ".length));
        } else if (h.startsWith("copy to ")) {
          f.status = "copied";
          f.newPath = unquote(h.slice("copy to ".length));
        } else if (h.startsWith("similarity index ") || h.startsWith("dissimilarity index ")) f.meta.push(h);
        else if (h.startsWith("old mode ") || h.startsWith("new mode ")) f.meta.push(h);
        else if (h.startsWith("index ")) {
          /* blob ids — nothing a reader needs */
        } else if (h.startsWith("Binary files ") && h.endsWith(" differ")) f.binary = true;
        else if (h === "GIT binary patch") {
          f.binary = true;
          // The base85 payload runs until the next file (or the end).
          i++;
          while (i < lines.length && !lines[i].startsWith("diff ")) i++;
          continue;
        } else break;
        i++;
      }
      // A created/deleted file names /dev/null on one side.
      if (f.status === "added") f.oldPath = null;
      if (f.status === "deleted") f.newPath = null;
      continue;
    }

    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      problems.push({
        line: i + 1,
        message: "Combined (merge) diffs are not supported — this part is shown as plain text.",
      });
      pushText(line);
      i++;
      continue;
    }

    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      // The headers of the `diff --git` file just opened, or a plain `diff -u` file.
      const f: PatchFile = cur.file !== null && cur.awaitingHeaders ? cur.file : startFile();
      cur.awaitingHeaders = false;
      const [oldPath, newPath] = stripPrefixes(
        headerPath(line.slice(4)),
        headerPath(lines[i + 1].slice(4)),
      );
      f.oldPath = oldPath;
      f.newPath = newPath;
      if (oldPath === null && newPath !== null) f.status = "added";
      else if (newPath === null && oldPath !== null) f.status = "deleted";
      i += 2;
      continue;
    }

    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) {
        problems.push({ line: i + 1, message: `Unreadable hunk header: ${line}` });
        pushText(line);
        i++;
        continue;
      }
      let f: PatchFile | null = cur.file;
      if (f === null) {
        problems.push({ line: i + 1, message: "Hunk without a file header — its file is unknown." });
        f = startFile();
      }
      cur.awaitingHeaders = false;
      const hunk: PatchHunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? "",
        lines: [],
      };
      f.hunks.push(hunk);
      const hunkLine = i + 1;
      i++;
      let oldLeft = hunk.oldLines;
      let newLeft = hunk.newLines;
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const l = lines[i];
        const sign = l[0];
        if (sign === "\\") {
          hunk.lines.push({ kind: "note", text: l.slice(1).trim(), oldNo: null, newNo: null });
        } else if (sign === "-" && oldLeft > 0) {
          hunk.lines.push({ kind: "del", text: l.slice(1), oldNo: oldNo++, newNo: null });
          oldLeft--;
          f.deletions++;
        } else if (sign === "+" && newLeft > 0) {
          hunk.lines.push({ kind: "add", text: l.slice(1), oldNo: null, newNo: newNo++ });
          newLeft--;
          f.additions++;
        } else if ((sign === " " || l === "") && oldLeft > 0 && newLeft > 0) {
          // An EMPTY line stands for a context line whose single space an editor or a
          // mail client trimmed — `git apply` reads it the same way.
          hunk.lines.push({ kind: "context", text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
          oldLeft--;
          newLeft--;
        } else break;
        i++;
      }
      if (oldLeft > 0 || newLeft > 0) {
        problems.push({
          line: hunkLine,
          message:
            `Hunk ${line.split("@@")[1]?.trim() ?? ""} is incomplete: ` +
            `${oldLeft} old and ${newLeft} new line(s) missing.`,
        });
      }
      // The no-newline marker after a hunk's LAST line is past the counted lines.
      while (i < lines.length && lines[i].startsWith("\\")) {
        hunk.lines.push({ kind: "note", text: lines[i].slice(1).trim(), oldNo: null, newNo: null });
        i++;
      }
      continue;
    }

    // `Binary files … differ` from a plain `diff` (no `diff --git` line before it).
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      const f = startFile();
      f.binary = true;
      const m = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (m) [f.oldPath, f.newPath] = stripPrefixes(headerPath(m[1]), headerPath(m[2]));
      cur.file = null;
      i++;
      continue;
    }

    pushText(line);
    i++;
  }

  return { blocks, files, problems };
}

/**
 * A patched file as the two texts a side-by-side diff editor compares. A patch only
 * carries EXCERPTS (its hunks), so each side is those excerpts end to end, each one
 * headed by its `@@` line — the same text on both sides, so the editor aligns it as
 * unchanged and it reads as the band between two excerpts. `oldLabels` / `newLabels` give,
 * per displayed line (index = line − 1), the line number in the real file, or "" for a
 * band; `oldBands` / `newBands` are the band lines (1-based).
 */
export interface SideBySideFile {
  oldText: string;
  newText: string;
  oldLabels: string[];
  newLabels: string[];
  oldBands: number[];
  newBands: number[];
}

export function sideBySideOf(file: PatchFile): SideBySideFile {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldLabels: string[] = [];
  const newLabels: string[] = [];
  const oldBands: number[] = [];
  const newBands: number[] = [];
  for (const h of file.hunks) {
    const band = h.section ? `${h.header.slice(0, h.header.lastIndexOf("@@") + 2)} ${h.section}` : h.header;
    oldLines.push(band);
    newLines.push(band);
    oldLabels.push("");
    newLabels.push("");
    oldBands.push(oldLines.length);
    newBands.push(newLines.length);
    for (const l of h.lines) {
      if (l.kind === "context" || l.kind === "del") {
        oldLines.push(l.text);
        oldLabels.push(String(l.oldNo ?? ""));
      }
      if (l.kind === "context" || l.kind === "add") {
        newLines.push(l.text);
        newLabels.push(String(l.newNo ?? ""));
      }
    }
  }
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    oldLabels,
    newLabels,
    oldBands,
    newBands,
  };
}

/** The display path of a file: its new path, or its old one when it was deleted. */
export function patchFilePath(f: PatchFile): string {
  return f.newPath ?? f.oldPath ?? "(unknown file)";
}

/** The changed span of a deleted line and of the added line it was rewritten into, as
 *  [start, end) character ranges — the common prefix and suffix are what did NOT change.
 *  Null when there is nothing worth marking: identical lines, or no shared prefix/suffix
 *  at all (the whole line changed, which its row colour already says). */
export function changedSpans(
  del: string,
  add: string,
): { del: [number, number]; add: [number, number] } | null {
  if (del === add) return null;
  let start = 0;
  const max = Math.min(del.length, add.length);
  while (start < max && del[start] === add[start]) start++;
  let end = 0;
  while (end < max - start && del[del.length - 1 - end] === add[add.length - 1 - end]) end++;
  if (start === 0 && end === 0) return null;
  return { del: [start, del.length - end], add: [start, add.length - end] };
}

/**
 * Pair each deleted line with the added line that replaced it, for intra-line marking:
 * within a hunk, a run of deletions directly followed by a run of additions is a rewrite,
 * and its i-th deletion pairs with its i-th addition (the extra lines of the longer run
 * stay unpaired). Returns, per line index of `lines`, the span to mark on that line.
 */
export function inlineSpans(lines: PatchLine[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const spans = changedSpans(lines[delStart + k].text, lines[addStart + k].text);
      if (!spans) continue;
      out.set(delStart + k, spans.del);
      out.set(addStart + k, spans.add);
    }
  }
  return out;
}
