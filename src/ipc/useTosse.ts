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
  LocalRepoScan,
  Result,
  TosseAccountStatus,
  TosseBacklogTask,
  TosseBriefing,
  TosseProjectRepo,
  TosseRepoLink,
  TosseRepoLinksPayload,
  TosseTask,
  TosseTaskDetail,
} from "./client";
import { accountStatusKey } from "./useAccounts";
// "The session is gone" vs "one request failed" — a wording CONTRACT with the Rust side,
// so it lives in its own tested module rather than as a local predicate here.
import { isSessionGone } from "./tosseErrors";
import { applyStatusToBoard } from "../features/tosse/tosseModel";
import { refreshLinkedTaskMeta, useConversationsStore } from "../store/conversationsStore";

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
  // Both keys: the connection state AND everything derived from it. A sign-out that left
  // the repo links cached would keep the sidebar marks lit on a dead session.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: tosseStatusKey() });
    invalidateTosseRepoLinks(qc);
  };
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
 * Refresh the repo-links query. Call it wherever the TOSSE SESSION changes.
 *
 * Without this the payload's `connected` flag — the gate every badge reads — stays stuck
 * for a full `staleTime`: sign in, and the marks simply do not appear for five minutes
 * (the feature reads as broken on first use); sign out, and they keep showing CRM names
 * and context for a session that no longer exists.
 */
export function invalidateTosseRepoLinks(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: tosseRepoLinksKey });
}

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
  // The set of folders is an INPUT of the answer, so it belongs in the key: a repo added
  // since the last fetch has no entry in the payload, and the card would then describe that
  // absence as a fact about the folder ("it has no git remote"). Adding or removing a
  // folder now re-runs the match instead of waiting out `staleTime`.
  // `tosseRepoLinksKey` stays the PREFIX, so invalidating by it still matches every variant.
  const repoKey = useConversationsStore((s) => s.repos.map((r) => r.id).join(","));
  return useQuery<TosseRepoLinksPayload>({
    queryKey: [...tosseRepoLinksKey, repoKey],
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

export const localRepoScanKey = (urls: string[]) =>
  ["local-repo-scan", [...urls].sort().join("|")] as const;

/**
 * The clones of a project's repositories ALREADY on this Mac — including the ones Flight
 * Deck has never been told about.
 *
 * This is what turns "no folder is associated with this project" from a dead end into a
 * one-click answer: the repository is usually cloned, it was simply never added to the app.
 *
 * Local and on demand: it only runs when a dialog actually needs a folder (`enabled`), and
 * it reads `.git/config` rather than spawning git per folder — MEASURED at ~19 ms for a
 * whole home directory. `staleTime` is long because clones do not appear by the minute.
 */
export function useLocalRepoScan(urls: string[], enabled: boolean) {
  return useQuery<LocalRepoScan>({
    queryKey: localRepoScanKey(urls),
    enabled: enabled && urls.length > 0,
    queryFn: () => unwrap(commands.scanLocalGitRepos(urls)),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export const tosseProjectReposKey = ["tosse-project-repos"] as const;

/**
 * Which local folder each TOSSE project's work happens in, as the user pinned it.
 *
 * Local data (SQLite), so this never touches the network and stays valid offline — it is
 * what lets "Start" work on a task whose project was already answered for, whatever the
 * CRM is doing. One shared query for the whole view; there are a handful of rows.
 */
export function useTosseProjectRepos(enabled = true) {
  return useQuery<TosseProjectRepo[]>({
    queryKey: tosseProjectReposKey,
    enabled,
    queryFn: () => unwrap(commands.tosseProjectRepos()),
    // Only this app writes them, and the mutation below invalidates on success.
    staleTime: Infinity,
  });
}

/** Pin a TOSSE project to a local folder, or forget the pin with `null`. */
export function useLinkTosseProjectRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; repoId: string | null }): Promise<null> =>
      unwrap(commands.tosseLinkProjectRepo(v.projectId, v.repoId)),
    // Success only: a refused write must leave the displayed folder alone rather than
    // flicker to one the database never stored.
    onSuccess: () => qc.invalidateQueries({ queryKey: tosseProjectReposKey }),
  });
}

// ── Tasks view ──────────────────────────────────────────────────────────────────────

export const tosseBriefingKey = ["tosse-briefing"] as const;
/** Prefix shared by every single-task query — invalidate this to refresh whichever task
 *  panel is open, whatever its id. */
export const tosseTaskKeyPrefix = ["tosse-task"] as const;
export const tosseTaskKey = (id: string) => [...tosseTaskKeyPrefix, id] as const;

/**
 * Everything the tasks view shows, in one query.
 *
 * Refetched when the window regains focus, because the CRM is also edited in a browser and
 * by agents through the MCP: coming back to Flight Deck should not show yesterday's board.
 * `staleTime` keeps switching views from re-fetching on every tab click.
 */
