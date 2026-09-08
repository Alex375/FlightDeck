// TanStack Query wrappers around the account commands (Settings → Accounts). The
// credential stores stay OWNED by the CLIs (`claude auth`, codex app-server
// `account/*`): these hooks only read the whitelisted statuses and drive the
// official login/logout flows. Query keys share the `["account-status"]` prefix so
// the global `account_login` / `account/updated` invalidation refreshes both.

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type {
  ClaudeAccountRecord,
  ClaudeAccountStatus,
  CodexAccountStatus,
  CodexLoginStart,
  Result,
} from "./client";
import { DEFAULT_ACCOUNT_ID, useClaudeAccountList } from "../store/claudeAccounts";

async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Query key for any account-like connection. The shared `["account-status"]` prefix is
 *  load-bearing: the global `account_login` handler invalidates on it, so a sign-in that
 *  completes asynchronously refreshes whichever card it belongs to — including TOSSE
 *  (`useTosse.ts`), which is not an agent backend but rides the same event. */
export const accountStatusKey = (backend: "claude" | "codex" | "tosse") =>
  ["account-status", backend] as const;

/** Query key for ONE Claude account's status. Nested under the Claude prefix so the
 *  existing `account_login` invalidation refreshes every account at once. */
export const claudeAccountStatusKey = (accountId: string | null) =>
  [...accountStatusKey("claude"), accountId ?? DEFAULT_ACCOUNT_ID] as const;

/** Query key for the persisted list of extra Claude accounts. */
export const claudeAccountsKey = ["claude-accounts"] as const;

/** One Claude account's status (`claude auth status --json`, scoped to its credential
 *  store). `accountId: null` is the default, un-scoped account. Refetches on window
 *  focus — returning from the browser after an OAuth round-trip refreshes the panel.
 *
 *  ⚠️ Do NOT read `email`/`orgName` off this to LABEL an account: those come from a
 *  profile cache the accounts share, so they describe whichever signed in last (see the
 *  core's `accounts::status`). The label lives on the persisted record instead. */
export function useClaudeAccount(enabled: boolean, accountId: string | null = null) {
  return useQuery<ClaudeAccountStatus>({
    queryKey: claudeAccountStatusKey(accountId),
    enabled,
    queryFn: () => unwrap(commands.accountClaudeStatus(accountId)),
    staleTime: 30_000,
  });
}

/** The extra Claude accounts the user registered (the default one is not in this list —
 *  it always exists). Mirrored into `useClaudeAccountList` so code outside React can read
 *  it without a round-trip. */
export function useClaudeAccounts(enabled = true) {
  const query = useQuery<ClaudeAccountRecord[]>({
    queryKey: claudeAccountsKey,
    enabled,
    queryFn: () => unwrap(commands.claudeAccountsList()),
    staleTime: 30_000,
  });
  const accounts = query.data;
  useEffect(() => {
    if (!accounts) return;
    useClaudeAccountList
      .getState()
      .setAccounts(
        accounts.map((a) => ({ id: a.id, label: a.label, sortIndex: a.sort_index })),
      );
  }, [accounts]);
  return query;
}

/** Add / rename / remove a Claude account. Every mutation refreshes the list AND the
 *  statuses, since adding or removing one changes what the panel must render. */
export function useClaudeAccountAdmin() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: claudeAccountsKey });
    void qc.invalidateQueries({ queryKey: accountStatusKey("claude") });
  };
  const create = useMutation({
    mutationFn: (label: string): Promise<ClaudeAccountRecord> =>
      unwrap(commands.claudeAccountCreate(label)),
    onSuccess: refresh,
  });
  const rename = useMutation({
    mutationFn: (v: { accountId: string; label: string }): Promise<null> =>
      unwrap(commands.claudeAccountRename(v.accountId, v.label)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (accountId: string): Promise<string | null> =>
      unwrap(commands.claudeAccountRemove(accountId)),
    // `onSettled`, not `onSuccess`: the row may well be gone even when the call reports a
    // failure (the delete is the last step), so the list must be re-read either way — the
    // same trap the TOSSE task creation hit.
    onSettled: refresh,
  });
  const captureIdentity = useMutation({
    mutationFn: (accountId: string): Promise<ClaudeAccountRecord> =>
      unwrap(commands.claudeAccountCaptureIdentity(accountId)),
    onSuccess: refresh,
  });
  return { create, rename, remove, captureIdentity };
}

