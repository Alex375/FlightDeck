// TanStack Query wrappers around the account commands (Settings → Accounts). The
// credential stores stay OWNED by the CLIs (`claude auth`, codex app-server
// `account/*`): these hooks only read the whitelisted statuses and drive the
// official login/logout flows. Query keys share the `["account-status"]` prefix so
// the global `account_login` / `account/updated` invalidation refreshes both.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { ClaudeAccountStatus, CodexAccountStatus, CodexLoginStart, Result } from "./client";

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

/** The signed-in Claude account (`claude auth status --json`). Refetches on window
 *  focus — returning from the browser after an OAuth round-trip refreshes the panel. */
export function useClaudeAccount(enabled: boolean) {
  return useQuery<ClaudeAccountStatus>({
    queryKey: accountStatusKey("claude"),
    enabled,
    queryFn: () => unwrap(commands.accountClaudeStatus()),
    staleTime: 30_000,
  });
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
export function useClaudeAccountActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: accountStatusKey("claude") });
  const loginStart = useMutation({
    mutationFn: (): Promise<string> => unwrap(commands.accountClaudeLoginStart()),
  });
  const loginCode = useMutation({
    mutationFn: (code: string): Promise<null> => unwrap(commands.accountClaudeLoginCode(code)),
    onSuccess: refresh,
  });
  const loginCancel = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountClaudeLoginCancel()),
  });
  const logout = useMutation({
    mutationFn: (): Promise<null> => unwrap(commands.accountClaudeLogout()),
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
