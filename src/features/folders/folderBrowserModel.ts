// Pure helpers of the remote folder browser (`RemoteFolderPicker.tsx`) — paths, the
// breadcrumb, the filter and the new-folder name check. POSIX paths only: every folder
// this browses lives on a paired server, never on this Mac.

/** The parent of a POSIX path, or null at the root. */
export function parentDir(p: string): string | null {
  if (!p || p === "/") return null;
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** Join a directory and a child name into a POSIX path. */
export function joinDir(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** The last segment of a path (`/` for the root). */
export function baseName(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1) || "/";
}

/** Whether `p` is `home` or below it. */
function underHome(p: string, home: string | null): home is string {
  return !!home && home !== "/" && (p === home || p.startsWith(`${home}/`));
}

/** `~/code/app` for a path below the server's home — the same prefix on every line says
 *  nothing, and a long `/home/someone/` crowds out the part that differs. */
export function tildePath(p: string, home: string | null): string {
  if (!underHome(p, home)) return p;
  return p === home ? "~" : `~${p.slice(home.length)}`;
}

/** One step of the breadcrumb: what it shows, and where clicking it goes. */
export interface Crumb {
  label: string;
  path: string;
  /** The home crumb (`~`), drawn with a house instead of its label. */
  home?: boolean;
}

/** The breadcrumb of `p`: from `~` when it is below the server's home, from `/`
 *  otherwise. The last crumb is the folder itself. */
export function pathCrumbs(p: string, home: string | null): Crumb[] {
  const start: Crumb = underHome(p, home) ? { label: "~", path: home!, home: true } : { label: "/", path: "/" };
  const rest = p.slice(start.path === "/" ? 1 : start.path.length).split("/").filter(Boolean);
  const crumbs = [start];
  let at = start.path;
  for (const seg of rest) {
    at = joinDir(at, seg);
    crumbs.push({ label: seg, path: at });
  }
  return crumbs;
}

/** Whether what was typed in the filter is a path to go to rather than a filter. */
export function looksLikePath(query: string): boolean {
  const q = query.trim();
  return q.startsWith("/") || q === "~" || q.startsWith("~/");
}

/** The absolute path a typed path means: `~` expanded against the server's home,
 *  `.`/`..` and doubled slashes folded away. Null when it isn't a path, or names the
 *  home while the home isn't known yet. The server resolves symlinks itself. */
export function resolveTypedPath(query: string, home: string | null): string | null {
  const q = query.trim();
  let abs: string;
  if (q === "~" || q.startsWith("~/")) {
    if (!home) return null;
    abs = home + q.slice(1);
  } else if (q.startsWith("/")) {
    abs = q;
  } else {
    return null;
  }
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** Sub-folder names as a person sorts them: case-insensitive, numbers by value. */
export function sortFolders(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/** A name kept by the filter, with where the typed text sits in it (for highlighting). */
export interface FolderMatch {
  name: string;
  /** Offset of the match in `name`; `-1` when nothing is typed. */
  at: number;
  length: number;
}

/** The names that contain `query` (case-insensitive), the ones that START with it
 *  first; each group keeps the incoming order. An empty query keeps everything. */
export function filterFolders(names: readonly string[], query: string): FolderMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return names.map((name) => ({ name, at: -1, length: 0 }));
  const starts: FolderMatch[] = [];
  const inside: FolderMatch[] = [];
  for (const name of names) {
    const at = name.toLowerCase().indexOf(q);
    if (at === 0) starts.push({ name, at, length: q.length });
    else if (at > 0) inside.push({ name, at, length: q.length });
  }
  return [...starts, ...inside];
}

/** A detected repository as the browser lists it: its folder name, and where it sits. */
export interface RepoEntry {
  path: string;
  name: string;
  /** Its parent folder, `~`-shortened. */
  where: string;
}

export function repoEntries(paths: readonly string[], home: string | null): RepoEntry[] {
  return paths.map((path) => ({ path, name: baseName(path), where: tildePath(parentDir(path) ?? "/", home) }));
}

/** The detected repositories whose name or path holds `query`, name matches first. */
export function filterRepos(repos: readonly RepoEntry[], query: string): RepoEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  const byName = repos.filter((r) => r.name.toLowerCase().includes(q));
  const byPath = repos.filter((r) => !byName.includes(r) && r.path.toLowerCase().includes(q));
  return [...byName, ...byPath];
}

/** Why `name` can't be created as a folder in a folder already holding `existing` —
 *  or null when it can. Empty is not an error: there is just nothing to create yet. */
export function folderNameProblem(name: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n.includes("/")) return "A folder name can't contain “/”.";
  if (n === "." || n === "..") return "That name is reserved — pick another one.";
  if (new TextEncoder().encode(n).length > 255) return "That name is too long.";
  if (existing.includes(n)) return "A folder with this name is already here.";
  return null;
}