/** The signed-in Codex account (`account/read` on a transient app-server). */
export function useCodexAccount(enabled: boolean) {
  return useQuery<CodexAccountStatus>({
    queryKey: accountStatusKey("codex"),
    enabled,
    queryFn: () => unwrap(commands.accountCodexStatus()),
    staleTime: 30_000,
  });
}

/**
 * The Claude login/logout actions. Login is a TWO-STEP flow: `loginStart` spawns
 * `claude auth login` and returns the OAuth URL (the caller opens it and shows a
 * code input); `loginCode` submits the pasted authorization code and completes it.
 */
export function useClaudeAccountActions(accountId: string | null = null) {
  const qc = useQueryClient();
  // Invalidate the WHOLE Claude prefix, not just this account's key: signing one account
  // in or out can change what every card shows (which one is the default, whether a
  // switch target exists), and the extra refetches are two cheap CLI calls.
  const refresh = () => qc.invalidateQueries({ queryKey: accountStatusKey("claude") });
  const loginStart = useMutation({
    mutationFn: (): Promise<string> => unwrap(commands.accountClaudeLoginStart(accountId)),
  });
  const loginCode = useMutation({
    mutationFn: (code: string): Promise<null> => unwrap(commands.accountClaudeLoginCode(code)),
    onSuccess: async () => {
      // Capture the identity while the CLI's profile cache still describes THIS account
      // (see the core's `accounts::status`). Best-effort: a failure leaves the label as it
      // was rather than undoing a sign-in that actually succeeded.
      if (accountId) {
        try {
          await commands.claudeAccountCaptureIdentity(accountId);
        } catch {
          /* keep the existing label */
        }
        void qc.invalidateQueries({ queryKey: claudeAccountsKey });
      }
      refresh();
    },
  });
  const loginCancel = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountClaudeLoginCancel()),
  });
  const logout = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountClaudeLogout(accountId)),
    onSuccess: refresh,
  });
  return { loginStart, loginCode, loginCancel, logout };
}

/**
 * The DEFINITIVE logged-out flags for both backends, for the passive warning
 * surfaces (composer banner, model-picker badges). `true` only when the status
 * query answered `loggedIn: false` — loading, disabled, or a failed status probe
 * yield `false` so a transient error never shows a scary false "not connected".
 * EACH backend is probed only when its binary is installed — a machine with just one
 * backend never fires the other's status command (which, absent its binary, would just
 * fail on repeat). One shared cached query per backend (30s staleTime + the global
 * `account_login`/`account/updated` invalidation), so mounting this in every composer
 * costs nothing extra.
 */
export function useAccountsLoggedOut(
  claudeAvailable: boolean,
  codexAvailable: boolean,
): {
  claude: boolean;
  codex: boolean;
} {
  const claude = useClaudeAccount(claudeAvailable);
  const codex = useCodexAccount(codexAvailable);
  return {
    claude: claudeAvailable && claude.data?.loggedIn === false,
    codex: codexAvailable && codex.data?.loggedIn === false,
  };
}

/**
 * The Codex login/logout actions. `loginStart` returns `{loginId, authUrl}` and the
 * flow completes ASYNCHRONOUSLY: the dedicated app-server held by the backend serves
 * the OAuth callback and the outcome arrives as the app-global `account_login` event
 * (the section listens for it; the global router already refreshes the status).
 */
export function useCodexAccountActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: accountStatusKey("codex") });
  const loginStart = useMutation({
    mutationFn: (): Promise<CodexLoginStart> => unwrap(commands.accountCodexLoginStart()),
  });
  const loginCancel = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountCodexLoginCancel()),
  });
  const logout = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountCodexLogout()),
    onSuccess: refresh,
  });
  return { loginStart, loginCancel, logout };
}
