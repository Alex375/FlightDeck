// WHEN the git caches of a conversation's folder go stale, WHICH of them, and HOW to refresh
// them — no React, so the rules are pinned by tests and the widget, the fs refresh and the
// global event hook agree on one cwd string and one way to invalidate.
//
// Why a turn end: the agent's commits, stages, resets and branch switches touch only `.git`,
// which the filesystem watcher deliberately ignores (and the watcher only exists while an
// editor is open at all). Nothing else would tell the Git views the checkout moved until the
// window lost and regained focus. A turn end is a CHECKPOINT, not a final truth — background
// work may still be writing — the next edge, focus or mount catches up.
//
// Why the exact cwd string: TanStack keys are compared by value, and the Git workspace, its
// changes list, its diff pane and the side panel's git widget all key on
// `effectiveCwd(conv, state)`. A worktree root vs a subfolder, or a trailing slash, would be a
// second cache entry and a second `git` process for the same answer.

import type { QueryClient } from "@tanstack/react-query";
import type { SessionStatePayload } from "../../ipc/client";
import { effectiveCwd } from "./worktree";

type ConvLike = { cwd: string; liveCwd: string | null };
type RepoLike = { path: string; machineId?: string | null };

/** A path this Mac's `git -C` can be pointed at: absolute. `"."` (the default local project)
 *  would resolve against the APP process's own cwd — `/` in the bundle, the repo in dev. */
function isLocalAbsolute(p: string | null | undefined): p is string {
  return typeof p === "string" && p.startsWith("/");
}

/**
 * The folder whose git status a conversation shows, or null when there is none to read on this
 * Mac: a REMOTE repository (its path is the server's — reading it here would fail, or worse,
 * silently read an unrelated local folder that happens to share the path) or a relative cwd.
 * Null disables the query: no `git` process at all.
 */
export function localGitCwd(
  conv: ConvLike,
  state: SessionStatePayload | undefined,
  repo: RepoLike | null | undefined,
): string | null {
  if (repo?.machineId) return null;
  const cwd = effectiveCwd(conv, state);
  return isLocalAbsolute(cwd) ? cwd : null;
}

/** Whether a session-state change is a moment to re-read git: a turn just ended (busy
 *  true→false) or the process just ended. Compared with the PREVIOUS state, so a duplicated
 *  event (Tauri delivers at least once) finds no edge and costs nothing. */
export function isGitRefreshEdge(
  prev: Pick<SessionStatePayload, "busy" | "ended"> | undefined,
  next: Pick<SessionStatePayload, "busy" | "ended">,
): boolean {
  const turnEnded = !!prev?.busy && !next.busy;
  const processEnded = next.ended && !prev?.ended;
  return turnEnded || processEnded;
}

/**
 * The query keys to invalidate when a conversation's turn ends — each a PREFIX (TanStack
 * matches keys by prefix), all under the conversation's local cwd:
 *  - status, working-tree diffs, log and branches of the cwd (an agent may have edited,
 *    staged, committed or switched branch);
 *  - that worktree's own status row in the worktree manager;
 *  - the repository's worktree LIST, whose `branch` is what the worktree row shows: an agent's
 *    `git checkout -b` inside a worktree changes it and nothing else would re-read it.
 * Commit contents (`commit-files`, `commit-diff`) are left alone: a commit never changes.
 * Empty for a conversation with nothing to read on this Mac (see `localGitCwd`).
 */
export function gitKeysToRefreshOnTurnEnd(
  conv: ConvLike,
  state: SessionStatePayload | undefined,
  repo: RepoLike | null | undefined,
): (readonly unknown[])[] {
  const cwd = localGitCwd(conv, state, repo);
  if (!cwd) return [];
  const keys: (readonly unknown[])[] = [
    ["git", cwd, "status"],
    ["git", cwd, "diff"],
    ["git", cwd, "log"],
    ["git", cwd, "branches"],
    ["worktree-status", cwd],
  ];
  if (repo && isLocalAbsolute(repo.path)) keys.push(["worktrees", repo.path]);
  return keys;
}

/**
 * The `refetchType` of an event-driven git invalidation (fs change, turn end): re-read the
 * MOUNTED views now — or, while the window is hidden, only mark them stale. Nobody is looking
 * then, and TanStack's focus refetch (on `visibilitychange`) re-reads a stale query the moment
 * the window shows again, so a hidden app spawns no `git` process for a change it will read
 * anyway.
 */
export function gitRefetchType(): "active" | "none" {
  return typeof document !== "undefined" && document.hidden ? "none" : "active";
}

/**
 * Invalidate a git query key (a PREFIX) in answer to an EVENT — an fs change, a turn end —
 * without ever running two `git` processes for it at once.
 *
 * ⚠️ `cancelRefetch: false` joins a fetch already in flight instead of restarting it: the
 * default would drop the JS promise and start another, but the Rust side's `git` process cannot
 * be cancelled, so bursts stacked concurrent `git status` processes on a big repo. Joining alone
 * has its own hole, though: that fetch STARTED before the change we are reacting to, and when it
 * lands TanStack clears the invalidation — the view would settle on a pre-change answer. So each
 * query that was in flight is invalidated once more when ITS read lands: sequential, never
 * concurrent.
 *
 * ⚠️ The follow-up targets exactly those queries, never the whole prefix: a prefix (`diff`) can
 * cover several queries, and re-invalidating all of them would read every idle sibling twice for
 * the one that happened to be busy. It also waits on the in-flight read itself, not on this
 * call's own refetch: while the window is hidden that refetch is a no-op that resolves at once,
 * and a follow-up fired then would be wiped by the old read landing after it.
 */
