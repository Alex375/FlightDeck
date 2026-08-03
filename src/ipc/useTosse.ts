// TanStack Query wrappers around the TOSSE connection commands (Settings → TOSSE).
//
// TOSSE is the internal CRM, NOT an agent backend: this signs the human in to their own
// data, and the whole app works without it. The hooks nevertheless share the
// `["account-status"]` query-key prefix with the Claude/Codex accounts, because the sign-in
// completes through the same app-global `account_login` event — whose handler invalidates
// that prefix (see `useGlobalSessionEvents`), so the card refreshes itself for free.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type {
  Result,
  TosseAccountStatus,
  TosseBriefing,
  TosseRepoLink,
  TosseRepoLinksPayload,
  TosseTask,
  TosseTaskDetail,
} from "./client";
import { accountStatusKey } from "./useAccounts";

async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

export const tosseStatusKey = () => accountStatusKey("tosse");

/**
 * The TOSSE connection state. Deliberately cheap to keep mounted: the command answers
 * from the locally stored session and only reaches the network for the identity, so an
 * offline machine still reports "connected" instead of flapping to signed-out.
 */
export function useTosseConnection(enabled = true) {
  return useQuery<TosseAccountStatus>({
    queryKey: tosseStatusKey(),
    enabled,
    queryFn: () => unwrap(commands.tosseStatus()),
    staleTime: 30_000,
  });
}

/**
 * Sign-in / sign-out actions. `loginStart` returns the authorization URL for the caller to
 * open; the flow then completes ASYNCHRONOUSLY when the browser hits the app's loopback
 * callback, and the outcome arrives as the `account_login` event with `backend: "tosse"`
 * (same shape as the Codex login).
 */
export function useTosseConnectionActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: tosseStatusKey() });
  const loginStart = useMutation({
    mutationFn: (): Promise<string> => unwrap(commands.tosseLoginStart()),
  });
  const loginCancel = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.tosseLoginCancel()),
  });
  const logout = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.tosseLogout()),
    // Refresh on BOTH outcomes: a failed revocation still signed us out locally, so the
    // card must stop showing a session that no longer exists on this Mac.
    onSettled: refresh,
  });
  // `refresh` is exposed because cancelling a sign-in needs it: cancelling only stops us
  // WAITING, and the browser round-trip may already have completed — in which case we are
  // connected and the card must not keep claiming otherwise until staleTime lapses.
  return { loginStart, loginCancel, logout, refresh };
}

export const tosseRepoLinksKey = ["tosse-repo-links"] as const;

/**
 * How each Flight Deck folder maps to a TOSSE repository — the whole table in one query,
 * because the CRM's repository list is a single request and matching needs all of it.
 *
 * ONE shared query for every repo header: keyed globally (not per repo), so N sidebar
 * badges cost one fetch. A signed-out user gets `connected: false` for free — the command
 * returns before reading a single git remote.
 *
 * `enabled` lets the caller skip the work entirely when the feature is switched off in
 * Settings, so the display preference costs nothing rather than merely hiding the result.
 */
export function useTosseRepoLinks(enabled = true) {
  return useQuery<TosseRepoLinksPayload>({
    queryKey: tosseRepoLinksKey,
    enabled,
    queryFn: () => unwrap(commands.tosseRepoLinks()),
    // Repositories move rarely and each refetch shells out to `git` once per folder, so
    // this stays deliberately cold; the mutation below invalidates it on a real change.
    staleTime: 5 * 60_000,
  });
}

/** One folder's link, or `undefined` while the query is still loading / disabled. */
export function repoLinkFor(
  payload: TosseRepoLinksPayload | undefined,
  repoId: string,
): TosseRepoLink | undefined {
  return payload?.links.find((l) => l.repoId === repoId);
}

/**
 * Pin a folder to a TOSSE repository by hand (or clear it with `null`).
 *
 * Purely local — TOSSE has no field for a machine path and is never written to. The
 * account-status key is NOT touched: this changes an association, not the session.
 */
export function useLinkTosseRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repoId: string; repositoryId: string | null }): Promise<null> =>
      unwrap(commands.tosseLinkRepository(v.repoId, v.repositoryId)),
    // Refetch on success only: a failed write must leave the displayed link alone rather
    // than flicker to a state the database never accepted.
    onSuccess: () => qc.invalidateQueries({ queryKey: tosseRepoLinksKey }),
  });
}

// ── Tasks view ──────────────────────────────────────────────────────────────────────

export const tosseBriefingKey = ["tosse-briefing"] as const;
export const tosseTaskKey = (id: string) => ["tosse-task", id] as const;

/**
 * Everything the tasks view shows, in one query.
 *
 * Refetched when the window regains focus, because the CRM is also edited in a browser and
 * by agents through the MCP: coming back to Flight Deck should not show yesterday's board.
 * `staleTime` keeps switching views from re-fetching on every tab click.
 */
