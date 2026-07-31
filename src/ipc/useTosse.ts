// TanStack Query wrappers around the TOSSE connection commands (Settings → TOSSE).
//
// TOSSE is the internal CRM, NOT an agent backend: this signs the human in to their own
// data, and the whole app works without it. The hooks nevertheless share the
// `["account-status"]` query-key prefix with the Claude/Codex accounts, because the sign-in
// completes through the same app-global `account_login` event — whose handler invalidates
// that prefix (see `useGlobalSessionEvents`), so the card refreshes itself for free.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { Result, TosseAccountStatus } from "./client";
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