export function invalidateGitQueries(qc: QueryClient, queryKey: readonly unknown[]): void {
  const inFlight = qc.getQueryCache().findAll({ queryKey, fetchStatus: "fetching" });
  void qc.invalidateQueries({ queryKey, refetchType: gitRefetchType() }, { cancelRefetch: false });
  for (const query of inFlight) {
    const landing = query.promise;
    if (!landing) continue;
    // A failed read is still a landed one — the view then shows that error, and the follow-up
    // retries it once.
    void landing
      .then(noop, noop)
      .then(() =>
        qc.invalidateQueries(
          { queryKey: query.queryKey, exact: true, refetchType: gitRefetchType() },
          { cancelRefetch: false },
        ),
      );
  }
}

function noop(): void {}

/** A subscription to the app's fs-change batches (absolute paths); resolves to its release. */
export type FsChangeListen = (onPaths: (paths: readonly string[]) => void) => Promise<() => void>;

/**
 * The fs-driven git refresh, SHARED per cwd: `retain(cwd)` starts (or joins) the one refresher of
 * that folder and returns its release. Every view that wants fs-driven freshness (the Git
 * workspace, the IDE status bar, the side panel's git widget) retains it; the last release stops
 * it.
 *
 * ⚠️ Why shared: each refresher throttles on its own clock. Two views on the same folder, each
 * with its own listener, would both fire at the end of the same burst — the second finds the
 * first's read in flight, and `invalidateGitQueries` (rightly, it cannot tell) reads once more
 * after it: two `git status` per burst instead of one. One listener per cwd makes the count
 * independent of how many views are open.
 *
 * Per refresher:
 *  - FILTERED to its cwd: the app has ONE fs watch, owned by whichever editor mounted last, so
 *    its events may be about the IDE's folder or another worktree;
 *  - THROTTLED, trailing: an agent writing files fires a batch every ~150 ms. The first batch
 *    under the cwd arms one timer and later ones ride along, so the refresh at its end sees all
 *    of them — one refresh per `throttleMs` at most, never a stale last write;
 *  - no timer while idle: the timer exists only between a batch and its refresh.
 */
export function createGitFsRefresh({
  listen,
  refresh,
  throttleMs,
  onListenError = (e) => console.error("[git] fs-change listener failed:", e),
}: {
  listen: FsChangeListen;
  /** Re-read the git views of `cwd`. */
  refresh: (cwd: string) => void;
  throttleMs: number;
  /** A listener that could not be set up — best effort (focus and turn ends still refresh),
   *  but never silent. */
  onListenError?: (e: unknown) => void;
}): (cwd: string) => () => void {
  type Refresher = {
    users: number;
    timer: ReturnType<typeof setTimeout> | null;
    off: (() => void) | null;
    closed: boolean;
  };
  const byCwd = new Map<string, Refresher>();

  const open = (cwd: string): Refresher => {
    const r: Refresher = { users: 0, timer: null, off: null, closed: false };
    void listen((paths) => {
      if (r.closed || r.timer !== null || !pathsTouchCwd(paths, cwd)) return;
      r.timer = setTimeout(() => {
        r.timer = null;
        if (!r.closed) refresh(cwd);
      }, throttleMs);
    }).then(
      // Released before the subscription came back: drop it the moment it exists.
      (off) => (r.closed ? off() : (r.off = off)),
      onListenError,
    );
    return r;
  };

  return (cwd) => {
    let r = byCwd.get(cwd);
    if (!r) {
      r = open(cwd);
      byCwd.set(cwd, r);
    }
    const held = r;
    held.users++;
    let released = false;
    return () => {
      if (released) return; // idempotent: one retain, one release
      released = true;
      held.users--;
      if (held.users > 0) return;
      held.closed = true;
      held.off?.();
      if (held.timer !== null) clearTimeout(held.timer);
      held.timer = null;
      if (byCwd.get(cwd) === held) byCwd.delete(cwd);
    };
  };
}

/** Whether an fs-change batch touched `cwd` (the folder itself or anything under it). The app
 *  has ONE watch, owned by whichever editor mounted last — its events may be about another
 *  folder entirely (the IDE's, another conversation's worktree).
 *
 *  ⚠️ A cwd this cannot place — a relative one (`"."`, the default project before its process
 *  reports a real path; the Git workspace still keys on it) — counts EVERY batch, as all
 *  batches did before this filter: going deaf would be a silent regression, a spare refresh is
 *  not. `/` holds every absolute path. */
export function pathsTouchCwd(paths: readonly string[], cwd: string): boolean {
  if (paths.length === 0) return false;
  if (!cwd.startsWith("/")) return true;
  const root = comparablePath(cwd.replace(/\/+$/, ""));
  if (!root) return true; // the filesystem root
  const prefix = `${root}/`;
  return paths.some((raw) => {
    const p = comparablePath(raw);
    return p === root || p.startsWith(prefix);
  });
}

/**
 * A path in the form the file watcher reports it. ⚠️ FSEvents canonicalizes the watched root, so
 * its events carry the REAL path — a folder opened as `/tmp/x` reports `/private/tmp/x` — and the
 * default APFS volume ignores case. Comparing raw strings dropped every event for such a folder,
 * and its git counts went stale until the next focus. (A folder under a user-made symlink still
 * needs the turn-end and focus refreshes: resolving those would take a round trip to the disk.)
 */
function comparablePath(path: string): string {
  const real = /^\/(tmp|var|etc)(\/|$)/.test(path) ? `/private${path}` : path;
  return real.toLowerCase();
}
