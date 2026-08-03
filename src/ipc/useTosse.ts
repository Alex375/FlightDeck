// TanStack Query wrappers around the TOSSE connection commands (Settings → TOSSE).
//
// TOSSE is the internal CRM, NOT an agent backend: this signs the human in to their own
// data, and the whole app works without it. The hooks nevertheless share the
// `["account-status"]` query-key prefix with the Claude/Codex accounts, because the sign-in
// completes through the same app-global `account_login` event — whose handler invalidates
// that prefix (see `useGlobalSessionEvents`), so the card refreshes itself for free.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { Result, TosseAccountStatus, TosseRepoLink, TosseRepoLinksPayload } from "./client";
import { accountStatusKey } from "./useAccounts";
import { useConversationsStore } from "../store/conversationsStore";

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
