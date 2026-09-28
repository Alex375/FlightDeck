// TanStack Query wrappers around the git history / source-control IPC commands.
// Everything is keyed by the conversation's LIVE cwd (the worktree the user is
// looking at), under a shared ["git", cwd] prefix so a single call invalidates
// the whole panel after a write.
//
// Reads are queries (status / log / branches / diffs); commit + push/pull/fetch
// are mutations that invalidate the prefix. `useGitAutoRefresh` additionally
// re-pulls status + diffs whenever the fs watcher reports a working-tree change,
// so editing a file is reflected without a manual refresh.

import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { commands, events } from "./client";
import { createGitFsRefresh, invalidateGitQueries } from "../features/git/gitTurnRefresh";
import type {
  BranchInfo,
  CommitFile,
  CommitInfo,
  GitDiff,
  GitFileEntry,
  GitStatus,
  Result,
} from "./client";

/** Throw on the Result.error branch so query/mutation error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Shared key prefix — invalidating it refreshes the whole panel for a cwd. */
export const gitKey = (cwd: string | null) => ["git", cwd] as const;

/** How many commits one history page loads. */
export const LOG_PAGE_SIZE = 200;

/** Working-tree status (branch, ahead/behind, changed files). */
export function useGitStatus(cwd: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "status"] as const,
    enabled: !!cwd,
    queryFn: () => unwrap(commands.gitStatus(cwd!)),
    staleTime: 2_000,
  });
}

/** Local + remote-tracking branches. */
export function useGitBranches(cwd: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "branches"] as const,
    enabled: !!cwd,
    queryFn: () => unwrap(commands.gitBranches(cwd!)),
    staleTime: 5_000,
  });
}

/**
 * Paginated commit history across all refs. Pages of [`LOG_PAGE_SIZE`]; the next
 * page loads only when the user scrolls to the end (`fetchNextPage`). Flatten
 * `data.pages` for the full ordered list.
 */
export function useGitLog(cwd: string | null) {
  return useInfiniteQuery({
    queryKey: ["git", cwd, "log"] as const,
    enabled: !!cwd,
    queryFn: ({ pageParam }) => unwrap(commands.gitLog(cwd!, LOG_PAGE_SIZE, pageParam)),
    initialPageParam: 0,
    // Next skip = commits loaded so far; stop once a short page comes back.
    getNextPageParam: (last, all) =>
      last.length < LOG_PAGE_SIZE ? undefined : all.reduce((n, p) => n + p.length, 0),
    staleTime: 5_000,
  });
}

/**
 * Diff of one working-tree file vs HEAD (for the changes view). `origPath` is the
 * rename source (when the file was renamed), so the "before" side reads from the
 * old path instead of rendering as fully added.
 */
export function useGitDiff(
  cwd: string | null,
  path: string | null,
  origPath: string | null = null,
) {
  return useQuery({
    queryKey: ["git", cwd, "diff", path, origPath] as const,
    enabled: !!cwd && !!path,
    queryFn: () => unwrap(commands.gitDiff(cwd!, path!, origPath)),
    staleTime: 2_000,
  });
}

/** Files changed by a commit (for the history detail pane). */
export function useCommitFiles(cwd: string | null, oid: string | null) {
  return useQuery({
    queryKey: ["git", cwd, "commit-files", oid] as const,
    enabled: !!cwd && !!oid,
    queryFn: () => unwrap(commands.gitCommitFiles(cwd!, oid!)),
    staleTime: 60_000, // a commit's contents never change
  });
}

/**
 * Diff of one file introduced by a commit (old = parent, new = commit). `origPath`
 * is the rename source so the "before" side reads the old path at the parent.
 */
export function useCommitFileDiff(
  cwd: string | null,
  oid: string | null,
  path: string | null,
  origPath: string | null = null,
) {
  return useQuery({
    queryKey: ["git", cwd, "commit-diff", oid, path, origPath] as const,
    enabled: !!cwd && !!oid && !!path,
    queryFn: () => unwrap(commands.gitCommitFileDiff(cwd!, oid!, path!, origPath)),
    staleTime: 60_000,
  });
}

/** Stage all + commit; refreshes the whole panel on success. */
export function useGitCommit(cwd: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string): Promise<string> => unwrap(commands.gitCommit(cwd!, message)),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKey(cwd) }),
  });
}

/** Run a remote-sync action (push/pull/fetch); refreshes the panel on success. */
export function useGitSync(cwd: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "push" | "pull" | "fetch"): Promise<null> =>
      unwrap(
        action === "push"
          ? commands.gitPush(cwd!)
          : action === "pull"
            ? commands.gitPull(cwd!)
            : commands.gitFetch(cwd!),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: gitKey(cwd) }),
  });
}

/** At most one fs-driven git refresh per this window (ms), fired at its END (trailing). */
export const GIT_FS_REFRESH_THROTTLE_MS = 1_000;

/** The shared fs-driven refreshers, one registry per QueryClient (the app has one; tests make
 *  their own). A WeakMap, so a discarded client takes its registry with it. */
const fsRefreshByClient = new WeakMap<QueryClient, (cwd: string) => () => void>();

function fsRefreshFor(qc: QueryClient): (cwd: string) => () => void {
  let retain = fsRefreshByClient.get(qc);
  if (!retain) {
    retain = createGitFsRefresh({
      listen: (onPaths) => events.fsChangeEvent.listen((e) => onPaths(e.payload.paths)),
      refresh: (cwd) => {
        invalidateGitQueries(qc, ["git", cwd, "status"]);
        invalidateGitQueries(qc, ["git", cwd, "diff"]);
      },
      throttleMs: GIT_FS_REFRESH_THROTTLE_MS,
    });
    fsRefreshByClient.set(qc, retain);
  }
  return retain;
}

/**
 * Re-pull status + open diffs whenever the fs watcher reports a change UNDER `cwd` (the
 * watcher already debounces and ignores `.git`/`node_modules`). Commit history and branches
 * don't change on a file save, so they're left to the turn-end refresh
 * (`useGlobalSessionEvents`), window-focus refetch and the write mutations.
 *
 * ⚠️ Every caller on the same cwd shares ONE refresher (see `createGitFsRefresh`): filtered to
 * the cwd, throttled (trailing, {@link GIT_FS_REFRESH_THROTTLE_MS}) and read through
 * {@link invalidateGitQueries}, which joins a fetch in flight rather than stacking a second
 * uncancellable `git` process. The Git workspace and the side panel's git widget open together
 * therefore still cost one `git status` per burst, not two.
 */
export function useGitAutoRefresh(cwd: string | null) {
  const qc = useQueryClient();
  useEffect(() => (cwd ? fsRefreshFor(qc)(cwd) : undefined), [cwd, qc]);
}

export type { BranchInfo, CommitFile, CommitInfo, GitDiff, GitFileEntry, GitStatus };