export function useTosseBriefing(enabled = true) {
  const qc = useQueryClient();
  return useQuery<TosseBriefing>({
    queryKey: tosseBriefingKey,
    enabled,
    queryFn: async () => {
      try {
        const briefing = await unwrap(commands.tosseBriefing());
        // The CRM was just read, so this is the moment to re-stamp the title + status
        // every LINKED conversation keeps its own copy of. Done here rather than in a
        // component effect because the answer belongs to the fetch, not to whichever
        // view happens to be mounted: the delete warning reads that copy, and it must
        // not go stale just because the tasks view was never opened this run.
        refreshLinkedTaskMeta(
          [...briefing.projects.flatMap((p) => p.tasks), ...briefing.generalTasks].map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
          })),
        );
        return briefing;
      } catch (e) {
        // A session that died between two refreshes has to reach the CONNECTION state, or
        // the tab stays up over a board it can no longer load: every retry fails the same
        // way, and the one thing that would fix it — signing in again — is in a Settings
        // tab the view never points at. Re-reading the status makes the tab withdraw and
        // the card explain why. The error still propagates, so nothing is swallowed.
        if (isSessionGone(e)) void qc.invalidateQueries({ queryKey: tosseStatusKey() });
        throw e;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export const tosseWebUrlKey = ["tosse-web-url"] as const;

/**
 * Where TOSSE lives in a browser — the origin behind every "Open in TOSSE" link.
 *
 * Never expires: it comes from the OAuth metadata, which is discovered once per run and
 * cached in the core, so refetching would only re-ask a question whose answer cannot change
 * under us. A failure leaves the links out rather than rendering ones that lead nowhere —
 * the caller says so on the surface that would have carried them.
 */
export function useTosseWebUrl(enabled = true) {
  return useQuery<string>({
    queryKey: tosseWebUrlKey,
    enabled,
    queryFn: () => unwrap(commands.tosseWebUrl()),
    staleTime: Infinity,
    retry: false,
  });
}

export const tosseBacklogKey = ["tosse-backlog"] as const;

/**
 * The Backlog tasks, which the briefing deliberately omits.
 *
 * A second request, and a deliberately cold one: a backlog is what you are NOT working on,
 * so it does not need to track the board minute by minute. It is still invalidated by the
 * writes below, so moving a task into or out of Backlog is reflected.
 */
export function useTosseBacklog(enabled = true) {
  return useQuery<TosseBacklogTask[]>({
    queryKey: tosseBacklogKey,
    enabled,
    queryFn: () => unwrap(commands.tosseBacklog()),
    staleTime: 5 * 60_000,
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


/**
 * Move a task to another status.
 *
 * Optimistic: the row jumps to its new section immediately, because the whole point of
 * doing this here rather than in the browser is that it feels local. If the server refuses
 * (a blocked task, an expired session), the previous board is restored WHOLE and the
 * caller shows the reason — a silent revert on the next refetch would look like a bug.
 *
 * A task moved off the board (see {@link STATUSES_OFF_THE_BOARD}) is removed rather than
 * moved: the briefing does not list those, so keeping the row would show something that
 * vanishes on the next refresh anyway.
 */
export function useSetTosseTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { taskId: string; status: string; title?: string }): Promise<null> =>
      unwrap(commands.tosseSetTaskStatus(v.taskId, v.status)),
    onMutate: async ({ taskId, status }) => {
      // Stop any briefing refetch already in flight FIRST. Without this, a response that
      // left before our patch can land after it and overwrite the optimistic board with
      // pre-write data — and, if the write then fails, our rollback would "restore" that
      // stale answer as if it were the state the user had.
      await qc.cancelQueries({ queryKey: tosseBriefingKey });
      return {
        previous: patchBriefing(qc, (b) => applyStatusToBoard(b, taskId, status)),
      };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(tosseBriefingKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: tosseBriefingKey });
      // A status write can move a task INTO or OUT OF Backlog, so that list is stale too.
      void qc.invalidateQueries({ queryKey: tosseBacklogKey });
      // The WHOLE `tosse-task` prefix, not just the task we wrote. Ticking a SUBTASK writes
      // the subtask's id, while the panel on screen is keyed by its PARENT — invalidating
      // only the written id refreshed a query nobody was looking at, so the checkbox never
      // moved and success looked exactly like failure. At most a couple of task queries are
      // ever cached (one open panel), so the wider invalidation costs nothing.
      void qc.invalidateQueries({ queryKey: tosseTaskKeyPrefix });
    },
  });
}

/** Start / pause / finish a project. Same optimistic contract as the task status. */
export function useSetTosseProjectStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; status: string; name?: string }): Promise<null> =>
      unwrap(commands.tosseSetProjectStatus(v.projectId, v.status)),
    onMutate: async ({ projectId, status }) => {
      // Same reason as the task mutation: an in-flight refetch must not land on top of the
      // optimistic board, or the rollback restores that stale answer instead of the truth.
      await qc.cancelQueries({ queryKey: tosseBriefingKey });
      return {
        previous: patchBriefing(qc, (b) => ({
          ...b,
          projects: b.projects.map((p) => (p.id === projectId ? { ...p, status } : p)),
          pausedProjects: b.pausedProjects.map((p) =>
            p.id === projectId ? { ...p, status } : p,
          ),
        })),
      };
    },
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
    },
    // Refetch on BOTH outcomes, not just success. A creation can fail on the way BACK — the
    // task exists in the CRM but the response was lost (dropped connection, a Railway
    // restart mid-flight). Refetching only on success left that task invisible here, so the
    // obvious move — retype it and press enter again — filed it a second time. Now the board
    // refreshes either way, and a task that WAS created shows up next to the error instead
    // of inviting a duplicate.
    onSettled: () => void qc.invalidateQueries({ queryKey: tosseBriefingKey }),
  });
}