export function useTosseBriefing(enabled = true) {
  return useQuery<TosseBriefing>({
    queryKey: tosseBriefingKey,
    enabled,
    queryFn: () => unwrap(commands.tosseBriefing()),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** One task in full — fetched only when a row is opened (the briefing omits the Markdown). */
export function useTosseTaskDetail(taskId: string | null) {
  return useQuery<TosseTaskDetail>({
    queryKey: tosseTaskKey(taskId ?? ""),
    enabled: taskId != null,
    queryFn: () => unwrap(commands.tosseTaskDetail(taskId as string)),
    staleTime: 30_000,
  });
}

/** Apply `f` to the cached briefing, if there is one. Returns the previous value so a
 *  failed write can put it back exactly as it was. */
function patchBriefing(
  qc: ReturnType<typeof useQueryClient>,
  f: (b: TosseBriefing) => TosseBriefing,
): TosseBriefing | undefined {
  const previous = qc.getQueryData<TosseBriefing>(tosseBriefingKey);
  if (previous) qc.setQueryData<TosseBriefing>(tosseBriefingKey, f(previous));
  return previous;
}

/** Deep-enough clone for our patches: projects and their task arrays are replaced, the task
 *  objects themselves are shared until one is edited. */
function mapProjects(b: TosseBriefing, f: (tasks: TosseTask[]) => TosseTask[]): TosseBriefing {
  return { ...b, projects: b.projects.map((p) => ({ ...p, tasks: f(p.tasks) })) };
}

/**
 * Move a task to another status.
 *
 * Optimistic: the row jumps to its new section immediately, because the whole point of
 * doing this here rather than in the browser is that it feels local. If the server refuses
 * (a blocked task, an expired session), the previous board is restored WHOLE and the
 * caller shows the reason — a silent revert on the next refetch would look like a bug.
 *
 * A task moved to `Fait` leaves the board: the briefing never lists done tasks, so keeping
 * it would show a row that vanishes on the next refresh anyway.
 */
export function useSetTosseTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; status: string; title?: string }): Promise<null> =>
      unwrap(commands.tosseSetTaskStatus(v.taskId, v.status)),
    onMutate: ({ taskId, status }) => ({
      previous: patchBriefing(qc, (b) =>
        mapProjects(b, (tasks) =>
          status === "Fait"
            ? tasks.filter((t) => t.id !== taskId)
            : tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
        ),
      ),
    }),
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(tosseBriefingKey, ctx.previous);
    },
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: tosseBriefingKey });
      void qc.invalidateQueries({ queryKey: tosseTaskKey(v.taskId) });
    },
  });
}

/** Start / pause / finish a project. Same optimistic contract as the task status. */
export function useSetTosseProjectStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; status: string; name?: string }): Promise<null> =>
      unwrap(commands.tosseSetProjectStatus(v.projectId, v.status)),
    onMutate: ({ projectId, status }) => ({
      previous: patchBriefing(qc, (b) => ({
        ...b,
        projects: b.projects.map((p) => (p.id === projectId ? { ...p, status } : p)),
        pausedProjects: b.pausedProjects.map((p) =>
          p.id === projectId ? { ...p, status } : p,
        ),
      })),
    }),
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(tosseBriefingKey, ctx.previous);
    },
    // Always refetch: a project that changed state moves BETWEEN `projects` and
    // `pausedProjects` (and takes its tasks with it), which is the server's call to make.
    onSettled: () => void qc.invalidateQueries({ queryKey: tosseBriefingKey }),
  });
}

/**
 * Create a task in a project, with the status of the group it was typed into.
 *
 * NOT optimistic: the created row's id comes from the server, and inventing a temporary one
 * would make the row un-clickable (its detail panel would 404) for as long as the request
 * takes. The input clears on success only, so a refused creation keeps what was typed.
 */
export function useCreateTosseTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      projectId: string;
      title: string;
      status: string;
      kind?: string | null;
      priority?: string | null;
      assignedTo?: string | null;
    }): Promise<TosseTask> =>
      unwrap(
        commands.tosseCreateTask(
          v.projectId,
          v.title,
          v.status,
          v.kind ?? null,
          v.priority ?? null,
          v.assignedTo ?? null,
        ),
      ),
    onSuccess: (created, v) => {
      // Seed the cache with what the server returned so the row appears without waiting for
      // the refetch, then reconcile.
      patchBriefing(qc, (b) => ({
        ...b,
        projects: b.projects.map((p) =>
          p.id === v.projectId ? { ...p, tasks: [...p.tasks, created] } : p,
        ),
      }));
      void qc.invalidateQueries({ queryKey: tosseBriefingKey });
    },
  });
}
