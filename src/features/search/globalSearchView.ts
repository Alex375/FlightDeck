// Pure helpers behind the ⌘⇧F panel: which folders a search covers (and why some cannot be
// ticked), how a preview splits around its hits, and the flat list of result rows the keyboard
// walks. No React, no IPC — unit-tested in globalSearchView.test.ts.
import type { ExtraFolder } from "./globalSearchStore";

/** The slice of a repository the folder picker needs. */
export interface RepoLike {
  id: string;
  path: string;
  machineId?: string | null;
}

/** One chip of the "Folders" row. */
export interface RootChip {
  kind: "repo" | "folder";
  /** Repo id, or the folder path for an added folder. */
  key: string;
  path: string;
  on: boolean;
  /** Set when the chip cannot be searched — the chip is greyed out WITH this reason. */
  disabledReason: string | null;
}

/** Whether `child` is `parent` or lies under it (on a '/' boundary — "/a/repo2" is not under
 *  "/a/repo"). */
export function isUnder(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(p + "/");
}

/**
 * The chips of the folder row, and the roots actually sent to the search.
 *  - every repository the app knows is a chip, ticked unless the user unticked it;
 *  - a REMOTE repository is shown but cannot be ticked: the search reads this Mac's disk
 *    (files and transcripts alike), and that repository's live on its server;
 *  - folders added by hand follow, minus any that duplicate a repository;
 *  - the roots are the ticked, searchable paths, deduplicated.
 */
export function searchRoots(
  repos: readonly RepoLike[],
  excludedRepoIds: readonly string[],
  extraFolders: readonly ExtraFolder[],
  machineLabel: (machineId: string) => string | null,
): { chips: RootChip[]; roots: string[] } {
  const chips: RootChip[] = [];
  const seen = new Set<string>();
  for (const r of repos) {
    const remote = !!r.machineId;
    const placeholder = !r.path.startsWith("/");
    const reason = remote
      ? `Lives on ${machineLabel(r.machineId!) ?? "a remote server"} — the search reads this Mac's disk.`
      : placeholder
        ? "Not a folder on disk."
        : null;
    if (!remote) seen.add(r.path);
    chips.push({
      kind: "repo",
      key: r.id,
      path: r.path,
      on: !reason && !excludedRepoIds.includes(r.id),
      disabledReason: reason,
    });
  }
  for (const f of extraFolders) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    chips.push({ kind: "folder", key: f.path, path: f.path, on: f.on, disabledReason: null });
  }
  const roots: string[] = [];
  for (const c of chips) if (c.on && !c.disabledReason && !roots.includes(c.path)) roots.push(c.path);
  return { chips, roots };
}

/** A preview cut into plain and highlighted runs. `ranges` are UTF-16 offsets — JS string
 *  indices — `[start, end)`, possibly unsorted or overlapping (clamped and merged here). */
export function highlightSegments(
  text: string,
  ranges: readonly { start: number; end: number }[],
): { text: string; hit: boolean }[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, text.length)), end: Math.max(0, Math.min(r.end, text.length)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const r of sorted) {
    const start = Math.max(r.start, pos);
    if (r.end <= start) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    const last = out[out.length - 1];
    // Overlapping or touching hits read as one highlight, not two marks side by side.
    if (last?.hit && start === pos) last.text += text.slice(start, r.end);
    else out.push({ text: text.slice(start, r.end), hit: true });
    pos = r.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** A selectable result row: a message hit of a conversation, or a line hit of a file. */
export type ResultRow =
  | { kind: "conv"; group: number; hit: number }
  | { kind: "file"; group: number; hit: number };

export function rowKey(r: ResultRow): string {
  return `${r.kind}:${r.group}:${r.hit}`;
}

/** The rows the keyboard walks, in on-screen order, skipping collapsed groups/sections. */
export function flatRows(
  convHitCounts: readonly number[],
  fileHitCounts: readonly number[],
  collapsed: ReadonlySet<string>,
): ResultRow[] {
  const rows: ResultRow[] = [];
  if (!collapsed.has("section:conv")) {
    convHitCounts.forEach((n, g) => {
      if (collapsed.has(`conv:${g}`)) return;
      for (let h = 0; h < n; h++) rows.push({ kind: "conv", group: g, hit: h });
    });
  }
  if (!collapsed.has("section:file")) {
    fileHitCounts.forEach((n, g) => {
      if (collapsed.has(`file:${g}`)) return;
      for (let h = 0; h < n; h++) rows.push({ kind: "file", group: g, hit: h });
    });
  }
  return rows;
}

/** "src/features/" + "x.ts" — a relative path split so the name can stand out. */
export function splitPath(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { dir: "", name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}

/** "1 match", "12 matches". */
export function plural(n: number, one: string, many: string = one + "s"): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The text just before and just after the first hit of a preview — the context the opened
 *  panel's find uses to land on that very occurrence (find/findQuery.ts `pickByHint`). */
export function hintFromPreview(
  preview: string,
  ranges: readonly { start: number; end: number }[],
): { before: string; after: string } | null {
  const first = [...ranges].sort((a, b) => a.start - b.start)[0];
  if (!first) return null;
  const strip = (s: string) => s.replace(/^…/, "").replace(/…$/, "");
  return { before: strip(preview.slice(0, first.start)), after: strip(preview.slice(first.end)) };
}
