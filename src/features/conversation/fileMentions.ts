// Pure detection + resolution of file-path "mentions" in conversation text.
// No React, no IPC — just string logic, so it is trivially unit-testable
// (see fileMentions.test.ts). The React layer (FileMention.tsx) gates a parsed
// mention on the file actually existing under the conversation cwd before making
// it clickable; this module only decides "does this token LOOK like a path?".

export interface FileMention {
  /** The path as written: absolute (`/…`) or relative to the conversation cwd. */
  path: string;
  /** 1-based line, when the mention carried a `:line` (or `:line:col`) suffix. */
  line?: number;
  column?: number;
}

// A URL (http://, https://, file://, …) is never a file mention.
export const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// A trailing `:line` or `:line:col` locator.
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;

// A path-ish token. A token is path-shaped when it is EITHER:
//  - unambiguously a path: absolute (`/…`), `./`/`../`-prefixed, or it contains
//    a `/` — then ANY final segment is fine, including extensionless ones
//    (`src/Makefile`, `.github/CODEOWNERS`, `/repo/Dockerfile`); OR
//  - a bare `name.ext` with a LETTER-LED extension (`foo.ts`, `package.json`) so
//    version numbers like `1.2.3` aren't mistaken for files; OR
//  - a bare dotfile (`.gitignore`, `.env`, `.eslintrc`).
// A bare extensionless word (`Makefile`, `useState`) is intentionally rejected —
// it is too ambiguous to flag from prose (tool-card paths bypass this via the
// authoritative chip). No whitespace is allowed anywhere.
const SEG = "[\\w.@+-]+";
const NAME_EXT = `${SEG}\\.[A-Za-z][A-Za-z0-9]{0,7}`;
const DOTFILE = "\\.[\\w@+-]+";
const PATH_RE = new RegExp(
  "^(?:" +
    `(?:/|\\.{1,2}/)(?:${SEG}/)*${SEG}` + // absolute / ./ / ../ prefixed → any final segment
    `|(?:${SEG}/)+${SEG}` + //              contains a directory → any final segment
    `|${NAME_EXT}` + //                     bare name.ext (letter-led extension)
    `|${DOTFILE}` + //                      bare dotfile
    ")$",
);

/** Whether a token is path-shaped. A token carrying whitespace is never one: that is
 *  prose or a shell line, and every false positive also costs a `pathExists` probe. */
function isPathShaped(s: string): boolean {
  return !/\s/.test(s) && PATH_RE.test(s);
}

/**
 * Parse a single token (e.g. the text of an inline-code span, or a tool's
 * `file_path` argument) into a file mention, or null when it doesn't look like a
 * path. A trailing `:line(:col)` is split off only when the remaining head is
 * still a valid path (so `foo.ts:42` → {path:"foo.ts", line:42}, but a bare
 * `12:30` time is rejected).
 */
export function parseFileMention(raw: string): FileMention | null {
  const s = raw.trim();
  if (!s || SCHEME.test(s)) return null;

  let path = s;
  let line: number | undefined;
  let column: number | undefined;

  const m = LINE_SUFFIX.exec(path);
  if (m) {
    const head = path.slice(0, m.index);
    if (isPathShaped(head)) {
      path = head;
      line = Number(m[1]);
      if (m[2] !== undefined) column = Number(m[2]);
    }
  }

  if (!isPathShaped(path)) return null;
  return column !== undefined ? { path, line, column } : line !== undefined ? { path, line } : { path };
}

const stripTrailingSlash = (p: string) => p.replace(/\/+$/, "");

/** Collapse `.`/`..`/empty segments so a file has ONE canonical absolute key
 *  (Monaco models + editor tabs are keyed by the literal path string, so two
 *  spellings of the same file would otherwise open two tabs). Exported so the
 *  mention existence cache can canonicalise raw fs-watcher paths to the SAME key
 *  shape before invalidating (see mentionCache.ts). */
export function normalizePosix(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(seg);
    }
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * Turn a mentioned path into a CANONICAL absolute one, rooted on the
 * conversation's live cwd. Absolute paths pass through; relative paths are joined
 * to the cwd; `.`/`..` segments are collapsed so the same file always yields the
 * same key (no duplicate Monaco tab).
 */
export function resolveMentionAbs(cwd: string, path: string): string {
  const joined = path.startsWith("/") ? path : `${stripTrailingSlash(cwd)}/${path}`;
  return normalizePosix(joined);
}

/** How a Markdown link's href should be rendered (see routeMarkdownLink). */
export type LinkRoute =
  | { kind: "file"; abs: string; line?: number; column?: number }
  | { kind: "external" }
  | { kind: "plain" };

/**
 * Route a Markdown link's href. A Markdown file link is a DELIBERATE reference
 * (Codex writes `[name](/abs/path:line)`, Claude occasionally `[name](path)`), so —
 * unlike a bare path guessed from prose — it is treated as AUTHORITATIVE: a
 * path-shaped href resolves to a `file` route that is clickable WITHOUT an
 * existence check (the editor surfaces a read error if the file is truly gone).
 * This is why a real Codex file link never renders as dead, non-clickable text.
 *
 * A genuine URL scheme (http(s), mailto, …) → `external`. A path we can't anchor
 * (a relative path with no cwd, or an inert provider) → `plain` text.
 */
export function routeMarkdownLink(href: string, opts: { cwd: string; inert: boolean }): LinkRoute {
  const mention = parseFileMention(href.trim());
  if (!mention) return { kind: "external" }; // URL scheme or non-path token
  if (opts.inert) return { kind: "plain" };
  const isAbsolute = mention.path.startsWith("/");
  if (!isAbsolute && !opts.cwd) return { kind: "plain" }; // relative needs a cwd to anchor
  return {
    kind: "file",
    abs: resolveMentionAbs(opts.cwd, mention.path),
    line: mention.line,
    column: mention.column,
  };
}
