// TanStack Query wrappers around the git worktree IPC commands. Worktrees are a
// property of a git repository (shared by all of its checkouts), so the list is
// cached per repo PATH and shared by every component that asks for the same repo
// — many sidebar rows in one repo trigger a single request, not one each.
//
// Reads (list/status) are queries; create/remove are mutations that invalidate
// the repo's list so the UI reflects the new set immediately.
//
// ⚠️ Every one of them runs THIS Mac's `git`. A folder is (machine, path): a folder on a paired
// server has a path that means something only THERE — read here it fails, or worse, lists an
// unrelated local clone that happens to sit at the same path (whose worktrees the UI would then
// show, remove, or open conversations in, as if they were the server's). So the list is keyed by
// machine too, and never fetched for a server folder: the query is disabled, no `git` at all.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { Result, WorktreeInfo, WorktreeStatus } from "./client";

/** Throw on the Result.error branch so query/mutation error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Query key for a folder's worktree list — shared so requests dedupe per folder. Keyed by
 *  machine AND path (`null` = this Mac): two machines can hold the same path, and their entries
 *  must never be one. */
export const worktreesKey = (repoPath: string | null, machineId: string | null) =>
  ["worktrees", machineId, repoPath] as const;

/**
 * The worktrees of the repository `repoPath` lives in (main first), on THIS Mac. Disabled
 * (no request) when `repoPath` is null or the folder is on a paired server (`machineId` set —
 * see the module note: this Mac's git cannot list a server's worktrees). Refetches on window
 * focus so a worktree Claude created via `git worktree add` (in a Bash tool call) shows up when
 * the user returns to the app, without us watching the filesystem.
 */
export function useWorktrees(repoPath: string | null, machineId: string | null) {
  return useQuery({
    queryKey: worktreesKey(repoPath, machineId),
    enabled: !!repoPath && !machineId,
    queryFn: () => unwrap(commands.listWorktrees(repoPath!)),
    // A worktree set changes rarely; a few seconds of staleness is fine and keeps
    // the always-on indicator from refetching on every render.
    staleTime: 5_000,
  });
}

/** The dirty/ahead-behind status of one worktree (heavier — used by the manager). */
export function useWorktreeStatus(worktreePath: string | null, enabled = true) {
  return useQuery({
    queryKey: ["worktree-status", worktreePath] as const,
    enabled: enabled && !!worktreePath,
    queryFn: () => unwrap(commands.worktreeStatus(worktreePath!)),
    staleTime: 5_000,
  });
}

export interface CreateWorktreeArgs {
  branch: string;
  /** Base ref for a new branch (default: the main worktree's HEAD). */
  baseRef?: string | null;
  /** Create the branch (`-b`) vs. check out an existing one. */
  newBranch: boolean;
}

/** Create a worktree in `repoPath`'s repository, then refresh its list. */
export function useCreateWorktree(repoPath: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateWorktreeArgs): Promise<WorktreeInfo> =>
      unwrap(
        commands.createWorktree(repoPath!, args.branch, args.baseRef ?? null, args.newBranch),
      ),
    // Worktrees are only ever created for a folder on this Mac (the spawn path refuses a server
    // folder before calling git), hence the local key.
    onSuccess: () => qc.invalidateQueries({ queryKey: worktreesKey(repoPath, null) }),
  });
}

/** Remove a worktree (force only after an explicit confirm), then refresh. */
export function useRemoveWorktree(repoPath: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { worktreePath: string; force: boolean }): Promise<null> =>
      unwrap(commands.removeWorktree(repoPath!, args.worktreePath, args.force)),
    // Only reachable from a listed worktree, and a server folder lists none.
    onSuccess: () => qc.invalidateQueries({ queryKey: worktreesKey(repoPath, null) }),
  });
}

export type { WorktreeInfo, WorktreeStatus };
